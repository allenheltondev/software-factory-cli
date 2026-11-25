// The loopback OTLP relay for Claude Code's own log events (image/runner/otlp-relay.mjs), and
// how what it receives lands on the agent span (image/runner/telemetry.mjs).
/* global fetch */
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeTelemetryEnv, createOtlpRelay, parseLogsRequest } from '../image/runner/otlp-relay.mjs';
import { sandboxEnv, telemetryEnv } from '../image/sandbox/updraft-sandbox.mjs';
import { MAX_EVENTS_PER_SPAN, createRunTrace, otlpRequest, redactSpan } from '../image/runner/telemetry.mjs';

const attr = (key, value) => ({ key, value: typeof value === 'number' ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value } });
const record = (name, attrs, extra = {}) => ({ timeUnixNano: '1700000000123000000', attributes: [attr('event.name', name), ...Object.entries(attrs).map(([k, v]) => attr(k, v))], ...extra });
const logsBody = (records, resource = []) => ({ resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: records }] }] });

const relays = [];
async function startRelay(options = {}) {
  const got = [];
  const relay = createOtlpRelay({ onRecord: (r) => got.push(r), ...options });
  relays.push(relay);
  const { port } = await relay.start();
  const post = (path, body, headers = { 'content-type': 'application/json' }) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  return { relay, port, got, post };
}
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop();
});

describe('parseLogsRequest', () => {
  it('keeps the allowlisted scalar attributes of known events, by event.name or body, and drops the rest', () => {
    const counts = {};
    const records = parseLogsRequest(
      logsBody(
        [
          record('api_request', { model: 'claude-x', duration_ms: 1200, input_tokens: 10, output_tokens: '7', cost_usd: 0.25, 'prompt.id': 'p1', prompt: 'secret prompt', user_email: 'a@b' }),
          { timeUnixNano: '0', body: { stringValue: 'claude_code.api_error' }, attributes: [attr('session.id', 'own'), attr('error', 'x'.repeat(500)), attr('status_code', 529), attr('attempt', 3), attr('event.timestamp', '2024-01-01T00:00:00.000Z')] },
          record('tool_result', { tool_name: 'Bash', success: 'false', tool_input: '{"command":"rm"}', error: 'full message' }),
          record('tool_decision', { tool_name: 'Edit', decision: 'reject', source: 'config' }),
          record('user_prompt', { prompt_length: 4 }),
          { attributes: [attr('session.id', 'x')] },
          null,
        ],
        [attr('session.id', 's-res')],
      ),
      { counts },
    );
    expect(records.map((r) => r.name)).toEqual(['claude_code.api_request', 'claude_code.api_error', 'claude_code.tool_result', 'claude_code.tool_decision']);
    expect(records[0]).toEqual({ name: 'claude_code.api_request', time: 1700000000123, sessionId: 's-res', attributes: { model: 'claude-x', duration_ms: 1200, input_tokens: 10, output_tokens: 7, cost_usd: 0.25, 'prompt.id': 'p1' } });
    expect(records[1].sessionId).toBe('own');
    expect(records[1].time).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
    expect(records[1].attributes.error).toHaveLength(200);
    expect(records[1].attributes).toMatchObject({ status_code: 529, attempt: 3 });
    // Content never: tool input, full tool errors, prompts.
    expect(records[2].attributes).toEqual({ tool_name: 'Bash', success: false });
    expect(records[3].attributes).toEqual({ tool_name: 'Edit', decision: 'reject', source: 'config' });
    expect(counts.unknown).toBe(2);
  });

  it('caps the records it returns and survives any shape', () => {
    const counts = {};
    expect(parseLogsRequest(logsBody(Array.from({ length: 5 }, () => record('api_request', {}))), { limit: 2, counts })).toHaveLength(2);
    expect(counts.overLimit).toBe(3);
    for (const junk of [null, 1, 'x', [], { resourceLogs: 'x' }, { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: 'x' }] }] }] }]) expect(parseLogsRequest(junk)).toEqual([]);
  });
});

describe('createOtlpRelay', () => {
  it('accepts OTLP/HTTP JSON logs on loopback and hands over each record', async () => {
    const { got, post, relay } = await startRelay();
    const res = await post('/v1/logs', logsBody([record('api_request', { 'session.id': 's1', model: 'm' }), record('mystery', {})]));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(got).toEqual([{ name: 'claude_code.api_request', time: 1700000000123, sessionId: 's1', attributes: { model: 'm' } }]);
    expect(relay.stats).toMatchObject({ records: 1, unknown: 1 });
    // gzip, as an exporter may send it.
    expect((await post('/v1/logs', gzipSync(JSON.stringify(logsBody([record('tool_decision', { 'session.id': 's1' })]))), { 'content-type': 'application/json', 'content-encoding': 'gzip' })).status).toBe(200);
    expect(got).toHaveLength(2);
  });

  it('accepts and discards metrics and traces', async () => {
    const { got, post, relay } = await startRelay();
    expect((await post('/v1/metrics', { resourceMetrics: [] })).status).toBe(200);
    expect((await post('/v1/traces', { resourceSpans: [] })).status).toBe(200);
    expect(got).toEqual([]);
    expect(relay.stats.discarded).toBe(2);
  });

  it('refuses what is not OTLP JSON, too large, or elsewhere', async () => {
    const { post, port, got } = await startRelay({ maxBodyBytes: 1000 });
    expect((await post('/v1/logs', 'x', { 'content-type': 'application/x-protobuf' })).status).toBe(415);
    expect((await post('/v1/logs', '{', { 'content-type': 'application/json' })).status).toBe(400);
    expect((await post('/v1/logs', { pad: 'x'.repeat(2000) })).status).toBe(413);
    // A gzip bomb is cut at the same size.
    expect((await post('/v1/logs', gzipSync(JSON.stringify({ pad: 'x'.repeat(100_000) })), { 'content-type': 'application/json', 'content-encoding': 'gzip' })).status).toBe(413);
    expect((await post('/v1/logs', 'x', { 'content-type': 'application/json', 'content-encoding': 'br' })).status).toBe(415);
    expect((await post('/v2/other', {})).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/v1/logs`)).status).toBe(405);
    expect(got).toEqual([]);
  });

  it('caps records per request and in all', async () => {
    const { got, post, relay } = await startRelay({ maxRecordsPerRequest: 3, maxTotalRecords: 4 });
    const many = logsBody(Array.from({ length: 5 }, () => record('api_request', { 'session.id': 's' })));
    expect((await post('/v1/logs', many)).status).toBe(200);
    expect((await post('/v1/logs', many)).status).toBe(200);
    expect(got).toHaveLength(4);
    expect(relay.stats.dropped).toBe(6);
  });

  it('never lets onRecord break a request', async () => {
    const relay = createOtlpRelay({
      onRecord: () => {
        throw new Error('boom');
      },
    });
    relays.push(relay);
    const { port } = await relay.start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(logsBody([record('api_request', {})])) });
    expect(res.status).toBe(200);
  });

  it('listens on loopback only', async () => {
    for (const host of ['0.0.0.0', '::', '10.0.0.1']) await expect(createOtlpRelay({ host }).start()).rejects.toThrow(/loopback only/);
    const { port } = await startRelay();
    expect(port).toBeGreaterThan(0);
  });
});

describe('claudeTelemetryEnv', () => {
  it('asks for log events in http/json at the relay, with no content and no headers', () => {
    const env = claudeTelemetryEnv(4318);
    expect(env).toMatchObject({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'none', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' });
    for (const name of ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_EXPORTER_OTLP_HEADERS']) expect(env[name]).toBeUndefined();
    expect(() => claudeTelemetryEnv(0)).toThrow();
  });

  it('is exactly what the sandbox runtime passes on to a contained agent, and nothing like it otherwise', () => {
    const env = claudeTelemetryEnv(40123);
    expect(telemetryEnv({ ...env, OTHER: 'x' })).toEqual(env);
    expect(sandboxEnv({ env: [] }, { ...env, SECRET: 'x' }, { path: '/p', env: {} })).toEqual({ PATH: '/p', LANG: 'C.UTF-8', ...env });
    expect(telemetryEnv({ ...env, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.honeycomb.io' })).toEqual({});
    expect(telemetryEnv({ ...env, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1@evil' })).toEqual({});
    expect(telemetryEnv({ ...env, OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toEqual({});
    const partial = { ...env };
    delete partial.OTEL_LOGS_EXPORTER;
    expect(telemetryEnv(partial)).toEqual({});
  });
});

describe("Claude Code's own events on the agent span", () => {
  const head = ['updraft run run_a', 'job: job_a (attempt 1)', 'repository: o/r (id 1)', 'issue: #7 t', 'agent: claude (adapter claude)', '---- agent output (stdout and stderr) ----'];
  function runTrace({ captureContent = false } = {}) {
    const spans = [];
    const trace = createRunTrace({ traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runDir: '/x/run_a', captureContent, redact: (t) => t.replaceAll('sk-secret', '[redacted]'), emit: (s) => spans.push(s) });
    for (const line of head) trace.line(line, 1000);
    trace.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }), 1001);
    return { trace, spans };
  }
  const ev = (name, attributes, time = 2000) => ({ name, time, sessionId: 'sess-1', attributes });

  it('lands on the run whose agent id is the session, with counters', () => {
    const { trace, spans } = runTrace();
    expect(trace.agentEvent({ ...ev('claude_code.api_request', {}), sessionId: 'other' })).toBe(false);
    expect(trace.agentEvent(ev('claude_code.api_error', { status_code: 529, attempt: 1, duration_ms: 30, error: 'key sk-secret' }))).toBe(true);
    expect(trace.agentEvent(ev('claude_code.api_error', { status_code: 529, attempt: 2, duration_ms: 50 }))).toBe(true);
    expect(trace.agentEvent(ev('claude_code.api_request', { duration_ms: 1500, model: 'm' }))).toBe(true);
    expect(trace.agentEvent(ev('claude_code.api_request', { duration_ms: 500 }))).toBe(true);
    expect(trace.agentEvent(ev('claude_code.tool_decision', { decision: 'reject', tool_name: 'Bash' }))).toBe(true);
    expect(trace.agentEvent(ev('claude_code.tool_decision', { decision: 'accept', tool_name: 'Read' }))).toBe(true);
    expect(trace.agentEvent(ev('claude_code.api_refusal', { model: 'm' }))).toBe(true);
    expect(trace.agentEvent(ev('claude_code.api_retries_exhausted', { status_code: 529, attempt: 10 }))).toBe(true);
    trace.line('---- end of agent output ----', 3000);
    trace.close(3000);
    const agent = spans.find((s) => s.name === 'invoke_agent implement / claude');
    expect(agent.events).toHaveLength(8);
    expect(agent.attributes).toMatchObject({
      'updraft.agent.api_requests': 2,
      'updraft.agent.api_errors': 2,
      'updraft.agent.api_retries': 2,
      'updraft.agent.api_refusals': 1,
      'updraft.agent.api_retries_exhausted': 1,
      'updraft.agent.api_duration_ms_total': 2080,
      'updraft.agent.api_duration_ms_max': 1500,
      'updraft.agent.tool_rejections': 1,
    });
    // As OTLP: without content, an error's status, attempt and duration, never its message.
    const otlp = otlpRequest([redactSpan(agent, (t) => t.replaceAll('sk-secret', '[redacted]'))], {}).resourceSpans[0].scopeSpans[0].spans[0];
    expect(otlp.events[0]).toEqual({
      timeUnixNano: '2000000000',
      name: 'claude_code.api_error',
      attributes: [
        { key: 'status_code', value: { intValue: '529' } },
        { key: 'attempt', value: { intValue: '1' } },
        { key: 'duration_ms', value: { intValue: '30' } },
      ],
    });
    expect(JSON.stringify(otlp)).not.toContain('key ');
    // Once the span is sent, a late event is consumed and changes nothing.
    expect(trace.agentEvent(ev('claude_code.api_request', {}))).toBe(true);
    expect(agent.attributes['updraft.agent.api_requests']).toBe(2);
  });

  it("keeps an API error's message only with content on, redacted", () => {
    const { trace, spans } = runTrace({ captureContent: true });
    trace.agentEvent(ev('claude_code.api_error', { status_code: 400, error: 'bad request for sk-secret' }));
    trace.agentEvent(ev('claude_code.api_retries_exhausted', { status_code: 529, attempt: 10, error: 'overloaded' }));
    trace.close(3000);
    const agent = spans.find((s) => s.name === 'invoke_agent implement / claude');
    expect(agent.events.map((e) => e.attributes.error)).toEqual(['bad request for [redacted]', 'overloaded']);
  });

  it('keeps at most MAX_EVENTS_PER_SPAN events, and counts on', () => {
    const { trace, spans } = runTrace();
    for (let i = 0; i < MAX_EVENTS_PER_SPAN + 10; i++) trace.agentEvent(ev('claude_code.api_request', { duration_ms: 1 }));
    trace.close(5000);
    const agent = spans.find((s) => s.name === 'invoke_agent implement / claude');
    expect(agent.events).toHaveLength(MAX_EVENTS_PER_SPAN);
    expect(agent.attributes['updraft.agent.api_requests']).toBe(MAX_EVENTS_PER_SPAN + 10);
    expect(agent.attributes['updraft.agent.events_dropped']).toBe(10);
  });

  it('a span without events has none in OTLP', () => {
    const { trace, spans } = runTrace();
    trace.close(5000);
    const otlp = otlpRequest(spans, {}).resourceSpans[0].scopeSpans[0].spans;
    expect(otlp.every((s) => s.events === undefined)).toBe(true);
  });
});
