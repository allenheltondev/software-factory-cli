import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLauncher, type LaunchSettings } from '../jobs/launch.js';
import { createMemoryStore, type Job } from '../store/store.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createBroker, jobSessionPolicy } from '../broker/broker.js';
import { createReconciler } from '../jobs/reconcile.js';
import { createNativeControl, WORKER_LEASE_MS } from './control.js';
import { nativeJobToken, nativeRoute, type NativeRoute } from './route.js';
import type { NativeStore, Worker } from './store.js';

const route: NativeRoute = { installationId: 55, repositoryId: 9, repository: 'acme/web', labels: ['updraft'], workerId: 'test-worker', microvmId: 'mvm-native', imageVersion: '7', controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/test-abcdef' };
const secret = 'worker-control-credential-01234567890123456789';
const settings: LaunchSettings = { region: 'us-east-1', bucket: 'bucket', imageArn: 'byok-image', executionRoleArn: 'role', ingressConnectorArn: 'in', egressConnectorArn: 'out', logGroup: 'log', brokerFunctionName: 'broker', maximumDurationSeconds: 10800, watchdogReserveSeconds: 600 };
const request = (deliveryId = 'delivery-1') => ({ installationId: 55, deliveryId, body: '{}', payload: {
  action: 'labeled', issue: { number: 12 }, label: { name: 'updraft' }, sender: { login: 'pat' }, repository: { id: 9, full_name: 'acme/web' },
} });

describe('native worker Cloud dispatch', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let row: Worker | null;
  let workers: NativeStore;
  let clock: number;
  let disabled: boolean;
  let subscriptionEnabled: boolean;
  let state: string;
  let control: ReturnType<typeof createNativeControl>;
  let launch: ReturnType<typeof createLauncher>;
  const runMicrovm = vi.fn();
  const terminateMicrovm = vi.fn();
  const loadSecret = vi.fn<() => Promise<string>>();
  const input = (op: string, extra = {}) => ({ action: 'worker', op, workerId: route.workerId, token: secret, session: 'session-0123456789', microvmId: route.microvmId, auth: 'connected', imageVersion: route.imageVersion, workerVersion: '104', ...extra });
  beforeEach(async () => {
    clock = Date.now(); disabled = false; subscriptionEnabled = true; state = 'RUNNING'; row = null;
    runMicrovm.mockReset().mockResolvedValue({ microvmId: 'mvm-byok' });
    terminateMicrovm.mockReset().mockResolvedValue(undefined);
    loadSecret.mockReset().mockResolvedValue(secret);
    store = createMemoryStore();
    await store.putTenantWithMember({ installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '', createdBy: 's' },
      { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    const version = await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: dispatchRules({
      dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
    }, { keysFor: () => ['ANTHROPIC_API_KEY'] }) });
    await store.markConfigReady(55, version as number); await store.activateConfig(55, version as number);
    workers = {
      async get() { return row ? structuredClone(row) : null; },
      async put(w, previous) { if ((row?.version ?? null) !== previous) return false; row = structuredClone(w); return true; },
      async queued() {
        const ids = (await store.listRecentJobs(55, 100)).map((j) => j.jobId);
        const jobs = await Promise.all(ids.map((id) => store.getJob(id)));
        return jobs.filter((j) => j?.native && !j.microvmId).map((j) => j!.jobId);
      },
      async dequeue() {},
    };
    control = createNativeControl({ store, workers, route, secret: async () => secret, settings, terminateMicrovm, microvmState: async () => state, disabled: async () => disabled, enabled: async () => subscriptionEnabled, now: () => clock });
    launch = createLauncher({ store, settings, native: { route, secret: loadSecret, enabled: async () => subscriptionEnabled }, imageVersion: async () => '3',
      putEvent: async () => {}, runMicrovm, quotas: { concurrentJobs: 10, platformConcurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000 }, now: () => clock, log: () => {} });
  });
  const queued = async () => (await store.getJob((await launch(request())).jobId!))!;
  async function assigned() {
    const job = await queued();
    expect(await control.handle(input('register'))).toMatchObject({ ok: true });
    const assignment = await control.handle(input('poll'));
    expect(assignment).toMatchObject({ ok: true, request: { microvmId: route.microvmId, payload: { broker: { jobId: job.jobId } } } });
    return (await store.getJob(job.jobId))!;
  }
  it('is disabled by default and validates operator references', () => {
    expect(nativeRoute('')).toBeUndefined();
    expect(nativeRoute(JSON.stringify(route))).toEqual(route);
    expect(() => nativeRoute(JSON.stringify({ ...route, controlSecretArn: 'claude-token' }))).toThrow();
  });
  it('switches between API-key and subscription routing without deleting keys or bypassing polling controls', async () => {
    subscriptionEnabled = false;
    expect(await launch(request())).toMatchObject({ disposition: 'missing_key' });
    expect(runMicrovm).not.toHaveBeenCalled();
    subscriptionEnabled = true;
    const job = await queued();
    await control.handle(input('register'));
    subscriptionEnabled = false;
    expect(await control.handle(input('poll'))).toMatchObject({ ok: true, busy: false });
    subscriptionEnabled = true;
    expect(await control.handle(input('poll'))).toHaveProperty('request');
    subscriptionEnabled = false;
    expect(await control.handle(input('heartbeat'))).toMatchObject({ cancel: true });
    expect((await store.getJob(job.jobId))?.native?.workerId).toBe(route.workerId);
  });
  it('queues without an API key or BYOK image, deduplicates deliveries and claims once across concurrent polls', async () => {
    const job = await queued();
    expect(job.native?.workerId).toBe(route.workerId); expect(job.agentKeys).toBeUndefined();
    expect(runMicrovm).not.toHaveBeenCalled();
    expect(await launch(request())).toMatchObject({ disposition: 'duplicate' });
    await control.handle(input('register'));
    const responses = await Promise.all([control.handle(input('poll')), control.handle(input('poll'))]);
    expect(responses.filter((r) => r.request)).toHaveLength(1);
    expect(row?.active?.jobId).toBe(job.jobId);
    expect(await control.handle(input('poll'))).toMatchObject({ ok: false });
  });
  it.each([false, true])('retains native claims on an ambiguous enqueue (committed: %s)', async (committed) => {
    const putJob = store.putJob.bind(store);
    vi.spyOn(store, 'putJob').mockImplementationOnce(async (job) => {
      if (committed) await putJob(job);
      throw new Error('DynamoDB response lost');
    });
    const result = await launch(request());
    expect(result).toMatchObject({ status: 503, disposition: 'launch_failed' });
    expect(await store.getDeliveryClaim(55, 'delivery-1')).toMatchObject({ jobId: result.jobId });
    expect(await store.listActiveJobs()).toHaveLength(1);
    expect(Boolean(await store.getJob(result.jobId!))).toBe(committed);
    expect(await launch(request())).toMatchObject({ disposition: 'duplicate' });
  });
  it('owns no delivery or quota when secret retrieval fails, and permits immediate redelivery', async () => {
    loadSecret.mockRejectedValueOnce(new Error('Secrets Manager unavailable'));
    const claim = vi.spyOn(store, 'claimDelivery');
    const reserve = vi.spyOn(store, 'reserveJob');
    await expect(launch(request())).rejects.toThrow('Secrets Manager unavailable');
    expect(claim).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(await store.getDeliveryClaim(55, 'delivery-1')).toBeNull();
    expect(await store.listActiveJobs()).toEqual([]);
    expect(await store.listRecentJobs(55, 10)).toEqual([]);
    expect(await launch(request())).toMatchObject({ status: 202, disposition: 'launched' });
    expect(await store.listActiveJobs()).toHaveLength(1);
    expect(runMicrovm).not.toHaveBeenCalled();
  });
  it('preserves key checks when the route does not select this workflow', async () => {
    const other = createLauncher({ store, settings, native: { route: { ...route, labels: ['other'] }, secret: async () => secret }, imageVersion: async () => '3',
      putEvent: async () => {}, runMicrovm, quotas: { concurrentJobs: 10, platformConcurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000 }, log: () => {} });
    expect(await other(request())).toMatchObject({ disposition: 'missing_key' });
    expect(runMicrovm).not.toHaveBeenCalled();
  });
  it.each(['auth-required', 'expired', 'unavailable'])('does not assign work while auth is %s', async (auth) => {
    await queued(); await control.handle(input('register', { auth }));
    expect(await control.handle(input('poll', { auth }))).toMatchObject({ ok: true, busy: false });
    expect(row?.auth).toBe(auth); expect(row?.active).toBeUndefined();
  });
  it('rejects wrong control credentials, tenant-selected metadata, raw auth and unpinned microVMs', async () => {
    for (const extra of [{ token: 'wrong' }, { workerId: 'other' }, { installationId: 66 }, { rawStatus: '{"token":"secret"}' }, { microvmId: 'another-vm' }]) {
      expect(await control.handle(input('register', extra))).toMatchObject({ ok: false });
    }
    expect(row).toBeNull(); expect(terminateMicrovm).not.toHaveBeenCalled();
  });
  it('retains capacity after a lost lease until the VM is confirmed terminated; never reassigns the task', async () => {
    const job = await assigned(); clock += WORKER_LEASE_MS + 1;
    expect(await control.canServe(job)).toBe(false);
    const reconcile = createReconciler({ store, native: control, microvmState: async () => state, now: () => clock, log: () => {} });
    expect((await reconcile()).released).toEqual([]);
    expect((await store.listActiveJobs()).map((j) => j.jobId)).toContain(job.jobId);
    expect(row?.fenced).toBe(true); expect(terminateMicrovm).toHaveBeenCalledWith(route.microvmId);
    state = 'TERMINATED'; expect((await reconcile()).released).toContain(job.jobId);
    expect((await store.getJob(job.jobId))?.outcome).toBe('microvm_gone');
    expect(await control.handle(input('register', { session: 'replacement-session-123' }))).toMatchObject({ ok: false });
  });
  it('does not renew a lost assignment through polling, registration or a settled claim', async () => {
    await assigned(); const until = row!.active!.until; clock += 100;
    for (const op of ['poll', 'register', 'settled']) expect(await control.handle(input(op))).toMatchObject({ ok: false });
    expect(row?.active?.until).toBe(until);
  });
  it('cancels queued work without starting a VM; signals active cancellation without extending its deadline', async () => {
    const job = await queued();
    expect(await control.handle({ action: 'worker', op: 'cancel', workerId: route.workerId, token: secret, jobId: job.jobId })).toMatchObject({ ok: true });
    expect((await store.getJob(job.jobId))?.outcome).toBe('canceled');
    expect(await store.listActiveJobs()).toHaveLength(0);
    await launch(request('delivery-2')); await control.handle(input('register')); await control.handle(input('poll'));
    const active = row!.active!; disabled = true; clock += 1000;
    expect(await control.handle(input('heartbeat'))).toMatchObject({ cancel: true });
    expect(row?.active?.until).toBe(active.until);
  });
  it('expires queued jobs instead of reclaiming their reservation after five minutes', async () => {
    const job = await queued(); clock += 6 * 60_000;
    expect(await control.reconcile(job)).toBe(false);
    expect((await store.listActiveJobs()).map((j) => j.jobId)).toContain(job.jobId);
    clock = job.expiresAt + 1; expect(await control.reconcile(job)).toBe(true);
    expect(await store.listActiveJobs()).toHaveLength(0);
  });
  it('uses the existing broker history and releases a finished lease without terminating the persistent VM', async () => {
    const job = await assigned();
    const assumeRole = vi.fn().mockResolvedValue({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(clock + 3600_000).toISOString() });
    const broker = createBroker({ store, native: control, loadSettings: async () => null, github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() }, assumeRole, terminateMicrovm, microvmState: async () => state,
      policy: { bucket: 'bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' }, now: () => clock });
    const call = (action: string, extra = {}) => broker({ action, jobId: job.jobId, token: nativeJobToken(secret, job.jobId), ...extra });
    expect(await call('start')).toMatchObject({ ok: true, descriptor: { agentKeySecrets: {} } });
    expect(assumeRole.mock.calls[0]![0].policy).not.toMatch(/ANTHROPIC|native-workers/);
    await call('finish', { outcome: 'succeeded', detail: { prNumber: 18, prUrl: 'https://github.com/acme/web/pull/18', logs: ['run.log'] } });
    expect(await call('terminate')).toMatchObject({ ok: true });
    expect(await call('terminate')).toMatchObject({ ok: true });
    expect(row?.active).toBeUndefined(); expect(terminateMicrovm).not.toHaveBeenCalled();
    expect((await store.listRecentJobs(55, 10))[0]).toMatchObject({ status: 'finished', outcome: 'succeeded', detail: { prNumber: 18 } });
    expect(await store.listActiveJobs()).toHaveLength(0);
    expect(await control.canServe(job)).toBe(false);
  });
  it('settles through a heartbeat CAS conflict by reading the worker again', async () => {
    const job = await assigned();
    await store.finishJob(job.jobId, 'succeeded');
    const finished = (await store.getJob(job.jobId))!;
    const put = workers.put;
    vi.spyOn(workers, 'put').mockImplementationOnce(async (next, previous) => {
      expect(await control.handle(input('heartbeat'))).toMatchObject({ ok: true, cancel: false });
      return put(next, previous);
    });
    expect(await control.complete(finished)).toBe(true);
    expect(row?.active).toBeUndefined(); expect(row?.settling).toBeUndefined(); expect(row?.fenced).toBeUndefined();
    expect(await store.listActiveJobs()).toEqual([]);
  });
  it('retains quota when every settlement CAS conflicts, then settles on a later retry', async () => {
    const job = await assigned();
    await store.finishJob(job.jobId, 'succeeded');
    const finished = (await store.getJob(job.jobId))!;
    const release = vi.spyOn(store, 'releaseJob');
    const put = workers.put;
    let conflicts = 3;
    const spy = vi.spyOn(workers, 'put').mockImplementation(async (next, previous) => {
      if (next.settling && conflicts-- > 0) expect(await control.handle(input('heartbeat'))).toMatchObject({ ok: true });
      return put(next, previous);
    });
    expect(await control.complete(finished)).toBe(false);
    spy.mockRestore();
    expect(release).not.toHaveBeenCalled();
    expect(row?.active?.jobId).toBe(job.jobId);
    expect(row?.settling).toBeUndefined();
    expect((await store.listActiveJobs()).map((j) => j.jobId)).toContain(job.jobId);
    expect(await store.reserveJob({ installationId: 55, jobId: 'job_competing00001', holdUntil: clock + 1000,
      day: new Date(clock).toISOString().slice(0, 10), month: new Date(clock).toISOString().slice(0, 7),
      quotas: { concurrentJobs: 1, platformConcurrentJobs: 1, jobsPerDay: 100, microvmMinutesPerMonth: 100_000 } })).toMatchObject({ ok: false });
    expect(await control.complete(finished)).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(row?.active).toBeUndefined(); expect(row?.settling).toBeUndefined();
    expect(await store.listActiveJobs()).toEqual([]);
  });
  it('keeps the shared worker for the next issue when a heartbeat lands during completion (#144)', async () => {
    const job = await assigned();
    const broker = createBroker({ store, native: control, loadSettings: async () => null, github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
      assumeRole: vi.fn().mockResolvedValue({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(clock + 3600_000).toISOString() }),
      terminateMicrovm, microvmState: async () => state, policy: { bucket: 'bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' }, now: () => clock });
    const call = (action: string, extra = {}) => broker({ action, jobId: job.jobId, token: nativeJobToken(secret, job.jobId), ...extra });
    await call('start');
    await call('finish', { outcome: 'succeeded' });
    // The worker heartbeats while the broker handles the runner's terminate: before this fix the
    // stop request was written first, the heartbeat answered cancel, and the worker loop ended.
    const heartbeats: Record<string, unknown>[] = [];
    const get = workers.get;
    vi.spyOn(workers, 'get').mockImplementationOnce(async (...args) => {
      heartbeats.push(await control.handle(input('heartbeat')));
      return get(...args);
    });
    expect(await call('terminate')).toMatchObject({ ok: true, terminated: true });
    expect(heartbeats).toEqual([expect.objectContaining({ ok: true, cancel: false })]);
    expect((await store.getJob(job.jobId))?.stopRequestedAt).toBeDefined();
    expect(row).toMatchObject({ session: 'session-0123456789', microvmId: route.microvmId });
    expect(row?.fenced).toBeUndefined(); expect(terminateMicrovm).not.toHaveBeenCalled();
    // The runner has exited: the dispatcher settles, then the next issue goes to the same VM.
    expect(await control.handle(input('heartbeat'))).toMatchObject({ ok: true, busy: false });
    expect(await control.handle(input('settled'))).toMatchObject({ ok: true, busy: false });
    clock += 3 * 60_000;
    expect(await control.handle(input('poll'))).toMatchObject({ ok: true, busy: false });
    const next = (await store.getJob((await launch(request('delivery-2'))).jobId!))!;
    expect(await control.handle(input('poll'))).toMatchObject({ ok: true, request: { microvmId: route.microvmId, payload: { broker: { jobId: next.jobId } } } });
    expect(row?.active?.jobId).toBe(next.jobId);
  });
  it('still cancels an active job whose stop was requested before it finished', async () => {
    const job = await assigned();
    await store.markStopping(job.jobId);
    expect(await control.handle(input('heartbeat'))).toMatchObject({ ok: true, cancel: true });
    await store.finishJob(job.jobId, 'canceled');
    expect(await control.handle(input('heartbeat'))).toMatchObject({ ok: true, cancel: true });
  });
  it('keeps a durable settlement marker across a release failure, blocks polling, and reconciles it', async () => {
    const job = await assigned();
    await store.finishJob(job.jobId, 'succeeded');
    const finished = (await store.getJob(job.jobId))!;
    const release = vi.spyOn(store, 'releaseJob').mockImplementationOnce(async () => {
      expect(row?.active).toBeUndefined();
      expect(row?.settling?.jobId).toBe(job.jobId);
      throw new Error('DynamoDB unavailable');
    });
    await expect(control.complete(finished)).rejects.toThrow('DynamoDB unavailable');
    expect(await control.canServe(job)).toBe(false);
    expect((await store.listActiveJobs()).map((j) => j.jobId)).toContain(job.jobId);
    await launch(request('delivery-2'));
    const version = row!.version;
    expect(await control.handle(input('heartbeat'))).toMatchObject({ ok: true, busy: true });
    expect(row?.version).toBe(version);
    expect(await control.handle(input('poll'))).toMatchObject({ ok: true, busy: true });
    expect(row?.settling?.jobId).toBe(job.jobId);
    expect(await control.reconcile(finished)).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
    expect(row?.settling).toBeUndefined();
    expect((await store.listActiveJobs()).map((j) => j.jobId)).not.toContain(job.jobId);
    expect(await control.handle(input('poll'))).toMatchObject({ ok: true, request: { payload: { deliveryId: 'delivery-2' } } });
    expect(terminateMicrovm).not.toHaveBeenCalled();
  });
  it('recovers an ambiguous settlement write and a failed final clear without resurrecting the lease', async () => {
    const job = await assigned();
    await store.finishJob(job.jobId, 'succeeded');
    const finished = (await store.getJob(job.jobId))!;
    const release = vi.spyOn(store, 'releaseJob');
    const put = workers.put;
    const writes = vi.spyOn(workers, 'put').mockImplementationOnce(async (next, previous) => {
      expect(await put(next, previous)).toBe(true);
      throw new Error('settlement response lost');
    });
    await expect(control.complete(finished)).rejects.toThrow('settlement response lost');
    expect(release).not.toHaveBeenCalled();
    expect(row?.active).toBeUndefined(); expect(row?.settling?.jobId).toBe(job.jobId);
    writes.mockResolvedValueOnce(false);
    expect(await control.complete(finished)).toBe(false);
    expect(row?.settling?.jobId).toBe(job.jobId);
    expect(await control.canServe(job)).toBe(false);
    // A dispatcher whose runner exited can finish the retained marker after release committed.
    expect(await control.handle(input('settled'))).toMatchObject({ ok: true, busy: false });
    expect(row?.settling).toBeUndefined(); expect(row?.active).toBeUndefined();
    expect(await store.listActiveJobs()).toEqual([]);
    expect(await control.complete((await store.getJob(job.jobId))!)).toBe(true);
    expect(terminateMicrovm).not.toHaveBeenCalled();
  });
  it('never grants the job access to the worker secret or Anthropic key, while retaining another required key', () => {
    const policy = jobSessionPolicy({ installationId: 55, configVersion: 1, deliveryId: 'd', native: { workerId: route.workerId }, agentKeys: ['CODEX_API_KEY', 'ANTHROPIC_API_KEY'] } as Job,
      { bucket: 'bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' });
    expect(JSON.stringify(policy)).toContain('agent-keys/CODEX_API_KEY-*');
    expect(JSON.stringify(policy)).not.toMatch(/ANTHROPIC|native-workers|agent-keys\/\*/);
  });
});
