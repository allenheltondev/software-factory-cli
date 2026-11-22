import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as claude from '../../test/claude-stream.js';
import { createLocalTelemetry, localTelemetryFromEnv, parseHeaders } from './local.js';

describe('local agent telemetry from the OTEL_EXPORTER_OTLP_* variables', () => {
  it('sends to the base endpoint plus /v1/traces, or to the traces endpoint as given, with the headers', () => {
    expect(
      localTelemetryFromEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20abc123456,x-team=a',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-team=b',
        OTEL_SERVICE_NAME: 'factory',
      }),
    ).toEqual({ tracesUrl: 'http://localhost:4318/v1/traces', headers: { authorization: 'Bearer abc123456', 'x-team': 'b' }, serviceName: 'factory', captureContent: false });
    expect(localTelemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otlp.example.com/custom/traces' })?.tracesUrl).toBe('https://otlp.example.com/custom/traces');
    expect(localTelemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318', OTEL_RESOURCE_ATTRIBUTES: 'service.name=from-resource,team=a' })?.serviceName).toBe('from-resource');
    expect(localTelemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true' })?.captureContent).toBe(true);
  });

  it('is off without an endpoint, when disabled, inside the microVM runner, or for a protocol it does not speak', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' };
    expect(localTelemetryFromEnv({}, warn)).toBeNull();
    expect(localTelemetryFromEnv({ ...base, OTEL_SDK_DISABLED: 'true' }, warn)).toBeNull();
    expect(localTelemetryFromEnv({ ...base, OTEL_TRACES_EXPORTER: 'none' }, warn)).toBeNull();
    // The runner traces the job itself, and points the endpoint at its own relay.
    expect(localTelemetryFromEnv({ ...base, UPDRAFT_TRACE_ID: 'ab'.repeat(16) }, warn)).toBeNull();
    expect(warnings).toEqual([]);
    expect(localTelemetryFromEnv({ ...base, OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, warn)).toBeNull();
    expect(localTelemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://x' }, warn)).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/http\/json/);
    expect(localTelemetryFromEnv({ ...base, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_TRACES_EXPORTER: 'otlp' })).not.toBeNull();
  });

  it('parses headers the OpenTelemetry way, and leaves out ones it sets itself', () => {
    expect(parseHeaders('a=1, B = two%2C2 ,content-type=x,bad name=1,=x,c=')).toEqual({ a: '1', b: 'two,2' });
  });
});

describe('a trace per run', () => {
  const header = (runId: string, issue: number) =>
    [`updraft run ${runId}`, 'job: job_local1 (attempt 1)', 'repository: octo/widgets (id 42)', `issue: #${issue} Title`, 'agent: claude-opus (adapter claude)', '', '---- agent output (stdout and stderr) ----', ''].join('\n');

  it('sends to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT exactly, its own path and query kept', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-local-telemetry-'));
    const urls: string[] = [];
    const fetchFn = (async (url: string) => (urls.push(url), { ok: true, status: 200, text: async () => '' })) as unknown as typeof fetch;
    const config = localTelemetryFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otlp.example.com/custom/traces?tenant=a' })!;
    const trace = createLocalTelemetry(config, { runsDir, fetch: fetchFn, pollMs: 20 }).begin('run_a')!;
    fs.mkdirSync(path.join(runsDir, 'run_a'));
    fs.writeFileSync(path.join(runsDir, 'run_a', 'run.log'), `${header('run_a', 7)}---- end of agent output ----\noutcome: succeeded\n`);
    await trace.end('succeeded');
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(['https://otlp.example.com/custom/traces?tenant=a']));
  });

  it("reads only its own run's log, and sends its spans with the headers, the key never in them", async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-local-telemetry-'));
    const write = (run: string, text: string) => {
      fs.mkdirSync(path.join(runsDir, run), { recursive: true });
      fs.appendFileSync(path.join(runsDir, run, 'run.log'), text);
    };
    const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      posts.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return { ok: true, status: 200, text: async () => '' };
    }) as unknown as typeof fetch;
    const telemetry = createLocalTelemetry(
      { tracesUrl: 'http://localhost:4318/v1/traces', headers: { authorization: 'Bearer local-secret-token' }, serviceName: 'updraft', captureContent: true },
      { runsDir, fetch: fetchFn, pollMs: 20 },
    );
    const trace = telemetry.begin('run_a')!;
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    write('run_a', header('run_a', 7));
    write('run_a', claude.stream(claude.assistantText('the key is Bearer local-secret-token'), claude.success('done')));
    write('run_a', '---- end of agent output ----\noutcome: succeeded\n');
    // Another run in the same directory is not this trace's.
    write('run_b', header('run_b', 8));
    await trace.end('succeeded');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0]!.url).toBe('http://localhost:4318/v1/traces');
    expect(posts[0]!.headers).toMatchObject({ authorization: 'Bearer local-secret-token', 'content-type': 'application/json' });
    const bodies = posts.map((p) => p.body).join('\n');
    expect(bodies).toContain(trace.traceId);
    expect(bodies).toContain('"octo/widgets#7"');
    expect(bodies).not.toContain('octo/widgets#8');
    expect(bodies).toContain('invoke_workflow updraft');
    expect(bodies).not.toContain('local-secret-token');
  });
});
