import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { ReviewLoopApiStubs } from '../../test/review-loop-api-stubs.js';
import { renderStatus, buildStatusView } from '../commands/status.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { endDependencyWait, getDependencyWait, waitOfJob } from '../db/dependency-waits.js';
import { listPrunableJobs } from '../db/prune.js';
import { claimNextJob, finishRun, getJob, getStatusSnapshot, setRunSummary } from '../db/queue.js';
import { computeStats } from '../db/stats.js';
import { GitHubError, type GitHubApi, type GitHubIssue, type GitHubIssueComment, type GitHubIssueEvent, type PullRequestDetails } from '../github/api.js';
import type { UpdraftPaths } from '../paths.js';
import { dependencyWaitMarker } from '../publish/dependency-comment.js';
import { dependencyEndedMarker } from '../publish/failure-comment.js';
import { publishRun } from '../publish/publish.js';
import { resumeOf, type RepoRef, type RunSummary } from '../types.js';
import { silentLogger } from '../util/log.js';
import { checkWait, createDependencyWatcher } from './dependencies.js';
import { checkJobDispatchable } from './poller.js';

const REPO_ID = 42;
const FULL = 'octo/app';
const LIB_ID = 77;
const T0 = Date.parse('2026-11-17T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The issue, the pull request in octo/lib and the issue's comments, in memory. */
class FakeApi extends ReviewLoopApiStubs implements GitHubApi {
  issue: GitHubIssue = { number: 7, title: 'Use the hook', body: 'Body', htmlUrl: `https://github.com/${FULL}/issues/7`, state: 'open', labels: ['updraft:ready'], isPullRequest: false };
  pr: Partial<PullRequestDetails> = { state: 'open', merged: false, title: 'Add the hook' };
  comments: GitHubIssueComment[] = [];
  events: GitHubIssueEvent[] = [];
  readonly calls: string[] = [];
  failNext: Partial<Record<'getIssue' | 'getPullRequest' | 'getRepo' | 'createIssueComment', GitHubError>> = {};
  private nextId = 1;

  private maybeFail(name: keyof FakeApi['failNext']): void {
    const err = this.failNext[name];
    if (err) {
      delete this.failNext[name];
      throw err;
    }
  }

  override getPullRequest = async (repo: RepoRef, n: number): Promise<PullRequestDetails> => {
    this.calls.push(`getPullRequest ${repo.id} ${repo.fullName}#${n}`);
    this.maybeFail('getPullRequest');
    return {
      number: n,
      nodeId: 'PR_1',
      htmlUrl: `https://github.com/${repo.fullName}/pull/${n}`,
      state: 'open',
      merged: false,
      draft: false,
      headRef: 'hook',
      headSha: 'a'.repeat(40),
      baseRef: 'main',
      mergeable: null,
      mergeableState: 'unknown',
      ...this.pr,
    };
  };
  async getViewer() {
    return { login: 'allen', id: 1 };
  }
  async getWorkerIdentity() {
    return { kind: 'user' as const, login: 'allen', id: 1 };
  }
  async listUserRepos(): Promise<never[]> {
    return [];
  }
  async getRepo(fullName: string) {
    this.calls.push(`getRepo ${fullName}`);
    this.maybeFail('getRepo');
    const [owner, name] = fullName.split('/') as [string, string];
    return { id: LIB_ID, fullName, owner, name, private: false, archived: false, defaultBranch: 'main', description: null, permissions: null };
  }
  async listLabels(): Promise<never[]> {
    return [];
  }
  async listIssueEvents(): Promise<never> {
    throw new Error('not used');
  }
  async getIssue(repo: RepoRef, n: number) {
    this.calls.push(`getIssue ${repo.id} #${n}`);
    this.maybeFail('getIssue');
    return { ...this.issue };
  }
  async listEventsForIssue() {
    return [...this.events];
  }
  async getIssueBodyEdit() {
    return { lastEditedAt: null, editor: null };
  }
  async listPullRequestsForHead(): Promise<never> {
    throw new Error('not used');
  }
  async listPullRequestUpdates(): Promise<never> {
    throw new Error('not used');
  }
  async getPullRequestReviews(): Promise<never> {
    throw new Error('not used');
  }
  async createPullRequest(): Promise<never> {
    throw new Error('a waiting run opens no pull request');
  }
  async listIssueComments() {
    return [...this.comments];
  }
  async createIssueComment(_repo: RepoRef, issue: number, body: string) {
    this.calls.push(`createComment #${issue}`);
    this.maybeFail('createIssueComment');
    const id = this.nextId++;
    const c = { id, htmlUrl: `https://github.com/${FULL}/issues/${issue}#issuecomment-${id}`, body, user: 'allen' };
    this.comments.push(c);
    return c;
  }
  async updateIssueComment(): Promise<never> {
    throw new Error('not used');
  }
}

const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function makeConfig(dependencies: Record<string, unknown> | null = { repositories: ['octo/lib'], checkIntervalMinutes: 5, maxWaitDays: 2 }): UpdraftConfig {
  return configSchema.parse({
    version: 1,
    execution: { mode: 'live' },
    dispatch: { allowedActors: ['allen'] },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompt.md', output: 'local-branch' } },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: '../clones/app',
        publish: 'draft-pr',
        ...(dependencies ? { dependencies } : {}),
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
      },
    },
  });
}

const summary: RunSummary = {
  branch: 'b',
  baseSha: 'c'.repeat(40),
  headSha: 'c'.repeat(40),
  worktree: '/wt',
  commits: [],
  commitCount: 0,
  filesChanged: 0,
  diffStat: '',
  untracked: 0,
  lastOutput: ['UPDRAFT-WAITING-ON: octo/lib#12'],
  notes: [],
};

/** A job whose one run succeeded and declared a wait on octo/lib#12, as the worker records it. */
function waitingJob(o: { config?: UpdraftConfig } = {}) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const clock = { t: T0 };
  const now = () => clock.t;
  const config = o.config ?? makeConfig();
  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: 7 });
  // An escalated job keeps the pool and hops it reached.
  db.prepare("UPDATE jobs SET escalation_hops = 1, pool = 'general' WHERE id = ?").run(jobId);
  const c = claimNextJob(db, config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: '/runs', now })!;
  setRunSummary(db, c.run.id, summary);
  const finished = finishRun(db, c.run.id, {
    outcome: 'succeeded',
    now,
    dependency: { repo: 'octo/lib', number: 12, note: 'The hook belongs in octo/lib.', firstCheckAt: new Date(T0 + 5 * MIN).toISOString() },
  });
  const api = new FakeApi();
  const deps = { db, config, api, log: silentLogger, now };
  return { db, config, api, clock, deps, jobId, runId: c.run.id, finished, watcher: createDependencyWatcher(deps) };
}

const paths: UpdraftPaths = { configFile: '/cfg/config.yaml', configDir: '/cfg', dataDir: '/data', dbFile: '/data/state.db', logDir: '/data/logs', runsDir: '/data/logs/runs' };

describe('recording a wait', () => {
  it('closes the run as succeeded with its wait, and nothing publishes the run', async () => {
    const s = waitingJob();
    expect(s.finished?.dependency).toEqual({ repo: 'octo/lib', number: 12, note: 'The hook belongs in octo/lib.' });
    expect(getJob(s.db, s.jobId)?.status).toBe('succeeded');
    expect(getDependencyWait(s.db, s.runId)).toMatchObject({ state: 'waiting', depUrl: 'https://github.com/octo/lib/pull/12', waits: 1 });
    const r = await publishRun({ db: s.db, config: s.config, paths, api: s.api, log: silentLogger, token: async () => 't' }, s.runId);
    expect(r).toEqual({ status: 'not-eligible', reason: expect.stringContaining('waits on octo/lib#12') });
    // `updraft clean` keeps the job while it waits: the follow-up is copied from it.
    expect(listPrunableJobs(s.db, new Date(T0 + 365 * DAY).toISOString())[0]?.keep).toMatch(/wait on another repository/);
  });

  it('posts the waiting comment on the issue once, with no agent text in it', async () => {
    const s = waitingJob();
    await s.watcher.afterRun(s.runId);
    await s.watcher.afterRun(s.runId);
    expect(s.api.comments).toHaveLength(1);
    const body = s.api.comments[0]!.body;
    expect(body).toContain('Updraft is waiting on octo/lib#12');
    expect(body).toContain('every 5 minutes');
    expect(body).toContain('after 2 days');
    expect(body).toContain(`updraft cancel ${s.jobId}`);
    expect(body).toContain(dependencyWaitMarker(s.runId));
    expect(body).not.toContain('The hook belongs');
    expect(getDependencyWait(s.db, s.runId)?.waitComment.url).toBe(s.api.comments[0]!.htmlUrl);
  });
});

describe('checking a wait', () => {
  it('does nothing before the first check is due, then keeps waiting while the pull request is open', async () => {
    const s = waitingJob();
    await s.watcher.checkDue();
    expect(s.api.calls.filter((c) => c.startsWith('get'))).toEqual([]);
    s.clock.t = T0 + 5 * MIN;
    await s.watcher.checkDue();
    expect(s.api.calls).toContain(`getPullRequest ${LIB_ID} octo/lib#12`);
    expect(getDependencyWait(s.db, s.runId)).toMatchObject({ state: 'waiting', depRepoId: LIB_ID, checks: 1, depTitle: 'Add the hook', nextCheckAt: new Date(T0 + 10 * MIN).toISOString() });
  });

  it('queues one follow-up of the same workflow once the pull request is merged, which the pre-start check vouches for by the original label', async () => {
    const s = waitingJob();
    s.clock.t = T0 + 5 * MIN;
    s.api.pr = { state: 'closed', merged: true, mergedAt: '2026-11-17T12:04:00Z', mergeCommitSha: 'd'.repeat(40), title: 'Add the hook' };
    const r = await checkWait(s.deps, getDependencyWait(s.db, s.runId)!);
    expect(r.kind).toBe('resumed');
    const wait = getDependencyWait(s.db, s.runId)!;
    expect(wait).toMatchObject({ state: 'resumed', mergedAt: '2026-11-17T12:04:00Z', mergeCommitSha: 'd'.repeat(40) });
    const follow = getJob(s.db, wait.resumeJobId!)!;
    const original = getJob(s.db, s.jobId)!;
    expect(follow).toMatchObject({ status: 'queued', workflowId: 'wf', issueNumber: 7, action: 'implement-issue', pool: 'general', eventId: `dep:${s.runId}` });
    expect((s.db.prepare('SELECT escalation_hops FROM jobs WHERE id = ?').get(follow.id) as { escalation_hops: number }).escalation_hops).toBe(1);
    expect(resumeOf(follow)).toEqual({
      originalEventId: original.eventId,
      waitingRunId: s.runId,
      waitingJobId: s.jobId,
      waits: 1,
      pullRequest: { repo: 'octo/lib', number: 12, url: 'https://github.com/octo/lib/pull/12', title: 'Add the hook', mergedAt: '2026-11-17T12:04:00Z', mergeCommitSha: 'd'.repeat(40) },
      note: 'The hook belongs in octo/lib.',
    });

    // Checked again (a restart, a replay): still one follow-up.
    expect(await checkWait(s.deps, { ...wait, state: 'waiting' })).toEqual({ kind: 'resumed', jobId: follow.id });
    expect((s.db.prepare("SELECT count(*) AS n FROM jobs WHERE event_id LIKE 'dep:%'").get() as { n: number }).n).toBe(1);

    // The label application that queued the first job is the one in force: the follow-up may start.
    s.api.events = [{ id: Number(original.eventId), event: 'labeled', createdAt: '2026-11-17T10:00:00Z', actor: 'allen', label: 'updraft:ready', issue: null }];
    expect(await checkJobDispatchable({ api: s.api, config: s.config }, follow)).toMatchObject({ ok: true });
    // A newer application queues a job of its own; the follow-up of the older one gives way.
    s.api.events.push({ id: 99_999, event: 'labeled', createdAt: '2026-11-17T12:10:00Z', actor: 'allen', label: 'updraft:ready', issue: null });
    expect(await checkJobDispatchable({ api: s.api, config: s.config }, follow)).toMatchObject({ ok: false, reason: expect.stringContaining('no longer the current one') });
  });

  it('ends the wait with a failure comment when the pull request is closed without merging', async () => {
    const s = waitingJob();
    s.clock.t = T0 + 5 * MIN;
    s.api.pr = { state: 'closed', merged: false };
    await s.watcher.checkDue();
    expect(getDependencyWait(s.db, s.runId)).toMatchObject({ state: 'closed', reason: 'octo/lib#12 was closed without being merged' });
    expect((s.db.prepare("SELECT count(*) AS n FROM jobs WHERE event_id LIKE 'dep:%'").get() as { n: number }).n).toBe(0);
    const ended = s.api.comments.find((c) => c.body.includes(dependencyEndedMarker(s.runId)))!;
    expect(ended.body).toContain('Updraft stopped waiting on octo/lib#12');
    expect(ended.body).toContain('closed without being merged');
    expect(ended.body).toContain('apply it again');
    // The waiting comment would only mislead now; it is not posted late.
    expect(s.api.comments.some((c) => c.body.includes(dependencyWaitMarker(s.runId)))).toBe(false);
    await s.watcher.checkDue();
    expect(s.api.comments).toHaveLength(1);
  });

  it('ends a wait that runs past maxWaitDays as expired, with a failure comment', async () => {
    const s = waitingJob();
    s.clock.t = T0 + 2 * DAY;
    await s.watcher.checkDue();
    expect(getDependencyWait(s.db, s.runId)).toMatchObject({ state: 'expired', reason: expect.stringContaining('dependencies.maxWaitDays') });
    expect(s.api.comments[0]?.body).toContain(dependencyEndedMarker(s.runId));
  });

  it('cancels the wait, without a comment, when the issue was closed or lost its label, or the config no longer allows it', async () => {
    const closed = waitingJob();
    closed.clock.t = T0 + 5 * MIN;
    closed.api.issue.state = 'closed';
    await closed.watcher.checkDue();
    expect(getDependencyWait(closed.db, closed.runId)).toMatchObject({ state: 'canceled', reason: 'issue #7 was closed' });
    expect(closed.api.calls.some((c) => c.startsWith('getPullRequest'))).toBe(false);

    const unlabeled = waitingJob();
    unlabeled.clock.t = T0 + 5 * MIN;
    unlabeled.api.issue.labels = [];
    await unlabeled.watcher.checkDue();
    expect(getDependencyWait(unlabeled.db, unlabeled.runId)).toMatchObject({ state: 'canceled', reason: expect.stringContaining('trigger label') });

    const removed = waitingJob();
    removed.clock.t = T0 + 5 * MIN;
    await createDependencyWatcher({ ...removed.deps, config: makeConfig({ repositories: ['octo/other'] }) }).checkDue();
    expect(getDependencyWait(removed.db, removed.runId)).toMatchObject({ state: 'canceled', reason: expect.stringContaining('octo/lib is no longer in') });
    for (const s of [closed, unlabeled, removed]) expect(s.api.comments).toEqual([]);
  });

  it('keeps waiting through GitHub errors, backing the next check off, and ends it when the pull request cannot be read at all', async () => {
    const s = waitingJob();
    s.clock.t = T0 + 5 * MIN;
    s.api.failNext.getPullRequest = new GitHubError('GET /pulls/12: 502 Bad Gateway', 502);
    expect(await checkWait(s.deps, getDependencyWait(s.db, s.runId)!)).toMatchObject({ kind: 'error' });
    expect(getDependencyWait(s.db, s.runId)).toMatchObject({ state: 'waiting', failures: 1, nextCheckAt: new Date(T0 + 10 * MIN).toISOString() });
    s.api.failNext.getPullRequest = new GitHubError('GET /pulls/12: 503', 503);
    await checkWait(s.deps, getDependencyWait(s.db, s.runId)!);
    expect(getDependencyWait(s.db, s.runId)).toMatchObject({ state: 'waiting', failures: 2, nextCheckAt: new Date(T0 + 15 * MIN).toISOString() });
    expect((s.db.prepare("SELECT count(*) AS n FROM errors WHERE scope = 'dependency'").get() as { n: number }).n).toBe(2);
    await checkWait(s.deps, getDependencyWait(s.db, s.runId)!);
    expect(getDependencyWait(s.db, s.runId)).toMatchObject({ state: 'waiting', failures: 0 });

    s.api.failNext.getPullRequest = new GitHubError('Not Found', 404);
    await checkWait(s.deps, getDependencyWait(s.db, s.runId)!);
    expect(getDependencyWait(s.db, s.runId)).toMatchObject({ state: 'closed', reason: expect.stringContaining('cannot read it') });
  });

  it('ends exactly once: a cancel after the wait resumed changes nothing', async () => {
    const s = waitingJob();
    s.clock.t = T0 + 5 * MIN;
    s.api.pr = { state: 'closed', merged: true };
    await s.watcher.checkDue();
    expect(endDependencyWait(s.db, s.runId, { state: 'canceled', reason: 'canceled by user', now: () => s.clock.t })).toBe(false);
    expect(waitOfJob(s.db, s.jobId)?.state).toBe('resumed');
  });
});

describe('status and stats', () => {
  it('shows the wait in updraft status and counts it in updraft stats', async () => {
    const s = waitingJob();
    const view = () =>
      renderStatus(
        buildStatusView({ configPath: '/cfg/config.yaml', configState: 'ok', configMessage: null, config: s.config, dbFile: ':memory:', dbExists: true, snapshot: getStatusSnapshot(s.db, s.config, () => s.clock.t) }),
      );
    expect(view()).toContain('1 succeeded job(s) waiting on another pull request');
    expect(view()).toContain('Waiting on other repositories:');
    expect(view()).toMatch(/waiting on octo\/lib#12 since .*; not checked yet, next check/);
    expect(view()).toContain(`${s.jobId}  succeeded    ${FULL}#7  wf  updated`);
    expect(view()).toContain('— waiting on octo/lib#12');

    const window = { since: null, now: T0 + DAY, label: 'all' };
    expect(computeStats(s.db, window).overall.dependencies).toEqual({
      started: 1,
      ended: { resumed: 0, closed: 0, canceled: 0, expired: 0 },
      waitToMerge: expect.objectContaining({ count: 0 }),
      waitingNow: 1,
    });

    s.clock.t = T0 + 30 * MIN;
    s.api.pr = { state: 'closed', merged: true };
    await s.watcher.checkDue();
    expect(view()).toMatch(/resumed: octo\/lib#12 merged; follow-up job job_/);
    const after = computeStats(s.db, { ...window, now: T0 + DAY }).overall.dependencies;
    expect(after).toMatchObject({ started: 1, ended: { resumed: 1 }, waitingNow: 0, waitToMerge: { count: 1, medianMs: 30 * MIN } });
  });
});
