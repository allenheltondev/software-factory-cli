import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CommitCheckCounts, PullRequestHead } from '../github/client.js';
import type { Job, JobSummary } from '../store/store.js';
import { createWorkflowRecorder } from './recorder.js';
import { createWorkflowReconciler } from './reconcile.js';
import { createMemoryWorkflowStore } from './store.js';
import { CI_FIRST_CHECK_MS, CI_RECHECK_MS, CI_WAIT_LIMIT_MS, FINISH_GRACE_MS, PR_POLL_MS, SIGN_IN_LIMIT_MS, STALL_LIMIT_MS } from './workflow.js';

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SETTINGS = { appId: '4242', slug: 'updraft', privateKey, clientId: 'c', clientSecret: 's', webhookSecret: 'w' };
const HEAD = 'a'.repeat(40);

const job = (over: Record<string, unknown> = {}) =>
  ({ jobId: 'job_issue0001', installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, eventName: 'issues', deliveryId: 'd-1', ...over }) as Parameters<
    ReturnType<typeof createWorkflowRecorder>['started']
  >[0];

function setup(o: { checks?: CommitCheckCounts; pr?: Partial<PullRequestHead>; engaged?: boolean; jobs?: Record<string, { job?: Partial<Job>; summary?: Partial<JobSummary> }> } = {}) {
  const store = createMemoryWorkflowStore();
  const controls = { getWorkflowPause: vi.fn(async (_i: number, _r: number, _s: number): Promise<import('../store/store.js').WorkflowPause | null> => null) };
  let clock = T0;
  const now = () => clock;
  const recorder = createWorkflowRecorder({ store, now, log: () => {} });
  const github = {
    createInstallationToken: vi.fn(async () => ({ token: 'ghs_x', expiresAt: clock + 3_600_000 })),
    pullRequestHead: vi.fn(async (): Promise<PullRequestHead> => ({ state: 'open', merged: false, headSha: HEAD, headRef: 'updraft/issue-7-job', ...o.pr })),
    commitChecks: vi.fn(async (): Promise<CommitCheckCounts> => o.checks ?? { total: 2, pending: 0, failed: 1, passed: 1, complete: true }),
  };
  const reconcile = createWorkflowReconciler({
    store,
    controls,
    jobs: {
      getJob: async (id: string) => (o.jobs?.[id]?.job as Job | undefined) ?? null,
      getJobSummary: async (_i: number, id: string) => (o.jobs?.[id]?.summary as JobSummary | undefined) ?? null,
    },
    github,
    loadSettings: async () => SETTINGS as never,
    killSwitch: { engaged: async () => o.engaged === true },
    now,
    log: () => {},
  });
  const tick = (ms: number) => (clock += ms);
  const wf = () => store.getWorkflow(55, '99-i7');
  /** The issue's job opened PR #12 and left it waiting for CI. */
  const waitForCi = async () => {
    await recorder.started(job());
    await recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci', verdict: 'ready-to-merge' } });
  };
  return { store, controls, recorder, reconcile, github, tick, wf, waitForCi };
}

describe('workflow reconciliation', () => {
  it('does nothing before a CI wait is due, and reports what is left due and for how long', async () => {
    const s = setup();
    await s.waitForCi();
    expect(await s.reconcile()).toMatchObject({ checked: 0, backlog: 0, oldestDueSeconds: 0 });
    expect(s.github.pullRequestHead).not.toHaveBeenCalled();
    // Due, but the run fails on it: it is left due, and the report says how long.
    s.tick(CI_FIRST_CHECK_MS + 120_000);
    s.github.pullRequestHead.mockRejectedValueOnce(new Error('down'));
    const r = await s.reconcile();
    expect(r).toMatchObject({ failed: 1, backlog: 0 });
  });

  it('reports a missed check event, and starts no job: a person restarts the loop', async () => {
    const s = setup();
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    expect(await s.reconcile()).toMatchObject({ checked: 1, blocked: 1 });
    expect(s.github.createInstallationToken).toHaveBeenCalledWith(expect.any(String), 55, { repositoryIds: [99], permissions: { pull_requests: 'read', checks: 'read', statuses: 'read' } });
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'ci_event_missed', message: expect.stringMatching(/1 failed, 1 passed/), nextAction: expect.stringMatching(/Re-run a check/) });
    expect((await s.wf())!.nextCheckAt).toBeUndefined();
    const events = await s.store.listWorkflowEvents(55, '99-i7', 50);
    expect(events.at(-1)).toMatchObject({ kind: 'blocked', message: expect.stringMatching(/never reached Updraft/) });

    // The re-run check's event starts the next job: the workflow works again.
    await s.recorder.started(job({ jobId: 'job_pr000001', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-2' }));
    expect(await s.wf()).toMatchObject({ status: 'active' });
  });

  it('treats CI that reports only commit statuses, or none at all, like any finished checks', async () => {
    const s = setup({ checks: { total: 0, pending: 0, failed: 0, passed: 0, complete: true } });
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    expect(await s.reconcile()).toMatchObject({ blocked: 1 });
    expect((await s.wf())!.message).toContain('none reported');
  });

  it('waits while checks run, holding nothing, and blocks once they have run too long', async () => {
    const s = setup({ checks: { total: 3, pending: 1, failed: 0, passed: 2, complete: true } });
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    expect(await s.reconcile()).toMatchObject({ checked: 1, blocked: 0 });
    expect(await s.wf()).toMatchObject({ status: 'waiting', nextCheckAt: new Date(T0 + CI_FIRST_CHECK_MS + CI_RECHECK_MS).toISOString() });
    s.tick(CI_WAIT_LIMIT_MS);
    expect(await s.reconcile()).toMatchObject({ blocked: 1 });
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'ci_stuck', message: expect.stringMatching(/1 still running/) });
  });

  it('never reads an incomplete listing of checks as finished', async () => {
    const s = setup({ checks: { total: 100, pending: 0, failed: 0, passed: 100, complete: false } });
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    await s.reconcile();
    expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci' });
  });

  it('finishes a workflow whose pull request was merged or closed meanwhile', async () => {
    const s = setup({ pr: { state: 'closed', merged: true } });
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    expect(await s.reconcile()).toMatchObject({ finished: 1 });
    expect(await s.wf()).toMatchObject({ status: 'finished', stage: 'merged' });
  });

  it('blocks a loop that waits for an event no one sent, after STALL_LIMIT_MS', async () => {
    const s = setup();
    await s.recorder.started(job());
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'changes-requested', verdict: 'changes-requested' } });
    s.tick(2 * 3_600_000);
    await s.reconcile();
    expect(await s.wf()).toMatchObject({ status: 'waiting' });
    s.tick(STALL_LIMIT_MS);
    expect(await s.reconcile()).toMatchObject({ blocked: 1 });
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'stalled', nextAction: expect.stringMatching(/retry/) });
  });

  it('changes nothing when a job started while it looked, does nothing with the kill switch on, and isolates a failing workflow', async () => {
    const s = setup();
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    s.github.commitChecks.mockImplementationOnce(async () => {
      // A delivery arrives meanwhile and its job starts.
      await s.recorder.started(job({ jobId: 'job_pr000001', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-2' }));
      return { total: 1, pending: 0, failed: 1, passed: 0, complete: true };
    });
    await s.reconcile();
    expect(await s.wf()).toMatchObject({ status: 'active', lastJobId: 'job_pr000001' });
    expect((await s.store.listWorkflowEvents(55, '99-i7', 50)).some((e) => e.kind === 'blocked')).toBe(false);

    const off = setup({ engaged: true });
    await off.waitForCi();
    off.tick(CI_FIRST_CHECK_MS);
    expect(await off.reconcile()).toMatchObject({ checked: 0 });

    const broken = setup();
    await broken.waitForCi();
    broken.tick(CI_FIRST_CHECK_MS);
    broken.github.pullRequestHead.mockRejectedValueOnce(new Error('GitHub is down'));
    expect(await broken.reconcile()).toMatchObject({ failed: 1 });
    expect(await broken.wf()).toMatchObject({ nextCheckAt: new Date(T0 + CI_FIRST_CHECK_MS + CI_RECHECK_MS).toISOString() });
  });

  describe('stalls', () => {
    it('brings a workflow up to date from its job\'s own record when the finish never reached it', async () => {
      const s = setup({ jobs: { job_issue0001: { job: { status: 'finished', outcome: 'succeeded', eventName: 'issues' }, summary: { status: 'finished', outcome: 'succeeded', detail: { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } } } } } });
      await s.recorder.started(job({ expiresAt: T0 + 3_600_000 }));
      expect(await s.wf()).toMatchObject({ status: 'active', nextCheckAt: new Date(T0 + 3_600_000 + FINISH_GRACE_MS).toISOString() });
      s.tick(3_600_000 + FINISH_GRACE_MS);
      expect(await s.reconcile()).toMatchObject({ repaired: 1 });
      expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci', pullRequest: 12 });
      expect((await s.store.listWorkflowEvents(55, '99-i7', 10)).at(-1)).toMatchObject({ kind: 'finish_recovered', jobId: 'job_issue0001' });
    });

    it('waits for a job that is still running, and blocks one whose record is gone', async () => {
      const running = setup({ jobs: { job_issue0001: { job: { status: 'launched' } } } });
      await running.recorder.started(job({ expiresAt: T0 }));
      running.tick(FINISH_GRACE_MS);
      await running.reconcile();
      expect(await running.wf()).toMatchObject({ status: 'active', nextCheckAt: expect.any(String) });

      const gone = setup();
      await gone.recorder.started(job({ expiresAt: T0 }));
      gone.tick(FINISH_GRACE_MS);
      expect(await gone.reconcile()).toMatchObject({ blocked: 1 });
      expect(await gone.wf()).toMatchObject({ status: 'blocked', reason: 'job_lost' });
    });

    it('waits a day for a Claude sign-in, then blocks with what to do', async () => {
      const s = setup();
      await s.recorder.waiting({ installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, eventName: 'issues', deliveryId: 'd-1', jobId: 'job_waiting01' }, { reason: 'sign_in_required', message: 'waits', nextAction: 'sign in' });
      expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'awaiting-sign-in', reason: 'sign_in_required', lastJobId: 'job_waiting01' });
      s.tick(SIGN_IN_LIMIT_MS / 2);
      await s.reconcile();
      expect(await s.wf()).toMatchObject({ status: 'waiting' });
      s.tick(SIGN_IN_LIMIT_MS);
      expect(await s.reconcile()).toMatchObject({ blocked: 1 });
      expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'sign_in_expired', nextAction: expect.stringMatching(/Sign in/) });
      // The sign-in comes after all: the job starts, and the workflow works again.
      await s.recorder.started(job({ jobId: 'job_waiting01' }));
      expect(await s.wf()).toMatchObject({ status: 'active' });
    });

    it('blocks a run whose publication failed, with how to get it published', async () => {
      const s = setup();
      await s.recorder.started(job());
      await s.recorder.finished(job(), 'succeeded', { updraftOutcome: 'publish-failed' });
      expect(await s.wf()).toMatchObject({ status: 'blocked', stage: 'publish-failed', reason: 'publish_failed', nextAction: expect.stringMatching(/apply the label again/) });
    });
  });

  describe('never acts on a workflow that moved on', () => {
    it('blocks nothing when a job starts or finishes while it reads GitHub', async () => {
      for (const meanwhile of ['started', 'finished'] as const) {
        const s = setup();
        await s.waitForCi();
        s.tick(CI_FIRST_CHECK_MS);
        s.github.commitChecks.mockImplementationOnce(async () => {
          const next = job({ jobId: 'job_pr000001', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-2' });
          await s.store.linkPullRequest(55, 99, 12, '99-i7');
          await s.recorder.started(next);
          if (meanwhile === 'finished') await s.recorder.finished(next, 'succeeded', { prNumber: 12, loop: { rounds: 1, reviews: 2, stage: 'waiting-for-ci' } });
          return { total: 1, pending: 0, failed: 1, passed: 0, complete: true };
        });
        await s.reconcile();
        expect((await s.wf())!.status).not.toBe('blocked');
        expect((await s.store.listWorkflowEvents(55, '99-i7', 50)).some((e) => e.kind === 'blocked')).toBe(false);
      }
    });

    it('records one block when two reconcilers look at the same workflow at once', async () => {
      const s = setup();
      await s.waitForCi();
      s.tick(CI_FIRST_CHECK_MS);
      const other = createWorkflowReconciler({ store: s.store, controls: s.controls, github: s.github, loadSettings: async () => SETTINGS as never, now: () => T0 + CI_FIRST_CHECK_MS, log: () => {} });
      await Promise.all([s.reconcile(), other()]);
      expect((await s.store.listWorkflowEvents(55, '99-i7', 50)).filter((e) => e.kind === 'blocked')).toHaveLength(1);
    });

    it('records a later block of the same head as a new event, never as a replay', async () => {
      const s = setup();
      await s.waitForCi();
      s.tick(CI_FIRST_CHECK_MS);
      await s.reconcile();
      // A retry runs and leaves the same head waiting for CI again; its event is missed again.
      await s.recorder.started(job({ jobId: 'job_retry001', deliveryId: 'retry-1' }));
      await s.recorder.finished(job({ jobId: 'job_retry001', deliveryId: 'retry-1' }), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
      s.tick(CI_FIRST_CHECK_MS);
      expect(await s.reconcile()).toMatchObject({ blocked: 1 });
      expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'ci_event_missed' });
      expect((await s.wf())!.nextCheckAt).toBeUndefined();
      expect((await s.store.listWorkflowEvents(55, '99-i7', 50)).filter((e) => e.kind === 'blocked')).toHaveLength(2);
    });
  });

  it('looks for a merge or close of a pull request waiting for a person, and never blocks it for taking time', async () => {
    const s = setup();
    await s.recorder.started(job());
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'ready-to-merge' } });
    expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'ready-to-merge', nextCheckAt: new Date(T0 + PR_POLL_MS).toISOString() });
    s.tick(PR_POLL_MS);
    await s.reconcile();
    expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'ready-to-merge' });
    // Merged by a person, with no webhook: found at the next look.
    s.github.pullRequestHead.mockResolvedValue({ state: 'closed', merged: true, headSha: HEAD, headRef: 'updraft/x' });
    s.tick(PR_POLL_MS);
    await s.reconcile();
    expect(await s.wf()).toMatchObject({ status: 'finished', stage: 'merged' });
  });

  it('never finishes a new run because of the last run\'s merged pull request', async () => {
    const s = setup();
    // Run 1: PR #12 is merged.
    await s.recorder.started(job());
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'merged', merged: true } });
    // Run 2: the issue is labeled again, and its job opens PR #20, which waits for CI.
    await s.recorder.started(job({ jobId: 'job_again001', deliveryId: 'd-9' }));
    expect(await s.wf()).toMatchObject({ generation: 2, pastPullRequests: [{ number: 12, generation: 1 }] });
    expect((await s.wf())!.pullRequest).toBeUndefined();
    await s.recorder.finished(job({ jobId: 'job_again001', deliveryId: 'd-9' }), 'succeeded', { prNumber: 20, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
    expect(await s.wf()).toMatchObject({ pullRequest: 20, status: 'waiting', stage: 'waiting-for-ci' });
    s.tick(CI_FIRST_CHECK_MS);
    s.github.commitChecks.mockResolvedValueOnce({ total: 1, pending: 1, failed: 0, passed: 0, complete: true });
    await s.reconcile();
    expect(s.github.pullRequestHead).toHaveBeenLastCalledWith('ghs_x', 'acme/web', 20);
    expect(await s.wf()).toMatchObject({ status: 'waiting', generation: 2 });
  });
});
