import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jobAgentKeys } from '../broker/broker.js';
import { waitingId } from '../native/sessions.js';
import { createMemoryStore, type Tenant } from '../store/store.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createMemoryWorkflowStore } from '../workflows/store.js';
import { createWorkflowRecorder } from '../workflows/recorder.js';
import { deliveryFromLaunch } from './deliveries.js';
import { refusalComment, refusalMarker } from './notices.js';
import { createLauncher, signInWait, waitingComment, type LaunchDeps, type LaunchRequest, type NativeLaunch, type NativeReadiness } from './launch.js';

// Codex on a ChatGPT plan routes to its own managed session (#125): exclusive with Claude's session
// and with the API-key path, one job per label, and never handed CODEX_API_KEY.

const NOW = Date.now();
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/root';
const trigger = { repositoryId: 9, repository: 'acme/web', label: 'updraft' };
const tenant: Tenant = { installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '2026-11-19T00:00:00.000Z', createdBy: 's' };

function binding(provider: 'claude' | 'codex', opts: { enabled?: boolean; triggers?: typeof trigger[]; readiness?: NativeReadiness } = {}): NativeLaunch {
  return {
    route: { installationId: 55, workerId: provider === 'codex' ? 'managed-codex-55' : 'managed-55', microvmId: `mvm-${provider}`, imageVersion: '7', generation: `${provider}-gen`, controlSecretArn: SECRET_ARN },
    ...(provider === 'codex' ? { provider } : {}),
    secret: async () => `${provider}-scoped-worker-secret-0123456789`,
    mode: async () => ({ enabled: opts.enabled ?? true, revision: 1, routingVersion: 4, triggers: opts.triggers ?? [trigger] }),
    readiness: vi.fn(async () => opts.readiness ?? 'ready'),
  };
}

describe('Codex subscription routing', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let deps: LaunchDeps;
  const request = (deliveryId = 'delivery-1', overrides: Partial<LaunchRequest> = {}): LaunchRequest => {
    const payload = { action: 'labeled', issue: { number: 12 }, label: { name: 'updraft' }, sender: { login: 'pat' }, repository: { id: 9, full_name: 'acme/web' } };
    return { installationId: 55, deliveryId, body: JSON.stringify(payload), payload, ...overrides };
  };
  async function publish(keys: string[]) {
    const version = await store.createConfigVersion(55, { sha256: keys.join(), files: [], publishedBy: 's', publishedAt: '', dispatch: dispatchRules({
      dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
    }, { keysFor: () => keys }) });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
  }
  const runs: unknown[] = [];

  beforeEach(async () => {
    store = createMemoryStore();
    runs.length = 0;
    await store.putTenantWithMember(tenant, { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    deps = {
      store,
      settings: { region: 'us-east-1', bucket: 'b', imageArn: 'arn:image', executionRoleArn: 'arn:role', ingressConnectorArn: 'in', egressConnectorArn: 'out',
        logGroup: 'lg', brokerFunctionName: 'broker', maximumDurationSeconds: 10800, watchdogReserveSeconds: 600 },
      imageVersion: async () => '3',
      putEvent: async () => {},
      runMicrovm: async (input) => { runs.push(input); return { microvmId: 'mvm-api' }; },
      quotas: { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 },
      now: () => NOW,
      log: () => {},
      retryDelayMs: 1,
    };
  });

  it('runs a Codex workflow on the Codex session with no Codex key set, and hands the job no CODEX_API_KEY', async () => {
    await publish(['CODEX_API_KEY', 'KIRO_API_KEY']);
    await store.putAgentKeyMeta(55, { name: 'KIRO_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => binding('codex');
    const result = await createLauncher(deps)(request());
    expect(result).toMatchObject({ status: 202, disposition: 'launched', jobId: waitingId(55, 'delivery-1', 'codex') });
    const job = (await store.getJob(result.jobId!))!;
    expect(job.native).toMatchObject({ workerId: 'managed-codex-55', generation: 'codex-gen', routingVersion: 4 });
    expect(job.agentKeys).toEqual(['KIRO_API_KEY']);
    expect(jobAgentKeys(job)).toEqual(['KIRO_API_KEY']);
    expect(runs).toEqual([]);
  });

  it('decides Claude first: a workflow needing both keys on a trigger both chose is one Claude job, never two', async () => {
    await publish(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
    await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    const codex = binding('codex');
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => codex;
    const launch = createLauncher(deps);
    const result = await launch(request());
    expect(result).toMatchObject({ disposition: 'launched', jobId: waitingId(55, 'delivery-1') });
    expect((await store.getJob(result.jobId!))!.native?.workerId).toBe('managed-55');
    // The Claude job keeps the Codex reviewer's key (BYOK); only its own provider's key is dropped.
    expect((await store.getJob(result.jobId!))!.agentKeys).toEqual(['CODEX_API_KEY']);
    expect(codex.readiness).not.toHaveBeenCalled();
    // A redelivery of the same label event starts nothing more.
    expect(await launch(request())).toMatchObject({ disposition: 'duplicate' });
    expect((await store.listActiveJobs()).map((j) => j.jobId)).toEqual([result.jobId]);
    expect(runs).toEqual([]);
  });

  it('routes a Codex-only workflow to Codex even where the Claude session lists the same trigger', async () => {
    await publish(['CODEX_API_KEY']);
    const claude = binding('claude');
    deps.resolveNative = async () => claude;
    deps.resolveCodex = async () => binding('codex');
    const result = await createLauncher(deps)(request());
    expect((await store.getJob(result.jobId!))!.native?.workerId).toBe('managed-codex-55');
    expect(claude.readiness).not.toHaveBeenCalled();
  });

  it('keeps the API-key path when Codex routing is off or the trigger is not chosen, and never falls to Claude', async () => {
    await publish(['CODEX_API_KEY']);
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => binding('codex', { enabled: false });
    expect(await createLauncher(deps)(request('off-1'))).toMatchObject({ reason: 'missing_key' });
    deps.resolveCodex = async () => binding('codex', { triggers: [{ ...trigger, label: 'other' }] });
    expect(await createLauncher(deps)(request('off-2'))).toMatchObject({ reason: 'missing_key' });
    await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    const result = await createLauncher(deps)(request('off-3'));
    expect(result).toMatchObject({ disposition: 'launched' });
    expect((await store.getJob(result.jobId!))!.native).toBeUndefined();
    expect((await store.getJob(result.jobId!))!.agentKeys).toEqual(['CODEX_API_KEY']);
    expect(runs).toHaveLength(1);
  });

  it('never moves work pinned to the Claude worker onto Codex, nor Codex work onto Claude', async () => {
    await publish(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
    deps.resolveNative = async () => binding('claude', { enabled: false });
    deps.resolveCodex = async () => binding('codex');
    expect(await createLauncher(deps)(request('retry-claude', { retryRuntime: { workerId: 'managed-55' } })))
      .toMatchObject({ reason: 'native_mode_disabled' });
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => binding('codex', { enabled: false });
    expect(await createLauncher(deps)(request('retry-codex', { retryRuntime: { workerId: 'managed-codex-55' } })))
      .toMatchObject({ reason: 'native_mode_disabled' });
    expect(await store.listActiveJobs()).toEqual([]);
  });

  it('parks a Codex job for a ChatGPT sign-in with Codex\'s words, and a redelivery finds that wait', async () => {
    await publish(['CODEX_API_KEY']);
    const id = waitingId(55, 'delivery-1', 'codex');
    let parked = false;
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => binding('codex', { readiness: 'not-connected' });
    deps.waitForClaude = vi.fn(async () => { parked = true; return id; });
    deps.parkedClaude = vi.fn(async (_req: LaunchRequest, provider?: string) => (parked && provider === 'codex' ? id : undefined));
    const workflows = createMemoryWorkflowStore();
    deps.workflows = createWorkflowRecorder({ store: workflows, log: () => {} });
    const launch = createLauncher(deps);
    expect(await launch(request())).toMatchObject({ reason: 'native_waiting_for_sign_in', message: 'Waiting for Codex to be signed in with ChatGPT', jobId: id });
    expect(deps.waitForClaude).toHaveBeenCalledWith(expect.anything(), 'acme/web', 9, 12, 'not-connected', undefined, 'codex');
    expect(await workflows.getWorkflow(55, '9-i12')).toMatchObject({ stage: 'awaiting-sign-in', message: 'The job waits for Codex to be signed in with ChatGPT before it can start.' });
    // Claude's wait is looked up exactly as before (no provider argument), then Codex's.
    expect(await launch(request())).toMatchObject({ reason: 'native_waiting_for_sign_in', jobId: id, message: 'Open the Codex sign-in request for this delivery' });
    expect(deps.parkedClaude).toHaveBeenCalledWith(expect.anything());
    expect(deps.parkedClaude).toHaveBeenCalledWith(expect.anything(), 'codex');
    expect(deps.waitForClaude).toHaveBeenCalledOnce();
  });

  it('leaves Claude\'s dispatch unchanged when a Codex session is deployed but chose nothing', async () => {
    await publish(['ANTHROPIC_API_KEY']);
    deps.resolveNative = async () => binding('claude', { readiness: 'auth-required' });
    deps.resolveCodex = async () => binding('codex', { triggers: [] });
    deps.waitForClaude = vi.fn(async () => 'job_waiting000000000');
    expect(await createLauncher(deps)(request())).toMatchObject({ reason: 'native_waiting_for_sign_in', message: 'Waiting for Claude subscription sign-in' });
    expect(deps.waitForClaude).toHaveBeenCalledWith(expect.anything(), 'acme/web', 9, 12, 'auth-required', undefined);
  });
});

describe('per-provider waiting words', () => {
  const link = 'https://console.example/installations/55/codex?request=job_x';
  it('asks for a ChatGPT sign-in on a Codex wait, and keeps Claude\'s sentence as it was', () => {
    expect(waitingComment(link, 'not-connected', undefined, 'codex'))
      .toBe(`Codex needs you to sign in with ChatGPT before this job can start: [sign in from Updraft](${link}) and it starts on its own.`);
    expect(waitingComment(link, 'environment-retiring', 'idle', 'codex'))
      .toBe(`Codex needs you to sign in with ChatGPT again because the previous Codex session ended (it was idle for its whole idle limit): [sign in from Updraft](${link}) and this job starts on its own.`);
    expect(waitingComment(link, 'worker-starting', undefined, 'codex')).toBeUndefined();
    expect(waitingComment('L', 'auth-required')).toBe('Claude needs you to sign in before this job can start: [sign in from Updraft](L) and it starts on its own.');
  });
  it('gives the timeline Codex codes and next steps', () => {
    expect(signInWait('reconnect', { readiness: 'environment-retiring', retirement: 'lifetime' }, 'codex')).toMatchObject({
      reason: 'reconnect_required', code: 'codex_session_lifetime', nextAction: expect.stringContaining('Codex page'),
    });
    expect(signInWait('sign-in', { readiness: 'expired' }, 'codex')).toMatchObject({ code: 'codex_expired' });
    expect(signInWait('sign-in', { readiness: 'expired' })).toMatchObject({ code: 'claude_expired', message: 'The job waits for a Claude subscription sign-in before it can start.' });
  });
});

describe('subscription key scoping', () => {
  it('drops only the session provider\'s own key', () => {
    const keys = ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'KIRO_API_KEY'];
    expect(jobAgentKeys({ native: { workerId: 'managed-55' }, agentKeys: keys })).toEqual(['CODEX_API_KEY', 'KIRO_API_KEY']);
    expect(jobAgentKeys({ native: { workerId: 'managed-codex-55' }, agentKeys: keys })).toEqual(['ANTHROPIC_API_KEY', 'KIRO_API_KEY']);
    // A pinned worker is Claude's, as before; a native job without recorded keys gets none.
    expect(jobAgentKeys({ native: { workerId: 'worker-1' }, agentKeys: keys })).toEqual(['CODEX_API_KEY', 'KIRO_API_KEY']);
    expect(jobAgentKeys({ native: { workerId: 'managed-codex-55' } })).toEqual([]);
  });
});

describe('Codex routing failures and explicit providers', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let deps: LaunchDeps;
  const request = (deliveryId = 'delivery-1', overrides: Partial<LaunchRequest> = {}): LaunchRequest => {
    const payload = { action: 'labeled', issue: { number: 12 }, label: { name: 'updraft' }, sender: { login: 'pat' }, repository: { id: 9, full_name: 'acme/web' } };
    return { installationId: 55, deliveryId, body: JSON.stringify(payload), payload, ...overrides };
  };
  async function publish(keys: string[]) {
    const version = await store.createConfigVersion(55, { sha256: keys.join(), files: [], publishedBy: 's', publishedAt: '', dispatch: dispatchRules({
      dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
    }, { keysFor: () => keys }) });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
  }
  const logs: Record<string, unknown>[] = [];
  beforeEach(async () => {
    store = createMemoryStore();
    logs.length = 0;
    await store.putTenantWithMember(tenant, { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    deps = {
      store,
      settings: { region: 'us-east-1', bucket: 'b', imageArn: 'arn:image', executionRoleArn: 'arn:role', ingressConnectorArn: 'in', egressConnectorArn: 'out',
        logGroup: 'lg', brokerFunctionName: 'broker', maximumDurationSeconds: 10800, watchdogReserveSeconds: 600 },
      imageVersion: async () => '3', putEvent: async () => {}, runMicrovm: async () => ({ microvmId: 'mvm-api' }),
      quotas: { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 },
      now: () => NOW, log: (entry) => logs.push(entry), retryDelayMs: 1,
    };
  });

  const throttled = () => Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
  const review = (deliveryId: string, number = 40) => {
    const payload = { action: 'submitted', review: { state: 'changes_requested' }, pull_request: { number, head: { ref: `updraft/issue-12-job_abc${number}` } }, sender: { login: 'pat' }, repository: { id: 9, full_name: 'acme/web' } };
    return { installationId: 55, deliveryId, eventName: 'pull_request_review', body: JSON.stringify(payload), payload } as LaunchRequest;
  };
  async function publishWithReview(keys: string[]) {
    const version = await store.createConfigVersion(55, { sha256: `r${keys.join()}`, files: [], publishedBy: 's', publishedAt: '', dispatch: dispatchRules({
      dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, review: true, revise: true, workflows: [{ trigger: { label: 'updraft' } }] } },
    }, { keysFor: () => keys }) });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
  }

  it('never runs a Codex-keyed issue on the API key while Codex routing cannot be read: it fails retryably', async () => {
    await publish(['CODEX_API_KEY']);
    await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => { throw throttled(); };
    await expect(createLauncher(deps)(request('codex-1'))).rejects.toThrow('throttled');
    // A mode read that fails is the same.
    deps.resolveCodex = async () => ({ ...binding('codex'), mode: async () => { throw throttled(); } });
    await expect(createLauncher(deps)(request('codex-2'))).rejects.toThrow('throttled');
    expect(await store.listActiveJobs()).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ warning: 'codex routing unavailable', name: 'ProvisionedThroughputExceededException' }));
    // Nothing was claimed: the redelivery, once Codex routing reads again, starts it on Codex.
    deps.resolveCodex = async () => binding('codex');
    const result = await createLauncher(deps)(request('codex-1'));
    expect((await store.getJob(result.jobId!))!.native?.workerId).toBe('managed-codex-55');
  });

  it('keeps Claude work, and workflows that never need Codex\'s key, going while Codex routing cannot be read', async () => {
    await publish(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => { throw throttled(); };
    // Claude takes it (decided first): Codex's routing does not matter. Its Codex reviewer stays BYOK.
    await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    const claude = await createLauncher(deps)(request('claude-1'));
    expect((await store.getJob(claude.jobId!))!.native?.workerId).toBe('managed-55');
    // A Kiro-only workflow runs on its own key as before.
    await publish(['KIRO_API_KEY']);
    await store.putAgentKeyMeta(55, { name: 'KIRO_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    const kiro = await createLauncher(deps)(request('kiro-1'));
    expect(kiro).toMatchObject({ disposition: 'launched' });
    expect((await store.getJob(kiro.jobId!))!.native).toBeUndefined();
  });

  it('fails a pull request event whose origin is unknown while Codex routing cannot be read, never handing it every key', async () => {
    await publishWithReview(['CODEX_API_KEY']);
    deps.resolveCodex = async () => { throw throttled(); };
    await expect(createLauncher(deps)(review('review-1'))).rejects.toThrow('throttled');
    expect(await store.listActiveJobs()).toEqual([]);
    // Known to be an API-key job's: it goes on.
    deps.resolveCodex = async () => binding('codex', { triggers: [] });
    await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    const origin = await createLauncher(deps)(request('issue-1'));
    expect((await store.getJob(origin.jobId!))!.native).toBeUndefined();
    await store.finishJob(origin.jobId!, 'succeeded', { at: NOW, detail: { prNumber: 40, prUrl: 'https://github.com/acme/web/pull/40' } });
    deps.resolveCodex = async () => { throw throttled(); };
    expect(await createLauncher(deps)(review('review-2'))).toMatchObject({ disposition: 'launched' });
  });

  it('refuses a Codex-selected trigger as unavailable on an image without Codex, with one notice, never the API key', async () => {
    await publish(['CODEX_API_KEY']);
    await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    const codex = { ...binding('codex'), unavailable: "this deployment's worker image does not support Codex yet" };
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => codex;
    deps.waitForClaude = vi.fn();
    const notices: unknown[] = [];
    deps.notifyRefused = async (n) => { notices.push(n); };
    const reserve = vi.spyOn(store, 'reserveJob');
    const result = await createLauncher(deps)(request());
    expect(result).toMatchObject({ disposition: 'not_dispatched', reason: 'native_worker_unavailable', message: expect.stringContaining('does not support Codex yet') });
    expect(notices).toEqual([expect.objectContaining({ kind: 'codex_unsupported', number: 12, pullRequest: false, missing: [] })]);
    expect(codex.readiness).not.toHaveBeenCalled();
    expect(deps.waitForClaude).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(await store.listActiveJobs()).toEqual([]);
    // A workflow that is not on the ChatGPT plan is unaffected.
    deps.resolveCodex = async () => ({ ...codex, mode: async () => ({ enabled: true, revision: 1, triggers: [{ ...trigger, label: 'other' }] }) });
    const byok = await createLauncher(deps)(request('byok-1'));
    expect(byok).toMatchObject({ disposition: 'launched' });
    expect((await store.getJob(byok.jobId!))!.native).toBeUndefined();
  });

  it('fails work pinned to the Codex worker retryably when Codex routing cannot be read, never rerouting it', async () => {
    await publish(['CODEX_API_KEY']);
    await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => { throw new Error('unavailable'); };
    await expect(createLauncher(deps)(request('pinned', { retryRuntime: { workerId: 'managed-codex-55' } }))).rejects.toThrow('unavailable');
    expect(await store.listActiveJobs()).toEqual([]);
  });

  it('names Codex explicitly on a wait\'s result and workflow, and on the redelivery that finds it', async () => {
    await publish(['CODEX_API_KEY']);
    const id = waitingId(55, 'delivery-1', 'codex');
    let parked = false;
    deps.resolveNative = async () => binding('claude');
    deps.resolveCodex = async () => binding('codex', { readiness: 'auth-required' });
    deps.waitForClaude = vi.fn(async () => { parked = true; return id; });
    deps.parkedClaude = vi.fn(async (_req: LaunchRequest, provider?: string) => (parked && provider === 'codex' ? id : undefined));
    const workflows = createMemoryWorkflowStore();
    deps.workflows = createWorkflowRecorder({ store: workflows, log: () => {} });
    const launch = createLauncher(deps);
    expect(await launch(request())).toMatchObject({ reason: 'native_waiting_for_sign_in', provider: 'codex' });
    expect(await workflows.getWorkflow(55, '9-i12')).toMatchObject({ stage: 'awaiting-sign-in', signInProvider: 'codex' });
    expect(await launch(request())).toMatchObject({ reason: 'native_waiting_for_sign_in', provider: 'codex', jobId: id });
    expect(deliveryFromLaunch({ at: 't', deliveryId: 'd', event: 'issues' }, await launch(request()))).toMatchObject({ reason: 'native_waiting_for_sign_in', jobId: id, provider: 'codex' });
  });

  it('records a Claude wait exactly as before: no provider anywhere', async () => {
    await publish(['ANTHROPIC_API_KEY']);
    deps.resolveNative = async () => binding('claude', { readiness: 'auth-required' });
    deps.waitForClaude = vi.fn(async () => 'job_waiting000000000');
    const workflows = createMemoryWorkflowStore();
    deps.workflows = createWorkflowRecorder({ store: workflows, log: () => {} });
    const result = await createLauncher(deps)(request());
    expect(result).not.toHaveProperty('provider');
    expect(deliveryFromLaunch({ at: 't', deliveryId: 'd', event: 'issues' }, result)).not.toHaveProperty('provider');
    expect(await workflows.getWorkflow(55, '9-i12')).not.toHaveProperty('signInProvider');
  });
});

describe('the image-unsupported notice', () => {
  it('says the image cannot run Codex yet and that no API key was used, once per version', () => {
    const n = { installationId: 55, repository: 'acme/web', repositoryId: 9, number: 12, pullRequest: false, message: 'x', missing: [], configVersion: 3, kind: 'codex_unsupported' as const };
    expect(refusalComment(n)).toContain("this deployment's subscription worker image does not support Codex yet. It was not run on an API key.");
    expect(refusalMarker(n)).toBe('<!-- updraft-refused: codex_unsupported v3 -->');
    expect(refusalMarker({ ...n, kind: undefined, missing: ['CODEX_API_KEY'] })).toBe('<!-- updraft-refused: missing_key v3 CODEX_API_KEY -->');
  });
});
