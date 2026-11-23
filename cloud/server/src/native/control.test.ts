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
  let state: string;
  let control: ReturnType<typeof createNativeControl>;
  let launch: ReturnType<typeof createLauncher>;
  const runMicrovm = vi.fn();
  const terminateMicrovm = vi.fn();
  const input = (op: string, extra = {}) => ({ action: 'worker', op, workerId: route.workerId, token: secret, session: 'session-0123456789', microvmId: route.microvmId, auth: 'connected', imageVersion: route.imageVersion, workerVersion: '104', ...extra });
  beforeEach(async () => {
    clock = Date.now(); disabled = false; state = 'RUNNING'; row = null;
    runMicrovm.mockReset().mockResolvedValue({ microvmId: 'mvm-byok' });
    terminateMicrovm.mockReset().mockResolvedValue(undefined);
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
    control = createNativeControl({ store, workers, route, secret: async () => secret, settings, terminateMicrovm, microvmState: async () => state, disabled: async () => disabled, now: () => clock });
    launch = createLauncher({ store, settings, native: { route, secret: async () => secret }, imageVersion: async () => null,
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
  it('never grants the job access to the worker secret or Anthropic key, while retaining another required key', () => {
    const policy = jobSessionPolicy({ installationId: 55, configVersion: 1, deliveryId: 'd', native: { workerId: route.workerId }, agentKeys: ['CODEX_API_KEY', 'ANTHROPIC_API_KEY'] } as Job,
      { bucket: 'bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' });
    expect(JSON.stringify(policy)).toContain('agent-keys/CODEX_API_KEY-*');
    expect(JSON.stringify(policy)).not.toMatch(/ANTHROPIC|native-workers|agent-keys\/\*/);
  });
});
