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
    };
    workers = {
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

  it('does not expose a route or permit changes to an installation without a pinned worker', async () => {
    const service = createNativeSettingsService({ github, mode, workers });
    expect(await service.view(caller, 99)).toEqual({ configured: false, enabled: false, worker: null });
    await expect(service.update(caller, 99, true)).rejects.toThrow('is provisioned for this installation');
    expect(enabled).toBe(false);
  });
});
