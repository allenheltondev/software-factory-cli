// `updraft run-event` on a state database that is passed between machines, and with everything
// the worker does for one event: the review loop inside one run, review events, cooldowns.
// As in run-event.test.ts: a webhook payload file, an in-memory GitHub, a real local git remote
// and the fake agents. Each "machine" is its own directory; `download` and `upload` do what the
// caller around it does (copy the shared database in; `updraft state merge` what the run changed).
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { fakeAdapter } from '../../test/fake-adapter.js';
import { FakeLoopGitHub } from '../../test/fake-loop-github.js';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { registerAdapter } from '../agents/adapters/registry.js';
import { setCooldown } from '../db/capacity.js';
import { openDatabase, type Db } from '../db/database.js';
import { mergeState } from '../db/merge.js';
import { getLoopPr } from '../db/pr-reviews.js';
import { countRevisions } from '../db/revisions.js';
import { claimNextJob, getJob } from '../db/queue.js';
import type { GitHubIssue, GitHubPullRequest } from '../github/api.js';
import { createUserCredentials } from '../github/credentials.js';
import { eventJobId } from '../poller/webhook.js';
import { createLogger } from '../util/log.js';
import { acquireWorkerLock } from '../worker/lock.js';
import { fakeContext, type MemoryOutput } from './fakes.js';
import { runEventCommand, type RunEventDeps, type RunEventOptions, type RunEventSummary } from './run-event.js';

const REPO_ID = 42;
const runnerModule = '../../deploy/aws-microvm/image/runner/job.mjs';

async function expectStandaloneFinish(summary: RunEventSummary, kind: 'review' | 'revision') {
  const { finishDetail } = await import(runnerModule);
  expect(summary).toMatchObject({ kind, routing: { source: 'pool' } });
  expect(summary.runId).toBeTruthy();
  const report = finishDetail({
    summary,
    telemetry: { runs: [{ runId: summary.runId, model: 'response-model', modelSource: 'response', usage: { inputTokens: 42 } }] },
  });
  expect(report).toMatchObject({
    routing: { source: 'pool', pool: expect.any(String) },
    steps: [{ kind, runId: summary.runId, model: 'response-model', usage: { inputTokens: 42 } }],
  });
}
const FULL = 'octo/widgets';
const ISSUE = 7;
const PR = 100;
const LABEL = 'updraft:ready';
const EVENT_ID = 9001;
const LABELED_AT = '2026-11-18T11:00:00Z';
const JOB_ID = eventJobId(REPO_ID, 'wf', String(EVENT_ID));
const BRANCH = `updraft/issue-${ISSUE}-${JOB_ID}`;

const fixtures: GitFixture[] = [];
const restores: Array<() => void> = [];
beforeEach(() => {
  restores.push(registerAdapter(fakeAdapter({ name: 'claude' })));
  restores.push(registerAdapter(fakeAdapter({ name: 'codex' })));
});
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r();
  for (const f of fixtures.splice(0)) f.cleanup();
});

class FakeGitHub extends FakeLoopGitHub {
  pulls: GitHubPullRequest[] = [];
  override async getIssue(): Promise<GitHubIssue> {
    this.calls.push('getIssue');
    return { ...(await super.getIssue()), labels: [LABEL] };
  }
  override async listEventsForIssue() {
    this.calls.push('listEventsForIssue');
    return this.issueEvents;
  }
  override async listPullRequestsForHead(_repo?: unknown, opts?: { head: string }): Promise<GitHubPullRequest[]> {
    this.calls.push(`listPullRequestsForHead ${opts?.head}`);
    return this.pulls.filter((p) => p.headRef === opts?.head);
  }
  override async createPullRequest(...args: Parameters<FakeLoopGitHub['createPullRequest']>): Promise<GitHubPullRequest> {
    const pr = await super.createPullRequest(...args);
    this.pulls.push(pr);
    return pr;
  }
}

const labeled = () => ({
  action: 'labeled',
  issue: { number: ISSUE, title: 'Add a widget', updated_at: LABELED_AT, state: 'open' },
  label: { name: LABEL },
  repository: { id: REPO_ID, full_name: FULL },
  sender: { login: 'allen' },
});
const pullRequestEvent = (action: string, number = PR) => ({
  action,
  pull_request: { number, state: 'open' },
  review: { state: 'changes_requested', user: { login: 'allen' } },
  repository: { id: REPO_ID, full_name: FULL },
  sender: { login: 'allen' },
});

interface World {
  f: GitFixture;
  gh: FakeGitHub;
  /** Written by the code-writing fake agent each time it starts. */
  received: string;
  /** The shared state database, as the object store holds it. */
  shared: string;
}

function world(): World {
  const f = createGitFixture(FULL);
  fixtures.push(f);
  const gh = new FakeGitHub(FULL, ISSUE, PR);
  gh.issueEvents = [{ id: EVENT_ID, event: 'labeled', createdAt: LABELED_AT, actor: 'allen', label: LABEL, issue: null }];
  gh.headSha = () => remoteHead(f, BRANCH);
  return { f, gh, received: join(f.root, 'agent received.md'), shared: join(f.root, 'shared state.db') };
}

const remoteHead = (f: GitFixture, branch: string) => f.git(f.root, 'ls-remote', f.remoteDir, `refs/heads/${branch}`).split(/\s+/)[0] ?? '';

interface VmOptions {
  payload?: unknown;
  /** The fake agent's mode (test/fake-agent.mjs). Default "success". */
  agentMode?: string;
  /** Which loops are on for the repository. */
  repo?: Record<string, unknown>;
  reviewerArgs?: string[];
  capacity?: boolean;
  now?: () => number;
  /** Replaces parts of the command's dependencies (a daemon that dies, for one). */
  deps?: Partial<RunEventDeps>;
  /** The first line of this machine's revise prompt: the fake agent writes it into the file it commits, so two machines make different commits. */
  revise?: string;
}

/** One machine: its own state directory, config and event file. */
function vm(w: World, name: string, o: VmOptions = {}) {
  const home = join(w.f.root, name);
  mkdirSync(join(home, 'prompts'), { recursive: true });
  for (const p of ['implement', 'revise', 'review']) writeFileSync(join(home, 'prompts', `${p}.md`), `${p === 'revise' && o.revise ? o.revise : `${p} the thing below.`}\n`);
  const emptyGitConfig = join(home, 'agent gitconfig');
  writeFileSync(emptyGitConfig, '');
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_AUTHOR_NAME: 'Fake Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Fake Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
  };
  const config = {
    version: 1,
    execution: { mode: 'live' },
    ...(o.capacity ? { capacity: { defaultCooldownMinutes: 60 } } : {}),
    agents: {
      claude: { command: process.execPath, args: ['--mode', o.agentMode ?? 'success', '--received', w.received], env },
      codex: { command: process.execPath, args: o.reviewerArgs ?? ['--mode', 'review'], env },
    },
    pools: { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement.md', revisePrompt: './prompts/revise.md', reviewPrompt: './prompts/review.md', timeoutMinutes: 2 } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: './checkouts/widgets',
        remote: 'origin',
        baseBranch: 'main',
        publish: 'draft-pr',
        ...o.repo,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: LABEL }, action: 'implement-issue', pool: 'general', reviewPool: 'reviewers' }],
      },
    },
  };
  writeFileSync(join(home, 'config.yaml'), stringify(config));
  const eventFile = join(home, 'event.json');
  writeFileSync(eventFile, JSON.stringify(o.payload ?? labeled()));
  const ctx = fakeContext({ home, api: w.gh.api, env: { ...process.env, GH_TOKEN: 'ghp_test' } });
  ctx.openDb = (file) => openDatabase(file);
  ctx.createCredentials = () => createUserCredentials(async () => 'ghp_test');
  if (o.now) ctx.now = o.now;
  const deps: RunEventDeps = {
    createLogger,
    onShutdownSignal: () => () => {},
    cloneUrl: () => w.f.remoteDir,
    eventLookup: { retries: 1, delayMs: 1 },
    drain: { tickMs: 20, stallMs: 300, mergePollMs: 20 },
    ...o.deps,
  };
  const state = join(home, 'state.db');
  const base = join(home, 'snapshot.db');
  return {
    home,
    state,
    /** Before the run: the shared database, and a copy of it to merge against afterwards. */
    download() {
      if (!existsSync(w.shared)) return;
      copyFileSync(w.shared, state);
      copyFileSync(w.shared, base);
    },
    /** After the run: what it changed, into whatever the shared database is by now. */
    upload: () => mergeState({ changed: state, into: w.shared, ...(existsSync(base) ? { base } : {}) }),
    async run(opts: Partial<RunEventOptions> = {}) {
      const code = await runEventCommand(ctx, { eventFile, json: true, ...opts }, deps);
      return { code, summary: lastJson(ctx.out), err: ctx.err.text };
    },
  };
}

function lastJson(out: MemoryOutput): RunEventSummary {
  const lines = out.text.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as RunEventSummary;
}

function withDb<T>(file: string, fn: (db: Db) => T): T {
  const db = openDatabase(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const jobsOf = (file: string) =>
  withDb(file, (db) => (db.prepare('SELECT id, status, envelope FROM jobs ORDER BY created_at, rowid').all() as Array<{ id: string; status: string; envelope: string }>).map((j) => [(JSON.parse(j.envelope) as { type: string }).type, j.status]));

const LOOP = { revise: true, review: true, autoMerge: 'squash' };

describe('updraft run-event: the whole review loop in one run', { timeout: 180_000 }, () => {
  it('publishes, has another agent review, revises, reviews again, marks the PR ready and merges the reviewed commit', async () => {
    const w = world();
    const v = vm(w, 'vm one', { repo: LOOP });
    const r = await v.run({ deliveryId: 'd-1' });

    expect(r.err).not.toContain('ERROR');
    expect(r.code).toBe(0);
    const head2 = remoteHead(w.f, BRANCH);
    w.f.git(w.f.clone, 'fetch', '--quiet', 'origin', BRANCH);
    const head1 = w.f.git(w.f.clone, 'rev-parse', `${head2}~1`);
    // The existing fields describe the event's own job; `loop` says where the pull request ended up.
    expect(r.summary).toMatchObject({
      dispatched: true,
      resumed: false,
      outcome: 'succeeded',
      reason: null,
      jobId: JOB_ID,
      status: 'succeeded',
      agent: 'claude',
      publication: 'published',
      prNumber: PR,
      drain: 'idle',
      deferredUntil: null,
      exitCode: 0,
      loop: {
        pullRequest: PR,
        url: `https://github.com/${FULL}/pull/${PR}`,
        rounds: 1,
        maxRevisions: 3,
        reviews: 2,
        verdict: 'ready-to-merge',
        verdictSha: head2,
        headSha: head2,
        stage: 'merged',
        ready: true,
        merged: true,
        mergeCommitSha: 'f'.repeat(40),
        notMergedReason: null,
      },
    });
    expect(r.summary.message).toContain(`pull request #${PR} is merged after 1 revision round(s)`);

    // Four jobs in one drain, the reviews by the other agent.
    expect(jobsOf(v.state)).toEqual([
      ['issue.labeled', 'succeeded'],
      ['pull_request.review', 'succeeded'],
      ['pull_request.changes_requested', 'succeeded'],
      ['pull_request.review', 'succeeded'],
    ]);
    expect(withDb(v.state, (db) => db.prepare('SELECT agent FROM runs ORDER BY started_at, rowid').all())).toEqual([{ agent: 'claude' }, { agent: 'codex' }, { agent: 'claude' }, { agent: 'codex' }]);
    // What GitHub saw: the merge names the commit the second review was of.
    expect(w.gh.writes).toEqual([
      `comment #${ISSUE}`,
      `open draft PR ${BRANCH} -> main`,
      `comment #${ISSUE}`,
      `review #${PR} COMMENT at ${head1}`,
      // The revision announces its push on the pull request, and the same comment becomes its reply.
      `comment #${PR}`,
      `edit comment #${PR}`,
      `review #${PR} COMMENT at ${head2}`,
      `ready PR_node_${PR}`,
      `merge #${PR} squash at ${head2}`,
    ]);
    expect(w.gh.merges).toEqual([{ sha: head2, method: 'squash' }]);
    // Nothing is left that would make the shared copy say work is in progress.
    expect(v.upload()).toMatchObject({ changed: true, unfinished: { runsInterrupted: 0, runsReleased: 0, jobsInterrupted: 0, stepsClosed: 0 } });

    // The event delivered again, to a machine that starts from the shared state: nothing to do, from the database alone.
    const calls = w.gh.calls.length;
    const again = vm(w, 'vm two', { repo: LOOP });
    again.download();
    const d = await again.run();
    expect(d.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery', dispatched: false, exitCode: 0, loop: { stage: 'merged', merged: true } });
    expect(w.gh.writes).toHaveLength(9);
    // Only the event lookup itself asked GitHub anything.
    expect(w.gh.calls.slice(calls).filter((c) => c.startsWith('listPullRequestsForHead'))).toEqual([]);
    expect(again.upload()).toMatchObject({ changed: false });
  });

  it('with ciFix: ends while CI is pending, then fixes a failure a check suite reports, reviews the fix and merges it once its checks pass', async () => {
    const w = world();
    const failing = new Set<string>();
    let first = '';
    // The first head's checks are pending, then fail; every later head's pass.
    w.gh.getCommitChecks = async (_repo, sha) => {
      w.gh.calls.push(`getCommitChecks ${sha}`);
      first ||= sha;
      if (sha === first) return failing.has(sha) ? { total: 1, failing: ['ci / test'], pending: [], succeeded: [], complete: true } : { total: 1, failing: [], pending: ['ci / test'], succeeded: [], complete: true };
      return { total: 1, failing: [], pending: [], succeeded: ['ci / test'], complete: true };
    };
    const repo = { ...LOOP, ciFix: true };
    const reviewerArgs = ['--mode', 'review', '--verdict', 'ready-to-merge'];
    const one = vm(w, 'vm one', { repo, reviewerArgs });
    const r = await one.run({ deliveryId: 'd-1' });
    expect(r.code).toBe(0);
    // A clean review while CI is pending: the run ends instead of waiting, and nothing is ready or merged.
    expect(r.summary).toMatchObject({ outcome: 'succeeded', drain: 'idle', loop: { reviews: 1, verdict: 'ready-to-merge', stage: 'waiting-for-ci', ready: false, merged: false } });
    expect(w.gh.writes.filter((x) => x.startsWith('ready') || x.startsWith('merge'))).toEqual([]);
    expect(one.upload()).toMatchObject({ changed: true });

    // CI fails on that head; the check suite's delivery reaches another machine.
    failing.add(first);
    const suite = {
      action: 'completed',
      repository: { id: REPO_ID, full_name: FULL },
      sender: { login: 'updraft-bot' },
      check_suite: { head_branch: BRANCH, head_sha: first, pull_requests: [{ number: PR, head: { ref: BRANCH } }] },
    };
    const two = vm(w, 'vm two', { repo, reviewerArgs, payload: suite });
    two.download();
    const fixed = await two.run({ eventName: 'check_suite', deliveryId: 'd-2' });
    expect(fixed.err).not.toContain('ERROR');
    expect(fixed.code).toBe(0);
    const head2 = remoteHead(w.f, BRANCH);
    expect(head2).not.toBe(first);
    expect(fixed.summary).toMatchObject({ dispatched: true, loop: { rounds: 1, reviews: 2, verdictSha: head2, stage: 'merged', ready: true, merged: true } });
    expect(jobsOf(two.state)).toEqual([
      ['issue.labeled', 'succeeded'],
      ['pull_request.review', 'succeeded'],
      ['pull_request.changes_requested', 'succeeded'],
      ['pull_request.review', 'succeeded'],
    ]);
    const revision = withDb(two.state, (db) => db.prepare("SELECT trigger_kind, state FROM review_requests").all());
    expect(revision).toEqual([{ trigger_kind: 'ci_failure', state: 'queued' }]);
    // The merge names the commit whose review and checks were both green.
    expect(w.gh.merges).toEqual([{ sha: head2, method: 'squash' }]);
    // One comment said a fix was queued for the failing head.
    expect(w.gh.comments.filter((c) => c.body.includes(`<!-- updraft-ci: ${first} -->`))).toHaveLength(1);
  });

  it('keeps waiting for checks before merging, and reports why a pull request was not merged', async () => {
    const w = world();
    // Pending at first; green once the drain has asked a few times.
    let asked = 0;
    w.gh.getCommitChecks = async (_repo, sha) => {
      w.gh.calls.push(`getCommitChecks ${sha}`);
      return ++asked < 3 ? { total: 1, failing: [], pending: ['ci / build'], succeeded: [], complete: true } : { total: 1, failing: [], pending: [], succeeded: ['ci / build'], complete: true };
    };
    const r = await vm(w, 'vm one', { repo: LOOP, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge'] }).run();
    expect(r.code).toBe(0);
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(r.summary).toMatchObject({ outcome: 'succeeded', drain: 'idle', loop: { rounds: 0, reviews: 1, stage: 'merged', merged: true } });

    // With a failing check the merge is blocked for good: the run ends, and says so.
    const w2 = world();
    w2.gh.checks = { total: 1, failing: ['ci / build'], pending: [], succeeded: [], complete: true };
    const blocked = await vm(w2, 'vm one', { repo: LOOP, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge'] }).run();
    expect(blocked.code).toBe(0);
    expect(blocked.summary).toMatchObject({ outcome: 'succeeded', drain: 'idle', loop: { stage: 'ready-to-merge', ready: true, merged: false } });
    expect(blocked.summary.loop?.notMergedReason).toContain('1 check(s)');
    expect(w2.gh.merges).toEqual([]);
    // The one comment that says so was posted before the run ended.
    expect(w2.gh.writes.filter((x) => x === `comment #${PR}`)).toHaveLength(1);
  });
});

describe('updraft run-event: a state database that is not empty', { timeout: 120_000 }, () => {
  it("runs its own event beside another machine's unfinished job, a stale lock and unrelated queued work, and touches none of them", async () => {
    const w = world();
    // The shared database as some earlier upload left it.
    const foreign = withDb(w.shared, (db) => {
      const running = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: ISSUE });
      db.prepare("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?").run(running);
      db.prepare(
        `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, hostname, pid, pid_start_time, lease_expires_at, started_at, execution_started_at)
         VALUES ('run_other', ?, 1, 'general', 'claude', 'wrk_other', 'another-vm', ?, 'linux:x:1', '2026-11-18T10:00:00.000Z', '2026-11-18T09:59:00.000Z', '2026-11-18T09:59:01.000Z')`,
      ).run(running, process.pid);
      const queued = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: 8 });
      acquireWorkerLock(db, { workerId: 'wrk_other', pid: 1, hostname: 'another-vm' }, { now: () => Date.now() - 3_600_000, isPidAlive: () => true });
      return { running, queued };
    });

    const v = vm(w, 'vm one');
    v.download();
    const r = await v.run();
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ dispatched: true, outcome: 'succeeded', jobId: JOB_ID, publication: 'published', drain: 'idle' });
    // The agent ran once, for this event's job, although the other machine's run holds the only slot of the agent.
    withDb(v.state, (db) => {
      expect(db.prepare("SELECT id, ended_at, outcome FROM runs WHERE id = 'run_other'").get()).toEqual({ id: 'run_other', ended_at: null, outcome: null });
      expect(getJob(db, foreign.running)).toMatchObject({ status: 'running', attempts: 1 });
      expect(getJob(db, foreign.queued)).toMatchObject({ status: 'queued', attempts: 0, statusReason: null });
      expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT count(*) AS n FROM worker_lock').get()).toEqual({ n: 0 });
      // Nothing was recorded against the other machine's work.
      expect(db.prepare('SELECT count(*) AS n FROM errors WHERE job_id IN (?, ?)').get(foreign.running, foreign.queued)).toEqual({ n: 0 });
    });

    // Merged back: this event's job and run are added; the other machine's rows are as they were.
    const merged = v.upload();
    expect(merged.tables.jobs).toMatchObject({ inserted: 1, updated: 0, conflicts: 0 });
    expect(merged.tables.runs).toMatchObject({ inserted: 1, updated: 0 });
    withDb(w.shared, (db) => {
      expect(getJob(db, foreign.running)).toMatchObject({ status: 'running' });
      expect(getJob(db, foreign.queued)).toMatchObject({ status: 'queued' });
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded' });
    });

    // The same event on a machine that has the merged state: a duplicate, settled before the clone exists.
    const again = vm(w, 'vm two');
    again.download();
    rmSync(w.received);
    const d = await again.run();
    expect(d.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery', dispatched: false, exitCode: 0 });
    expect(d.summary.message).toContain(`${JOB_ID}: succeeded`);
    expect(existsSync(w.received)).toBe(false);
    expect(existsSync(join(again.home, 'checkouts', 'widgets'))).toBe(false);
  });

  it('--retry runs a failed job of the event again, which a plain redelivery does not', async () => {
    const w = world();
    const failing = vm(w, 'vm failing', { agentMode: 'fail' });
    failing.download();
    const first = await failing.run();
    expect(first.code).toBe(1);
    expect(first.summary).toMatchObject({ outcome: 'failed', jobId: JOB_ID });
    failing.upload();
    withDb(w.shared, (db) => expect(getJob(db, JOB_ID)).toMatchObject({ status: 'failed' }));

    // A delivery as it is: the failed job is on record, so nothing runs ("updraft retry" is the way).
    rmSync(w.received, { force: true });
    const plain = vm(w, 'vm plain');
    plain.download();
    expect((await plain.run({ deliveryId: 'd-redelivered' })).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery' });
    expect(existsSync(w.received)).toBe(false);

    // With --retry the job is requeued first, as `updraft retry` would, and this run does it.
    const retried = vm(w, 'vm retried');
    retried.download();
    const r = await retried.run({ deliveryId: 'd-retry', retry: true });
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ outcome: 'succeeded', jobId: JOB_ID, publication: 'published' });
    expect(existsSync(w.received)).toBe(true);
    withDb(retried.state, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded' });
      expect(db.prepare('SELECT retries FROM jobs WHERE id = ?').get(JOB_ID)).toEqual({ retries: 1 });
    });
    // Merged back, the retried result is the shared one.
    retried.upload();
    withDb(w.shared, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded' });
      expect(db.prepare('SELECT retries FROM jobs WHERE id = ?').get(JOB_ID)).toEqual({ retries: 1 });
    });
  });

  it('--retry leaves a job that succeeded, and an event with no job on record, as they are', async () => {
    const w = world();
    const v = vm(w, 'vm one');
    v.download();
    expect((await v.run()).summary).toMatchObject({ outcome: 'succeeded' });
    v.upload();
    const again = vm(w, 'vm two');
    again.download();
    expect((await again.run({ retry: true })).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery' });
    withDb(again.state, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded' });
      expect(db.prepare('SELECT retries FROM jobs WHERE id = ?').get(JOB_ID)).toEqual({ retries: 0 });
    });
  });

  it('ends "deferred" with exit code 4 when a cooldown outlasts the run, and a later delivery continues the queued job', async () => {
    const w = world();
    const t0 = Date.now();
    withDb(w.shared, (db) => setCooldown(db, { scope: 'agent', name: 'claude', untilMs: t0 + 3_600_000, reason: 'usage limit: try again later', stated: true, nowMs: t0 }));

    const v = vm(w, 'vm one', { capacity: true });
    v.download();
    const r = await v.run({ deadlineMinutes: '1' });
    expect(r.code).toBe(4);
    expect(r.summary).toMatchObject({
      dispatched: true,
      outcome: 'deferred',
      reason: 'cooldown',
      status: 'queued',
      runId: null,
      drain: 'deferred',
      deferredUntil: new Date(t0 + 3_600_000).toISOString(),
      exitCode: 4,
    });
    expect(r.summary.message).toContain('delivering the event again after that continues it');
    expect(existsSync(w.received)).toBe(false);
    // Only the assignment comment would have been a write; no agent was assigned.
    expect(w.gh.writes).toEqual([]);
    expect(v.upload().tables.jobs).toMatchObject({ inserted: 1 });
    expect(withDb(w.shared, (db) => getJob(db, JOB_ID))).toMatchObject({ status: 'queued' });

    // Delivered again while the cooldown lasts: still deferred, and no second job.
    const early = vm(w, 'vm two', { capacity: true });
    early.download();
    expect(await early.run({ deadlineMinutes: '1' })).toMatchObject({ code: 4, summary: { outcome: 'deferred', dispatched: false, resumed: true, jobId: JOB_ID } });

    // Delivered again after it ended: the queued job runs.
    withDb(w.shared, (db) => db.prepare('UPDATE capacity_cooldowns SET until = ?').run(new Date(t0 - 1000).toISOString()));
    const late = vm(w, 'vm three', { capacity: true });
    late.download();
    const done = await late.run();
    expect(done.code).toBe(0);
    expect(done.summary).toMatchObject({ dispatched: false, resumed: true, outcome: 'succeeded', jobId: JOB_ID, publication: 'published', prNumber: PR });
    expect(late.upload().tables.jobs).toMatchObject({ inserted: 0, updated: 1 });
    expect(jobsOf(w.shared)).toEqual([['issue.labeled', 'succeeded']]);
  });

  it('waits for a cooldown that ends before the deadline, then runs the job', async () => {
    const w = world();
    const until = Date.now() + 1_500;
    withDb(w.shared, (db) => setCooldown(db, { scope: 'agent', name: 'claude', untilMs: until, reason: 'usage limit', stated: true, nowMs: Date.now() }));
    const v = vm(w, 'vm one', { capacity: true });
    v.download();
    const r = await v.run({ deadlineMinutes: '2' });
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ outcome: 'succeeded', drain: 'idle', publication: 'published' });
    expect(Date.now()).toBeGreaterThanOrEqual(until);
  });

  it('refuses a state database written by a newer updraft with exit code 5, before anything starts', async () => {
    const w = world();
    const v = vm(w, 'vm one');
    withDb(v.state, (db) => db.exec('PRAGMA user_version = 999'));
    const r = await v.run();
    expect(r.code).toBe(5);
    expect(r.summary).toMatchObject({ outcome: 'error', exitCode: 5 });
    expect(r.summary.message).toContain('newer than this CLI supports');
    expect(existsSync(w.received)).toBe(false);
  });
});

describe('updraft run-event: pull request events', { timeout: 180_000 }, () => {
  /** A pull request Updraft opened, on record in the shared state. */
  async function published(repo: Record<string, unknown>, reviewerArgs?: string[]) {
    const w = world();
    const first = vm(w, 'vm publish', { repo, ...(reviewerArgs ? { reviewerArgs } : {}) });
    const r = await first.run();
    expect(r.code).toBe(0);
    first.upload();
    rmSync(w.received, { force: true });
    return w;
  }
  const event = (w: World, name: string, action: string, o: VmOptions = {}) => {
    const v = vm(w, name, { payload: pullRequestEvent(action), ...o });
    v.download();
    return v;
  };

  it("pull_request_review.submitted: an allowed actor's change request is revised and pushed; the same delivery again does nothing", async () => {
    const w = await published({ revise: true });
    const head1 = remoteHead(w.f, BRANCH);
    w.gh.humanReview('allen', 'CHANGES_REQUESTED', 'Please add a second line.');

    const v = event(w, 'vm review', 'submitted', { repo: { revise: true } });
    const r = await v.run({ eventName: 'pull_request_review', deliveryId: 'd-review' });
    expect(r.code).toBe(0);
    await expectStandaloneFinish(r.summary, 'revision');
    expect(r.summary).toMatchObject({
      event: { name: 'pull_request_review', action: 'submitted', pullRequest: PR, issue: null, repositoryId: REPO_ID },
      dispatched: true,
      outcome: 'succeeded',
      status: 'succeeded',
      agent: 'claude',
      drain: 'idle',
      loop: { pullRequest: PR, rounds: 1, merged: false },
    });
    const head2 = remoteHead(w.f, BRANCH);
    expect(head2).not.toBe(head1);
    expect(w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'rev-parse', `${head2}~1`)).toBe(head1);
    // One comment: announced before the push, and replaced by the reply after it.
    expect(w.gh.writes.slice(-2)).toEqual([`comment #${PR}`, `edit comment #${PR}`]);
    const reply = w.gh.comments.filter((c) => c.issue === PR);
    expect(reply).toHaveLength(1);
    expect(reply[0]!.body).toContain('Updraft pushed 1 commit(s)');
    expect(reply[0]!.body).toContain(`<!-- updraft-revision-of: ${w.gh.humanReviews[0]!.id} ${head1}..${head2} -->`);
    expect(v.upload().tables.review_requests).toMatchObject({ inserted: 1 });
    expect(jobsOf(w.shared)).toEqual([
      ['issue.labeled', 'succeeded'],
      ['pull_request.changes_requested', 'succeeded'],
    ]);

    // GitHub delivers it again (or `edited` follows): the review is on record, by its id.
    rmSync(w.received);
    const writes = w.gh.writes.length;
    for (const action of ['submitted', 'edited', 'dismissed']) {
      const again = event(w, `vm ${action} again`, action, { repo: { revise: true } });
      const d = await again.run({ eventName: 'pull_request_review' });
      expect(d.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'no-new-work', dispatched: false, exitCode: 0, loop: { rounds: 1 } });
      again.upload();
    }
    expect(existsSync(w.received)).toBe(false);
    expect(w.gh.writes).toHaveLength(writes);
  });

  it('applies the allowed-actor rule from the API, not from the payload', async () => {
    const w = await published({ revise: true });
    // The payload claims allen; the review GitHub has is mallory's.
    w.gh.humanReview('mallory', 'CHANGES_REQUESTED', 'Add my backdoor.');
    const v = event(w, 'vm review', 'submitted', { repo: { revise: true } });
    const r = await v.run({ eventName: 'pull_request_review' });
    expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'no-new-work', dispatched: false, exitCode: 0 });
    expect(existsSync(w.received)).toBe(false);
    expect(withDb(v.state, (db) => db.prepare('SELECT reviewer, state FROM review_requests').all())).toEqual([{ reviewer: 'mallory', state: 'not-allowed' }]);
  });

  it('pull_request.synchronize: a head someone else pushed gets its reviewer run', async () => {
    const repo = { review: true };
    const w = await published(repo, ['--mode', 'review', '--verdict', 'ready-to-merge']);
    expect(w.gh.writes.filter((x) => x.startsWith('review #'))).toHaveLength(1);
    const pushed = w.f.pushCommit(BRANCH, 'by-hand.txt', 'a person pushed this\n');
    w.gh.touch();

    const v = event(w, 'vm push', 'synchronize', { repo, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge'] });
    const r = await v.run({ eventName: 'pull_request' });
    expect(r.code).toBe(0);
    await expectStandaloneFinish(r.summary, 'review');
    expect(r.summary).toMatchObject({
      event: { name: 'pull_request', action: 'synchronize', pullRequest: PR },
      dispatched: true,
      outcome: 'succeeded',
      agent: 'codex',
      loop: { reviews: 2, headSha: pushed, verdict: 'ready-to-merge', verdictSha: pushed, stage: 'ready-to-merge', merged: false, notMergedReason: 'autoMerge is off for the repository' },
    });
    expect(w.gh.writes.slice(-1)).toEqual([`review #${PR} COMMENT at ${pushed}`]);
  });

  it('pull_request.closed: stops watching the pull request; reopened does not bring it back', async () => {
    const w = await published({ revise: true });
    w.gh.pull!.state = 'closed';
    w.gh.touch();
    const v = event(w, 'vm closed', 'closed', { repo: { revise: true } });
    const r = await v.run({ eventName: 'pull_request' });
    expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'pull-request-closed', exitCode: 0 });
    expect(withDb(v.state, (db) => getLoopPr(db, REPO_ID, PR)?.state)).toBe('closed');
    // The run that opened it put it on record (its last look); this run closed it.
    expect(v.upload().tables.revision_prs).toMatchObject({ inserted: 0, updated: 1 });
    expect(withDb(w.shared, (db) => getLoopPr(db, REPO_ID, PR)?.state)).toBe('closed');

    // Reopened on GitHub: closing was final. Whatever event arrives for it next, the state
    // database decides, and GitHub is not asked. `reopened` itself is not an action run-event handles.
    w.gh.pull!.state = 'open';
    const calls = w.gh.calls.length;
    const re = event(w, 'vm reopened', 'synchronize', { repo: { revise: true } });
    expect((await re.run({ eventName: 'pull_request' })).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'pull-request-closed' });
    const unhandled = event(w, 'vm reopened action', 'reopened', { repo: { revise: true } });
    expect((await unhandled.run({ eventName: 'pull_request' })).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'unsupported-action', exitCode: 0 });
    expect(w.gh.calls.slice(calls)).toEqual([]);
    expect(existsSync(w.received)).toBe(false);
  });

  it('does nothing for a pull request Updraft does not watch: one read of it from the API, no agent', async () => {
    const w = await published({ revise: true });
    const calls = w.gh.calls.length;
    for (const [eventName, action] of [
      ['pull_request_review', 'submitted'],
      ['pull_request_review', 'edited'],
      ['pull_request_review', 'dismissed'],
      ['pull_request', 'synchronize'],
      ['pull_request', 'closed'],
    ] as const) {
      const v = vm(w, `vm ${eventName} ${action}`, { payload: pullRequestEvent(action, 555), repo: { revise: true } });
      v.download();
      const r = await v.run({ eventName });
      expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'pull-request-not-watched', dispatched: false, exitCode: 0, event: { pullRequest: 555 } });
      // Nothing but the record that pull request #100 (the one Updraft did open) is watched.
      expect(v.upload().totals).toMatchObject({ updated: 0, appended: 0, conflicts: 0 });
    }
    // A machine with no state at all knows of no pull request, and creates no state for the question.
    const empty = vm(w, 'vm empty', { payload: pullRequestEvent('submitted', 555), repo: { revise: true } });
    expect((await empty.run({ eventName: 'pull_request_review' })).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'pull-request-not-watched' });
    expect(existsSync(empty.state)).toBe(false);
    // GitHub was asked one thing each time: whether the pull request is one of Updraft's after all.
    expect(w.gh.calls.slice(calls)).toEqual(Array.from({ length: 6 }, () => 'getPullRequest'));

    // One that somebody else opened on a branch that looks like a job branch, or that lost the
    // run's marker, is not Updraft's either; a closed one of Updraft's is not waited for.
    const other = async (name: string, change: () => void) => {
      change();
      const v = vm(w, name, { payload: pullRequestEvent('submitted'), repo: { revise: true } });
      const r = await v.run({ eventName: 'pull_request_review' });
      expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'pull-request-not-watched', exitCode: 0 });
      return r.summary.message;
    };
    const body = w.gh.pullBody;
    expect(await other('vm not the worker', () => (w.gh.pullAuthor = 'mallory'))).toContain('opened by mallory');
    w.gh.pullAuthor = w.gh.login;
    expect(await other('vm no marker', () => (w.gh.pullBody = 'Closes #7'))).toContain('marker');
    w.gh.pullBody = body;
    expect(await other('vm closed', () => (w.gh.pull!.state = 'closed'))).toContain('closed or merged');
    expect(existsSync(w.received)).toBe(false);
  });
});

describe('updraft run-event: review findings', { timeout: 180_000 }, () => {
  it('finding 1: a reviewer job the drain created and that failed makes the run fail', async () => {
    const w = world();
    const v = vm(w, 'vm one', { repo: LOOP, reviewerArgs: ['--mode', 'fail'] });
    const r = await v.run();
    expect(jobsOf(v.state)).toEqual([
      ['issue.labeled', 'succeeded'],
      ['pull_request.review', 'failed'],
    ]);
    expect(r.summary.loop).toMatchObject({ stage: 'needs-human' });
    // The event's own job is still described as it went; the outcome is the worst of everything in scope.
    expect(r.summary).toMatchObject({ status: 'succeeded', publication: 'published', prNumber: PR, outcome: 'failed', exitCode: 1 });
    expect(r.code).toBe(1);
    expect(r.summary.followOnJobs).toHaveLength(1);
    expect(r.summary.followOnJobs![0]).toMatchObject({ status: 'failed', agent: 'codex', kind: 'review', outcome: 'failed' });
    expect(r.summary.message).toContain('failed');
  });

  it('finding 2: a pull request event for an Updraft pull request that the state database does not know yet is not swallowed', async () => {
    const w = world();
    // The issue machine has opened the pull request and has not uploaded anything yet.
    const first = vm(w, 'vm publish', { repo: { revise: true } });
    expect((await first.run()).code).toBe(0);
    w.gh.humanReview('allen', 'CHANGES_REQUESTED', 'Please add a second line.');

    const second = vm(w, 'vm review', { payload: pullRequestEvent('submitted'), repo: { revise: true } });
    second.download();
    const r = await second.run({ eventName: 'pull_request_review' });
    expect(r.summary).toMatchObject({ outcome: 'state-pending', reason: 'state-pending', dispatched: false, exitCode: 6 });
    expect(r.code).toBe(6);
    expect(r.summary.message).toContain('again');
    // Nothing was created for the question, and nothing was written anywhere.
    expect(existsSync(second.state)).toBe(false);
    const writes = w.gh.writes.length;

    // The caller tries again once the shared database has changed: the same event, a new snapshot.
    first.upload();
    rmSync(w.received);
    const retry = vm(w, 'vm review retry', { payload: pullRequestEvent('submitted'), repo: { revise: true } });
    retry.download();
    const done = await retry.run({ eventName: 'pull_request_review' });
    expect(done.summary).toMatchObject({ outcome: 'succeeded', dispatched: true, agent: 'claude', exitCode: 0, loop: { rounds: 1 } });
    expect(w.gh.writes.length).toBeGreaterThan(writes);
  });

  it('finding 2: the run that opened the pull request looks at it once more before it ends, and handles a review submitted meanwhile', async () => {
    const w = world();
    // A person requests changes the moment the pull request exists, long before this run uploads anything.
    const open = w.gh.createPullRequest.bind(w.gh);
    w.gh.createPullRequest = async (...args) => {
      const pr = await open(...args);
      w.gh.humanReview('allen', 'CHANGES_REQUESTED', 'Please add a second line.');
      return pr;
    };
    const v = vm(w, 'vm one', { repo: { revise: true } });
    const head0 = () => remoteHead(w.f, BRANCH);
    const r = await v.run();
    expect(r.code).toBe(0);
    // The event's own job, then the revision the last look queued; a second look found nothing more.
    expect(jobsOf(v.state)).toEqual([
      ['issue.labeled', 'succeeded'],
      ['pull_request.changes_requested', 'succeeded'],
    ]);
    expect(r.summary).toMatchObject({ outcome: 'succeeded', drain: 'idle', finalLook: { looks: 2, queued: 1, error: null }, loop: { rounds: 1 } });
    expect(r.summary.followOnJobs).toMatchObject([{ kind: 'revision', status: 'succeeded', outcome: 'succeeded', publication: 'published' }]);
    expect(w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'rev-list', '--count', `main..${head0()}`)).toBe('2');
    // The review is on record, so its own delivery finds nothing left to do.
    v.upload();
    const late = vm(w, 'vm review', { payload: pullRequestEvent('submitted'), repo: { revise: true } });
    late.download();
    expect((await late.run({ eventName: 'pull_request_review' })).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'no-new-work', exitCode: 0 });

    // A look that fails does not fail the run: the review still has its own delivery.
    const w2 = world();
    const v2 = vm(w2, 'vm one', { repo: { revise: true } });
    w2.gh.getPullRequestReviews = async () => {
      throw new Error('GitHub is down');
    };
    const failed = await v2.run();
    expect(failed.summary).toMatchObject({ outcome: 'succeeded', exitCode: 0, finalLook: { looks: 0, queued: 0, error: 'GitHub is down' } });
  });

  it("finding 2: a checkpoint shows another machine the pull request as watched, and that machine leaves the first run's unfinished work alone", async () => {
    const w = world();
    const v1 = vm(w, 'vm one', { repo: LOOP, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge'] });
    let asked = 0;
    let second: Awaited<ReturnType<ReturnType<typeof vm>['run']>> | undefined;
    let hookError: unknown;
    w.gh.getCommitChecks = async (_repo, sha) => {
      w.gh.calls.push(`getCommitChecks ${sha}`);
      if (++asked === 2) hookError = await inHook().catch((err: unknown) => err);
      return asked < 3 ? { total: 1, failing: [], pending: ['ci / build'], succeeded: [], complete: true } : { total: 1, failing: [], pending: [], succeeded: ['ci / build'], complete: true };
    };
    const inHook = async () => {
      {
        // The first run is waiting for checks before it merges. Its database is checkpointed
        // into the shared one, and a `synchronize` delivery starts a second machine from that.
        const checkpoint = mergeState({ changed: v1.state, into: w.shared, live: true });
        expect(checkpoint.unfinished).toMatchObject({ runsInterrupted: 0, runsReleased: 0, jobsInterrupted: 0, stepsClosed: 0, holdsReleased: 0 });
        expect(withDb(w.shared, (db) => getLoopPr(db, REPO_ID, PR))).toMatchObject({ state: 'open', mergeState: 'waiting' });
        const v2 = vm(w, 'vm two', { payload: pullRequestEvent('synchronize'), repo: LOOP, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge'] });
        v2.download();
        const writes = w.gh.writes.length;
        second = await v2.run({ eventName: 'pull_request' });
        // Nothing of its own to do, and the merge that is waiting is the first run's: it did not wait for it, or make it.
        expect(w.gh.writes).toHaveLength(writes);
        v2.upload();
      }
    };
    const r = await v1.run();
    expect(hookError).toBeUndefined();
    expect(second?.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'no-new-work', exitCode: 0, loop: { pullRequest: PR, merged: false } });
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ outcome: 'succeeded', loop: { stage: 'merged', merged: true } });
    expect(w.gh.merges).toHaveLength(1);

    // The final merge of the first run, on top of its own checkpoint and the second machine's upload.
    expect(v1.upload()).toMatchObject({ changed: true, unfinished: { runsInterrupted: 0, runsReleased: 0, jobsInterrupted: 0, stepsClosed: 0, holdsReleased: 0 } });
    expect(jobsOf(w.shared)).toEqual([
      ['issue.labeled', 'succeeded'],
      ['pull_request.review', 'succeeded'],
    ]);
    withDb(w.shared, (db) => {
      expect(getLoopPr(db, REPO_ID, PR)).toMatchObject({ mergeState: 'merged' });
      expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT count(*) AS n FROM runs WHERE ended_at IS NULL').get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n, count(DISTINCT kind || subject_id) AS d FROM metric_events").get()).toMatchObject(db.prepare('SELECT count(*) AS n, count(*) AS d FROM metric_events').get() as object);
      // The hold the checkpoint carried is released.
      expect((db.prepare("SELECT value FROM meta WHERE key LIKE 'run-event:hold:%'").all() as Array<{ value: string }>).map((m) => (JSON.parse(m.value) as { releasedAt: string | null }).releasedAt !== null)).toEqual([true]);
    });
    expect(v1.upload()).toMatchObject({ changed: false });
  });

  /** The issue machine opened the pull request and its state never reached the shared database. */
  async function lostState(repo: Record<string, unknown>) {
    const w = world();
    const first = vm(w, 'vm lost', { repo });
    const r = await first.run();
    expect(r.code).toBe(0);
    rmSync(w.received, { force: true });
    return { w, first, runId: r.summary.runId! };
  }

  it('finding 3: a redelivery restores a publication whose state was lost, without running the agent, and reviews are acted on again', async () => {
    const { w, first, runId } = await lostState({ revise: true });
    const writes = w.gh.writes.length;
    const again = vm(w, 'vm redelivered', { repo: { revise: true } });
    again.download();
    const r = await again.run({ deliveryId: 'd-again' });
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'already-handled', stateRestored: true, dispatched: false, exitCode: 0, jobId: JOB_ID, runId, status: 'succeeded', publication: 'published', prNumber: PR });
    expect(r.summary.message).toContain('restored from the GitHub API');
    expect(existsSync(w.received)).toBe(false);
    expect(w.gh.writes).toHaveLength(writes);
    // What is on record, and that it says where it came from.
    withDb(again.state, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded' });
      expect(getJob(db, JOB_ID)?.statusReason).toMatch(/^reconstructed: /);
      expect(db.prepare('SELECT id, agent, worker_id, outcome, summary FROM runs').all()).toEqual([{ id: runId, agent: 'claude', worker_id: 'reconstructed', outcome: 'succeeded', summary: null }]);
      expect(db.prepare('SELECT run_id, state, pr_number, branch, base_branch, head_sha FROM publications').all()).toEqual([{ run_id: runId, state: 'published', pr_number: PR, branch: BRANCH, base_branch: 'main', head_sha: null }]);
      expect(db.prepare("SELECT error FROM publications").get()).toMatchObject({ error: expect.stringMatching(/^reconstructed: .*d-again/) });
      expect(db.prepare('SELECT state, source_run_id, author_agent, created_at FROM revision_prs').all()).toEqual([{ state: 'open', source_run_id: runId, author_agent: 'claude', created_at: '1970-01-01T00:00:00.000Z' }]);
    });
    again.upload();

    // Delivered once more: on record now, settled from the database.
    const third = vm(w, 'vm third', { repo: { revise: true } });
    third.download();
    expect((await third.run()).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery', stateRestored: false });

    // A review of the pull request is acted on, from the restored rows.
    w.gh.humanReview('allen', 'CHANGES_REQUESTED', 'Please add a second line.');
    const review = vm(w, 'vm review', { payload: pullRequestEvent('submitted'), repo: { revise: true } });
    review.download();
    const revised = await review.run({ eventName: 'pull_request_review' });
    expect(revised.summary).toMatchObject({ outcome: 'succeeded', dispatched: true, agent: 'claude', exitCode: 0, loop: { rounds: 1 } });
    review.upload();

    // The original run's database turns up after all (recovered from where the runner kept it).
    // Its rows are the recorded ones: they replace the reconstructed ones, and nothing is there twice.
    mergeState({ changed: first.state, into: w.shared });
    withDb(w.shared, (db) => {
      expect(jobsOf(w.shared)).toEqual([
        ['issue.labeled', 'succeeded'],
        ['pull_request.changes_requested', 'succeeded'],
      ]);
      expect(getJob(db, JOB_ID)?.statusReason ?? '').not.toMatch(/^reconstructed/);
      expect(db.prepare('SELECT worker_id != ? AS recorded, summary IS NOT NULL AS summarized FROM runs WHERE id = ?').get('reconstructed', runId)).toEqual({ recorded: 1, summarized: 1 });
      expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT error, head_sha IS NOT NULL AS pushed FROM publications WHERE run_id = ?').get(runId)).toEqual({ error: null, pushed: 1 });
      expect(db.prepare('SELECT count(*) AS n FROM publications').get()).toEqual({ n: 1 });
      // The pull request's row is the one that knows more: the revision round a later run recorded.
      expect(db.prepare('SELECT count(*) AS n FROM revision_prs').get()).toEqual({ n: 1 });
      expect(getLoopPr(db, REPO_ID, PR)).toMatchObject({ state: 'open', sourceRunId: runId });
      expect(getLoopPr(db, REPO_ID, PR)?.seenUpdatedAt).not.toBeNull();
    });
  });

  it('finding 3: a job that a checkpoint carried, and whose end was never saved, is left to its run while that holds it and restored once it does not', async () => {
    const w = world();
    const first = vm(w, 'vm lost', { repo: { revise: true } });
    // A checkpoint while the publication is under way: the run has ended, the pull request is not recorded yet.
    const open = w.gh.createPullRequest.bind(w.gh);
    w.gh.createPullRequest = async (...args) => {
      mergeState({ changed: first.state, into: w.shared, live: true });
      return open(...args);
    };
    const r = await first.run();
    expect(r.code).toBe(0);
    rmSync(w.received, { force: true });
    // The machine is gone after that; its final merge never happened.
    expect(withDb(w.shared, (db) => db.prepare('SELECT state, pr_number FROM publications').all())).toEqual([{ state: 'publishing', pr_number: null }]);

    // Delivered again while the first run's hold is in force: its work, not ours.
    const early = vm(w, 'vm early', { repo: { revise: true } });
    early.download();
    const held = await early.run();
    expect(held.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery', stateRestored: false, exitCode: 0 });
    expect(held.summary.message).toContain('another run that is still going');

    // Delivered again after the hold has expired: GitHub has the pull request, so the publication is completed.
    const late = vm(w, 'vm late', { repo: { revise: true }, now: () => Date.now() + 7 * 3_600_000 });
    late.download();
    const restored = await late.run();
    expect(restored.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'already-handled', stateRestored: true, exitCode: 0, runId: r.summary.runId, prNumber: PR, publication: 'published' });
    withDb(late.state, (db) => {
      // The run is the recorded one; only the publication had to be completed from the API.
      expect(db.prepare('SELECT worker_id != ? AS recorded, summary IS NOT NULL AS summarized FROM runs').all('reconstructed')).toEqual([{ recorded: 1, summarized: 1 }]);
      expect(db.prepare('SELECT state, pr_number FROM publications').all()).toEqual([{ state: 'published', pr_number: PR }]);
      expect(getLoopPr(db, REPO_ID, PR)).toMatchObject({ state: 'open' });
    });
    expect(existsSync(w.received)).toBe(false);
  });

  it('finding 3: reconstructed rows never replace the recorded ones, whichever reaches the shared database first', async () => {
    const { w, first, runId } = await lostState({ revise: true });
    const again = vm(w, 'vm redelivered', { repo: { revise: true } });
    expect((await again.run()).summary).toMatchObject({ reason: 'already-handled', stateRestored: true });
    // The recorded state first, then the machine that reconstructed (it started from nothing, so no base).
    first.upload();
    const recorded = withDb(w.shared, (db) => ({
      job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(JOB_ID),
      run: db.prepare('SELECT * FROM runs WHERE id = ?').get(runId),
      publication: db.prepare('SELECT * FROM publications WHERE run_id = ?').get(runId),
      pr: db.prepare('SELECT * FROM revision_prs').all(),
    }));
    const merged = again.upload();
    expect(merged.tables.runs).toMatchObject({ inserted: 0, updated: 0, conflicts: 1 });
    expect(merged.tables.publications).toMatchObject({ inserted: 0, updated: 0, conflicts: 1 });
    expect(merged.tables.jobs).toMatchObject({ inserted: 0, updated: 0, conflicts: 1 });
    expect(merged.tables.revision_prs).toMatchObject({ inserted: 0, updated: 0, conflicts: 1 });
    withDb(w.shared, (db) => {
      expect(db.prepare('SELECT * FROM jobs WHERE id = ?').get(JOB_ID)).toEqual(recorded.job);
      expect(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)).toEqual(recorded.run);
      expect(db.prepare('SELECT * FROM publications WHERE run_id = ?').get(runId)).toEqual(recorded.publication);
      expect(db.prepare('SELECT * FROM revision_prs').all()).toEqual(recorded.pr);
    });
  });

  it('finding 3: fails loudly when the pull request is there and what a restore needs cannot be established', async () => {
    for (const [name, change, said] of [
      ['no marker', (w: World) => (w.gh.pullBody = 'Closes #7'), 'marker'],
      ['another author', (w: World) => (w.gh.pullAuthor = 'mallory'), 'opened by mallory'],
      ['no agent', (w: World) => (w.gh.pullBody = w.gh.pullBody.replace(/\(agent [^)]*\)/, '')), 'agent'],
    ] as const) {
      const { w } = await lostState({ revise: true });
      change(w);
      const again = vm(w, `vm ${name}`, { repo: { revise: true } });
      const r = await again.run();
      expect(r.code, name).toBe(1);
      expect(r.summary).toMatchObject({ outcome: 'error', reason: 'state-not-restorable', stateRestored: false, exitCode: 1 });
      expect(r.summary.message).toContain(said);
      expect(r.summary.message).toContain('cannot be restored');
      expect(existsSync(w.received)).toBe(false);
      // Nothing was invented.
      if (existsSync(again.state)) expect(withDb(again.state, (db) => db.prepare('SELECT count(*) AS n FROM publications').get())).toEqual({ n: 0 });
    }
    // A pull request that was merged or closed meanwhile needs no rows: as before.
    const { w } = await lostState({ revise: true });
    w.gh.pull!.state = 'closed';
    w.gh.pulls[0]!.state = 'closed';
    expect((await vm(w, 'vm closed', { repo: { revise: true } }).run()).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'already-handled', stateRestored: false, exitCode: 0 });
  });
});

describe('updraft run-event: a run that checkpointed and then vanished', { timeout: 180_000 }, () => {
  const HOURS = 3_600_000;
  /**
   * A machine that claimed the event's job, started its agent, checkpointed and was never heard
   * of again: the shared state has the job `running`, its open run and the machine's hold.
   */
  async function vanished(repo: Record<string, unknown> = {}) {
    const w = world();
    const lost = vm(w, 'vm lost', {
      repo,
      deps: {
        runDaemon: async (d) => {
          const c = claimNextJob(d.db, d.config, { workerId: 'wrk_lost', hostname: 'lost-vm', leaseSeconds: 60, runsDir: join(w.f.root, 'vm lost', 'runs') })!;
          d.db.prepare('UPDATE runs SET execution_started_at = ?, pid = 4242 WHERE id = ?').run(new Date().toISOString(), c.run.id);
          mergeState({ changed: lost.state, into: w.shared, live: true });
          throw new Error('the machine is gone');
        },
      },
    });
    const died = await lost.run({ deadlineMinutes: '30', deliveryId: 'd-lost' });
    expect(died.code).toBe(1);
    const run = withDb(w.shared, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'running', attempts: 1 });
      return db.prepare('SELECT id, ended_at FROM runs').all() as Array<{ id: string; ended_at: string | null }>;
    });
    expect(run).toMatchObject([{ ended_at: null }]);
    return { w, runId: run[0]!.id };
  }
  const runRow = (file: string, runId: string) => withDb(file, (db) => db.prepare('SELECT outcome, ended_at IS NOT NULL AS ended FROM runs WHERE id = ?').get(runId));

  it('while its hold is live: a redelivery settles nothing and starts nothing', async () => {
    const { w, runId } = await vanished();
    const early = vm(w, 'vm early');
    early.download();
    const r = await early.run({ deliveryId: 'd-early' });
    expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery', exitCode: 0, abandonedRun: null, resumed: false });
    expect(r.summary.message).toContain('another run that is still going');
    expect(withDb(early.state, (db) => getJob(db, JOB_ID))).toMatchObject({ status: 'running', attempts: 1 });
    expect(runRow(early.state, runId)).toEqual({ outcome: null, ended: 0 });
    expect(existsSync(w.received)).toBe(false);
    expect(w.gh.writes).toEqual([]);
  });

  it('after its hold expired, with nothing of it on GitHub: the run is closed as interrupted and this delivery does the work, on the next attempt\'s branch', async () => {
    const { w, runId } = await vanished();
    // Another machine's job that is also running in the shared state: not this event's.
    const foreign = withDb(w.shared, (db) => {
      const id = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: 8 });
      db.prepare("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?").run(id);
      db.prepare(
        `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, hostname, pid, lease_expires_at, started_at, execution_started_at)
         VALUES ('run_other', ?, 1, 'general', 'claude', 'wrk_other', 'another-vm', 1, '2026-11-18T10:00:00.000Z', '2026-11-18T09:59:00.000Z', '2026-11-18T09:59:01.000Z')`,
      ).run(id);
      return id;
    });
    const late = vm(w, 'vm late', { now: () => Date.now() + 7 * HOURS });
    late.download();
    const r = await late.run({ deliveryId: 'd-late' });
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({
      outcome: 'succeeded',
      resumed: true,
      dispatched: false,
      jobId: JOB_ID,
      status: 'succeeded',
      publication: 'published',
      prNumber: PR,
      branch: `${BRANCH}-2`,
      abandonedRun: { jobId: JOB_ID, runId, settled: 'interrupted', resumed: true, existingBranch: null },
    });
    expect(r.summary.abandonedRun?.heldUntil).toEqual(expect.any(String));
    expect(r.summary.runId).not.toBe(runId);
    expect(existsSync(w.received)).toBe(true);
    expect(remoteHead(w.f, `${BRANCH}-2`)).not.toBe('');
    expect(remoteHead(w.f, BRANCH)).toBe('');
    withDb(late.state, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded', attempts: 2 });
      // The other machine's run is not this event's: exactly as it was.
      expect(getJob(db, foreign)).toMatchObject({ status: 'running', attempts: 1 });
      expect(db.prepare("SELECT ended_at, outcome FROM runs WHERE id = 'run_other'").get()).toEqual({ ended_at: null, outcome: null });
    });
    expect(runRow(late.state, runId)).toEqual({ outcome: 'interrupted', ended: 1 });
    // And in the shared copy after the merge: the job is no longer stuck.
    late.upload();
    withDb(w.shared, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded' });
      expect(getJob(db, foreign)).toMatchObject({ status: 'running' });
    });
    expect(runRow(w.shared, runId)).toEqual({ outcome: 'interrupted', ended: 1 });

    // The same delivery once more: nothing is left.
    const again = vm(w, 'vm again', { now: () => Date.now() + 8 * HOURS });
    again.download();
    expect((await again.run()).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery', abandonedRun: null });
  });

  it('after its hold expired, with its branch pushed and no pull request: the run is closed, nothing is started, and the summary says what to do', async () => {
    const { w, runId } = await vanished();
    w.f.pushCommit(BRANCH, 'widget.txt', 'pushed by the run that vanished\n');
    const late = vm(w, 'vm late', { now: () => Date.now() + 7 * HOURS });
    late.download();
    const r = await late.run();
    expect(r.summary).toMatchObject({
      outcome: 'nothing-to-do',
      reason: 'already-handled',
      exitCode: 0,
      resumed: false,
      stateRestored: false,
      abandonedRun: { jobId: JOB_ID, runId, settled: 'interrupted', resumed: false, existingBranch: BRANCH },
    });
    expect(r.summary.message).toContain('updraft retry');
    expect(existsSync(w.received)).toBe(false);
    expect(withDb(late.state, (db) => getJob(db, JOB_ID))).toMatchObject({ status: 'interrupted', attempts: 1 });
    expect(runRow(late.state, runId)).toEqual({ outcome: 'interrupted', ended: 1 });
    expect(late.upload().changed).toBe(true);
    expect(withDb(w.shared, (db) => getJob(db, JOB_ID))).toMatchObject({ status: 'interrupted' });
  });

  it('does not start another attempt once the job has used them up', async () => {
    const { w, runId } = await vanished();
    withDb(w.shared, (db) => db.prepare('UPDATE jobs SET attempts = 3 WHERE id = ?').run(JOB_ID));
    const late = vm(w, 'vm late', { now: () => Date.now() + 7 * HOURS });
    late.download();
    const r = await late.run();
    expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery', exitCode: 0, abandonedRun: { runId, settled: 'interrupted', resumed: false, existingBranch: null } });
    expect(r.summary.message).toContain('updraft retry');
    expect(existsSync(w.received)).toBe(false);
    expect(withDb(late.state, (db) => getJob(db, JOB_ID))).toMatchObject({ status: 'interrupted' });
  });
});

// Twice: the shared state has what a checkpoint carried (the publication still `publishing`), or
// what the runner's final merge of that database made of it (closed as unfinished, `failed`).
describe.each([
  { saved: 'a checkpoint', final: false },
  { saved: 'the final merge', final: true },
])('updraft run-event: a run that vanished between its push and its pull request, saved by $saved', { timeout: 180_000 }, ({ final }) => {
  const HOURS = 3_600_000;
  /**
   * A machine whose agent finished and whose push landed, checkpointed while it was publishing,
   * and vanished before the pull request was opened: the shared state has the job `succeeded`
   * and its publication `publishing` with no pull request; GitHub has the branch and no PR.
   * (Made from a run that did finish, its database turned back into that checkpoint.)
   */
  async function stalled() {
    const w = world();
    const lost = vm(w, 'vm lost');
    const first = await lost.run({ deliveryId: 'd-lost' });
    expect(first.code, JSON.stringify(first.summary)).toBe(0);
    const ended = remoteHead(w.f, BRANCH);
    const runId = withDb(lost.state, (db) => {
      db.prepare(
        `UPDATE publications SET state = 'publishing', pr_number = NULL, pr_url = NULL, published_at = NULL,
                lease_expires_at = '2026-01-01T00:00:00.000Z'`,
      ).run();
      return (db.prepare('SELECT run_id FROM publications').get() as { run_id: string }).run_id;
    });
    mergeState({ changed: lost.state, into: w.shared, ...(final ? {} : { live: true }) });
    // GitHub never saw the pull request.
    w.gh.pull = null;
    w.gh.pulls = [];
    rmSync(w.received, { force: true });
    withDb(w.shared, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded' });
      expect(db.prepare('SELECT state, retryable, pr_number FROM publications').get()).toEqual(
        final ? { state: 'failed', retryable: 0, pr_number: null } : { state: 'publishing', retryable: 0, pr_number: null },
      );
    });
    return { w, runId, ended };
  }
  const late = (w: World) => {
    const v = vm(w, 'vm late', { now: () => Date.now() + 7 * HOURS });
    v.download();
    return v;
  };

  it('with its branch on GitHub at the commit it ended on: opens the pull request from it, and runs no agent', async () => {
    const { w, runId, ended } = await stalled();
    const v = late(w);
    const r = await v.run({ deliveryId: 'd-late' });
    expect(r.code, JSON.stringify(r.summary)).toBe(0);
    expect(r.summary).toMatchObject({
      outcome: 'succeeded',
      resumed: true,
      runId,
      publication: 'published',
      prNumber: expect.any(Number),
      abandonedRun: { jobId: JOB_ID, runId, settled: 'publication', resumed: true, existingBranch: BRANCH },
    });
    expect(existsSync(w.received)).toBe(false);
    expect(remoteHead(w.f, BRANCH)).toBe(ended);
    expect(w.gh.pull).toMatchObject({ headRef: BRANCH, state: 'open' });
    withDb(v.state, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(db.prepare('SELECT state, pr_number IS NOT NULL AS pr FROM publications').get()).toEqual({ state: 'published', pr: 1 });
    });
  });

  it('with nothing of it on GitHub: the publication fails, and this delivery runs the job as its next attempt', async () => {
    const { w, runId } = await stalled();
    w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'update-ref', '-d', `refs/heads/${BRANCH}`);
    const v = late(w);
    const r = await v.run({ deliveryId: 'd-late' });
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({
      outcome: 'succeeded',
      resumed: true,
      publication: 'published',
      branch: `${BRANCH}-2`,
      abandonedRun: { jobId: JOB_ID, runId, settled: 'publication', resumed: true, existingBranch: null },
    });
    expect(r.summary.runId).not.toBe(runId);
    expect(existsSync(w.received)).toBe(true);
    withDb(v.state, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'succeeded', attempts: 2 });
      expect(db.prepare('SELECT state, retryable FROM publications WHERE run_id = ?').get(runId)).toEqual({ state: 'failed', retryable: 0 });
    });
  });

  it('with another commit on its branch: publishes nothing, fails the job so updraft retry takes it, and exits 1', async () => {
    const { w, runId, ended } = await stalled();
    const tree = w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'rev-parse', `${ended}^{tree}`);
    const other = w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'commit-tree', tree, '-p', ended, '-m', 'someone else');
    w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'update-ref', `refs/heads/${BRANCH}`, other);
    const v = late(w);
    const r = await v.run({ deliveryId: 'd-late' });
    expect(r.code).toBe(1);
    expect(r.summary).toMatchObject({ reason: 'publication-not-recoverable', abandonedRun: { runId, settled: 'publication', resumed: false, existingBranch: BRANCH } });
    expect(r.summary.message).toContain(`updraft retry ${JOB_ID}`);
    expect(existsSync(w.received)).toBe(false);
    expect(remoteHead(w.f, BRANCH)).toBe(other);
    expect(w.gh.pull).toBeNull();
    withDb(v.state, (db) => {
      expect(getJob(db, JOB_ID)).toMatchObject({ status: 'failed' });
      expect(db.prepare('SELECT state, retryable FROM publications').get()).toEqual({ state: 'failed', retryable: 0 });
    });
  });
});

describe('updraft run-event: a publication that was refused', { timeout: 180_000 }, () => {
  it('is not taken for one a vanished run left unfinished: a redelivery changes nothing', async () => {
    const w = world();
    const first = vm(w, 'vm first');
    expect((await first.run({ deliveryId: 'd-first' })).code).toBe(0);
    withDb(first.state, (db) =>
      db.prepare("UPDATE publications SET state = 'failed', retryable = 0, pr_number = NULL, pr_url = NULL, published_at = NULL, error = 'GitHub refused the pull request: 422'").run(),
    );
    mergeState({ changed: first.state, into: w.shared });
    w.gh.pull = null;
    w.gh.pulls = [];
    rmSync(w.received, { force: true });
    const late = vm(w, 'vm late', { now: () => Date.now() + 7 * 3_600_000 });
    late.download();
    const r = await late.run({ deliveryId: 'd-late' });
    expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'duplicate-delivery', abandonedRun: null, exitCode: 0 });
    expect(existsSync(w.received)).toBe(false);
    expect(w.gh.pull).toBeNull();
    expect(withDb(late.state, (db) => db.prepare('SELECT state, retryable, error FROM publications').get())).toEqual({ state: 'failed', retryable: 0, error: 'GitHub refused the pull request: 422' });
  });
});

describe('updraft run-event: one review, two machines', { timeout: 180_000 }, () => {
  const REVISE = { revise: true };
  /** A pull request on record in the shared state, a change request on it, and two machines that both start from that state. */
  async function twoMachines() {
    const w = world();
    const first = vm(w, 'vm publish', { repo: REVISE });
    expect((await first.run()).code).toBe(0);
    first.upload();
    rmSync(w.received, { force: true });
    const head1 = remoteHead(w.f, BRANCH);
    const review = w.gh.humanReview('allen', 'CHANGES_REQUESTED', 'Please add a second line.');
    const a = vm(w, 'vm a', { payload: pullRequestEvent('submitted'), repo: REVISE, revise: 'revise it the way machine A does.' });
    const b = vm(w, 'vm b', { payload: pullRequestEvent('submitted'), repo: REVISE, revise: 'revise it the way machine B does.' });
    a.download();
    b.download();
    return { w, a, b, head1, review };
  }
  const parentOf = (w: World, sha: string) => w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'rev-parse', `${sha}~1`);
  const revisionsOf = (file: string) =>
    withDb(file, (db) => db.prepare('SELECT state, pushed_at IS NOT NULL AS pushed, substr(coalesce(error, \'\'), 1, 11) AS why FROM revisions ORDER BY state').all() as Array<{ state: string; pushed: number; why: string }>);
  /** Merge the two machines' databases into a copy of the shared one, in the given order, and return what is on record. */
  function merged(w: World, order: Array<ReturnType<typeof vm>>, name: string) {
    const into = join(w.f.root, `${name}.db`);
    copyFileSync(w.shared, into);
    for (const m of order) mergeState({ changed: m.state, base: join(m.home, 'snapshot.db'), into });
    return withDb(into, (db) => ({
      jobs: (db.prepare("SELECT status FROM jobs WHERE event_id LIKE 'review:%'").all() as Array<{ status: string }>).map((j) => j.status),
      requests: db.prepare('SELECT r.state, j.status AS job FROM review_requests r LEFT JOIN jobs j ON j.id = r.job_id').all(),
      revisions: db.prepare("SELECT state, substr(coalesce(error, ''), 1, 11) AS why FROM revisions ORDER BY state").all(),
      rounds: countRevisions(db, REPO_ID, PR),
      dangling: db.prepare('SELECT count(*) AS n FROM runs WHERE job_id NOT IN (SELECT id FROM jobs)').get(),
    }));
  }
  const ONE_REVISION = { jobs: ['succeeded'], requests: [{ state: 'queued', job: 'succeeded' }], rounds: 1, dangling: { n: 0 } };

  it('one after the other: the second machine finds the first one\'s push on GitHub and starts no agent', async () => {
    const { w, a, b, head1 } = await twoMachines();
    const ra = await a.run({ eventName: 'pull_request_review', deliveryId: 'd-a' });
    expect(ra.summary).toMatchObject({ outcome: 'succeeded', exitCode: 0, publication: 'published' });
    const head2 = remoteHead(w.f, BRANCH);
    expect(parentOf(w, head2)).toBe(head1);
    rmSync(w.received);
    const writes = w.gh.writes.length;

    // Machine B knows nothing of that: its snapshot is from before the review.
    const rb = await b.run({ eventName: 'pull_request_review', deliveryId: 'd-b' });
    expect(rb.code).toBe(0);
    expect(rb.summary).toMatchObject({ outcome: 'canceled', reason: 'canceled-before-start', status: 'canceled', exitCode: 0, failureCommentUrl: null, loop: { rounds: 1 } });
    expect(rb.summary.error).toMatch(/^superseded: /);
    expect(existsSync(w.received)).toBe(false);
    expect(remoteHead(w.f, BRANCH)).toBe(head2);
    expect(w.gh.writes).toHaveLength(writes);
    expect(revisionsOf(b.state)).toEqual([]);

    // The shared state afterwards, whichever machine's merge comes first: one revision, published.
    for (const [name, order] of [['a first', [a, b]], ['b first', [b, a]]] as const) {
      expect(merged(w, [...order], name)).toMatchObject({ ...ONE_REVISION, revisions: [{ state: 'published', why: '' }] });
    }
  });

  it('a claim whose push never happened does not cancel the review, even after a person pushed', async () => {
    const { w, b, head1, review } = await twoMachines();
    // A machine claimed the review and died before pushing: the claim names a commit that
    // never reached GitHub. Then a person pushed to the branch.
    const neverPushed = 'f'.repeat(40);
    await w.gh.createIssueComment({ id: REPO_ID, fullName: FULL }, PR, `Revising.\n\n<!-- updraft-revision-of: ${review.id} ${head1}..${neverPushed} -->`);
    const tree = w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'rev-parse', `${head1}^{tree}`);
    const personal = w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'commit-tree', tree, '-p', head1, '-m', 'a person pushed');
    w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'update-ref', `refs/heads/${BRANCH}`, personal);

    const rb = await b.run({ eventName: 'pull_request_review', deliveryId: 'd-b' });
    expect(rb.summary).toMatchObject({ outcome: 'succeeded', exitCode: 0, publication: 'published' });
    expect(existsSync(w.received)).toBe(true);
    const head = remoteHead(w.f, BRANCH);
    expect(parentOf(w, head)).toBe(personal);
  });

  it('at the same time: both run their agent, one push is accepted, and the other ends quietly as superseded', async () => {
    const { w, a, b, head1 } = await twoMachines();
    // Machine A does everything, start to end, at the moment machine B is about to push.
    let other: Awaited<ReturnType<typeof a.run>> | undefined;
    const post = w.gh.createIssueComment.bind(w.gh);
    w.gh.createIssueComment = async (...args) => {
      if (!other) {
        other = { code: -1 } as Awaited<ReturnType<typeof a.run>>;
        other = await a.run({ eventName: 'pull_request_review', deliveryId: 'd-a' });
      }
      return post(...args);
    };
    const rb = await b.run({ eventName: 'pull_request_review', deliveryId: 'd-b' });
    expect(other?.summary).toMatchObject({ outcome: 'succeeded', exitCode: 0, publication: 'published' });
    const head2 = remoteHead(w.f, BRANCH);
    // One commit on top of the head the review was for: machine A's.
    expect(parentOf(w, head2)).toBe(head1);
    expect(head2).toBe(other?.summary.headSha);

    expect(rb.code).toBe(0);
    expect(rb.summary).toMatchObject({ outcome: 'superseded', reason: 'published-by-another-run', status: 'succeeded', runOutcome: 'succeeded', publication: 'skipped', exitCode: 0, failureCommentUrl: null });
    expect(rb.summary.publicationError).toMatch(/^superseded: /);
    expect(revisionsOf(a.state)).toEqual([{ state: 'published', pushed: 1, why: '' }]);
    expect(revisionsOf(b.state)).toEqual([{ state: 'skipped', pushed: 0, why: 'superseded:' }]);
    // What is left on the pull request: machine A's reply, and one line where machine B had announced its push.
    const comments = w.gh.comments.filter((c) => c.issue === PR).map((c) => c.body);
    expect(comments.filter((c) => c.includes('Updraft pushed 1 commit(s)'))).toHaveLength(1);
    expect(comments.filter((c) => c.includes('<!-- updraft-revision-of: '))).toHaveLength(1);
    expect(comments.filter((c) => c.includes('did not push'))).toEqual([]);

    for (const [name, order] of [['a first', [a, b]], ['b first', [b, a]]] as const) {
      expect(merged(w, [...order], name)).toMatchObject({
        ...ONE_REVISION,
        revisions: [
          { state: 'published', why: '' },
          { state: 'skipped', why: 'superseded:' },
        ],
      });
    }
  });

  it('the last look of the run that opened the pull request skips a review another machine has pushed for', async () => {
    for (const sharedState of [false, true]) {
      const w = world();
      const x = vm(w, 'vm issue', { repo: REVISE, revise: 'revise it the way the issue run does.' });
      // While the issue run is at its last look: its checkpoint is in the shared state, a person
      // requests changes, and the machine that delivery starts revises and pushes.
      let reviewVm: Awaited<ReturnType<typeof x.run>> | undefined;
      const read = w.gh.getPullRequestReviews.bind(w.gh);
      w.gh.getPullRequestReviews = async (...args) => {
        if (!reviewVm) {
          reviewVm = { code: -1 } as Awaited<ReturnType<typeof x.run>>;
          mergeState({ changed: x.state, into: w.shared, live: true });
          w.gh.humanReview('allen', 'CHANGES_REQUESTED', 'Please add a second line.');
          const a = vm(w, 'vm review', { payload: pullRequestEvent('submitted'), repo: REVISE, revise: 'revise it the way the review machine does.' });
          a.download();
          reviewVm = await a.run({ eventName: 'pull_request_review' });
          a.upload();
          rmSync(w.received);
        }
        return read(...args);
      };
      const r = await x.run(sharedState ? { sharedState: w.shared } : {});
      expect(reviewVm?.summary).toMatchObject({ outcome: 'succeeded', publication: 'published' });
      const head2 = remoteHead(w.f, BRANCH);
      expect(head2).toBe(reviewVm?.summary.headSha);
      expect(r.code).toBe(0);
      expect(r.summary).toMatchObject({ outcome: 'succeeded', exitCode: 0, publication: 'published' });
      // No second agent run and no second push, either way.
      expect(existsSync(w.received)).toBe(false);
      expect(w.f.git(w.f.root, '--git-dir', w.f.remoteDir, 'rev-list', '--count', `main..${head2}`)).toBe('2');
      if (sharedState) {
        // The fresher copy of the shared state had the review on record: it was never queued here.
        expect(r.summary.finalLook).toMatchObject({ queued: 0, knownElsewhere: 1, error: null });
        expect(r.summary.followOnJobs).toBeUndefined();
      } else {
        // Without it GitHub said so, before any agent started.
        expect(r.summary.finalLook).toMatchObject({ queued: 1, knownElsewhere: 0, error: null });
        expect(r.summary.followOnJobs).toMatchObject([{ kind: 'revision', status: 'canceled', outcome: 'canceled' }]);
      }
      x.upload();
      withDb(w.shared, (db) => {
        expect(db.prepare('SELECT state FROM revisions').all()).toEqual([{ state: 'published' }]);
        expect(countRevisions(db, REPO_ID, PR)).toBe(1);
      });
    }
  });
});
