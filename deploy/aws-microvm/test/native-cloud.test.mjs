import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { cloudConfig, runnerEnvironment, startCloudWorker, TRANSIENT_BUDGET_MS } from '../native-worker/cloud.mjs';
import { brokerResponse, transientInvokeError } from '../image/runner/worker-control.mjs';
import { bootPayload } from '../native-worker/hooks.mjs';
import { loginRouteFor } from '../native-worker/browser-login.mjs';
import { nativeConfig, NATIVE_RUNTIME } from '../image/runner/native-config.mjs';
import { checkAgentConfig, SANDBOX_RUNTIME, SANDBOX_IMAGE } from '../image/runner/isolation.mjs';

const config = { region: 'us-east-1', brokerFunctionName: 'broker', workerId: 'test-worker', imageVersion: '7', workerVersion: '104',
  controlSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/test-abcdef' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await pause(5); } throw new Error('condition timed out'); }
function fakeChild() {
  const c = new EventEmitter();
  c.kill = vi.fn(() => globalThis.queueMicrotask(() => c.emit('close')));
  return c;
}
describe('root subscription worker Cloud loop', () => {
  it('accepts only storage and explicit control references at boot', () => {
    expect(bootPayload(JSON.stringify({ fileSystemId: 'fs-12345678', accessPointId: 'fsap-12345678', cloud: config })).cloud).toEqual(config);
    expect(() => cloudConfig({ ...config, claudeToken: 'never' })).toThrow();
    expect(() => cloudConfig({ ...config, controlSecretArn: '/native/home/.credentials' })).toThrow();
  });
  it('starts the root runner with sbin on PATH (nft is /usr/sbin/nft) and no inherited secrets', () => {
    const env = runnerEnvironment(config, { payload: {} }, {
      ANTHROPIC_API_KEY: 'never', CLAUDE_CONFIG_DIR: '/native/home', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
    });
    expect(env.PATH.split(':')).toEqual(expect.arrayContaining(['/usr/sbin', '/sbin', '/usr/bin', '/bin']));
    expect(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBe('http://169.254.170.23/v1/credentials');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(env.UPDRAFT_NATIVE_WORKER).toBe('1');
  });
  it('forces all Claude profiles into the shared slot and verifies other profiles through the existing sandbox', () => {
    const input = { agents: { claude: { authentication: 'default', container: { image: 'other', env: ['ANTHROPIC_API_KEY'] } },
      reviewer: { adapter: 'claude' }, codex: { adapter: 'codex', container: { runtime: SANDBOX_RUNTIME, image: SANDBOX_IMAGE, env: ['CODEX_API_KEY'] } } } };
    const output = nativeConfig(input);
    expect(output.agents.claude.container.runtime).toBe(NATIVE_RUNTIME);
    expect(output.agents.reviewer.capacityGroup).toBe(output.agents.claude.capacityGroup);
    expect(output.agents.claude.authentication).toBeUndefined();
    expect(checkAgentConfig(output, { nativeWorker: true })).toEqual([]);
    expect(checkAgentConfig(output)).not.toEqual([]); // no general runtime exception
    output.agents.reviewer.container.env = ['ANTHROPIC_API_KEY'];
    expect(checkAgentConfig(output, { nativeWorker: true }).join()).toMatch(/empty environment/);
    expect(() => nativeConfig({ agents: {}, triage: { agent: 'claude' } })).toThrow();
  });
  it('registers sanitized readiness, executes one assignment, and acknowledges settlement before another poll', async () => {
    const child = fakeChild();
    let assigned = false;
    let settled = false;
    const calls = [];
    const call = async (p) => {
      calls.push(p);
      if (p.op === 'poll' && !assigned) { assigned = true; return { ok: true, request: { payload: { broker: { jobToken: 'job-only' } } } }; }
      if (p.op === 'settled') settled = true;
      return { ok: true, busy: false };
    };
    const launch = vi.fn(() => child);
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, { call, launch, interval: 5 });
    await until(() => launch.mock.calls.length === 1);
    child.emit('close');
    await until(() => settled);
    await worker.close();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ op: 'register', auth: 'connected' });
    expect(calls[0]).not.toHaveProperty('controlSecretArn');
    expect(calls[0]).not.toHaveProperty('rawStatus');
  });
  it("applies each assignment's registry policy before its runner starts and removes it when the runner exits (#157)", async () => {
    const children = [fakeChild(), fakeChild()];
    const events = [];
    let polls = 0;
    const call = async (p) => {
      if (p.op === 'poll') {
        polls += 1;
        if (polls === 1) return { ok: true, request: { payload: { broker: { jobId: 'job_a' } } }, egress: { jobId: 'job_a', hosts: ['npm.pkg.github.com'] } };
        if (polls === 2) return { ok: true, request: { payload: { broker: { jobId: 'job_b' } } }, egress: { jobId: 'job_a', hosts: ['npm.pkg.github.com'] } };
      }
      if (p.op === 'settled') events.push('settled');
      return { ok: true, busy: false };
    };
    const service = {
      authStatus: async () => 'connected',
      applyJobEgress: vi.fn((egress, jobId) => events.push(`apply ${jobId} ${JSON.stringify(egress)}`)),
      resetJobEgress: vi.fn(() => events.push('reset')),
    };
    let launched = 0;
    const launch = vi.fn(() => { events.push('launch'); return children[launched++]; });
    const worker = await startCloudWorker(config, 'mvm-native', service, { call, launch, interval: 5 });
    await until(() => launch.mock.calls.length === 1);
    children[0].emit('close');
    await until(() => launch.mock.calls.length === 2);
    children[1].emit('close');
    await until(() => events.filter((e) => e === 'settled').length === 2);
    await worker.close();
    expect(events).toEqual([
      `apply job_a ${JSON.stringify({ jobId: 'job_a', hosts: ['npm.pkg.github.com'] })}`, 'launch', 'reset', 'settled',
      // The second assignment carries a policy for another job: it is passed with the real job id,
      // and parseJobEgress (the supervisor) refuses it, leaving the image's hosts only.
      `apply job_b ${JSON.stringify({ jobId: 'job_a', hosts: ['npm.pkg.github.com'] })}`, 'launch', 'reset', 'settled',
      'reset',
    ]);
  });
  it("stops, without polling again, when a finished job's registry hosts cannot be removed", async () => {
    const child = fakeChild();
    const ops = [];
    const call = async (p) => {
      ops.push(p.op);
      if (p.op === 'poll') return { ok: true, request: { payload: { broker: { jobId: 'job_a' } } }, egress: { jobId: 'job_a', hosts: ['npm.pkg.github.com'] } };
      return { ok: true, busy: false };
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const launch = vi.fn(() => child);
    const service = { authStatus: async () => 'connected', applyJobEgress: vi.fn(), resetJobEgress: vi.fn(() => { throw new Error('proxy gone'); }) };
    const worker = await startCloudWorker(config, 'mvm-native', service, { call, launch, interval: 5 });
    await until(() => launch.mock.calls.length === 1);
    child.emit('close');
    await worker.done;
    expect(launch).toHaveBeenCalledTimes(1);
    expect(ops.filter((op) => op === 'poll')).toHaveLength(1);
    expect(ops).not.toContain('settled');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('registry hosts failed'));
    error.mockRestore();
    await worker.close();
  });
  it('starts no runner when the registry policy cannot be applied', async () => {
    const launch = vi.fn(() => fakeChild());
    const service = { authStatus: async () => 'connected', applyJobEgress: () => { throw new Error('proxy gone'); }, resetJobEgress: vi.fn() };
    const call = async (p) => (p.op === 'poll' ? { ok: true, request: { payload: { broker: { jobId: 'job_a' } } }, egress: { jobId: 'job_a', hosts: [] } } : { ok: true });
    const worker = await startCloudWorker(config, 'mvm-native', service, { call, launch, interval: 5 });
    await worker.done;
    expect(launch).not.toHaveBeenCalled();
    await worker.close();
  });
  it.each(['cancel', 'network failure'])('stops the runner and polling on %s without releasing a lease locally', async (failure) => {
    const child = fakeChild();
    const ops = [];
    const call = async (p) => {
      ops.push(p.op);
      if (p.op === 'poll') return { ok: true, request: { payload: {} } };
      if (p.op === 'heartbeat') { if (failure === 'network failure') throw new Error('offline'); return { ok: true, cancel: true }; }
      if (p.op === 'settled') return { ok: true, busy: true };
      return { ok: true };
    };
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, { call, launch: () => child, interval: 5 });
    await worker.done;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ops).toEqual(['register', 'poll', 'heartbeat', ...(failure === 'cancel' ? ['settled', 'settled', 'settled'] : [])]);
    await worker.close();
  });
  it('keeps the signed-in session after a cooperative cancel only when the server confirms settlement', async () => {
    const child = fakeChild(); let polls = 0; let settled = false;
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, launch: () => child,
      call: async (p) => {
        if (p.op === 'poll' && ++polls === 1) return { ok: true, request: { payload: {} } };
        if (p.op === 'heartbeat') return { ok: true, cancel: true };
        if (p.op === 'settled') settled = true;
        return { ok: true, busy: false };
      },
    });
    await until(() => polls >= 2);
    expect(settled).toBe(true); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await worker.close();
  });
  it('settles and keeps polling when a cancel arrives after the runner already exited (#144)', async () => {
    const child = fakeChild();
    const ops = [];
    let polls = 0;
    const call = async (p) => {
      ops.push(p.op);
      if (p.op === 'poll') return ++polls === 1 ? { ok: true, request: { payload: {} } } : { ok: true, busy: false };
      if (p.op === 'heartbeat') return { ok: true, cancel: true };
      return { ok: true, busy: false };
    };
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, { call, launch: () => { globalThis.queueMicrotask(() => child.emit('close')); return child; }, interval: 5 });
    await until(() => polls >= 3);
    await worker.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(ops.slice(0, 4)).toEqual(['register', 'poll', 'heartbeat', 'settled']);
  });
  it('waits for transient settlement contention before running a distinct job on the same session', async () => {
    const ops = []; const sessions = new Set(); let polls = 0; let settlements = 0;
    const launch = vi.fn(() => {
      const child = fakeChild();
      globalThis.queueMicrotask(() => child.emit('close'));
      return child;
    });
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, launch,
      call: async (p) => {
        ops.push(p.op); sessions.add(p.session);
        if (p.op === 'poll' && ++polls <= 2) return { ok: true, request: { payload: { jobId: `job-${polls}` } } };
        if (p.op === 'settled') return { ok: true, busy: ++settlements <= 2 };
        return { ok: true, busy: false };
      },
    });
    await until(() => polls >= 3);
    await worker.close();
    expect(ops.slice(0, 7)).toEqual(['register', 'poll', 'heartbeat', 'settled', 'settled', 'settled', 'poll']);
    expect(launch.mock.calls.map(([request]) => request.payload.jobId)).toEqual(['job-1', 'job-2']);
    expect(sessions.size).toBe(1);
    expect(launch.mock.results.every(({ value }) => value.kill.mock.calls.length === 0)).toBe(true);
  });
  it('never retries an uncertain settlement transport or polls another assignment', async () => {
    const child = fakeChild(); const ops = [];
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, launch: () => { globalThis.queueMicrotask(() => child.emit('close')); return child; },
      call: async (p) => {
        ops.push(p.op);
        if (p.op === 'settled') throw new Error('uncertain response');
        return { ok: true, ...(p.op === 'poll' ? { request: { payload: {} } } : {}) };
      },
    });
    await worker.done;
    expect(ops).toEqual(['register', 'poll', 'heartbeat', 'settled']);
  });
  it('probes auth once more before reporting it unavailable, and never reuses an earlier answer', async () => {
    const answers = ['connected', 'unavailable', 'connected', 'unavailable', 'unavailable'];
    const polled = [];
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => answers.shift() ?? 'unavailable' }, {
      interval: 5, authRetryDelay: 1,
      call: async (p) => { if (p.op === 'poll') polled.push(p.auth); return { ok: true, busy: false }; },
    });
    await until(() => polled.length >= 2);
    await worker.close();
    expect(polled.slice(0, 2)).toEqual(['connected', 'unavailable']);
  });
  it('does not renew a lease after a spawn error or exit without confirmed settlement', async () => {
    const child = fakeChild();
    let heartbeats = 0;
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, launch: () => { globalThis.queueMicrotask(() => child.emit('error', new Error('spawn failed'))); return child; },
      call: async (p) => {
        if (p.op === 'poll') return { ok: true, request: { payload: {} } };
        if (p.op === 'heartbeat') heartbeats++;
        return { ok: true, busy: p.op === 'settled' };
      },
    });
    await worker.done;
    expect(heartbeats).toBe(1);
  });
  it('bounds a stuck heartbeat and stops execution once its retry budget is spent, without waiting for the transport', async () => {
    const child = fakeChild();
    let heartbeats = 0;
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, callTimeout: 5, transientBudget: 40, maxBackoff: 10, launch: () => child,
      call: async (p) => p.op === 'heartbeat' ? (heartbeats++, new Promise(() => {})) : { ok: true, ...(p.op === 'poll' ? { request: { payload: {} } } : {}) },
    });
    await worker.done;
    expect(heartbeats).toBeGreaterThan(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

// #125: a Codex session runs on the same image; its run hook names the provider, Claude's does not.
describe('a Codex session on the subscription worker image', () => {
  const codex = { ...config, provider: 'codex' };
  it('accepts a Codex run hook beside the unchanged Claude one, and nothing else', () => {
    expect(cloudConfig(config)).toEqual(config);
    expect(cloudConfig(codex)).toEqual(codex);
    expect(bootPayload(JSON.stringify({ storage: 'ephemeral', cloud: { ...codex, controlSecretArn: undefined, controlToken: 'a'.repeat(43) } })).cloud.provider).toBe('codex');
    for (const provider of ['claude', 'kiro', '', null, 1]) expect(() => cloudConfig({ ...config, provider })).toThrow();
    expect(() => cloudConfig({ ...codex, chatgptToken: 'never' })).toThrow();
  });
  it('serves only its own provider\'s sign-in route', () => {
    // A Claude session (no provider in its run hook): only /claude-login, even with Codex installed.
    expect(loginRouteFor('/claude-login')).toBe('claude');
    expect(loginRouteFor('/codex-login', 'claude', true)).toBeUndefined();
    // A Codex session: only /codex-login, and only where the image installs Codex.
    expect(loginRouteFor('/codex-login', 'codex', true)).toBe('codex');
    expect(loginRouteFor('/claude-login', 'codex', true)).toBeUndefined();
    expect(loginRouteFor('/codex-login', 'codex', false)).toBeUndefined();
    for (const url of ['/', '/claude-login/', '/codex-login?x', undefined]) {
      expect(loginRouteFor(url)).toBeUndefined();
      expect(loginRouteFor(url, 'codex', true)).toBeUndefined();
    }
  });
  it('tells the root runner its provider only for Codex, from the run hook and never the job', () => {
    expect(runnerEnvironment(config, { payload: {} })).not.toHaveProperty('UPDRAFT_NATIVE_PROVIDER');
    expect(runnerEnvironment(codex, { payload: {} }).UPDRAFT_NATIVE_PROVIDER).toBe('codex');
    expect(runnerEnvironment(config, { payload: { provider: 'codex' } }, { UPDRAFT_NATIVE_PROVIDER: 'codex' })).not.toHaveProperty('UPDRAFT_NATIVE_PROVIDER');
  });
  it('reports the Codex login to Cloud on a Codex session and the Claude login, as before, otherwise', async () => {
    for (const [settings, expected] of [[config, []], [codex, ['codex']]]) {
      const authStatus = vi.fn(async () => 'auth-required');
      const calls = [];
      const worker = await startCloudWorker(settings, 'mvm-native', { authStatus }, {
        call: async (p) => { calls.push(p); return { ok: true, busy: false }; }, launch: vi.fn(), interval: 5,
      });
      await until(() => calls.some((p) => p.op === 'poll'));
      await worker.close();
      expect(authStatus.mock.calls.every((args) => JSON.stringify(args) === JSON.stringify(expected))).toBe(true);
      expect(calls[0]).toMatchObject({ op: 'register', auth: 'auth-required' });
      expect(calls[0]).not.toHaveProperty('provider');
    }
  });
  it('runs only the Codex profiles on the native worker for a Codex session, leaving Claude on its sandbox and key', () => {
    const input = { agents: {
      codex: { adapter: 'codex', authentication: 'native-codex', model: 'gpt-5.5', container: { image: 'other', env: ['CODEX_API_KEY'] } },
      reviewer: { adapter: 'claude', container: { runtime: SANDBOX_RUNTIME, image: SANDBOX_IMAGE, env: ['ANTHROPIC_API_KEY'] } },
    } };
    const output = nativeConfig(JSON.parse(JSON.stringify(input)), 'codex');
    expect(output.agents.codex).toMatchObject({ command: 'codex', maxConcurrent: 1, container: { runtime: NATIVE_RUNTIME, network: 'none', env: [] } });
    expect(output.agents.codex.authentication).toBeUndefined();
    expect(output.agents.reviewer.container.runtime).toBe(SANDBOX_RUNTIME);
    expect(checkAgentConfig(output, { nativeWorker: true, nativeProvider: 'codex' })).toEqual([]);
    // Judged as a Claude session, the same config is refused: the Codex profile is not on the sandbox.
    expect(checkAgentConfig(output, { nativeWorker: true })).not.toEqual([]);
    // The Claude default is unchanged.
    expect(nativeConfig(JSON.parse(JSON.stringify(input))).agents.reviewer.container.runtime).toBe(NATIVE_RUNTIME);
    expect(() => nativeConfig({ agents: { reviewer: input.agents.reviewer } }, 'codex')).toThrow('no enabled Codex profile');
    expect(() => nativeConfig(JSON.parse(JSON.stringify(input)), 'kiro')).toThrow();
  });
});

// #176: a backend redeploy (a throttled, cold, or updating broker) must not end a healthy session.
describe('transient broker failures', () => {
  const flaky = (message = 'worker broker unavailable') => Object.assign(new Error(message), { transient: true });
  it('keeps polling through transient poll failures, then runs the next assignment on the same session', async () => {
    const ops = []; const sessions = new Set(); let polls = 0;
    const launch = vi.fn(() => { const child = fakeChild(); globalThis.queueMicrotask(() => child.emit('close')); return child; });
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, maxBackoff: 10, launch,
      call: async (p) => {
        ops.push(p.op); sessions.add(p.session);
        if (p.op === 'poll') {
          polls++;
          if (polls <= 3) throw flaky();
          if (polls === 4) return { ok: true, request: { payload: { jobId: 'job-after-deploy' } } };
        }
        return { ok: true, busy: false };
      },
    });
    await until(() => polls >= 5);
    await worker.close();
    expect(launch.mock.calls.map(([r]) => r.payload.jobId)).toEqual(['job-after-deploy']);
    expect(ops.slice(0, 7)).toEqual(['register', 'poll', 'poll', 'poll', 'poll', 'heartbeat', 'settled']);
    expect(sessions.size).toBe(1);
  });
  // Within its 60 s assignment lease (control.ts WORKER_LEASE_MS): a longer gap lets Cloud fence
  // the assignment, and the next heartbeat's refusal stops the job.
  it('keeps a running job through a short transient heartbeat gap, within its lease, and settles it normally', async () => {
    const child = fakeChild(); let polls = 0; let heartbeats = 0; let settled = false;
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, maxBackoff: 10, launch: () => child,
      call: async (p) => {
        if (p.op === 'poll') return ++polls === 1 ? { ok: true, request: { payload: {} } } : { ok: true, busy: false };
        if (p.op === 'heartbeat') {
          if (++heartbeats <= 2) throw flaky('worker control request timed out');
          if (heartbeats === 3) globalThis.queueMicrotask(() => child.emit('close'));
          return { ok: true, busy: true, cancel: false };
        }
        if (p.op === 'settled') settled = true;
        return { ok: true, busy: false };
      },
    });
    await until(() => polls >= 2);
    await worker.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(settled).toBe(true);
  });
  it.each([
    ['a refusal', () => new Error('worker broker refused request')],
    ['an unclassified failure', () => new Error('offline')],
  ])('stops for good on %s, at once', async (_name, error) => {
    const ops = [];
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, call: async (p) => { ops.push(p.op); if (p.op === 'poll') throw error(); return { ok: true }; },
    });
    await worker.done;
    expect(ops).toEqual(['register', 'poll']);
  });
  it('stops an idle worker once transient failures outlast the two-minute budget, which is shorter than Cloud\'s worker-lost grace', async () => {
    let clock = 0; let polls = 0;
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, maxBackoff: 5, now: () => clock,
      call: async (p) => { if (p.op === 'poll') { polls++; clock += 50_000; throw flaky(); } return { ok: true }; },
    });
    await worker.done;
    // Failing since the first poll: 50 s, 100 s within two minutes; 150 s is past it.
    expect(polls).toBe(4);
    expect(TRANSIENT_BUDGET_MS).toBeLessThan(3 * 60_000);
  });
  it('stops a running job once a heartbeat retried past its lease is refused', async () => {
    const child = fakeChild(); let heartbeats = 0;
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, maxBackoff: 5, launch: () => child,
      call: async (p) => {
        if (p.op === 'poll') return { ok: true, request: { payload: {} } };
        if (p.op === 'heartbeat') {
          if (++heartbeats <= 2) throw flaky();
          throw new Error('worker broker refused request'); // the expired lease was fenced
        }
        return { ok: true };
      },
    });
    await worker.done;
    expect(heartbeats).toBe(3);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('never retries an uncertain settlement, even a transient one', async () => {
    const child = fakeChild(); const ops = [];
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, launch: () => { globalThis.queueMicrotask(() => child.emit('close')); return child; },
      call: async (p) => {
        ops.push(p.op);
        if (p.op === 'settled') throw flaky();
        return { ok: true, ...(p.op === 'poll' ? { request: { payload: {} } } : {}) };
      },
    });
    await worker.done;
    expect(ops).toEqual(['register', 'poll', 'heartbeat', 'settled']);
  });
});

describe('broker invocation classification', () => {
  it('marks transport faults transient and refusals final', () => {
    for (const error of [
      Object.assign(new Error('t'), { name: 'TimeoutError' }), Object.assign(new Error('t'), { name: 'TooManyRequestsException' }),
      Object.assign(new Error('t'), { name: 'ResourceConflictException' }), Object.assign(new Error('t'), { $metadata: { httpStatusCode: 503 } }),
      Object.assign(new Error('t'), { code: 'ECONNRESET' }),
    ]) expect(transientInvokeError(error)).toBe(true);
    for (const error of [
      Object.assign(new Error('t'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }),
      Object.assign(new Error('t'), { name: 'ResourceNotFoundException', $metadata: { httpStatusCode: 404 } }), new Error('t'), null,
    ]) expect(transientInvokeError(error)).toBe(false);
    expect(() => brokerResponse({ FunctionError: 'Unhandled' })).toThrow(expect.objectContaining({ transient: true }));
    const refused = (() => { try { brokerResponse({ Payload: Buffer.from(JSON.stringify({ ok: false })) }); } catch (e) { return e; } })();
    expect(refused.message).toBe('worker broker refused request');
    expect(refused.transient).toBeUndefined();
    expect(() => brokerResponse({ Payload: Buffer.from('not json') })).toThrow();
    expect(brokerResponse({ Payload: Buffer.from(JSON.stringify({ ok: true, busy: false })) })).toEqual({ ok: true, busy: false });
  });
  it("treats the broker handler's own failure ('unavailable') as transient for a poll or heartbeat only, never a settlement", () => {
    const unavailable = { Payload: Buffer.from(JSON.stringify({ ok: false, error: 'unavailable' })) };
    const thrown = (op) => { try { brokerResponse(unavailable, op); } catch (e) { return e; } return undefined; };
    for (const op of ['poll', 'heartbeat']) expect(thrown(op)).toMatchObject({ transient: true });
    for (const op of ['settled', 'register', 'cancel', undefined]) {
      expect(thrown(op).message).toBe('worker broker refused request');
      expect(thrown(op).transient).toBeUndefined();
    }
    // A plain refusal of a poll stays final.
    const refusedPoll = (() => { try { brokerResponse({ Payload: Buffer.from(JSON.stringify({ ok: false })) }, 'poll'); } catch (e) { return e; } })();
    expect(refusedPoll.transient).toBeUndefined();
  });
});
