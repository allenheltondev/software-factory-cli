import { createWorkflowRecorder } from '../workflows/recorder.js';
import { createMemoryWorkflowStore } from '../workflows/store.js';
import { waitingId } from '../native/sessions.js';
import { parse, stringify } from 'yaml';
import { jobBranchName } from '../../../../src/git/worktree.js';
import { eventJobId } from '../../../../src/poller/webhook.js';
import { BENCHMARK_LABEL } from '../benchmarks/config.js';
import { createBenchmarkDispatch } from '../benchmarks/dispatch.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBroker, hashToken } from '../broker/broker.js';
import { createMemoryStore, type DispatchRules, type Tenant } from '../store/store.js';
import { createBundleKeys } from '../tenants/key-needs.js';
import { configPrefix } from '../tenants/paths.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createAdminService } from '../admin/admin.js';
import { createReconciler } from './reconcile.js';
import { createLauncher, readinessAction, waitingComment, type NativeReadiness, PR_COALESCE_MS, PRELAUNCH_CLAIM_MS, pullRequestLease, type LaunchDeps, type LaunchRequest, type RunMicrovmInput, type ThrottleNotice, runHookPayload } from './launch.js';

// Relative to the real clock: the memory store judges a delivery claim's expiry by it.
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
const tenant = (status: Tenant['status'] = 'active'): Tenant => ({
  installationId: 55,
  accountId: 900,
  accountLogin: 'acme',
  accountType: 'Organization',
  status,
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 's',
});
const rules = dispatchRules({
  dispatch: { allowedActors: ['pat'] },
  repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
}, { keysFor: () => [] });

describe('the launcher', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let events: Record<string, string>;
  let runs: RunMicrovmInput[];
  let runMicrovm: LaunchDeps['runMicrovm'];
  let imageVersion: string | null;
  let deps: LaunchDeps;

  const request = (overrides: Partial<LaunchRequest['payload']> = {}, deliveryId = 'delivery-1'): LaunchRequest => {
    const payload = { action: 'labeled', issue: { number: 12 }, label: { name: 'updraft' }, sender: { login: 'pat' }, repository: { id: 9, full_name: 'acme/web' }, ...overrides };
    return { installationId: 55, deliveryId, body: JSON.stringify(payload), payload };
  };

  beforeEach(async () => {
    store = createMemoryStore();
    await store.putTenantWithMember(tenant(), { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    const version = await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: rules });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
    events = {};
    runs = [];
    imageVersion = '3';
    runMicrovm = async (input) => {
      runs.push(input);
      return { microvmId: 'mvm-0001' };
    };
    deps = {
      store,
      settings: SETTINGS,
      imageVersion: async () => imageVersion,
      putEvent: async (key, body) => {
        events[key] = body;
      },
      runMicrovm: (input) => runMicrovm(input),
      // Generous, so the tests of everything else are never throttled.
      quotas: { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 },
      now: () => NOW,
      log: () => {},
      retryDelayMs: 1,
    };
  });

  it('stops a late-arriving VM and prevents label replay until an explicit retry', async () => {
    const { createJobStopper } = await import('./stop.js');
    const terminated: string[] = [];
    const stop = createJobStopper({ store, terminateMicrovm: async (id) => { terminated.push(id); }, microvmState: async () => 'TERMINATED', now: () => NOW, log: () => {} });
    deps.stopJob = stop.advance;
    runMicrovm = async (input) => {
      await stop.request(55, input.clientToken, 'pat', 'stop while launching');
      expect(await store.listActiveJobs()).toHaveLength(1);
      return { microvmId: 'late-vm' };
    };
    const out = await createLauncher(deps)(request());
    expect((await store.getJob(out.jobId!))?.outcome).toBe('canceled');
    expect(await store.listActiveJobs()).toHaveLength(0);
    // Already terminated is also confirmation; the termination API need not be called again.
    expect(terminated).toEqual([]);
    expect(await createLauncher(deps)(request({}, 'new-label-event'))).toMatchObject({ disposition: 'not_dispatched', reason: 'workflow_paused' });
  });

  it('keeps canceled work fenced and holds capacity when RunMicrovm loses its response', async () => {
    const { createJobStopper } = await import('./stop.js');
    const stop = createJobStopper({ store, terminateMicrovm: async () => {}, microvmState: async () => 'RUNNING', now: () => NOW, log: () => {} });
    runMicrovm = async (input) => { await stop.request(55, input.clientToken, 'pat', 'stop'); throw new Error('lost response'); };
    const out = await createLauncher(deps)(request());
    expect(out).toMatchObject({ disposition: 'cancelled' });
    expect((await store.getJob(out.jobId!))?.status).toBe('launched');
    expect(await store.listActiveJobs()).toHaveLength(1);
    expect(await createLauncher(deps)(request())).toMatchObject({ reason: 'workflow_paused' });
  });
  it('does not provision a sibling VM when the source issue is stopped after routing checks', async () => {
    const owner = await createLauncher(deps)(request({}, 'parent-delivery'));
    const parent = (await store.getJob(owner.jobId!))!;
    const mark = store.markLaunching;
    vi.spyOn(store, 'markLaunching').mockImplementationOnce(async (id) => {
      await store.requestJobStop(parent, { requestedAt: NOW, by: 'pat', reason: 'stop workflow' }, [12]);
      return mark(id);
    });
    const result = await createLauncher(deps)(request({}, 'racing-delivery'));
    expect(result).toMatchObject({ disposition: 'cancelled' });
    expect(runs).toHaveLength(1); // only the parent, never the racing sibling
    expect((await store.getJob(result.jobId!))?.outcome).toBe('canceled');
    expect(await store.getWorkflowPause(55, 9, 12)).toMatchObject({ jobId: parent.jobId });
  });

  it('routes a console-selected Claude trigger without a stack repository and refuses offline fallback', async () => {
    const version = await store.createConfigVersion(55, { sha256: 'y', files: [], publishedBy: 's', publishedAt: '',
      dispatch: dispatchRules({ dispatch: { allowedActors: ['pat'] }, repositories: {
        'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] },
        'acme/docs': { id: 10, workflows: [{ trigger: { label: 'updraft' } }] },
      } }, { keysFor: () => ['ANTHROPIC_API_KEY'] }) });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
    const ready = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    deps.native = {
      route: { installationId: 55, workerId: 'worker-1', microvmId: 'mvm-native', imageVersion: '7',
        controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/test-abcdef' },
      secret: async () => 'worker-control-credential-01234567890123456789',
      mode: async () => ({ enabled: true, revision: 2, routingVersion: 1,
        triggers: [{ repositoryId: 10, repository: 'acme/docs', label: 'updraft' }] }),
      ready,
    };
    const launch = createLauncher(deps);
    const event = request({ repository: { id: 10, full_name: 'acme/docs' } });
    expect(await launch(event)).toMatchObject({ reason: 'native_worker_unavailable' });
    const result = await launch(event);
    expect(result).toMatchObject({ status: 202, disposition: 'launched' });
    expect(await store.getJob(result.jobId!)).toMatchObject({ native: { workerId: 'worker-1', routingVersion: 1 } });
    expect(await launch(request({}, 'unselected-delivery'))).toMatchObject({ reason: 'missing_key' });
    expect(runs).toEqual([]);
  });

  it('parks a managed issue without reserving runtime, then resumes the same delivery on its own worker', async () => {
    const config = dispatchRules({
      dispatch: { allowedActors: ['pat'] },
      repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
    }, { keysFor: () => ['ANTHROPIC_API_KEY'] });
    const version = await store.createConfigVersion(55, { sha256: 'park', files: [], publishedBy: 's', publishedAt: '', dispatch: config });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
    const id = waitingId(55, 'delivery-1');
    let connected = false;
    let parked = false;
    deps.resolveNative = async (tenantId) => tenantId === 55 ? {
      route: { installationId: 55, workerId: 'managed-55', microvmId: 'mvm-native', imageVersion: '7', generation: 'session-a',
        controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/root' },
      secret: async () => 'scoped-worker-secret-01234567890',
      mode: async () => ({ enabled: true, revision: 1, triggers: [{ repositoryId: 9, repository: 'acme/web', label: 'updraft' }] }),
      ready: async () => connected,
    } : undefined;
    deps.waitForClaude = vi.fn(async () => { parked = true; return id; });
    deps.parkedClaude = async () => parked ? id : undefined;
    const reserve = vi.spyOn(store, 'reserveJob');
    const workflowStore = createMemoryWorkflowStore();
    deps.workflows = createWorkflowRecorder({ store: workflowStore, log: () => {} });
    const launch = createLauncher(deps);
    const event = request();
    expect(await launch(event)).toMatchObject({ status: 202, reason: 'native_waiting_for_sign_in', jobId: id });
    // The issue's workflow waits for the sign-in, with what to do.
    expect(await workflowStore.getWorkflow(55, '9-i12')).toMatchObject({ status: 'waiting', stage: 'awaiting-sign-in', reason: 'sign_in_required', lastJobId: id });
    expect(await launch(event)).toMatchObject({ reason: 'native_waiting_for_sign_in', jobId: id });
    expect(deps.waitForClaude).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
    expect(await store.getDeliveryClaim(55, event.deliveryId)).toBeNull();
    connected = true;
    expect(await launch(event)).toMatchObject({ reason: 'native_waiting_for_sign_in' });
    expect(await launch({ ...event, resumeClaude: true, jobId: id })).toMatchObject({ disposition: 'launched', jobId: id });
    expect(await store.getJob(id)).toMatchObject({ native: { workerId: 'managed-55', generation: 'session-a' } });
    expect(reserve).toHaveBeenCalledOnce();
    expect(runs).toEqual([]);
  });

  it.each([
    ['heartbeat-stale', 'native_waiting_for_worker'],
    ['auth-unavailable', 'native_waiting_for_worker'],
    ['worker-starting', 'native_waiting_for_worker'],
    ['worker-lost', 'native_waiting_for_reconnect'],
    ['startup-failed', 'native_waiting_for_reconnect'],
    ['environment-retiring', 'native_waiting_for_reconnect'],
    ['not-connected', 'native_waiting_for_sign_in'],
    ['environment-suspended', 'native_waiting_for_reconnect'],
    ['environment-ended', 'native_waiting_for_reconnect'],
    ['fenced', 'native_waiting_for_reconnect'],
    ['auth-required', 'native_waiting_for_sign_in'],
    ['expired', 'native_waiting_for_sign_in'],
  ] as const)('names why a managed issue waits (%s) and asks for sign-in only when auth is gone (#144)', async (readiness, reason) => {
    const version = await store.createConfigVersion(55, { sha256: 'why', files: [], publishedBy: 's', publishedAt: '', dispatch: dispatchRules({
      dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
    }, { keysFor: () => ['ANTHROPIC_API_KEY'] }) });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
    const logs: Record<string, unknown>[] = [];
    deps.log = (entry) => logs.push(entry);
    deps.resolveNative = async () => ({
      route: { installationId: 55, workerId: 'managed-55', microvmId: 'mvm-native', imageVersion: '7', generation: 'session-a',
        controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/root' },
      secret: async () => 'scoped-worker-secret-01234567890',
      mode: async () => ({ enabled: true, revision: 1, triggers: [{ repositoryId: 9, repository: 'acme/web', label: 'updraft' }] }),
      readiness: async () => readiness,
    });
    deps.waitForClaude = vi.fn(async () => 'job_waiting');
    expect(await createLauncher(deps)(request())).toMatchObject({ status: 202, reason, jobId: 'job_waiting' });
    expect(deps.waitForClaude).toHaveBeenCalledWith(expect.anything(), 'acme/web', 9, 12, readiness, undefined);
    expect(logs).toContainEqual(expect.objectContaining({ nativeDispatch: 'wait', readiness, generation: 'session-a', microvmId: 'mvm-native' }));
    expect(runs).toEqual([]);
  });

  it('records which retirement ended the Claude session on the workflow timeline (#176)', async () => {
    const version = await store.createConfigVersion(55, { sha256: 'retired', files: [], publishedBy: 's', publishedAt: '', dispatch: dispatchRules({
      dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
    }, { keysFor: () => ['ANTHROPIC_API_KEY'] }) });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
    const logs: Record<string, unknown>[] = [];
    deps.log = (entry) => logs.push(entry);
    deps.resolveNative = async () => ({
      route: { installationId: 55, workerId: 'managed-55', microvmId: 'mvm-native', imageVersion: '7', generation: 'session-a',
        controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/root' },
      secret: async () => 'scoped-worker-secret-01234567890',
      mode: async () => ({ enabled: true, revision: 1, triggers: [{ repositoryId: 9, repository: 'acme/web', label: 'updraft' }] }),
      readiness: async () => 'environment-retiring',
      retirement: async () => 'vm-ended',
    });
    deps.waitForClaude = vi.fn(async () => 'job_waiting');
    const workflowStore = createMemoryWorkflowStore();
    deps.workflows = createWorkflowRecorder({ store: workflowStore, log: () => {} });
    expect(await createLauncher(deps)(request())).toMatchObject({ reason: 'native_waiting_for_reconnect', jobId: 'job_waiting' });
    expect(deps.waitForClaude).toHaveBeenCalledWith(expect.anything(), 'acme/web', 9, 12, 'environment-retiring', 'vm-ended');
    expect(logs).toContainEqual(expect.objectContaining({ nativeDispatch: 'wait', readiness: 'environment-retiring', retirementReason: 'vm-ended' }));
    expect(await workflowStore.getWorkflow(55, '9-i12')).toMatchObject({ status: 'waiting', reason: 'reconnect_required',
      message: expect.stringContaining('its VM stopped running before its lifetime ended') });
    const events = await workflowStore.listWorkflowEvents(55, '9-i12', 50);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'waiting', reason: 'claude_session_vm_ended', jobId: 'job_waiting' }));
  });

  it('resumes a job parked on a transient auth probe once the worker reports connected, with no sign-in', async () => {
    const version = await store.createConfigVersion(55, { sha256: 'transient', files: [], publishedBy: 's', publishedAt: '', dispatch: dispatchRules({
      dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
    }, { keysFor: () => ['ANTHROPIC_API_KEY'] }) });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
    const id = waitingId(55, 'delivery-1');
    let readiness: NativeReadiness = 'auth-unavailable';
    let parked = false;
    deps.resolveNative = async () => ({
      route: { installationId: 55, workerId: 'managed-55', microvmId: 'mvm-native', imageVersion: '7', generation: 'session-a',
        controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/root' },
      secret: async () => 'scoped-worker-secret-01234567890',
      mode: async () => ({ enabled: true, revision: 1, triggers: [{ repositoryId: 9, repository: 'acme/web', label: 'updraft' }] }),
      readiness: async () => readiness,
    });
    deps.waitForClaude = vi.fn(async () => { parked = true; return id; });
    deps.parkedClaude = async () => parked ? id : undefined;
    const launch = createLauncher(deps);
    expect(await launch(request())).toMatchObject({ reason: 'native_waiting_for_worker', jobId: id });
    // Still unready: a resume attempt does not start it, and does not ask for sign-in.
    expect(await launch({ ...request(), resumeClaude: true, jobId: id })).toMatchObject({ reason: 'native_worker_unavailable' });
    readiness = 'ready';
    expect(await launch({ ...request(), resumeClaude: true, jobId: id })).toMatchObject({ disposition: 'launched', jobId: id });
    expect(await store.getJob(id)).toMatchObject({ native: { workerId: 'managed-55', generation: 'session-a' } });
    expect(deps.waitForClaude).toHaveBeenCalledOnce();
    expect(runs).toEqual([]);
  });

  it('comments only when a person must sign in, in one friendly sentence with the console link (#176)', () => {
    const sentences = (text: string | undefined) => (text ?? '').replace(/\[[^\]]*\]\([^)]*\)/g, 'LINK').split(/[.!?](\s|$)/).filter((s) => s.trim()).length;
    for (const reason of ['expired', 'auth-required', 'not-connected', undefined] as const) {
      const comment = waitingComment('https://console/x', reason);
      expect(comment).toMatch(/^Claude needs you to sign in before this job can start: \[sign in from Updraft\]\(https:\/\/console\/x\)/);
      expect(sentences(comment)).toBe(1);
    }
    // A wait that ends by itself posts nothing.
    for (const reason of ['auth-unavailable', 'heartbeat-stale', 'worker-starting'] as const) expect(waitingComment('https://console/x', reason)).toBeUndefined();
    // A session that ended says why, from its own recorded retirement reason.
    const retired = waitingComment('https://console/x', 'environment-retiring', 'lifetime');
    expect(retired).toBe('Claude needs you to sign in again because the previous Claude session ended (it reached its maximum lifetime): [sign in from Updraft](https://console/x) and this job starts on its own.');
    expect(sentences(retired)).toBe(1);
    expect(waitingComment('https://console/x', 'environment-retiring', 'vm-ended')).toMatch(/its VM stopped running before its lifetime ended/);
    expect(waitingComment('https://console/x', 'environment-suspended')).toMatch(/sign in again .*suspended/);
    expect(waitingComment('https://console/x', 'environment-retiring', 'some-new-reason')).toMatch(/\(it was retired \(some-new-reason\)\)/);
    expect(readinessAction('ready')).toBe('none');
  });

  it('starts a job: the event under its tenant, a pinned job record, a version 2 run hook, and its microVM recorded', async () => {
    const result = await createLauncher(deps)(request());
    expect(result).toMatchObject({ status: 202, disposition: 'launched', jobId: expect.stringMatching(/^job_[A-Za-z0-9_-]{16}$/) });

    expect(Object.keys(events)).toEqual(['tenants/55/events/delivery-1/event.json']);
    expect(JSON.parse(events['tenants/55/events/delivery-1/event.json']!)).toMatchObject({ label: { name: 'updraft' } });

    const job = await store.getJob(result.jobId!);
    expect(job).toMatchObject({
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 9,
      configVersion: 1,
      deliveryId: 'delivery-1',
      eventName: 'issues',
      status: 'launched',
      label: 'updraft',
      sender: 'pat',
      imageVersion: '3',
      microvmId: 'mvm-0001',
      expiresAt: NOW + 10800 * 1000,
    });

    expect(runs).toHaveLength(1);
    const input = runs[0]!;
    expect(input).toMatchObject({
      imageIdentifier: SETTINGS.imageArn,
      imageVersion: '3',
      executionRoleArn: SETTINGS.executionRoleArn,
      ingressNetworkConnectors: ['arn:in'],
      egressNetworkConnectors: ['arn:out'],
      maximumDurationInSeconds: 10800,
      logging: { cloudWatch: { logGroup: SETTINGS.logGroup } },
      idlePolicy: { maxIdleDurationSeconds: 10800, suspendedDurationSeconds: 0, autoResumeEnabled: false },
      clientToken: result.jobId,
    });
    const hook = JSON.parse(input.runHookPayload) as Record<string, unknown> & { broker: { jobToken: string; jobId: string } };
    expect(hook).toEqual({
      version: 2,
      deliveryId: 'delivery-1',
      eventName: 'issues',
      region: 'us-east-1',
      broker: { functionName: 'updraft-cloud-broker', jobId: result.jobId, jobToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
      maximumDurationSeconds: 10800,
      watchdogReserveSeconds: 600,
      launchedAt: new Date(NOW).toISOString(),
      agentIsolation: 'enforced',
    });
    // Only the token's hash is stored, and it is the one the broker will check.
    expect(job!.tokenHash).toBe(hashToken(hook.broker.jobToken));
    expect(JSON.stringify(job)).not.toContain(hook.broker.jobToken);
  });

  it('tells the runner a job is a console retry, so it requeues the event\'s failed job in the shared state', async () => {
    const result = await createLauncher(deps)({ ...request(), retry: true });
    expect(result).toMatchObject({ status: 202, disposition: 'launched' });
    expect(JSON.parse(runs[0]!.runHookPayload)).toMatchObject({ retry: true });
  });

  it('gives the job the id its caller chose, and refuses one that is not an id', async () => {
    const chosen = await createLauncher(deps)({ ...request(), jobId: 'job_chosenid00000001' });
    expect(chosen).toMatchObject({ status: 202, jobId: 'job_chosenid00000001' });
    expect(await store.getJob('job_chosenid00000001')).not.toBeNull();
    expect(await createLauncher(deps)({ ...request(undefined, 'delivery-2'), jobId: '../../etc' })).toMatchObject({ status: 400, disposition: 'bad_job_id' });
    expect(runs).toHaveLength(1);
  });

  it('gives the job to the broker: the token from the run hook starts it and stops its own microVM', async () => {
    const result = await createLauncher(deps)(request());
    const { jobToken } = (JSON.parse(runs[0]!.runHookPayload) as { broker: { jobToken: string } }).broker;
    const terminateMicrovm = vi.fn(async () => {});
    const broker = createBroker({
      store,
      loadSettings: async () => null,
      github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
      assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(NOW + 3_600_000).toISOString() }),
      terminateMicrovm,
      microvmState: async () => 'TERMINATING',
      policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
      now: () => NOW,
    });
    expect(await broker({ action: 'start', jobId: result.jobId, token: jobToken })).toMatchObject({
      ok: true,
      descriptor: { eventKey: 'tenants/55/events/delivery-1/event.json', configPrefix: 'tenants/55/config/1/' },
    });
    expect(await broker({ action: 'terminate', jobId: result.jobId, token: jobToken })).toEqual({ ok: true, terminated: true });
    expect(terminateMicrovm).toHaveBeenCalledWith('mvm-0001');
  });

  it('isolates two arms through the real launcher and broker and reserves the marker when disabled', async () => {
    const published = {
      version: 1, dispatch: { allowedActors: ['pat'] },
      agents: { fast: { adapter: 'claude', model: 'fast-1' }, deep: { adapter: 'codex', model: 'deep-2' } },
      pools: { build: { agents: ['fast', 'deep'] } }, actions: { build: { prompt: 'prompts/build.md' } },
      repositories: { 'acme/web': { id: 9, autoMerge: 'squash',
        workflows: [{ id: 'build', action: 'build', pool: 'build', trigger: { event: 'issue.labeled', label: BENCHMARK_LABEL } }] } },
    };
    const version = await store.createConfigVersion(55, { sha256: 'bench', files: ['config.yaml'], publishedAt: '', publishedBy: 's',
      dispatch: dispatchRules(published, { keysFor: () => ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'] }) });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
    for (const name of ['ANTHROPIC_API_KEY', 'CODEX_API_KEY']) await store.putAgentKeyMeta(55, { name, updatedAt: 't', updatedBy: 'pat' });
    expect(await createLauncher(deps)(request({ label: { name: 'Updraft:Benchmark' } }))).toMatchObject({ disposition: 'not_dispatched' });
    const launch = createLauncher({ ...deps, benchmarkInstallationId: 55 });
    expect(await launch(request())).toMatchObject({ disposition: 'not_dispatched' });
    const dispatch = createBenchmarkDispatch({ installationId: 55, repositoryId: 9, store, launch,
      readConfig: async () => stringify(published), issueOpenWithMarker: async () => true });
    const input = { repository: 'acme/web', issue: 12, workflow: 'build', actor: 'pat' };
    const arms = ['fast', 'deep'].map((agent) => ({ ...input, agent, benchmark: { runId: 'pilot', caseId: 'case', arm: agent } }));
    const results = await Promise.all(arms.map(dispatch));
    expect(results).toMatchObject([{ status: 202 }, { status: 202 }]);
    expect(await dispatch(arms[0])).toMatchObject({ disposition: 'duplicate', jobId: results[0]?.jobId });
    expect(runs).toHaveLength(2);
    const broker = createBroker({
      store, loadSettings: async () => null, github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
      assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(NOW + 3600_000).toISOString() }),
      terminateMicrovm: async () => {}, microvmState: async () => 'RUNNING',
      policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
      now: () => NOW,
    });
    const stateKeys = new Set<string>();
    const branches = new Set<string>();
    for (const run of runs) {
      const { jobId, jobToken } = JSON.parse(run.runHookPayload).broker;
      const start = { action: 'start', jobId, token: jobToken };
      expect(await broker(start)).toMatchObject({ ok: false });
      const response = await broker({ ...start, benchmarkProtocol: 1 });
      if (!response.ok || !('descriptor' in response)) throw new Error('Expected a benchmark descriptor');
      const descriptor = response.descriptor;
      stateKeys.add(descriptor.stateKey);
      const arm = descriptor.benchmark!.arm as 'fast' | 'deep';
      const config = parse(events[descriptor.benchmarkConfigKey!]!);
      const workflow = config.repositories['acme/web'].workflows[0];
      branches.add(jobBranchName({ id: eventJobId(9, workflow.id, 'same-github-label-event'), issueNumber: 12 }, 1));
      expect(config.agents).toEqual({ [arm]: expect.objectContaining({ model: published.agents[arm].model }) });
      expect(config.repositories['acme/web']).toMatchObject({ publish: 'draft-pr', review: false });
      expect(config.repositories['acme/web']).not.toHaveProperty('autoMerge');
      expect(Object.keys(descriptor.agentKeySecrets)).toEqual([arm === 'fast' ? 'ANTHROPIC_API_KEY' : 'CODEX_API_KEY']);
    }
    expect(stateKeys.size).toBe(2);
    expect(branches.size).toBe(2);
  });

  describe('bring your own key (#70)', () => {
    const activate = async (dispatch: DispatchRules) => {
      const v = await store.createConfigVersion(55, { sha256: 'y', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch });
      await store.markConfigReady(55, v as number);
      await store.activateConfig(55, v as number);
      return v as number;
    };
    // Two workflows: Claude on `updraft`, Codex on `codex` (as dispatchRules stores them now).
    const twoAgents = (): DispatchRules =>
      dispatchRules(
        {
          dispatch: { allowedActors: ['pat'] },
          repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }, { trigger: { label: 'codex' } }] } },
        },
        { keysFor: (_repo, wf) => ((wf.trigger as { label: string }).label === 'codex' ? ['CODEX_API_KEY'] : ['ANTHROPIC_API_KEY']) },
      );
    const withKeys = async (keys: string[]) => activate(dispatchRules(
      { dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } } },
      { keysFor: () => keys },
    ));
    const setKey = (name: string) => store.putAgentKeyMeta(55, { name, updatedAt: '2000-01-01T00:00:00.000Z', updatedBy: 'pat' });
    const finishWith = async (jobId: string, token: string, outcome: string) => {
      const broker = createBroker({
        store,
        loadSettings: async () => null,
        github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
        assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(NOW + 3_600_000).toISOString() }),
        terminateMicrovm: async () => {},
        microvmState: async () => 'RUNNING',
        policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
        now: () => NOW,
      });
      await broker({ action: 'start', jobId, token });
      await broker({ action: 'finish', jobId, token, outcome });
    };

    it('refuses to dispatch when the workflow\'s agent has no key, and records why', async () => {
      await withKeys(['ANTHROPIC_API_KEY']);
      const log = vi.fn();
      expect(await createLauncher({ ...deps, log })(request())).toMatchObject({ status: 200, disposition: 'missing_key' });
      expect(runs).toEqual([]);
      expect(events).toEqual({});
      const [refusal] = await store.listRefusals(55, 5);
      expect(refusal).toMatchObject({ repository: 'acme/web', issue: 12, deliveryId: 'delivery-1', reason: 'ANTHROPIC_API_KEY is not set: add it under Agent keys' });
      // Nothing was claimed, so setting the key and redelivering starts the job.
      await store.putAgentKeyMeta(55, { name: 'ANTHROPIC_API_KEY', updatedAt: 't', updatedBy: 'pat' });
      expect(await createLauncher(deps)(request())).toMatchObject({ status: 202, disposition: 'launched' });
    });

    it('asks a person for the missing key on the issue, never for a console retry (#173)', async () => {
      await withKeys(['ANTHROPIC_API_KEY']);
      const notifyRefused = vi.fn(async () => {});
      expect(await createLauncher({ ...deps, notifyRefused })(request())).toMatchObject({ disposition: 'missing_key' });
      expect(notifyRefused).toHaveBeenCalledWith(expect.objectContaining({ installationId: 55, repository: 'acme/web', number: 12, pullRequest: false, missing: ['ANTHROPIC_API_KEY'] }));
      notifyRefused.mockClear();
      expect(await createLauncher({ ...deps, notifyRefused })({ ...request({}, 'delivery-retry'), retry: true } as LaunchRequest)).toMatchObject({ disposition: 'missing_key' });
      expect(notifyRefused).not.toHaveBeenCalled();
      // A comment that cannot be posted never changes the refusal.
      expect(await createLauncher({ ...deps, notifyRefused: async () => { throw new Error('down'); } })(request({}, 'delivery-2'))).toMatchObject({ disposition: 'missing_key' });
    });

    it("checks only the matched trigger's keys, and pins only those on the job", async () => {
      await activate(twoAgents());
      await setKey('ANTHROPIC_API_KEY');
      // Codex is not set: its label is refused, Claude's label is not held up by it.
      expect(await createLauncher(deps)(request({ label: { name: 'codex' } }, 'delivery-codex'))).toMatchObject({ status: 200, disposition: 'missing_key' });
      const result = await createLauncher(deps)(request());
      expect(result).toMatchObject({ status: 202, disposition: 'launched' });
      expect((await store.getJob(result.jobId!))?.agentKeys).toEqual(['ANTHROPIC_API_KEY']);
    });

    describe('a version published before key needs were recorded', () => {
      // Its dispatch rules: no `keys` on any trigger.
      const legacy = () => dispatchRules({ dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } } });
      const bundle = (version: number) => ({
        [`tenants/55/config/${version}/config.yaml`]: [
          'dispatch: { allowedActors: [pat] }',
          'agents:',
          '  claude: { adapter: claude }',
          'pools:',
          '  default: { agents: [claude] }',
          'repositories:',
          '  acme/web:',
          '    id: 9',
          '    workflows:',
          '      - { trigger: { label: updraft }, pool: default }',
        ].join('\n'),
      });
      const reader = (objects: Record<string, string>) => {
        const reads: string[] = [];
        return { reads, bundleKeys: createBundleKeys(async (key) => (reads.push(key), objects[key] ?? null), configPrefix) };
      };

      it('reads them from its bundle: refused without the key, started (and pinned) with it, read once', async () => {
        const v = await activate(legacy());
        const { reads, bundleKeys } = reader(bundle(v));
        const launch = createLauncher({ ...deps, bundleKeys });
        expect(await launch(request())).toMatchObject({ status: 200, disposition: 'missing_key' });
        expect((await store.listRefusals(55, 1))[0]?.reason).toBe('ANTHROPIC_API_KEY is not set: add it under Agent keys');
        await setKey('ANTHROPIC_API_KEY');
        const result = await launch(request({}, 'delivery-2'));
        expect(result).toMatchObject({ status: 202, disposition: 'launched' });
        expect((await store.getJob(result.jobId!))?.agentKeys).toEqual(['ANTHROPIC_API_KEY']);
        expect(reads).toEqual([`tenants/55/config/${v}/config.yaml`]);
      });

      it('is refused, with the reason, when its bundle cannot tell (never run unchecked)', async () => {
        await activate(legacy());
        await setKey('ANTHROPIC_API_KEY');
        expect(await createLauncher({ ...deps, bundleKeys: reader({}).bundleKeys })(request())).toMatchObject({ status: 200, disposition: 'missing_key' });
        expect(await createLauncher(deps)(request({}, 'delivery-2'))).toMatchObject({ status: 200, disposition: 'missing_key' });
        expect((await store.listRefusals(55, 1))[0]?.reason).toContain('publish the configuration again');
        expect(runs).toEqual([]);
      });
    });

    it('marks each key the job used as OK or failed when it finishes, and never stores a value', async () => {
      await withKeys(['ANTHROPIC_API_KEY']);
      await setKey('ANTHROPIC_API_KEY');
      const result = await createLauncher(deps)(request());
      expect((await store.getJob(result.jobId!))?.agentKeys).toEqual(['ANTHROPIC_API_KEY']);
      const { jobToken } = (JSON.parse(runs[0]!.runHookPayload) as { broker: { jobToken: string } }).broker;
      await finishWith(result.jobId!, jobToken, 'failed');
      expect(await store.listAgentKeyMeta(55)).toEqual([{ name: 'ANTHROPIC_API_KEY', updatedAt: '2000-01-01T00:00:00.000Z', updatedBy: 'pat', lastUsedAt: new Date(NOW).toISOString(), lastUsedOk: false }]);
    });
  });

  it.each([
    ['a tenant that is suspended', async () => store.setSuspended(55, true), 'tenant_inactive'],
    ['no tenant', async () => store.markUninstalled(55, NOW).then(() => store.purgeTenantPartition(55)), 'no_tenant'],
  ])('starts nothing for %s', async (_what, arrange, disposition) => {
    await arrange();
    expect(await createLauncher(deps)(request())).toMatchObject({ status: 200, disposition });
    expect(runs).toEqual([]);
    expect(events).toEqual({});
  });

  it('starts nothing for a tenant without a config, an event its config does not dispatch, or while jobs are off', async () => {
    const launch = createLauncher(deps);
    expect(await launch(request({ label: { name: 'bug' } }))).toMatchObject({ status: 200, disposition: 'not_dispatched' });
    expect(await launch(request({ sender: { login: 'mallory' } }))).toMatchObject({ status: 200, disposition: 'not_dispatched' });
    expect(await launch(request({ issue: undefined }))).toMatchObject({ status: 200, disposition: 'ignored' });
    imageVersion = null;
    expect(await launch(request())).toMatchObject({ status: 200, disposition: 'jobs_off' });

    const bare = createMemoryStore();
    await bare.putTenantWithMember({ ...tenant(), installationId: 56 }, { installationId: 56, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    expect(await createLauncher({ ...deps, store: bare })({ ...request(), installationId: 56 })).toMatchObject({ status: 200, disposition: 'no_config' });
    expect(runs).toEqual([]);
  });

  it('starts one job per delivery: a redelivery while it may run is a duplicate', async () => {
    const launch = createLauncher(deps);
    expect((await launch(request())).disposition).toBe('launched');
    expect(await launch(request())).toMatchObject({ status: 200, disposition: 'duplicate' });
    // Another delivery (another label event) is its own job.
    expect((await launch(request({}, 'delivery-2'))).disposition).toBe('launched');
    expect(runs).toHaveLength(2);
  });

  it('answers 500 when RunMicrovm fails, gives up the claim so the redelivery starts it, and retires the job record', async () => {
    runMicrovm = async () => {
      throw Object.assign(new Error('quota'), { name: 'ServiceQuotaExceededException' });
    };
    const failed = await createLauncher(deps)(request());
    expect(failed).toMatchObject({ status: 500, disposition: 'launch_failed' });
    expect((await store.getJob(failed.jobId!))?.status).toBe('finished');

    runMicrovm = async (input) => {
      runs.push(input);
      return { microvmId: 'mvm-0002' };
    };
    expect((await createLauncher(deps)(request())).disposition).toBe('launched');
  });

  it('retries VM registration and retires the known VM when registration remains unavailable', async () => {
    const attach = vi.spyOn(store, 'attachMicrovm').mockRejectedValueOnce(new Error('throttled'));
    const ok = await createLauncher(deps)(request());
    expect(ok.disposition).toBe('launched');
    expect(attach).toHaveBeenCalledTimes(2);
    expect((await store.getJob(ok.jobId!))?.microvmId).toBe('mvm-0001');

    attach.mockRejectedValue(new Error('down'));
    const logged: Record<string, unknown>[] = [];
    const { createJobStopper } = await import('./stop.js');
    const terminate = vi.fn(async () => {});
    const stop = createJobStopper({ store, terminateMicrovm: terminate, microvmState: async () => 'TERMINATED', now: () => NOW, log: () => {} });
    const second = await createLauncher({ ...deps, stopJob: stop.advance, log: (e) => logged.push(e) })(request({}, 'delivery-3'));
    expect(second.disposition).toBe('launch_failed');
    expect(terminate).toHaveBeenCalledWith('mvm-0001');
    expect((await store.getJob(second.jobId!))?.stop).toMatchObject({ executionMicrovmId: 'mvm-0001', confirmedAt: NOW });
    expect((await store.listActiveJobs()).map((j) => j.jobId)).not.toContain(second.jobId);
    expect(logged.some((e) => String(e.warning).includes('could not record the microVM'))).toBe(true);
  });
  it('keeps a stopped late VM recoverable when attachment and initial termination both fail', async () => {
    const { createJobStopper } = await import('./stop.js');
    let state = 'RUNNING';
    const terminate = vi.fn().mockRejectedValueOnce(new Error('AWS unavailable')).mockImplementation(async () => { state = 'TERMINATED'; });
    const stop = createJobStopper({ store, terminateMicrovm: terminate, microvmState: async () => state, now: () => NOW, log: () => {} });
    vi.spyOn(store, 'attachMicrovm').mockRejectedValue(new Error('temporary table write failure'));
    runMicrovm = async (input) => { await stop.request(55, input.clientToken, 'pat', 'emergency stop'); return { microvmId: 'mvm-late' }; };
    const out = await createLauncher({ ...deps, stopJob: stop.advance })(request());
    const job = (await store.getJob(out.jobId!))!;
    expect(job.microvmId).toBeUndefined();
    expect(job.stop).toMatchObject({ executionMicrovmId: 'mvm-late', by: 'pat', reason: 'emergency stop' });
    expect(await store.listActiveJobs()).toHaveLength(1);
    const reconcile = createReconciler({ store, stop, microvmState: async () => state, now: () => NOW, log: () => {} });
    expect(await reconcile()).toMatchObject({ released: [job.jobId], failed: 0 });
    expect(terminate).toHaveBeenLastCalledWith('mvm-late');
    expect(await store.listActiveJobs()).toHaveLength(0);
  });

  it("reads the tenant and its active config strongly consistently, and the claim is held by the job's id", async () => {
    const getTenant = vi.spyOn(store, 'getTenant');
    const getConfigVersion = vi.spyOn(store, 'getConfigVersion');
    const claim = vi.spyOn(store, 'claimDelivery');
    const ok = await createLauncher(deps)(request());
    expect(getTenant).toHaveBeenCalledWith(55, { consistent: true });
    expect(getConfigVersion).toHaveBeenCalledWith(55, 1, { consistent: true });
    expect(claim).toHaveBeenCalledWith(55, 'delivery-1', NOW + PRELAUNCH_CLAIM_MS, ok.jobId);
  });

  describe('a launch that stops partway (review fix on #80)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const brokerFor = () =>
      createBroker({
        store,
        loadSettings: async () => null,
        github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
        assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3_600_000).toISOString() }),
        terminateMicrovm: vi.fn(async () => {}),
        microvmState: async () => 'TERMINATING',
        policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
        now: () => Date.now(),
      });

    it('blocks a redelivery only until its short claim runs out, when no job got started', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      // The Lambda's deadline hits during RunMicrovm: nothing after it runs, not even the catch.
      const stuck = createLauncher({ ...deps, now: () => Date.now(), runMicrovm: () => new Promise(() => {}) });
      void stuck(request());
      await vi.waitFor(() => expect(Object.keys(events)).toHaveLength(1));
      expect(await createLauncher({ ...deps, now: () => Date.now() })(request())).toMatchObject({ status: 200, disposition: 'duplicate' });

      vi.setSystemTime(NOW + PRELAUNCH_CLAIM_MS + 1_000);
      expect((await createLauncher({ ...deps, now: () => Date.now() })(request())).disposition).toBe('launched');
    });

    it('a job that started holds the claim for its lifetime; one that starts after a redelivery took it does not run', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const launch = createLauncher({ ...deps, now: () => Date.now() });
      const broker = brokerFor();
      const tokenOf = (i: number) => (JSON.parse(runs[i]!.runHookPayload) as { broker: { jobToken: string } }).broker.jobToken;

      const first = await launch(request());
      expect((await broker({ action: 'start', jobId: first.jobId, token: tokenOf(0) })).ok).toBe(true);
      vi.setSystemTime(NOW + PRELAUNCH_CLAIM_MS + 60_000);
      expect(await launch(request())).toMatchObject({ status: 200, disposition: 'duplicate' });

      // A slow job: its claim ran out before it started, and the redelivery's job took it.
      const slow = await launch(request({}, 'delivery-2'));
      vi.setSystemTime(NOW + 2 * PRELAUNCH_CLAIM_MS + 120_000);
      const redelivered = await launch(request({}, 'delivery-2'));
      expect(redelivered.disposition).toBe('launched');
      expect(await broker({ action: 'start', jobId: slow.jobId, token: tokenOf(1) })).toEqual({ ok: false, error: 'refused' });
      expect((await broker({ action: 'start', jobId: redelivered.jobId, token: tokenOf(2) })).ok).toBe(true);
    });
  });

  describe('quotas and the kill switch', () => {
    const day = new Date(NOW).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const ONE_AT_A_TIME = { concurrentJobs: 1, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 };

    it('starts nothing while the kill switch is on, and claims nothing', async () => {
      let engaged = true;
      const launch = createLauncher({ ...deps, killSwitch: { engaged: async () => engaged } });
      expect(await launch(request())).toMatchObject({ status: 200, disposition: 'kill_switch' });
      expect(runs).toEqual([]);
      engaged = false;
      expect((await launch(request())).disposition).toBe('launched');
    });

    it('records the job\'s slots and the microVM time it reserves', async () => {
      const result = await createLauncher(deps)(request());
      expect(await store.getJob(result.jobId!)).toMatchObject({ tenantSlot: 0, platformSlot: expect.any(Number), reservedSeconds: 10800 });
      expect(await store.getUsage(55, day, month)).toMatchObject({ jobsToday: 1, jobsThisMonth: 1 });
    });

    it('throttles a delivery over a quota: nothing started, the claim given up, one comment a day on the issue', async () => {
      const notices: ThrottleNotice[] = [];
      const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, notifyThrottled: async (n) => void notices.push(n) });
      const first = await launch(request());
      expect(first.disposition).toBe('launched');

      expect(await launch(request({}, 'delivery-2'))).toMatchObject({ status: 200, disposition: 'throttled' });
      expect(await launch(request({}, 'delivery-3'))).toMatchObject({ status: 200, disposition: 'throttled' });
      expect(runs).toHaveLength(1);
      expect(notices).toEqual([{ installationId: 55, repository: 'acme/web', repositoryId: 9, issue: 12, limit: 'concurrent_jobs', quotas: ONE_AT_A_TIME }]);
      // Another issue gets its own comment.
      await launch(request({ issue: { number: 13 } }, 'delivery-4'));
      expect(notices.map((n) => n.issue)).toEqual([12, 13]);
      expect((await store.getUsage(55, day, month)).throttledThisMonth).toBe(3);

      // Once the first job is done, redelivering a throttled delivery starts it.
      const job = (await store.getJob(first.jobId!))!;
      await store.releaseJobSlots(job);
      expect((await launch(request({}, 'delivery-2'))).disposition).toBe('launched');
    });

    it("applies the tenant's overrides over the stack's defaults", async () => {
      await store.setTenantLimits(55, { jobsPerDay: 1 });
      const notices: ThrottleNotice[] = [];
      const launch = createLauncher({ ...deps, notifyThrottled: async (n) => void notices.push(n) });
      expect((await launch(request())).disposition).toBe('launched');
      expect(await launch(request({}, 'delivery-2'))).toMatchObject({ status: 200, disposition: 'throttled' });
      expect(notices[0]).toMatchObject({ limit: 'jobs_per_day', quotas: { jobsPerDay: 1, concurrentJobs: 10 } });
    });

    it('a comment that fails is only logged', async () => {
      const logged: Record<string, unknown>[] = [];
      const launch = createLauncher({
        ...deps,
        quotas: ONE_AT_A_TIME,
        log: (e) => logged.push(e),
        notifyThrottled: async () => {
          throw new Error('GitHub is down');
        },
      });
      await launch(request());
      expect(await launch(request({}, 'delivery-2'))).toMatchObject({ status: 200, disposition: 'throttled' });
      expect(logged.some((e) => String(e.warning).includes('could not comment on the issue: GitHub is down'))).toBe(true);
    });

    it("holds a confirmed launch's capacity until Lambda shows its microVM terminated, even if its start never commits", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      try {
        const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now() });
        const first = await launch(request());
        expect(first.disposition).toBe('launched');
        const { jobToken } = (JSON.parse(runs[0]!.runHookPayload) as { broker: { jobToken: string } }).broker;
        let engaged = true;
        let state: string | null = 'RUNNING';
        const broker = createBroker({
          store,
          loadSettings: async () => null,
          github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
          assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3_600_000).toISOString() }),
          terminateMicrovm: vi.fn(async () => {
            throw new Error('throttled');
          }),
          microvmState: async () => state,
          policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
          killSwitch: { engaged: async () => engaged },
          now: () => Date.now(),
        });
        // Refused by the kill switch, and its terminate fails: the microVM runs on.
        expect(await broker({ action: 'start', jobId: first.jobId, token: jobToken })).toEqual({ ok: false, error: 'refused' });
        await expect(broker({ action: 'terminate', jobId: first.jobId, token: jobToken })).rejects.toThrow('throttled');

        // Well past the launcher's five minutes, its slot is still held, and reconciliation sees it.
        vi.setSystemTime(NOW + 4 * PRELAUNCH_CLAIM_MS);
        expect(await launch(request({}, 'delivery-2'))).toMatchObject({ status: 200, disposition: 'throttled' });
        const reconcile = createReconciler({ store, microvmState: async () => state, log: () => {} });
        expect(await reconcile()).toMatchObject({ released: [], held: 1 });

        // Terminated: released, and retired, so a delayed start (the kill switch off by now) gets nothing.
        state = 'TERMINATED';
        expect((await reconcile()).released).toEqual([first.jobId]);
        engaged = false;
        expect(await broker({ action: 'start', jobId: first.jobId, token: jobToken })).toEqual({ ok: false, error: 'refused' });
        expect(await broker({ action: 'credentials', jobId: first.jobId, token: jobToken })).toEqual({ ok: false, error: 'refused' });
        expect((await launch(request({}, 'delivery-3'))).disposition).toBe('launched');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reserves the slots for the job\'s lifetime before its microVM exists, so no later write can lose them', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      try {
        // RunMicrovm never answers (the Lambda's deadline): nothing after it runs.
        const stuck = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now(), runMicrovm: () => new Promise(() => {}) });
        void stuck(request());
        await vi.waitFor(async () => expect(await store.listPlatformSlots()).toHaveLength(1));
        // Held to the job's own end (vi.waitFor moves the fake clock a little while it waits).
        const [entry] = await store.listActiveJobs();
        expect(entry).toMatchObject({ phase: 'launching' });
        expect((await store.listPlatformSlots())[0]!.expiresAt).toBe((await store.getJob(entry!.jobId))!.expiresAt);

        // Well past the launcher's five minutes: still taken, and the job still reconciled.
        vi.setSystemTime(NOW + 4 * PRELAUNCH_CLAIM_MS);
        const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now() });
        expect(await launch(request({}, 'delivery-2'))).toMatchObject({ status: 200, disposition: 'throttled' });
        expect(await store.listActiveJobs()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconciliation holds a running job's slots again, but never a job released while it looked", async () => {
      const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME });
      const first = await launch(request());
      const job = (await store.getJob(first.jobId!))!;
      // Its slots went missing (say, a delete that should not have happened): held again.
      await store.releaseJobSlots(job);
      expect(await createReconciler({ store, microvmState: async () => 'RUNNING', log: () => {} })()).toMatchObject({ held: 1 });
      expect((await store.listPlatformSlots()).map((s) => s.jobId)).toEqual([first.jobId]);

      // Released (by the broker's terminate, say) while reconciliation waits on Lambda: its stale
      // hold must not bring the slots back.
      const reconcile = createReconciler({
        store,
        microvmState: async () => {
          await store.releaseJob(job);
          return 'RUNNING';
        },
        log: () => {},
      });
      await reconcile();
      expect(await store.listPlatformSlots()).toEqual([]);
      expect(await store.listActiveJobs()).toEqual([]);
      expect((await launch(request({}, 'delivery-2'))).disposition).toBe('launched');
    });

    it('reclaims a reservation whose launch stopped before it asked for a microVM', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      try {
        const reconcile = () => createReconciler({ store, microvmState: vi.fn(), now: () => Date.now(), log: () => {} })();
        // The Lambda's deadline hits while it writes the event: nothing after the reservation is written.
        const stuck = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now(), putEvent: () => new Promise(() => {}) });
        void stuck(request());
        await vi.waitFor(async () => expect(await store.listActiveJobs()).toHaveLength(1));
        expect((await store.listActiveJobs())[0]).toMatchObject({ phase: 'reserved' });

        // Too soon to tell from a launch still under way: left alone.
        vi.setSystemTime(NOW + 60_000);
        expect((await reconcile()).released).toEqual([]);
        expect(await store.listPlatformSlots()).toHaveLength(1);

        // Past five minutes: reclaimed, the slots and the day's count given back.
        vi.setSystemTime(NOW + 6 * 60_000);
        expect((await reconcile()).released).toHaveLength(1);
        expect(await store.listPlatformSlots()).toEqual([]);
        expect(await store.listActiveJobs()).toEqual([]);
        expect(await store.getUsage(55, new Date(NOW).toISOString().slice(0, 10), new Date(NOW).toISOString().slice(0, 7))).toMatchObject({ jobsToday: 0, jobsThisMonth: 0 });
        expect((await createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now() })(request({}, 'delivery-2'))).disposition).toBe('launched');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a reclaimed reservation retires the job it recorded, which can then never start', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      try {
        // The job is recorded, then the Lambda stops before it marks the launch (no RunMicrovm).
        const markLaunching = store.markLaunching.bind(store);
        store.markLaunching = () => new Promise(() => {});
        const stuck = createLauncher({ ...deps, now: () => Date.now() });
        void stuck(request());
        await vi.waitFor(async () => expect(Object.keys(events)).toHaveLength(1));
        const [entry] = await store.listActiveJobs();
        await vi.waitFor(async () => expect(await store.getJob(entry!.jobId)).not.toBeNull());
        store.markLaunching = markLaunching;

        vi.setSystemTime(NOW + 6 * 60_000);
        expect((await createReconciler({ store, microvmState: vi.fn(), now: () => Date.now(), log: () => {} })()).released).toEqual([entry!.jobId]);
        const job = (await store.getJob(entry!.jobId))!;
        expect(job).toMatchObject({ status: 'finished', outcome: 'launch_failed' });
        expect(typeof job.stopRequestedAt).toBe('number');
        expect(await store.startJob(job, job.expiresAt)).toEqual({ result: 'retired' });
        // Too late to launch: marking it fails, so a launch that woke up now starts nothing.
        await expect(store.markLaunching(job.jobId)).rejects.toThrow('no reservation to launch');
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports an admin's release of a launch it beat as cancelled, not as a failure", async () => {
      // The webhook pauses just before it marks its launch; an admin releases the job meanwhile.
      let resume!: () => void;
      const paused = new Promise<void>((r) => (resume = r));
      const markLaunching = store.markLaunching.bind(store);
      store.markLaunching = async (jobId) => {
        await paused;
        return markLaunching(jobId);
      };
      const pending = createLauncher(deps)(request());
      await vi.waitFor(async () => expect(await store.listActiveJobs()).toHaveLength(1));
      const [entry] = await store.listActiveJobs();
      await vi.waitFor(async () => expect(await store.getJob(entry!.jobId)).not.toBeNull());
      await createAdminService({ store, quotas: deps.quotas, log: () => {} }).releaseJob(entry!.jobId, 'admin:x');

      resume();
      expect(await pending).toMatchObject({ status: 200, disposition: 'cancelled', jobId: entry!.jobId });
      expect(runs).toEqual([]);
      expect(await store.getJob(entry!.jobId)).toMatchObject({ status: 'finished', outcome: 'released_by_admin' });
      const day = new Date(NOW).toISOString().slice(0, 10);
      expect((await store.getUsage(55, day, day.slice(0, 7))).failedThisMonth).toBe(0);
      expect((await store.listRecentJobs(55, 5))[0]).toMatchObject({ status: 'finished', outcome: 'released_by_admin' });
    });

    it('gives the reservation back when the launch fails', async () => {
      runMicrovm = async () => {
        throw new Error('throttled by Lambda');
      };
      const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME });
      expect((await launch(request())).disposition).toBe('launch_failed');
      expect(await store.getUsage(55, day, month)).toMatchObject({ jobsToday: 0, jobsThisMonth: 0 });
      runMicrovm = async (input) => {
        runs.push(input);
        return { microvmId: 'mvm-0002' };
      };
      expect((await launch(request())).disposition).toBe('launched');
    });
  });

  describe('pull request events (the review loop)', () => {
    const loopRules = dispatchRules(
      { dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, review: true, revise: true, workflows: [{ trigger: { label: 'updraft' } }] } } },
      { keysFor: () => ['ANTHROPIC_API_KEY'] },
    );
    beforeEach(async () => {
      const v = await store.createConfigVersion(55, { sha256: 'z', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: loopRules });
      await store.markConfigReady(55, v as number);
      await store.activateConfig(55, v as number);
      await store.putAgentKeyMeta(55, { name: 'ANTHROPIC_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    });
    const prEvent = (over: Record<string, unknown> = {}, deliveryId = 'pr-delivery-1', eventName = 'pull_request_review'): LaunchRequest => {
      const payload = {
        action: 'submitted',
        pull_request: { number: 40, head: { ref: 'updraft/issue-12-abc' } },
        review: { state: 'changes_requested' },
        sender: { login: 'pat' },
        repository: { id: 9, full_name: 'acme/web' },
        ...over,
      };
      return { installationId: 55, deliveryId, eventName, appBot: 'updraft[bot]', body: JSON.stringify(payload), payload };
    };


    describe('subscription PR origin safety', () => {
      let subscriptionEnabled: boolean;
      let originId: string;
      beforeEach(async () => {
        subscriptionEnabled = true;
        deps.native = {
          route: { installationId: 55, repositoryId: 9, repository: 'acme/web',
            labels: ['updraft'], workerId: 'worker-1', microvmId: 'mvm-native', imageVersion: '7',
            controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/test-abcdef' },
          secret: async () => 'worker-control-credential-01234567890123456789',
          enabled: async () => subscriptionEnabled,
        };
        originId = (await createLauncher(deps)(request())).jobId!;
        await store.finishJob(originId, 'succeeded', { at: NOW, detail: { prNumber: 40 } });
        subscriptionEnabled = false;
      });
      it('refuses API fallback for a subscription-originated PR after disabling the mode', async () => {
        expect(await createLauncher(deps)(prEvent())).toMatchObject({ reason: 'native_mode_disabled' });
        expect(runs).toEqual([]);
      });
      it('propagates origin list failures without acknowledging or claiming the delivery', async () => {
        const list = store.listRecentJobs.bind(store);
        store.listRecentJobs = async () => { throw new Error('temporary DynamoDB list failure'); };
        await expect(createLauncher(deps)(prEvent())).rejects.toThrow('temporary DynamoDB list failure');
        expect(runs).toEqual([]);
        expect(await store.getDeliveryClaim(55, 'pr-delivery-1')).toBeNull();
        expect(await store.getDeliveryClaim(55, pullRequestLease(9, 40))).toBeNull();
        store.listRecentJobs = list;
        expect(await createLauncher(deps)(prEvent())).toMatchObject({ reason: 'native_mode_disabled' });
      });
      it('propagates origin read failures before claiming delivery or charging API usage', async () => {
        const getJob = store.getJob.bind(store);
        store.getJob = async (id) => {
          if (id === originId) throw new Error('temporary DynamoDB failure');
          return getJob(id);
        };
        await expect(createLauncher(deps)(prEvent())).rejects.toThrow('temporary DynamoDB failure');
        expect(runs).toEqual([]);
        expect(await store.getDeliveryClaim(55, 'pr-delivery-1')).toBeNull();
        store.getJob = getJob;
        expect(await createLauncher(deps)(prEvent())).toMatchObject({ reason: 'native_mode_disabled' });
      });
      it('refuses API fallback when only the origin summary remains', async () => {
        const getJob = store.getJob.bind(store);
        store.getJob = async (id) => id === originId ? null : getJob(id);
        expect(await createLauncher(deps)(prEvent())).toMatchObject({ reason: 'native_workflow_unknown' });
        expect(runs).toEqual([]);
      });
    });

    it("starts a job for a review asking for changes: the pull request on the job, the event's name, and a start after the lease", async () => {
      const result = await createLauncher(deps)(prEvent());
      expect(result).toMatchObject({ status: 202, disposition: 'launched' });
      const job = (await store.getJob(result.jobId!))!;
      expect(job).toMatchObject({ eventName: 'pull_request_review', pullRequest: 40, repository: 'acme/web' });
      expect(job.issue).toBeUndefined();
      expect(job.label).toBeUndefined();
      const hook = JSON.parse(runs[0]!.runHookPayload) as { eventName: string; notBefore?: string };
      expect(hook.eventName).toBe('pull_request_review');
      expect(Date.parse(hook.notBefore!)).toBe(NOW + PR_COALESCE_MS + 1000);
      expect(JSON.parse(events['tenants/55/events/pr-delivery-1/event.json']!)).toMatchObject({ review: { state: 'changes_requested' } });
      const [summary] = await store.listRecentJobs(55, 5);
      expect(summary).toMatchObject({ pullRequest: 40 });
    });

    it('folds the events of a pull request within the lease into its job, and starts the next one after it', async () => {
      const early = createLauncher({ ...deps, now: () => NOW - 60_000 });
      expect((await early(prEvent())).disposition).toBe('launched');
      // That lease is over: the next event starts a job, and holds the pull request for a few seconds.
      const launch = createLauncher(deps);
      expect((await launch(prEvent({}, 'pr-delivery-2'))).disposition).toBe('launched');
      expect(await launch(prEvent({ action: 'synchronize' }, 'pr-delivery-3', 'pull_request'))).toMatchObject({ status: 200, disposition: 'coalesced', message: expect.stringMatching(/#40/) });
      expect(runs).toHaveLength(2);
      // The coalesced delivery holds no claim: redelivered later, it starts a job of its own.
      expect(await store.claimDelivery(55, 'pr-delivery-3', NOW + 1000, 'probe')).toBe(true);
      // Another pull request is not held up.
      expect((await launch(prEvent({ pull_request: { number: 41, head: { ref: 'updraft/issue-13-def' } } }, 'pr-delivery-4'))).disposition).toBe('launched');
    });

    it('gives the lease back when the launch fails, so a redelivery is not coalesced away', async () => {
      runMicrovm = async () => {
        throw Object.assign(new Error('nope'), { name: 'ServiceException' });
      };
      expect(await createLauncher(deps)(prEvent())).toMatchObject({ status: 500, disposition: 'launch_failed' });
      expect(await store.claimDelivery(55, pullRequestLease(9, 40), NOW + 1000, 'probe')).toBe(true);
    });

    it('starts nothing for what the rules refuse, and says why', async () => {
      const launch = createLauncher(deps);
      expect(await launch(prEvent({ review: { state: 'commented' } }))).toMatchObject({ disposition: 'not_dispatched', reason: 'comment_review' });
      expect(await launch(prEvent({ sender: { login: 'updraft[bot]' } }))).toMatchObject({ disposition: 'not_dispatched', reason: 'own_event' });
      expect(await launch(prEvent({ pull_request: { number: 40, head: { ref: 'main' } } }))).toMatchObject({ disposition: 'not_dispatched', reason: 'not_updraft_pr' });
      expect(await launch(prEvent({ action: 'opened' }, 'x', 'pull_request'))).toMatchObject({ disposition: 'ignored' });
      expect(runs).toEqual([]);
    });

    describe("the keys of the workflow that started the pull request", () => {
      // Claude on `updraft`, Codex on `codex`; only the Anthropic key is set.
      beforeEach(async () => {
        const v = await store.createConfigVersion(55, { sha256: 'k', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: dispatchRules(
          { dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, review: true, revise: true, workflows: [{ trigger: { label: 'updraft' } }, { trigger: { label: 'codex' } }] } } },
          { keysFor: (_repo, wf) => ((wf.trigger as { label: string }).label === 'codex' ? ['CODEX_API_KEY'] : ['ANTHROPIC_API_KEY']) },
        ) });
        await store.markConfigReady(55, v as number);
        await store.activateConfig(55, v as number);
      });
      const onIssue = (issue: number, over: Record<string, unknown> = {}, deliveryId = `pr-of-${issue}`) => prEvent({ pull_request: { number: 40 + issue, head: { ref: `updraft/issue-${issue}-job_abc` } }, ...over }, deliveryId);
      // A finished issue job of `label` that opened pull request `pr`.
      let n = 0;
      // Under the active version, unless `version` says it was an earlier one.
      const opened = async (label: string, issue: number, pr: number, agentKeys = [label === 'codex' ? 'CODEX_API_KEY' : 'ANTHROPIC_API_KEY'], version?: number) => {
        const jobId = `job_opened${String(++n).padStart(4, '0')}`;
        const configVersion = version ?? (await store.getTenant(55))!.activeConfigVersion!;
        await store.putJob({ jobId, tokenHash: 'x', installationId: 55, repository: 'acme/web', repositoryId: 9, configVersion, deliveryId: `d-${jobId}`, eventName: 'issues', status: 'launched', createdAt: new Date(NOW + n).toISOString(), expiresAt: NOW + 3_600_000, label, issue, agentKeys });
        await store.finishJob(jobId, 'succeeded', { at: NOW + n, detail: { prNumber: pr, prUrl: `https://github.com/acme/web/pull/${pr}` } });
      };

      it("checks only that workflow's keys: a Codex workflow without its key does not hold up a Claude pull request", async () => {
        await opened('updraft', 12, 52);
        const result = await createLauncher(deps)(onIssue(12));
        expect(result.disposition).toBe('launched');
        expect(await store.getJob(result.jobId!)).toMatchObject({ label: 'updraft', agentKeys: ['ANTHROPIC_API_KEY'], pullRequest: 52 });
      });

      it('matches the pull request itself, not its issue: one issue, two pull requests from two workflows', async () => {
        // Issue 12 opened #52 with Claude, and later #53 with Codex: a review of #52 is Claude's.
        await opened('updraft', 12, 52);
        await opened('codex', 12, 53);
        const launch = createLauncher(deps);
        expect((await launch(onIssue(12))).disposition).toBe('launched');
        expect(await launch(prEvent({ pull_request: { number: 53, head: { ref: 'updraft/issue-12-job_def' } } }, 'pr-53'))).toMatchObject({ disposition: 'missing_key', message: 'CODEX_API_KEY is not set: add it under Agent keys' });
        expect((await store.listRefusals(55, 5))[0]).toMatchObject({ issue: 53 });
      });

      it('takes the keys the opening job ran with when two workflows share its label, for different actors', async () => {
        // `implement` routes pat to Claude and sam to Codex; only the Claude key is set.
        const v = await store.createConfigVersion(55, { sha256: 's', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: dispatchRules(
          { repositories: { 'acme/web': { id: 9, review: true, revise: true, workflows: [
            { trigger: { label: 'implement' }, allowedActors: ['pat'], agent: 'claude' },
            { trigger: { label: 'implement' }, allowedActors: ['sam'], agent: 'codex' },
          ] } } },
          { keysFor: (_repo, wf) => (wf.agent === 'codex' ? ['CODEX_API_KEY'] : ['ANTHROPIC_API_KEY']) },
        ) });
        await store.markConfigReady(55, v as number);
        await store.activateConfig(55, v as number);
        const launch = createLauncher(deps);
        const issueJob = await launch(request({ label: { name: 'implement' } }, 'pat-issue'));
        expect(issueJob.disposition).toBe('launched');
        await store.finishJob(issueJob.jobId!, 'succeeded', { at: NOW, detail: { prNumber: 40, prUrl: 'https://github.com/acme/web/pull/40' } });
        const review = await launch(prEvent({}, 'pat-review'));
        expect(review.disposition).toBe('launched');
        expect(await store.getJob(review.jobId!)).toMatchObject({ label: 'implement', agentKeys: ['ANTHROPIC_API_KEY'] });
      });

      it('leaves the keys to the job once the configuration was republished: neither the old keys nor the label decide', async () => {
        // #52 was opened under version 1 by a workflow that ran Kiro; `updraft` runs Claude now.
        await opened('updraft', 12, 52, ['KIRO_API_KEY'], 1);
        const republished = await createLauncher(deps)(onIssue(12));
        expect(republished.disposition).toBe('launched');
        expect((await store.getJob(republished.jobId!))?.agentKeys).toBeUndefined();
        // #53's workflow moved to another label, and `codex` (once its) is now a Codex workflow
        // whose key is not set: the old label does not hold #53 up.
        await opened('codex', 13, 53, ['ANTHROPIC_API_KEY'], 1);
        const relabeled = await createLauncher(deps)(onIssue(13));
        expect(relabeled.disposition).toBe('launched');
        expect((await store.getJob(relabeled.jobId!))?.agentKeys).toBeUndefined();
      });

      it("keeps the workflow across the loop's own jobs: the next event of the pull request finds it on the last one", async () => {
        await opened('updraft', 12, 52);
        const launch = createLauncher({ ...deps, now: () => NOW - 60_000 });
        const first = await launch(onIssue(12));
        expect((await store.getJob(first.jobId!))?.label).toBe('updraft');
        // The issue job's record is gone; the loop job still names the workflow.
        const fresh = createMemoryStore();
        await fresh.putTenantWithMember(tenant(), { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
        const active = (await store.getConfigVersion(55, (await store.getTenant(55))!.activeConfigVersion!))!;
        const v = (await fresh.createConfigVersion(55, { sha256: 'k', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: active.dispatch! })) as number;
        await fresh.markConfigReady(55, v);
        await fresh.activateConfig(55, v);
        await fresh.putAgentKeyMeta(55, { name: 'ANTHROPIC_API_KEY', updatedAt: 't', updatedBy: 'pat' });
        // Its version there is the fresh store's active one (versions are numbered per store).
        await fresh.putJob({ ...(await store.getJob(first.jobId!))!, configVersion: v });
        const next = await createLauncher({ ...deps, store: fresh })(onIssue(12, {}, 'pr-again'));
        expect(await fresh.getJob(next.jobId!)).toMatchObject({ label: 'updraft', agentKeys: ['ANTHROPIC_API_KEY'] });
      });

      it('needs no key to close, and leaves the keys to the job when no kept job opened the pull request', async () => {
        const launch = createLauncher(deps);
        // Only the issue is on record, not which pull request it opened: nothing names the workflow.
        await store.putJob({ jobId: 'job_noprrecord', tokenHash: 'x', installationId: 55, repository: 'acme/web', repositoryId: 9, configVersion: 1, deliveryId: 'd-np', eventName: 'issues', status: 'launched', createdAt: new Date(NOW).toISOString(), expiresAt: NOW + 3_600_000, label: 'codex', issue: 30 });
        const unknown = await launch(onIssue(30));
        expect(unknown.disposition).toBe('launched');
        expect((await store.getJob(unknown.jobId!))?.agentKeys).toBeUndefined();
        const close = await launch({ ...onIssue(32, { action: 'closed' }, 'close-32'), eventName: 'pull_request' });
        expect(close.disposition).toBe('launched');
        expect((await store.getJob(close.jobId!))?.agentKeys).toBeUndefined();
      });
    });

    describe('an event that finds the pull request held', () => {
      const lease = pullRequestLease(9, 40);
      const quick = { coalesceConfirmMs: 5, coalescePollMs: 1 };

      it('is not acknowledged while the job holding it is not confirmed launched: 503, and it can be redelivered', async () => {
        await store.claimDelivery(55, lease, NOW + PR_COALESCE_MS, 'job_ghost');
        const result = await createLauncher({ ...deps, ...quick })(prEvent());
        expect(result).toMatchObject({ status: 503, disposition: 'coalesce_unconfirmed' });
        expect(runs).toEqual([]);
        expect(await store.claimDelivery(55, 'pr-delivery-1', NOW + 1000, 'probe')).toBe(true);
      });

      it("takes the pull request over when the holder's launch fails and gives it back, and launches itself", async () => {
        await store.claimDelivery(55, lease, NOW + PR_COALESCE_MS, 'job_ghost');
        const read = store.getDeliveryClaim.bind(store);
        let looks = 0;
        store.getDeliveryClaim = async (id, key) => {
          // The holder's launch fails after a look or two, and it gives the lease back.
          if (++looks === 2) await store.releaseDelivery(55, lease, 'job_ghost');
          return read(id, key);
        };
        const result = await createLauncher({ ...deps, ...quick, coalesceConfirmMs: 50 })(prEvent());
        expect(result.disposition).toBe('launched');
        expect(runs).toHaveLength(1);
        expect((await store.getDeliveryClaim(55, lease))?.jobId).toBe(result.jobId);
      });
    });

    it("comments on the pull request, in its own words, when a quota stops its event", async () => {
      const notices: ThrottleNotice[] = [];
      await store.setTenantLimits(55, { jobsPerDay: 1 });
      const launch = createLauncher({ ...deps, notifyThrottled: async (n) => void notices.push(n) });
      expect((await launch(request())).disposition).toBe('launched');
      expect(await launch(prEvent())).toMatchObject({ disposition: 'throttled' });
      expect(notices).toEqual([expect.objectContaining({ issue: 40, pullRequest: true, limit: 'jobs_per_day' })]);
      // Its lease went with it: once there is room, the next event is not coalesced into nothing.
      expect(await store.claimDelivery(55, pullRequestLease(9, 40), NOW + 1000, 'probe')).toBe(true);
    });
  });

  it('refuses a delivery id that cannot be part of an S3 key', async () => {
    expect(await createLauncher(deps)(request({}, '../../x'))).toEqual({ status: 400, disposition: 'bad_delivery_id' });
  });
});

describe('runHookPayload console origin', () => {
  const job = { jobId: 'job_abc12345', token: 't', deliveryId: 'd', launchedAt: NOW };
  it('carries only a valid https origin, for the same retries and native runs as the job itself', () => {
    expect(runHookPayload({ ...SETTINGS, consoleOrigin: 'https://updraft.readysetcloud.io/x?y' }, job)).toMatchObject({ consoleOrigin: 'https://updraft.readysetcloud.io' });
    expect(runHookPayload({ ...SETTINGS, consoleOrigin: 'https://staging.example.com' }, { ...job, retry: true })).toMatchObject({ consoleOrigin: 'https://staging.example.com', retry: true });
    for (const bad of [undefined, '', 'http://x.io', 'not a url', 'https://u:p@x.io']) {
      expect(runHookPayload({ ...SETTINGS, consoleOrigin: bad }, job)).not.toHaveProperty('consoleOrigin');
    }
  });
});
