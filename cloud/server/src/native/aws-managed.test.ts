import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { STARTUP_MS } from './admission.js';
import type { ManagedSession } from './sessions.js';
import type { Worker } from './store.js';

// The real managedClaude().route() and nativeAws().resolveNative() path, with storage and AWS
// mocked: what dispatch decides for each phase of a managed session (#144, #152 review).
vi.mock('./image-policy.js', async (original) => ({
  ...(await original<typeof import('./image-policy.js')>()),
  createImagePolicies: () => async (imageVersion: string) => ({ imageVersion, revision: 1, state: 'approved', protocol: 'tenant-browser-1', reason: 'test approval' }),
}));
const mocks = vi.hoisted(() => ({ vm: vi.fn(), session: vi.fn(), worker: vi.fn() }));
vi.mock('@aws-sdk/client-lambda-microvms', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-lambda-microvms')>()),
  LambdaMicrovmsClient: class { send = mocks.vm; },
}));
vi.mock('@aws-sdk/client-ssm', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-ssm')>()),
  SSMClient: class { send = async () => ({ Parameter: { Value: 'off' } }); },
}));
vi.mock('./sessions.js', () => ({
  managedWorkerId: (id: number) => `managed-${id}`,
  createClaudeSessions: () => ({ session: mocks.session }),
}));
vi.mock('./store.js', () => ({
  createNativeStore: () => ({ get: mocks.worker, queued: async () => [] }),
  createNativeModeStore: () => ({ snapshot: async () => ({ enabled: true, revision: 0 }), enabled: async () => true }),
}));

Object.assign(process.env, {
  NATIVE_MANAGED_IMAGE_ARN: 'arn:aws:lambda:us-east-1:123:image/test', NATIVE_MANAGED_IMAGE_VERSION: '10',
  NATIVE_MANAGED_SECRET_ARN: 'fixture-secret', NATIVE_MANAGED_ROLE_ARN: 'fixture-role', BROKER_FUNCTION_NAME: 'broker', AWS_REGION: 'us-east-1',
});
delete process.env.NATIVE_WORKER_ROUTE;
const { nativeAws } = await import('./aws.js');

const now = Date.now();
const session = (patch: Partial<ManagedSession> = {}): ManagedSession => ({ generation: 'gen-a', imageVersion: '10', requestedAt: now - 60_000, startupDeadline: now - 60_000 + STARTUP_MS, ...patch });
const worker = (patch: Partial<Worker> = {}): Worker => ({ version: 1, installationId: 55, workerId: 'managed-55', session: 'worker-session-0123456', microvmId: 'mvm-a',
  imageVersion: '10', workerVersion: 'tenant-browser-1', auth: 'connected', heartbeatAt: Date.now(), ...patch });
const readiness = async () => (await nativeAws({} as never).resolveNative!(55))!.readiness!();
const vmReads = () => mocks.vm.mock.calls.filter(([command]) => command instanceof GetMicrovmCommand).map(([command]) => command.input.microvmIdentifier);

describe('managed route to dispatch readiness', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.vm.mockResolvedValue({ state: 'RUNNING' }); mocks.worker.mockResolvedValue(null); });
  it('asks a never-connected installation to sign in', async () => {
    mocks.session.mockResolvedValue(undefined);
    expect(await readiness()).toBe('not-connected');
    expect(vmReads()).toEqual([]);
  });
  it('waits for a reserved session that has not bound its VM, and never reads the placeholder from AWS', async () => {
    mocks.session.mockResolvedValue(session());
    expect(await readiness()).toBe('worker-starting');
    expect(vmReads()).toEqual([]);
  });
  it('asks for a reconnect once a pending launch passes its startup deadline', async () => {
    mocks.session.mockResolvedValue(session({ requestedAt: now - 2 * STARTUP_MS, startupDeadline: now - STARTUP_MS }));
    expect(await readiness()).toBe('startup-failed');
    expect(vmReads()).toEqual([]);
  });
  it('waits while a bound VM starts, then reports a startup that never registered as failed', async () => {
    mocks.session.mockResolvedValue(session({ microvmId: 'mvm-a' }));
    expect(await readiness()).toBe('worker-starting');
    mocks.session.mockResolvedValue(session({ microvmId: 'mvm-a', requestedAt: now - 2 * STARTUP_MS, startupDeadline: now - STARTUP_MS }));
    expect(await readiness()).toBe('startup-failed');
    expect(new Set(vmReads())).toEqual(new Set(['mvm-a']));
  });
  it('reports a ready session whose worker row is gone as lost, or ended once AWS has no VM', async () => {
    mocks.session.mockResolvedValue(session({ microvmId: 'mvm-a', readyAt: now - 30_000 }));
    expect(await readiness()).toBe('worker-lost');
    mocks.vm.mockResolvedValue({ state: 'TERMINATED' });
    expect(await readiness()).toBe('environment-ended');
  });
  it('asks for a reconnect for a retiring session, without reading AWS', async () => {
    mocks.session.mockResolvedValue(session({ microvmId: 'mvm-a', retiring: true, retirementReason: 'idle' }));
    expect(await readiness()).toBe('environment-retiring');
    expect(vmReads()).toEqual([]);
  });
  it('dispatches to a bound, ready, connected worker', async () => {
    mocks.session.mockResolvedValue(session({ microvmId: 'mvm-a', readyAt: now - 30_000 }));
    mocks.worker.mockResolvedValue(worker());
    expect(await readiness()).toBe('ready');
    expect(vmReads()).toEqual([]);
  });
  it('keeps dispatch on the actual approved session image across a routine rollout', async () => {
    mocks.session.mockResolvedValue(session({ microvmId: 'mvm-a', readyAt: now - 30_000, imageVersion: '9' }));
    mocks.worker.mockResolvedValue(worker({ imageVersion: '9' }));
    const launch = (await nativeAws({} as never).resolveNative!(55))!;
    expect(launch.route).toMatchObject({ imageVersion: '9', generation: 'gen-a', microvmId: 'mvm-a' });
    expect(await launch.readiness!()).toBe('ready');
    expect(vmReads()).toEqual([]);
  });

});
