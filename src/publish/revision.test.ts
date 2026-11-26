// The revision push and reply, against real git (test/git-fixtures.ts) and an in-memory GitHub.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { fakeContext } from '../commands/fakes.js';
import { publishCommand } from '../commands/publish.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { getFailureComment } from '../db/failure-comments.js';
import { getPublication } from '../db/publications.js';
import { claimNextJob, getJob } from '../db/queue.js';
import { enqueueRevision, getRevision, getRevisionPr, listDueRevisions, recordReviewRequest, revisionJob, syncRevisionPrs } from '../db/revisions.js';
import { GitError, runGit, type GitOptions } from '../git/git.js';
import { jobBranchName, jobWorktreePath, prepareJobWorktree } from '../git/worktree.js';
import { GitHubError, type GitHubApi, type GitHubIssueComment } from '../github/api.js';
import type { UpdraftPaths } from '../paths.js';
import type { RepoRef, RevisionRequest, RunOutcome, RunSummary } from '../types.js';
import { getFinding, recordFindings, setThreadComment } from '../db/review-findings.js';
import type { PullRequestReviewComment } from '../github/api.js';
import { silentLogger } from '../util/log.js';
import { summarizeRun } from '../worker/run-summary.js';
import { failureCommentMarker, postFailureComment } from './failure-comment.js';
import { publishRun, type PublishDeps, type Publisher, type RunGit } from './publish.js';
import { createRevisionPublisher, findRevisionClaims, postLimitNotices, REVISION_LIMIT_MARKER, reviseRun, revisionClaimMarker, revisionMarker } from './revision.js';

const REPO_ID = 42;
const FULL = 'octo/widgets';
const PR = 100;
const TOKEN = 'ghp_SECRETtoken0123456789';
const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const REVIEW_URL = `https://github.com/${FULL}/pull/${PR}#pullrequestreview-9001`;

/** The comment side of GitHub. Any other method is a bug in the code under test. */
class FakeCommentsApi {
  comments: Array<GitHubIssueComment & { issue: number }> = [];
  readonly calls: string[] = [];
  failNext: Partial<Record<'createIssueComment' | 'listIssueComments', GitHubError>> = {};
  /** Create the comment, then fail as if the response was lost. */
  loseNextCommentResponse = false;
  private nextId = 1;

  private maybeFail(name: 'createIssueComment' | 'listIssueComments'): void {
    const err = this.failNext[name];
    if (err) {
      delete this.failNext[name];
      throw err;
    }
  }

  async listIssueComments(repo: RepoRef, issue: number): Promise<GitHubIssueComment[]> {
    this.calls.push(`listComments ${repo.id} #${issue}`);
    this.maybeFail('listIssueComments');
    return this.comments.filter((c) => c.issue === issue);
  }

  async createIssueComment(repo: RepoRef, issue: number, body: string): Promise<GitHubIssueComment> {
    this.calls.push(`createComment ${repo.id} #${issue}`);
    this.maybeFail('createIssueComment');
    const id = this.nextId++;
    const c = { id, htmlUrl: `https://github.com/${FULL}/pull/${issue}#issuecomment-${id}`, body, user: 'allen', issue };
    this.comments.push(c);
    if (this.loseNextCommentResponse) {
      this.loseNextCommentResponse = false;
      throw new GitHubError('POST /repositories/42/issues/100/comments: network error: socket hang up', 0);
    }
    return c;
  }

  async updateIssueComment(repo: RepoRef, commentId: number, body: string): Promise<GitHubIssueComment> {
    this.calls.push(`updateComment ${repo.id} ${commentId}`);
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) throw new GitHubError('comment not found', 404);
    c.body = body;
    return c;
  }

  /** Who the worker is: its comments carry this login (`allen`, as createIssueComment writes it). */
  async getWorkerIdentity(): Promise<{ kind: 'user'; login: string; id: number }> {
    return { kind: 'user', login: 'allen', id: 1 };
  }

  get api(): GitHubApi {
    return new Proxy(this, {
      get(target, prop) {
        // Not a thenable: an awaited api must resolve to itself.
        if (prop in target || prop === 'then' || typeof prop === 'symbol') return Reflect.get(target, prop, target) as unknown;
        return () => {
          throw new Error(`the revision push must not call ${String(prop)}`);
        };
      },
    }) as unknown as GitHubApi;
  }
}

const fixtures: GitFixture[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const f of fixtures.splice(0)) f.cleanup();
});

function makeConfig(f: GitFixture, repoOver: Record<string, unknown> = {}, mode = 'live'): UpdraftConfig {
  return configSchema.parse({
    version: 1,
    execution: { mode },
    dispatch: { allowedActors: ['allen'] },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompt.md', revisePrompt: './revise.md', output: 'local-branch' } },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: f.clone,
        remote: 'origin',
        baseBranch: 'main',
        publish: 'draft-pr',
        notifications: 'verbose',
        revise: true,
        commentOnFailure: true,
        workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
        ...repoOver,
      },
    },
  });
}

function makePaths(root: string): UpdraftPaths {
  const dataDir = join(root, 'updraft state');
  const logDir = join(dataDir, 'logs');
  return { configFile: join(root, 'cfg', 'config.yaml'), configDir: join(root, 'cfg'), dataDir, dbFile: join(dataDir, 'state.db'), logDir, runsDir: join(logDir, 'runs') };
}

interface Published {
  f: GitFixture;
  db: Db;
  paths: UpdraftPaths;
  /** The PR's branch: the original job's branch, on the remote. */
  prBranch: string;
  originalRunId: string;
}

function insertRun(db: Db, o: { runId: string; jobId: string; worktree: string; logPath: string; outcome: RunOutcome; summary: unknown; error?: string }): void {
  const at = new Date(T0).toISOString();
  db.prepare(
    `INSERT INTO runs (id, job_id, attempt, pool, agent, checkout_path, log_path, worker_id, lease_expires_at, started_at,
                       execution_started_at, ended_at, outcome, error, summary)
     VALUES (?, ?, 1, 'general', 'claude', ?, ?, 'wrk_1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.runId, o.jobId, o.worktree, o.logPath, at, at, at, at, o.outcome, o.error ?? null, JSON.stringify(o.summary));
  db.prepare('UPDATE jobs SET status = ?, attempts = 1 WHERE id = ?').run(o.outcome === 'failed' ? 'failed' : 'succeeded', o.jobId);
}

/** An issue job whose run was published: its branch is on the remote and PR #100 is recorded for it. */
async function published(o: { db?: Db; paths?: UpdraftPaths } = {}): Promise<Published> {
  const f = createGitFixture(FULL);
  fixtures.push(f);
  const db = o.db ?? openDatabase(':memory:');
  if (!o.db) dbs.push(db);
  const paths = o.paths ?? makePaths(f.root);
  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: 7 });
  const job = getJob(db, jobId)!;
  const prBranch = jobBranchName(job, 1);
  const prepared = await prepareJobWorktree({ checkoutPath: f.clone, repoFullName: FULL, remote: 'origin', baseBranch: 'main', branch: prBranch, worktreePath: jobWorktreePath(paths, job, 1) });
  writeFileSync(join(prepared.worktreePath, 'widget.txt'), 'a widget\n');
  f.git(prepared.worktreePath, 'add', '.');
  f.git(prepared.worktreePath, 'commit', '--quiet', '-m', 'Add the widget');
  f.git(f.clone, 'push', '--quiet', 'origin', `${prBranch}:refs/heads/${prBranch}`);
  const { summary } = await summarizeRun({ worktree: prepared.worktreePath, branch: prBranch, baseSha: prepared.baseSha, lastOutput: ['Done.'] });
  const originalRunId = `run_${jobId}`;
  insertRun(db, { runId: originalRunId, jobId, worktree: prepared.worktreePath, logPath: join(paths.runsDir, originalRunId, 'run.log'), outcome: 'succeeded', summary });
  const at = new Date(T0).toISOString();
  db.prepare(
    `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, base_branch, head_sha, pushed_at,
                               pr_number, pr_url, attempts, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, 7, 'draft-pr', 'published', ?, 'main', ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(originalRunId, jobId, REPO_ID, FULL, prBranch, f.git(f.clone, 'rev-parse', prBranch), at, PR, `https://github.com/${FULL}/pull/${PR}`, at, at, at);
  expect(syncRevisionPrs(db, REPO_ID)).toBe(1);
  return { f, db, paths, prBranch, originalRunId };
}

let reviewSeq = 0;

function request(p: Published, over: Partial<RevisionRequest['pullRequest']> = {}): RevisionRequest {
  reviewSeq++;
  return {
    trigger: 'changes_requested',
    pullRequest: { number: PR, url: `https://github.com/${FULL}/pull/${PR}`, branch: p.prBranch, ...over },
    sourceRunId: p.originalRunId,
    originalEventId: '5001',
    review: { id: `PRR_${reviewSeq}`, url: REVIEW_URL, author: 'allen', submittedAt: '2026-11-18T11:00:00Z', body: 'Please rename it.', comments: [], omittedComments: 0 },
  };
}

interface RevisionScenario extends Published {
  jobId: string;
  runId: string;
  logPath: string;
  /** The revision run's own branch in the clone. */
  localBranch: string;
  worktree: string;
  /** The remote head of the PR branch when the run started. */
  baseSha: string;
  localSha: string;
}

/**
 * A finished revision run for PR #100: its worktree created from the PR branch's remote head (as
 * the live executor does), `commits` commits made in it, its summary stored. `edit` can rewrite
 * the worktree before the run is recorded; `req` replaces the request the job carries.
 */
async function revised(
  p: Published,
  o: { commits?: number; outcome?: RunOutcome; edit?: (worktree: string) => void; req?: RevisionRequest; error?: string; resolutions?: RunSummary['resolutions'] } = {},
): Promise<RevisionScenario> {
  const { f, db, paths } = p;
  const req = o.req ?? request(p);
  const watched = getRevisionPr(db, REPO_ID, PR)!;
  const queued = enqueueRevision(db, {
    repoId: REPO_ID,
    reviewId: req.review.id,
    prNumber: PR,
    reviewer: 'allen',
    trigger: 'changes_requested',
    reviewUrl: REVIEW_URL,
    submittedAt: req.review.submittedAt,
    job: revisionJob({ id: REPO_ID, fullName: FULL }, watched, req),
    max: 10,
  });
  if (queued.status !== 'queued') throw new Error(`not queued: ${queued.status}`);
  const job = queued.job;
  const localBranch = jobBranchName(job, 1);
  // Exactly the executor's call for a revision job: the PR branch is the base.
  const prepared = await prepareJobWorktree({ checkoutPath: f.clone, repoFullName: FULL, remote: 'origin', baseBranch: p.prBranch, branch: localBranch, worktreePath: jobWorktreePath(paths, job, 1) });
  for (let i = 0; i < (o.commits ?? 1); i++) {
    writeFileSync(join(prepared.worktreePath, `revision-${i}.txt`), `revision ${i} of ${job.id}\n`);
    f.git(prepared.worktreePath, 'add', '.');
    f.git(prepared.worktreePath, 'commit', '--quiet', '-m', `Rename it (${i}), thanks @someone`);
  }
  o.edit?.(prepared.worktreePath);
  const { summary } = await summarizeRun({ worktree: prepared.worktreePath, branch: localBranch, baseSha: prepared.baseSha, lastOutput: ['Renamed it.', 'Ping @octocat ```not a fence```'] });
  if (o.resolutions) summary.resolutions = o.resolutions;
  const runId = `run_${job.id}`;
  const logPath = join(paths.runsDir, runId, 'run.log');
  mkdirSync(join(paths.runsDir, runId), { recursive: true });
  writeFileSync(logPath, 'updraft run\n');
  insertRun(db, { runId, jobId: job.id, worktree: prepared.worktreePath, logPath, outcome: o.outcome ?? 'succeeded', summary, ...(o.error ? { error: o.error } : {}) });
  return { ...p, jobId: job.id, runId, logPath, localBranch, worktree: prepared.worktreePath, baseSha: prepared.baseSha, localSha: f.git(f.clone, 'rev-parse', `refs/heads/${localBranch}`) };
}

function remoteSha(p: Published, branch = p.prBranch): string | null {
  const out = p.f.git(p.f.root, 'ls-remote', p.f.remoteDir, `refs/heads/${branch}`);
  return out ? out.split(/\s+/)[0]! : null;
}

/** Real git, recording each call. `beforePush` runs once, right before the push reaches git. */
function recordingGit(o: { beforePush?: () => void; failPushWith?: GitError } = {}): { runGit: RunGit; calls: Array<readonly string[]> } {
  const calls: Array<readonly string[]> = [];
  let hook = o.beforePush;
  return {
    calls,
    runGit: async (args, opts: GitOptions) => {
      calls.push([...args]);
      if (args[0] === 'push') {
        hook?.();
        hook = undefined;
        if (o.failPushWith) throw o.failPushWith;
      }
      return runGit(args, opts);
    },
  };
}

function deps(p: Published, api: FakeCommentsApi, over: Partial<PublishDeps> = {}): PublishDeps {
  return { db: p.db, config: makeConfig(p.f), paths: p.paths, api: api.api, log: silentLogger, token: async () => TOKEN, now: () => T0, ...over };
}

describe('reviseRun', { timeout: 120_000 }, () => {
  it('fast-forwards the PR branch from the head the run started from and replies once on the PR', async () => {
    const s = await revised(await published(), { commits: 2 });
    const api = new FakeCommentsApi();
    const git = recordingGit();
    const r = await reviseRun(deps(s, api, { runGit: git.runGit }), s.runId);

    expect(r.status).toBe('published');
    expect(remoteSha(s)).toBe(s.localSha);
    // Only the PR branch moved; main is where it was.
    expect(remoteSha(s, 'main')).toBe(s.f.git(s.f.clone, 'rev-parse', 'origin/main'));

    const pushes = git.calls.filter((c) => c[0] === 'push');
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push).toContain(`--force-with-lease=refs/heads/${s.prBranch}:${s.baseSha}`);
    expect(push.at(-1)).toBe(`${s.localSha}:refs/heads/${s.prBranch}`);
    expect(push.some((a) => a.startsWith('+') || a === '--force' || a === '-f')).toBe(false);
    expect(push.at(-2)).toBe(s.f.remoteDir);

    expect(api.comments).toHaveLength(1);
    const reply = api.comments[0]!;
    expect(reply.issue).toBe(PR);
    expect(reply.body).toContain('pushed 2 commit(s)');
    expect(reply.body).toContain(REVIEW_URL);
    expect(reply.body).toContain('Renamed it.');
    expect(reply.body.trimEnd().endsWith(revisionMarker(s.runId))).toBe(true);
    // The agent's words and the commit subjects are fenced: a mention in them notifies nobody.
    const outsideFences = reply.body.split(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/m).join('\n');
    expect(outsideFences).not.toContain('@octocat');
    expect(outsideFences).not.toContain('@someone');

    expect(getRevision(s.db, s.runId)).toMatchObject({
      state: 'published',
      prNumber: PR,
      branch: s.prBranch,
      baseSha: s.baseSha,
      headSha: s.localSha,
      moved: false,
      trigger: 'changes_requested',
      commentId: reply.id,
      attempts: 1,
      error: null,
    });
    expect(readFileSync(s.logPath, 'utf8')).toContain(`revision: commented on pull request #${PR}`);
    // Never a PR, a review, a merge: the fake throws on anything but comments.
    expect(api.calls).toEqual([`listComments ${REPO_ID} #${PR}`, `createComment ${REPO_ID} #${PR}`]);
  });

  it('answers each finding in its thread once the push is confirmed, and the rest in its reply', async () => {
    const p = await published();
    recordFindings(p.db, {
      repoId: REPO_ID,
      prNumber: PR,
      runId: 'run_rev1',
      headSha: 'h1',
      reviewId: 9,
      findings: [
        { id: 'F1', severity: 'blocker', title: 'Generation not checked', problem: 'p1', suggestion: null, path: 'src/a.ts', location: null, sameAs: null, notes: [] },
        { id: 'F2', severity: 'suggestion', title: 'Rename x', problem: 'p2', suggestion: null, path: null, location: null, sameAs: null, notes: [] },
      ],
    });
    setThreadComment(p.db, REPO_ID, PR, 'run_rev1#F1', { id: 70, url: 'https://github.com/octo/widgets/pull/100#discussion_r70' });
    const findings = [
      { key: 'run_rev1#F1', severity: 'blocker' as const, title: 'Generation not checked', problem: 'p1', suggestion: null, path: 'src/a.ts', line: 3, threadUrl: 'https://github.com/octo/widgets/pull/100#discussion_r70' },
      { key: 'run_rev1#F2', severity: 'suggestion' as const, title: 'Rename x', problem: 'p2', suggestion: null, path: null, line: null, threadUrl: null },
    ];
    const s = await revised(p, {
      req: { ...request(p), trigger: 'updraft_review', findings },
      resolutions: [
        { finding: 'run_rev1#F1', status: 'fixed', note: 'Retire compares generations now.', tests: 'npm test: 12 passed' },
        { finding: 'run_rev1#F2', status: 'disagreed', note: 'x is the domain term.', tests: null },
      ],
    });
    class ThreadsApi extends FakeCommentsApi {
      threadComments: PullRequestReviewComment[] = [{ id: 70, reviewId: 9, inReplyToId: null, user: 'allen', body: 'finding', path: 'src/a.ts', htmlUrl: 'https://github.com/octo/widgets/pull/100#discussion_r70' }];
      async listPullRequestReviewComments(): Promise<PullRequestReviewComment[]> {
        return [...this.threadComments];
      }
      async replyToReviewComment(_r: RepoRef, _pr: number, commentId: number, body: string): Promise<PullRequestReviewComment> {
        this.calls.push(`reply ${commentId}`);
        const c = { id: 71, reviewId: null, inReplyToId: commentId, user: 'allen', body, path: 'src/a.ts', htmlUrl: 'https://github.com/octo/widgets/pull/100#discussion_r71' };
        this.threadComments.push(c);
        return c;
      }
    }
    const api = new ThreadsApi();
    expect((await reviseRun(deps(s, api), s.runId)).status).toBe('published');
    expect(api.calls.filter((c) => c.startsWith('reply'))).toEqual(['reply 70']);
    const reply = api.threadComments.at(-1)!.body;
    expect(reply).toContain(`**Coding agent:** Fixed in [${s.localSha.slice(0, 12)}](https://github.com/${FULL}/commit/${s.localSha}). Retire compares generations now.`);
    expect(reply).toContain('Tests: npm test: 12 passed');
    expect(reply).toContain('not a verification');
    const pr = api.comments[0]!.body;
    expect(pr).toContain('**Coding agent** · pushed 1 commit(s)');
    expect(pr).toMatch(/<sub>Profile `[\w.-]+` · (adapter `\w+` · )?model `[\w .-]+` · effort `[\w .-]+`<\/sub>/);
    expect(pr).toContain('- Blocker · Generation not checked: fixed ([in its thread](https://github.com/octo/widgets/pull/100#discussion_r71))');
    expect(pr).toContain(`- Suggestion · Rename x: Not changed: I disagree, in`);
    expect(pr).toContain('x is the domain term.');
    expect(getFinding(p.db, REPO_ID, PR, 'run_rev1#F1')).toMatchObject({ resolution: 'fixed', resolutionSha: s.localSha, status: 'open' });
    expect(getFinding(p.db, REPO_ID, PR, 'run_rev1#F2')).toMatchObject({ resolution: 'disagreed' });

    // Again: nothing new in the thread.
    await reviseRun(deps(s, api), s.runId);
    expect(api.calls.filter((c) => c.startsWith('reply'))).toHaveLength(1);
  });

  it('says nothing in the threads of a revision that pushed nothing', async () => {
    const p = await published();
    const findings = [{ key: 'run_rev2#F1', severity: 'blocker' as const, title: 't', problem: 'p', suggestion: null, path: null, line: null, threadUrl: null }];
    const s = await revised(p, { commits: 0, req: { ...request(p), trigger: 'updraft_review', findings }, resolutions: [{ finding: 'run_rev2#F1', status: 'fixed', note: 'done', tests: null }] });
    const api = new FakeCommentsApi();
    await reviseRun(deps(s, api), s.runId);
    expect(api.comments[0]!.body).toContain('made no commits, so nothing was pushed');
    expect(api.comments[0]!.body).not.toContain('Fixed in');
  });

  it('builds on commits a person pushed to the PR branch before the run started', async () => {
    const p = await published();
    const theirs = p.f.pushCommit(p.prBranch, 'by-hand.txt', 'pushed by a person\n');
    const s = await revised(p);
    expect(s.baseSha).toBe(theirs);
    const r = await reviseRun(deps(s, new FakeCommentsApi()), s.runId);
    expect(r.status).toBe('published');
    expect(remoteSha(s)).toBe(s.localSha);
    expect(s.f.git(s.f.clone, 'merge-base', '--is-ancestor', theirs, s.localSha)).toBe('');
  });

  it('does not push when the PR branch moved after the run started, says so on the PR once, and never retries', async () => {
    const s = await revised(await published());
    const theirs = s.f.pushCommit(s.prBranch, 'by-hand.txt', 'pushed while the agent ran\n');
    const api = new FakeCommentsApi();
    const git = recordingGit();
    const r = await reviseRun(deps(s, api, { runGit: git.runGit }), s.runId);

    expect(r).toMatchObject({ status: 'failed', moved: true, retryable: false });
    expect(remoteSha(s)).toBe(theirs);
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false);
    expect(api.comments).toHaveLength(1);
    const notice = api.comments[0]!.body;
    expect(notice).toContain('did not push it');
    expect(notice).toContain(`moved from ${s.baseSha.slice(0, 12)} to ${theirs.slice(0, 12)}`);
    expect(notice).toContain(revisionMarker(s.runId));
    // The worker's own words only: no agent output, no local paths.
    expect(notice).not.toContain('Renamed it.');
    expect(notice).not.toContain(s.f.root);
    expect(getRevision(s.db, s.runId)).toMatchObject({ state: 'failed', moved: true, retryable: false, headSha: null, nextAttemptAt: null });
    expect(listDueRevisions(s.db, { now: () => T0 + 24 * 3600_000 })).toEqual([]);

    // `updraft publish` on it again: still refused, still one comment, still nothing pushed.
    const again = await reviseRun(deps(s, api, { runGit: git.runGit }), s.runId);
    expect(again).toMatchObject({ status: 'failed', moved: true });
    expect(api.comments).toHaveLength(1);
    expect(remoteSha(s)).toBe(theirs);
  });

  it('is refused by the remote itself when the branch moves between the check and the push', async () => {
    const s = await revised(await published());
    let theirs = '';
    const git = recordingGit({ beforePush: () => (theirs = s.f.pushCommit(s.prBranch, 'race.txt', 'landed in between\n')) });
    const api = new FakeCommentsApi();
    const r = await reviseRun(deps(s, api, { runGit: git.runGit }), s.runId);

    // The push did reach git, with the lease, and git left the branch at the other commit.
    expect(git.calls.filter((c) => c[0] === 'push')).toHaveLength(1);
    expect(theirs).not.toBe('');
    expect(remoteSha(s)).toBe(theirs);
    expect(r).toMatchObject({ status: 'failed', moved: true, retryable: false });
    expect(api.comments).toHaveLength(1);
  });

  it('does not push a result that does not descend from the head the run started from', async () => {
    const p = await published();
    const s = await revised(p, {
      commits: 0,
      // The agent rewrote history: dropped the PR's commit and committed something else on main.
      edit: (worktree) => {
        p.f.git(worktree, 'reset', '--quiet', '--hard', 'origin/main');
        writeFileSync(join(worktree, 'rewritten.txt'), 'instead\n');
        p.f.git(worktree, 'add', '.');
        p.f.git(worktree, 'commit', '--quiet', '-m', 'Rewrite');
      },
    });
    const api = new FakeCommentsApi();
    const git = recordingGit();
    const r = await reviseRun(deps(s, api, { runGit: git.runGit }), s.runId);

    expect(r).toMatchObject({ status: 'failed', moved: false, retryable: false });
    expect(r.status === 'failed' && r.error).toContain('does not descend from');
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false);
    expect(remoteSha(s)).toBe(s.baseSha);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('would not be a fast-forward');
  });

  it('checks ancestry itself because git does not: a lease alone lets a rewrite through', async () => {
    // What the push would do without the worker's merge-base check, on a branch nobody needs.
    const p = await published();
    const base = p.f.pushCommit('probe', 'probe.txt', 'one\n');
    const scratch = join(p.f.root, 'probe work');
    p.f.git(p.f.root, 'clone', '--quiet', p.f.remoteDir, scratch);
    writeFileSync(join(scratch, 'unrelated.txt'), 'not a descendant of probe\n');
    p.f.git(scratch, 'add', '.');
    p.f.git(scratch, 'commit', '--quiet', '-m', 'unrelated');
    const rewritten = p.f.git(scratch, 'rev-parse', 'HEAD');
    p.f.git(scratch, 'push', '--quiet', `--force-with-lease=refs/heads/probe:${base}`, p.f.remoteDir, `${rewritten}:refs/heads/probe`);
    expect(remoteSha(p, 'probe')).toBe(rewritten);
  });

  it('refuses the base branch, a foreign branch and a PR it did not publish, before anything reaches the network', async () => {
    const cases: Array<{ name: string; arrange: (p: Published) => RevisionRequest; error: RegExp }> = [
      { name: 'base branch in the request', arrange: (p) => request(p, { branch: 'main' }), error: /published from updraft\/issue-7-\S+, not main/ },
      {
        name: 'base branch in the request and the record',
        arrange: (p) => {
          p.db.prepare("UPDATE revision_prs SET branch = 'main'").run();
          return request(p, { branch: 'main' });
        },
        error: /main is not a job branch/,
      },
      {
        name: 'a foreign branch',
        arrange: (p) => {
          p.f.pushCommit('feature/x', 'x.txt', 'x\n');
          p.db.prepare("UPDATE revision_prs SET branch = 'feature/x'").run();
          return request(p, { branch: 'feature/x' });
        },
        error: /feature\/x is not a job branch/,
      },
      {
        name: 'a PR that is not in the record',
        arrange: (p) => {
          p.db.prepare('DELETE FROM revision_prs').run();
          return request(p);
        },
        error: /not one this worker published/,
      },
    ];
    for (const c of cases) {
      const p = await published();
      // The job is queued while the record is intact, then the record is tampered with.
      const good = request(p);
      const s = await revised(p, { req: good });
      const bad = c.arrange(p);
      const envelope = getJob(p.db, s.jobId)!.envelope;
      p.db.prepare('UPDATE jobs SET envelope = ? WHERE id = ?').run(JSON.stringify({ ...envelope, revision: { ...bad, review: good.review } }), s.jobId);
      const before = { pr: remoteSha(p), main: remoteSha(p, 'main'), other: remoteSha(p, 'feature/x') };

      const api = new FakeCommentsApi();
      const git = recordingGit();
      const r = await reviseRun(deps(s, api, { runGit: git.runGit }), s.runId);
      expect(r, c.name).toMatchObject({ status: 'failed', retryable: false, moved: false });
      expect(r.status === 'failed' && r.error, c.name).toMatch(c.error);
      expect(git.calls, c.name).toEqual([]);
      expect(api.calls, c.name).toEqual([]);
      expect({ pr: remoteSha(p), main: remoteSha(p, 'main'), other: remoteSha(p, 'feature/x') }, c.name).toEqual(before);
    }
  });

  it('refuses a job branch that is also the configured base branch', async () => {
    const s = await revised(await published());
    const git = recordingGit();
    const r = await reviseRun(deps(s, new FakeCommentsApi(), { runGit: git.runGit, config: makeConfig(s.f, { baseBranch: s.prBranch }) }), s.runId);
    expect(r.status === 'failed' && r.error).toContain('is the base or default branch');
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false);
    expect(remoteSha(s)).toBe(s.baseSha);
  });

  it('never posts the reply twice: a lost response and a failed request are both resumed', async () => {
    const s = await revised(await published());
    const api = new FakeCommentsApi();
    api.loseNextCommentResponse = true;
    const first = await reviseRun(deps(s, api), s.runId);
    expect(first).toMatchObject({ status: 'failed', retryable: true });
    expect(remoteSha(s)).toBe(s.localSha);
    expect(getRevision(s.db, s.runId)).toMatchObject({ state: 'failed', retryable: true, headSha: s.localSha, commentId: null });
    expect(listDueRevisions(s.db, { now: () => T0 + 3600_000 })).toEqual([s.runId]);

    const git = recordingGit();
    const second = await reviseRun(deps(s, api, { runGit: git.runGit }), s.runId);
    expect(second.status).toBe('published');
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false);
    expect(api.comments).toHaveLength(1);
    expect(getRevision(s.db, s.runId)).toMatchObject({ state: 'published', attempts: 2, commentId: api.comments[0]!.id });

    const third = await reviseRun(deps(s, api), s.runId);
    expect(third).toMatchObject({ status: 'published', already: true });
    expect(api.comments).toHaveLength(1);

    const t = await revised(s);
    const api2 = new FakeCommentsApi();
    api2.failNext.createIssueComment = new GitHubError('POST ... failed: 502', 502);
    expect(await reviseRun(deps(t, api2), t.runId)).toMatchObject({ status: 'failed', retryable: true });
    expect(await reviseRun(deps(t, api2), t.runId)).toMatchObject({ status: 'published' });
    expect(api2.comments).toHaveLength(1);
  });

  it('retries a push that failed for the network, with the same lease', async () => {
    const s = await revised(await published());
    const api = new FakeCommentsApi();
    const failing = recordingGit({ failPushWith: new GitError('git push failed', ['push'], 128, 'fatal: unable to access: Could not resolve host: github.com') });
    expect(await reviseRun(deps(s, api, { runGit: failing.runGit }), s.runId)).toMatchObject({ status: 'failed', retryable: true, moved: false });
    expect(remoteSha(s)).toBe(s.baseSha);
    expect(api.comments).toHaveLength(0);
    expect(await reviseRun(deps(s, api), s.runId)).toMatchObject({ status: 'published' });
    expect(remoteSha(s)).toBe(s.localSha);
  });

  it('pushes nothing when the agent made no commits, but still answers the review', async () => {
    const s = await revised(await published(), { commits: 0 });
    const api = new FakeCommentsApi();
    const git = recordingGit();
    const r = await reviseRun(deps(s, api, { runGit: git.runGit }), s.runId);
    expect(r.status).toBe('skipped');
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('made no commits');
    expect(getRevision(s.db, s.runId)).toMatchObject({ state: 'skipped', headSha: null });
  });

  it('answers a CI fix as the Coding agent, naming the failed head and linking the commit it pushed, not as a change request', async () => {
    const p = await published();
    const failedSha = 'a'.repeat(40);
    const ci = (base: RevisionRequest): RevisionRequest => ({
      ...base,
      trigger: 'ci_failure',
      reviewedSha: failedSha,
      review: { ...base.review, url: `https://github.com/${FULL}/runs/7`, author: 'updraft-bot[bot]', headSha: failedSha },
    });
    const s = await revised(p, { req: ci(request(p)) });
    const api = new FakeCommentsApi();
    expect((await reviseRun(deps(s, api), s.runId)).status).toBe('published');
    const reply = api.comments[0]!.body;
    expect(reply).toMatch(
      new RegExp(
        `^\\*\\*Coding agent\\*\\* · pushed 1 commit\\(s\\) to fix the checks that failed on \`${failedSha.slice(0, 12)}\` \\(https://github.com/${FULL}/runs/7\\); ` +
          `the pull request is now at \\[\`${s.localSha.slice(0, 12)}\`\\]\\(https://github.com/${FULL}/commit/${s.localSha}\\)\\.`,
      ),
    );
    expect(reply).toMatch(/not a verification: the review agent reviews the new head, and Updraft · CI reads its checks again/);
    expect(reply).not.toContain('changes requested by');

    // A CI fix that changed nothing says the checks stay failed and who acts next.
    const q = await published();
    const none = await revised(q, { commits: 0, req: ci(request(q)) });
    const api2 = new FakeCommentsApi();
    expect((await reviseRun(deps(none, api2), none.runId)).status).toBe('skipped');
    expect(api2.comments[0]!.body).toMatch(new RegExp(`a revision for the checks that failed on \`${failedSha.slice(0, 12)}\`.*made no commits`));
    expect(api2.comments[0]!.body).toMatch(/fixing them is up to a person/);
    expect(api2.comments[0]!.body).not.toContain('changes requested by');

    // A status's target URL is set by whatever wrote the status: only a plain https link is shown.
    const r = await published();
    const unsafe = (base: RevisionRequest): RevisionRequest => ({ ...ci(base), review: { ...ci(base).review, url: 'javascript:alert(1)' } });
    const bad = await revised(r, { req: unsafe(request(r)) });
    const api3 = new FakeCommentsApi();
    expect((await reviseRun(deps(bad, api3), bad.runId)).status).toBe('published');
    expect(api3.comments[0]!.body).toMatch(new RegExp(`to fix the checks that failed on \`${failedSha.slice(0, 12)}\`; the pull request is now at`));
    expect(api3.comments[0]!.body).not.toContain('javascript:');
    const t = await published();
    const badNone = await revised(t, { commits: 0, req: unsafe(request(t)) });
    const api4 = new FakeCommentsApi();
    await reviseRun(deps(badNone, api4), badNone.runId);
    expect(api4.comments[0]!.body).toMatch(new RegExp(`a revision for the checks that failed on \`${failedSha.slice(0, 12)}\`, but`));
    expect(api4.comments[0]!.body).not.toContain('javascript:');
  });

  it('quiet notifications: a CI fix pushes, and posts no reply and no claim on the PR; a change request is still answered', async () => {
    const p = await published();
    const failedSha = 'a'.repeat(40);
    const base = request(p);
    const req: RevisionRequest = { ...base, trigger: 'ci_failure', reviewedSha: failedSha, review: { ...base.review, url: `https://github.com/${FULL}/runs/7`, author: 'updraft-bot[bot]', headSha: failedSha } };
    const s = await revised(p, { req });
    const api = new FakeCommentsApi();
    const quiet = makeConfig(s.f, { notifications: 'quiet' });
    expect((await reviseRun(deps(s, api, { config: quiet, claimReviews: true }), s.runId)).status).toBe('published');
    expect(api.comments).toEqual([]);

    const q = await published();
    const r = await revised(q);
    const api2 = new FakeCommentsApi();
    expect((await reviseRun(deps(r, api2, { config: makeConfig(r.f, { notifications: 'quiet' }) }), r.runId)).status).toBe('published');
    expect(api2.comments).toHaveLength(1);
  });

  it('quiet notifications: two runners fixing the same failed head land exactly one revision, and neither says anything on the PR', async () => {
    const p = await published();
    const failedSha = remoteSha(p)!;
    const ciReq = (base: RevisionRequest): RevisionRequest => ({ ...base, trigger: 'ci_failure', reviewedSha: failedSha, review: { ...base.review, id: `ci-failure:${PR}:${failedSha}`, url: `https://github.com/${FULL}/runs/7`, author: 'updraft-bot[bot]', headSha: failedSha } });
    // Two machines' runs for the one CI-fix review, both prepared from the failed head.
    const a = await revised(p, { req: ciReq(request(p)) });
    const other = ciReq(request(p));
    const b = await revised(p, { req: { ...other, review: { ...other.review, id: 'ci-failure-second-machine' } } });
    const env = JSON.parse((p.db.prepare('SELECT envelope FROM jobs WHERE id = ?').get(b.jobId) as { envelope: string }).envelope) as { revision: RevisionRequest };
    env.revision.review.id = `ci-failure:${PR}:${failedSha}`;
    p.db.prepare('UPDATE jobs SET envelope = ? WHERE id = ?').run(JSON.stringify(env), b.jobId);
    expect(b.baseSha).toBe(a.baseSha);

    const quiet = makeConfig(p.f, { notifications: 'quiet' });
    const apiA = new FakeCommentsApi();
    const apiB = new FakeCommentsApi();
    // B gets as far as its first push; A then runs to the end; then B goes on: the race at its worst.
    let resultA: Awaited<ReturnType<typeof reviseRun>> | undefined;
    let raced = false;
    const racing: RunGit = async (args, opts) => {
      if (args[0] === 'push' && !raced) {
        raced = true;
        resultA = await reviseRun(deps(a, apiA, { config: quiet, claimReviews: true }), a.runId);
      }
      return runGit(args, opts);
    };
    const resultB = await reviseRun(deps(b, apiB, { config: quiet, claimReviews: true, runGit: racing }), b.runId);
    expect(resultA).toMatchObject({ status: 'published' });
    expect(resultB).toMatchObject({ status: 'skipped' });
    expect(getRevision(p.db, b.runId)!.error).toMatch(/^superseded: /);
    // Exactly one revision on the branch: A's.
    expect(remoteSha(p)).toBe(a.localSha);
    expect(p.f.git(p.f.clone, 'log', '--format=%H', `${failedSha}..${a.localSha}`).split('\n')).toHaveLength(1);
    // Nothing on the pull request, from either.
    expect(apiA.comments).toEqual([]);
    expect(apiB.comments).toEqual([]);
    // The claims are refs, not branches.
    expect(p.f.git(p.f.root, 'ls-remote', '--heads', p.f.remoteDir)).not.toContain('revision-claims');
    // The winner's claim stays (it is what a later loser reads); the loser took its own back.
    const claims = p.f.git(p.f.root, 'ls-remote', p.f.remoteDir, 'refs/updraft/*');
    expect(claims).toContain(`${a.localSha}\trefs/updraft/revision-claims/ci-failure-${PR}-${failedSha}/${a.runId}`);
    expect(claims).not.toContain(b.runId);

    // A third machine, prepared from the failed head after A landed: it gives way before pushing anything.
    const c = await revised(p, { req: { ...other, review: { ...other.review, id: 'ci-failure-third-machine' } } });
    const envC = JSON.parse((p.db.prepare('SELECT envelope FROM jobs WHERE id = ?').get(c.jobId) as { envelope: string }).envelope) as { revision: RevisionRequest };
    envC.revision.review.id = `ci-failure:${PR}:${failedSha}`;
    p.db.prepare('UPDATE jobs SET envelope = ? WHERE id = ?').run(JSON.stringify(envC), c.jobId);
    expect(await reviseRun(deps(c, new FakeCommentsApi(), { config: quiet, claimReviews: true }), c.runId)).toMatchObject({ status: 'skipped' });
    expect(remoteSha(p)).toBe(a.localSha);
  });

  it('quiet notifications: a remote that refuses the claim ref costs only the claim, never the CI fix', async () => {
    const p = await published();
    const failedSha = remoteSha(p)!;
    const base = request(p);
    const s = await revised(p, { req: { ...base, trigger: 'ci_failure', reviewedSha: failedSha, review: { ...base.review, url: `https://github.com/${FULL}/runs/7`, author: 'updraft-bot[bot]', headSha: failedSha } } });
    // As a ruleset or a pre-receive hook refuses refs outside branches and tags.
    const refusing: RunGit = async (args, opts) => {
      if (args[0] === 'push' && args.some((a) => a.includes(':refs/updraft/'))) {
        throw new GitError('git push failed', [...args], 1, ' ! [remote rejected] refs/updraft/revision-claims/x (pre-receive hook declined)');
      }
      return runGit(args, opts);
    };
    const api = new FakeCommentsApi();
    const r = await reviseRun(deps(s, api, { config: makeConfig(s.f, { notifications: 'quiet' }), claimReviews: true, runGit: refusing }), s.runId);
    expect(r).toMatchObject({ status: 'published' });
    expect(remoteSha(p)).toBe(s.localSha);
    expect(api.comments).toEqual([]);
    expect(readFileSync(s.logPath, 'utf8')).toContain('the remote refused the claim ref');
  });

  it('pushes nothing to a PR that was closed while the revision ran', async () => {
    const s = await revised(await published());
    s.db.prepare("UPDATE revision_prs SET state = 'closed'").run();
    const api = new FakeCommentsApi();
    const r = await reviseRun(deps(s, api), s.runId);
    expect(r.status).toBe('skipped');
    expect(remoteSha(s)).toBe(s.baseSha);
    expect(api.calls).toEqual([]);
  });

  it('applies only to succeeded revision runs, with revise on, in live mode', async () => {
    const p = await published();
    const s = await revised(p);
    const api = new FakeCommentsApi();
    expect(await reviseRun(deps(s, api), p.originalRunId)).toMatchObject({ status: 'not-eligible', reason: expect.stringContaining('not a revision run') as string });
    expect(await reviseRun(deps(s, api, { config: makeConfig(s.f, { revise: false }) }), s.runId)).toMatchObject({ status: 'not-eligible' });
    expect(await reviseRun(deps(s, api, { config: makeConfig(s.f, { publish: 'none' }) }), s.runId)).toMatchObject({ status: 'not-eligible' });
    expect(await reviseRun(deps(s, api, { config: makeConfig(s.f, {}, 'prepare-only') }), s.runId)).toMatchObject({ status: 'not-eligible' });
    const failed = await revised(p, { outcome: 'failed' });
    expect(await reviseRun(deps(failed, api), failed.runId)).toMatchObject({ status: 'not-eligible' });
    expect(remoteSha(s)).toBe(s.baseSha);
    expect(api.calls).toEqual([]);
    expect(getRevision(s.db, s.runId)).toBeNull();
  });

  it('is never published as a new PR: publication refuses a revision run', async () => {
    const s = await revised(await published());
    const r = await publishRun(deps(s, new FakeCommentsApi()), s.runId);
    expect(r).toMatchObject({ status: 'not-eligible', reason: expect.stringContaining('revision of an existing pull request') as string });
    expect(getPublication(s.db, s.runId)).toBeNull();
    expect(remoteSha(s, s.localBranch)).toBeNull();
  });
});

describe('reviseRun with claimReviews: one revision per review across machines', { timeout: 120_000 }, () => {
  /** The id of the review the scenario's run answers. */
  const reviewId = (s: RevisionScenario) => (JSON.parse((s.db.prepare('SELECT envelope FROM jobs WHERE id = ?').get(s.jobId) as { envelope: string }).envelope) as { revision: RevisionRequest }).revision.review.id;
  const claimed = (p: Published, api: FakeCommentsApi, over: Partial<PublishDeps> = {}) => deps(p, api, { claimReviews: true, ...over });
  /** A comment as another machine's revision of the same review leaves it. */
  const foreignClaim = (api: FakeCommentsApi, review: string, base: string, head: string, user = 'allen') =>
    api.comments.push({ id: 900 + api.comments.length, htmlUrl: 'https://github.com/octo/widgets/pull/100#issuecomment-900', body: `Updraft pushed 1 commit(s)\n\n${revisionMarker('run_other')}\n${revisionClaimMarker(review, base, head)}`, user, issue: PR });

  it('announces the push in the comment that then becomes the reply: one comment, written before the push', async () => {
    const s = await revised(await published());
    const REVIEW_ID = reviewId(s);
    const api = new FakeCommentsApi();
    let atPush: string[] = [];
    const git = recordingGit({ beforePush: () => (atPush = api.comments.map((c) => c.body)) });
    const r = await reviseRun(claimed(s, api, { runGit: git.runGit }), s.runId);
    expect(r).toMatchObject({ status: 'published' });
    expect(remoteSha(s)).toBe(s.localSha);
    const marker = revisionClaimMarker(REVIEW_ID, s.baseSha, s.localSha);
    expect(atPush).toHaveLength(1);
    expect(atPush[0]).toContain('Updraft is pushing 1 commit(s)');
    expect(atPush[0]).toContain(marker);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('Updraft pushed 1 commit(s)');
    expect(api.comments[0]!.body).toContain(marker);
    expect(api.comments[0]!.body).toContain(revisionMarker(s.runId));
    expect(await findRevisionClaims(api.api, { id: REPO_ID, fullName: FULL }, PR, REVIEW_ID)).toMatchObject([{ baseSha: s.baseSha, headSha: s.localSha, runId: s.runId }]);
  });

  it('gives way, without a push or a comment, when the head it started from already holds another run\'s revision for the review', async () => {
    const p = await published();
    // Another machine pushed its revision for the review; this run was prepared after that, on top of it.
    const before = remoteSha(p)!;
    const theirs = p.f.pushCommit(p.prBranch, 'theirs.txt', 'the other machine\'s revision\n');
    const s = await revised(p);
    expect(s.baseSha).toBe(theirs);
    const api = new FakeCommentsApi();
    foreignClaim(api, reviewId(s), before, theirs);
    const git = recordingGit();
    const r = await reviseRun(claimed(s, api, { runGit: git.runGit }), s.runId);
    expect(r).toMatchObject({ status: 'skipped' });
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false);
    expect(remoteSha(s)).toBe(theirs);
    expect(api.comments).toHaveLength(1);
    expect(getRevision(s.db, s.runId)).toMatchObject({ state: 'skipped', pushedAt: null, retryable: false, moved: false });
    expect(getRevision(s.db, s.runId)!.error).toMatch(/^superseded: /);
    expect(listDueRevisions(s.db, { now: () => T0 + 24 * 3600_000 })).toEqual([]);
    // Without claimReviews (the worker): the same run is pushed, as it always was.
    const s2 = await revised(await published());
    expect(await reviseRun(deps(s2, new FakeCommentsApi()), s2.runId)).toMatchObject({ status: 'published' });
  });

  it('ignores a claim whose push never came, and one that the worker did not write', async () => {
    const s = await revised(await published());
    const api = new FakeCommentsApi();
    // A run that announced a push from the same head and died: the branch is still where it was.
    foreignClaim(api, reviewId(s), s.baseSha, 'a'.repeat(40));
    // Anybody can write a comment that looks like a claim for the commit the branch is at.
    foreignClaim(api, reviewId(s), 'b'.repeat(40), s.baseSha, 'mallory');
    const r = await reviseRun(claimed(s, api), s.runId);
    expect(r).toMatchObject({ status: 'published' });
    expect(remoteSha(s)).toBe(s.localSha);
  });

  it('takes its announcement back when the push fails for good', async () => {
    const s = await revised(await published());
    const api = new FakeCommentsApi();
    const git = recordingGit({ failPushWith: new GitError('git push failed: remote: Permission to octo/widgets.git denied', ['push'], 128, 'remote: Permission to octo/widgets.git denied') });
    const r = await reviseRun(claimed(s, api, { runGit: git.runGit }), s.runId);
    // Refused for good (no permission to push): not retried, so nothing is still to come.
    expect(r).toMatchObject({ status: 'failed', retryable: false, moved: false });
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('did not push it');
    expect(await findRevisionClaims(api.api, { id: REPO_ID, fullName: FULL }, PR, reviewId(s))).toEqual([]);
  });

  it('still says so on the pull request when it was a person who moved the branch: the announcement becomes the notice', async () => {
    const s = await revised(await published());
    const api = new FakeCommentsApi();
    let theirs = '';
    const git = recordingGit({ beforePush: () => (theirs = s.f.pushCommit(s.prBranch, 'by-hand.txt', 'pushed between the check and the push\n')) });
    const r = await reviseRun(claimed(s, api, { runGit: git.runGit }), s.runId);
    expect(r).toMatchObject({ status: 'failed', moved: true, retryable: false });
    expect(remoteSha(s)).toBe(theirs);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('did not push it');
    // No longer a claim: a later revision for the review is free to push.
    expect(await findRevisionClaims(api.api, { id: REPO_ID, fullName: FULL }, PR, reviewId(s))).toEqual([]);
  });
});

describe('a failed revision run', { timeout: 120_000 }, () => {
  it('gets one failure comment on the pull request, without agent output or local paths', async () => {
    const p = await published();
    const s = await revised(p, { outcome: 'failed', error: `verification failed: "npm test" exited 1: see ${p.f.root}/secret output` });
    const api = new FakeCommentsApi();
    const d = { db: s.db, config: makeConfig(s.f), paths: s.paths, api: api.api, log: silentLogger, now: () => T0 };
    expect((await postFailureComment(d, s.runId)).status).toBe('posted');
    expect((await postFailureComment(d, s.runId)).status).toBe('posted');
    expect(api.comments).toHaveLength(1);
    const c = api.comments[0]!;
    expect(c.issue).toBe(PR);
    expect(c.body).toContain('revision run for this pull request failed');
    expect(c.body).toContain('submit a new review that requests changes');
    expect(c.body).toContain(failureCommentMarker(s.runId));
    expect(c.body).not.toContain('Renamed it.');
    expect(c.body).not.toContain(s.f.root);
    expect(getFailureComment(s.db, s.runId)).toMatchObject({ state: 'posted', issueNumber: PR });
  });

  it('gets none with commentOnFailure off', async () => {
    const s = await revised(await published(), { outcome: 'failed', error: 'agent exited 1' });
    const api = new FakeCommentsApi();
    const r = await postFailureComment({ db: s.db, config: makeConfig(s.f, { commentOnFailure: false }), paths: s.paths, api: api.api, log: silentLogger }, s.runId);
    expect(r.status).toBe('not-eligible');
    expect(api.calls).toEqual([]);
  });
});

describe('the worker side', { timeout: 120_000 }, () => {
  it('sends revision runs to the revision push and every other run to the publisher, and holds the next revision back', async () => {
    const p = await published();
    const s = await revised(p);
    // A second change request, queued while the first revision's push is still to come.
    const watched = getRevisionPr(p.db, REPO_ID, PR)!;
    const next = request(p);
    const second = enqueueRevision(p.db, {
      repoId: REPO_ID,
      reviewId: next.review.id,
      prNumber: PR,
      reviewer: 'allen',
      trigger: 'changes_requested',
      reviewUrl: REVIEW_URL,
      submittedAt: next.review.submittedAt,
      job: revisionJob({ id: REPO_ID, fullName: FULL }, watched, next),
      max: 10,
    });
    expect(second.status).toBe('queued');

    const seen: string[] = [];
    const inner: Publisher = {
      afterRun: async (id) => void seen.push(id),
      retryDue: async () => void seen.push('retryDue'),
      sweepUnpublished: async () => void seen.push('sweep'),
    };
    const api = new FakeCommentsApi();
    api.failNext.listIssueComments = new GitHubError('GET ... failed: 503', 503);
    const config = makeConfig(p.f);
    const publisher = createRevisionPublisher(deps(s, api), inner);
    const claimOpts = { workerId: 'wrk_1', hostname: hostname(), leaseSeconds: 60, runsDir: p.paths.runsDir, now: () => T0 };

    const pushing = publisher.afterRun(s.runId);
    // The row exists before afterRun yields, so the worker cannot claim the next revision in between.
    expect(getRevision(p.db, s.runId)).toMatchObject({ state: 'publishing' });
    expect(claimNextJob(p.db, config, claimOpts)).toBeNull();
    await pushing;
    expect(seen).toEqual([]);
    // Pushed, but the reply failed for now: still unsettled, so the next revision keeps waiting.
    expect(getRevision(p.db, s.runId)).toMatchObject({ state: 'failed', retryable: true, headSha: s.localSha });
    expect(claimNextJob(p.db, config, claimOpts)).toBeNull();

    await createRevisionPublisher(deps(s, api, { now: () => T0 + 3600_000 }), inner).retryDue();
    expect(seen).toEqual(['retryDue']);
    expect(getRevision(p.db, s.runId)).toMatchObject({ state: 'published' });
    expect(api.comments).toHaveLength(1);
    const claimed = claimNextJob(p.db, config, claimOpts);
    expect(claimed?.job.id).toBe(second.status === 'queued' ? second.job.id : '');

    await publisher.afterRun(p.originalRunId);
    expect(seen).toEqual(['retryDue', p.originalRunId]);
  });

  it('comments once per PR that it reached maxRevisions', async () => {
    const p = await published();
    for (const id of ['PRR_over_1', 'PRR_over_2']) {
      recordReviewRequest(p.db, { repoId: REPO_ID, reviewId: id, prNumber: PR, reviewer: 'allen', trigger: 'changes_requested', reviewUrl: REVIEW_URL, submittedAt: null, state: 'over-limit', reason: 'limit' });
    }
    const api = new FakeCommentsApi();
    const d = deps(p, api, { config: makeConfig(p.f, { maxRevisions: 2 }) });
    api.failNext.createIssueComment = new GitHubError('POST ... failed: 502', 502);
    await postLimitNotices(d);
    expect(api.comments).toHaveLength(0);
    expect(getRevisionPr(p.db, REPO_ID, PR)).toMatchObject({ limitCommentId: null, limitCommentAttempts: 1 });
    await postLimitNotices(d);
    await postLimitNotices(d);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.issue).toBe(PR);
    expect(api.comments[0]!.body).toContain('limit of 2 automatic revision(s)');
    expect(api.comments[0]!.body).toContain(REVISION_LIMIT_MARKER);
    expect(getRevisionPr(p.db, REPO_ID, PR)!.limitCommentId).toBe(api.comments[0]!.id);
  });
});

describe('updraft publish RUN_ID on a revision run', { timeout: 120_000 }, () => {
  it('pushes it to its PR by the same path as the worker, and never opens a PR for it', async () => {
    const api = new FakeCommentsApi();
    const home = mkdtempSync(join(tmpdir(), 'updraft revise cli '));
    try {
      const ctx = { ...fakeContext({ api: api.api, home }), openDb: (file: string) => openDatabase(file) };
      mkdirSync(ctx.paths.configDir, { recursive: true });
      const db = openDatabase(ctx.paths.dbFile);
      const s = await revised(await published({ db, paths: ctx.paths }));
      writeFileSync(ctx.paths.configFile, stringify(makeConfig(s.f)));
      db.close();

      expect(await publishCommand(ctx, s.runId, { fileExists: () => true, token: async () => TOKEN })).toBe(0);
      expect(ctx.out.text).toContain(`Pushed ${s.runId} to pull request #${PR}: branch ${s.prBranch} at ${s.localSha.slice(0, 12)}`);
      expect(remoteSha(s)).toBe(s.localSha);
      expect(api.comments).toHaveLength(1);

      expect(await publishCommand(ctx, s.runId, { fileExists: () => true, token: async () => TOKEN })).toBe(0);
      expect(ctx.out.text).toContain(`Already pushed ${s.runId}`);
      expect(api.comments).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
