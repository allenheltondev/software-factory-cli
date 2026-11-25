import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore, type Tenant } from '../store/store.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createWorkflowRecorder } from '../workflows/recorder.js';
import { createMemoryWorkflowStore } from '../workflows/store.js';
import { deliveryFromLaunch } from './deliveries.js';
import { createLauncher, pullRequestLease, type LaunchDeps, type LaunchRequest, type RunMicrovmInput, type ThrottleNotice } from './launch.js';
import { ADMIT_LEASE_MS, createAdmissionQueue, createGitHubRevalidator, createQueueDispatcher, dispatchMetricsLine, isQueueCancelRequest, MAX_ADMIT_ATTEMPTS, QUEUE_EXPIRY_MS, queueComment, queueCommentMarker, type QueueNotifier, type Revalidate } from './queue.js';
import { createMemoryQueueStore, type QueueEntry } from './queue-store.js';
import { jobResult } from './status.js';
import { GitHubError } from '../github/client.js';

const NOW = Date.now();
const SETTINGS: LaunchDeps['settings'] = {
  region: 'us-east-1',
  bucket: 'tenant-bucket',
  imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:updraft-cloud-job',
  executionRoleArn: 'arn:aws:iam::123456789012:role/exec',
  ingressConnectorArn: 'arn:in',
  egressConnectorArn: 'arn:out',
  logGroup: '/aws/lambda-microvms/updraft-cloud-job',
  brokerFunctionName: 'updraft-cloud-broker',
  maximumDurationSeconds: 10800,
  watchdogReserveSeconds: 600,
};
const ONE_AT_A_TIME = { concurrentJobs: 1, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 };
const tenant = (installationId: number): Tenant => ({ installationId, accountId: installationId, accountLogin: `acct${installationId}`, accountType: 'Organization', status: 'active', createdAt: '2026-11-19T00:00:00.000Z', createdBy: 's' });
const rules = (repo: string, id: number, loop = false) => dispatchRules({
  dispatch: { allowedActors: ['pat'] },
  repositories: { [repo]: { id, ...(loop ? { review: true, revise: true, ciFix: true } : {}), workflows: [{ trigger: { label: 'updraft' } }] } },
}, { keysFor: () => [] });

type Comment = { jobId: string; id: number; body: string; edits: number };

describe('the admission queue', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let queue: ReturnType<typeof createMemoryQueueStore>;
  let workflowStore: ReturnType<typeof createMemoryWorkflowStore>;
  let events: Record<string, string>;
  let runs: RunMicrovmInput[];
  let comments: Comment[];
  let clock: number;
  let revalidate: Revalidate;
  let notices: ThrottleNotice[];
  let quotas: LaunchDeps['quotas'];

  const notify: QueueNotifier = {
    async post(e, body, marker) {
      const found = comments.find((c) => c.body.includes(marker));
      if (found) return found.id;
      const c = { jobId: e.jobId, id: comments.length + 1, body, edits: 0 };
      comments.push(c);
      return c.id;
    },
    async update(_e, id, body) {
      const c = comments.find((x) => x.id === id)!;
      c.body = body;
      c.edits++;
    },
  };

  const setup = async (installationId: number, repo = 'acme/web', repoId = 9, loop = false) => {
    await store.putTenantWithMember(tenant(installationId), { installationId, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    const v = await store.createConfigVersion(installationId, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: rules(repo, repoId, loop) });
    await store.markConfigReady(installationId, v as number);
    await store.activateConfig(installationId, v as number);
  };

  const request = (issue: number, deliveryId: string, o: { installationId?: number; repo?: string; repoId?: number; label?: string } = {}): LaunchRequest => {
    const payload = { action: 'labeled', issue: { number: issue }, label: { name: o.label ?? 'updraft' }, sender: { login: 'pat' }, repository: { id: o.repoId ?? 9, full_name: o.repo ?? 'acme/web' } };
    return { installationId: o.installationId ?? 55, deliveryId, body: JSON.stringify(payload), payload };
  };

  const deps = (over: Partial<LaunchDeps> = {}): LaunchDeps => {
    const workflows = createWorkflowRecorder({ store: workflowStore, now: () => clock, log: () => {} });
    return {
      store,
      settings: SETTINGS,
      imageVersion: async () => '3',
      putEvent: async (key, body) => void (events[key] = body),
      runMicrovm: async (input) => {
        runs.push(input);
        return { microvmId: `mvm-${runs.length}` };
      },
      quotas,
      now: () => clock,
      log: () => {},
      retryDelayMs: 1,
      coalesceConfirmMs: 5,
      coalescePollMs: 1,
      workflows,
      notifyThrottled: async (n) => void notices.push(n),
      queue: createAdmissionQueue({ store: queue, putEvent: async (key, body) => void (events[key] = body), notify, workflows, consoleOrigin: 'https://updraft.example.com', now: () => clock, log: () => {} }),
      ...over,
    };
  };

  const dispatcherFor = (launch: ReturnType<typeof createLauncher>, over: Partial<Parameters<typeof createQueueDispatcher>[0]> = {}) =>
    createQueueDispatcher({
      queue,
      jobs: store,
      launch,
      readEvent: async (key) => events[key] ?? null,
      revalidate: (e) => revalidate(e),
      notify,
      workflows: createWorkflowRecorder({ store: workflowStore, now: () => clock, log: () => {} }),
      consoleOrigin: 'https://updraft.example.com',
      now: () => clock,
      log: () => {},
      ...over,
    });

  /** The running job of the tenant ends: its microVM is gone, and its slots come back. */
  const finish = async (jobId: string) => {
    const job = (await store.getJob(jobId))!;
    await store.finishJob(jobId, 'succeeded', { at: clock });
    await store.releaseJob(job);
  };

  beforeEach(async () => {
    store = createMemoryStore();
    queue = createMemoryQueueStore();
    workflowStore = createMemoryWorkflowStore();
    events = {};
    runs = [];
    comments = [];
    notices = [];
    clock = NOW;
    quotas = ONE_AT_A_TIME;
    revalidate = async () => ({ ok: true });
    await setup(55);
  });

  it('queues B and C while A runs, acknowledges them truthfully, and starts each once, in order, as capacity frees', async () => {
    const launch = createLauncher(deps());
    const dispatcher = dispatcherFor(launch);
    const a = await launch(request(1, 'delivery-a'));
    expect(a).toMatchObject({ status: 202, disposition: 'launched' });

    const b = await launch(request(2, 'delivery-b'));
    expect(b).toMatchObject({ status: 202, disposition: 'queued', reason: 'concurrent_jobs' });
    clock += 1000;
    const c = await launch(request(3, 'delivery-c'));
    // C finds B waiting: FIFO, it waits behind it.
    expect(c).toMatchObject({ status: 202, disposition: 'queued', reason: 'queue_ahead' });
    expect(runs).toHaveLength(1);
    // Nothing is counted while queued: the day's jobs are A's only, and only A holds a slot.
    expect((await store.getUsage(55, new Date(NOW).toISOString().slice(0, 10), new Date(NOW).toISOString().slice(0, 7))).jobsToday).toBe(1);
    expect(notices).toEqual([]);
    // The delivery records say queued, with the job each starts as.
    expect(deliveryFromLaunch({ at: '', deliveryId: 'delivery-b', event: 'issues' }, b)).toMatchObject({ disposition: 'queued', reason: 'concurrent_jobs', jobId: b.jobId });

    // One acknowledgement each: no relabel instruction, no agent, a real link, the waiting status.
    expect(comments.map((x) => x.jobId)).toEqual([b.jobId, c.jobId]);
    const ack = comments[0]!.body;
    expect(ack).toContain('Updraft queued this issue. Your account\'s current execution slot is occupied. Work will start automatically when capacity is available. No action is needed.');
    expect(ack).toContain('**Status:** Queued · Waiting for capacity');
    expect(ack).toContain(`[View in Updraft](https://updraft.example.com/installations/55/jobs/${b.jobId})`);
    expect(ack).not.toMatch(/remove the label|add it again|assigned/i);

    // While A runs, a dispatch admits nothing, and does not try C behind B.
    const launches = vi.fn(launch);
    const busy = dispatcherFor(launches);
    expect(await busy.dispatch()).toMatchObject({ admitted: 0, tenantsAtCapacity: 1, waiting: 2 });
    expect(launches).toHaveBeenCalledTimes(1);
    expect((await queue.get(55, b.jobId!))?.state).toBe('queued');

    // A ends: B starts, under its queued id; C still waits (one slot).
    await finish(a.jobId!);
    clock += 60_000;
    expect(await dispatcher.dispatch()).toMatchObject({ admitted: 1, waiting: 1 });
    expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, b.jobId]);
    expect((await store.getJob(b.jobId!))?.status).toBe('launched');
    expect(comments[0]!.body).toContain('**Status:** Started · queued for 1 minute');
    expect(comments[0]!.edits).toBe(1);

    // A dispatch again (a duplicate wakeup) changes nothing.
    expect(await dispatcher.dispatch()).toMatchObject({ admitted: 0, waiting: 1 });
    expect(runs).toHaveLength(2);

    await finish(b.jobId!);
    await dispatcher.dispatch();
    expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, b.jobId, c.jobId]);
    expect(await queue.listWaiting(10)).toEqual([]);
    expect(await queue.depth(55)).toBe(0);
    // Each ran once, and never two at a time: each admission found the slot of the one before free.
    expect(new Set(runs.map((r) => r.clientToken)).size).toBe(3);
  });

  it('records the wait on the workflow, then the start under the same job', async () => {
    const launch = createLauncher(deps());
    await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    const waiting = await workflowStore.getWorkflow(55, '9-i2');
    expect(waiting).toMatchObject({ status: 'waiting', stage: 'queued', reason: 'capacity_wait', lastJobId: b.jobId });
    await finish((await store.listRecentJobs(55, 5))[0]!.jobId);
    await dispatcherFor(launch).dispatch();
    expect(await workflowStore.getWorkflow(55, '9-i2')).toMatchObject({ status: 'active', stage: 'implementing', lastJobId: b.jobId, generation: 1 });
    const kinds = (await workflowStore.listWorkflowEvents(55, '9-i2', 10)).map((e) => e.kind);
    expect(kinds).toEqual(['waiting', 'job_started']);
  });

  it('folds redeliveries and relabels of queued work into it: no second entry, no second comment', async () => {
    const launch = createLauncher(deps());
    await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    expect(await launch(request(2, 'delivery-b'))).toMatchObject({ status: 200, disposition: 'queue_joined', jobId: b.jobId });
    expect(await launch(request(2, 'relabel-b'))).toMatchObject({ status: 200, disposition: 'queue_joined', jobId: b.jobId });
    expect(deliveryFromLaunch({ at: '', deliveryId: 'relabel-b', event: 'issues' }, { status: 200, disposition: 'queue_joined', jobId: b.jobId! })).toMatchObject({ disposition: 'deduped', reason: 'already_queued' });
    expect(await queue.depth(55)).toBe(1);
    expect(comments).toHaveLength(1);
    expect((await queue.get(55, b.jobId!))?.deliveries).toBe(2);
  });

  it('dedupes concurrent duplicate deliveries of the same event', async () => {
    const launch = createLauncher(deps());
    await launch(request(1, 'delivery-a'));
    const [x, y] = await Promise.all([launch(request(2, 'delivery-b')), launch(request(2, 'delivery-b'))]);
    expect([x.disposition, y.disposition].sort()).toEqual(['duplicate', 'queued'].sort());
    expect(await queue.depth(55)).toBe(1);
    expect(comments).toHaveLength(1);
  });

  it('keeps FIFO when capacity frees just as a new delivery arrives: the new one waits behind the queued one', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    await finish(a.jobId!);
    clock += 1000;
    // The slot is free, but B waits: D goes behind it, rather than taking the slot first.
    const d = await launch(request(4, 'delivery-d'));
    expect(d).toMatchObject({ disposition: 'queued', reason: 'queue_ahead' });
    expect(comments.find((x) => x.jobId === d.jobId)?.body).toContain('Earlier queued work for your account starts first.');
    await dispatcherFor(launch).dispatch();
    expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, b.jobId]);
  });

  it('cancels queued work whose label was removed or whose issue was closed, on the event or at admission', async () => {
    const launch = createLauncher(deps());
    const dispatcher = dispatcherFor(launch);
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    const c = await launch(request(3, 'delivery-c'));

    // The unlabeled webhook: B ends now, with its comment edited in place.
    expect(await dispatcher.subjectChanged(55, 9, { issue: 2 }, { kind: 'unlabeled', label: 'other' })).toBe(false);
    expect(await dispatcher.subjectChanged(55, 9, { issue: 2 }, { kind: 'unlabeled', label: 'UPDRAFT' })).toBe(true);
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'canceled', outcome: { reason: 'label_removed' } });
    expect(comments[0]!.body).toContain('**Status:** Canceled · label_removed');
    expect(await workflowStore.getWorkflow(55, '9-i2')).toMatchObject({ status: 'blocked', reason: 'queue_canceled' });

    // C's issue closed without the event reaching Updraft: admission finds it.
    revalidate = async (e) => (e.issue === 3 ? { ok: false, reason: 'issue_closed', message: 'the issue was closed while the job was queued.' } : { ok: true });
    await finish(a.jobId!);
    expect(await dispatcher.dispatch()).toMatchObject({ admitted: 0, ended: 1 });
    expect(await queue.get(55, c.jobId!)).toMatchObject({ state: 'canceled', outcome: { reason: 'issue_closed' } });
    expect(runs).toHaveLength(1);
    // A relabel afterwards queues (or runs) anew: the ended entry holds nothing.
    expect(await launch(request(2, 'relabel-b2'))).toMatchObject({ disposition: 'launched' });
  });

  it('never launches twice after a lost launch answer: the job record decides', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    await finish(a.jobId!);
    // The dispatcher's launch got as far as the job (RunMicrovm accepted), then its answer was lost.
    const ambiguous = vi.fn(async (req: LaunchRequest) => {
      await launch(req);
      throw new Error('socket hang up');
    });
    expect(await dispatcherFor(ambiguous).dispatch()).toMatchObject({ admitted: 1 });
    expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, b.jobId]);
    expect((await queue.get(55, b.jobId!))?.state).toBe('admitted');
  });

  it('recovers a dispatcher that died holding an entry: held until its lease runs out, then admitted once', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    await finish(a.jobId!);
    // A dispatcher took B and died before launching.
    const e = (await queue.get(55, b.jobId!))!;
    expect(await queue.update({ ...e, state: 'admitting', admittingUntil: clock + ADMIT_LEASE_MS, attempts: 1 }, e)).toBe(true);
    const dispatcher = dispatcherFor(launch);
    expect(await dispatcher.dispatch()).toMatchObject({ admitted: 0, deferred: 1 });
    expect(runs).toHaveLength(1);
    clock += ADMIT_LEASE_MS + 1;
    expect(await dispatcher.dispatch()).toMatchObject({ admitted: 1 });
    expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, b.jobId]);
  });

  it('a lost wakeup costs only time: the scheduled run admits what the release did not', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    // The slot is released and no wakeup arrives; minutes later, the schedule runs.
    await finish(a.jobId!);
    clock += 5 * 60_000;
    expect(await dispatcherFor(launch).dispatch()).toMatchObject({ admitted: 1, waiting: 0 });
    expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, b.jobId]);
  });

  it('backs off after a failed admission, and refuses once attempts run out', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    await finish(a.jobId!);
    revalidate = async () => { throw new GitHubError(502, 'bad gateway'); };
    const dispatcher = dispatcherFor(launch);
    expect(await dispatcher.dispatch()).toMatchObject({ deferred: 1 });
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'queued', reason: 'retrying', attempts: 1 });
    // Not again before its backoff.
    expect(await dispatcher.dispatch()).toMatchObject({ deferred: 1 });
    expect((await queue.get(55, b.jobId!))?.attempts).toBe(1);
    for (let i = 0; i < MAX_ADMIT_ATTEMPTS + 1; i++) {
      clock += 60 * 60_000;
      await dispatcher.dispatch();
    }
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'refused', outcome: { reason: 'admission_failed' } });
    expect(runs).toHaveLength(1);
  });

  it('expires work that waited too long, and says so on GitHub', async () => {
    const launch = createLauncher(deps());
    await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    clock += QUEUE_EXPIRY_MS + 1;
    expect(await dispatcherFor(launch).dispatch()).toMatchObject({ ended: 1 });
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'expired' });
    expect(comments[0]!.body).toContain('**Status:** Expired · queue_expired');
    expect(comments[0]!.body).toContain('Apply the label again');
  });

  it('refuses at admission what a budget or the routing no longer allows, without waiting out a reset', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    await finish(a.jobId!);
    await store.setTenantLimits(55, { jobsPerDay: 1 });
    expect(await dispatcherFor(launch).dispatch()).toMatchObject({ ended: 1 });
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'refused', outcome: { reason: 'jobs_per_day' } });
    expect(comments[0]!.body).toContain('Not started · jobs_per_day');
    // The over-quota comment is not posted for queued work: its acknowledgement says why.
    expect(notices).toEqual([]);
  });

  it('admits queued subscription work on a replacement session of the same worker (a new generation is not a new route)', async () => {
    const native = (generation: string): NonNullable<LaunchDeps['native']> => ({
      route: { installationId: 55, repositoryId: 9, repository: 'acme/web', labels: ['updraft'], workerId: 'worker-1', microvmId: `mvm-${generation}`, imageVersion: '7', generation,
        controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/test-abcdef' },
      secret: async () => 'worker-control-credential-01234567890123456789',
      enabled: async () => true,
    });
    const first = createLauncher(deps({ native: native('g1') }));
    const a = await first(request(1, 'delivery-a'));
    expect(a.disposition).toBe('launched');
    const b = await first(request(2, 'delivery-b'));
    expect(b).toMatchObject({ disposition: 'queued' });
    expect((await queue.get(55, b.jobId!))?.route).toBe('worker-1');
    await finish(a.jobId!);
    // The session was replaced meanwhile (a compatible image rollout, #155): same worker, new generation.
    await dispatcherFor(createLauncher(deps({ native: native('g2') }))).dispatch();
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'admitted' });
    expect((await store.getJob(b.jobId!))?.native).toMatchObject({ workerId: 'worker-1', generation: 'g2' });
  });

  it('refuses queued work whose execution route changed, never rerouting it', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    await finish(a.jobId!);
    const e = (await queue.get(55, b.jobId!))!;
    expect(e.route).toBe('standard');
    await queue.update({ ...e, route: 'worker-1' }, e);
    await dispatcherFor(launch).dispatch();
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'refused', outcome: { reason: 'route_changed' } });
    expect(runs).toHaveLength(1);
  });

  it('cancels queued work of a workflow an owner stopped', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    await store.requestJobStop((await store.getJob(a.jobId!))!, { requestedAt: clock, by: 'pat', reason: 'stop' }, [2]);
    await finish(a.jobId!);
    await dispatcherFor(launch).dispatch();
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'canceled', outcome: { reason: 'workflow_paused' } });
    expect(runs).toHaveLength(1);
  });

  it('lets an owner cancel waiting work, but not work being admitted', async () => {
    const launch = createLauncher(deps());
    await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    const c = await launch(request(3, 'delivery-c'));
    const dispatcher = dispatcherFor(launch);
    expect(await dispatcher.cancel(55, b.jobId!, 'pat')).toEqual({ ok: true, state: 'canceled' });
    expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'canceled', outcome: { reason: 'canceled_by_owner', by: 'pat' } });
    expect(await dispatcher.cancel(55, b.jobId!, 'pat')).toMatchObject({ ok: false, code: 'not_queued' });
    // Another tenant's id is never found.
    expect(await dispatcher.cancel(66, c.jobId!, 'pat')).toMatchObject({ ok: false, code: 'not_found' });
    const e = (await queue.get(55, c.jobId!))!;
    await queue.update({ ...e, state: 'admitting', admittingUntil: clock + ADMIT_LEASE_MS }, e);
    expect(await dispatcher.cancel(55, c.jobId!, 'pat')).toMatchObject({ ok: false, code: 'admitting' });
    expect(isQueueCancelRequest({ updraftQueue: { action: 'cancel', installationId: 55, jobId: c.jobId, by: 'pat' } })).toBe(true);
    expect(isQueueCancelRequest({ updraftQueue: { action: 'cancel', installationId: 55, jobId: '../x', by: 'pat' } })).toBe(false);
  });

  it('bounds the queue per tenant: past the bound, the delivery is throttled with its own comment', async () => {
    const launch = createLauncher(deps({ queue: createAdmissionQueue({ store: queue, putEvent: async () => {}, maxPerTenant: 2, now: () => clock, log: () => {} }) }));
    await launch(request(1, 'delivery-a'));
    expect((await launch(request(2, 'd2'))).disposition).toBe('queued');
    expect((await launch(request(3, 'd3'))).disposition).toBe('queued');
    expect(await launch(request(4, 'd4'))).toMatchObject({ disposition: 'throttled', reason: 'queue_full' });
    expect(notices.map((n) => n.limit)).toEqual(['queue_full']);
  });

  it('is fair across tenants: a full tenant never holds up another, and a long line never starves one', async () => {
    await setup(66, 'beta/app', 19);
    quotas = { ...ONE_AT_A_TIME, platformConcurrentJobs: 10 };
    const launch = createLauncher(deps());
    const x1 = await launch(request(1, 'x1'));
    const x = [];
    // Tenant X queues a long line first; Y's one entry comes after all of it.
    for (let n = 2; n <= 5; n++) {
      clock += 1000;
      x.push(await launch(request(n, `x${n}`)));
    }
    const y1 = await launch(request(1, 'y1', { installationId: 66, repo: 'beta/app', repoId: 19 }));
    clock += 1000;
    const y2 = await launch(request(2, 'y2', { installationId: 66, repo: 'beta/app', repoId: 19 }));
    expect([...x.map((r) => r.disposition), y1.disposition, y2.disposition]).toEqual(['queued', 'queued', 'queued', 'queued', 'launched', 'queued']);
    // While X is full, Y's queued work is not held up behind X's older line.
    await finish(y1.jobId!);
    expect(await dispatcherFor(launch).dispatch()).toMatchObject({ admitted: 1, waiting: 4, tenantsAtCapacity: 1 });
    expect(runs.map((r) => r.clientToken)).toEqual([x1.jobId, y1.jobId, y2.jobId]);
    // Both free: one per tenant per round; X's next starts, and Y (now empty) takes nothing from it.
    await finish(x1.jobId!);
    await finish(y2.jobId!);
    expect(await dispatcherFor(launch).dispatch()).toMatchObject({ admitted: 1, waiting: 3 });
    expect(runs.at(-1)?.clientToken).toBe(x[0]!.jobId);
  });

  it('treats the platform ceiling as a wait, and stops the run there', async () => {
    await setup(66, 'beta/app', 19);
    quotas = { ...ONE_AT_A_TIME, platformConcurrentJobs: 1 };
    const launch = createLauncher(deps());
    const x1 = await launch(request(1, 'x1'));
    const y1 = await launch(request(1, 'y1', { installationId: 66, repo: 'beta/app', repoId: 19 }));
    expect(y1).toMatchObject({ disposition: 'queued', reason: 'platform_concurrency' });
    expect(comments[0]!.body).toContain('Updraft Cloud is running as many jobs as it can right now.');
    expect(await dispatcherFor(launch).dispatch()).toMatchObject({ platformAtCapacity: true, admitted: 0 });
    await finish(x1.jobId!);
    expect(await dispatcherFor(launch).dispatch()).toMatchObject({ admitted: 1 });
    expect(runs.map((r) => r.clientToken)).toEqual([x1.jobId, y1.jobId]);
  });

  it('holds everything while the kill switch is on', async () => {
    const launch = createLauncher(deps());
    const a = await launch(request(1, 'delivery-a'));
    await launch(request(2, 'delivery-b'));
    await finish(a.jobId!);
    const dispatcher = dispatcherFor(launch, { killSwitch: { engaged: async () => true } });
    expect(await dispatcher.dispatch()).toMatchObject({ skipped: 'kill_switch', admitted: 0 });
    expect(runs).toHaveLength(1);
  });

  it('posts an acknowledgement that never got out, once, when the dispatcher next looks', async () => {
    let failing = true;
    const flaky: QueueNotifier = { post: async (e, b, m) => { if (failing) throw new Error('GitHub is down'); return notify.post(e, b, m); }, update: notify.update };
    const launch = createLauncher(deps({ queue: createAdmissionQueue({ store: queue, putEvent: async (k, b) => void (events[k] = b), notify: flaky, now: () => clock, log: () => {} }) }));
    await launch(request(1, 'delivery-a'));
    const b = await launch(request(2, 'delivery-b'));
    expect(b.disposition).toBe('queued');
    expect(comments).toHaveLength(0);
    failing = false;
    clock += 2 * 60_000;
    const dispatcher = dispatcherFor(launch, { notify: flaky });
    await dispatcher.dispatch();
    await dispatcher.dispatch();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(queueCommentMarker(b.jobId!));
  });

  it('writes the metrics line the alarms read', () => {
    const line = JSON.parse(dispatchMetricsLine({ scanned: 3, admitted: 1, ended: 0, deferred: 1, waiting: 2, oldestWaitSeconds: 90, tenantsAtCapacity: 1, platformAtCapacity: false, failed: 0 }, 'wake', NOW));
    expect(line).toMatchObject({ queueDispatch: 'wake', Waiting: 2, OldestWaitSeconds: 90, Admitted: 1, DispatchFailures: 0 });
    expect(line._aws.CloudWatchMetrics[0].Namespace).toBe('Updraft/Queue');
  });

  it('never shows queued work as running or throttled', () => {
    expect(jobResult({ status: 'launched' })).toBe('running');
    const e = { jobId: 'job_aaaaaaaaaaaaaaaa', installationId: 55, enqueuedAt: NOW, expiresAt: NOW + QUEUE_EXPIRY_MS, state: 'queued', reason: 'concurrent_jobs', issue: 2 } as QueueEntry;
    expect(queueComment(e)).toContain('`job_aaaaaaaaaaaaaaaa`');
    expect(queueComment(e)).not.toMatch(/throttl|running/i);
    // Handed to a subscription sign-in wait: never claimed as started.
    const handed = queueComment({ ...e, state: 'admitted', outcome: { at: NOW, reason: 'native_waiting_for_sign_in', message: 'Waiting' } });
    expect(handed).toContain('**Status:** Waiting for the Claude subscription');
    expect(handed).not.toContain('Started');
  });

  it('says at Started that routing has not chosen anything yet, and names no worker or model (#140)', () => {
    const e = { jobId: 'job_aaaaaaaaaaaaaaaa', installationId: 55, enqueuedAt: NOW, expiresAt: NOW + QUEUE_EXPIRY_MS, state: 'admitted', reason: 'concurrent_jobs', issue: 2, outcome: { at: NOW + 60_000, reason: 'admitted', message: 'Started.' } } as QueueEntry;
    const started = queueComment(e);
    expect(started).toContain('**Status:** Started · queued for 1 minute');
    expect(started).toContain('Complexity, capability tier, worker, model and effort are chosen when the job runs; the assignment comment that follows names them.');
    expect(started).not.toMatch(/\| (Worker|Model)|Assigned/);
    const pr = queueComment({ ...e, issue: undefined, pullRequest: 4 });
    expect(pr).toContain('the review or revision it posts names them.');
  });

  describe('waiting is not failing (review of #164)', () => {
    it('never spends admission attempts on capacity waits: a long wait, then one transient error, is retried, not refused', async () => {
      const launch = createLauncher(deps());
      const dispatcher = dispatcherFor(launch);
      const a = await launch(request(1, 'delivery-a'));
      const b = await launch(request(2, 'delivery-b'));
      for (let i = 0; i < MAX_ADMIT_ATTEMPTS + 2; i++) {
        clock += 60_000;
        await dispatcher.dispatch();
      }
      expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'queued', attempts: 0, reason: 'concurrent_jobs' });
      await finish(a.jobId!);
      let failOnce = true;
      revalidate = async () => {
        if (failOnce) { failOnce = false; throw new GitHubError(502, 'bad gateway'); }
        return { ok: true };
      };
      await dispatcher.dispatch();
      expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'queued', attempts: 1, reason: 'retrying' });
      clock += 60 * 60_000;
      await dispatcher.dispatch();
      expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'admitted' });
      expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, b.jobId]);
    });

    it('skips full tenants without a lease or a GitHub call, so a tenant with room behind many full ones starts within the budget', async () => {
      const full = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
      for (const id of full) await setup(id, `t${id}/app`, id);
      await setup(200, 'free/app', 200);
      quotas = { ...ONE_AT_A_TIME, platformConcurrentJobs: 20 };
      const launch = createLauncher(deps());
      for (const id of full) {
        expect((await launch(request(1, `run-${id}`, { installationId: id, repo: `t${id}/app`, repoId: id }))).disposition).toBe('launched');
        clock += 10;
        expect((await launch(request(2, `wait-${id}`, { installationId: id, repo: `t${id}/app`, repoId: id }))).disposition).toBe('queued');
      }
      // The free tenant's entry is queued last (a job of its own held its slot then, and has ended).
      const z1 = await launch(request(1, 'z1', { installationId: 200, repo: 'free/app', repoId: 200 }));
      clock += 10;
      const z2 = await launch(request(2, 'z2', { installationId: 200, repo: 'free/app', repoId: 200 }));
      expect(z2.disposition).toBe('queued');
      await finish(z1.jobId!);
      // Every GitHub check costs a second of the 6-second budget.
      const checked: number[] = [];
      revalidate = async (e) => { checked.push(e.installationId); clock += 1000; return { ok: true }; };
      const report = await dispatcherFor(launch, { capacity: { store, quotas } }).dispatch();
      expect(report).toMatchObject({ admitted: 1, tenantsAtCapacity: full.length });
      expect(checked).toEqual([200]);
      expect(runs.at(-1)?.clientToken).toBe(z2.jobId);
      for (const id of full) expect((await queue.list(id, 5)).find((x) => x.state === 'queued')).toMatchObject({ attempts: 0, version: 2 }); // enqueue, then its comment: never leased
    });

    it('releases the delivery claim once the entry is kept: a wake during the enqueue admits at once', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      let woke: Awaited<ReturnType<ReturnType<typeof createQueueDispatcher>['dispatch']>> | undefined;
      // The stream wakes a dispatcher while the enqueuing launch is still posting its acknowledgement,
      // and the slot frees at that moment.
      const racing: QueueNotifier = {
        ...notify,
        async post(e, body, marker) {
          const id = await notify.post(e, body, marker);
          if (!woke) {
            await finish(a.jobId!);
            woke = await dispatcherFor(launch).dispatch();
          }
          return id;
        },
      };
      const b = await createLauncher(deps({ queue: createAdmissionQueue({ store: queue, putEvent: async (k, v) => void (events[k] = v), notify: racing, now: () => clock, log: () => {} }) }))(request(2, 'delivery-b'));
      expect(b.disposition).toBe('queued');
      expect(woke).toMatchObject({ admitted: 1 });
      expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'admitted', attempts: 1 });
      expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, b.jobId]);
    });

    it('treats its own held delivery claim as a short wait, not a failed attempt', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      const b = await launch(request(2, 'delivery-b'));
      await finish(a.jobId!);
      // A launch for B that died after claiming its delivery, before recording the job.
      expect(await store.claimDelivery(55, 'delivery-b', Date.now() + 3 * 60 * 60_000, b.jobId!)).toBe(true);
      await dispatcherFor(launch).dispatch();
      const e = (await queue.get(55, b.jobId!))!;
      expect(e).toMatchObject({ state: 'queued', attempts: 0, reason: 'concurrent_jobs' });
      expect(e.nextAttemptAt - clock).toBeLessThanOrEqual(60_000);
      expect(comments[0]!.body).not.toContain('did not complete');
    });
  });

  describe('re-review of #164', () => {
    it('edits the acknowledgement to Started when the admission lands while its post is still in flight', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      let raced = false;
      const slow: QueueNotifier = {
        ...notify,
        find: async (_e, marker) => comments.find((x) => x.body.includes(marker))?.id,
        async post(e, body, marker) {
          if (!raced) {
            // The post is in flight: the slot frees, a woken dispatcher admits B, and its end
            // finds no comment yet. Then GitHub answers for the "Queued" one.
            raced = true;
            await finish(a.jobId!);
            await dispatcherFor(launch, { notify: slow }).dispatch();
          }
          return notify.post(e, body, marker);
        },
      };
      const b = await createLauncher(deps({ queue: createAdmissionQueue({ store: queue, putEvent: async (k, v) => void (events[k] = v), notify: slow, now: () => clock, log: () => {} }) }))(request(2, 'delivery-b'));
      expect(await queue.get(55, b.jobId!)).toMatchObject({ state: 'admitted', commentId: 1, commentState: 'admitted' });
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain('**Status:** Started');
    });

    it('never moves a started job back to queued when its start is recorded before its wait', async () => {
      const recorder = createWorkflowRecorder({ store: workflowStore, now: () => clock, log: () => {} });
      const ref = { jobId: 'job_queued00000001', installationId: 55, repository: 'acme/web', repositoryId: 9, issue: 2, eventName: 'issues', deliveryId: 'd-b' };
      await recorder.started(ref);
      await recorder.queued(ref, { reason: 'capacity_wait', message: 'Queued.' });
      expect(await workflowStore.getWorkflow(55, '9-i2')).toMatchObject({ status: 'active', stage: 'implementing', lastJobId: ref.jobId });
      expect((await workflowStore.listWorkflowEvents(55, '9-i2', 10)).map((e) => e.kind)).toEqual(['job_started']);
    });

    it('keeps a job parked for a Claude sign-in as the latest when work for the same workflow is queued', async () => {
      const recorder = createWorkflowRecorder({ store: workflowStore, now: () => clock, log: () => {} });
      const parked = { jobId: 'job_parked00000001', installationId: 55, repository: 'acme/web', repositoryId: 9, pullRequest: 40, eventName: 'pull_request_review', deliveryId: 'd-p' };
      await recorder.waiting(parked, { reason: 'sign_in_required', message: 'Sign in.', nextAction: 'Sign in.' });
      const q = { ...parked, jobId: 'job_queued00000002', eventName: 'check_suite', deliveryId: 'd-q' };
      await recorder.queued(q, { reason: 'capacity_wait', message: 'Queued.' });
      expect(await workflowStore.getWorkflow(55, '9-p40')).toMatchObject({ status: 'waiting', stage: 'awaiting-sign-in', lastJobId: parked.jobId, pendingJobId: q.jobId });
      await recorder.queueEnded(q, { reason: 'queue_canceled', message: 'stale.' });
      const w = (await workflowStore.getWorkflow(55, '9-p40'))!;
      expect(w).toMatchObject({ status: 'waiting', stage: 'awaiting-sign-in', lastJobId: parked.jobId });
      expect(w.pendingJobId).toBeUndefined();
    });

    it('backs a long wait for an offline subscription worker off to 15 minutes, spending no attempts', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      const b = await launch(request(2, 'delivery-b'));
      await finish(a.jobId!);
      const offline = vi.fn(async () => ({ status: 200, disposition: 'not_dispatched', reason: 'native_worker_unavailable', message: 'offline' }));
      const dispatcher = dispatcherFor(offline);
      const gaps: number[] = [];
      for (let i = 0; i < 8; i++) {
        await dispatcher.dispatch();
        const e = (await queue.get(55, b.jobId!))!;
        expect(e).toMatchObject({ state: 'queued', attempts: 0 });
        gaps.push(e.nextAttemptAt - clock);
        clock = e.nextAttemptAt;
      }
      expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
      expect(offline).toHaveBeenCalledTimes(8);
    });
  });

  describe('the acknowledgement follows the work (review of #164)', () => {
    it('keeps the comment id when another writer moved the entry on during the post, and edits it to Started', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      const busy: QueueNotifier = {
        ...notify,
        async post(e, body, marker) {
          const id = await notify.post(e, body, marker);
          // A dispatcher touched the entry meanwhile: its version is not the one the enqueue read.
          const cur = (await queue.get(e.installationId, e.jobId))!;
          await queue.update({ ...cur, deliveries: cur.deliveries + 1 }, cur);
          return id;
        },
      };
      const b = await createLauncher(deps({ queue: createAdmissionQueue({ store: queue, putEvent: async (k, v) => void (events[k] = v), notify: busy, now: () => clock, log: () => {} }) }))(request(2, 'delivery-b'));
      expect((await queue.get(55, b.jobId!))?.commentId).toBe(1);
      await finish(a.jobId!);
      await dispatcherFor(launch).dispatch();
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain('**Status:** Started');
    });

    it('finds and edits a posted acknowledgement whose id was never recorded, when the work starts or is canceled', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      const b = await launch(request(2, 'delivery-b'));
      const c = await launch(request(3, 'delivery-c'));
      for (const id of [b.jobId!, c.jobId!]) {
        const cur = (await queue.get(55, id))!;
        const { commentId: _c, ...rest } = cur;
        await queue.update(rest as QueueEntry, cur);
      }
      const finder: QueueNotifier = { ...notify, find: async (_e, marker) => comments.find((x) => x.body.includes(marker))?.id };
      const dispatcher = dispatcherFor(launch, { notify: finder });
      await finish(a.jobId!);
      revalidate = async (e) => (e.issue === 3 ? { ok: false, reason: 'label_removed', message: 'the label was removed.' } : { ok: true });
      await dispatcher.dispatch();
      expect(await dispatcher.cancel(55, c.jobId!, 'pat')).toMatchObject({ ok: false }); // already ended at admission
      expect(comments.map((x) => x.body.match(/\*\*Status:\*\* ([^\n]*)/)?.[1])).toEqual([expect.stringContaining('Started'), 'Canceled · label_removed']);
    });
  });

  describe('pull request events', () => {
    const prEvent = (deliveryId: string, eventName: string, over: Record<string, unknown> = {}): LaunchRequest => {
      const payload = {
        action: eventName === 'check_suite' ? 'completed' : eventName === 'pull_request' ? 'synchronize' : 'submitted',
        pull_request: { number: 40, head: { ref: 'updraft/issue-12-abc', sha: 'aaaaaaa1' } },
        review: { state: 'changes_requested' },
        sender: { login: 'pat' },
        repository: { id: 9, full_name: 'acme/web' },
        ...over,
      };
      return { installationId: 55, deliveryId, eventName, appBot: 'updraft[bot]', body: JSON.stringify(payload), payload };
    };
    beforeEach(async () => {
      const v = await store.createConfigVersion(55, { sha256: 'z', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: rules('acme/web', 9, true) });
      await store.markConfigReady(55, v as number);
      await store.activateConfig(55, v as number);
    });

    it('queues a review continuation while the account is busy, keeps only the newest event, and runs it once', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      const first = await launch(prEvent('pr-1', 'pull_request_review'));
      expect(first).toMatchObject({ disposition: 'queued' });
      expect(comments[0]!.body).toContain('Updraft queued the latest event on this pull request.');
      const push = await launch(prEvent('pr-2', 'pull_request', { pull_request: { number: 40, head: { ref: 'updraft/issue-12-abc', sha: 'bbbbbbb2' } } }));
      expect(push).toMatchObject({ disposition: 'queue_joined', jobId: first.jobId });
      expect(await queue.get(55, first.jobId!)).toMatchObject({ deliveryId: 'pr-2', eventName: 'pull_request', action: 'synchronize', headSha: 'bbbbbbb2', deliveries: 2 });
      expect(comments).toHaveLength(1);
      await finish(a.jobId!);
      await dispatcherFor(launch).dispatch();
      expect(runs.map((r) => r.clientToken)).toEqual([a.jobId, first.jobId]);
      expect(await store.getJob(first.jobId!)).toMatchObject({ eventName: 'pull_request', deliveryId: 'pr-2', pullRequest: 40 });
    });

    it("keeps the workflow on its running job when the same pull request's next event is queued behind it", async () => {
      const recorder = createWorkflowRecorder({ store: workflowStore, now: () => clock, log: () => {} });
      const launch = createLauncher(deps());
      // A, a review job on pull request 40, runs; CI completes on its pull request meanwhile.
      const a = await launch(prEvent('pr-a', 'pull_request_review'));
      expect(a.disposition).toBe('launched');
      await store.releaseDelivery(55, pullRequestLease(9, 40), a.jobId!); // its 20-second coalescing lease is over
      const ci = await launch(prEvent('ci-1', 'check_suite', { check_suite: { head_sha: 'aaaaaaa1', head_branch: 'updraft/issue-12-abc', pull_requests: [{ number: 40 }] } }));
      expect(ci.disposition).toBe('queued');
      expect(await workflowStore.getWorkflow(55, '9-p40')).toMatchObject({ status: 'active', lastJobId: a.jobId, pendingJobId: ci.jobId });
      // A's finish decides the workflow; it is not history.
      const jobA = (await store.getJob(a.jobId!))!;
      await recorder.finished(jobA, 'succeeded');
      expect(await workflowStore.getWorkflow(55, '9-p40')).toMatchObject({ status: 'finished', stage: 'done', lastJobId: a.jobId });
      // The queued event's head is stale by admission: it ends, and the workflow stays as A left it.
      await finish(a.jobId!);
      revalidate = async () => ({ ok: false, reason: 'stale_head', message: 'the head moved on.' });
      await dispatcherFor(launch).dispatch();
      const w = (await workflowStore.getWorkflow(55, '9-p40'))!;
      expect(w).toMatchObject({ status: 'finished', stage: 'done', lastJobId: a.jobId });
      expect(w.pendingJobId).toBeUndefined();
    });

    it('moves the workflow on to the covering job when queued work is coalesced into it', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      const q = await launch(prEvent('pr-q', 'pull_request_review'));
      expect(q.disposition).toBe('queued');
      expect(await workflowStore.getWorkflow(55, '9-p40')).toMatchObject({ status: 'waiting', stage: 'queued', lastJobId: q.jobId });
      await finish(a.jobId!);
      const coalesced = async () => ({ status: 200, disposition: 'coalesced', coveredBy: 'job_holder000000001', message: 'covered' });
      await dispatcherFor(coalesced).dispatch();
      expect(await queue.get(55, q.jobId!)).toMatchObject({ state: 'admitted', outcome: { reason: 'coalesced', jobId: 'job_holder000000001' } });
      expect(await workflowStore.getWorkflow(55, '9-p40')).toMatchObject({ status: 'active', stage: 'reviewing-loop', lastJobId: 'job_holder000000001' });
    });

    it('drops a queued push or check suite whose head is stale, rather than repairing old code', async () => {
      const launch = createLauncher(deps());
      const a = await launch(request(1, 'delivery-a'));
      const ci = await launch(prEvent('ci-1', 'check_suite', { check_suite: { head_sha: 'aaaaaaa1', head_branch: 'updraft/issue-12-abc', pull_requests: [{ number: 40 }] } }));
      expect(ci.disposition).toBe('queued');
      await finish(a.jobId!);
      const github = {
        createInstallationToken: async () => ({ token: 't', expiresAt: 0 }),
        pullRequestHead: async () => ({ state: 'open' as const, merged: false, headSha: 'ccccccc3', headRef: 'updraft/issue-12-abc' }),
      };
      const revalidator = createGitHubRevalidator({ github, loadSettings: async () => ({ appId: '1', privateKey: KEY, webhookSecret: 'x', slug: 'updraft' } as never) });
      await dispatcherFor(launch, { revalidate: revalidator }).dispatch();
      expect(await queue.get(55, ci.jobId!)).toMatchObject({ state: 'canceled', outcome: { reason: 'stale_head' } });
      expect(runs).toHaveLength(1);
    });
  });
});

describe('the GitHub revalidation', () => {
  const entry = (over: Partial<QueueEntry> = {}) => ({ jobId: 'job_aaaaaaaaaaaaaaaa', installationId: 55, repository: 'acme/web', repositoryId: 9, issue: 2, eventName: 'issues', label: 'updraft', ...over }) as QueueEntry;
  const settings = async () => ({ appId: '1', privateKey: KEY, webhookSecret: 'x' }) as never;
  it('checks the issue is open and still labeled, with a read-only token for that one repository', async () => {
    const scopes: unknown[] = [];
    const github = {
      createInstallationToken: async (_j: string, _i: number, scope?: unknown) => { scopes.push(scope); return { token: 't', expiresAt: 0 }; },
      issueState: vi.fn().mockResolvedValueOnce({ open: true, labels: ['Updraft'] }).mockResolvedValueOnce({ open: true, labels: [] }).mockResolvedValueOnce({ open: false, labels: ['updraft'] }),
    };
    const check = createGitHubRevalidator({ github, loadSettings: settings });
    expect(await check(entry())).toEqual({ ok: true });
    expect(await check(entry())).toMatchObject({ ok: false, reason: 'label_removed' });
    expect(await check(entry())).toMatchObject({ ok: false, reason: 'issue_closed' });
    expect(scopes[0]).toEqual({ repositoryIds: [9], permissions: { issues: 'read' } });
  });
  it('cancels for a repository the App can no longer reach, and throws (retry later) for anything else', async () => {
    const github = {
      createInstallationToken: async () => ({ token: 't', expiresAt: 0 }),
      issueState: vi.fn().mockRejectedValueOnce(new GitHubError(404, 'gone')).mockRejectedValueOnce(new GitHubError(500, 'boom')),
    };
    const check = createGitHubRevalidator({ github, loadSettings: settings });
    expect(await check(entry())).toMatchObject({ ok: false, reason: 'not_accessible' });
    await expect(check(entry())).rejects.toThrow('boom');
  });
  it('lets a queued close through, and cancels other events of a closed pull request', async () => {
    const github = {
      createInstallationToken: async () => ({ token: 't', expiresAt: 0 }),
      pullRequestHead: async () => ({ state: 'closed' as const, merged: true, headSha: 'a', headRef: 'b' }),
    };
    const check = createGitHubRevalidator({ github, loadSettings: settings });
    const pr = { issue: undefined, pullRequest: 40 };
    expect(await check(entry({ ...pr, eventName: 'pull_request', action: 'closed' }))).toEqual({ ok: true });
    expect(await check(entry({ ...pr, eventName: 'pull_request_review' }))).toMatchObject({ ok: false, reason: 'pull_request_closed' });
  });
});

// A throwaway RSA key: appJwt signs with it, nothing verifies it.
const KEY = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
