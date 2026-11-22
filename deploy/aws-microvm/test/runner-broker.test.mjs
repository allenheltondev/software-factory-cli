// The runner's side of Updraft Cloud's job broker (version 2 run-hook payloads): parsing the
// payload, the broker client, the credential refresh and how a job is started. No AWS, no
// child processes: these run everywhere. runner-job.test.mjs runs a whole version 2 job.
import { describe, expect, it, vi } from 'vitest';
import {
  abandonBrokerJob,
  brokerCredentialProvider,
  createBrokerClient,
  CREDENTIAL_REFRESH_MARGIN_MS,
  START_FAILED_OUTCOME,
  startBrokerJob,
  TERMINATE_ATTEMPTS,
  TERMINATE_DELAY_MS,
  terminateThroughBroker,
} from '../image/runner/broker.mjs';
import { BROKER_PAYLOAD_VERSION, parseRunRequest } from '../image/runner/hooks.mjs';

const TOKEN = 'a'.repeat(43);
const NOW = Date.parse('2026-11-20T12:00:00.000Z');

const v2 = (overrides = {}) => ({
  version: 2,
  deliveryId: 'delivery-1',
  eventName: 'issues',
  region: 'us-east-1',
  broker: { functionName: 'updraft-cloud-broker', jobId: 'job_abc12345', jobToken: TOKEN },
  maximumDurationSeconds: 7200,
  watchdogReserveSeconds: 300,
  launchedAt: new Date(NOW).toISOString(),
  ...overrides,
});
const parse = (payload) => parseRunRequest({ microvmId: 'mvm-1', runHookPayload: JSON.stringify(payload) });

describe('parseRunRequest, version 2', () => {
  it('takes the job and its broker, and enforces isolation', () => {
    const { payload } = parse(v2());
    expect(payload).toEqual({ ...v2(), agentIsolation: 'enforced' });
    expect(payload.version).toBe(BROKER_PAYLOAD_VERSION);
    expect(payload.bucket).toBeUndefined();
  });

  it('carries a console retry, which makes run-event requeue the event\'s failed jobs first', () => {
    expect(parse(v2({ retry: true })).payload.retry).toBe(true);
    expect(parse(v2()).payload).not.toHaveProperty('retry');
  });

  it.each([
    ['no broker', { broker: undefined }, /broker is missing/],
    ['a short job token', { broker: { functionName: 'f', jobId: 'job_abc12345', jobToken: 'short' } }, /broker\.jobToken/],
    ['a bad job id', { broker: { functionName: 'f', jobId: '../etc', jobToken: TOKEN } }, /broker\.jobId/],
    ['isolation turned off', { agentIsolation: 'disabled' }, /must be enforced/],
    ['a retry that is not true', { retry: 'yes' }, /retry is malformed/],
    ['no launch time', { launchedAt: 'soon' }, /launchedAt/],
  ])('refuses %s', (_what, overrides, message) => {
    expect(() => parse(v2(overrides))).toThrow(message);
  });

  it('never repeats the job token in an error', () => {
    try {
      parse(v2({ broker: { functionName: 'bad name with spaces', jobId: 'job_abc12345', jobToken: TOKEN } }));
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});

describe('createBrokerClient', () => {
  it('sends the job id and token with each action, and throws without the token on a refusal', async () => {
    const invoke = vi.fn(async (_fn, body) => (body.action === 'finish' ? { ok: false, error: 'refused' } : { ok: true, tokenFile: { token: 'ghs_x' } }));
    const client = createBrokerClient({ functionName: 'broker', jobId: 'job_abc12345', jobToken: TOKEN, region: 'us-east-1' }, { invoke });
    await expect(client.githubToken()).resolves.toEqual({ token: 'ghs_x' });
    expect(invoke).toHaveBeenCalledWith('broker', { action: 'github-token', jobId: 'job_abc12345', token: TOKEN });
    const err = await client.finish('succeeded').catch((e) => e);
    expect(err.message).toMatch(/refused finish \(refused\)/);
    expect(err.message).not.toContain(TOKEN);
    expect(invoke).toHaveBeenLastCalledWith('broker', { action: 'finish', jobId: 'job_abc12345', token: TOKEN, outcome: 'succeeded' });
    await client.terminate();
    expect(invoke).toHaveBeenLastCalledWith('broker', { action: 'terminate', jobId: 'job_abc12345', token: TOKEN });
  });
});

describe('brokerCredentialProvider', () => {
  const creds = (id, expiresAt) => ({ accessKeyId: id, secretAccessKey: 's', sessionToken: 't', expiration: new Date(expiresAt).toISOString() });

  it('uses the credentials it has until shortly before they expire, then asks once for new ones', async () => {
    let now = NOW;
    const client = { credentials: vi.fn(async () => ({ credentials: creds('second', NOW + 2 * 3_600_000) })) };
    const provide = brokerCredentialProvider(client, creds('first', NOW + 3_600_000), { now: () => now });
    expect((await provide()).accessKeyId).toBe('first');
    now = NOW + 3_600_000 - CREDENTIAL_REFRESH_MARGIN_MS + 1;
    const [a, b] = await Promise.all([provide(), provide()]);
    expect([a.accessKeyId, b.accessKeyId]).toEqual(['second', 'second']);
    expect(client.credentials).toHaveBeenCalledOnce();
    expect(a.expiration).toBeInstanceOf(Date);
  });

  it('refuses credentials it cannot use', () => {
    expect(() => brokerCredentialProvider({}, { accessKeyId: 'x' })).toThrow(/no usable credentials/);
  });
});

describe('terminateThroughBroker', () => {
  // The broker's side: "unavailable" until the launcher has recorded the job's microVM.
  const brokerAttachingAfter = (calls) => {
    let seen = 0;
    const invoke = vi.fn(async (_fn, body) => {
      expect(body.action).toBe('terminate');
      seen += 1;
      return seen > calls ? { ok: true, terminated: true } : { ok: false, error: 'unavailable' };
    });
    return { invoke, client: createBrokerClient({ functionName: 'broker', jobId: 'job_abc12345', jobToken: TOKEN, region: 'us-east-1' }, { invoke }) };
  };

  it('keeps asking, with growing pauses, until the launcher has recorded the microVM', async () => {
    const { invoke, client } = brokerAttachingAfter(2);
    const wait = vi.fn(async () => {});
    await terminateThroughBroker(client, { wait });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[TERMINATE_DELAY_MS], [2 * TERMINATE_DELAY_MS]]);
  });

  it('gives up after a bounded number of attempts, and says why', async () => {
    const { invoke, client } = brokerAttachingAfter(Infinity);
    const wait = vi.fn(async () => {});
    await expect(terminateThroughBroker(client, { wait })).rejects.toThrow(/refused terminate \(unavailable\)/);
    expect(invoke).toHaveBeenCalledTimes(TERMINATE_ATTEMPTS);
    // About half a minute in all, so a launcher that is a little slow is waited for.
    const total = wait.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(25_000);
    expect(total).toBeLessThanOrEqual(60_000);
  });

  it('is what a started job terminates with', async () => {
    const { invoke, client } = brokerAttachingAfter(1);
    const started = {
      ok: true,
      descriptor: { bucket: 'b', eventKey: 'e', configPrefix: 'c/', resultKeyPrefix: 'r/', stateKey: 's/state.db' },
      credentials: { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(NOW + 3_600_000).toISOString() },
    };
    client.start = async () => started;
    const { deps } = await startBrokerJob(parse(v2()).payload, { client, createAwsDeps: () => ({}), now: () => NOW, terminateOptions: { wait: async () => {} } });
    await deps.terminate('mvm-1');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('abandonBrokerJob (the broker did not start the job)', () => {
  const clientWith = (invoke) => createBrokerClient({ functionName: 'broker', jobId: 'job_abc12345', jobToken: TOKEN, region: 'us-east-1' }, { invoke });

  it('reports the failed start first, so the delivery can be redelivered, then stops the microVM', async () => {
    // The broker's start failed transiently (a throttled STS call); finish and terminate answer.
    const invoke = vi.fn(async (_fn, body) => (body.action === 'finish' ? { ok: true, finished: true } : { ok: true, terminated: true }));
    expect(await abandonBrokerJob(clientWith(invoke), { wait: async () => {} })).toEqual([]);
    expect(invoke.mock.calls.map(([, body]) => body)).toEqual([
      { action: 'finish', jobId: 'job_abc12345', token: TOKEN, outcome: START_FAILED_OUTCOME },
      { action: 'terminate', jobId: 'job_abc12345', token: TOKEN },
    ]);
    expect(START_FAILED_OUTCOME).not.toBe('succeeded');
  });

  it('retries the finish, and stops the microVM even when the finish never lands', async () => {
    let finishes = 0;
    const invoke = vi.fn(async (_fn, body) => {
      if (body.action === 'terminate') return { ok: true, terminated: true };
      finishes += 1;
      if (finishes === 1) throw new Error('Rate exceeded');
      return { ok: true, finished: true };
    });
    expect(await abandonBrokerJob(clientWith(invoke), { wait: async () => {} })).toEqual([]);
    expect(finishes).toBe(2);

    const down = vi.fn(async (_fn, body) => (body.action === 'terminate' ? { ok: true, terminated: true } : { ok: false, error: 'unavailable' }));
    const problems = await abandonBrokerJob(clientWith(down), { wait: async () => {} });
    expect(problems).toEqual([expect.stringMatching(/did not record the failed start.*refused finish \(unavailable\)/)]);
    expect(down.mock.calls.filter(([, body]) => body.action === 'finish')).toHaveLength(TERMINATE_ATTEMPTS);
    expect(down).toHaveBeenLastCalledWith('broker', { action: 'terminate', jobId: 'job_abc12345', token: TOKEN });
  });
});

describe('startBrokerJob', () => {
  it('fills the descriptor into the payload and scopes S3 and Secrets Manager to the broker\'s credentials', async () => {
    const descriptor = {
      bucket: 'tenant-bucket',
      region: 'us-east-1',
      eventKey: 'tenants/55/events/delivery-1/event.json',
      configPrefix: 'tenants/55/config/3/',
      resultKeyPrefix: 'tenants/55/results/delivery-1/',
      stateKey: 'tenants/55/state/state.db',
      agentKeySecrets: { ANTHROPIC_API_KEY: 'updraft/tenants/55/agent-keys/ANTHROPIC_API_KEY' },
    };
    const client = {
      start: vi.fn(async () => ({ ok: true, descriptor, credentials: { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(NOW + 3_600_000).toISOString() } })),
      githubToken: vi.fn(async () => ({ token: 'ghs_x' })),
      finish: vi.fn(async () => ({ ok: true })),
      terminate: vi.fn(async () => ({ ok: true, terminated: true })),
    };
    const executionRoleTerminate = vi.fn();
    const createAwsDeps = vi.fn((_region, options) => ({ s3Get: 'scoped', credentials: options.credentials, terminate: executionRoleTerminate }));
    const { payload, deps } = await startBrokerJob(parse(v2()).payload, { client, createAwsDeps, now: () => NOW });
    expect(payload).toMatchObject({ version: 2, bucket: 'tenant-bucket', eventKey: descriptor.eventKey, configPrefix: descriptor.configPrefix, stateKey: descriptor.stateKey, agentKeySecrets: descriptor.agentKeySecrets });
    expect(createAwsDeps).toHaveBeenCalledWith('us-east-1', { credentials: expect.any(Function) });
    expect((await deps.credentials()).accessKeyId).toBe('ASIA');
    await expect(deps.githubToken()).resolves.toEqual({ token: 'ghs_x' });
    await deps.finishJob('succeeded', { prUrl: 'https://github.com/o/r/pull/7' });
    expect(client.finish).toHaveBeenCalledWith('succeeded', { prUrl: 'https://github.com/o/r/pull/7' });
    // The broker stops the job's own microVM; the execution role is never asked to.
    await deps.terminate('mvm-anything');
    expect(client.terminate).toHaveBeenCalledOnce();
    expect(executionRoleTerminate).not.toHaveBeenCalled();
  });

  it('refuses a descriptor that does not say where the job\'s data is', async () => {
    const client = { start: async () => ({ ok: true, descriptor: { bucket: 'b' }, credentials: {} }) };
    await expect(startBrokerJob(parse(v2()).payload, { client, createAwsDeps: () => ({}) })).rejects.toThrow(/no eventKey/);
  });
});
