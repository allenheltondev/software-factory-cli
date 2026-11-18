import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideEvent } from '../launcher/lib/filter.mjs';
import {
  MAX_RUN_HOOK_PAYLOAD_BYTES,
  buildRunMicrovmInput,
  handleWebhook,
  loadConfig,
} from '../launcher/lib/launch.mjs';
import { signBody, verifySignature } from '../launcher/lib/signature.mjs';
import { parseRunRequest } from '../image/runner/hooks.mjs';

const WEBHOOK_SECRET = 'webhook-secret-for-tests';
const REGION = 'eu-test-1';
const ACCOUNT = '000000000000';

const env = {
  AWS_REGION: REGION,
  IMAGE_ARN: `arn:aws:lambda:${REGION}:${ACCOUNT}:microvm-image:updraft-job`,
  EXECUTION_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/exec`,
  INGRESS_CONNECTOR_ARN: `arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:NO_INGRESS`,
  EGRESS_CONNECTOR_ARN: `arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
  MICROVM_LOG_GROUP: '/aws/lambda-microvms/updraft-job',
  BUCKET: 'job-bucket',
  WEBHOOK_SECRET_ARN: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:webhook-AbCdEf`,
  GITHUB_APP_KEY_SECRET_ARN: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:app-key-AbCdEf`,
  AGENT_ENV_SECRET_ARN: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:agent-env-AbCdEf`,
  MAX_DURATION_SECONDS: '7200',
  WATCHDOG_RESERVE_SECONDS: '300',
};

const labeled = (overrides = {}) => ({
  action: 'labeled',
  label: { name: 'ready' },
  issue: { number: 12, title: 'Add a thing', body: 'Please.' },
  repository: { id: 1, full_name: 'octo/repo' },
  sender: { login: 'someone' },
  ...overrides,
});

function request(payload, { secret = WEBHOOK_SECRET, event = 'issues', delivery = '5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10', headers = {}, base64 = false } = {}) {
  const raw = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return {
    headers: {
      'x-hub-signature-256': signBody(raw, secret),
      'x-github-event': event,
      'x-github-delivery': delivery,
      'content-type': 'application/json',
      ...headers,
    },
    body: base64 ? raw.toString('base64') : raw.toString('utf8'),
    isBase64Encoded: base64,
  };
}

function deps(overrides = {}) {
  const calls = { put: [], run: [], log: [] };
  return {
    calls,
    config: loadConfig(env),
    getWebhookSecret: async () => WEBHOOK_SECRET,
    putObject: async (bucket, key, body) => {
      calls.put.push({ bucket, key, body });
    },
    runMicrovm: async (input) => {
      calls.run.push(input);
      return { microvmId: 'mvm-01234567-abcd-ef01-2345-6789abcdef01', state: 'PENDING' };
    },
    log: (entry) => calls.log.push(entry),
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifySignature', () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');

  it('accepts the signature GitHub would send', () => {
    // The example from GitHub's "Validating webhook deliveries" documentation.
    expect(
      verifySignature(
        Buffer.from('Hello, World!'),
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
        "It's a Secret to Everybody",
      ),
    ).toBe(true);
    expect(verifySignature(body, signBody(body, WEBHOOK_SECRET), WEBHOOK_SECRET)).toBe(true);
    expect(verifySignature(body, signBody(body, WEBHOOK_SECRET).toUpperCase().replace('SHA256=', 'sha256='), WEBHOOK_SECRET)).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifySignature(body, signBody(body, 'another-secret'), WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a missing, empty or malformed header', () => {
    for (const header of [undefined, null, '', 'sha256=', 'sha1=0123', 'sha256=zz', `sha256=${'0'.repeat(63)}`, `${'0'.repeat(64)}`, 42]) {
      expect(verifySignature(body, header, WEBHOOK_SECRET)).toBe(false);
    }
  });

  it('rejects a tampered body', () => {
    const header = signBody(body, WEBHOOK_SECRET);
    expect(verifySignature(Buffer.from(`${body.toString()} `), header, WEBHOOK_SECRET)).toBe(false);
    expect(verifySignature(Buffer.from('{"zen":"Keep it logically awesome!"}'), header, WEBHOOK_SECRET)).toBe(false);
  });

  it('never accepts an empty secret', () => {
    expect(verifySignature(body, signBody(body, ''), '')).toBe(false);
    expect(verifySignature(body, signBody(body, ''), undefined)).toBe(false);
  });

  it('compares with crypto.timingSafeEqual, on equal-length digests', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    expect(verifySignature(body, signBody(body, 'another-secret'), WEBHOOK_SECRET)).toBe(false);
    expect(verifySignature(body, signBody(body, WEBHOOK_SECRET), WEBHOOK_SECRET)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [received, expected] of spy.mock.calls) {
      expect(received).toHaveLength(32);
      expect(expected).toHaveLength(32);
    }
    // A malformed header is refused before any comparison: nothing depends on its content.
    expect(verifySignature(body, 'sha256=short', WEBHOOK_SECRET)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('decideEvent', () => {
  it('launches for issues.labeled', () => {
    expect(decideEvent('issues', labeled())).toEqual({ launch: true, reason: 'issues.labeled' });
  });

  it('ignores other events and actions', () => {
    for (const [event, payload] of [
      ['ping', { zen: 'x' }],
      ['push', { ref: 'refs/heads/main' }],
      ['issue_comment', labeled({ action: 'created' })],
      ['pull_request', labeled()],
      ['pull_request_review', labeled({ action: 'submitted' })],
      ['issues', labeled({ action: 'opened' })],
      ['issues', labeled({ action: 'unlabeled' })],
      ['issues', labeled({ action: undefined })],
      ['constructor', labeled()],
      ['toString', labeled()],
      [undefined, labeled()],
      ['', labeled()],
    ]) {
      expect(decideEvent(event, payload).launch, `${event}/${payload.action}`).toBe(false);
    }
  });

  it('ignores payloads that lack what a job needs', () => {
    for (const payload of [
      null,
      'text',
      [],
      labeled({ label: undefined }),
      labeled({ label: { name: '' } }),
      labeled({ issue: undefined }),
      labeled({ issue: { number: '12' } }),
      labeled({ repository: undefined }),
      labeled({ repository: { id: 1 } }),
    ]) {
      expect(decideEvent('issues', payload).launch).toBe(false);
    }
  });

  it('applies the optional label list, ignoring case', () => {
    expect(decideEvent('issues', labeled(), { triggerLabels: ['Ready', 'agent'] }).launch).toBe(true);
    expect(decideEvent('issues', labeled({ label: { name: 'bug' } }), { triggerLabels: ['ready'] })).toEqual({
      launch: false,
      reason: 'label is not in TRIGGER_LABELS',
    });
    expect(decideEvent('issues', labeled({ label: { name: 'bug' } }), { triggerLabels: [] }).launch).toBe(true);
  });
});

describe('loadConfig', () => {
  it('names the missing variable', () => {
    expect(() => loadConfig({ ...env, BUCKET: '' })).toThrow('BUCKET is not set');
    expect(() => loadConfig({ ...env, IMAGE_ARN: undefined })).toThrow('IMAGE_ARN is not set');
  });

  it('checks the duration against the service limit and the reserve', () => {
    expect(() => loadConfig({ ...env, MAX_DURATION_SECONDS: '28801' })).toThrow('MAX_DURATION_SECONDS');
    expect(() => loadConfig({ ...env, MAX_DURATION_SECONDS: 'soon' })).toThrow('MAX_DURATION_SECONDS');
    expect(() => loadConfig({ ...env, MAX_DURATION_SECONDS: '600', WATCHDOG_RESERVE_SECONDS: '600' })).toThrow('less than');
    expect(() => loadConfig({ ...env, IDLE_POLICY_MODE: 'never' })).toThrow('IDLE_POLICY_MODE');
  });

  it('parses the label list', () => {
    expect(loadConfig({ ...env, TRIGGER_LABELS: ' ready, agent ,,' }).triggerLabels).toEqual(['ready', 'agent']);
    expect(loadConfig(env).triggerLabels).toEqual([]);
  });
});

describe('buildRunMicrovmInput', () => {
  const job = { deliveryId: 'd-1', eventName: 'issues', launchedAt: '2026-01-02T03:04:05.000Z' };

  it('builds the documented RunMicrovm request', () => {
    const input = buildRunMicrovmInput(loadConfig(env), job);
    expect(input).toEqual({
      imageIdentifier: env.IMAGE_ARN,
      executionRoleArn: env.EXECUTION_ROLE_ARN,
      ingressNetworkConnectors: [env.INGRESS_CONNECTOR_ARN],
      egressNetworkConnectors: [env.EGRESS_CONNECTOR_ARN],
      maximumDurationInSeconds: 7200,
      idlePolicy: { maxIdleDurationSeconds: 7200, suspendedDurationSeconds: 0, autoResumeEnabled: false },
      logging: { cloudWatch: { logGroup: '/aws/lambda-microvms/updraft-job' } },
      runHookPayload: expect.any(String),
    });
    expect(JSON.parse(input.runHookPayload)).toEqual({
      version: 1,
      deliveryId: 'd-1',
      eventName: 'issues',
      region: REGION,
      bucket: 'job-bucket',
      eventKey: 'events/d-1/event.json',
      resultKeyPrefix: 'results/d-1/',
      configPrefix: 'config/',
      secrets: { githubAppPrivateKey: env.GITHUB_APP_KEY_SECRET_ARN, agentEnv: env.AGENT_ENV_SECRET_ARN },
      maximumDurationSeconds: 7200,
      watchdogReserveSeconds: 300,
      launchedAt: job.launchedAt,
    });
  });

  it('pins an image version and omits the idle policy when asked to', () => {
    const input = buildRunMicrovmInput(loadConfig({ ...env, IMAGE_VERSION: '3.0', IDLE_POLICY_MODE: 'omit' }), job);
    expect(input.imageVersion).toBe('3.0');
    expect(input).not.toHaveProperty('idlePolicy');
  });

  it('produces a payload the runner accepts', () => {
    const input = buildRunMicrovmInput(loadConfig(env), job);
    const parsed = parseRunRequest({ microvmId: 'mvm-1', runHookPayload: input.runHookPayload });
    expect(parsed.payload).toEqual(JSON.parse(input.runHookPayload));
  });

  it('refuses a payload over 16 KB instead of sending it', () => {
    const config = { ...loadConfig(env), bucket: 'b'.repeat(MAX_RUN_HOOK_PAYLOAD_BYTES) };
    expect(() => buildRunMicrovmInput(config, job)).toThrow('run hook payload');
  });
});

describe('handleWebhook', () => {
  it('stores the body and launches a microVM for issues.labeled', async () => {
    const d = deps();
    const req = request(labeled());
    const response = await handleWebhook(req, d);

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      deliveryId: '5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10',
      microvmId: 'mvm-01234567-abcd-ef01-2345-6789abcdef01',
    });
    expect(d.calls.put).toHaveLength(1);
    expect(d.calls.put[0].bucket).toBe('job-bucket');
    expect(d.calls.put[0].key).toBe('events/5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10/event.json');
    expect(d.calls.put[0].body.toString('utf8')).toBe(req.body);
    expect(d.calls.run).toHaveLength(1);
    expect(JSON.parse(d.calls.run[0].runHookPayload)).toMatchObject({
      deliveryId: '5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10',
      eventName: 'issues',
      launchedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('puts no secret and no issue text in the RunMicrovm request, and stays under 16 KB', async () => {
    const d = deps();
    // A body far larger than the payload limit, with recognisable text.
    const big = labeled({ issue: { number: 12, title: 'MARKER-TITLE', body: `MARKER-BODY ${'x'.repeat(200_000)}` } });
    const response = await handleWebhook(request(big), d);
    expect(response.statusCode).toBe(202);

    const input = d.calls.run[0];
    const serialized = JSON.stringify(input);
    expect(Buffer.byteLength(input.runHookPayload, 'utf8')).toBeLessThanOrEqual(MAX_RUN_HOOK_PAYLOAD_BYTES);
    expect(Buffer.byteLength(input.runHookPayload, 'utf8')).toBeLessThan(2048);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain('MARKER-');
    expect(serialized).not.toContain('sha256=');
    // Secrets appear as Secrets Manager ARNs only.
    const payload = JSON.parse(input.runHookPayload);
    for (const reference of Object.values(payload.secrets)) expect(reference).toMatch(/^arn:aws:secretsmanager:/);
    expect(Object.keys(payload).sort()).toEqual(
      ['bucket', 'configPrefix', 'deliveryId', 'eventKey', 'eventName', 'launchedAt', 'maximumDurationSeconds', 'region', 'resultKeyPrefix', 'secrets', 'version', 'watchdogReserveSeconds'],
    );
    // The webhook secret's ARN is the launcher's business, not the microVM's.
    expect(serialized).not.toContain(env.WEBHOOK_SECRET_ARN);
  });

  it('verifies a base64-encoded body over its decoded bytes', async () => {
    const d = deps();
    const response = await handleWebhook(request(labeled(), { base64: true }), d);
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(d.calls.put[0].body.toString('utf8')).action).toBe('labeled');
  });

  it('finds headers whatever their case', async () => {
    const d = deps();
    const req = request(labeled());
    req.headers = {
      'X-Hub-Signature-256': req.headers['x-hub-signature-256'],
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': req.headers['x-github-delivery'],
    };
    expect((await handleWebhook(req, d)).statusCode).toBe(202);
  });

  it('answers 401 without reading the secret when the signature header is missing', async () => {
    const getWebhookSecret = vi.fn(async () => WEBHOOK_SECRET);
    const d = deps({ getWebhookSecret });
    const req = request(labeled());
    delete req.headers['x-hub-signature-256'];
    const response = await handleWebhook(req, d);
    expect(response.statusCode).toBe(401);
    expect(getWebhookSecret).not.toHaveBeenCalled();
    expect(d.calls.put).toHaveLength(0);
    expect(d.calls.run).toHaveLength(0);
  });

  it('answers 401 for a wrong secret or a tampered body, before parsing anything', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const d = deps();
    expect((await handleWebhook(request(labeled(), { secret: 'not-the-secret' }), d)).statusCode).toBe(401);

    const tampered = request(labeled());
    tampered.body = tampered.body.replace('"ready"', '"other"');
    expect((await handleWebhook(tampered, d)).statusCode).toBe(401);

    // Even a body that is not JSON is a 401, not a 400: it is never parsed.
    const garbage = request('not json at all');
    garbage.headers['x-hub-signature-256'] = `sha256=${'0'.repeat(64)}`;
    expect((await handleWebhook(garbage, d)).statusCode).toBe(401);

    expect(parse).not.toHaveBeenCalled();
    expect(d.calls.put).toHaveLength(0);
    expect(d.calls.run).toHaveLength(0);
  });

  it('answers 2xx and launches nothing for events that cannot lead to work', async () => {
    const d = deps();
    for (const [event, payload] of [
      ['ping', { zen: 'x' }],
      ['push', { ref: 'refs/heads/main' }],
      ['issues', labeled({ action: 'opened' })],
      ['issues', labeled({ action: 'unlabeled' })],
      ['pull_request_review', labeled({ action: 'submitted' })],
    ]) {
      const response = await handleWebhook(request(payload, { event }), d);
      expect(response.statusCode, event).toBe(200);
      expect(JSON.parse(response.body).ignored, event).toEqual(expect.any(String));
    }
    expect(d.calls.put).toHaveLength(0);
    expect(d.calls.run).toHaveLength(0);
  });

  it('applies TRIGGER_LABELS', async () => {
    const d = deps({ config: loadConfig({ ...env, TRIGGER_LABELS: 'agent' }) });
    expect((await handleWebhook(request(labeled()), d)).statusCode).toBe(200);
    expect((await handleWebhook(request(labeled({ label: { name: 'Agent' } })), d)).statusCode).toBe(202);
    expect(d.calls.run).toHaveLength(1);
  });

  it('answers 400 for a signed delivery with unusable headers or body', async () => {
    const d = deps();
    expect((await handleWebhook(request(labeled(), { delivery: '../../etc/passwd' }), d)).statusCode).toBe(400);
    expect((await handleWebhook(request(labeled(), { headers: { 'x-github-delivery': undefined } }), d)).statusCode).toBe(400);
    expect((await handleWebhook(request(labeled(), { event: 'Issues!' }), d)).statusCode).toBe(400);
    // Content type application/x-www-form-urlencoded: signed, but not JSON.
    expect((await handleWebhook(request('payload=%7B%7D'), d)).statusCode).toBe(400);
    expect(d.calls.put).toHaveLength(0);
    expect(d.calls.run).toHaveLength(0);
  });

  it('answers 500 with the delivery id in the log when the launch fails', async () => {
    const d = deps({
      runMicrovm: async () => {
        const error = new Error('quota');
        error.name = 'ServiceQuotaExceededException';
        throw error;
      },
    });
    const response = await handleWebhook(request(labeled()), d);
    expect(response.statusCode).toBe(500);
    const entry = d.calls.log.find((line) => line.level === 'error');
    expect(entry).toMatchObject({
      deliveryId: '5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10',
      message: 'launch failed',
      error: { name: 'ServiceQuotaExceededException', message: 'quota' },
    });
  });

  it('answers 500 and launches nothing when the body cannot be stored', async () => {
    const d = deps({
      putObject: async () => {
        throw new Error('AccessDenied');
      },
    });
    expect((await handleWebhook(request(labeled()), d)).statusCode).toBe(500);
    expect(d.calls.run).toHaveLength(0);
  });

  it('answers 500, not 401, when the webhook secret is unavailable or empty', async () => {
    const failing = deps({
      getWebhookSecret: async () => {
        throw new Error('ResourceNotFoundException');
      },
    });
    expect((await handleWebhook(request(labeled()), failing)).statusCode).toBe(500);
    const empty = deps({ getWebhookSecret: async () => '' });
    expect((await handleWebhook(request(labeled(), { secret: '' }), empty)).statusCode).toBe(500);
    expect(empty.calls.run).toHaveLength(0);
  });

  it('never logs the secret or the body', async () => {
    const d = deps();
    await handleWebhook(request(labeled({ issue: { number: 1, title: 'MARKER-TITLE' } })), d);
    await handleWebhook(request(labeled(), { secret: 'not-the-secret' }), d);
    const logged = JSON.stringify(d.calls.log);
    expect(logged).not.toContain(WEBHOOK_SECRET);
    expect(logged).not.toContain('MARKER-TITLE');
  });
});

describe('handleWebhook: deduplication on the delivery id', () => {
  const dedupeEnv = { ...env, DEDUPE_TABLE: 'deliveries', DEDUPE_WINDOW_SECONDS: '7200' };

  function withTable(overrides = {}) {
    const table = new Map();
    const d = deps({
      config: loadConfig(dedupeEnv),
      claimDelivery: async (deliveryId, nowSeconds, expiresSeconds) => {
        const existing = table.get(deliveryId);
        if (existing !== undefined && existing >= nowSeconds) return false;
        table.set(deliveryId, expiresSeconds);
        return true;
      },
      releaseDelivery: async (deliveryId) => {
        table.delete(deliveryId);
      },
      ...overrides,
    });
    return { d, table };
  }

  it('launches once and answers 200 to a redelivery inside the window', async () => {
    const { d, table } = withTable();
    expect((await handleWebhook(request(labeled()), d)).statusCode).toBe(202);
    const now = Math.floor(Date.parse('2026-01-02T03:04:05.000Z') / 1000);
    expect([...table.entries()]).toEqual([['5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10', now + 7200]]);

    const again = await handleWebhook(request(labeled()), d);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ duplicate: true, deliveryId: '5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10' });
    expect(d.calls.run).toHaveLength(1);
    expect(d.calls.put).toHaveLength(1);

    // Another delivery is not affected.
    expect((await handleWebhook(request(labeled(), { delivery: 'another-delivery' }), d)).statusCode).toBe(202);
    expect(d.calls.run).toHaveLength(2);
  });

  it('launches again once the record has expired or the runner removed it', async () => {
    const { d, table } = withTable();
    await handleWebhook(request(labeled()), d);
    d.now = () => new Date('2026-01-02T05:04:06.000Z'); // 7201 s later
    expect((await handleWebhook(request(labeled()), d)).statusCode).toBe(202);

    table.clear(); // what the runner does after a failed job
    expect((await handleWebhook(request(labeled()), d)).statusCode).toBe(202);
    expect(d.calls.run).toHaveLength(3);
  });

  it('tells the runner which table holds the record, and nothing when deduplication is off', async () => {
    const { d } = withTable();
    await handleWebhook(request(labeled()), d);
    expect(JSON.parse(d.calls.run[0].runHookPayload).dedupeTable).toBe('deliveries');
    expect(parseRunRequest({ microvmId: 'mvm-1', runHookPayload: d.calls.run[0].runHookPayload }).payload.dedupeTable).toBe('deliveries');

    const off = deps({ claimDelivery: vi.fn() });
    await handleWebhook(request(labeled()), off);
    expect(off.claimDelivery).not.toHaveBeenCalled();
    expect(JSON.parse(off.calls.run[0].runHookPayload)).not.toHaveProperty('dedupeTable');
  });

  it('removes the record when the launch fails, so the delivery can be redelivered', async () => {
    let fail = true;
    const { d, table } = withTable({
      runMicrovm: async () => {
        if (fail) throw new Error('ThrottlingException');
        return { microvmId: 'mvm-2' };
      },
    });
    expect((await handleWebhook(request(labeled()), d)).statusCode).toBe(500);
    expect(table.size).toBe(0);
    fail = false;
    expect((await handleWebhook(request(labeled()), d)).statusCode).toBe(202);
  });

  it('launches anyway when the table cannot be reached', async () => {
    const { d } = withTable({
      claimDelivery: async () => {
        throw new Error('ProvisionedThroughputExceededException');
      },
    });
    expect((await handleWebhook(request(labeled()), d)).statusCode).toBe(202);
    expect(d.calls.log.some((entry) => entry.level === 'warn' && entry.message.includes('deduplication unavailable'))).toBe(true);
  });

  it('does not record deliveries that are filtered or unauthenticated', async () => {
    const claimDelivery = vi.fn(async () => true);
    const { d } = withTable({ claimDelivery });
    await handleWebhook(request(labeled({ action: 'opened' })), d);
    await handleWebhook(request(labeled(), { secret: 'not-the-secret' }), d);
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('requires a table when a window is set', () => {
    expect(() => loadConfig({ ...env, DEDUPE_WINDOW_SECONDS: '60' })).toThrow('DEDUPE_TABLE');
    expect(loadConfig({ ...env, DEDUPE_TABLE: 't', DEDUPE_WINDOW_SECONDS: '0' }).dedupeWindowSeconds).toBe(0);
  });
});
