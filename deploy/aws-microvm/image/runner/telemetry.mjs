// Agent telemetry: what the agents did in a job, as OpenTelemetry traces in the GenAI semantic
// conventions, sent to the tenant's Honeycomb (or any OTLP/HTTP endpoint) for its Agent Timeline.
//
// The runner is root and the agents are not, so nothing is installed in or asked of an agent.
// Instead the runner reads what Updraft already writes: every run's run.log, which holds the
// worker's header (job, issue, trigger, agent, profile), the agent's own machine-readable output
// (Claude Code `--output-format stream-json`, Codex `exec --json`), and the worker's verification
// markers. It tails those files while the job runs, so each event is timed when it is written,
// and turns them into spans:
//
//   invoke_workflow updraft                 the job (one trace per microVM), agent "updraft"
//   ├─ invoke_agent <profile>               one agent run: implement, review or revision
//   │  ├─ chat <model>                      one model response, with its token usage
//   │  ├─ execute_tool <tool>               one tool call (Bash, Edit, shell, an MCP tool, ...)
//   │  │  └─ invoke_agent <profile>/<type>  a Claude Code subagent (the Task tool), with its own spans
//   │  └─ ...
//   └─ execute_tool verify                  each of the workflow's verify commands, agent "updraft"
//
// Every span carries `gen_ai.conversation.id` = "<owner>/<repo>#<issue>", so the implement run,
// each review and each revision of an issue, over however many webhook events, are one
// conversation (a multi-trace session) in Agent Timeline.
//
// Content (prompts, model output, tool arguments and results) is recorded only when the tenant
// opts in (`captureContent`), always redacted with the job's keys and key-shaped patterns, and
// cut to MAX_ATTRIBUTE_CHARS. Without it, spans hold names, ids, timings, token counts, outcomes
// and the verify commands (which are configuration, not content).
/* global AbortSignal */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  checkAttributes,
  claudeToolAttributes,
  codexTodoAttributes,
  codexToolAttributes,
  describeCommand,
  isTestPath,
  parseCheckOutput,
  parseTestOutput,
  resultAttributes,
  testAttributes,
  toolCategory,
} from './telemetry-detail.mjs';

export const SCOPE = { name: 'updraft-microvm-runner', version: '1' };
/** How often the run logs are looked at. */
export const TELEMETRY_POLL_MS = 500;
/** How often finished spans are sent. */
export const EXPORT_INTERVAL_MS = 3000;
/** Spans per request. */
export const EXPORT_BATCH = 400;
/** Spans waiting to be sent at most; past it the oldest are dropped (and counted). */
export const MAX_QUEUED_SPANS = 20000;
/** The most of one log read per look; the rest is read next time. */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** A line longer than this is skipped (counted), not buffered. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;
/** One content attribute at most (Honeycomb keeps up to 64 KB per field). */
export const MAX_ATTRIBUTE_CHARS = 16 * 1024;
const MAX_RUNS = 64;
/** The most of a run's prompt that is read. */
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_SPANS_PER_RUN = 20000;
/** Span events per span at most; past it they are counted, not kept. */
export const MAX_EVENTS_PER_SPAN = 256;
/** The most of one verify command's output that is kept for reading its test counts. */
const MAX_VERIFY_OUTPUT_CHARS = 512 * 1024;
/** Updraft's own messages on span events (publication, review, revision steps), cut to this. */
const MAX_MESSAGE_CHARS = 300;
/** Agent events whose session no run has shown yet, kept until one does (or the job ends). */
const MAX_UNMATCHED_EVENTS = 2000;

const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** Honeycomb's OTLP endpoints by region (docs.honeycomb.io/send-data/opentelemetry). */
export const HONEYCOMB_ENDPOINTS = { us: 'https://api.honeycomb.io', eu: 'https://api.eu1.honeycomb.io' };

/** `gen_ai.provider.name` by Updraft adapter (semantic-conventions-genai: anthropic, openai). */
const PROVIDER = { claude: 'anthropic', codex: 'openai' };
/** Anthropic stop reasons as the conventions' finish reasons. */
const FINISH = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_call', max_tokens: 'length', refusal: 'content_filter', pause_turn: 'stop' };

export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');

/** OTLP/JSON AnyValue. */
function anyValue(v) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  return { stringValue: String(v) };
}

const attributes = (attrs) =>
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && !Number.isFinite(v)))
    .map(([key, value]) => ({ key, value: anyValue(value) }));

const nanos = (ms) => `${BigInt(Math.round(ms)) * 1000000n}`;

/** One span as OTLP/JSON. */
export function toOtlpSpan(s) {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: s.kind ?? KIND_INTERNAL,
    startTimeUnixNano: nanos(s.start),
    endTimeUnixNano: nanos(Math.max(s.start, s.end ?? s.start)),
    attributes: attributes(s.attributes ?? {}),
    ...(s.events?.length ? { events: s.events.map((e) => ({ timeUnixNano: nanos(e.at), name: e.name, attributes: attributes(e.attributes ?? {}) })) } : {}),
    status: s.error ? { code: STATUS_ERROR, ...(s.errorMessage ? { message: s.errorMessage } : {}) } : { code: STATUS_OK },
    ...(s.droppedEvents ? { droppedEventsCount: s.droppedEvents } : {}),
    ...(s.links?.length ? { links: s.links.map((l) => ({ traceId: l.traceId, spanId: l.spanId, attributes: attributes(l.attributes ?? {}) })) } : {}),
  };
}

/** Adds a span event (a point in time inside a span, with its own attributes). */
export function addEvent(span, at, name, attrs = {}) {
  if (!span) return;
  span.events ??= [];
  if (span.events.length >= MAX_EVENTS_PER_SPAN) {
    span.droppedEvents = (span.droppedEvents ?? 0) + 1;
    return;
  }
  span.events.push({ at, name, attributes: attrs });
}

/** An OTLP/HTTP export request body for these spans. */
export function otlpRequest(spans, resource) {
  return { resourceSpans: [{ resource: { attributes: attributes(resource) }, scopeSpans: [{ scope: SCOPE, spans: spans.map(toOtlpSpan) }] }] };
}

/**
 * An exporter that sends nothing: with no destination, the tracer still reads the run logs for
 * the console's own view of the job (its marks and totals), and every span stays here.
 */
export function createLocalExporter() {
  const stats = { exported: 0, failed: 0, dropped: 0, requests: 0, lastError: null, lastOkAt: null };
  return { stats, local: true, push() {}, flush: async () => {}, pending: () => 0, accepted: () => true };
}

/**
 * How many spans of a 200 answer's batch the receiver rejected: OTLP's partial success
 * (`{"partialSuccess":{"rejectedSpans":"<n>"}}`, an int64 as a string in JSON). 0 for an empty or
 * unreadable body; at most the batch.
 */
async function rejectedSpans(res, size) {
  try {
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (!text) return 0;
    const n = Number(JSON.parse(text)?.partialSuccess?.rejectedSpans ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.min(size, Math.floor(n)) : 0;
  } catch {
    return 0;
  }
}

/**
 * Sends finished spans in batches (OTLP/HTTP, JSON encoding) to `<endpoint>/v1/traces` with the
 * `x-honeycomb-team` header. Never throws: a failure is counted and logged, and the job goes on.
 */
export function createExporter({ endpoint, apiKey, resource, redact = (t) => t, fetch: fetchImpl = globalThis.fetch, log = () => {}, timeoutMs = 10_000, now = Date.now }) {
  const queue = [];
  // The one way out: every string of every span, and of the resource, passes the job's redactor
  // here, whatever produced it (a span name, a tool or model name read from the transcript, an
  // id, a URL). Content was redacted when it was recorded too; redacting twice changes nothing.
  const cleanResource = redactAttributes(resource ?? {}, redact);
  const stats = { exported: 0, failed: 0, dropped: 0, requests: 0, lastError: null, lastOkAt: null };
  /** The span ids Honeycomb accepted (a 2xx for their batch): only those are worth a link. */
  const accepted = new Set();
  let sending = Promise.resolve();
  const url = `${endpoint.replace(/\/+$/, '')}/v1/traces`;

  async function post(batch) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        stats.requests += 1;
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-honeycomb-team': apiKey },
          body: JSON.stringify(otlpRequest(batch, cleanResource)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          // OTLP answers a partial success with 200 and how many spans it rejected, not which:
          // then none of the batch counts as accepted, for a link.
          const rejected = await rejectedSpans(res, batch.length);
          stats.exported += batch.length - rejected;
          if (rejected) {
            stats.failed += rejected;
            stats.lastError = 'partial success';
            log(`agent telemetry: ${rejected} of ${batch.length} span(s) rejected`);
          } else for (const span of batch) accepted.add(span.spanId);
          stats.lastOkAt = new Date(now()).toISOString();
          return;
        }
        // 4xx other than throttling will not get better by asking again (a bad key, a bad body).
        stats.lastError = `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 429) break;
      } catch (error) {
        stats.lastError = error?.name === 'TimeoutError' ? 'timeout' : (error?.name ?? 'error');
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
    }
    stats.failed += batch.length;
    log(`agent telemetry: ${batch.length} span(s) not sent (${stats.lastError})`);
  }

  return {
    stats,
    push(span) {
      queue.push(redactSpan(span, redact));
      if (queue.length > MAX_QUEUED_SPANS) {
        const over = queue.length - MAX_QUEUED_SPANS;
        queue.splice(0, over);
        stats.dropped += over;
      }
    },
    /** Sends everything queued so far (one request at a time). */
    flush() {
      sending = sending.then(async () => {
        while (queue.length) await post(queue.splice(0, EXPORT_BATCH));
      });
      return sending;
    },
    pending: () => queue.length,
    /** Whether Honeycomb accepted this span: false while it is queued, and when its batch failed or was dropped. */
    accepted: (spanId) => accepted.has(spanId),
  };
}

/** Every string value (and every string in an array value) of attributes, redacted. */
function redactAttributes(attrs, redact) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[redact(k)] = typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? redact(x) : x)) : v;
  }
  return out;
}

/** A span with its name, attributes and error message redacted; ids are hex the runner made. */
export function redactSpan(span, redact) {
  return {
    ...span,
    name: redact(span.name),
    attributes: redactAttributes(span.attributes ?? {}, redact),
    ...(span.errorMessage ? { errorMessage: redact(span.errorMessage) } : {}),
    ...(span.events ? { events: span.events.map((e) => ({ ...e, name: redact(e.name), attributes: redactAttributes(e.attributes ?? {}, redact) })) } : {}),
    ...(span.links ? { links: span.links.map((l) => ({ ...l, attributes: redactAttributes(l.attributes ?? {}, redact) })) } : {}),
  };
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text);

/** Every string in a JSON value, cut to `max` characters. */
function cutStrings(value, max) {
  if (typeof value === 'string') return cut(value, max);
  if (Array.isArray(value)) return value.map((v) => cutStrings(v, max));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutStrings(v, max)]));
  return value;
}

/**
 * An attribute's value: redacted, and within MAX_ATTRIBUTE_CHARS. Text is cut at the end; a JSON
 * value (messages, tool arguments) is cut inside its strings, so it stays valid JSON.
 */
function clip(redact, value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return cut(redact(value), MAX_ATTRIBUTE_CHARS);
  let parsed;
  try {
    // Redacted as text first: the redaction never adds a quote, so the JSON stays JSON.
    parsed = JSON.parse(redact(JSON.stringify(value)));
  } catch {
    return undefined;
  }
  for (let max = MAX_ATTRIBUTE_CHARS; max >= 64; max = Math.floor(max / 2)) {
    const text = JSON.stringify(cutStrings(parsed, max));
    if (text.length <= MAX_ATTRIBUTE_CHARS) return text;
  }
  return JSON.stringify(`[${JSON.stringify(parsed).length} characters, too large to record]`);
}

/** A name, version or id as the CLI reports it: plain characters only, else it is not recorded. */
const SAFE_NAME = /^[A-Za-z0-9_.:@/+[\]-]{1,128}$/;
/** Fields of a CLI event that are never put on a span: ids already there, and anything that may be content. */
const NOT_SCALAR = new Set(['type', 'subtype', 'uuid', 'session_id', 'parent_tool_use_id', 'output', 'stdout', 'stderr', 'content', 'text', 'message', 'prompt', 'result', 'body', 'input', 'response', 'error', 'errors', 'reason', 'detail', 'details', 'description']);

/** An event's plain values (numbers, booleans, short plain strings) as attributes under `prefix`. */
function scalarAttributes(ev, prefix) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(ev)) {
    if (NOT_SCALAR.has(k) || !/^[A-Za-z_]{1,40}$/.test(k) || n >= 24) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && /^[\w .:/@+-]{0,80}$/.test(v))) {
      out[`${prefix}.${k}`] = v;
      n++;
    }
  }
  return out;
}

/** The text of a Claude tool_result's content (a string or content blocks). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : c?.type ? `[${c.type}]` : '')).join('\n');
  return content === undefined ? '' : JSON.stringify(content);
}

/** What the worker's run.log header says about the run (src/worker/live.ts). */
export function parseHeaderLine(line, h) {
  let m;
  if ((m = /^updraft run (\S+)/.exec(line))) h.runId = m[1];
  else if ((m = /^job: (\S+)(?: \(attempt (\d+)\))?/.exec(line))) {
    h.jobId = m[1];
    if (m[2]) h.attempt = Number(m[2]);
  }
  else if ((m = /^repository: (\S+)/.exec(line))) h.repository = m[1];
  else if ((m = /^issue: #(\d+)/.exec(line))) h.issue = Number(m[1]);
  else if ((m = /^workflow: (\S+)/.exec(line))) h.workflow = m[1];
  else if ((m = /^pool: (\S+)/.exec(line))) h.pool = m[1];
  else if ((m = /^agent: (\S+)(?: \(adapter ([A-Za-z0-9_-]+)\))?/.exec(line))) {
    h.agent = m[1];
    if (m[2]) h.adapter = m[2];
  } else if (line.startsWith('profile: ')) {
    const model = /; model "([^"]+)"/.exec(line);
    const effort = /; effort "([^"]+)"/.exec(line);
    if (model) h.model = model[1];
    if (effort) h.effort = effort[1];
  } else if (line.startsWith('code written by agent: ')) h.kind = 'review';
  else if (line.startsWith('review: ') && h.kind !== 'review') h.kind = 'revision';
  else if ((m = /^pull request: #(\d+)/.exec(line))) h.pullRequest = Number(m[1]);
  else if ((m = /^trigger: (\S+)/.exec(line))) h.trigger = m[1];
  else if ((m = /^review: \S+ \((\d+) inline comment/.exec(line))) h.reviewComments = Number(m[1]);
  // What the worker logs once the worktree is ready, just before the agent starts.
  else if ((m = /^base: (\S+) at ([0-9a-f]{7,40})/.exec(line))) {
    h.baseBranch = m[1];
    h.baseSha = m[2];
  } else if ((m = /^branch: (\S+)/.exec(line))) h.branch = m[1];
  else if ((m = /^checkout: (\S+)/.exec(line))) h.checkout = m[1];
  else if ((m = /^container: \S+ \(runtime ([A-Za-z0-9_-]+)\)/.exec(line))) h.containerRuntime = m[1];
  else if ((m = /^timeout: (\d+) min/.exec(line))) h.timeoutMinutes = Number(m[1]);
  else if (line.startsWith('issue body: withheld')) h.issueWithheld = true;
  // Earlier runs of the same pull request, with the trace each was in (src/worker/live.ts).
  else if ((m = /^follows: run ([A-Za-z0-9_-]{1,80}) \(([a-z_-]{1,32}), trace ([0-9a-f]{32})\)/.exec(line))) {
    h.follows ??= [];
    if (h.follows.length < 8) h.follows.push({ runId: m[1], relation: m[2], traceId: m[3] });
  }
}

/**
 * The span id of a run's invoke_agent span: derived from the run id, so a later job (another
 * microVM, another trace) can link to it knowing only the run and the trace it was in.
 */
/** At most this many marks per run, and per job (stop's `marks`). */
export const MAX_MARKS_PER_RUN = 8;
export const MAX_MARKS_PER_JOB = 32;

export const agentSpanIdFor = (runId) => createHash('sha256').update(`updraft-agent-span:${runId}`).digest('hex').slice(0, 16);

const isJsonLine = (line) => line.startsWith('{') && line.endsWith('}');
function parseJson(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Total length of a set of [start, end] intervals, overlaps counted once. */
function unionMs(intervals) {
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  return curEnd === null ? total : total + curEnd - curStart;
}

/** Thresholds past which a run is marked as going in circles (`updraft.agent.thrashing`). */
export const THRASH = { repeatedCommands: 3, editsOneFile: 8, consecutiveToolErrors: 5 };

/**
 * How the agent worked, from the order and outcome of its calls: when it first edited and first
 * tested, how many edit→test cycles it went through and how many test runs it took to get one
 * to pass, whether it repeated itself, which file it kept coming back to, how its time split
 * between the model, the tools and neither, and how its context grew. Commands are compared in
 * memory only; nothing but counts, times and a path leaves this.
 */
export function createBehavior() {
  const b = {
    categories: {},
    firstToolAt: null,
    firstEditAt: null,
    firstTestAt: null,
    firstGreenAt: null,
    testRuns: 0,
    testRunsFailed: 0,
    testRunsUntilGreen: null,
    editTestCycles: 0,
    editedSinceTest: false,
    edits: 0,
    commands: new Map(),
    repeatedCommands: 0,
    editsByFile: new Map(),
    filesRead: new Set(),
    errorStreak: 0,
    maxErrorStreak: 0,
    toolIntervals: [],
    chatIntervals: [],
    chats: 0,
    firstContext: null,
    lastContext: null,
    peakContext: 0,
    inputTotal: 0,
    cachedTotal: 0,
  };
  return {
    tool({ category, name, attrs, command, failed, start, end }) {
      const c = category ?? 'other';
      b.categories[c] = (b.categories[c] ?? 0) + 1;
      b.firstToolAt ??= start;
      b.toolIntervals.push([start, end]);
      b.errorStreak = failed ? b.errorStreak + 1 : 0;
      b.maxErrorStreak = Math.max(b.maxErrorStreak, b.errorStreak);
      if (c === 'edit' && !failed) {
        b.firstEditAt ??= start;
        b.edits += 1;
        b.editedSinceTest = true;
        const paths = attrs['updraft.tool.file.paths'] ?? (attrs['updraft.tool.file.path'] ? [attrs['updraft.tool.file.path']] : []);
        for (const p of paths) b.editsByFile.set(p, (b.editsByFile.get(p) ?? 0) + 1);
      }
      if (name === 'Read' && attrs['updraft.tool.file.path']) b.filesRead.add(attrs['updraft.tool.file.path']);
      if (c === 'test') {
        b.firstTestAt ??= start;
        b.testRuns += 1;
        const red = failed || (attrs['updraft.test.failed'] ?? 0) > 0;
        if (red) b.testRunsFailed += 1;
        else if (b.firstGreenAt === null) {
          b.firstGreenAt = end;
          b.testRunsUntilGreen = b.testRuns;
        }
        if (b.editedSinceTest) b.editTestCycles += 1;
        b.editedSinceTest = false;
      }
      if (typeof command === 'string' && command.trim()) {
        // The same command again with no edit since: it cannot have a different answer.
        const key = command.trim().replace(/\s+/g, ' ');
        if (b.commands.get(key) === b.edits) b.repeatedCommands += 1;
        if (b.commands.size < 5000) b.commands.set(key, b.edits);
      }
    },
    /** One model response; returns attributes for its chat span. */
    chat({ start, end, input, cached, main }) {
      b.chatIntervals.push([start, end]);
      if (!main) return { 'updraft.chat.cache_hit_ratio': input ? Math.round((cached / input) * 1000) / 1000 : undefined };
      b.chats += 1;
      b.firstContext ??= input;
      b.lastContext = input;
      b.peakContext = Math.max(b.peakContext, input);
      b.inputTotal += input;
      b.cachedTotal += cached;
      return { 'updraft.chat.index': b.chats, 'updraft.chat.cache_hit_ratio': input ? Math.round((cached / input) * 1000) / 1000 : undefined };
    },
    /** The run's behavior, for its invoke_agent span. */
    attributes(start, end) {
      const since = (t) => (t === null ? undefined : Math.max(0, t - start));
      let hotFile;
      let maxEdits = 0;
      for (const [p, n] of b.editsByFile) {
        if (n > maxEdits) {
          maxEdits = n;
          hotFile = p;
        }
      }
      const model = unionMs(b.chatIntervals);
      const tool = unionMs(b.toolIntervals);
      const busy = unionMs([...b.chatIntervals, ...b.toolIntervals]);
      const thrashing = b.repeatedCommands >= THRASH.repeatedCommands || maxEdits >= THRASH.editsOneFile || b.maxErrorStreak >= THRASH.consecutiveToolErrors;
      return {
        ...Object.fromEntries(Object.entries(b.categories).map(([c, n]) => [`updraft.agent.tools.${c}`, n])),
        'updraft.agent.time_to_first_tool_ms': since(b.firstToolAt),
        'updraft.agent.time_to_first_edit_ms': since(b.firstEditAt),
        'updraft.agent.time_to_first_test_ms': since(b.firstTestAt),
        'updraft.agent.time_to_first_green_ms': since(b.firstGreenAt),
        'updraft.agent.test_runs': b.testRuns,
        'updraft.agent.test_runs_failed': b.testRunsFailed,
        'updraft.agent.test_runs_until_green': b.testRunsUntilGreen ?? undefined,
        'updraft.agent.edit_test_cycles': b.editTestCycles,
        'updraft.agent.edited_after_last_test': b.editedSinceTest && b.testRuns > 0 ? true : undefined,
        'updraft.agent.repeated_commands': b.repeatedCommands,
        'updraft.agent.files_edited': b.editsByFile.size,
        'updraft.agent.files_read': b.filesRead.size,
        'updraft.agent.max_edits_one_file': maxEdits || undefined,
        'updraft.agent.hot_file': maxEdits >= 3 ? hotFile : undefined,
        'updraft.agent.max_consecutive_tool_errors': b.maxErrorStreak,
        'updraft.agent.thrashing': thrashing,
        'updraft.agent.model_ms': model,
        'updraft.agent.tool_ms': tool,
        'updraft.agent.idle_ms': Math.max(0, end - start - busy),
        'updraft.agent.peak_context_tokens': b.peakContext || undefined,
        'updraft.agent.context_growth_tokens': b.lastContext !== null ? b.lastContext - b.firstContext : undefined,
        'updraft.agent.cache_hit_ratio': b.inputTotal ? Math.round((b.cachedTotal / b.inputTotal) * 1000) / 1000 : undefined,
      };
    },
  };
}

/**
 * One run's log, turned into spans as it is read. `emit(span)` gets each span when it ends.
 * Lines come with the time they were read (`at`), which is when they were written, give or take
 * a poll.
 */
export function createRunTrace({ traceId, rootSpanId, runDir, captureContent, redact, emit, readPrompt }) {
  const h = { kind: 'implement' };
  let phase = 'header';
  let agentSpan = null;
  let verifySpan = null;
  let verifyStep = null;
  let spans = 0;
  /** Claude: agent contexts by parent tool use id ('' for the main agent). */
  const contexts = new Map();
  /** Open tool spans by tool call id. */
  const tools = new Map();
  /** Codex: the open turn's chat span. */
  let turn = null;
  const summary = { runId: null, kind: null, agent: null, chats: 0, tools: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, outcome: null, costUsd: null, review: null, change: null };
  /** When the run's first line was read: its preparation (prompt, worktree) starts then. */
  let firstAt = null;
  let prepareSpan = null;
  /** Inside the run summary the worker writes at the end ('summary' or 'stat'), else null. */
  let summarySection = null;
  const change = { paths: [], testFiles: 0, testLines: 0, sourceLines: 0 };
  /** Updraft's publication, review and revision steps after the run, by step. */
  const steps = new Map();
  let compactions = 0;
  const behavior = createBehavior();
  /**
   * Spans worth a link of their own (stop's `marks`): the run's agent span, its first red test
   * run and the first green one after it, its first failed verify command, its first failed
   * Updraft step. Only spans that were sent: a link to one that was not would open the root.
   */
  const marks = [];
  const marked = new Set();
  let sawRedTest = false;
  /** Where the agent's paths are relative to: its own working directory, and the worktree. */
  const roots = () => [h.cwd, h.checkout].filter(Boolean);

  const conversationId = () => (h.repository && h.issue !== undefined ? `${h.repository}#${h.issue}` : (h.jobId ?? path.basename(runDir)));
  const provider = () => PROVIDER[h.adapter] ?? h.adapter;
  const base = (agentName) => ({
    'gen_ai.conversation.id': conversationId(),
    'gen_ai.agent.name': agentName,
    ...(provider() ? { 'gen_ai.provider.name': provider() } : {}),
    'updraft.run.id': h.runId,
    'updraft.job.id': h.jobId,
    'updraft.job.kind': h.kind,
    'updraft.repository': h.repository,
    'updraft.issue': h.issue,
    'updraft.pull_request': h.pullRequest,
  });
  const content = (value) => (captureContent ? clip(redact, value) : undefined);

  function finish(span, at) {
    if (span.ended) return;
    span.ended = true;
    span.end = Math.max(span.start, span.end ?? at);
    if (spans++ < MAX_SPANS_PER_RUN) {
      emit(span);
      noteMark(span);
    }
  }

  function noteMark(span) {
    const a = span.attributes ?? {};
    const add = (kind, extra = {}) => {
      if (marks.length < MAX_MARKS_PER_RUN) marks.push({ kind, spanId: span.spanId, at: span.start, end: span.end, ...(h.kind ? { run: h.kind } : {}), ...extra });
    };
    const once = (kind, extra) => {
      if (marked.has(kind)) return;
      marked.add(kind);
      add(kind, extra);
    };
    if (span === agentSpan) {
      const verdict = a['updraft.review.verdict'];
      add('agent', {
        ...(h.agent ? { agent: h.agent } : {}),
        ...(span.error ? { failed: true } : {}),
        ...(a['updraft.agent.thrashing'] === true ? { thrashing: true } : {}),
        ...(typeof verdict === 'string' ? { verdict } : {}),
      });
    } else if (span.name === 'execute_tool verify') {
      if (span.error) once('verify_failed');
    } else if (a['gen_ai.operation.name'] === 'execute_tool' && a['updraft.tool.category'] === 'test') {
      if (span.error || (a['updraft.test.failed'] ?? 0) > 0) {
        sawRedTest = true;
        once('test_failed');
      } else if (sawRedTest && (a['updraft.test.passed'] ?? 0) > 0) {
        // Green only on evidence: tests ran and passed (a command that printed no result, such as --help, is not it).
        once('test_green');
      }
    } else if (span.error && a['gen_ai.agent.name'] === 'updraft' && typeof a['updraft.step'] === 'string') {
      once('step_failed', { step: a['updraft.step'] });
    }
  }

  /** Updraft's own steps: on the "updraft" lane, with no provider. */
  const updraftBase = () => ({ ...base('updraft'), 'gen_ai.provider.name': undefined });

  /** The run's preparation, from its first line to the worker's "ready" block; ended when the agent starts or the run ends. */
  function endPrepare(at, failure) {
    if (firstAt === null || prepareSpan?.ended) return;
    prepareSpan ??= {
      traceId,
      spanId: newSpanId(),
      parentSpanId: rootSpanId,
      name: 'updraft prepare',
      kind: KIND_INTERNAL,
      start: firstAt,
    };
    prepareSpan.attributes = {
      ...updraftBase(),
      'updraft.step': 'prepare',
      'updraft.job.attempt': h.attempt,
      'updraft.trigger': h.trigger,
      'updraft.base.branch': h.baseBranch,
      'updraft.base.sha': h.baseSha,
      'updraft.branch': h.branch,
      'updraft.container.runtime': h.containerRuntime,
      'updraft.agent.timeout_minutes': h.timeoutMinutes,
      'updraft.issue.withheld': h.issueWithheld,
      'updraft.review.inline_comments': h.reviewComments,
    };
    if (failure) {
      prepareSpan.error = true;
      prepareSpan.attributes['error.type'] = failure.type;
      // The worker's error may quote git or the CLI (their stderr): content.
      if (failure.message && captureContent) prepareSpan.errorMessage = clip(redact, failure.message.slice(0, MAX_MESSAGE_CHARS));
    }
    finish(prepareSpan, h.preparedAt ?? at);
  }

  function startAgent(at) {
    endPrepare(at);
    agentSpan = {
      traceId,
      // Derived from the run id, so a later job's trace can link to this run.
      spanId: h.runId ? agentSpanIdFor(h.runId) : newSpanId(),
      parentSpanId: rootSpanId,
      name: `invoke_agent ${h.agent ?? 'agent'}`,
      kind: KIND_INTERNAL,
      start: at,
      attributes: {
        ...base(h.agent ?? 'agent'),
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.request.model': h.model,
        'updraft.agent.effort': h.effort,
        'updraft.pool': h.pool,
        'updraft.workflow': h.workflow,
        'updraft.trigger': h.trigger,
        'updraft.job.attempt': h.attempt,
        'updraft.branch': h.branch,
        'updraft.base.sha': h.baseSha,
      },
      // The runs this one follows: the review it answers, the code it reviews.
      links: (h.follows ?? []).map((f) => ({ traceId: f.traceId, spanId: agentSpanIdFor(f.runId), attributes: { 'updraft.link.relation': f.relation, 'updraft.run.id': f.runId } })),
    };
    contexts.set('', { span: agentSpan, name: h.agent ?? 'agent', last: at, chat: null, pendingInput: [] });
    Object.assign(summary, { runId: h.runId ?? null, kind: h.kind, agent: h.agent ?? null });
    if (captureContent && readPrompt) {
      readPrompt()
        .then((prompt) => {
          if (prompt) agentSpan.attributes['gen_ai.input.messages'] = clip(redact, [{ role: 'user', parts: [{ type: 'text', content: prompt }] }]);
        })
        .catch(() => {});
    }
  }

  /** The agent's plan changed (TodoWrite, a Codex todo list): its counts, and its items with content on. */
  function todoEvent(span, at, detail, items) {
    const counts = Object.fromEntries(Object.entries(detail).filter(([k]) => k.startsWith('updraft.todo.')));
    if (!Object.keys(counts).length) return;
    addEvent(span, at, 'todo.update', { ...counts, 'updraft.todo.items': items ? content(items) : undefined });
  }

  // ---- Claude Code stream-json --------------------------------------------------------------

  function closeChat(ctx, at) {
    const c = ctx.chat;
    if (!c) return;
    ctx.chat = null;
    const u = c.usage ?? {};
    const cacheRead = Number(u.cache_read_input_tokens) || 0;
    const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
    // The conventions' input count includes the cache reads and writes; Anthropic's does not.
    const input = (Number(u.input_tokens) || 0) + cacheRead + cacheWrite;
    const output = Number(u.output_tokens) || 0;
    Object.assign(c.span.attributes, {
      'gen_ai.response.model': c.model,
      'gen_ai.usage.input_tokens': input,
      'gen_ai.usage.output_tokens': output,
      'gen_ai.usage.cache_read.input_tokens': cacheRead || undefined,
      'gen_ai.usage.cache_creation.input_tokens': cacheWrite || undefined,
      'gen_ai.response.finish_reasons': c.stop ? [FINISH[c.stop] ?? c.stop] : undefined,
    });
    if (c.model) c.span.name = `chat ${c.model}`;
    if (captureContent) {
      if (c.input.length) c.span.attributes['gen_ai.input.messages'] = clip(redact, c.input);
      if (c.parts.length) c.span.attributes['gen_ai.output.messages'] = clip(redact, [{ role: 'assistant', parts: c.parts, ...(c.stop ? { finish_reason: FINISH[c.stop] ?? c.stop } : {}) }]);
    }
    summary.chats += 1;
    summary.inputTokens += input;
    summary.outputTokens += output;
    Object.assign(c.span.attributes, behavior.chat({ start: c.span.start, end: c.end ?? at, input, cached: cacheRead, main: !ctx.sub }));
    finish(c.span, c.end ?? at);
  }

  function claudeContext(parentToolUseId, at) {
    const key = parentToolUseId ?? '';
    let ctx = contexts.get(key);
    if (!ctx) {
      // A subagent's message: its invoke_agent span hangs under the tool call that started it.
      const tool = tools.get(key);
      const type = typeof tool?.input?.subagent_type === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(tool.input.subagent_type) ? tool.input.subagent_type : 'subagent';
      const name = `${h.agent ?? 'agent'}/${type}`;
      const span = {
        traceId,
        spanId: newSpanId(),
        parentSpanId: tool?.span.spanId ?? agentSpan?.spanId ?? rootSpanId,
        name: `invoke_agent ${name}`,
        kind: KIND_INTERNAL,
        start: tool?.span.start ?? at,
        attributes: { ...base(name), 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.description': content(tool?.input?.description) },
      };
      ctx = { span, name, last: span.start, chat: null, pendingInput: [], sub: true };
      contexts.set(key, ctx);
    }
    return ctx;
  }

  function onClaude(ev, at) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (typeof ev.cwd === 'string') h.cwd = ev.cwd;
      if (agentSpan) {
        const servers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers.filter((m) => m && typeof m.name === 'string' && SAFE_NAME.test(m.name)) : [];
        Object.assign(agentSpan.attributes, {
          'gen_ai.agent.id': typeof ev.session_id === 'string' ? ev.session_id : undefined,
          'updraft.agent.cli_version': typeof ev.claude_code_version === 'string' && SAFE_NAME.test(ev.claude_code_version) ? ev.claude_code_version : undefined,
          'updraft.agent.permission_mode': typeof ev.permissionMode === 'string' && SAFE_NAME.test(ev.permissionMode) ? ev.permissionMode : undefined,
          'updraft.agent.tools_available': Array.isArray(ev.tools) ? ev.tools.length : undefined,
          'updraft.agent.mcp_servers': servers.length ? servers.map((m) => m.name) : undefined,
          'updraft.agent.mcp_servers_failed': servers.some((m) => m.status !== 'connected') ? servers.filter((m) => m.status !== 'connected').map((m) => m.name) : undefined,
        });
        if (!h.model && typeof ev.model === 'string') agentSpan.attributes['gen_ai.request.model'] = ev.model;
      }
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
      // The agent's context was compacted: the conversation so far replaced by a summary.
      const ctx = claudeContext(ev.parent_tool_use_id, at);
      const meta = ev.compact_metadata && typeof ev.compact_metadata === 'object' ? ev.compact_metadata : {};
      compactions += 1;
      addEvent(ctx.span, at, 'compaction', { 'updraft.compaction.trigger': typeof meta.trigger === 'string' && SAFE_NAME.test(meta.trigger) ? meta.trigger : undefined, 'updraft.compaction.pre_tokens': typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined });
      if (agentSpan && agentSpan.attributes['updraft.agent.first_compaction_ms'] === undefined) agentSpan.attributes['updraft.agent.first_compaction_ms'] = at - agentSpan.start;
      return;
    }
    if (ev.type === 'system' && typeof ev.subtype === 'string' && /^[a-z_]{1,40}$/.test(ev.subtype)) {
      // Anything else the CLI reports about itself (retries, status, hooks): its name and its plain values only.
      addEvent(claudeContext(ev.parent_tool_use_id, at).span, at, `system.${ev.subtype}`, scalarAttributes(ev, 'updraft.system'));
      return;
    }
    if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
      const ctx = claudeContext(ev.parent_tool_use_id, at);
      const msg = ev.message;
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (ctx.chat && ctx.chat.id !== id) closeChat(ctx, at);
      if (!ctx.chat) {
        const span = {
          traceId,
          spanId: newSpanId(),
          parentSpanId: ctx.span.spanId,
          name: 'chat',
          kind: KIND_CLIENT,
          start: ctx.last,
          attributes: { ...base(ctx.name), 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': h.model ?? agentSpan?.attributes['gen_ai.request.model'], 'gen_ai.response.id': id ?? undefined },
        };
        const input = ctx.pendingInput.splice(0);
        ctx.chat = { id, span, parts: [], input, usage: null, model: null, stop: null, end: at };
      }
      const c = ctx.chat;
      c.end = at;
      if (typeof msg.model === 'string') c.model = msg.model;
      if (msg.usage && typeof msg.usage === 'object') {
        // Streamed blocks of one message repeat its usage; the output count only grows.
        c.usage = { ...msg.usage, output_tokens: Math.max(Number(msg.usage.output_tokens) || 0, Number(c.usage?.output_tokens) || 0) };
      }
      if (typeof msg.stop_reason === 'string') c.stop = msg.stop_reason;
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') c.parts.push({ type: 'text', content: block.text });
        else if (block?.type === 'thinking' && typeof block.thinking === 'string') c.parts.push({ type: 'reasoning', content: block.thinking });
        else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          c.parts.push({ type: 'tool_call', id: block.id, name: block.name, arguments: block.input ?? {} });
          if (!c.stop) c.stop = 'tool_use';
          const input = block.input && typeof block.input === 'object' ? block.input : {};
          const detail = claudeToolAttributes(block.name, input, roots());
          const span = {
            traceId,
            spanId: newSpanId(),
            parentSpanId: ctx.span.spanId,
            name: `execute_tool ${block.name}`,
            kind: KIND_INTERNAL,
            start: at,
            attributes: {
              ...base(ctx.name),
              'gen_ai.operation.name': 'execute_tool',
              'gen_ai.tool.name': block.name,
              'gen_ai.tool.call.id': block.id,
              'gen_ai.tool.type': block.name.startsWith('mcp__') ? 'extension' : 'function',
              'gen_ai.tool.call.arguments': content(block.input ?? {}),
              ...detail,
            },
          };
          tools.set(block.id, { span, input, name: block.name, category: detail['updraft.tool.category'], ctx });
          if (block.name === 'TodoWrite') todoEvent(ctx.span, at, detail, Array.isArray(input.todos) ? input.todos.map((t) => ({ content: t?.content, status: t?.status })) : null);
        }
      }
      return;
    }
    if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      const ctx = claudeContext(ev.parent_tool_use_id, at);
      closeChat(ctx, at);
      for (const block of ev.message.content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const tool = tools.get(block.tool_use_id);
        const text = resultText(block.content);
        if (captureContent) ctx.pendingInput.push({ role: 'tool', parts: [{ type: 'tool_call_response', id: block.tool_use_id, response: text }] });
        if (!tool) continue;
        tools.delete(block.tool_use_id);
        summary.tools += 1;
        const failed = block.is_error === true;
        Object.assign(tool.span.attributes, resultAttributes(tool.category, tool.name, text, failed, tool.span.attributes['updraft.tool.command.programs']));
        if (failed) {
          tool.span.error = true;
          tool.span.attributes['error.type'] = 'tool_error';
          summary.toolErrors += 1;
        } else tool.span.attributes['gen_ai.tool.call.result'] = content(text);
        behavior.tool({ category: tool.category, name: tool.name, attrs: tool.span.attributes, command: tool.name === 'Bash' ? tool.input.command : undefined, failed, start: tool.span.start, end: at });
        // The subagent this tool ran, if any, ends with it.
        const sub = contexts.get(block.tool_use_id);
        if (sub) {
          closeChat(sub, at);
          finish(sub.span, at);
          contexts.delete(block.tool_use_id);
        }
        finish(tool.span, at);
      }
      ctx.last = at;
      return;
    }
    if (ev.type === 'result') {
      const ctx = contexts.get('');
      if (ctx) closeChat(ctx, at);
      if (agentSpan) {
        const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : null;
        const usage = ev.modelUsage && typeof ev.modelUsage === 'object' && !Array.isArray(ev.modelUsage) ? ev.modelUsage : {};
        const models = Object.keys(usage).filter((m) => SAFE_NAME.test(m)).slice(0, 16);
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        const word = (v) => (typeof v === 'string' && SAFE_NAME.test(v) ? v : undefined);
        Object.assign(agentSpan.attributes, {
          'updraft.agent.turns': num(ev.num_turns),
          'updraft.agent.reported_cost_usd': num(ev.total_cost_usd),
          // Wall time against time spent waiting on the model API, as the CLI measured them.
          'updraft.agent.duration_ms': num(ev.duration_ms),
          'updraft.agent.api_duration_ms': num(ev.duration_api_ms),
          'updraft.agent.result.subtype': word(ev.subtype),
          'updraft.agent.terminal_reason': word(ev.terminal_reason),
          'updraft.agent.stop_reason': word(ev.stop_reason),
          'updraft.agent.errors': Array.isArray(ev.errors) ? ev.errors.length : undefined,
          'updraft.agent.permission_denials': denials ? denials.length : undefined,
          'updraft.agent.permission_denied_tools': denials?.length ? [...new Set(denials.map((d) => d?.tool_name).filter((n) => typeof n === 'string' && SAFE_NAME.test(n)))] : undefined,
          'updraft.agent.models': models.length ? models : undefined,
        });
        if (typeof ev.total_cost_usd === 'number') summary.costUsd = ev.total_cost_usd;
        for (const m of models) {
          const u = usage[m] && typeof usage[m] === 'object' ? usage[m] : {};
          addEvent(agentSpan, at, 'model_usage', {
            'gen_ai.response.model': m,
            'updraft.usage.input_tokens': num(u.inputTokens),
            'updraft.usage.output_tokens': num(u.outputTokens),
            'updraft.usage.cache_read_tokens': num(u.cacheReadInputTokens),
            'updraft.usage.cache_creation_tokens': num(u.cacheCreationInputTokens),
            'updraft.usage.web_search_requests': num(u.webSearchRequests),
            'updraft.usage.cost_usd': num(u.costUSD),
          });
        }
        if (captureContent && typeof ev.result === 'string') {
          agentSpan.attributes['gen_ai.output.messages'] = clip(redact, [{ role: 'assistant', parts: [{ type: 'text', content: ev.result }], finish_reason: ev.is_error ? 'error' : 'stop' }]);
        }
        if (ev.is_error === true) {
          agentSpan.error = true;
          agentSpan.attributes['error.type'] = typeof ev.subtype === 'string' ? ev.subtype : 'agent_error';
        }
      }
    }
  }

  // ---- Codex exec --json ---------------------------------------------------------------------

  const codexTool = (item) => {
    if (item.type === 'command_execution') return { name: 'shell', args: { command: item.command } };
    if (item.type === 'file_change') return { name: 'apply_patch', args: { changes: item.changes } };
    if (item.type === 'mcp_tool_call') return { name: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`, args: item.arguments ?? {}, extension: true };
    if (item.type === 'web_search') return { name: 'web_search', args: { query: item.query } };
    return null;
  };

  function closeTurn(at, usage, failed) {
    if (!turn) return;
    const t = turn;
    turn = null;
    const input = Number(usage?.input_tokens) || 0;
    const cached = Number(usage?.cached_input_tokens) || 0;
    const written = Number(usage?.cache_write_input_tokens) || 0;
    const output = Number(usage?.output_tokens) || 0;
    // OpenAI's input count already includes the cached tokens.
    Object.assign(t.span.attributes, {
      'updraft.usage.reasoning_output_tokens': Number(usage?.reasoning_output_tokens) || undefined,
      'gen_ai.usage.input_tokens': usage ? input : undefined,
      'gen_ai.usage.output_tokens': usage ? output : undefined,
      'gen_ai.usage.cache_read.input_tokens': cached || undefined,
      'gen_ai.usage.cache_creation.input_tokens': written || undefined,
      'gen_ai.response.finish_reasons': [failed ? 'error' : t.toolCalls ? 'tool_call' : 'stop'],
    });
    if (failed) {
      t.span.error = true;
      t.span.attributes['error.type'] = 'turn_failed';
    }
    if (captureContent && t.parts.length) t.span.attributes['gen_ai.output.messages'] = clip(redact, [{ role: 'assistant', parts: t.parts }]);
    summary.chats += 1;
    summary.inputTokens += input;
    summary.outputTokens += output;
    if (usage) Object.assign(t.span.attributes, behavior.chat({ start: t.span.start, end: at, input, cached, main: true }));
    finish(t.span, at);
  }

  function onCodex(ev, at) {
    if (ev.type === 'thread.started' && agentSpan) {
      agentSpan.attributes['gen_ai.agent.id'] = typeof ev.thread_id === 'string' ? ev.thread_id : undefined;
      return;
    }
    if (ev.type === 'turn.started') {
      closeTurn(at, null, false);
      const model = h.model;
      turn = {
        span: {
          traceId,
          spanId: newSpanId(),
          parentSpanId: agentSpan?.spanId ?? rootSpanId,
          name: model ? `chat ${model}` : 'chat',
          kind: KIND_CLIENT,
          start: at,
          attributes: { ...base(h.agent ?? 'agent'), 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': model },
        },
        parts: [],
        toolCalls: 0,
      };
      return;
    }
    if (ev.type === 'turn.completed') return closeTurn(at, ev.usage, false);
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      if (ev.type === 'turn.failed') closeTurn(at, null, true);
      if (agentSpan) {
        agentSpan.error = true;
        agentSpan.attributes['error.type'] = ev.type;
      }
      return;
    }
    const item = ev.item;
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') return;
    if (item.type === 'todo_list') {
      todoEvent(agentSpan, at, codexTodoAttributes(item), Array.isArray(item.items) ? item.items.map((t) => ({ content: t?.text, status: t?.completed ? 'completed' : 'pending' })) : null);
      return;
    }
    if (item.type === 'error' && ev.type === 'item.completed') {
      addEvent(agentSpan, at, 'error', { 'updraft.message': captureContent && typeof item.message === 'string' ? clip(redact, item.message.slice(0, MAX_MESSAGE_CHARS)) : undefined });
      return;
    }
    if (ev.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') turn?.parts.push({ type: 'text', content: item.text });
    if (ev.type === 'item.completed' && item.type === 'reasoning' && typeof item.text === 'string') turn?.parts.push({ type: 'reasoning', content: item.text });
    const kind = codexTool(item);
    if (!kind) return;
    let open = tools.get(item.id);
    if (!open) {
      if (turn) turn.toolCalls += 1;
      turn?.parts.push({ type: 'tool_call', id: item.id, name: kind.name, arguments: kind.args });
      const detail = codexToolAttributes(item, roots());
      detail['updraft.tool.category'] = toolCategory(kind.name, detail);
      open = {
        name: kind.name,
        category: detail['updraft.tool.category'],
        span: {
          traceId,
          spanId: newSpanId(),
          parentSpanId: agentSpan?.spanId ?? rootSpanId,
          name: `execute_tool ${kind.name}`,
          kind: KIND_INTERNAL,
          start: at,
          attributes: {
            ...base(h.agent ?? 'agent'),
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': kind.name,
            'gen_ai.tool.call.id': item.id,
            'gen_ai.tool.type': kind.extension ? 'extension' : 'function',
            'gen_ai.tool.call.arguments': content(kind.args),
            ...detail,
          },
        },
      };
      tools.set(item.id, open);
    }
    if (ev.type !== 'item.completed') return;
    tools.delete(item.id);
    summary.tools += 1;
    const failed = item.status === 'failed' || (item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0);
    if (typeof item.exit_code === 'number') open.span.attributes['updraft.tool.exit_code'] = item.exit_code;
    if (failed) {
      open.span.error = true;
      open.span.attributes['error.type'] = 'tool_error';
      summary.toolErrors += 1;
    }
    const result = item.aggregated_output ?? item.result ?? (item.error ? item.error.message : undefined);
    if (item.type === 'command_execution') Object.assign(open.span.attributes, resultAttributes(open.category, open.name, typeof item.aggregated_output === 'string' ? item.aggregated_output : '', failed, open.span.attributes['updraft.tool.command.programs']));
    if (typeof item.exit_code === 'number') open.span.attributes['updraft.tool.exit_code'] = item.exit_code;
    if (result !== undefined && !failed) open.span.attributes['gen_ai.tool.call.result'] = content(result);
    behavior.tool({ category: open.category, name: open.name, attrs: open.span.attributes, command: item.type === 'command_execution' ? item.command : undefined, failed, start: open.span.start, end: at });
    finish(open.span, at);
  }

  // ---- The worker's own lines ----------------------------------------------------------------

  /** Step events whose line is entirely Updraft's own text (a URL, a branch, a count). */
  const STRUCTURED_STEP_EVENTS = new Set(['attempt', 'push', 'pull_request.opened', 'pull_request.reused', 'already_pushed', 'review.posted', 'pull_request.ready', 'comment.posted', 'superseded']);

  /** Updraft's steps after a run, by the prefix the publish modules give their run.log lines. */
  const STEP_PREFIXES = [
    ['publication: ', 'publish'],
    ['review: ', 'post_review'],
    ['revision: ', 'push_revision'],
    ['failure comment: ', 'failure_comment'],
  ];

  /**
   * One line of a publication, review or revision step: a new attempt starts a span; everything
   * else is an event on it (with the line, which is Updraft's own text), and what it says about
   * the pull request and the review lands on the span.
   */
  function onStepLine(step, text, at) {
    let m;
    const attempt = /^attempt (\d+) (?:\(|at\b)/.exec(text);
    let s = steps.get(step);
    if (s && attempt) {
      finish(s.span, s.last);
      s = null;
    }
    if (!s) {
      s = {
        span: { traceId, spanId: newSpanId(), parentSpanId: rootSpanId, name: `updraft ${step}`, kind: KIND_INTERNAL, start: at, attributes: { ...updraftBase(), 'updraft.step': step, 'updraft.step.attempt': attempt ? Number(attempt[1]) : undefined } },
        last: at,
      };
      steps.set(step, s);
    }
    s.last = at;
    const a = s.span.attributes;
    let name = 'log';
    if ((m = /^pushing (?:\S+ \([0-9a-f]+, |[0-9a-f]+\.\.[0-9a-f]+ \()(\d+) commit/.exec(text))) {
      name = 'push';
      a['updraft.push.commits'] = Number(m[1]);
    } else if ((m = /^opened (draft )?PR #(\d+): (\S+)/.exec(text))) {
      name = 'pull_request.opened';
      Object.assign(a, { 'updraft.pull_request': Number(m[2]), 'updraft.pull_request.url': m[3], 'updraft.pull_request.draft': Boolean(m[1]) });
    } else if ((m = /^reusing PR #(\d+)/.exec(text))) {
      name = 'pull_request.reused';
      a['updraft.pull_request'] = Number(m[1]);
    } else if (/ is already on /.test(text)) name = 'already_pushed';
    else if (/^skipped: /.test(text)) {
      name = 'skipped';
      a['updraft.step.result'] = 'skipped';
    } else if (/^not posted: /.test(text)) {
      name = 'not_posted';
      a['updraft.step.result'] = 'not_posted';
      s.span.error = true;
      a['error.type'] = 'not_posted';
    } else if ((m = /verdict (\S+) for [0-9a-f]+ of pull request #(\d+)/.exec(text))) {
      name = 'attempt';
      Object.assign(a, { 'updraft.review.verdict': m[1], 'updraft.pull_request': Number(m[2]) });
    } else if ((m = /^verdict \S+: ([a-z-]+)/.exec(text))) {
      name = 'review.outcome';
      a['updraft.review.outcome'] = m[1];
      summary.review = { ...(summary.review ?? {}), outcome: m[1] };
    } else if (/^(posted a comment review|review already on)/.test(text)) name = 'review.posted';
    else if (/^marked pull request #\d+ ready/.test(text)) name = 'pull_request.ready';
    else if (/^(updated the comment|commented|comment already|already on)/.test(text)) name = 'comment.posted';
    else if (/^attempt \d+ stopped/.test(text)) name = 'superseded';
    else if (attempt) name = 'attempt';
    // A line of a known shape is Updraft's own words, with values already on the span; any other
    // (a reason, an error from GitHub) may quote anything, and is content.
    const ownWords = STRUCTURED_STEP_EVENTS.has(name);
    addEvent(s.span, at, name, { 'updraft.message': ownWords || captureContent ? clip(redact, text.slice(0, MAX_MESSAGE_CHARS)) : undefined });
  }

  /** The worker's end-of-run summary: commits, the diffstat, untracked files. */
  function onSummaryLine(line) {
    let m;
    if ((m = /^ {2}commits since base: (\d+)/.exec(line))) change.commits = Number(m[1]);
    else if ((m = /^ {2}changed files \(.*\): (\d+)$/.exec(line))) {
      change.files = Number(m[1]);
      summarySection = 'stat';
    } else if (summarySection === 'stat' && (m = /^ {2}(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(line))) {
      change.insertions = Number(m[2] ?? 0);
      change.deletions = Number(m[3] ?? 0);
    } else if (summarySection === 'stat' && (m = /^ {2}(\S.*?)\s+\|\s+(\d+|Bin)\b/.exec(line))) {
      const lines = m[2] === 'Bin' ? 0 : Number(m[2]);
      if (change.paths.length < 50) change.paths.push(m[1].slice(0, 512));
      if (isTestPath(m[1])) {
        change.testFiles += 1;
        change.testLines += lines;
      } else change.sourceLines += lines;
    } else if ((m = /^ {2}untracked files: (\d+)/.exec(line))) {
      change.untracked = Number(m[1]);
      summarySection = 'summary';
    } else if (line === '  last agent output:') summarySection = 'output';
  }

  function onWorkerLine(line, at) {
    let m;
    if (verifyStep && !line.startsWith('---- ') && !/^exit: (code|signal) /.test(line)) {
      // A verify command's own output: kept (its end) to read the test counts from.
      if (verifyStep.outputLines === undefined) {
        // The first line is the worker's 'command: [...]'.
        verifyStep.outputLines = 0;
        verifyStep.output = '';
        if (line.startsWith('command: ')) return;
      }
      verifyStep.outputLines += 1;
      verifyStep.output += `${line}\n`;
      if (verifyStep.output.length > MAX_VERIFY_OUTPUT_CHARS) verifyStep.output = verifyStep.output.slice(-MAX_VERIFY_OUTPUT_CHARS / 2);
      return;
    }
    if (line === 'summary:' && phase === 'after') {
      summarySection = 'summary';
      return;
    }
    if (summarySection) {
      if (line.startsWith('  ')) return onSummaryLine(line);
      if (line !== '') summarySection = null;
    }
    for (const [prefix, step] of STEP_PREFIXES) {
      if (line.startsWith(prefix) && phase === 'after') return onStepLine(step, line.slice(prefix.length), at);
    }
    if (line.startsWith('---- agent output')) {
      phase = 'agent';
      startAgent(at);
    } else if (line === '---- end of agent output ----') {
      phase = 'after';
      endAgent(at);
    } else if (line.startsWith('---- verification (')) {
      verifySpan = {
        traceId,
        spanId: newSpanId(),
        parentSpanId: rootSpanId,
        name: 'invoke_workflow verify',
        kind: KIND_INTERNAL,
        start: at,
        attributes: { ...base('updraft'), 'gen_ai.provider.name': undefined, 'gen_ai.operation.name': 'invoke_workflow' },
      };
    } else if ((m = /^---- verify (\d+)\/(\d+): (.*) ----$/.exec(line))) {
      if (verifyStep) finish(verifyStep, at);
      verifyStep = {
        traceId,
        spanId: newSpanId(),
        parentSpanId: verifySpan?.spanId ?? rootSpanId,
        name: 'execute_tool verify',
        kind: KIND_INTERNAL,
        start: at,
        attributes: {
          ...base('updraft'),
          'gen_ai.provider.name': undefined,
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'verify',
          'gen_ai.tool.type': 'function',
          'gen_ai.tool.call.id': `${h.runId ?? 'run'}-verify-${m[1]}`,
          'updraft.verify.command': clip(redact, m[3]),
          'updraft.verify.index': Number(m[1]),
        },
        // What the command runs, to tell checkers' summaries apart; not an attribute.
        programs: describeCommand(m[3])?.programs ?? [],
      };
    } else if ((m = /^exit: (code (-?\d+)|signal (\S+)) after (\d+)s/.exec(line)) && verifyStep) {
      const code = m[2] !== undefined ? Number(m[2]) : null;
      verifyStep.attributes['updraft.tool.exit_code'] = code ?? undefined;
      if (code !== 0) {
        verifyStep.error = true;
        verifyStep.attributes['error.type'] = code === null ? `signal_${m[3]}` : 'exit_code';
      }
      endVerifyStep(at);
    } else if ((m = /^exit: (code (-?\d+)|signal (\S+)) after (\d+)s(?: \(stopped by the worker: ([a-z_ ]+)\))?/.exec(line)) && agentSpan && !verifySpan && agentSpan.attributes['updraft.agent.exit_code'] === undefined && agentSpan.attributes['updraft.agent.exit_signal'] === undefined) {
      // How the agent's process ended.
      if (m[2] !== undefined) agentSpan.attributes['updraft.agent.exit_code'] = Number(m[2]);
      else agentSpan.attributes['updraft.agent.exit_signal'] = m[3].slice(0, 32);
      if (m[5]) agentSpan.attributes['updraft.agent.stopped_by'] = m[5];
    } else if ((m = /^---- end of verification: (\w+) ----$/.exec(line))) {
      if (verifyStep) endVerifyStep(at);
      if (verifySpan) {
        if (m[1] !== 'passed') {
          verifySpan.error = true;
          verifySpan.attributes['error.type'] = `verify_${m[1]}`;
        }
        verifySpan.attributes['updraft.verify.result'] = m[1];
        finish(verifySpan, at);
        verifySpan = null;
      }
    } else if ((m = /^review verdict for ([0-9a-f]{7,40}): (\S+)/.exec(line))) {
      const verdict = m[2] === 'none' ? 'none' : m[2];
      summary.review = { ...(summary.review ?? {}), verdict };
      if (agentSpan) Object.assign(agentSpan.attributes, { 'updraft.review.verdict': verdict, 'updraft.review.head_sha': m[1] });
      if (verdict === 'none' && agentSpan) agentSpan.attributes['error.type'] = 'no_verdict';
    } else if ((m = /^review findings count: (\d+)/.exec(line))) {
      summary.review = { ...(summary.review ?? {}), findings: Number(m[1]) };
      if (agentSpan) agentSpan.attributes['updraft.review.findings'] = Number(m[1]);
    } else if ((m = /^waiting on: ([\w.-]+\/[\w.-]+)#(\d+)/.exec(line))) {
      if (agentSpan) agentSpan.attributes['updraft.waiting_on'] = `${m[1]}#${m[2]}`;
    } else if (line.startsWith('verification: skipped')) {
      if (agentSpan) agentSpan.attributes['updraft.verify.result'] = 'skipped';
    } else if ((m = /^outcome: (\S+)/.exec(line))) {
      summary.outcome = m[1];
      if (!agentSpan) endPrepare(at, m[1] === 'succeeded' ? null : { type: m[1], message: h.startError });
      phase = 'after';
      if (agentSpan) {
        agentSpan.attributes['updraft.run.outcome'] = m[1];
        if (m[1] !== 'succeeded') {
          agentSpan.error = true;
          agentSpan.attributes['error.type'] ??= m[1];
        }
      }
    }
  }

  /** Ends the open verify command, with what its output says about tests and checks. */
  function endVerifyStep(at) {
    const v = verifyStep;
    verifyStep = null;
    if (!v) return;
    const tests = parseTestOutput(v.output ?? '');
    const checks = parseCheckOutput(v.output ?? '', v.programs ?? []);
    Object.assign(v.attributes, { 'updraft.verify.output_lines': v.outputLines ?? 0, ...testAttributes(tests), ...checkAttributes(checks) });
    if (verifySpan && tests) {
      const a = verifySpan.attributes;
      a['updraft.test.passed'] = (a['updraft.test.passed'] ?? 0) + tests.passed;
      a['updraft.test.failed'] = (a['updraft.test.failed'] ?? 0) + tests.failed;
      a['updraft.test.skipped'] = (a['updraft.test.skipped'] ?? 0) + tests.skipped;
      if (tests.failedTests?.length) a['updraft.test.failed_tests'] = [...(a['updraft.test.failed_tests'] ?? []), ...tests.failedTests].slice(0, 20);
    }
    delete v.output;
    delete v.outputLines;
    delete v.programs;
    finish(v, at);
  }

  function endAgent(at) {
    for (const [key, ctx] of [...contexts.entries()].reverse()) {
      closeChat(ctx, at);
      if (key !== '') finish(ctx.span, at);
    }
    closeTurn(at, null, false);
    for (const t of tools.values()) {
      // A tool still open when the agent ended: it never answered.
      t.span.error = true;
      t.span.attributes['error.type'] = 'unfinished';
      finish(t.span, at);
    }
    tools.clear();
    if (agentSpan && !agentSpan.endedPending) {
      agentSpan.endedPending = true;
      agentSpan.end = at;
    }
  }

  /** Claude Code's own log events (otlp-relay.mjs), as counted on the agent span. */
  const api = { requests: 0, errors: 0, retries: 0, durationTotal: 0, durationMax: 0, rejections: 0, dropped: 0 };

  /**
   * One of Claude Code's own log events, when it belongs to this run's agent (its session is
   * this run's `gen_ai.agent.id`): a span event on the agent span, and the agent span's
   * counters. False when the session is not this run's (or not known yet).
   */
  function agentEvent(record) {
    const id = agentSpan?.attributes['gen_ai.agent.id'];
    if (!id || record?.sessionId !== id) return false;
    // Already sent: what comes after the agent span ended has nowhere to go.
    if (agentSpan.ended) return true;
    const a = { ...(record.attributes ?? {}) };
    // An API error's message is the provider's free text, which may quote the request: content.
    // Its status, attempt and duration are kept either way.
    if (typeof a.error === 'string' && captureContent) a.error = clip(redact, a.error);
    else delete a.error;
    const duration = typeof a.duration_ms === 'number' && a.duration_ms >= 0 ? a.duration_ms : 0;
    if (record.name === 'claude_code.api_request' || record.name === 'claude_code.api_error') {
      if (record.name === 'claude_code.api_request') api.requests += 1;
      else api.errors += 1;
      api.durationTotal += duration;
      api.durationMax = Math.max(api.durationMax, duration);
    }
    if (typeof a.attempt === 'number' && a.attempt > 1) api.retries += 1;
    if (record.name === 'claude_code.tool_decision' && a.decision === 'reject') api.rejections += 1;
    if (record.name === 'claude_code.api_refusal') api.refusals = (api.refusals ?? 0) + 1;
    if (record.name === 'claude_code.api_retries_exhausted') api.exhausted = (api.exhausted ?? 0) + 1;
    agentSpan.events ??= [];
    if (agentSpan.events.length < MAX_EVENTS_PER_SPAN) {
      agentSpan.events.push({ at: Number.isFinite(record.time) ? record.time : agentSpan.start, name: String(record.name), attributes: { ...a } });
    } else api.dropped += 1;
    Object.assign(agentSpan.attributes, {
      'updraft.agent.api_requests': api.requests,
      'updraft.agent.api_errors': api.errors,
      'updraft.agent.api_retries': api.retries,
      'updraft.agent.api_duration_ms_total': Math.round(api.durationTotal),
      'updraft.agent.api_duration_ms_max': Math.round(api.durationMax),
      'updraft.agent.tool_rejections': api.rejections,
      'updraft.agent.api_refusals': api.refusals,
      'updraft.agent.api_retries_exhausted': api.exhausted,
      'updraft.agent.events_dropped': api.dropped || undefined,
    });
    return true;
  }

  return {
    header: h,
    summary,
    marks,
    agentEvent,
    get conversationId() {
      return conversationId();
    },
    line(line, at) {
      firstAt ??= at;
      if (phase === 'header') {
        if (line.startsWith('---- ') || line.startsWith('outcome: ')) onWorkerLine(line, at);
        else if (line.startsWith('error: ')) h.startError ??= line.slice(7);
        else {
          // The worker's "ready" block (source clone, base, branch, ...): the worktree is prepared.
          if (line.startsWith('source clone: ')) h.preparedAt = at;
          parseHeaderLine(line, h);
        }
        return;
      }
      if (phase === 'agent' && isJsonLine(line)) {
        const ev = parseJson(line);
        if (!ev || typeof ev.type !== 'string') return;
        if (h.adapter === 'codex' || ev.type.includes('.')) onCodex(ev, at);
        else onClaude(ev, at);
        return;
      }
      onWorkerLine(line, at);
    },
    /** Ends everything still open (the log ended, or the job is over). */
    close(at) {
      if (phase === 'agent') endAgent(at);
      if (!agentSpan) endPrepare(at);
      if (verifyStep) endVerifyStep(at);
      if (verifySpan) finish(verifySpan, at);
      verifySpan = null;
      for (const s of steps.values()) finish(s.span, s.last);
      if (change.files !== undefined || change.commits !== undefined) {
        summary.change = {
          commits: change.commits,
          files: change.files,
          insertions: change.insertions,
          deletions: change.deletions,
          untracked: change.untracked,
          testFiles: change.testFiles,
        };
      }
      if (agentSpan) {
        Object.assign(agentSpan.attributes, {
          'updraft.agent.tool_calls': summary.tools,
          'updraft.agent.tool_errors': summary.toolErrors,
          'updraft.agent.compactions': compactions || undefined,
          ...behavior.attributes(agentSpan.start, agentSpan.end ?? at),
          'gen_ai.usage.input_tokens': summary.inputTokens || undefined,
          'gen_ai.usage.output_tokens': summary.outputTokens || undefined,
          ...(summary.change
            ? {
                'updraft.change.commits': change.commits,
                'updraft.change.files': change.files,
                'updraft.change.insertions': change.insertions,
                'updraft.change.deletions': change.deletions,
                'updraft.change.untracked': change.untracked,
                'updraft.change.paths': change.paths.length ? change.paths : undefined,
                'updraft.change.test_files': change.testFiles,
                'updraft.change.test_lines': change.testLines,
                'updraft.change.source_lines': change.sourceLines,
              }
            : {}),
        });
        summary.thrashing = agentSpan.attributes['updraft.agent.thrashing'] === true;
        finish(agentSpan, agentSpan.end ?? at);
      }
    },
  };
}

/**
 * Tails every run log under `runsDir` while the job runs, and sends the spans it makes. `stop()`
 * reads what is left, ends the job's root span with what the summary says, and sends the rest
 * within `budgetMs`. Never throws.
 */
export function createAgentTracer({ runsDir: givenRunsDir = null, confineTo: givenConfineTo = null, exporter, captureContent = false, redact = (t) => t, now = Date.now, log = () => {}, pollMs = TELEMETRY_POLL_MS, exportMs = EXPORT_INTERVAL_MS, fsImpl = fs, startedAt: jobStartedAt, traceId: givenTraceId }) {
  const traceId = typeof givenTraceId === 'string' && /^[0-9a-f]{32}$/.test(givenTraceId) ? givenTraceId : newTraceId();
  const rootSpanId = newSpanId();
  // The job's start (before the tracer existed: isolation, the state, the coalescing wait), when the runner knows it.
  const startedAt = typeof jobStartedAt === 'number' && jobStartedAt <= now() ? jobStartedAt : now();
  const runs = new Map();
  const stats = { runs: 0, spans: 0, linesSkipped: 0, agentEvents: 0, agentEventsUnmatched: 0 };
  let pollTimer = null;
  let exportTimer = null;
  let polling = Promise.resolve();

  const emit = (span) => {
    stats.spans += 1;
    exporter.push(span);
  };

  // Run logs are written by the job user, and the tracer runs as root and sends what it reads:
  // a file is read only when what was opened is a regular file at exactly
  // <confineTo, resolved>/logs/runs/<run>/<file>, so no link anywhere on the way leads it elsewhere.
  // The anchor is the state directory, resolved once, before the job could change anything under it.
  // The tracer can start before the state directory exists (to time the runner's first steps):
  // `watch()` names the directory then, and nothing is read until it has.
  let runsDir = null;
  let anchor = Promise.resolve(null);
  function watch({ runsDir: dir, confineTo = null }) {
    if (runsDir !== null || typeof dir !== 'string') return;
    runsDir = dir;
    const base = confineTo ?? dir;
    anchor = fsImpl.realpath(base).then(
      (real) => path.join(real, path.relative(base, dir)),
      () => null,
    );
  }
  if (givenRunsDir) watch({ runsDir: givenRunsDir, confineTo: givenConfineTo });
  const expectedRoot = async () => {
    const root = await anchor;
    if (root === null) throw Object.assign(new Error('the state directory cannot be resolved'), { code: 'ENOENT' });
    return root;
  };
  const refused = new Set();

  async function openConfined(name, file) {
    const where = path.join(runsDir, name, file);
    let expected;
    try {
      expected = path.join(await expectedRoot(), name, file);
    } catch {
      return null;
    }
    let handle;
    try {
      handle = await fsImpl.open(where, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (error?.code !== 'ENOENT' && !refused.has(where)) {
        refused.add(where);
        log(`agent telemetry: not reading ${name}/${file} (${error?.code ?? 'error'})`);
      }
      return null;
    }
    try {
      const st = await handle.stat();
      let real;
      try {
        real = await fsImpl.readlink(`/proc/self/fd/${handle.fd}`);
      } catch {
        // No /proc: the path as it resolves now (the final link was refused by O_NOFOLLOW).
        real = await fsImpl.realpath(where);
      }
      if (!st.isFile() || real !== expected) {
        if (!refused.has(where)) {
          refused.add(where);
          log(`agent telemetry: not reading ${name}/${file}: it is not a regular file in the run's log directory`);
        }
        await handle.close();
        return null;
      }
      return { handle, size: st.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async function readRun(name, entry) {
    const opened = await openConfined(name, 'run.log');
    if (!opened) return;
    const { handle, size } = opened;
    try {
      if (size <= entry.offset) return;
      const length = Math.min(size - entry.offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, entry.offset);
      entry.offset += bytesRead;
      entry.partial += entry.decoder.write(buf.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    const at = now();
    let nl;
    while ((nl = entry.partial.indexOf('\n')) !== -1) {
      const line = entry.partial.slice(0, nl).replace(/\r$/, '');
      entry.partial = entry.partial.slice(nl + 1);
      entry.trace.line(line, at);
    }
    if (entry.partial.length > MAX_LINE_CHARS) {
      entry.partial = '';
      stats.linesSkipped += 1;
    }
  }

  async function poll() {
    if (runsDir === null) return;
    let names;
    try {
      names = await fsImpl.readdir(runsDir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) continue;
      let entry = runs.get(name);
      if (!entry) {
        if (runs.size >= MAX_RUNS) continue;
        const dir = path.join(runsDir, name);
        entry = {
          offset: 0,
          partial: '',
          decoder: new StringDecoder('utf8'),
          trace: createRunTrace({
            traceId,
            rootSpanId,
            runDir: dir,
            captureContent,
            redact,
            emit,
            readPrompt: async () => {
              // Capped before it is read, not after.
              const opened = await openConfined(name, 'prompt.md');
              if (!opened) return null;
              try {
                const buf = Buffer.alloc(Math.min(opened.size, MAX_PROMPT_BYTES));
                const { bytesRead } = await opened.handle.read(buf, 0, buf.length, 0);
                return new StringDecoder('utf8').end(buf.subarray(0, bytesRead));
              } finally {
                await opened.handle.close();
              }
            },
          }),
        };
        runs.set(name, entry);
        stats.runs += 1;
      }
      try {
        await readRun(name, entry);
      } catch (error) {
        log(`agent telemetry: could not read ${name}/run.log: ${error?.code ?? error?.name ?? 'error'}`);
      }
    }
  }

  // Claude Code's own log events (otlp-relay.mjs). One can arrive before the run log line that
  // says whose session it is has been read; it waits here for the next look at the logs.
  const unmatched = [];
  const placeEvent = (record) => [...runs.values()].some((r) => r.trace.agentEvent(record));
  const placeUnmatched = () => {
    if (!unmatched.length) return;
    const waiting = unmatched.splice(0);
    for (const record of waiting) if (!placeEvent(record)) unmatched.push(record);
  };

  const schedulePoll = () => {
    polling = polling.then(poll).then(placeUnmatched).catch(() => {});
    return polling;
  };

  return {
    traceId,
    rootSpanId,
    stats,
    /** One look at the logs now (the timer does this every pollMs). */
    poll: schedulePoll,
    /** Names the run log directory, when the tracer started before it existed. */
    watch,
    /**
     * One of Claude Code's own log events ({ name, time, sessionId, attributes }, from the
     * relay): a span event and counters on the agent span whose `gen_ai.agent.id` is its
     * session. Never throws.
     */
    agentEvent(record) {
      try {
        if (!record || typeof record.name !== 'string' || typeof record.sessionId !== 'string') return;
        stats.agentEvents += 1;
        if (placeEvent(record)) return;
        unmatched.push(record);
        if (unmatched.length > MAX_UNMATCHED_EVENTS) {
          unmatched.shift();
          stats.agentEventsUnmatched += 1;
        }
      } catch (error) {
        log(`agent telemetry: ${error?.message ?? error}`);
      }
    },
    start() {
      pollTimer = setInterval(schedulePoll, pollMs);
      pollTimer.unref?.();
      exportTimer = setInterval(() => void exporter.flush(), exportMs);
      exportTimer.unref?.();
    },
    /**
     * `outcome`: the job's (succeeded, failed, ...); `summary`: run-event's JSON summary, if any;
     * `steps`: the runner's own steps ({ name, start, end, error?, attributes? }), each a span
     * under the job's.
     */
    async stop({ outcome, summary, deliveryId, eventName, budgetMs = 15_000, steps = [] } = {}) {
      clearInterval(pollTimer);
      clearInterval(exportTimer);
      /** The runner's own failed steps, as marks (each run's are in its trace's). */
      const runnerMarks = [];
      /** The conversation the job's span was sent in, for the finish report. */
      let sentConversationId;
      try {
        await schedulePoll();
        const at = now();
        const traces = [...runs.values()].map((r) => r.trace);
        for (const t of traces) t.close(at);
        const runnerSteps = Array.isArray(steps) ? steps.filter((step) => step && typeof step.name === 'string' && typeof step.start === 'number').slice(0, 64) : [];
        // A job that ran no agent (it failed in the runner, or its event had nothing to run)
        // still has its runner steps: sent under the job's span, in a conversation of the delivery.
        if (traces.length || runnerSteps.length) {
          const conversationId = traces.find((t) => t.header.issue !== undefined)?.conversationId ?? traces[0]?.conversationId ?? `delivery/${typeof deliveryId === 'string' && deliveryId ? deliveryId : traceId}`;
          sentConversationId = conversationId;
          const loop = summary?.loop && typeof summary.loop === 'object' ? summary.loop : null;
          const failed = outcome !== 'succeeded';
          for (const step of runnerSteps) {
            const spanId = newSpanId();
            if (step.error) runnerMarks.push({ kind: 'step_failed', spanId, at: step.start, end: typeof step.end === 'number' ? step.end : at, step: `runner_${step.name}` });
            emit({
              traceId,
              spanId,
              parentSpanId: rootSpanId,
              name: `runner ${step.name}`,
              kind: KIND_INTERNAL,
              start: step.start,
              end: typeof step.end === 'number' ? step.end : at,
              error: Boolean(step.error),
              ...(step.error && typeof step.error === 'string' ? { errorMessage: step.error.slice(0, MAX_MESSAGE_CHARS) } : {}),
              attributes: { 'gen_ai.agent.name': 'updraft', 'gen_ai.conversation.id': conversationId, 'updraft.step': step.name, ...(step.error ? { 'error.type': 'runner_step' } : {}), ...(step.attributes ?? {}) },
            });
          }
          // The job in one wide event: what every run cost, changed and decided.
          const runSummaries = traces.map((t) => t.summary);
          const sum = (f) => runSummaries.reduce((n, r) => n + (f(r) ?? 0), 0);
          const lastReview = [...runSummaries].reverse().find((r) => r.review)?.review ?? null;
          const lastChange = [...runSummaries].reverse().find((r) => r.change)?.change ?? null;
          const costs = runSummaries.filter((r) => typeof r.costUsd === 'number');
          emit({
            traceId,
            spanId: rootSpanId,
            name: 'invoke_workflow updraft',
            kind: KIND_INTERNAL,
            start: startedAt,
            end: at,
            error: failed,
            attributes: {
              'gen_ai.operation.name': 'invoke_workflow',
              'gen_ai.agent.name': 'updraft',
              'gen_ai.conversation.id': conversationId,
              'updraft.delivery.id': deliveryId,
              'updraft.event.name': eventName,
              'updraft.job.outcome': outcome,
              'updraft.outcome': typeof summary?.outcome === 'string' ? summary.outcome : undefined,
              'updraft.repository': traces[0]?.header.repository,
              'updraft.issue': traces[0]?.header.issue,
              'updraft.pull_request': typeof summary?.prNumber === 'number' ? summary.prNumber : undefined,
              'updraft.pull_request.url': typeof summary?.prUrl === 'string' ? summary.prUrl : undefined,
              'updraft.loop.stage': typeof loop?.stage === 'string' ? loop.stage : undefined,
              'updraft.loop.rounds': typeof loop?.rounds === 'number' ? loop.rounds : undefined,
              'updraft.loop.reviews': typeof loop?.reviews === 'number' ? loop.reviews : undefined,
              'updraft.loop.merged': typeof loop?.merged === 'boolean' ? loop.merged : undefined,
              'updraft.runs': traces.length,
              'updraft.runs.kinds': [...new Set(runSummaries.map((r) => r.kind).filter(Boolean))],
              'updraft.runs.failed': runSummaries.filter((r) => r.outcome && r.outcome !== 'succeeded').length,
              'updraft.agent.thrashing': runSummaries.some((r) => r.thrashing),
              'gen_ai.usage.input_tokens': sum((r) => r.inputTokens) || undefined,
              'gen_ai.usage.output_tokens': sum((r) => r.outputTokens) || undefined,
              'updraft.agent.reported_cost_usd': costs.length ? costs.reduce((n, r) => n + r.costUsd, 0) : undefined,
              'updraft.agent.tool_calls': sum((r) => r.tools),
              'updraft.agent.tool_errors': sum((r) => r.toolErrors),
              'updraft.review.verdict': lastReview?.verdict,
              'updraft.review.findings': lastReview?.findings,
              'updraft.review.outcome': lastReview?.outcome,
              'updraft.change.commits': lastChange?.commits,
              'updraft.change.files': lastChange?.files,
              'updraft.change.insertions': lastChange?.insertions,
              'updraft.change.deletions': lastChange?.deletions,
              'updraft.change.test_files': lastChange?.testFiles,
              ...(failed ? { 'error.type': outcome ?? 'unknown' } : {}),
            },
          });
        }
        await Promise.race([exporter.flush(), new Promise((r) => setTimeout(r, budgetMs).unref?.())]);
      } catch (error) {
        log(`agent telemetry: ${error?.message ?? error}`);
      }
      const conversations = [...new Set([...runs.values()].map((r) => r.trace.conversationId))];
      // The conversation the job's span went in: the issue's, else the run's or the delivery's.
      const conversationId = sentConversationId;
      // Only spans Honeycomb accepted: a link to one it never got would open the root instead.
      let marks = [];
      try {
        marks = [...[...runs.values()].flatMap((r) => r.trace.marks), ...runnerMarks]
          .filter((m) => exporter.accepted(m.spanId))
          .sort((x, y) => x.at - y.at)
          .slice(0, MAX_MARKS_PER_JOB)
          // When, from the job's start, and for how long: the console's own timeline of the job.
          .map(({ at: start, end, ...m }) => ({ ...m, offsetMs: Math.max(0, Math.round(start - startedAt)), durationMs: Math.max(0, Math.round((end ?? start) - start)) }));
      } catch (error) {
        log(`agent telemetry: ${error?.message ?? error}`);
      }
      // The job's totals, for the console without any destination: what every run cost and did.
      const runSummaries = [...runs.values()].map((r) => r.trace.summary);
      const costs = runSummaries.filter((r) => typeof r.costUsd === 'number');
      const totals = {
        runs: runSummaries.length,
        inputTokens: runSummaries.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
        outputTokens: runSummaries.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
        ...(costs.length ? { costUsd: Math.round(costs.reduce((n, r) => n + r.costUsd, 0) * 10_000) / 10_000 } : {}),
        toolCalls: runSummaries.reduce((n, r) => n + (r.tools ?? 0), 0),
        toolErrors: runSummaries.reduce((n, r) => n + (r.toolErrors ?? 0), 0),
        thrashing: runSummaries.some((r) => r.thrashing),
        durationMs: Math.max(0, Math.round(now() - startedAt)),
      };
      return {
        traceId,
        // Read for the console only, sent nowhere (createLocalExporter): no link can open it.
        ...(exporter.local ? { local: true } : {}),
        totals,
        ...(conversationId ? { conversationId } : {}),
        conversationIds: conversations,
        marks,
        runs: [...runs.values()].map((r) => r.trace.summary),
        spans: stats.spans,
        exported: exporter.stats.exported,
        failed: exporter.stats.failed + exporter.stats.dropped + exporter.pending(),
        lastError: exporter.stats.lastError,
        startedAt: new Date(startedAt).toISOString(),
      };
    },
  };
}
