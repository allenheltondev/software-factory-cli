import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { cloudConfig, runnerEnvironment, startCloudWorker } from '../native-worker/cloud.mjs';
import { bootPayload } from '../native-worker/hooks.mjs';
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
  it.each(['cancel', 'network failure'])('stops the runner and polling on %s without releasing a lease locally', async (failure) => {
    const child = fakeChild();
    const ops = [];
    const call = async (p) => {
      ops.push(p.op);
      if (p.op === 'poll') return { ok: true, request: { payload: {} } };
      if (p.op === 'heartbeat') { if (failure === 'network failure') throw new Error('offline'); return { ok: true, cancel: true }; }
      return { ok: true };
    };
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, { call, launch: () => child, interval: 5 });
    await worker.done;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ops).toEqual(['register', 'poll', 'heartbeat']);
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
  it('bounds a stuck heartbeat and stops execution without waiting for the transport', async () => {
    const child = fakeChild();
    const worker = await startCloudWorker(config, 'mvm-native', { authStatus: async () => 'connected' }, {
      interval: 5, callTimeout: 5, launch: () => child,
      call: async (p) => p.op === 'heartbeat' ? new Promise(() => {}) : { ok: true, ...(p.op === 'poll' ? { request: { payload: {} } } : {}) },
    });
    await worker.done;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
