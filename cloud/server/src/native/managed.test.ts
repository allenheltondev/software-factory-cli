import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetMicrovmCommand, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { managedClaude } from './managed.js';
import type { ManagedSession } from './sessions.js';
const mocks = vi.hoisted(() => ({
  vm: vi.fn(),
  secret: vi.fn(),
  session: vi.fn(),
  reserve: vi.fn(),
  bind: vi.fn(),
  worker: vi.fn(),
}));
vi.mock('@aws-sdk/client-lambda-microvms', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-lambda-microvms')>()),
  LambdaMicrovmsClient: class {
    send = mocks.vm;
  },
}));
vi.mock('@aws-sdk/client-secrets-manager', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-secrets-manager')>()),
  SecretsManagerClient: class {
    send = mocks.secret;
  },
}));
vi.mock('./sessions.js', () => ({
  managedWorkerId: (id: number) => `managed-${id}`,
  createClaudeSessions: () => ({ session: mocks.session, requestSession: mocks.reserve, bind: mocks.bind }),
}));
vi.mock('./store.js', () => ({ createNativeStore: () => ({ get: mocks.worker }) }));
const env = {
  NATIVE_MANAGED_IMAGE_ARN: 'arn:aws:lambda:us-east-1:123:image/test',
  NATIVE_MANAGED_IMAGE_VERSION: '10',
  NATIVE_MANAGED_SECRET_ARN: 'fixture-secret',
  NATIVE_MANAGED_ROLE_ARN: 'fixture-role',
  BROKER_FUNCTION_NAME: 'fixture-broker',
  AWS_REGION: 'us-east-1',
};
describe('managed connection reservation', () => {
  let current: ManagedSession | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    current = undefined;
    mocks.session.mockImplementation(async () => (current ? { ...current } : undefined));
    mocks.reserve.mockImplementation(async (_id, previous) => {
      if (previous?.generation !== current?.generation) return undefined;
      current = { generation: 'fixture-generation', imageVersion: '10', requestedAt: Date.now() };
      return { ...current };
    });
    mocks.bind.mockImplementation(async (_id, generation, microvmId) => {
      if (!current || current.generation !== generation) throw Error('stale reservation');
      current.microvmId = microvmId;
    });
    mocks.secret.mockResolvedValue({ SecretString: 'fixture-control-root-'.repeat(3) });
    mocks.worker.mockResolvedValue(null);
    mocks.vm.mockImplementation(async (command) =>
      command instanceof RunMicrovmCommand ? { microvmId: 'mvm-fixture' } : { state: 'RUNNING' },
    );
  });
  it('uses the same generation and bounded lifetime for concurrent connect requests', async () => {
    await Promise.all([managedClaude(env)!.start(55), managedClaude(env)!.start(55)]);
    const launches = mocks.vm.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof RunMicrovmCommand);
    expect(launches.length).toBeGreaterThan(0);
    expect(new Set(launches.map((command) => command.input.clientToken))).toEqual(new Set(['fixture-generation']));
    expect(launches.every((command) => command.input.maximumDurationInSeconds === 8 * 60 * 60)).toBe(true);
    expect(current?.microvmId).toBe('mvm-fixture');
  });
  it('reuses a healthy worker without reserving or launching another environment', async () => {
    current = { generation: 'existing', imageVersion: '10', requestedAt: Date.now(), microvmId: 'mvm-existing' };
    await managedClaude(env)!.start(55);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.vm).toHaveBeenCalledOnce();
    expect(mocks.vm.mock.calls[0]![0]).toBeInstanceOf(GetMicrovmCommand);
  });
  it('does not replace a fenced worker until that exact VM stops', async () => {
    current = { generation: 'existing', imageVersion: '9', requestedAt: Date.now(), microvmId: 'mvm-existing' };
    mocks.worker.mockResolvedValue({ fenced: true, microvmId: 'mvm-existing' });
    await expect(managedClaude(env)!.start(55)).rejects.toThrow('previous worker to stop');
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.secret).not.toHaveBeenCalled();
  });
});
