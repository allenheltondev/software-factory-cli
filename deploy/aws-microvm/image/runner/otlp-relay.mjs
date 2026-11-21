// A localhost OTLP/HTTP (JSON) receiver for Claude Code's own log events.
//
// Claude Code can export OpenTelemetry log events about itself (code.claude.com/docs/en/
// monitoring-usage): every API request with its duration, tokens and cost, every API error and
// retry, every permission decision and tool result. They say what the stream-json transcript
// does not (retries, how long a request took, a rejected tool). An agent sends them here, to a
// port the runner (root) listens on at 127.0.0.1, with no key at all: the runner turns what it
// accepts into span events on the agent's `invoke_agent` span (telemetry.mjs, agentEvent) and
// sends those with its own key. The Honeycomb key is never in an agent's environment.
//
// Nothing that arrives is trusted: whoever can reach a loopback port can post here. Bodies are
// capped, only JSON is read, only a fixed allowlist of scalar attributes of a few known events
// is kept, and the number of records is capped per request and in all. It never throws at a
// caller; a bad request gets a 4xx and is counted.
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const MAX_RECORDS_PER_REQUEST = 1000;
export const MAX_TOTAL_RECORDS = 50_000;
const MAX_ERROR_CHARS = 200;
const MAX_STRING_CHARS = 256;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

const num = 'number';
const str = 'string';
const bool = 'boolean';
/** Attributes every kept event may carry (Claude Code's correlation attributes). */
const COMMON = { 'prompt.id': str, 'event.sequence': num, agent_id: str, parent_agent_id: str };
/**
 * The events kept, by bare name (Claude Code exports them as `claude_code.<name>`), and the
 * attributes kept of each, with their types. Nothing that is content: no prompt, no tool input,
 * no response. `error` is an API error message, cut to MAX_ERROR_CHARS.
 */
export const EVENT_ATTRIBUTES = {
  api_request: {
    model: str,
    duration_ms: num,
    input_tokens: num,
    output_tokens: num,
    cache_read_tokens: num,
    cache_creation_tokens: num,
    cost_usd: num,
    speed: str,
    effort: str,
    query_source: str,
    request_id: str,
    'agent.name': str,
  },
  api_error: {
    model: str,
    error: str,
    status_code: num,
    duration_ms: num,
    attempt: num,
    speed: str,
    effort: str,
    query_source: str,
    request_id: str,
    'agent.name': str,
  },
  tool_decision: { tool_name: str, tool_use_id: str, decision: str, source: str, tool_source: str },
  // The model refused, and an API call gave up after its retries (the retries themselves are not events).
  api_refusal: { model: str, duration_ms: num, request_id: str, query_source: str, 'agent.name': str },
  api_retries_exhausted: { model: str, error: str, status_code: num, attempt: num, duration_ms: num, request_id: str, query_source: str, 'agent.name': str },
  tool_result: {
    tool_name: str,
    tool_use_id: str,
    success: bool,
    duration_ms: num,
    error_type: str,
    decision_type: str,
    decision_source: str,
    tool_input_size_bytes: num,
    tool_result_size_bytes: num,
  },
};

/**
 * The variables that make Claude Code export its log events, and nothing else, to the relay at
 * http://127.0.0.1:<port> over OTLP/HTTP with JSON. Prompts and tool details stay off
 * (OTEL_LOG_USER_PROMPTS, OTEL_LOG_TOOL_DETAILS are not set): whether content is recorded is
 * the tenant's setting, applied by the tracer, and none of it is read from here.
 */
export function claudeTelemetryEnv(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the relay port is not a port number');
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
  };
}

/** An OTLP/JSON AnyValue as a JS scalar (int64 arrives as a string), or undefined. */
function scalar(v) {
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  if (typeof v.intValue === 'number') return v.intValue;
  if (typeof v.intValue === 'string' && /^-?\d{1,18}$/.test(v.intValue)) return Number(v.intValue);
  return undefined;
}

/** An OTLP/JSON attribute list as a map of scalars (lists, maps and bytes are left out). */
function attributeMap(list) {
  const out = new Map();
  if (!Array.isArray(list)) return out;
  for (const kv of list.slice(0, 256)) {
    if (kv && typeof kv.key === 'string' && kv.key.length <= 128) {
      const v = scalar(kv.value);
      if (v !== undefined) out.set(kv.key, v);
    }
  }
  return out;
}

/** A value as `type`, or undefined when it is not one (numbers sent as text are accepted). */
function typed(value, type, key) {
  if (type === num) {
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value) ? Number(value) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === bool) return value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  const text = String(value);
  const max = key === 'error' ? MAX_ERROR_CHARS : MAX_STRING_CHARS;
  return text.length > max ? text.slice(0, max) : text;
}

/** OTLP nanoseconds (a decimal string, or a number) as ms, or null. */
function nanosToMs(t) {
  if (typeof t === 'string' && /^\d{1,20}$/.test(t)) {
    const ms = Number(BigInt(t) / 1000000n);
    return ms > 0 ? ms : null;
  }
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? Math.floor(t / 1e6) : null;
}

/** The record's time in ms: its own time, else event.timestamp, else when it was observed, else now. */
function recordTime(record, attrs, now) {
  const iso = attrs.get('event.timestamp');
  const fromIso = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return nanosToMs(record.timeUnixNano) ?? (Number.isFinite(fromIso) ? fromIso : null) ?? nanosToMs(record.observedTimeUnixNano) ?? now();
}

/** The bare event name of a record (`event.name`, else the body), or null. */
function eventName(attrs, body) {
  const raw = attrs.get('event.name') ?? scalar(body);
  if (typeof raw !== 'string') return null;
  return raw.startsWith('claude_code.') ? raw.slice('claude_code.'.length) : raw;
}

/**
 * The records of an OTLP/JSON ExportLogsServiceRequest, each as { name, time, sessionId,
 * attributes } with only allowlisted attributes. Pure; never throws. `limit` caps how many are
 * returned; `counts` gets unknown and over-the-limit records.
 */
export function parseLogsRequest(body, { limit = MAX_RECORDS_PER_REQUEST, now = Date.now, counts = {} } = {}) {
  const out = [];
  const resourceLogs = Array.isArray(body?.resourceLogs) ? body.resourceLogs : [];
  for (const rl of resourceLogs) {
    const resource = attributeMap(rl?.resource?.attributes);
    for (const sl of Array.isArray(rl?.scopeLogs) ? rl.scopeLogs : []) {
      for (const record of Array.isArray(sl?.logRecords) ? sl.logRecords : []) {
        if (!record || typeof record !== 'object') continue;
        const attrs = attributeMap(record.attributes);
        const bare = eventName(attrs, record.body);
        const allowed = bare !== null && Object.hasOwn(EVENT_ATTRIBUTES, bare) ? { ...COMMON, ...EVENT_ATTRIBUTES[bare] } : null;
        if (!allowed) {
          counts.unknown = (counts.unknown ?? 0) + 1;
          continue;
        }
        if (out.length >= limit) {
          counts.overLimit = (counts.overLimit ?? 0) + 1;
          continue;
        }
        const session = attrs.get('session.id') ?? resource.get('session.id');
        const attributes = {};
        for (const [key, type] of Object.entries(allowed)) {
          const value = typed(attrs.get(key), type, key);
          if (value !== undefined) attributes[key] = value;
        }
        out.push({
          name: `claude_code.${bare}`,
          time: recordTime(record, attrs, now),
          sessionId: typeof session === 'string' && session.length <= 128 ? session : null,
          attributes,
        });
      }
    }
  }
  return out;
}

/**
 * The relay: an HTTP server on loopback that accepts OTLP/HTTP JSON at /v1/logs and hands each
 * kept record to `onRecord`, and accepts and discards /v1/metrics and /v1/traces (so an
 * exporter that sends them does not report errors). `start()` resolves with the port.
 */
export function createOtlpRelay({ onRecord, log = () => {}, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, maxRecordsPerRequest = MAX_RECORDS_PER_REQUEST, maxTotalRecords = MAX_TOTAL_RECORDS, host = '127.0.0.1', port = 0, now = Date.now }) {
  const stats = { requests: 0, records: 0, unknown: 0, dropped: 0, rejected: 0, discarded: 0, lastProblem: null };
  let server = null;
  let warned = false;

  const reply = (res, status, body = {}) => {
    if (res.headersSent) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' });
    res.end(text);
  };
  const reject = (res, status, problem) => {
    stats.rejected += 1;
    stats.lastProblem = problem;
    if (!warned) {
      warned = true;
      log(`agent events: a request was refused (${problem}); later refusals are only counted`);
    }
    reply(res, status, { message: problem });
  };

  function handle(req, res) {
    stats.requests += 1;
    if (!LOOPBACK.has(String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''))) return reject(res, 403, 'not from this machine');
    const url = String(req.url ?? '').split('?')[0];
    const known = url === '/v1/logs' || url === '/v1/metrics' || url === '/v1/traces';
    if (!known) return reject(res, 404, 'no such path');
    if (req.method !== 'POST') return reject(res, 405, 'only POST');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return reject(res, 415, 'only OTLP/HTTP with JSON (http/json) is accepted');
    const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity' && encoding !== 'gzip') return reject(res, 415, `content encoding ${encoding}`);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      reject(res, 413, 'body too large');
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        over = true;
        reject(res, 413, 'body too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (over) return;
      if (url !== '/v1/logs') {
        stats.discarded += 1;
        return reply(res, 200);
      }
      let body;
      try {
        let raw = Buffer.concat(chunks);
        if (encoding === 'gzip') raw = gunzipSync(raw, { maxOutputLength: maxBodyBytes });
        body = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        return error?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? reject(res, 413, 'body too large') : reject(res, 400, 'not JSON');
      }
      const counts = {};
      const records = parseLogsRequest(body, { limit: maxRecordsPerRequest, now, counts });
      stats.unknown += counts.unknown ?? 0;
      stats.dropped += counts.overLimit ?? 0;
      for (const record of records) {
        if (stats.records >= maxTotalRecords) {
          stats.dropped += 1;
          continue;
        }
        stats.records += 1;
        try {
          onRecord?.(record);
        } catch (error) {
          stats.lastProblem = `onRecord: ${error?.message ?? error}`;
        }
      }
      reply(res, 200);
    });
  }

  return {
    stats,
    /** Listens on loopback only; resolves with the port it got. */
    start() {
      if (!LOOPBACK.has(host)) return Promise.reject(new Error(`the relay listens on loopback only, not ${host}`));
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          try {
            handle(req, res);
          } catch {
            reply(res, 500);
          }
        });
        server.requestTimeout = 15_000;
        server.headersTimeout = 10_000;
        server.keepAliveTimeout = 1_000;
        server.maxConnections = 64;
        server.on('clientError', (_error, socket) => socket.destroy());
        server.once('error', reject);
        server.listen({ host, port, exclusive: true }, () => {
          server.off('error', reject);
          server.on('error', (error) => log(`agent events: ${error?.message ?? error}`));
          server.unref();
          resolve({ port: server.address().port });
        });
      });
    },
    /** Stops listening and closes every connection. Never throws. */
    stop() {
      const s = server;
      server = null;
      if (!s) return Promise.resolve();
      return new Promise((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections?.();
      });
    },
  };
}
