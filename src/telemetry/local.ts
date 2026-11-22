// Agent telemetry for the local CLI (docs/agent-telemetry.md, "Running it yourself"): the same
// OpenTelemetry GenAI spans the microVM runner sends, from the same tracer (./runner/, a copy of
// deploy/aws-microvm/image/runner/'s, kept identical by a test), to whatever OTLP/HTTP endpoint
// the standard OTEL_EXPORTER_OTLP_* variables name. One trace per run: it starts when the worker
// claims the run and ends once the run is recorded and published (or commented on).
import { createRedactor } from './runner/redact.mjs';
import { createAgentTracer, createExporter } from './runner/telemetry.mjs';

export interface LocalTelemetryConfig {
  /** Where spans go: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT as given, or OTEL_EXPORTER_OTLP_ENDPOINT plus /v1/traces. */
  tracesUrl: string;
  headers: Record<string, string>;
  serviceName: string;
  /** OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true: prompts, outputs, tool arguments and results (redacted). */
  captureContent: boolean;
}

/**
 * The local telemetry settings from the environment, or null when there are none, or when this
 * process is the microVM runner's (UPDRAFT_TRACE_ID: the runner traces the job itself, and points
 * OTEL_EXPORTER_OTLP_ENDPOINT at its own relay for Claude Code's events). `warn` says why a
 * setting that is there is not used.
 */
export function localTelemetryFromEnv(env: NodeJS.ProcessEnv, warn: (message: string) => void = () => {}): LocalTelemetryConfig | null {
  if (env.UPDRAFT_TRACE_ID?.trim()) return null;
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return null;
  const exporters = env.OTEL_TRACES_EXPORTER?.trim();
  if (exporters && !exporters.split(',').map((e) => e.trim()).includes('otlp')) return null;
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!traces && !base) return null;
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL)?.trim();
  if (protocol && protocol !== 'http/json') {
    warn(`agent telemetry: OTEL_EXPORTER_OTLP_PROTOCOL is ${protocol}; Updraft sends OTLP/HTTP with JSON only (http/json), so no traces are sent`);
    return null;
  }
  const tracesUrl = traces || `${base!.replace(/\/+$/, '')}/v1/traces`;
  let url: URL;
  try {
    url = new URL(tracesUrl);
  } catch {
    warn('agent telemetry: the OTLP endpoint is not a URL; no traces are sent');
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    warn('agent telemetry: the OTLP endpoint is not http:// or https://; no traces are sent');
    return null;
  }
  return {
    tracesUrl: url.href,
    headers: { ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) },
    serviceName: serviceNameFrom(env),
    captureContent: env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?.trim().toLowerCase() === 'true',
  };
}

/** `key1=value1,key2=value2`, values URL-encoded (the OpenTelemetry form); names lower-cased. */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(name) || name === 'content-type' || name === 'content-length' || name === 'host') continue;
    let value = pair.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not encoded: as written.
    }
    if (value && !/[\r\n]/.test(value)) out[name] = value;
  }
  return out;
}

function serviceNameFrom(env: NodeJS.ProcessEnv): string {
  const named = env.OTEL_SERVICE_NAME?.trim() || parseResource(env.OTEL_RESOURCE_ATTRIBUTES)['service.name'];
  return named && /^[A-Za-z0-9_.-]{1,64}$/.test(named) ? named : 'updraft';
}

function parseResource(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

/** One run's trace: its id (recorded with the run, so later runs link to it), and its end. */
export interface RunTrace {
  traceId: string;
  /** Ends the trace with how the run ended, and sends what is left. Never throws. */
  end(outcome: string): Promise<void>;
}

export interface RunTelemetry {
  /** Starts tracing a run as the worker claims it; null when it cannot. Never throws. */
  begin(runId: string): RunTrace | null;
}

export function createLocalTelemetry(config: LocalTelemetryConfig, deps: { runsDir: string; log?: (line: string) => void; fetch?: typeof fetch; now?: () => number; pollMs?: number }): RunTelemetry {
  // The header values, and each word of them (the token in "Bearer <token>"), never leave in a span.
  const secrets = Object.values(config.headers).flatMap((v) => [v, ...v.split(/\s+/).filter((w) => w.length >= 8)]);
  const redact = createRedactor(secrets);
  const log = deps.log ?? (() => {});
  return {
    begin(runId) {
      try {
        const exporter = createExporter({
          // Exactly: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is the final URL, the base endpoint already has /v1/traces.
          tracesUrl: config.tracesUrl,
          headers: config.headers,
          resource: { 'service.name': config.serviceName },
          redact,
          log,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        });
        const tracer = createAgentTracer({
          runsDir: deps.runsDir,
          onlyRun: runId,
          exporter,
          captureContent: config.captureContent,
          redact,
          log,
          ...(deps.now ? { now: deps.now, startedAt: deps.now() } : {}),
          ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
        });
        tracer.start();
        return {
          traceId: tracer.traceId,
          async end(outcome) {
            try {
              const report = await tracer.stop({ outcome });
              log(`agent telemetry: ${report.exported} of ${report.spans} span(s) of run ${runId} sent (trace ${report.traceId})${report.lastError ? `, last error: ${report.lastError}` : ''}`);
            } catch (err) {
              log(`agent telemetry: ${(err as Error)?.message ?? err}`);
            }
          },
        };
      } catch (err) {
        log(`agent telemetry: ${(err as Error)?.message ?? err}`);
        return null;
      }
    },
  };
}
