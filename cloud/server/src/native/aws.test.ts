import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceNotFoundException } from '@aws-sdk/client-lambda-microvms';
import type { Worker } from './store.js';
import type { NativeRoute } from './route.js';

const mocks = vi.hoisted(() => ({ vm: vi.fn(), worker: vi.fn() }));
vi.mock('@aws-sdk/client-lambda-microvms', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-lambda-microvms')>()),
  LambdaMicrovmsClient: class { send = mocks.vm; },
}));
vi.mock('./store.js', () => ({
  createNativeStore: () => ({ get: mocks.worker }),
  createNativeModeStore: () => ({ snapshot: async () => ({ enabled: true, revision: 0 }), enabled: async () => true }),
}));
vi.mock('./managed.js', () => ({ managedClaude: () => undefined }));

const { nativeAws } = await import('./aws.js');
const route: NativeRoute = { installationId: 55, workerId: 'worker-1', microvmId: 'mvm-a', imageVersion: '7', controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/x' };
const worker = (patch: Partial<Worker> = {}): Worker => ({ version: 1, installationId: 55, workerId: 'worker-1', session: 'session-0123456789',
  microvmId: 'mvm-a', imageVersion: '7', workerVersion: '1', auth: 'connected', heartbeatAt: Date.now(), ...patch });

describe('subscription dispatch readiness (#144)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NATIVE_WORKER_ROUTE = JSON.stringify(route);
    mocks.vm.mockResolvedValue({ state: 'RUNNING' });
  });
  const readiness = () => nativeAws({} as never).launch!.readiness!();
  it.each([
    ['a missing worker row', null, 'worker-missing'],
    ['another VM', worker({ microvmId: 'mvm-b' }), 'worker-replaced'],
    ['a fenced worker', worker({ fenced: true }), 'fenced'],
    ['a signed-out CLI', worker({ auth: 'auth-required' }), 'auth-required'],
    ['an expired login', worker({ auth: 'expired' }), 'expired'],
    ['an unreadable probe', worker({ auth: 'unavailable' }), 'auth-unavailable'],
    ['a connected worker', worker(), 'ready'],
  ])('names %s', async (_name, row, expected) => {
    mocks.worker.mockResolvedValue(row);
    expect(await readiness()).toBe(expected);
    expect(mocks.vm).not.toHaveBeenCalled();
  });
  it.each([
    ['SUSPENDED', 'environment-suspended'],
    ['SUSPENDING', 'environment-suspended'],
    ['TERMINATED', 'environment-ended'],
    ['RUNNING', 'heartbeat-stale'],
  ])('tells a %s VM behind a stale heartbeat apart', async (state, expected) => {
    mocks.worker.mockResolvedValue(worker({ heartbeatAt: Date.now() - 2 * 60_000 }));
    mocks.vm.mockResolvedValue({ state });
    expect(await readiness()).toBe(expected);
  });
  it('treats a VM AWS no longer knows as ended, and an unreadable state as a gap, never as ready', async () => {
    mocks.worker.mockResolvedValue(worker({ heartbeatAt: Date.now() - 2 * 60_000 }));
    mocks.vm.mockRejectedValueOnce(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
    expect(await readiness()).toBe('environment-ended');
    mocks.vm.mockRejectedValueOnce(new Error('throttled'));
    expect(await readiness()).toBe('heartbeat-stale');
  });
});
