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
import { getJob } from '../db/queue.js';
import type { GitHubIssue, GitHubPullRequest } from '../github/api.js';
import { createUserCredentials } from '../github/credentials.js';
import { eventJobId } from '../poller/webhook.js';
import { createLogger } from '../util/log.js';
import { acquireWorkerLock } from '../worker/lock.js';
import { fakeContext, type MemoryOutput } from './fakes.js';
import { runEventCommand, type RunEventDeps, type RunEventOptions, type RunEventSummary } from './run-event.js';

const REPO_ID = 42;
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
  /** Which loops are on for the repository. */
  repo?: Record<string, unknown>;
  reviewerArgs?: string[];
  capacity?: boolean;
  now?: () => number;
}

/** One machine: its own state directory, config and event file. */
function vm(w: World, name: string, o: VmOptions = {}) {
  const home = join(w.f.root, name);
  mkdirSync(join(home, 'prompts'), { recursive: true });
  for (const p of ['implement', 'revise', 'review']) writeFileSync(join(home, 'prompts', `${p}.md`), `${p} the thing below.\n`);
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
      claude: { command: process.execPath, args: ['--mode', 'success', '--received', w.received], env },
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
      `comment #${PR}`,
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
    expect(w.gh.writes).toHaveLength(8);
    // Only the event lookup itself asked GitHub anything.
    expect(w.gh.calls.slice(calls).filter((c) => c.startsWith('listPullRequestsForHead'))).toEqual([]);
    expect(again.upload()).toMatchObject({ changed: false });
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
    expect(w.gh.writes.slice(-1)).toEqual([`comment #${PR}`]);
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
    // With revise alone, the pull request is first put on record by the first event about it.
    expect(v.upload().tables.revision_prs).toMatchObject({ inserted: 1 });
    expect(withDb(w.shared, (db) => getLoopPr(db, REPO_ID, PR)?.state)).toBe('closed');

    w.gh.pull!.state = 'open';
    const calls = w.gh.calls.length;
    const re = event(w, 'vm reopened', 'reopened', { repo: { revise: true } });
    expect((await re.run({ eventName: 'pull_request' })).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'pull-request-closed' });
    // Decided from the state database: GitHub was not asked.
    expect(w.gh.calls.slice(calls)).toEqual([]);
    expect(existsSync(w.received)).toBe(false);
  });

  it('does nothing for a pull request Updraft does not watch, without asking GitHub or starting an agent', async () => {
    const w = await published({ revise: true });
    const calls = w.gh.calls.length;
    for (const [eventName, action] of [
      ['pull_request_review', 'submitted'],
      ['pull_request_review', 'edited'],
      ['pull_request_review', 'dismissed'],
      ['pull_request', 'synchronize'],
      ['pull_request', 'closed'],
      ['pull_request', 'reopened'],
    ] as const) {
      const v = vm(w, `vm ${eventName} ${action}`, { payload: pullRequestEvent(action, 555), repo: { revise: true } });
      v.download();
      const r = await v.run({ eventName });
      expect(r.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'pull-request-not-watched', dispatched: false, exitCode: 0, event: { pullRequest: 555 } });
      // Nothing but the record that pull request #100 (the one Updraft did open) is watched.
      expect(v.upload().totals).toMatchObject({ updated: 0, appended: 0, conflicts: 0 });
    }
    // A machine with no state at all knows of no pull request, and creates no state for the question.
    const empty = vm(w, 'vm empty', { payload: pullRequestEvent('submitted'), repo: { revise: true } });
    expect((await empty.run({ eventName: 'pull_request_review' })).summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'pull-request-not-watched' });
    expect(existsSync(empty.state)).toBe(false);
    expect(w.gh.calls.slice(calls)).toEqual([]);
    expect(existsSync(w.received)).toBe(false);
  });
});
