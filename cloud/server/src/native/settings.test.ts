import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from '../caller.js';
import type { GitHubFlows } from '../flows/github.js';
import { createNativeSettingsService } from './settings.js';
import { nativeRoute, type NativeRoute } from './route.js';
import type { NativeModeStore, NativeStore, Worker } from './store.js';

const route: NativeRoute = {
  installationId: 55,
  repositoryId: 9,
  repository: 'acme/test-repo',
  labels: ['updraft-native-test'],
  workerId: 'worker-1',
  microvmId: 'mvm-native',
  imageVersion: '4',
  controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/test-abcdef',
};
const caller = { sub: 'member' } as Caller;

describe('Claude subscription mode in the installation app', () => {
  const member = vi.fn().mockResolvedValue(undefined);
  const configContext = vi.fn().mockResolvedValue({});
  const github = { member, configContext } as unknown as Pick<GitHubFlows, 'member' | 'configContext'>;
  let enabled: boolean;
  let worker: Worker | null;
  let queued: string[];
  let now: number;
  let mode: NativeModeStore;
  let fenceCommits: boolean;
  let workers: NativeStore;

  beforeEach(() => {
    member.mockClear();
    configContext.mockClear();
    enabled = false;
    now = Date.now();
    queued = [];
    worker = {
      installationId: 55, workerId: 'worker-1', microvmId: 'mvm-native',
      session: 'session-0123456789', imageVersion: '4', workerVersion: '104',
      version: 1, auth: 'connected', heartbeatAt: now,
    };
    mode = {
      enabled: async () => enabled,
      snapshot: async () => ({ enabled, revision: 0 }),
      setEnabled: async (_, __, next) => { enabled = next; return true; },
      fenceForRestart: async () => fenceCommits,
    };
    fenceCommits = true;
    workers = {
      async assign() { return false; },
      async get() { return worker; },
      async put() { return true; },
      async queued() { return queued; },
      async dequeue() {},
    };
  });

  const service = () => createNativeSettingsService({ github, route, mode, workers, now: () => now });

  it('defaults to API-key mode and never removes or reads an API key', async () => {
    const result = await service().view(caller, 55);
    expect(result).toMatchObject({
      configured: true, enabled: false, repository: 'acme/test-repo',
      worker: { status: 'connected', online: true, busy: false },
    });
    expect(member).toHaveBeenCalledWith(caller, 55);
    expect(configContext).not.toHaveBeenCalled();
  });

  it('enables subscription only on a connected worker and supports returning to API keys', async () => {
    const api = service();
    expect(await api.update(caller, 55, true)).toMatchObject({ enabled: true });
    expect(enabled).toBe(true);
    expect(await api.update(caller, 55, false)).toMatchObject({ enabled: false });
    expect(configContext).toHaveBeenCalledTimes(2);
  });

  it('refuses enabling when the worker has not signed in or its heartbeat is stale', async () => {
    const api = service();
    worker!.auth = 'auth-required';
    await expect(api.update(caller, 55, true)).rejects.toThrow('Sign in directly');
    worker!.auth = 'connected';
    now += 61_000;
    await expect(api.update(caller, 55, true)).rejects.toThrow('Sign in directly');
    expect(enabled).toBe(false);
  });

  it('does not switch auth modes while active or queued native work could be stranded', async () => {
    const api = service();
    enabled = true;
    worker!.active = { jobId: 'job_active0000001', until: now + 30_000 };
    await expect(api.update(caller, 55, false)).rejects.toThrow('current subscription job');
    delete worker!.active;
    queued = ['job_queued0000001'];
    await expect(api.update(caller, 55, false)).rejects.toThrow('queued subscription jobs');
    expect(enabled).toBe(true);
  });

  it('accepts a worker binding without a repo and validates routing against published Claude triggers', async () => {
    const { repository, repositoryId, labels, ...binding } = route;
    expect(nativeRoute(JSON.stringify(binding))).toEqual(binding);
    const trigger = { repository: repository!, repositoryId: repositoryId!, label: labels![0]! };
    const tenant = { installationId: 55, activeConfigVersion: 3, status: 'active' };
    member.mockResolvedValueOnce({ tenant });
    configContext.mockResolvedValue({ tenant, repositories: [{ id: repositoryId }] });
    const getConfigVersion = vi.fn().mockResolvedValue({ dispatch: { repositories: {
      [repository!]: { id: repositoryId, keys: ['ANTHROPIC_API_KEY'], triggers: [{ label: trigger.label }] },
      'acme/other': { id: 10, keys: ['CODEX_API_KEY'], triggers: [{ label: trigger.label }] },
    } } });
    const save = vi.spyOn(mode, 'setEnabled');
    const service = createNativeSettingsService({ github, route: binding, mode, workers, store: { getConfigVersion }, now: () => now });
    expect(await service.view(caller, 55)).toMatchObject({ triggers: [], availableTriggers: [trigger] });
    await expect(service.update(caller, 55, true, [{ ...trigger, repositoryId: 10 }])).rejects.toThrow('reachable repositories');
    await service.update(caller, 55, true, [trigger]);
    expect(save).toHaveBeenCalledWith(55, 'worker-1', true, expect.objectContaining({ triggers: [trigger] }));
    configContext.mockResolvedValue({});
  });

  it('only gives an owner a browser grant for an idle, pinned worker waiting for login', async () => {
    const loginGrant = vi.fn().mockResolvedValue({ url: 'wss://worker.on.aws/claude-login', token: 'sample', port: 8081 });
    const service = createNativeSettingsService({ github, route, mode, workers, loginGrant, now: () => now });
    const tenant = { status: 'active' };
    member.mockResolvedValueOnce({ tenant, summary: { role: 'member' } });
    await expect(service.login(caller, 55)).rejects.toThrow('Only installation owners');
    member.mockResolvedValueOnce({ tenant, summary: { role: 'owner' } });
    await expect(service.login(caller, 55)).rejects.toThrow('ready for sign-in');
    worker!.auth = 'auth-required';
    member.mockResolvedValueOnce({ tenant, summary: { role: 'owner' } });
    await expect(service.login(caller, 55)).resolves.toMatchObject({ port: 8081 });
    expect(loginGrant).toHaveBeenCalledOnce();
  });

  it('only starts a waiting request for an active installation owner in that installation', async () => {
    const requestId = 'job_' + 'a'.repeat(16);
    const get = vi.fn(async (id: number, request: string) => id === 55 && request === requestId ? {
      id: requestId, request: { installationId: 55, deliveryId: 'delivery' }, eventKey: 'event.json',
      status: 'waiting' as const, expiresAt: now + 60_000,
    } : undefined);
    const start = vi.fn().mockResolvedValue(undefined);
    const service = createNativeSettingsService({ github, mode, workers, now: () => now, managed: {
      route: async (id) => ({ ...route, installationId: id, workerId: `managed-${id}`, microvmId: 'mvm-pending' }),
      start, sessions: { get }, grant: () => undefined,
    } });
    enabled = true;
    const tenant = { status: 'active' };
    member.mockResolvedValueOnce({ tenant, summary: { role: 'member' } });
    await expect(service.start(caller, 55, requestId)).rejects.toThrow('Only an installation owner');
    member.mockResolvedValueOnce({ tenant, summary: { role: 'owner' } });
    await expect(service.start(caller, 56, requestId)).rejects.toThrow('does not have an active Claude sign-in request');
    member.mockResolvedValueOnce({ tenant, summary: { role: 'owner' } });
    await expect(service.start(caller, 55, requestId)).resolves.toMatchObject({ managed: true });
    expect(start).toHaveBeenCalledExactlyOnceWith(55);
  });

  it('connects an active owner without a waiting issue or enabled routing and preserves mode', async () => {
    member.mockResolvedValue({ tenant: { status: 'active' }, summary: { role: 'owner' } });
    const start = vi.fn();
    const get = vi.fn();
    const api = createNativeSettingsService({ github, mode, workers, managed: {
      route: async (id) => ({ ...route, installationId: id }), start, sessions: { get }, grant: () => undefined,
    } });
    await api.start(caller, 55);
    expect(start).toHaveBeenCalledExactlyOnceWith(55);
    expect(get).not.toHaveBeenCalled();
    expect(enabled).toBe(false);
    member.mockResolvedValue({ tenant: { status: 'suspended' }, summary: { role: 'owner' } });
    await expect(api.start(caller, 55)).rejects.toThrow('permission to connect');
    member.mockResolvedValue({ tenant: { status: 'active' }, summary: { role: 'member' } });
    await expect(api.start(caller, 55)).rejects.toThrow('Only an installation owner');
    expect(start).toHaveBeenCalledTimes(1);
    member.mockResolvedValue(undefined);
  });

  it('reuses restart fencing for expired and offline current-image sessions', async () => {
    member.mockResolvedValue({ tenant: { status: 'active' }, summary: { role: 'owner' } });
    const stop = vi.fn();
    const api = createNativeSettingsService({ github, mode, workers, now: () => now, managed: {
      route: async () => ({ ...route, imageVersion: '4' }), start: vi.fn(), stop,
      imageVersion: '4', vmState: async () => 'RUNNING', sessions: { get: vi.fn() }, grant: () => undefined,
    } });
    worker!.auth = 'expired';
    queued = ['job_busy'];
    await expect(api.restart(caller, 55)).rejects.toThrow('current subscription job');
    expect(stop).not.toHaveBeenCalled();
    queued = []; fenceCommits = false;
    await expect(api.restart(caller, 55)).rejects.toThrow('changed');
    fenceCommits = true;
    await api.restart(caller, 55);
    expect(stop).toHaveBeenCalledExactlyOnceWith('mvm-native');
    worker!.auth = 'connected'; now += 61000;
    expect(await api.view(caller, 55)).toMatchObject({ recovery: { state: 'required' }, worker: { online: false } });
    member.mockResolvedValue(undefined);
  });

  describe('a managed worker on an older image', () => {
    let vm: string | null;
    const stop = vi.fn(async () => { vm = 'TERMINATING'; });
    const managed = () => createNativeSettingsService({ github, mode, workers, now: () => now, managed: {
      route: async (id) => ({ ...route, installationId: id, workerId: `managed-${id}`, microvmId: 'mvm-native', imageVersion: '9.0' }),
      start: vi.fn(), stop, vmState: async () => vm, imageVersion: '10.0',
      sessions: { get: vi.fn(), pending: async () => [{ id: 'job_' + 'w'.repeat(16) } as never] }, grant: () => undefined,
    } });
    const owner = () => member.mockResolvedValueOnce({ tenant: { status: 'active' }, summary: { role: 'owner' } });
    beforeEach(() => { vm = 'RUNNING'; stop.mockClear(); worker!.imageVersion = '9.0'; worker!.workerId = 'managed-55'; });

    it('tells the console a restart is required, which job a new worker can start for, and who may act', async () => {
      owner();
      expect(await managed().view(caller, 55)).toMatchObject({
        updateAvailable: { from: '9.0', to: '10.0', state: 'required' }, pendingRequest: 'job_' + 'w'.repeat(16), owner: true,
      });
      member.mockResolvedValueOnce({ tenant: { status: 'active' }, summary: { role: 'member' } });
      expect(await managed().view(caller, 55)).toMatchObject({ updateAvailable: { state: 'required' }, owner: false });
      vm = 'TERMINATED';
      expect(await managed().view(caller, 55)).toMatchObject({ updateAvailable: { state: 'stopped' } });
    });

    it('lets only an owner stop an idle outdated worker, and never one with work on it', async () => {
      member.mockResolvedValueOnce({ tenant: { status: 'active' }, summary: { role: 'member' } });
      await expect(managed().restart(caller, 55)).rejects.toThrow('Only an installation owner');
      worker!.active = { jobId: 'job_active0000001', until: now + 30_000 };
      owner();
      await expect(managed().restart(caller, 55)).rejects.toThrow('current subscription job');
      delete worker!.active;
      queued = ['job_queued0000001'];
      owner();
      await expect(managed().restart(caller, 55)).rejects.toThrow('current subscription job');
      expect(stop).not.toHaveBeenCalled();
      queued = [];
      owner();
      expect(await managed().restart(caller, 55)).toMatchObject({ updateAvailable: { state: 'stopping' } });
      expect(stop).toHaveBeenCalledExactlyOnceWith('mvm-native');
    });

    it('stops nothing when the fence loses to a claim or an enqueue, and finishes an earlier fenced restart', async () => {
      fenceCommits = false;
      owner();
      await expect(managed().restart(caller, 55)).rejects.toThrow('changed');
      expect(stop).not.toHaveBeenCalled();
      worker!.fenced = true;
      owner();
      await managed().restart(caller, 55);
      expect(stop).toHaveBeenCalledExactlyOnceWith('mvm-native');
    });

    it('reports no required update while a new VM starts behind another VM\'s placeholder row', async () => {
      const policy = { imageVersion: '10.0', revision: 1, state: 'approved' as const, protocol: 'tenant-browser-1', reason: 'Latest verified image' };
      const api = createNativeSettingsService({ github, mode, workers, now: () => now, managed: {
        route: async (id) => ({ ...route, installationId: id, workerId: `managed-${id}`, microvmId: 'mvm-new', imageVersion: '10.0', generation: 'g2' }),
        start: vi.fn(), stop, vmState: async () => 'RUNNING', imageVersion: '10.0', imagePolicy: async () => policy,
        sessions: { get: vi.fn() }, grant: () => undefined,
      } });
      Object.assign(worker!, { microvmId: 'mvm-retired', imageVersion: '9.0', workerVersion: 'unregistered', auth: 'unavailable', heartbeatAt: 0 });
      const view = await api.view(caller, 55);
      expect(view).not.toHaveProperty('upgrade');
      expect(view).not.toHaveProperty('updateAvailable');
      // On this VM's own row the same version is a real incompatibility.
      Object.assign(worker!, { microvmId: 'mvm-new', imageVersion: '10.0', heartbeatAt: now });
      expect(await api.view(caller, 55)).toMatchObject({ upgrade: { optional: false, reason: 'Worker protocol is not supported by this deployment' } });
    });

    it('refuses while the worker has not registered this VM yet', async () => {
      worker!.microvmId = 'mvm-other';
      owner();
      await expect(managed().restart(caller, 55)).rejects.toThrow('still starting');
      expect(stop).not.toHaveBeenCalled();
    });

    it('refuses to restart a worker that is already on the deployed image', async () => {
      const current = createNativeSettingsService({ github, mode, workers, now: () => now, managed: {
        route: async (id) => ({ ...route, installationId: id, workerId: `managed-${id}`, imageVersion: '10.0' }),
        start: vi.fn(), stop, vmState: async () => 'RUNNING', imageVersion: '10.0', sessions: { get: vi.fn() }, grant: () => undefined,
      } });
      expect(await current.view(caller, 55)).not.toHaveProperty('upgrade');
      owner();
      await expect(current.restart(caller, 55)).rejects.toThrow('already up to date');
      expect(stop).not.toHaveBeenCalled();
    });
  });

  it('does not expose a route or permit changes to an installation without a pinned worker', async () => {
    const service = createNativeSettingsService({ github, mode, workers });
    expect(await service.view(caller, 99)).toEqual({ configured: false, enabled: false, worker: null });
    await expect(service.update(caller, 99, true)).rejects.toThrow('is provisioned for this installation');
    expect(enabled).toBe(false);
  });
  it('keeps the original restart target when another tab replaces it after eligibility evaluation', async () => {
    const oldSession = { generation: 'old-generation', imageVersion: '9', microvmId: 'mvm-old', requestedAt: now };
    const newSession = { generation: 'new-generation', imageVersion: '10', microvmId: 'mvm-new', requestedAt: now };
    let current = oldSession;
    const stop = vi.fn();
    const retire = vi.fn(async (_id: number, generation: string) => {
      if (current.generation !== generation) return false;
      await stop(current.microvmId);
      return true;
    });
    const api = createNativeSettingsService({ github: { ...github, member: vi.fn().mockResolvedValue({ tenant: { status: 'active' }, summary: { role: 'owner' } }) }, mode, now: () => now,
      workers: { ...workers, get: async () => {
        const snapshot = { ...worker!, workerId: 'managed-55', microvmId: current.microvmId, imageVersion: current.imageVersion };
        current = newSession; // Replacement wins after the old eligibility snapshot, before retire.
        return snapshot;
      } },
      managed: { route: async () => ({ ...route, workerId: 'managed-55', ...current }), imageVersion: '10', start: vi.fn(), stop, retire,
        vmState: async () => 'RUNNING', lifecycle: async () => ({ preparing: false, startupFailed: false, retiring: false }),
        sessions: { get: vi.fn(), session: async () => ({ ...current }) }, grant: () => undefined,
      },
    });
    expect(await api.restart(caller, 55)).toMatchObject({ worker: { status: 'connected' } });
    expect(retire).toHaveBeenCalledExactlyOnceWith(55, 'old-generation');
    expect(stop).not.toHaveBeenCalled();
  });
  it('rejects a binding change between the route and the initial session snapshot', async () => {
    const retire = vi.fn();
    const api = createNativeSettingsService({ github: { ...github, member: vi.fn().mockResolvedValue({ tenant: { status: 'active' }, summary: { role: 'owner' } }) }, mode, workers,
      managed: { route: async () => ({ ...route, generation: 'old', microvmId: 'mvm-old' }), start: vi.fn(), stop: vi.fn(), retire,
        sessions: { get: vi.fn(), session: async () => ({ generation: 'new', microvmId: 'mvm-new', imageVersion: '10', requestedAt: now }) }, grant: () => undefined },
    });
    await expect(api.restart(caller, 55)).rejects.toThrow('environment changed');
    expect(retire).not.toHaveBeenCalled();
  });

  it('reports a mandatory policy reason and allows queued-work recovery without mistaking it for active execution', async () => {
    queued = ['waiting-job'];
    worker!.workerVersion = 'tenant-browser-1';
    const service = createNativeSettingsService({ github, mode, workers, now: () => now, managed: {
      route: async () => route, start: vi.fn(), stop: vi.fn(), vmState: async () => 'RUNNING', imageVersion: '10',
      imagePolicy: async () => ({ imageVersion: route.imageVersion, revision: 2, state: 'draining', protocol: 'tenant-browser-1', reason: 'Security upgrade required' }),
      sessions: { get: vi.fn() }, grant: () => undefined,
    } });
    expect(await service.view(caller, 55)).toMatchObject({ upgrade: { reason: 'Security upgrade required', optional: false }, upgradeBlocked: false, worker: { busy: true } });
  });

});
