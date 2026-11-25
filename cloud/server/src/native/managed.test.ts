import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetMicrovmCommand, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { managedClaude } from './managed.js';
import { createClaudeAdmission, STARTUP_MS } from './admission.js';
import { admissionFixture } from './admission-fixture.js';
import type { Worker } from './store.js';
import type { ManagedSession } from './sessions.js';
vi.mock('./image-policy.js', async (original) => ({
  ...(await original<typeof import('./image-policy.js')>()),
  createImagePolicies: () => mocks.imagePolicy,
}));
const mocks = vi.hoisted(() => ({
  imagePolicy: vi.fn(),
  vm: vi.fn(),
  secret: vi.fn(),
  session: vi.fn(),
  reserve: vi.fn(),
  bind: vi.fn(),
  worker: vi.fn(),
  retire: vi.fn(),
  ready: vi.fn(),
  queued: vi.fn(),
  parameter: vi.fn(),
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
vi.mock('@aws-sdk/client-ssm', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-ssm')>()),
  SSMClient: class {
    send = mocks.parameter;
  },
}));
vi.mock('./sessions.js', () => ({
  managedWorkerId: (id: number) => `managed-${id}`,
  createClaudeSessions: () => ({
    session: mocks.session,
    requestSession: mocks.reserve,
    bind: mocks.bind,
    retire: mocks.retire,
    ready: mocks.ready,
  }),
}));
vi.mock('./store.js', () => ({
  createNativeStore: () => ({ get: mocks.worker, queued: mocks.queued }),
  createNativeModeStore: () => ({ snapshot: async () => ({ enabled: false, revision: 0, routingVersion: 0 }) }),
}));
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
  let row: Worker | null;
  let clock: number;
  let disabled: boolean;
  let otherSessions: Map<number, { generation: string }>;
  let admission: ReturnType<typeof createClaudeAdmission>;
  const managed = (overrides: Record<string, string> = {}) =>
    managedClaude({ ...env, ...overrides }, { admission, disabled: async () => disabled, now: () => clock })!;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 1, state: 'approved', protocol: 'tenant-browser-1', reason: 'test approval' }));
    current = undefined;
    row = null;
    clock = Date.now();
    disabled = false;
    otherSessions = new Map();
    admission = createClaudeAdmission(
      'test',
      admissionFixture(undefined, (id) => (id === 55 ? current : otherSessions.get(id))).db,
    );
    mocks.retire.mockImplementation(async (_id, _session, _mode, _worker, reason) => {
      if (current) {
        current.retiring = true;
        current.retirementReason = reason;
      }
      return true;
    });
    mocks.ready.mockImplementation(async () => {
      if (current) current.readyAt = clock;
    });
    mocks.queued.mockResolvedValue([]);
    mocks.session.mockImplementation(async () => (current ? { ...current } : undefined));
    mocks.reserve.mockImplementation(async (_id, previous) => {
      if (previous?.generation !== current?.generation) return undefined;
      current = {
        generation: 'fixture-generation-' + (current?.generation ?? 'initial'),
        imageVersion: '10',
        requestedAt: clock,
        startupDeadline: clock + STARTUP_MS,
        admissionRequired: true,
      };
      return { ...current };
    });
    mocks.bind.mockImplementation(async (_id, generation, microvmId) => {
      if (!current || current.generation !== generation) throw Error('stale reservation');
      current.microvmId = microvmId;
    });
    mocks.secret.mockResolvedValue({ SecretString: 'fixture-control-root-'.repeat(3) });
    mocks.worker.mockImplementation(async () => row);
    mocks.vm.mockImplementation(async (command) =>
      command instanceof RunMicrovmCommand ? { microvmId: 'mvm-fixture' } : { state: 'RUNNING' },
    );
  });
  it('uses the same generation and bounded lifetime for concurrent connect requests', async () => {
    await Promise.all([managed().start(55), managed().start(55)]);
    const launches = mocks.vm.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof RunMicrovmCommand);
    expect(launches.length).toBeGreaterThan(0);
    expect(new Set(launches.map((command) => command.input.clientToken))).toEqual(
      new Set(['fixture-generation-initial']),
    );
    expect(launches.every((command) => command.input.maximumDurationInSeconds === 8 * 60 * 60)).toBe(true);
    // The worker gets no inbound endpoint traffic: never left to the service's idle default (#144).
    expect(launches.every((command) => JSON.stringify(command.input.idlePolicy) ===
      JSON.stringify({ maxIdleDurationSeconds: 8 * 60 * 60, suspendedDurationSeconds: 0, autoResumeEnabled: false }))).toBe(true);
    expect(current?.microvmId).toBe('mvm-fixture');
  });
  const connectedWorker = (): Worker => ({ installationId: 55, workerId: 'managed-55', microvmId: 'mvm-fixture', imageVersion: '10',
    workerVersion: 'test', version: 1, session: 'worker-session-123456', heartbeatAt: clock, auth: 'connected', lastWorkAt: clock });
  it('keeps a connected idle session across cleanup runs minutes after its last job (#144)', async () => {
    await managed().start(55);
    row = connectedWorker();
    await managed().lifecycle(55);
    for (const minutes of [1, 5, 10, 30]) {
      clock += minutes * 60_000;
      row = { ...row!, heartbeatAt: clock };
      expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    }
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(current?.retiring).toBeUndefined();
    expect((await managed().route(55)).microvmId).toBe('mvm-fixture');
  });
  it('keeps a ready session through a bounded heartbeat gap, then retires a lost dispatcher (#144)', async () => {
    let stopped = false;
    mocks.vm.mockImplementation(async (command) => {
      if (command instanceof RunMicrovmCommand) return { microvmId: 'mvm-fixture' };
      if (command.constructor.name === 'TerminateMicrovmCommand') { stopped = true; return {}; }
      return { state: stopped ? 'TERMINATED' : 'RUNNING' };
    });
    await managed().start(55);
    row = connectedWorker();
    await managed().lifecycle(55);
    clock += 2 * 60_000; // silent, within the grace: a slow call or throttled broker
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    row = { ...row, heartbeatAt: clock }; // it recovered by itself
    clock += 60_000;
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    expect(mocks.retire).not.toHaveBeenCalled();
    clock += 10 * 60_000; // the dispatcher stopped for good; its VM still runs
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await managed().reconcile()).toEqual({ released: 1, failed: 0 });
    expect(mocks.retire).toHaveBeenCalledWith(55, expect.anything(), expect.anything(), expect.anything(), 'worker-lost');
    expect(stopped).toBe(true);
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ reason: 'worker-lost', vmState: 'RUNNING' }));
    logs.mockRestore();
  });
  it('keeps a worker that heartbeats after cleanup read it as lost, and it stays routable (#144)', async () => {
    let recovered = false;
    mocks.vm.mockImplementation(async (command) => {
      if (command instanceof RunMicrovmCommand) return { microvmId: 'mvm-fixture' };
      if (command.constructor.name === 'TerminateMicrovmCommand') return {};
      // Cleanup has read the stale worker; its heartbeat lands while cleanup asks AWS.
      if (recovered) row = { ...row!, heartbeatAt: clock, version: row!.version + 1 };
      return { state: 'RUNNING' };
    });
    await managed().start(55);
    row = connectedWorker();
    await managed().lifecycle(55);
    clock += 10 * 60_000;
    recovered = true;
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ claudeSession: 'keep', reason: 'worker-lost', why: 'recovered' }));
    logs.mockRestore();
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.vm.mock.calls.some(([command]) => command.constructor.name === 'TerminateMicrovmCommand')).toBe(false);
    expect(current?.retiring).toBeUndefined();
    expect(await managed().route(55)).toMatchObject({ microvmId: 'mvm-fixture', generation: current!.generation });
    expect(await admission.list()).toHaveLength(1);
  });
  it('keeps a worker whose heartbeat lands between the eligibility read and the sealing write', async () => {
    await managed().start(55);
    row = connectedWorker();
    await managed().lifecycle(55);
    clock += 10 * 60_000;
    mocks.retire.mockResolvedValueOnce(false); // the worker's version moved: the transaction fails
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    expect(mocks.vm.mock.calls.some(([command]) => command.constructor.name === 'TerminateMicrovmCommand')).toBe(false);
    expect(current?.retiring).toBeUndefined();
    vi.mocked(console.log).mockRestore();
  });
  it('keeps an idle session whose worker took work after cleanup read it', async () => {
    const configured = () => managed({ NATIVE_MANAGED_IDLE_MINUTES: '120' });
    let worked = false;
    mocks.vm.mockImplementation(async (command) => {
      if (command instanceof RunMicrovmCommand) return { microvmId: 'mvm-fixture' };
      if (worked) row = { ...row!, lastWorkAt: clock, heartbeatAt: clock, version: row!.version + 1 };
      return { state: 'RUNNING' };
    });
    await configured().start(55);
    row = connectedWorker();
    await configured().lifecycle(55);
    clock += 2 * 3_600_000 + 1;
    row = { ...row, heartbeatAt: clock };
    worked = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await configured().reconcile()).toEqual({ released: 0, failed: 0 });
    vi.mocked(console.log).mockRestore();
    expect(mocks.retire).not.toHaveBeenCalled();
  });
  it('never retires a lost dispatcher that still holds queued work', async () => {
    await managed().start(55);
    row = connectedWorker();
    await managed().lifecycle(55);
    clock += 30 * 60_000;
    mocks.queued.mockResolvedValue(['job-queued']);
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    expect(mocks.retire).not.toHaveBeenCalled();
  });
  it.each(['SUSPENDING', 'SUSPENDED'])('retires a %s environment with that precise reason', async (vmState) => {
    let stopped = false;
    mocks.vm.mockImplementation(async (command) => {
      if (command instanceof RunMicrovmCommand) return { microvmId: 'mvm-fixture' };
      if (command.constructor.name === 'TerminateMicrovmCommand') { stopped = true; return {}; }
      return { state: stopped ? 'TERMINATED' : current?.readyAt ? vmState : 'RUNNING' };
    });
    await managed().start(55);
    row = connectedWorker();
    await managed().lifecycle(55);
    clock += 60_000;
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await managed().reconcile()).toEqual({ released: 1, failed: 0 });
    expect(mocks.retire).toHaveBeenCalledWith(55, expect.anything(), expect.anything(), expect.anything(), 'suspended');
    expect(stopped).toBe(true);
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ claudeSession: 'retire', reason: 'suspended', vmState }));
    logs.mockRestore();
  });
  it('reuses a healthy worker without reserving or launching another environment', async () => {
    current = { generation: 'existing', imageVersion: '10', requestedAt: Date.now(), microvmId: 'mvm-existing' };
    await managed().start(55);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.vm).toHaveBeenCalledOnce();
    expect(mocks.vm.mock.calls[0]![0]).toBeInstanceOf(GetMicrovmCommand);
  });
  it('does not replace a fenced worker until that exact VM stops', async () => {
    current = { generation: 'existing', imageVersion: '9', requestedAt: Date.now(), microvmId: 'mvm-existing' };
    mocks.worker.mockResolvedValue({ fenced: true, microvmId: 'mvm-existing' });
    await expect(managed().start(55)).rejects.toThrow('previous worker to stop');
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.secret).not.toHaveBeenCalled();
  });
  it('rejects service-disabled admission without reserving capacity or launching', async () => {
    disabled = true;
    await expect(managed().start(55)).rejects.toThrow('paused by an operator');
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.vm).not.toHaveBeenCalled();
    expect(await admission.list()).toHaveLength(0);
  });
  it('releases a pre-launch secret failure after sealing its generation', async () => {
    mocks.secret.mockRejectedValue(new Error('secret unavailable'));
    await expect(managed().start(55)).rejects.toThrow('secret unavailable');
    expect(mocks.retire).toHaveBeenCalledOnce();
    expect(mocks.vm).not.toHaveBeenCalled();
    expect(await admission.list()).toHaveLength(0);
    expect(current?.retiring).toBe(true);
  });
  it('retains an uncertain launch until replay discovers and confirms termination of the exact VM', async () => {
    let lost = true;
    let stopped = false;
    mocks.vm.mockImplementation(async (command) => {
      if (command instanceof RunMicrovmCommand) {
        if (lost) {
          lost = false;
          throw Error('response lost');
        }
        return { microvmId: 'mvm-uncertain' };
      }
      if (command.constructor.name === 'TerminateMicrovmCommand') {
        stopped = true;
        return {};
      }
      return { state: stopped ? 'TERMINATED' : 'RUNNING' };
    });
    await expect(managed().start(55)).rejects.toThrow('response lost');
    expect(await admission.list()).toHaveLength(1);
    clock += STARTUP_MS + 1;
    expect(await managed().reconcile()).toEqual({ released: 1, failed: 0 });
    expect(stopped).toBe(true);
    expect(await admission.list()).toHaveLength(0);
    const launches = mocks.vm.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof RunMicrovmCommand);
    expect(new Set(launches.map((command) => command.input.clientToken)).size).toBe(1);
  });
  it.each(['missing', 'unavailable'])(
    'times out a %s worker, fences before stopping, then reconnects',
    async (auth) => {
      let stopped = false;
      mocks.vm.mockImplementation(async (command) => {
        if (command instanceof RunMicrovmCommand) return { microvmId: stopped ? 'mvm-replacement' : 'mvm-fixture' };
        if (command.constructor.name === 'TerminateMicrovmCommand') {
          stopped = true;
          return {};
        }
        return { state: stopped ? 'TERMINATED' : 'RUNNING' };
      });
      await managed().start(55);
      if (auth === 'unavailable')
        row = {
          installationId: 55,
          workerId: 'managed-55',
          microvmId: 'mvm-fixture',
          imageVersion: '10',
          workerVersion: 'test',
          version: 1,
          session: 'worker-session-123456',
          heartbeatAt: clock,
          auth: 'unavailable',
        };
      expect(await managed().lifecycle(55)).toMatchObject({ preparing: true, startupFailed: false });
      clock += STARTUP_MS + 1;
      expect(await managed().lifecycle(55)).toMatchObject({ preparing: false, startupFailed: true });
      expect(await managed().reconcile()).toEqual({ released: 1, failed: 0 });
      expect(mocks.retire).toHaveBeenCalledWith(
        55,
        expect.objectContaining({ generation: 'fixture-generation-initial' }),
        expect.objectContaining({ revision: 0 }),
        auth === 'missing' ? null : expect.objectContaining({ auth: 'unavailable' }),
        'startup-failed',
      );
      await managed().start(55);
      expect(current?.microvmId).toBe('mvm-replacement');
    },
  );
  it('stops no VM and retains its admission when the generation fence loses a registration or enqueue race', async () => {
    await managed().start(55);
    mocks.retire.mockResolvedValue(false);
    await expect(managed().retire(55, current!.generation)).rejects.toThrow('work changed');
    expect(mocks.vm.mock.calls.some(([command]) => command.constructor.name === 'TerminateMicrovmCommand')).toBe(false);
    expect(await admission.list()).toHaveLength(1);
  });
  it('never retires active or queued work during startup or idle cleanup', async () => {
    await managed().start(55);
    clock += STARTUP_MS + 1;
    mocks.queued.mockResolvedValue(['job-queued']);
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    await expect(managed().retire(55, current!.generation)).rejects.toThrow('queued Claude jobs');
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(await admission.list()).toHaveLength(1);
  });
  it.each(['on', 'unreadable'])('fails closed when the platform SSM switch is %s', async (value) => {
    if (value === 'on') mocks.parameter.mockResolvedValue({ Parameter: { Value: 'on' } });
    else mocks.parameter.mockRejectedValue(Error('SSM read unavailable'));
    const worker = managedClaude(env, { admission, now: () => clock })!;
    await expect(worker.start(55)).rejects.toThrow('paused by an operator');
    expect(mocks.parameter).toHaveBeenCalledOnce();
    expect(mocks.vm).not.toHaveBeenCalled();
    expect(await admission.list()).toHaveLength(0);
  });
  it('honors a configured idle deadline and exposes the effective expiration', async () => {
    let state = 'RUNNING';
    mocks.vm.mockImplementation(async (command) => {
      if (command instanceof RunMicrovmCommand) return { microvmId: 'mvm-fixture' };
      if (command.constructor.name === 'TerminateMicrovmCommand') {
        state = 'TERMINATED';
        return {};
      }
      return { state };
    });
    const configured = () => managed({ NATIVE_MANAGED_IDLE_MINUTES: '120' });
    await configured().start(55);
    row = {
      installationId: 55,
      workerId: 'managed-55',
      microvmId: 'mvm-fixture',
      imageVersion: '10',
      workerVersion: 'test',
      version: 1,
      session: 'worker-session-123456',
      heartbeatAt: clock,
      auth: 'connected',
    };
    await configured().lifecycle(55);
    clock += 2 * 3600000 - 1;
    row = { ...row, heartbeatAt: clock }; // idle, but its worker is alive and heartbeating
    expect(await configured().reconcile()).toEqual({ released: 0, failed: 0 });
    expect((await configured().lifecycle(55)).expiresAt).toBe(
      new Date(current!.requestedAt + 2 * 3600000).toISOString(),
    );
    clock += 2;
    expect(await configured().reconcile()).toEqual({ released: 1, failed: 0 });
    expect(await admission.list()).toHaveLength(0);
    expect(state).toBe('TERMINATED');
    expect(await configured().lifecycle(55)).toMatchObject({ retired: true, retirementReason: 'idle' });
  });
  it('retains capacity while a stop is uncertain and releases it only after confirmed termination', async () => {
    await managed().start(55);
    mocks.vm.mockResolvedValue({ state: 'UNKNOWN' });
    expect(await managed().retire(55, current!.generation)).toBe(false);
    expect(await admission.list()).toHaveLength(1);
    mocks.vm.mockResolvedValue({ state: 'TERMINATED' });
    expect(await managed().retire(55, current!.generation)).toBe(true);
    expect(await admission.list()).toHaveLength(0);
  });

  it('retains ambiguous exposure if its session changes after the launch marker commits', async () => {
    const launching = admission.launching.bind(admission);
    vi.spyOn(admission, 'launching').mockImplementation(async (generation) => {
      await launching(generation);
      current = { ...current!, generation: 'replacement-generation' };
    });
    await expect(managed().start(55)).rejects.toThrow('environment is retiring');
    expect(mocks.vm).not.toHaveBeenCalled();
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 1 });
    expect(await admission.list()).toHaveLength(1);
  });
  it('cannot bypass platform admission by replaying a pre-budget unbound generation', async () => {
    current = { generation: 'legacy-generation', imageVersion: '9', requestedAt: clock - STARTUP_MS - 1 };
    for (const id of [1, 2, 3, 4]) otherSessions.set(id, { generation: `occupied-${id}` });
    await Promise.all([1, 2, 3, 4].map((id) => admission.reserve(id, `occupied-${id}`, clock)));
    await expect(managed().retire(55, current.generation)).rejects.toThrow('capacity is full');
    expect(mocks.vm).not.toHaveBeenCalled();
    expect(await admission.list()).toHaveLength(4);
  });
  it('keeps one healthy connection through morning and lunch breaks under the default policy', async () => {
    await managed().start(55);
    row = {
      installationId: 55,
      workerId: 'managed-55',
      microvmId: current!.microvmId!,
      imageVersion: '10',
      workerVersion: 'test',
      version: 1,
      session: 'worker-session-123456',
      heartbeatAt: clock,
      auth: 'connected',
    };
    const originalGeneration = current!.generation;
    for (const minutes of [30, 60, 90, 120]) {
      clock += minutes * 60000;
      row = { ...row!, heartbeatAt: clock }; // the live worker heartbeats every ten seconds
      await managed().start(55);
      expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
      expect(current!.generation).toBe(originalGeneration);
    }
    expect(mocks.vm.mock.calls.filter(([command]) => command instanceof RunMicrovmCommand)).toHaveLength(1);
    expect(await admission.list()).toHaveLength(1);
  });
  it('rejects a delayed reserve for G after retirement and lets replacement H connect', async () => {
    current = {
      generation: 'pending-G',
      imageVersion: '10',
      requestedAt: clock,
      startupDeadline: clock + STARTUP_MS,
      admissionRequired: true,
    };
    let resumeG!: () => void;
    let resumeH!: () => void;
    let reachedG!: () => void;
    let reachedH!: () => void;
    const gPaused = new Promise<void>((done) => {
      reachedG = done;
    });
    const hPaused = new Promise<void>((done) => {
      reachedH = done;
    });
    const gGate = new Promise<void>((done) => {
      resumeG = done;
    });
    const hGate = new Promise<void>((done) => {
      resumeH = done;
    });
    const reserve = admission.reserve.bind(admission);
    vi.spyOn(admission, 'reserve').mockImplementation(async (id, generation, at, limits) => {
      if (generation === 'pending-G') {
        reachedG();
        await gGate;
      } else {
        reachedH();
        await hGate;
      }
      return reserve(id, generation, at, limits);
    });
    const stale = managed()
      .start(55)
      .catch((err: unknown) => err);
    await gPaused;
    expect(await managed().retire(55, 'pending-G')).toBe(true);
    const replacement = managed()
      .start(55)
      .catch((err: unknown) => err);
    await hPaused;
    const replacementGeneration = current!.generation;
    expect(replacementGeneration).not.toBe('pending-G');
    resumeG();
    expect(await stale).toBeInstanceOf(Error);
    resumeH();
    expect(await replacement).toBeUndefined();
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    expect((await admission.list()).map((lease) => lease.generation)).toEqual([replacementGeneration]);
    expect(current?.microvmId).toBe('mvm-fixture');
    expect(mocks.vm.mock.calls.filter(([command]) => command instanceof RunMicrovmCommand)).toHaveLength(1);
  });

  it('reclaims a stale never-launched hold when replacement wins before the launch marker', async () => {
    const launching = admission.launching.bind(admission);
    vi.spyOn(admission, 'launching').mockImplementationOnce(async (generation, at) => {
      current = { ...current!, generation: 'replacement-H' };
      return launching(generation, at);
    });
    await expect(managed().start(55)).rejects.toThrow('generation changed');
    expect(mocks.vm).not.toHaveBeenCalled();
    expect((await admission.list())[0]).toMatchObject({ mayHaveLaunched: false });
    expect(await managed().reconcile()).toEqual({ released: 1, failed: 0 });
    expect(await admission.list()).toHaveLength(0);
    await managed().start(55);
    expect((await admission.list()).map((lease) => lease.generation)).toEqual(['replacement-H']);
    expect(current?.microvmId).toBe('mvm-fixture');
  });

  it('marks an interrupted sealed legacy adoption before any recovery replay', async () => {
    current = { generation: 'legacy-G', imageVersion: '10', requestedAt: clock };
    await admission.reserve(55, 'legacy-G', clock);
    current.retiring = true;
    await admission.retiring('legacy-G');
    let stopped = false;
    mocks.vm.mockImplementation(async (command) => {
      if (command instanceof RunMicrovmCommand) {
        expect(await admission.get('legacy-G')).toMatchObject({ mayHaveLaunched: true, retiring: true });
        return { microvmId: 'mvm-legacy' };
      }
      if (command.constructor.name === 'TerminateMicrovmCommand') {
        stopped = true;
        return {};
      }
      return { state: stopped ? 'TERMINATED' : 'RUNNING' };
    });
    expect(await managed().retire(55, 'legacy-G')).toBe(true);
    expect(await admission.list()).toHaveLength(0);
    expect(stopped).toBe(true);
  });
  it('preserves queued work while retiring a mandatory-upgrade session at an idle boundary', async () => {
    await managed().start(55);
    row = connectedWorker();
    mocks.queued.mockResolvedValue(['queued-job']);
    await expect(managed().retire(55, current!.generation)).rejects.toThrow('queued');
    mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 2, state: 'draining', protocol: 'tenant-browser-1', reason: 'Required security update' }));
    mocks.vm.mockResolvedValue({ state: 'TERMINATED' });
    expect(await managed().retire(55, current!.generation)).toBe(true);
    expect(mocks.retire).toHaveBeenCalled();
    expect(await mocks.queued()).toEqual(['queued-job']);
  });

  it.each(['unregistered', 'silent', 'queued', 'active'] as const)('independently terminates a revoked %s session without worker cooperation', async (kind) => {
    await managed().start(55);
    const generation = current!.generation;
    row = kind === 'unregistered' ? null : { ...connectedWorker(), heartbeatAt: 0 };
    if (kind === 'queued') mocks.queued.mockResolvedValue(['never-started-job']);
    if (kind === 'active') row!.active = { jobId: 'active-job', until: clock + 60000 };
    mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 2, state: 'revoked', protocol: 'tenant-browser-1', reason: 'Emergency revoke' }));
    let stopped = false;
    mocks.vm.mockImplementation(async (command) => {
      if (command.constructor.name === 'TerminateMicrovmCommand') { stopped = true; return {}; }
      return { state: stopped ? 'TERMINATED' : 'RUNNING' };
    });
    expect(await managed().reconcile()).toEqual({ released: 1, failed: 0 });
    expect(stopped).toBe(true);
    expect(current).toMatchObject({ generation, retiring: true, retirementReason: 'image-revoked' });
    expect(mocks.retire).toHaveBeenCalledWith(55, expect.objectContaining({ generation }), expect.anything(), row, 'image-revoked', expect.objectContaining({ state: 'revoked', revision: 2 }));
    expect(await admission.list()).toHaveLength(0);
    if (kind === 'queued') expect(await mocks.queued()).toEqual(['never-started-job']);
  });
  it('retains revoked-session accounting until independent termination is confirmed', async () => {
    await managed().start(55);
    mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 2, state: 'revoked', protocol: 'tenant-browser-1', reason: 'Emergency revoke' }));
    mocks.vm.mockResolvedValue({ state: 'UNKNOWN' });
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    expect(await admission.list()).toHaveLength(1);
    mocks.vm.mockResolvedValue({ state: 'TERMINATED' });
    expect(await managed().reconcile()).toEqual({ released: 1, failed: 0 });
    expect(await admission.list()).toHaveLength(0);
  });
  it.each(['reapproved', 'unreadable'] as const)('finishes a sealed emergency retirement with queued work when policy is %s', async (policyState) => {
    await managed().start(55);
    const generation = current!.generation;
    mocks.queued.mockResolvedValue(['never-started-job']);
    mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 2, state: 'revoked', protocol: 'tenant-browser-1', reason: 'Emergency revoke' }));
    mocks.vm.mockResolvedValue({ state: 'UNKNOWN' });
    const stops = () => mocks.vm.mock.calls.filter(([command]) => command.constructor.name === 'TerminateMicrovmCommand');
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    expect(current).toMatchObject({ generation, retiring: true, retirementReason: 'image-revoked' });
    expect(stops()).toHaveLength(1);
    expect(await admission.get(generation)).toMatchObject({ retiring: true });

    mocks.imagePolicy.mockClear();
    if (policyState === 'reapproved') {
      mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 3, state: 'approved', protocol: 'tenant-browser-1', reason: 'Reapproved' }));
    } else mocks.imagePolicy.mockRejectedValue(new Error('Policy unavailable'));
    expect(await managed().reconcile()).toEqual({ released: 0, failed: 0 });
    expect(stops()).toHaveLength(2);
    expect(await admission.get(generation)).toBeDefined();
    expect(mocks.imagePolicy).not.toHaveBeenCalled();

    mocks.vm.mockResolvedValue({ state: 'TERMINATED' });
    expect(await managed().reconcile()).toEqual({ released: 1, failed: 0 });
    expect(await admission.list()).toHaveLength(0);
    expect(current).toMatchObject({ generation, retiring: true, retirementReason: 'image-revoked' });
    expect(await mocks.queued()).toEqual(['never-started-job']);
    expect(mocks.retire).toHaveBeenCalledTimes(1); // The committed fence is reused, never undone.
    expect(mocks.vm.mock.calls.filter(([command]) => command instanceof RunMicrovmCommand)).toHaveLength(1);
  });
  it.each(['draining', 'revoked'] as const)('replaces a pending %s A reservation with approved B before admitting a launch', async (state) => {
    current = { generation: 'pending-A', imageVersion: '9', requestedAt: clock, admissionRequired: true };
    await admission.reserve(55, current.generation, clock);
    mocks.queued.mockResolvedValue(['waiting-job']);
    mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 2, state: imageVersion === '9' ? state : 'approved', protocol: 'tenant-browser-1', reason: 'Policy update' }));
    await managed().start(55);
    const launches = mocks.vm.mock.calls.filter(([command]) => command instanceof RunMicrovmCommand);
    expect(launches).toHaveLength(1);
    expect(launches[0]![0].input.imageVersion).toBe('10');
    expect(current!.generation).not.toBe('pending-A');
    expect(current!.imageVersion).toBe('10');
    expect((await admission.list()).map((lease) => lease.generation)).toEqual([current!.generation]);
    expect(await mocks.queued()).toEqual(['waiting-job']);
  });
  it.each(['draining', 'revoked'] as const)('quarantines an ambiguous %s A launch before replacement with B', async (state) => {
    current = { generation: 'pending-A', imageVersion: '9', requestedAt: clock, admissionRequired: true };
    await admission.reserve(55, current.generation, clock);
    await admission.launching(current.generation, clock);
    mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 2, state: imageVersion === '9' ? state : 'approved', protocol: 'tenant-browser-1', reason: 'Policy update' }));
    let oldStopped = false;
    mocks.vm.mockImplementation(async (command) => {
      if (command instanceof RunMicrovmCommand) {
        if (command.input.imageVersion === '9') {
          expect(current!.retiring).toBe(true);
          expect(command.input.clientToken).toBe('pending-A');
          expect(await admission.get('pending-A')).toMatchObject({ retiring: true, mayHaveLaunched: true });
          return { microvmId: 'mvm-old' };
        }
        expect(oldStopped).toBe(true);
        return { microvmId: 'mvm-new' };
      }
      if (command.constructor.name === 'TerminateMicrovmCommand') { oldStopped = true; return {}; }
      return { state: oldStopped ? 'TERMINATED' : 'RUNNING' };
    });
    await managed().start(55);
    expect(current).toMatchObject({ imageVersion: '10', microvmId: 'mvm-new' });
    expect((await admission.list()).map((lease) => lease.generation)).toEqual([current!.generation]);
  });

  it('checks the exact reserved image again when policy changes during connect preparation', async () => {
    current = { generation: 'pending-A', imageVersion: '9', requestedAt: clock, admissionRequired: true };
    await admission.reserve(55, current.generation, clock);
    let blocked = false;
    mocks.imagePolicy.mockImplementation(async (imageVersion: string) => ({ imageVersion, revision: 2, state: blocked && imageVersion === '9' ? 'revoked' : 'approved', protocol: 'tenant-browser-1', reason: 'Policy changed' }));
    mocks.secret.mockImplementation(async () => { blocked = true; return { SecretString: 'fixture-control-root-'.repeat(3) }; });
    await expect(managed().start(55)).rejects.toThrow('Reserved Claude image cannot start');
    expect(mocks.vm.mock.calls.filter(([command]) => command instanceof RunMicrovmCommand)).toHaveLength(0);
    expect(await admission.get('pending-A')).toMatchObject({ mayHaveLaunched: true });
  });

});
