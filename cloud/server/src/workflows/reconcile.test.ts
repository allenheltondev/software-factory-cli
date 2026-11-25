import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CommitCheckCounts, PullRequestHead } from '../github/client.js';
import type { LaunchRequest, LaunchResult } from '../jobs/launch.js';
import { createWorkflowRecorder } from './recorder.js';
import { createWorkflowReconciler, recoveryDeliveryId } from './reconcile.js';
import { createMemoryWorkflowStore } from './store.js';
import { CI_FIRST_CHECK_MS, CI_RECHECK_MS, CI_WAIT_LIMIT_MS, MAX_CI_RECOVERIES, STALL_LIMIT_MS } from './workflow.js';

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SETTINGS = { appId: '4242', slug: 'updraft', privateKey, clientId: 'c', clientSecret: 's', webhookSecret: 'w' };
const HEAD = 'a'.repeat(40);

const job = (over: Record<string, unknown> = {}) =>
  ({ jobId: 'job_issue0001', installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, eventName: 'issues', deliveryId: 'd-1', ...over }) as Parameters<
    ReturnType<typeof createWorkflowRecorder>['started']
  >[0];

function setup(o: { checks?: CommitCheckCounts; pr?: Partial<PullRequestHead>; launch?: LaunchResult; engaged?: boolean } = {}) {
  const store = createMemoryWorkflowStore();
  let clock = T0;
  const now = () => clock;
  const recorder = createWorkflowRecorder({ store, now, log: () => {} });
  const github = {
    createInstallationToken: vi.fn(async () => ({ token: 'ghs_x', expiresAt: clock + 3_600_000 })),
    pullRequestHead: vi.fn(async (): Promise<PullRequestHead> => ({ state: 'open', merged: false, headSha: HEAD, headRef: 'updraft/issue-7-job', ...o.pr })),
    commitChecks: vi.fn(async (): Promise<CommitCheckCounts> => o.checks ?? { total: 2, pending: 0, failed: 1, passed: 1, complete: true }),
  };
  const launched: LaunchRequest[] = [];
  const launch = vi.fn(async (req: LaunchRequest): Promise<LaunchResult> => {
    launched.push(req);
    return o.launch ?? { status: 202, disposition: 'launched', jobId: 'job_recovered01' };
  });
  const reconcile = createWorkflowReconciler({
    store,
    github,
    loadSettings: async () => SETTINGS as never,
    launch,
    appBot: async () => 'updraft[bot]',
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
  return { store, recorder, reconcile, github, launch, launched, tick, wf, waitForCi };
}

describe('workflow reconciliation', () => {
  it('does nothing before a CI wait is due', async () => {
    const s = setup();
    await s.waitForCi();
    expect(await s.reconcile()).toMatchObject({ checked: 0 });
    expect(s.github.pullRequestHead).not.toHaveBeenCalled();
  });

  it('recovers a missed check event once per head: the job a check_suite delivery would start', async () => {
    const s = setup();
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    expect(await s.reconcile()).toMatchObject({ checked: 1, recovered: 1 });
    expect(s.launched).toHaveLength(1);
    const req = s.launched[0]!;
    expect(req).toMatchObject({ installationId: 55, eventName: 'check_suite', appBot: 'updraft[bot]', deliveryId: recoveryDeliveryId({ installationId: 55, repositoryId: 99, pullRequest: 12 }, HEAD, 1) });
    expect(JSON.parse(req.body)).toMatchObject({ action: 'completed', repository: { id: 99, full_name: 'acme/web' }, installation: { id: 55 }, check_suite: { head_sha: HEAD, pull_requests: [{ number: 12 }] } });
    expect(s.github.createInstallationToken).toHaveBeenCalledWith(expect.any(String), 55, { repositoryIds: [99], permissions: { pull_requests: 'read', checks: 'read', statuses: 'read' } });
    expect(await s.wf()).toMatchObject({ recoveries: 1, recoveredSha: HEAD, status: 'waiting' });
    const events = await s.store.listWorkflowEvents(55, '99-i7', 50);
    expect(events.at(-1)).toMatchObject({ kind: 'ci_recovered', headSha: HEAD, jobId: 'job_recovered01', message: expect.stringMatching(/without a check event/) });

    // The recovered job starts: the workflow is active, nothing is due.
    await s.recorder.started(job({ jobId: 'job_recovered01', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: req.deliveryId }));
    expect((await s.wf())!.nextCheckAt).toBeUndefined();
  });

  it('stops recovering a head after MAX_CI_RECOVERIES, and says a person must act', async () => {
    const s = setup({ launch: { status: 200, disposition: 'duplicate' } });
    await s.waitForCi();
    for (let i = 0; i < MAX_CI_RECOVERIES; i++) {
      s.tick(CI_RECHECK_MS);
      await s.reconcile();
    }
    expect(s.launched.map((r) => r.deliveryId)).toEqual([1, 2].map((n) => recoveryDeliveryId({ installationId: 55, repositoryId: 99, pullRequest: 12 }, HEAD, n)));
    s.tick(CI_RECHECK_MS);
    expect(await s.reconcile()).toMatchObject({ blocked: 1 });
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'ci_event_missed', nextAction: expect.stringMatching(/Retry/) });
    expect((await s.wf())!.nextCheckAt).toBeUndefined();
    expect(s.launched).toHaveLength(MAX_CI_RECOVERIES);
  });

  it('treats CI that reports only commit statuses, or none at all, like any finished checks', async () => {
    const s = setup({ checks: { total: 0, pending: 0, failed: 0, passed: 0, complete: true } });
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    expect(await s.reconcile()).toMatchObject({ recovered: 1 });
    expect((await s.store.listWorkflowEvents(55, '99-i7', 50)).at(-1)!.message).toContain('none reported');
  });

  it('waits while checks run, holding nothing, and blocks once they have run too long', async () => {
    const s = setup({ checks: { total: 3, pending: 1, failed: 0, passed: 2, complete: true } });
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    expect(await s.reconcile()).toMatchObject({ checked: 1, recovered: 0, blocked: 0 });
    expect(await s.wf()).toMatchObject({ status: 'waiting', nextCheckAt: new Date(T0 + CI_FIRST_CHECK_MS + CI_RECHECK_MS).toISOString() });
    s.tick(CI_WAIT_LIMIT_MS);
    expect(await s.reconcile()).toMatchObject({ blocked: 1 });
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'ci_stuck', message: expect.stringMatching(/1 still running/) });
    expect(s.launched).toEqual([]);
  });

  it('never reads an incomplete listing of checks as finished', async () => {
    const s = setup({ checks: { total: 100, pending: 0, failed: 0, passed: 100, complete: false } });
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    await s.reconcile();
    expect(s.launched).toEqual([]);
  });

  it('finishes a workflow whose pull request was merged or closed meanwhile', async () => {
    const s = setup({ pr: { state: 'closed', merged: true } });
    await s.waitForCi();
    s.tick(CI_FIRST_CHECK_MS);
    expect(await s.reconcile()).toMatchObject({ finished: 1 });
    expect(await s.wf()).toMatchObject({ status: 'finished', stage: 'merged' });
    expect(s.launched).toEqual([]);
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

  it('says why when the launcher refuses the step, and leaves a quota refusal for later', async () => {
    const refused = setup({ launch: { status: 200, disposition: 'not_dispatched', reason: 'loop_off', message: 'ciFix is off for this repository' } });
    await refused.waitForCi();
    refused.tick(CI_FIRST_CHECK_MS);
    await refused.reconcile();
    expect(await refused.wf()).toMatchObject({ status: 'blocked', reason: 'ci_not_dispatched', message: expect.stringMatching(/ciFix is off/) });

    const throttled = setup({ launch: { status: 200, disposition: 'throttled' } });
    await throttled.waitForCi();
    throttled.tick(CI_FIRST_CHECK_MS);
    await throttled.reconcile();
    expect(await throttled.wf()).toMatchObject({ status: 'waiting', nextCheckAt: expect.any(String) });
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
    expect((await s.wf())!.recoveries ?? 0).toBe(0);

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
});
