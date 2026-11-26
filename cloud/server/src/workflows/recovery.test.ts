import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitCheckCounts, PullRequestHead } from '../github/client.js';
import { GitHubError } from '../github/client.js';
import { createLauncher, pullRequestLease, type LaunchDeps, type LaunchRequest, type RunMicrovmInput } from '../jobs/launch.js';
import { createAdmissionQueue, createGitHubRevalidator, createQueueDispatcher } from '../jobs/queue.js';
import { createMemoryQueueStore } from '../jobs/queue-store.js';
import { createReconciler } from '../jobs/reconcile.js';
import { createRetryHandler } from '../jobs/retry.js';
import { createMemoryStore, type JobFinishDetail, type Tenant } from '../store/store.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createWorkflowRecorder, updateWorkflow } from './recorder.js';
import { createWorkflowReconciler } from './reconcile.js';
import { issueBranchPrefix, LOST_TOKEN_GRACE_MS, MAX_RECOVERIES_PER_RUN, MAX_RECOVERY_ATTEMPTS, missedCheckKey, recoveryBackoff, recoveryIds, recoveryJobId } from './recovery.js';
import { createMemoryWorkflowStore } from './store.js';
import { CI_FIRST_CHECK_MS, CI_RECHECK_MS, LOST_JOB_LOOK_MS, type Workflow } from './workflow.js';

// Relative to the real clock: the memory store judges delivery claims by it.
const NOW = Date.now();
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const APP = { appId: '4242', slug: 'updraft', privateKey, clientId: 'c', clientSecret: 's', webhookSecret: 'w' };
const SETTINGS: LaunchDeps['settings'] = {
  region: 'us-east-1', bucket: 'tenant-bucket', imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:updraft-cloud-job', executionRoleArn: 'arn:aws:iam::123456789012:role/exec',
  ingressConnectorArn: 'arn:in', egressConnectorArn: 'arn:out', logGroup: '/aws/lambda-microvms/updraft-cloud-job', brokerFunctionName: 'updraft-cloud-broker', maximumDurationSeconds: 10800, watchdogReserveSeconds: 600,
};
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const BRANCH = 'updraft/issue-7-job_evabc';
const WF = '99-i7';
const tenant: Tenant = { installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '2026-11-19T00:00:00.000Z', createdBy: 's' };

/**
 * The whole Cloud path, in memory: the launcher, the admission queue and its dispatcher, the
 * console retry, the quota reconciliation, the workflow recorder and the workflow reconciler with
 * recovery. Only GitHub and RunMicrovm are fakes.
 */
async function world(o: { ciFix?: boolean; concurrentJobs?: number } = {}) {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant, { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
  const rules = dispatchRules({
    dispatch: { allowedActors: ['pat'] },
    repositories: { 'acme/web': { id: 99, review: true, revise: true, ...(o.ciFix === false ? {} : { ciFix: true }), workflows: [{ trigger: { label: 'updraft' } }] } },
  }, { keysFor: () => [] });
  const version = await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: rules });
  await store.markConfigReady(55, version as number);
  await store.activateConfig(55, version as number);

  let clock = NOW;
  const now = () => clock;
  const events: Record<string, string> = {};
  const runs: RunMicrovmInput[] = [];
  const workflowStore = createMemoryWorkflowStore();
  const recorder = createWorkflowRecorder({ store: workflowStore, now, log: () => {} });
  const queueStore = createMemoryQueueStore();
  const putEvent = async (key: string, body: string) => void (events[key] = body);
  const readEvent = async (key: string) => events[key] ?? null;
  let imageVersion: string | null = '3';
  const gh = {
    pr: { state: 'open', merged: false, headSha: HEAD, headRef: BRANCH } as PullRequestHead,
    checks: { total: 2, pending: 0, failed: 1, passed: 1, complete: true } as CommitCheckCounts,
    issue: { open: true, labels: ['updraft'] } as { open: boolean; labels: string[] },
    branches: [] as string[],
    pulls: { numbers: [] as number[], complete: true },
  };
  const github = {
    createInstallationToken: vi.fn(async () => ({ token: 'ghs_x', expiresAt: clock + 3_600_000 })),
    pullRequestHead: vi.fn(async (): Promise<PullRequestHead> => ({ ...gh.pr })),
    commitChecks: vi.fn(async (): Promise<CommitCheckCounts> => ({ ...gh.checks })),
    issueState: vi.fn(async () => ({ ...gh.issue })),
    matchingBranches: vi.fn(async (_t: string, _r: string, prefix: string) => gh.branches.filter((b) => b.startsWith(prefix))),
    pullRequestsByHeadPrefix: vi.fn(async () => ({ ...gh.pulls, numbers: [...gh.pulls.numbers] })),
  };
  const loadSettings = async () => APP as never;
  const launch = createLauncher({
    store, settings: SETTINGS, imageVersion: async () => imageVersion, putEvent,
    runMicrovm: async (input) => {
      runs.push(input);
      return { microvmId: `mvm-${runs.length}` };
    },
    quotas: { concurrentJobs: o.concurrentJobs ?? 1, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 },
    workflows: recorder,
    queue: createAdmissionQueue({ store: queueStore, putEvent, workflows: recorder, now, log: () => {} }),
    now, log: () => {}, retryDelayMs: 1, coalesceConfirmMs: 5, coalescePollMs: 1,
  });
  const dispatcher = createQueueDispatcher({ queue: queueStore, jobs: store, launch, readEvent, revalidate: createGitHubRevalidator({ github, loadSettings, now }), workflows: recorder, now, log: () => {} });
  const retry = createRetryHandler({ store, launch, readEvent, appBot: async () => 'updraft[bot]', now, log: () => {} });
  const logs: Record<string, unknown>[] = [];
  /** The please-act notices the blocks asked for (#173). */
  const notices: { workflowId: string; generation: number; reason: string }[] = [];
  const reconcilerFor = (over: Partial<Parameters<typeof createWorkflowReconciler>[0]> = {}) => createWorkflowReconciler({
    store: workflowStore, controls: store, jobs: store, github, loadSettings, now, log: (e) => void logs.push(e),
    recovery: { launch, retry, appBot: async () => 'updraft[bot]', queue: queueStore },
    notifyBlocked: async (wf, why) => void notices.push({ workflowId: wf.workflowId, generation: wf.generation, reason: why.reason }),
    ...over,
  });
  const reconcile = reconcilerFor();
  let microvm = 'RUNNING';
  const quota = createReconciler({ store, microvmState: async () => microvm, workflows: recorder, now, log: () => {} });

  const label = (deliveryId = 'd-label'): LaunchRequest => {
    const payload = { action: 'labeled', issue: { number: 7 }, label: { name: 'updraft' }, sender: { login: 'pat' }, repository: { id: 99, full_name: 'acme/web' } };
    return { installationId: 55, deliveryId, body: JSON.stringify(payload), payload };
  };
  /** A job's runner reports its finish (the broker's finish): its record, its slots, its workflow. */
  const finish = async (jobId: string, outcome: string, detail?: JobFinishDetail) => {
    const job = (await store.getJob(jobId))!;
    await store.finishJob(jobId, outcome, { at: clock, ...(detail ? { detail } : {}) });
    await store.releaseJob(job);
    // Its pull request's coalescing lease is over (the memory store judges it by the real clock).
    if (job.pullRequest !== undefined) await store.releaseDelivery(55, pullRequestLease(99, job.pullRequest), jobId);
    await recorder.finished(job, outcome, detail);
  };
  /** The issue's job opens PR #12 and leaves it waiting for CI. */
  const waitForCi = async (issue = 7, pr = 12) => {
    const req = label(`d-label-${issue}`);
    req.payload = { ...req.payload, issue: { number: issue } };
    req.body = JSON.stringify(req.payload);
    const first = await launch(req);
    expect(first).toMatchObject({ disposition: 'launched' });
    await finish(first.jobId!, 'succeeded', { prNumber: pr, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci', verdict: 'ready-to-merge' } });
    return first.jobId!;
  };
  const wf = async (id = WF) => (await workflowStore.getWorkflow(55, id))!;
  /** Puts the workflow back where it was, due now (what a lost write, or a recorder failure, leaves). */
  const rewind = (o: Partial<Workflow>, id = WF) => updateWorkflow(workflowStore, 55, id, (cur) => ({ workflow: { ...cur!, ...o, nextCheckAt: new Date(clock).toISOString() } }));
  const timeline = () => workflowStore.listWorkflowEvents(55, WF, 100);
  /** An owner stops a running job of the workflow: its stop pauses the issue and its pull request. */
  let stops = 0;
  const stop = async () => {
    const running = { ...(await store.getJob((await workflowStore.getWorkflow(55, WF))!.lastJobId!))!, jobId: `job_stopped${String(++stops).padStart(5, '0')}`, status: 'launched' as const };
    delete running.releasedAt;
    delete running.stop;
    await store.putJob(running);
    await store.requestJobStop(running, { requestedAt: clock, by: 'pat', reason: 'off course' }, [7, 12]);
  };
  return {
    store, workflowStore, queueStore, recorder, launch, dispatcher, retry, reconcile, reconcilerFor, quota, gh, github, runs, events, logs, notices,
    label, finish, waitForCi, wf, rewind, timeline, stop,
    tick: (ms: number) => (clock += ms),
    now,
    setImage: (v: string | null) => (imageVersion = v),
    setMicrovm: (s: string) => (microvm = s),
  };
}

const ciJobId = (head = HEAD, generation = 1) => recoveryJobId(55, WF, missedCheckKey({ generation }, head));

describe('fenced automatic recovery', () => {
  describe('a missed check event', () => {
    let w: Awaited<ReturnType<typeof world>>;
    beforeEach(async () => {
      w = await world();
    });

    it('starts the CI step once, for exactly the current head, through the launcher', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      expect(await w.reconcile()).toMatchObject({ checked: 1, recovered: 1, blocked: 0 });
      expect(w.runs).toHaveLength(2);
      const job = (await w.store.getJob(ciJobId()))!;
      expect(job).toMatchObject({ eventName: 'check_suite', pullRequest: 12, deliveryId: expect.stringMatching(/^recover-[0-9a-f]{32}$/) });
      // The stored event names this head and pull request, and nothing GitHub did not say.
      const body = JSON.parse(Object.entries(w.events).find(([k]) => k.includes(job.deliveryId))![1]);
      expect(body).toMatchObject({ action: 'completed', check_suite: { head_sha: HEAD, head_branch: BRANCH, pull_requests: [{ number: 12 }] }, repository: { id: 99, full_name: 'acme/web' }, updraft_recovery: { workflowId: WF, generation: 1 } });
      // The workflow follows the job, as for a real check event.
      expect(await w.wf()).toMatchObject({ status: 'active', stage: 'fixing-ci', lastJobId: ciJobId(), recovery: { kind: 'missed_check_event', key: `ci:1:${HEAD}`, attempts: 1, used: 1, result: 'launched' } });
      expect((await w.timeline()).filter((e) => e.kind === 'recovery')).toHaveLength(1);
    });

    it('starts nothing twice: two reconcilers at once, and every later look', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      const other = w.reconcilerFor();
      const [a, b] = await Promise.all([w.reconcile(), other()]);
      expect(a.recovered + b.recovered).toBe(1);
      expect(w.runs).toHaveLength(2);
      // The CI step's job finishes and leaves the same head waiting for CI: never run again for it.
      await w.finish(ciJobId(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
      w.tick(CI_FIRST_CHECK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(w.runs).toHaveLength(2);
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'ci_event_missed', message: expect.stringMatching(/already ran the missed CI step once for this head/) });
    });

    it('recovers each new head of the run once, within the run\'s budget, then blocks', async () => {
      await w.waitForCi();
      const heads = ['1', '2', '3', '4'].map((c) => c.repeat(40));
      for (const [i, head] of heads.entries()) {
        w.gh.pr = { ...w.gh.pr, headSha: head };
        w.tick(CI_FIRST_CHECK_MS);
        const r = await w.reconcile();
        if (i < MAX_RECOVERIES_PER_RUN) {
          expect(r).toMatchObject({ recovered: 1 });
          await w.finish(ciJobId(head), 'succeeded', { prNumber: 12, loop: { rounds: i + 1, reviews: i + 2, stage: 'waiting-for-ci' } });
        } else {
          expect(r).toMatchObject({ recovered: 0, blocked: 1 });
          expect(await w.wf()).toMatchObject({ reason: 'ci_event_missed', message: expect.stringMatching(/already acted 3 times in this run/) });
        }
      }
      expect(w.runs).toHaveLength(1 + MAX_RECOVERIES_PER_RUN);
    });

    it('lets a real check event that arrives first win: nothing is launched', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      w.github.commitChecks.mockImplementationOnce(async () => {
        // The real delivery comes while the reconciler reads the checks.
        const payload = { action: 'completed', check_suite: { head_sha: HEAD, head_branch: BRANCH, pull_requests: [{ number: 12, head: { ref: BRANCH } }] }, sender: { login: 'ci' }, repository: { id: 99, full_name: 'acme/web' } };
        expect(await w.launch({ installationId: 55, deliveryId: 'real-check', eventName: 'check_suite', body: JSON.stringify(payload), payload })).toMatchObject({ disposition: 'launched' });
        return { ...w.gh.checks };
      });
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 0 });
      expect(w.runs).toHaveLength(2);
      expect(await w.store.getJob(ciJobId())).toBeNull();
      expect(await w.wf()).toMatchObject({ status: 'active' });
      expect((await w.timeline()).some((e) => e.kind === 'recovery' || e.kind === 'blocked')).toBe(false);
    });

    it('never acts on a head that moved between its look and its launch (a person pushed)', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      // The first read decides on HEAD; the read right before the launch finds HEAD2.
      w.github.pullRequestHead.mockResolvedValueOnce({ ...w.gh.pr }).mockResolvedValueOnce({ ...w.gh.pr, headSha: HEAD2 });
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 0 });
      expect(w.runs).toHaveLength(1);
      expect(await w.wf()).toMatchObject({ status: 'waiting', reason: 'recovering', recovery: { result: 'stale_head' } });
      // The newer head's checks still run: waited on, nothing launched for the old one.
      w.gh.pr = { ...w.gh.pr, headSha: HEAD2 };
      w.gh.checks = { total: 2, pending: 1, failed: 0, passed: 1, complete: true };
      w.tick(recoveryBackoff(1));
      await w.reconcile();
      expect(w.runs).toHaveLength(1);
      expect(await w.wf()).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci' });
    });

    it('lets a stop win: between its claim and its launch, and at every look after', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      // A stop lands while the reconciler reads the pull request right before launching.
      w.github.pullRequestHead.mockResolvedValueOnce({ ...w.gh.pr }).mockImplementationOnce(async () => {
        await w.stop();
        return { ...w.gh.pr };
      });
      // The launcher's own pause check refuses it: nothing starts.
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 0 });
      expect(w.runs).toHaveLength(1);
      expect(await w.wf()).toMatchObject({ recovery: { result: 'not_dispatched:workflow_paused' } });
      // Every later look reports the pause, and starts nothing.
      w.tick(recoveryBackoff(1));
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'workflow_paused' });
      w.tick(CI_FIRST_CHECK_MS * 4);
      await w.reconcile();
      expect(w.runs).toHaveLength(1);
      // Even the launcher, asked directly with the recovery's own event, refuses while paused.
      const payload = { action: 'completed', check_suite: { head_sha: HEAD, head_branch: BRANCH, pull_requests: [{ number: 12, head: { ref: BRANCH } }] }, repository: { id: 99, full_name: 'acme/web' } };
      expect(await w.launch({ installationId: 55, deliveryId: 'x-1', eventName: 'check_suite', body: JSON.stringify(payload), payload })).toMatchObject({ reason: 'workflow_paused' });
    });

    it('queues behind capacity through the admission queue, which drops it once the head moved', async () => {
      await w.waitForCi();
      // Another issue's job holds the tenant's only slot.
      const other = { ...w.label('d-other'), payload: { ...w.label().payload, issue: { number: 8 } } };
      other.body = JSON.stringify(other.payload);
      const busy = await w.launch(other);
      expect(busy).toMatchObject({ disposition: 'launched' });
      w.tick(CI_FIRST_CHECK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 1 });
      expect(await w.wf()).toMatchObject({ status: 'waiting', stage: 'queued', lastJobId: ciJobId() });
      expect(w.queueStore.dump()).toEqual([expect.objectContaining({ jobId: ciJobId(), state: 'queued', eventName: 'check_suite', headSha: HEAD })]);
      // A later look changes nothing: the queued job is the workflow's.
      w.tick(recoveryBackoff(1));
      await w.reconcile();
      expect(w.queueStore.dump()).toHaveLength(1);
      // A person pushes; capacity frees; admission finds the event's head stale and starts nothing.
      w.gh.pr = { ...w.gh.pr, headSha: HEAD2 };
      await w.finish(busy.jobId!, 'succeeded');
      expect(await w.dispatcher.dispatch()).toMatchObject({ admitted: 0, ended: 1 });
      expect(w.queueStore.dump()[0]).toMatchObject({ state: 'canceled', outcome: { reason: 'stale_head' } });
      expect(w.runs).toHaveLength(2);
    });

    it('queues behind capacity and is admitted under its stable id once a slot frees', async () => {
      await w.waitForCi();
      const other = { ...w.label('d-other'), payload: { ...w.label().payload, issue: { number: 8 } } };
      other.body = JSON.stringify(other.payload);
      const busy = await w.launch(other);
      w.tick(CI_FIRST_CHECK_MS);
      await w.reconcile();
      await w.finish(busy.jobId!, 'succeeded');
      expect(await w.dispatcher.dispatch()).toMatchObject({ admitted: 1 });
      expect(w.runs.map((r) => r.clientToken)).toEqual([expect.any(String), busy.jobId, ciJobId()]);
      expect(await w.wf()).toMatchObject({ status: 'active', lastJobId: ciJobId() });
    });

    it('blocks with exactly why when the launcher refuses for good (ciFix is off)', async () => {
      const off = await world({ ciFix: false });
      await off.waitForCi();
      off.tick(CI_FIRST_CHECK_MS);
      expect(await off.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(off.runs).toHaveLength(1);
      expect(await off.wf()).toMatchObject({ status: 'blocked', reason: 'ci_event_missed', message: expect.stringMatching(/could not start the CI step: ciFix is off/) });
      expect((await off.wf()).nextCheckAt).toBeUndefined();
    });

    it('tries a transient refusal again with backoff, and blocks once its tries are spent', async () => {
      await w.waitForCi();
      w.setImage(null); // jobs are off: the launcher answers jobs_off
      w.tick(CI_FIRST_CHECK_MS);
      for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
        expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 0 });
        expect(await w.wf()).toMatchObject({ reason: 'recovering', recovery: { attempts: attempt, result: 'jobs_off' } });
        w.tick(recoveryBackoff(attempt));
      }
      expect(await w.reconcile()).toMatchObject({ blocked: 1 });
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'ci_event_missed', message: expect.stringMatching(/tried 6 times/) });
      expect(w.runs).toHaveLength(1);
    });

    it('does nothing while the kill switch is on', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      const off = w.reconcilerFor({ killSwitch: { engaged: async () => true } });
      expect(await off()).toMatchObject({ checked: 0, recovered: 0 });
      expect(w.runs).toHaveLength(1);
    });

    it('acts at most a bounded number of times per run, leaving the rest due for the next', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      const none = w.reconcilerFor({ maxRecoveries: 0 });
      expect(await none()).toMatchObject({ checked: 1, recovered: 0, blocked: 0, backlog: 1 });
      expect(w.runs).toHaveLength(1);
      expect(await w.reconcile()).toMatchObject({ recovered: 1 });
    });

    it('never lets a workflow it cannot act on yet starve the others (a pending queued job, a recovery job still running)', async () => {
      await w.waitForCi(7, 12);
      await w.waitForCi(8, 13);
      // Issue 7's workflow has a queued job pending behind its last one: nothing to do yet.
      await updateWorkflow(w.workflowStore, 55, WF, (cur) => ({ workflow: { ...cur!, pendingJobId: 'job_pending00000001' } }));
      w.tick(CI_FIRST_CHECK_MS);
      // One action per run: the no-op look at issue 7 must not use it, and must move its next look on.
      const one = w.reconcilerFor({ maxRecoveries: 1 });
      expect(await one()).toMatchObject({ checked: 2, recovered: 1, backlog: 0, oldestDueSeconds: 0 });
      expect(Date.parse((await w.wf()).nextCheckAt!)).toBe(w.now() + CI_RECHECK_MS);
      expect(await w.wf('99-i8')).toMatchObject({ status: 'active' });

      // A recovery job that runs while its workflow was not told (a lost write): waited on, moved on, never relaunched.
      const x = await world();
      await x.waitForCi();
      x.tick(CI_FIRST_CHECK_MS);
      await x.reconcile();
      await x.rewind({ status: 'waiting', stage: 'waiting-for-ci', reason: 'recovering' });
      expect(await x.reconcile()).toMatchObject({ recovered: 0, blocked: 0, backlog: 0 });
      expect(Date.parse((await x.wf()).nextCheckAt!)).toBe(x.now() + CI_RECHECK_MS);
      expect(x.runs).toHaveLength(2);
    });

    it('claims a head again after the head moved away and back, rather than replaying its old try', async () => {
      await w.waitForCi();
      w.setImage(null); // every try answers jobs_off
      for (const head of [HEAD, HEAD2, HEAD]) {
        w.gh.pr = { ...w.gh.pr, headSha: head };
        w.tick(CI_FIRST_CHECK_MS * 8);
        expect(await w.reconcile()).toMatchObject({ checked: 1, failed: 0 });
        expect(await w.wf()).toMatchObject({ recovery: { key: `ci:1:${head}`, attempts: 1 } });
        expect(Date.parse((await w.wf()).nextCheckAt!)).toBeGreaterThan(w.now());
      }
      expect((await w.timeline()).filter((e) => e.kind === 'recovery')).toHaveLength(3);
    });

    it('never runs a second CI step when the first was folded into another job', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      const launch = vi.fn(async () => ({ status: 200, disposition: 'coalesced', coveredBy: 'job_holder000000001' }));
      const r = w.reconcilerFor({ recovery: { launch, retry: w.retry } });
      expect(await r()).toMatchObject({ recovered: 1 });
      expect(await w.wf()).toMatchObject({ recovery: { result: 'coalesced', startedJobId: 'job_holder000000001' } });
      // The covering job's start never reached the workflow; a later look finds the head still waiting.
      w.tick(recoveryBackoff(1));
      expect(await r()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(await w.wf()).toMatchObject({ reason: 'ci_event_missed', message: expect.stringMatching(/already ran the missed CI step once for this head \(job job_holder000000001/) });
    });

    it('tries again under ids of its own after a launch that never got a microVM (launch_failed)', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      await w.reconcile();
      // Reconciliation reclaimed the launch before RunMicrovm: its job ended launch_failed, nothing ran
      // (no start, no microVM, never marked launching).
      await w.finish(ciJobId(), 'launch_failed');
      const { microvmId: _m, launchingAt: _l, startedAt: _s, ...reclaimed } = (await w.store.getJob(ciJobId()))!;
      await w.store.putJob(reclaimed);
      await w.store.finishJob(ciJobId(), 'launch_failed', { at: w.now() });
      await w.rewind({ status: 'waiting', stage: 'waiting-for-ci', reason: 'recovering', lastJobId: (await w.wf()).jobRuns![0]!.jobId });
      expect(await w.reconcile()).toMatchObject({ recovered: 1, blocked: 0 });
      const second = recoveryIds(55, WF, missedCheckKey({ generation: 1 }, HEAD), 1).jobId;
      expect(await w.store.getJob(second)).toMatchObject({ eventName: 'check_suite' });
      expect(w.runs).toHaveLength(3);
    });

    it('never launches again after a launch_failed that may have reached RunMicrovm', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      await w.reconcile();
      // RunMicrovm's answer was lost: the launcher recorded launch_failed, but the job had started.
      await w.finish(ciJobId(), 'launch_failed');
      const job = (await w.store.getJob(ciJobId()))!;
      await w.store.putJob({ ...job, startedAt: w.now() });
      await w.rewind({ status: 'waiting', stage: 'waiting-for-ci', reason: 'recovering', lastJobId: (await w.wf()).jobRuns![0]!.jobId });
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(w.runs).toHaveLength(2);
      expect(await w.store.getJob(recoveryIds(55, WF, missedCheckKey({ generation: 1 }, HEAD), 1).jobId)).toBeNull();
      expect(await w.wf()).toMatchObject({ reason: 'ci_event_missed', message: expect.stringMatching(/already ran the missed CI step once/) });
    });

    it('waits on a try handed to a queued event while it waits, and says so truthfully once it ended unstarted', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      const holder = 'job_queued00000001';
      const launch = vi.fn(async () => ({ status: 200, disposition: 'queue_joined', jobId: holder }));
      const r = w.reconcilerFor({ recovery: { launch, retry: w.retry, queue: w.queueStore } });
      const entry = { jobId: holder, installationId: 55, repository: 'acme/web', repositoryId: 99, pullRequest: 12, deliveryId: 'd-q', eventName: 'check_suite', eventKey: 'k', route: 'standard', configVersion: 1, reason: 'concurrent_jobs', state: 'queued', enqueuedAt: w.now(), expiresAt: w.now() + 3_600_000, attempts: 0, nextAttemptAt: w.now(), deliveries: 1, version: 0 } as const;
      await w.queueStore.enqueue({ ...entry }, 25);
      expect(await r()).toMatchObject({ recovered: 1 });
      // Its record is waiting (a recorder write was lost, say): the workflow is due again.
      w.tick(recoveryBackoff(1));
      expect(await r()).toMatchObject({ recovered: 0, blocked: 0 });
      expect(Date.parse((await w.wf()).nextCheckAt!)).toBe(w.now() + CI_RECHECK_MS);
      // The entry ends without starting: blocked, saying exactly that.
      const cur = (await w.queueStore.get(55, holder))!;
      expect(await w.queueStore.settle({ ...cur, state: 'canceled', outcome: { at: w.now(), reason: 'stale_head', message: 'moved on' } }, cur)).toBeTruthy();
      w.tick(CI_RECHECK_MS);
      expect(await r()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(await w.wf()).toMatchObject({ reason: 'ci_event_missed', message: expect.stringMatching(/handed the missed CI step for this head to another queued event \(job job_queued00000001\), which did not start \(stale_head\)/) });
    });

    it('stays report-only without recovery configured', async () => {
      await w.waitForCi();
      w.tick(CI_FIRST_CHECK_MS);
      const plain = w.reconcilerFor({ recovery: undefined });
      expect(await plain()).toMatchObject({ blocked: 1, recovered: 0 });
      expect(w.runs).toHaveLength(1);
    });
  });

  describe('a lost worker', () => {
    let w: Awaited<ReturnType<typeof world>>;
    /** The issue's implementation job starts, and its microVM dies without reporting: the quota reconciliation finds it gone. */
    const lose = async () => {
      const first = await w.launch(w.label());
      expect(first).toMatchObject({ disposition: 'launched' });
      w.setMicrovm('TERMINATED');
      await w.quota();
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'job_lost' });
      w.setMicrovm('RUNNING');
      return first.jobId!;
    };
    beforeEach(async () => {
      w = await world();
    });

    it('retries an implementation that published nothing once, through the console retry\'s claim', async () => {
      const lost = await lose();
      w.tick(LOST_JOB_LOOK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 1 });
      expect(w.github.matchingBranches).toHaveBeenCalledWith('ghs_x', 'acme/web', issueBranchPrefix(7), 5);
      expect(w.github.createInstallationToken).toHaveBeenCalledWith(expect.any(String), 55, { repositoryIds: [99], permissions: { issues: 'read', contents: 'read', pull_requests: 'read' } });
      expect(w.runs).toHaveLength(2);
      const summary = (await w.store.getJobSummary(55, lost))!;
      expect(summary.retriedAs).toBeDefined();
      const child = (await w.store.getJob(summary.retriedAs!))!;
      expect(child).toMatchObject({ deliveryId: expect.stringMatching(/^retry-/), issue: 7 });
      // Not a new run: the same generation, now working again.
      expect(await w.wf()).toMatchObject({ status: 'active', generation: 1, lastJobId: child.jobId, recovery: { kind: 'lost_job', key: `lost:${lost}`, result: 'started', startedJobId: child.jobId } });
      // A console retry after it, and every later look, start nothing more.
      expect(await w.retry({ updraftRetry: { installationId: 55, jobId: lost, by: 'pat' } })).toMatchObject({ ok: false, code: 'already_retried' });
      w.tick(LOST_JOB_LOOK_MS);
      await w.reconcile();
      expect(w.runs).toHaveLength(2);
    });

    it('starts one retry when two reconcilers and a console retry race for it', async () => {
      const lost = await lose();
      w.tick(LOST_JOB_LOOK_MS);
      const results = await Promise.all([w.reconcile(), w.reconcilerFor()(), w.retry({ updraftRetry: { installationId: 55, jobId: lost, by: 'pat' } })]);
      expect(w.runs).toHaveLength(2);
      expect(results).toBeDefined();
    });

    it('never retries a lost run that may have published: an Updraft branch of the issue exists', async () => {
      await lose();
      w.gh.branches = [`${issueBranchPrefix(7)}job_evx`, 'updraft/issue-70-job_other'];
      w.tick(LOST_JOB_LOOK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(w.runs).toHaveLength(1);
      const wf = await w.wf();
      expect(wf).toMatchObject({ status: 'blocked', reason: 'publication_uncertain', message: expect.stringContaining('updraft/issue-7-job_evx') });
      // A person has to decide: asked once on GitHub, without changing what recovery decided.
      expect(w.notices).toEqual([{ workflowId: wf.workflowId, generation: wf.generation, reason: 'publication_uncertain' }]);
      expect(wf.message).not.toContain('issue-70');
      expect(wf.nextCheckAt).toBeUndefined();
    });

    it('never retries a stopped job, a paused workflow, nor one whose issue was closed or label removed', async () => {
      const lost = await lose();
      // A stop recorded on the lost job itself: never retried, whatever else holds.
      const job = (await w.store.getJob(lost))!;
      await w.store.putJob({ ...job, stop: { requestedAt: w.now(), by: 'pat', reason: 'no' } });
      w.tick(LOST_JOB_LOOK_MS);
      await w.reconcile();
      expect(w.runs).toHaveLength(1);
      expect((await w.wf()).nextCheckAt).toBeUndefined();

      // Another job's stop paused the workflow: reported, nothing retried.
      w = await world();
      await lose();
      await w.stop();
      w.tick(LOST_JOB_LOOK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(w.runs).toHaveLength(1);
      expect(await w.wf()).toMatchObject({ reason: 'workflow_paused' });

      for (const change of ['closed', 'unlabeled'] as const) {
        const x = await world();
        w = x;
        await lose();
        x.gh.issue = change === 'closed' ? { open: false, labels: ['updraft'] } : { open: true, labels: [] };
        x.tick(LOST_JOB_LOOK_MS);
        expect(await x.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
        expect(x.runs).toHaveLength(1);
        expect(await x.wf()).toMatchObject({ status: 'blocked', reason: 'job_lost', message: expect.stringMatching(change === 'closed' ? /has been closed/ : /label has been removed/) });
      }
    });

    it('does not carry a lost job\'s retry on after a pause is resumed', async () => {
      await lose();
      // A pause of the workflow by another of its jobs, while the lost job waits for its look.
      w.tick(LOST_JOB_LOOK_MS);
      const pause = { jobId: 'job_other0000001', at: w.now(), by: 'pat' };
      const controls = { getWorkflowPause: vi.fn(async () => pause as never) };
      const r = w.reconcilerFor({ controls });
      await r();
      expect(await w.wf()).toMatchObject({ reason: 'workflow_paused' });
      // Resumed: the workflow says what it said, without the automatic retry.
      controls.getWorkflowPause.mockResolvedValue(null as never);
      w.tick(CI_FIRST_CHECK_MS);
      await r();
      w.tick(CI_FIRST_CHECK_MS);
      await r();
      expect(w.runs).toHaveLength(1);
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'job_lost', nextAction: expect.stringMatching(/Retry the job from its page/) });
    });

    it('bounds a chain of lost retries by the run\'s budget', async () => {
      await lose();
      for (let i = 0; i < MAX_RECOVERIES_PER_RUN; i++) {
        w.tick(LOST_JOB_LOOK_MS);
        expect(await w.reconcile()).toMatchObject({ recovered: 1 });
        // The retry's microVM dies as well.
        w.setMicrovm('TERMINATED');
        await w.quota();
        w.setMicrovm('RUNNING');
      }
      w.tick(LOST_JOB_LOOK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'recovery_exhausted' });
      expect(w.notices.map((n) => n.reason)).toEqual(['recovery_exhausted']);
      expect(w.runs).toHaveLength(1 + MAX_RECOVERIES_PER_RUN);
    });

    it('waits out a GitHub failure without acting, and fails the look so the alarm sees it', async () => {
      await lose();
      w.tick(LOST_JOB_LOOK_MS);
      w.github.matchingBranches.mockRejectedValueOnce(new GitHubError(502, 'bad gateway'));
      expect(await w.reconcile()).toMatchObject({ failed: 1, recovered: 0 });
      expect(w.runs).toHaveLength(1);
      // Backed off, not due again at every run: the next run does not look at it.
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'job_lost', nextCheckAt: new Date(w.now() + CI_RECHECK_MS).toISOString() });
      expect(await w.reconcile()).toMatchObject({ checked: 0, failed: 0 });
      w.tick(CI_RECHECK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 1 });
    });

    it('never retries a lost run with a pull request since it started, merged or closed and its branch deleted, or one it could not list', async () => {
      await lose();
      w.gh.pulls = { numbers: [31], complete: true };
      w.tick(LOST_JOB_LOOK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(await w.wf()).toMatchObject({ reason: 'publication_uncertain', message: expect.stringContaining('pull request #31') });
      expect(w.github.pullRequestsByHeadPrefix).toHaveBeenCalledWith('ghs_x', 'acme/web', issueBranchPrefix(7), expect.any(String));

      w = await world();
      await lose();
      w.gh.pulls = { numbers: [], complete: false };
      w.tick(LOST_JOB_LOOK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(await w.wf()).toMatchObject({ reason: 'publication_uncertain', message: expect.stringMatching(/could not all be read/) });
      expect(w.runs).toHaveLength(1);
    });

    it('does not retry after a stop that was resumed between two looks', async () => {
      const lost = await lose();
      // Another job of the run is stopped (a pause), and resumed before the reconciler looks.
      const other = { ...(await w.store.getJob(lost))!, jobId: 'job_stopped0000099', status: 'launched' as const, stop: undefined, releasedAt: undefined, outcome: undefined };
      await w.store.putJob(other);
      w.tick(60_000);
      await w.store.requestJobStop(other, { requestedAt: w.now(), by: 'pat', reason: 'hold' }, [7]);
      await w.store.resumeWorkflowPause(55, 99, { jobId: other.jobId, at: w.now() }, [7], 'pat', w.now());
      expect(await w.store.getWorkflowPause(55, 99, 7)).toBeNull();
      await updateWorkflow(w.workflowStore, 55, WF, (cur) => ({ workflow: { ...cur!, jobRuns: [...cur!.jobRuns!, { jobId: other.jobId, generation: 1 }] } }));
      w.tick(LOST_JOB_LOOK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(w.runs).toHaveLength(1);
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'job_lost', message: expect.stringMatching(/stopped \(job job_stopped0000099\) since/) });
    });

    it('never retries a review-loop job, and says how the loop continues', async () => {
      await w.waitForCi();
      const payload = { action: 'completed', check_suite: { head_sha: HEAD, head_branch: BRANCH, pull_requests: [{ number: 12, head: { ref: BRANCH } }] }, repository: { id: 99, full_name: 'acme/web' } };
      expect(await w.launch({ installationId: 55, deliveryId: 'real-check', eventName: 'check_suite', body: JSON.stringify(payload), payload })).toMatchObject({ disposition: 'launched' });
      w.setMicrovm('TERMINATED');
      await w.quota();
      w.tick(LOST_JOB_LOOK_MS);
      expect(await w.reconcile()).toMatchObject({ recovered: 0, blocked: 1 });
      expect(w.runs).toHaveLength(2);
      expect(await w.wf()).toMatchObject({ status: 'blocked', reason: 'job_lost', nextAction: expect.stringMatching(/Push to the pull request/) });
    });

    it('waits for a lost job without a terminated microVM to be unable to act before retrying it', async () => {
      const first = await w.launch(w.label());
      const job = (await w.store.getJob(first.jobId!))!;
      // As the quota reconciliation does past a job's lifetime with no microVM on record.
      await w.store.finishJob(job.jobId, 'microvm_gone', { at: w.now() });
      await w.store.releaseJob(job);
      await w.recorder.finished({ ...job, microvmId: undefined } as never, 'microvm_gone');
      const noVm = { ...w.store, getJob: async (id: string) => { const j = await w.store.getJob(id); return j && id === job.jobId ? { ...j, microvmId: undefined } : j; } };
      const r = w.reconcilerFor({ jobs: noVm });
      w.tick(LOST_JOB_LOOK_MS);
      expect(await r()).toMatchObject({ recovered: 0 });
      expect(await w.wf()).toMatchObject({ nextCheckAt: new Date(job.expiresAt + LOST_TOKEN_GRACE_MS).toISOString() });
      expect(w.runs).toHaveLength(1);
      w.tick(job.expiresAt + LOST_TOKEN_GRACE_MS - w.now());
      expect(await r()).toMatchObject({ recovered: 1 });
      expect(w.runs).toHaveLength(2);
    });
  });
});
