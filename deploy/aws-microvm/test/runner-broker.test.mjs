// The runner's side of Updraft Cloud's job broker (version 2 run-hook payloads): parsing the
// payload, the broker client, the credential refresh and how a job is started. No AWS, no
// child processes: these run everywhere. runner-job.test.mjs runs a whole version 2 job.
import { describe, expect, it, vi } from 'vitest';
import { brokerCredentialProvider, createBrokerClient, CREDENTIAL_REFRESH_MARGIN_MS, startBrokerJob } from '../image/runner/broker.mjs';
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

  it.each([
    ['no broker', { broker: undefined }, /broker is missing/],
    ['a short job token', { broker: { functionName: 'f', jobId: 'job_abc12345', jobToken: 'short' } }, /broker\.jobToken/],
    ['a bad job id', { broker: { functionName: 'f', jobId: '../etc', jobToken: TOKEN } }, /broker\.jobId/],
    ['isolation turned off', { agentIsolation: 'disabled' }, /must be enforced/],
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
    };
    const createAwsDeps = vi.fn((_region, options) => ({ s3Get: 'scoped', credentials: options.credentials }));
    const { payload, deps } = await startBrokerJob(parse(v2()).payload, { client, createAwsDeps, now: () => NOW });
    expect(payload).toMatchObject({ version: 2, bucket: 'tenant-bucket', eventKey: descriptor.eventKey, configPrefix: descriptor.configPrefix, stateKey: descriptor.stateKey, agentKeySecrets: descriptor.agentKeySecrets });
    expect(createAwsDeps).toHaveBeenCalledWith('us-east-1', { credentials: expect.any(Function) });
    expect((await deps.credentials()).accessKeyId).toBe('ASIA');
    await expect(deps.githubToken()).resolves.toEqual({ token: 'ghs_x' });
    await deps.finishJob('succeeded');
    expect(client.finish).toHaveBeenCalledWith('succeeded');
  });

  it('refuses a descriptor that does not say where the job\'s data is', async () => {
    const client = { start: async () => ({ ok: true, descriptor: { bucket: 'b' }, credentials: {} }) };
    await expect(startBrokerJob(parse(v2()).payload, { client, createAwsDeps: () => ({}) })).rejects.toThrow(/no eventKey/);
  });
});
