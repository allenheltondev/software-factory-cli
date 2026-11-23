import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from '../caller.js';
import type { GitHubFlows } from '../flows/github.js';
import { createNativeSettingsService } from './settings.js';
import type { NativeRoute } from './route.js';
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
      setEnabled: async (_, __, next) => { enabled = next; },
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

  it('does not expose a route or permit changes to an installation without a pinned worker', async () => {
    const service = createNativeSettingsService({ github, mode, workers });
    expect(await service.view(caller, 99)).toEqual({ configured: false, enabled: false, worker: null });
    await expect(service.update(caller, 99, true)).rejects.toThrow('is provisioned for this installation');
    expect(enabled).toBe(false);
  });
});
