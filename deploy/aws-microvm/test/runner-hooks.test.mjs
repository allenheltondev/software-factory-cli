/* global fetch */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_BASE_PATH, createHookHandler, parseRunRequest } from '../image/runner/hooks.mjs';

const payload = (overrides = {}) => ({
  version: 1,
  deliveryId: '5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10',
  eventName: 'issues',
  region: 'eu-test-1',
  bucket: 'job-bucket',
  eventKey: 'events/5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10/event.json',
  resultKeyPrefix: 'results/5f0c7d5e-1b1a-4c3b-9a55-0d6f6f1c2a10/',
  configPrefix: 'config/',
  secrets: { githubAppPrivateKey: 'arn:aws:secretsmanager:eu-test-1:000000000000:secret:key', agentEnv: 'arn:aws:secretsmanager:eu-test-1:000000000000:secret:env' },
  maximumDurationSeconds: 7200,
  watchdogReserveSeconds: 300,
  launchedAt: '2026-01-02T03:04:05.000Z',
  ...overrides,
});

// The body Lambda sends to /run: the microVM id plus the launcher's payload as a string.
const runBody = (overrides = {}) => ({
  microvmId: 'mvm-01234567-abcd-ef01-2345-6789abcdef01',
  runHookPayload: JSON.stringify(payload(overrides)),
});

const servers = [];

async function startServer(handlers = {}) {
  const calls = { started: [], stops: 0, log: [] };
  const handler = createHookHandler({
    startJob: (request) => calls.started.push(request),
    stopJob: async () => {
      calls.stops += 1;
    },
    log: (message) => calls.log.push(message),
    ...handlers,
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const hook = (name, body, method = 'POST') =>
    fetch(`${base}${HOOK_BASE_PATH}/${name}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { calls, hook, base };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('lifecycle hook routing', () => {
  it('serves hooks under /aws/lambda-microvms/runtime/v1', () => {
    expect(HOOK_BASE_PATH).toBe('/aws/lambda-microvms/runtime/v1');
  });

  it('answers 200 to /ready and /validate without starting anything', async () => {
    const { calls, hook } = await startServer();
    expect((await hook('ready')).status).toBe(200);
    expect((await hook('validate')).status).toBe(200);
    expect(calls.started).toHaveLength(0);
  });

  it('starts the job once on /run and answers 200', async () => {
    const { calls, hook } = await startServer();
    const response = await hook('run', runBody());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'started' });
    expect(calls.started).toEqual([{ microvmId: 'mvm-01234567-abcd-ef01-2345-6789abcdef01', payload: payload() }]);

    const again = await hook('run', runBody({ deliveryId: 'another-delivery' }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'already started' });
    expect(calls.started).toHaveLength(1);
  });

  it('rejects an unusable /run body with 400 and starts nothing', async () => {
    const { calls, hook } = await startServer();
    for (const body of [
      '',
      'not json',
      '[]',
      { microvmId: 'mvm-1' },
      { runHookPayload: JSON.stringify(payload()) },
      { microvmId: 'mvm-1', runHookPayload: 'tenant-specific-string' },
      { microvmId: 'mvm-1', runHookPayload: '[]' },
      { microvmId: '../x', runHookPayload: JSON.stringify(payload()) },
      runBody({ version: 2 }),
      runBody({ deliveryId: '../../x' }),
      runBody({ eventName: 'Issues' }),
      runBody({ bucket: '' }),
      runBody({ secrets: { githubAppPrivateKey: 'arn' } }),
      runBody({ secrets: undefined }),
      runBody({ maximumDurationSeconds: '7200' }),
      runBody({ launchedAt: 'yesterday' }),
    ]) {
      const response = await hook('run', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls.started).toHaveLength(0);
    // A later valid /run still works: a rejected request does not use up the one start.
    expect((await hook('run', runBody())).status).toBe(200);
    expect(calls.started).toHaveLength(1);
  });

  it('keeps a valid https consoleOrigin of a version 2 payload and drops anything else', () => {
    const v2 = (extra) => ({
      microvmId: 'mvm-1',
      runHookPayload: JSON.stringify({
        version: 2, deliveryId: 'd-1', eventName: 'issues', region: 'us-east-1',
        broker: { functionName: 'broker', jobId: 'job_abc12345', jobToken: 'x'.repeat(43) },
        maximumDurationSeconds: 3600, watchdogReserveSeconds: 60, launchedAt: '2026-01-02T03:04:05.000Z', ...extra,
      }),
    });
    expect(parseRunRequest(v2({ consoleOrigin: 'https://updraft.readysetcloud.io' })).payload.consoleOrigin).toBe('https://updraft.readysetcloud.io');
    for (const bad of ['http://x.io', 'https://x.io/path', 'https://u:p@x.io', 'junk', 5]) {
      expect(parseRunRequest(v2({ consoleOrigin: bad })).payload).not.toHaveProperty('consoleOrigin');
    }
  });

  it('rejects an oversized /run body', async () => {
    const { calls, hook } = await startServer();
    const response = await hook('run', { microvmId: 'mvm-1', runHookPayload: 'x'.repeat(200_000) }).catch(() => undefined);
    // Either an error status or a dropped connection; never a start.
    if (response) expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls.started).toHaveLength(0);
  });

  it('waits for the job to stop on /terminate', async () => {
    const order = [];
    const { hook } = await startServer({
      stopJob: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('stopped');
      },
    });
    const response = await hook('terminate');
    order.push('answered');
    expect(response.status).toBe(200);
    expect(order).toEqual(['stopped', 'answered']);
  });

  it('answers 200 to /suspend and /resume and says that they are unexpected', async () => {
    const { calls, hook } = await startServer();
    expect((await hook('suspend')).status).toBe(200);
    expect((await hook('resume')).status).toBe(200);
    expect(calls.log.join('\n')).toContain('not meant to be suspended');
    expect(calls.stops).toBe(0);
  });

  it('answers 404 outside the hook path and for unknown hooks, 405 for other methods', async () => {
    const { calls, hook, base } = await startServer();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/run`, { method: 'POST' })).status).toBe(404);
    expect((await hook('reboot')).status).toBe(404);
    expect((await hook('run', undefined, 'GET')).status).toBe(405);
    expect((await hook('terminate', undefined, 'GET')).status).toBe(405);
    expect(calls.started).toHaveLength(0);
    expect(calls.stops).toBe(0);
  });

  it('answers 500 when a handler throws', async () => {
    const { hook } = await startServer({
      stopJob: async () => {
        throw new Error('boom');
      },
    });
    expect((await hook('terminate')).status).toBe(500);
  });
});

describe('parseRunRequest', () => {
  it('returns only the fields the runner knows', () => {
    const parsed = parseRunRequest({ microvmId: 'mvm-1', runHookPayload: JSON.stringify(payload({ extra: 'ignored' })) });
    expect(parsed).toEqual({ microvmId: 'mvm-1', payload: payload() });
  });

  it('takes an image check (version 3): a check id and nothing else', () => {
    const body = (p) => ({ microvmId: 'mvm-1', runHookPayload: JSON.stringify(p) });
    expect(parseRunRequest(body({ version: 3, checkId: 'image-check-20261122t190000z', broker: { jobToken: 'ignored' } }))).toEqual({
      microvmId: 'mvm-1',
      payload: { version: 3, checkId: 'image-check-20261122t190000z', deliveryId: 'image-check-20261122t190000z', eventName: 'isolation_check' },
    });
    expect(() => parseRunRequest(body({ version: 3 }))).toThrow('runHookPayload.checkId');
    expect(() => parseRunRequest(body({ version: 3, checkId: '../x' }))).toThrow('runHookPayload.checkId');
  });

  it('names the problem', () => {
    expect(() => parseRunRequest(null)).toThrow('not a JSON object');
    expect(() => parseRunRequest({ microvmId: 'mvm-1', runHookPayload: '{' })).toThrow('not JSON');
    expect(() => parseRunRequest(runBody({ version: 9 }))).toThrow('version 9');
    expect(() => parseRunRequest(runBody({ eventKey: undefined }))).toThrow('runHookPayload.eventKey');
  });
});
