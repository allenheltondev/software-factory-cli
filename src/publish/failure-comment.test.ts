import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { claudeAdapter } from '../agents/adapters/claude.js';
import { codexAdapter } from '../agents/adapters/codex.js';
import { kiroAdapter } from '../agents/adapters/kiro.js';
import { configSchema, type UpdraftConfig, type UpdraftConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { beginFailureComment, getFailureComment } from '../db/failure-comments.js';
import { getJob, getRun, getStatusSnapshot, MAX_START_FAILURES, retryJob } from '../db/queue.js';
import { GitHubError, type GitHubApi, type GitHubIssueComment } from '../github/api.js';
import type { UpdraftPaths } from '../paths.js';
import type { RepoRef, RunOutcome, RunSummary } from '../types.js';
import { silentLogger } from '../util/log.js';
import {
  createFailureCommenter,
  failureCommentMarker,
  failureCommentsEnabled,
  postFailureComment,
  publicFailureReason,
  renderFailureComment,
  type FailureCommentDeps,
} from './failure-comment.js';
import { MAX_AUTO_ATTEMPTS, PUBLISH_LEASE_SECONDS, publicationMarker } from './publish.js';

const REPO_ID = 42;
const FULL = 'octo/widgets';
const T0 = Date.parse('2026-11-17T12:00:00.000Z');
const SECRET = 'ghp_SECRETtoken0123456789';

/** GitHub's issue comments, in memory. */
class FakeCommentApi implements GitHubApi {
  comments: GitHubIssueComment[] = [];
  readonly calls: string[] = [];
  /** Errors to throw on the next call of a method (consumed once). */
  failNext: Partial<Record<'createIssueComment' | 'listIssueComments', GitHubError>> = {};
  /** Create the comment, then fail as if the response was lost. */
  loseNextCommentResponse = false;
  /** Runs inside listIssueComments, before it returns. */
  onList: (() => void) | null = null;
  private nextId = 1;

  private maybeFail(name: keyof FakeCommentApi['failNext']): void {
    const err = this.failNext[name];
    if (err) {
      delete this.failNext[name];
      throw err;
    }
  }

  async getViewer() {
    return { login: 'allen', id: 1 };
  }
  async listUserRepos(): Promise<never[]> {
    return [];
  }
  async getIssueBodyEdit(): Promise<never> {
    throw new Error('not used');
  }
  async getRepo(): Promise<never> {
    throw new Error('not used');
  }
  async listLabels(): Promise<never[]> {
    return [];
  }
  async listIssueEvents(): Promise<never> {
    throw new Error('not used');
  }
  async getIssue(): Promise<never> {
    throw new Error('not used');
  }
  async listEventsForIssue(): Promise<never[]> {
    return [];
  }
  async listPullRequestsForHead(): Promise<never> {
    throw new Error('a failure comment never looks at pull requests');
  }
  async createPullRequest(): Promise<never> {
    throw new Error('a failure comment never opens a pull request');
  }

  async listIssueComments(repo: RepoRef, issue: number) {
    this.calls.push(`listComments ${repo.id} #${issue}`);
    this.maybeFail('listIssueComments');
    this.onList?.();
    return [...this.comments];
  }

  async createIssueComment(repo: RepoRef, issue: number, body: string) {
    this.calls.push(`createComment ${repo.id} #${issue}`);
    this.maybeFail('createIssueComment');
    const id = this.nextId++;
    const c = { id, htmlUrl: `https://github.com/${FULL}/issues/${issue}#issuecomment-${id}`, body, user: 'allen' };
    this.comments.push(c);
    if (this.loseNextCommentResponse) {
      this.loseNextCommentResponse = false;
      throw new GitHubError('POST /repositories/42/issues/7/comments: network error: socket hang up', 0);
    }
    return c;
  }

  get creates(): string[] {
    return this.calls.filter((c) => c.startsWith('create'));
  }
}

const roots: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeConfig(repoOver: Record<string, unknown> = {}, over: Partial<UpdraftConfigInput> = {}): UpdraftConfig {
  return configSchema.parse({
    version: 1,
    execution: { mode: 'live' },
    dispatch: { allowedActors: ['allen'] },
    agents: { claude: {}, kiro: {} },
    pools: { general: { agents: ['claude', 'kiro'] } },
    actions: { 'implement-issue': { prompt: './prompt.md', output: 'local-branch' } },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: '../clones/widgets',
        commentOnFailure: true,
        workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
        ...repoOver,
      },
    },
    ...over,
  });
}

function makePaths(): UpdraftPaths {
  const root = mkdtempSync(join(tmpdir(), 'updraft failure comment '));
  roots.push(root);
  const dataDir = join(root, 'updraft state');
  const logDir = join(dataDir, 'logs');
  return {
    configFile: join(root, 'cfg', 'config.yaml'),
    configDir: join(root, 'cfg'),
    dataDir,
    dbFile: join(dataDir, 'state.db'),
    logDir,
    runsDir: join(logDir, 'runs'),
  };
}

interface Scenario {
  db: Db;
  paths: UpdraftPaths;
  api: FakeCommentApi;
  clock: { t: number };
  deps: FailureCommentDeps;
  runId: string;
  jobId: string;
  logPath: string;
  worktree: string;
}

interface ScenarioOptions {
  /** null: closed without an outcome (canceled or released before start). */
  outcome?: RunOutcome | null;
  error?: string | null;
  /** The job's status after the run; defaults to what finishRun gives it. */
  jobStatus?: string;
  startFailures?: number;
  /** false: the run failed before a worktree existed. */
  prepared?: boolean;
  /** false: the agent never ran, so there is no summary. */
  summary?: boolean;
  seconds?: number;
  config?: UpdraftConfig;
}

/** A closed run and its job, as the worker records them; nothing on GitHub yet. */
function scenario(o: ScenarioOptions = {}): Scenario {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const paths = makePaths();
  const api = new FakeCommentApi();
  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: 7 });
  const runId = `run_${jobId}`;
  const outcome = o.outcome === undefined ? 'failed' : o.outcome;
  const worktree = join(paths.dataDir, 'worktrees', String(REPO_ID), jobId);
  const logPath = join(paths.runsDir, runId, 'run.log');
  mkdirSync(join(paths.runsDir, runId), { recursive: true });
  writeFileSync(logPath, 'updraft run\n');
  const summary: RunSummary = {
    branch: `updraft/issue-7-${jobId}`,
    baseSha: 'a'.repeat(40),
    worktree,
    commits: ['abc1234 Half a change'],
    commitCount: 1,
    filesChanged: 1,
    diffStat: '1 file changed, 2 insertions(+)',
    untracked: 0,
    lastOutput: [`I gave up. My token is ${SECRET}.`, 'Ping @octocat, this closes #99'],
    notes: [],
  };
  const started = new Date(T0).toISOString();
  const ended = new Date(T0 + (o.seconds ?? 725) * 1000).toISOString();
  db.prepare(
    `INSERT INTO runs (id, job_id, attempt, pool, agent, checkout_path, log_path, worker_id, lease_expires_at, started_at,
                       execution_started_at, ended_at, outcome, error, summary)
     VALUES (?, ?, 1, 'general', 'claude', ?, ?, 'wrk_1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    jobId,
    o.prepared === false ? null : worktree,
    logPath,
    started,
    started,
    started,
    ended,
    outcome,
    o.error === undefined ? 'agent timed out after 60 min; its process tree was stopped' : o.error,
    o.summary === false || o.prepared === false ? null : JSON.stringify(summary),
  );
  const status = o.jobStatus ?? (outcome === null ? 'canceled' : outcome === 'start_failed' ? 'queued' : outcome);
  db.prepare('UPDATE jobs SET status = ?, attempts = 1, start_failures = ? WHERE id = ?').run(status, o.startFailures ?? 0, jobId);
  const clock = { t: T0 + 3_600_000 };
  const deps: FailureCommentDeps = { db, config: o.config ?? makeConfig(), paths, api, log: silentLogger, now: () => clock.t };
  return { db, paths, api, clock, deps, runId, jobId, logPath, worktree };
}

describe('postFailureComment: which runs get a comment', () => {
  it('comments once on the issue of a run that ended failed, and records it', async () => {
    const s = scenario();
    const r = await postFailureComment(s.deps, s.runId);
    expect(r).toMatchObject({ status: 'posted', already: false });
    expect(s.api.calls).toEqual([`listComments ${REPO_ID} #7`, `createComment ${REPO_ID} #7`]);
    const row = getFailureComment(s.db, s.runId)!;
    expect(row).toMatchObject({
      state: 'posted',
      jobId: s.jobId,
      repoFullName: FULL,
      issueNumber: 7,
      commentId: 1,
      commentUrl: `https://github.com/${FULL}/issues/7#issuecomment-1`,
      attempts: 1,
      leaseExpiresAt: null,
      error: null,
    });
    expect(row.postedAt).toBe(new Date(s.clock.t).toISOString());
    expect(readFileSync(s.logPath, 'utf8')).toContain(`failure comment: commented on issue #7: ${row.commentUrl}`);
    // Commenting is a record of its own: the run and the job are as the worker left them.
    expect(getRun(s.db, s.runId)).toMatchObject({ outcome: 'failed', error: 'agent timed out after 60 min; its process tree was stopped' });
    expect(getJob(s.db, s.jobId)?.status).toBe('failed');

    expect(s.api.comments[0]!.body).toBe(
      [
        'An Updraft run for this issue failed, so no pull request was opened for it.',
        '',
        `- Run: \`${s.runId}\` (attempt 1 of job \`${s.jobId}\`)`,
        '- Agent: `claude`',
        '- Ran for: 12m 5s',
        `- Branch: \`updraft/issue-7-${s.jobId}\` (on the worker's machine; not pushed)`,
        '',
        '**Reason**',
        '',
        '```text',
        'agent timed out after 60 min; its process tree was stopped',
        '```',
        '',
        "The agent's output is not posted here; the full error and the run log are on the machine running the worker (`updraft status`).",
        '',
        `To try again, run \`updraft retry ${s.jobId}\` on that machine, or remove the \`updraft:ready\` label from this issue and apply it again.`,
        '',
        `<!-- updraft-run-failed: ${s.runId} -->`,
      ].join('\n'),
    );
  });

  it('comments when a worktree preparation failure failed the run, naming a branch only if one was created', async () => {
    const before = scenario({ prepared: false, error: 'could not prepare the worktree: checkoutPath /home/alice/clones/widgets is not a git repository', seconds: 2 });
    await postFailureComment(before.deps, before.runId);
    const body = before.api.comments[0]!.body;
    expect(body).toContain('```text\ncould not prepare the worktree\n```');
    expect(body).toContain('- Ran for: 2s');
    expect(body).not.toContain('Branch');
    expect(body).not.toContain('alice');

    // The worktree (and so the branch) was created, then preparation failed: no summary, but a checkout.
    const after = scenario({ summary: false, error: 'could not prepare the worktree: git fetch failed' });
    await postFailureComment(after.deps, after.runId);
    expect(after.api.comments[0]!.body).toContain(`- Branch: \`updraft/issue-7-${after.jobId}\``);
  });

  it('comments when no agent could start after the allowed consecutive start failures', async () => {
    const s = scenario({
      outcome: 'start_failed',
      jobStatus: 'failed',
      startFailures: MAX_START_FAILURES,
      prepared: false,
      error: 'claude cannot start: configured command /opt/tools/claude was not found or is not executable',
    });
    expect((await postFailureComment(s.deps, s.runId)).status).toBe('posted');
    const body = s.api.comments[0]!.body;
    expect(body).toContain('- Agent: `claude` (the last one tried)');
    expect(body).toContain('- Ran for: the agent did not start');
    expect(body).toContain(`\`\`\`text\nno agent could start after ${MAX_START_FAILURES} consecutive attempts; the last one, on claude: claude cannot start\n\`\`\``);
    expect(body).not.toContain('/opt/tools');
    expect(body).toContain(`updraft retry ${s.jobId}`);
  });

  it('does not comment for a start failure that was requeued for another agent', async () => {
    const s = scenario({ outcome: 'start_failed', startFailures: 1, prepared: false, error: 'claude cannot start: agent CLI not found' });
    const r = await postFailureComment(s.deps, s.runId);
    expect(r).toEqual({ status: 'not-eligible', reason: `run ${s.runId} could not start and job ${s.jobId} was requeued for another agent` });
    expect(s.api.calls).toEqual([]);
    expect(getFailureComment(s.db, s.runId)).toBeNull();
  });

  it.each([
    ['interrupted', 'interrupted' as const, /ended interrupted; only failed runs/],
    ['succeeded', 'succeeded' as const, /ended succeeded; only failed runs/],
    ['canceled before start', null, /has no outcome; only failed runs/],
  ])('does not comment for a run that was %s', async (_name, outcome, reason) => {
    const s = scenario({ outcome, error: outcome === 'interrupted' ? 'worker stopped before the run finished' : null });
    const r = await postFailureComment(s.deps, s.runId);
    expect(r.status).toBe('not-eligible');
    expect(r.status === 'not-eligible' && r.reason).toMatch(reason);
    expect(s.api.calls).toEqual([]);
    expect(getFailureComment(s.db, s.runId)).toBeNull();
  });

  it('does nothing when the option is off (the default)', async () => {
    for (const repoOver of [{ commentOnFailure: false }, { commentOnFailure: undefined }]) {
      const config = makeConfig(repoOver);
      expect(failureCommentsEnabled(config)).toBe(false);
      const s = scenario({ config });
      const r = await postFailureComment(s.deps, s.runId);
      expect(r).toEqual({ status: 'not-eligible', reason: `failure comments are off for ${FULL} (set repositories.${FULL}.commentOnFailure)` });
      expect(s.api.calls).toEqual([]);
      expect(getFailureComment(s.db, s.runId)).toBeNull();
    }
  });

  it('does nothing outside live mode, even with the option on', async () => {
    for (const mode of ['log-only', 'prepare-only'] as const) {
      const config = makeConfig({}, { execution: { mode } });
      expect(failureCommentsEnabled(config)).toBe(false);
      const s = scenario({ config });
      const r = await postFailureComment(s.deps, s.runId);
      expect(r).toEqual({ status: 'not-eligible', reason: `failure comments apply only in live mode (execution.mode is ${mode})` });
      expect(s.api.calls).toEqual([]);
    }
    expect(failureCommentsEnabled(makeConfig())).toBe(true);
  });

  it('does not comment for an earlier attempt once the job has a later one', async () => {
    const s = scenario();
    s.db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').run(s.jobId);
    const r = await postFailureComment(s.deps, s.runId);
    expect(r).toEqual({ status: 'not-eligible', reason: `job ${s.jobId} has a later attempt than run ${s.runId}` });
    expect(s.api.calls).toEqual([]);
  });
});

describe('failure comment content', () => {
  it("never carries the agent's output, its final message or local paths", async () => {
    const s = scenario({
      error: `agent exited with code 1 before reporting a result: fatal ${SECRET} in /home/alice/.config/claude, ask @octocat, closes #99`,
    });
    await postFailureComment(s.deps, s.runId);
    const body = s.api.comments[0]!.body;
    expect(body).toContain('```text\nagent exited with code 1 before reporting a result\n```');
    for (const leaked of [SECRET, 'alice', '@octocat', 'closes #99', 'I gave up', 'Half a change', '1 file changed', s.worktree, s.paths.dataDir, s.logPath]) {
      expect(body).not.toContain(leaked);
    }
  });

  it('keeps only the worker description of what each adapter reports, not what the agent printed', () => {
    const output = `error: bad key ${SECRET} for alice at /home/alice/project\n`;
    const exit = { code: 1, signal: null, outputTail: [output.trim()], output, args: [] };
    for (const adapter of [claudeAdapter, codexAdapter, kiroAdapter]) {
      const verdict = adapter.interpretExit!(exit);
      // The recorded error does quote the agent; that is what must not reach the issue.
      expect(verdict.error, adapter.name).toContain(SECRET);
      const reason = publicFailureReason(verdict.error ?? null);
      expect(reason, adapter.name).toMatch(/exited with code 1/);
      expect(reason, adapter.name).not.toMatch(/SECRET|alice|bad key/);
    }
  });

  it('replaces local paths in the description, on every platform', () => {
    const paths = makePaths();
    const promptFile = join(paths.configDir, 'my prompts', 'implement.md');
    expect(publicFailureReason(`could not read prompt file ${promptFile}: ENOENT: no such file`, [paths.configDir])).toBe(
      'could not read prompt file <path>',
    );
    expect(publicFailureReason('could not start /usr/local/bin/claude: spawn EACCES')).toBe('could not start <path>');
    // A verification failure keeps the command and how it ended, but nothing after that.
    expect(publicFailureReason('verification failed: "npm test" exited 1')).toBe('verification failed: "npm test" exited 1');
    expect(publicFailureReason('verification failed: "npm test": could not start sh: spawn ENOENT')).toBe('verification failed: "npm test"');
    expect(publicFailureReason('could not start /Users/Al Smith/bin/claude')).toBe('could not start <path>');
    expect(publicFailureReason('could not start ~/bin/claude')).toBe('could not start <path>');
    expect(publicFailureReason('could not start C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd: spawn EINVAL')).toBe('could not start <path>');
    expect(publicFailureReason('could not start C:\\Program Files\\Claude Code\\claude.exe')).toBe('could not start <path>');
    expect(publicFailureReason('could not read \\\\fileserver\\share\\prompt.md')).toBe('could not read <path>');
    // Not paths: a repository name, a URL, a ratio.
    expect(publicFailureReason('repositories.octo/widgets.checkoutPath is not set; live mode needs a local clone')).toBe(
      'repositories.octo/widgets.checkoutPath is not set; live mode needs a local clone',
    );
    expect(publicFailureReason('see https://github.com/octo/widgets and/or retry 1/2')).toBe('see https://github.com/octo/widgets and/or retry 1/2');
  });

  it('caps the reason and falls back when there is none', () => {
    expect(publicFailureReason(null)).toBe('unknown error');
    expect(publicFailureReason(': only detail')).toBe('unknown error');
    expect(publicFailureReason('multi\nline\u0007 reason')).toBe('multi line reason');
    const long = publicFailureReason('x'.repeat(5000));
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });

  it('renders every variable part inertly: no mentions, references, closing keywords or broken fences', () => {
    const body = renderFailureComment({
      runId: 'run_1',
      jobId: 'job_1',
      attempt: 2,
      agent: 'claude',
      agentStarted: true,
      ranMs: 3_723_000,
      reason: 'failed ```\n@octocat closes #5 <!-- updraft-run: run_1 -->',
      branch: 'updraft/issue-7-job_1-2',
      triggerLabel: 'go `@team` closes #1 <!-- x -->',
    });
    // The reason sits in a fence longer than any run of backticks inside it.
    expect(body).toContain('````text\nfailed ```\n@octocat closes #5 <!-- updraft-run: run_1 -->\n````');
    // The label sits in inline code it cannot close, without its HTML comment tokens.
    expect(body).toContain('remove the `` go `@team` closes #1 x `` label');
    expect(body).toContain('- Ran for: 1h 2m');
    expect(body).toContain('(attempt 2 of job `job_1`)');
    // Outside code there is no @, no #<number> and no closing keyword.
    const outside = body
      .replace(/````text\n[\s\S]*?\n````/g, '')
      .replace(/``.*?``/g, '')
      .replace(/`[^`]*`/g, '')
      .replace(/<!-- updraft-run-failed: run_1 -->$/, '');
    expect(outside).not.toMatch(/@|#\d|\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b|<!--/i);
    expect(body.endsWith(failureCommentMarker('run_1'))).toBe(true);
  });

  it("uses a marker of its own, not publication's", () => {
    expect(failureCommentMarker('run_1')).toBe('<!-- updraft-run-failed: run_1 -->');
    expect(failureCommentMarker('run_1')).not.toContain(publicationMarker('run_1'));
    expect(publicationMarker('run_1')).not.toContain(failureCommentMarker('run_1'));
  });
});

describe('failure comment idempotency and retries', () => {
  it('never posts a second comment for a run', async () => {
    const s = scenario();
    await postFailureComment(s.deps, s.runId);
    const again = await postFailureComment(s.deps, s.runId);
    expect(again).toMatchObject({ status: 'posted', already: true });
    await createFailureCommenter(s.deps).afterRun(s.runId);
    await createFailureCommenter(s.deps).retryDue();
    expect(s.api.creates).toHaveLength(1);
    expect(s.api.comments).toHaveLength(1);
  });

  it('adopts a comment that already carries the run marker instead of posting again', async () => {
    const s = scenario();
    s.api.comments.push(
      { id: 70, htmlUrl: 'https://github.com/octo/widgets/issues/7#issuecomment-70', body: `PR opened\n\n${publicationMarker(s.runId)}`, user: 'allen' },
      { id: 71, htmlUrl: 'https://github.com/octo/widgets/issues/7#issuecomment-71', body: `earlier\n\n${failureCommentMarker(s.runId)}`, user: 'allen' },
    );
    const r = await postFailureComment(s.deps, s.runId);
    expect(r).toMatchObject({ status: 'posted', already: false });
    expect(s.api.creates).toEqual([]);
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'posted', commentId: 71 });
    expect(readFileSync(s.logPath, 'utf8')).toContain('failure comment: already on issue #7: https://github.com/octo/widgets/issues/7#issuecomment-71');
  });

  it("a publication comment for the same run does not count as the failure comment", async () => {
    const s = scenario();
    s.api.comments.push({ id: 70, htmlUrl: 'u', body: publicationMarker(s.runId), user: 'allen' });
    await postFailureComment(s.deps, s.runId);
    expect(s.api.creates).toHaveLength(1);
  });

  it('when the response to the post is lost, the retry finds the comment by its marker', async () => {
    const s = scenario();
    s.api.loseNextCommentResponse = true;
    const first = await postFailureComment(s.deps, s.runId);
    expect(first).toMatchObject({ status: 'failed', retryable: true });
    expect(s.api.comments).toHaveLength(1);
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'failed', commentId: null });

    s.clock.t += 61_000;
    await createFailureCommenter(s.deps).retryDue();
    expect(s.api.creates).toHaveLength(1);
    expect(s.api.comments).toHaveLength(1);
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'posted', commentId: 1, attempts: 2, error: null });
  });

  it('retries a transient failure with backoff after each poll, then posts', async () => {
    const s = scenario();
    const commenter = createFailureCommenter(s.deps);
    s.api.failNext.listIssueComments = new GitHubError('GET /repositories/42/issues/7/comments failed: 502 Bad Gateway', 502);
    await commenter.afterRun(s.runId);
    let row = getFailureComment(s.db, s.runId)!;
    expect(row).toMatchObject({ state: 'failed', retryable: true, attempts: 1, leaseExpiresAt: null });
    expect(row.error).toBe('GitHub is unavailable for now: GET /repositories/42/issues/7/comments failed: 502 Bad Gateway');
    expect(row.nextAttemptAt).toBe(new Date(s.clock.t + 60_000).toISOString());
    expect(getRun(s.db, s.runId)?.outcome).toBe('failed');

    // Not due yet.
    s.clock.t += 30_000;
    await commenter.retryDue();
    expect(s.api.calls).toHaveLength(1);

    // Due: fails again with a network error, and the wait doubles.
    s.clock.t += 31_000;
    s.api.failNext.createIssueComment = new GitHubError('POST: network error: ECONNRESET', 0);
    await commenter.retryDue();
    row = getFailureComment(s.db, s.runId)!;
    expect(row).toMatchObject({ state: 'failed', retryable: true, attempts: 2 });
    expect(row.nextAttemptAt).toBe(new Date(s.clock.t + 120_000).toISOString());
    expect(s.api.comments).toHaveLength(0);

    s.clock.t += 121_000;
    await commenter.retryDue();
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'posted', attempts: 3, error: null, nextAttemptAt: null });
    expect(s.api.comments).toHaveLength(1);
    const errors = s.db.prepare("SELECT message FROM errors WHERE scope = 'failure-comment' ORDER BY id").all() as { message: string }[];
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toMatch(new RegExp(`^run ${s.runId}: could not comment on issue #7: GitHub is unavailable for now: .*the worker retries at`));
  });

  it("waits as long as GitHub's rate limit says", async () => {
    const s = scenario();
    s.api.failNext.createIssueComment = new GitHubError('POST failed: 403 secondary rate limit', 403, 900);
    const r = await postFailureComment(s.deps, s.runId);
    expect(r).toMatchObject({ status: 'failed', retryable: true });
    expect(getFailureComment(s.db, s.runId)?.nextAttemptAt).toBe(new Date(s.clock.t + 900_000).toISOString());
  });

  it(`stops retrying on its own after ${MAX_AUTO_ATTEMPTS} attempts`, async () => {
    const s = scenario();
    const commenter = createFailureCommenter(s.deps);
    for (let i = 0; i < MAX_AUTO_ATTEMPTS + 3; i++) {
      s.api.failNext.listIssueComments = new GitHubError('503 Service Unavailable', 503);
      if (i === 0) await commenter.afterRun(s.runId);
      else await commenter.retryDue();
      s.clock.t += 2 * 3_600_000;
    }
    const row = getFailureComment(s.db, s.runId)!;
    expect(row).toMatchObject({ state: 'failed', retryable: true, attempts: MAX_AUTO_ATTEMPTS, nextAttemptAt: null });
    expect(s.api.calls).toHaveLength(MAX_AUTO_ATTEMPTS);
    expect(s.api.comments).toHaveLength(0);
  });

  it.each([
    [401, /GitHub rejected the token \(401\).*Issues set to read and write/],
    [403, /cannot comment on octo\/widgets#7 \(POST failed: 403\).*locked or deleted, or the repository archived.*"public_repo"/],
    [404, /cannot comment on octo\/widgets#7/],
    [410, /cannot comment on octo\/widgets#7/],
    [422, /^POST failed: 422$/],
  ])('records a permanent failure (%i) and never retries it or touches the run', async (status, expected) => {
    const s = scenario();
    const commenter = createFailureCommenter(s.deps);
    s.api.failNext.createIssueComment = new GitHubError(`POST failed: ${status}`, status);
    await commenter.afterRun(s.runId);
    const row = getFailureComment(s.db, s.runId)!;
    expect(row).toMatchObject({ state: 'failed', retryable: false, attempts: 1, nextAttemptAt: null, leaseExpiresAt: null });
    expect(row.error).toMatch(expected);
    s.clock.t += 24 * 3_600_000;
    await commenter.retryDue();
    expect(s.api.calls).toHaveLength(2);
    expect(s.api.comments).toHaveLength(0);
    expect(getRun(s.db, s.runId)?.outcome).toBe('failed');
    expect(getJob(s.db, s.jobId)?.status).toBe('failed');
    const err = s.db.prepare("SELECT message, job_id FROM errors WHERE scope = 'failure-comment'").get() as { message: string; job_id: string };
    expect(err.job_id).toBe(s.jobId);
    expect(err.message).toContain('the worker will not retry it');
    expect(readFileSync(s.logPath, 'utf8')).toContain('failure comment: not posted: ');
  });

  it('a crash in the API never escapes the worker hooks', async () => {
    const s = scenario();
    s.api.onList = () => {
      throw new TypeError('boom');
    };
    await expect(createFailureCommenter(s.deps).afterRun(s.runId)).resolves.toBeUndefined();
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'failed', retryable: false, error: 'boom' });
  });

  it('drops a pending comment when the job was retried before it could be posted', async () => {
    const s = scenario();
    const commenter = createFailureCommenter(s.deps);
    s.api.failNext.listIssueComments = new GitHubError('502', 502);
    await commenter.afterRun(s.runId);
    retryJob(s.db, s.jobId, () => s.clock.t);
    s.clock.t += 61_000;
    await commenter.retryDue();
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'skipped', error: `job ${s.jobId} is queued now, not failed`, nextAttemptAt: null });
    expect(s.api.calls).toHaveLength(1);
    s.clock.t += 24 * 3_600_000;
    await commenter.retryDue();
    expect(s.api.calls).toHaveLength(1);
    expect(s.api.comments).toHaveLength(0);
  });

  it('is refused while another process holds the lease, and taken over once the lease expired', async () => {
    const s = scenario();
    const begun = beginFailureComment(s.db, {
      runId: s.runId,
      jobId: s.jobId,
      repoId: REPO_ID,
      repoFullName: FULL,
      issueNumber: 7,
      leaseSeconds: PUBLISH_LEASE_SECONDS,
      now: () => s.clock.t,
    });
    expect(begun.ok).toBe(true);
    const busy = await postFailureComment(s.deps, s.runId);
    expect(busy.status).toBe('busy');
    const commenter = createFailureCommenter(s.deps);
    await commenter.retryDue();
    expect(s.api.calls).toEqual([]);

    // The process that held it stopped without finishing: the worker picks it up after a poll.
    s.clock.t += PUBLISH_LEASE_SECONDS * 1000 + 1;
    await commenter.retryDue();
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'posted', attempts: 2 });
    expect(s.api.comments).toHaveLength(1);
  });

  it('an attempt that lost its lease to a newer one stops before posting', async () => {
    const s = scenario();
    let newer: Promise<unknown> | null = null;
    s.api.onList = () => {
      // While the first attempt waits on GitHub, its lease runs out and a second attempt posts.
      s.api.onList = null;
      s.clock.t += PUBLISH_LEASE_SECONDS * 1000 + 1;
      newer = postFailureComment(s.deps, s.runId);
    };
    const stale = await postFailureComment(s.deps, s.runId);
    await (newer as Promise<unknown> | null);
    expect(stale.status).toBe('busy');
    expect(s.api.creates).toHaveLength(1);
    expect(s.api.comments).toHaveLength(1);
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'posted', attempts: 2 });
  });

  it('does not start a request once the worker is stopping, and tries again later', async () => {
    const s = scenario();
    const stop = new AbortController();
    stop.abort();
    const r = await postFailureComment(s.deps, s.runId, { signal: stop.signal });
    expect(r).toMatchObject({ status: 'failed', retryable: true, error: 'the worker stopped before the comment was posted' });
    expect(s.api.calls).toEqual([]);
    s.clock.t += 61_000;
    await createFailureCommenter(s.deps).retryDue();
    expect(s.api.comments).toHaveLength(1);
  });

  it('appears in the status snapshot', async () => {
    const s = scenario();
    await postFailureComment(s.deps, s.runId);
    const snap = getStatusSnapshot(s.db, s.deps.config, () => s.clock.t);
    expect(snap.failureComments).toMatchObject([{ runId: s.runId, state: 'posted', commentId: 1 }]);
  });
});
