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
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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
const MAX_SPANS_PER_RUN = 20000;

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
    status: s.error ? { code: STATUS_ERROR, ...(s.errorMessage ? { message: s.errorMessage } : {}) } : { code: STATUS_OK },
  };
}

/** An OTLP/HTTP export request body for these spans. */
export function otlpRequest(spans, resource) {
  return { resourceSpans: [{ resource: { attributes: attributes(resource) }, scopeSpans: [{ scope: SCOPE, spans: spans.map(toOtlpSpan) }] }] };
}

/**
 * Sends finished spans in batches (OTLP/HTTP, JSON encoding) to `<endpoint>/v1/traces` with the
 * `x-honeycomb-team` header. Never throws: a failure is counted and logged, and the job goes on.
 */
export function createExporter({ endpoint, apiKey, resource, fetch: fetchImpl = globalThis.fetch, log = () => {}, timeoutMs = 10_000, now = Date.now }) {
  const queue = [];
  const stats = { exported: 0, failed: 0, dropped: 0, requests: 0, lastError: null, lastOkAt: null };
  let sending = Promise.resolve();
  const url = `${endpoint.replace(/\/+$/, '')}/v1/traces`;

  async function post(batch) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        stats.requests += 1;
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-honeycomb-team': apiKey },
          body: JSON.stringify(otlpRequest(batch, resource)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          stats.exported += batch.length;
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
      queue.push(span);
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
  else if ((m = /^job: (\S+)/.exec(line))) h.jobId = m[1];
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
}

const isJsonLine = (line) => line.startsWith('{') && line.endsWith('}');
function parseJson(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
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
  const summary = { runId: null, kind: null, agent: null, chats: 0, tools: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, outcome: null };

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
    if (spans++ < MAX_SPANS_PER_RUN) emit(span);
  }

  function startAgent(at) {
    agentSpan = {
      traceId,
      spanId: newSpanId(),
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
      },
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
      if (agentSpan) {
        Object.assign(agentSpan.attributes, { 'gen_ai.agent.id': typeof ev.session_id === 'string' ? ev.session_id : undefined });
        if (!h.model && typeof ev.model === 'string') agentSpan.attributes['gen_ai.request.model'] = ev.model;
      }
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
            },
          };
          tools.set(block.id, { span, input: block.input && typeof block.input === 'object' ? block.input : {} });
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
        if (block.is_error === true) {
          tool.span.error = true;
          tool.span.attributes['error.type'] = 'tool_error';
          summary.toolErrors += 1;
        } else tool.span.attributes['gen_ai.tool.call.result'] = content(text);
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
        Object.assign(agentSpan.attributes, {
          'updraft.agent.turns': typeof ev.num_turns === 'number' ? ev.num_turns : undefined,
          'updraft.agent.reported_cost_usd': typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        });
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
    if (ev.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') turn?.parts.push({ type: 'text', content: item.text });
    if (ev.type === 'item.completed' && item.type === 'reasoning' && typeof item.text === 'string') turn?.parts.push({ type: 'reasoning', content: item.text });
    const kind = codexTool(item);
    if (!kind) return;
    let open = tools.get(item.id);
    if (!open) {
      if (turn) turn.toolCalls += 1;
      turn?.parts.push({ type: 'tool_call', id: item.id, name: kind.name, arguments: kind.args });
      open = {
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
    if (result !== undefined && !failed) open.span.attributes['gen_ai.tool.call.result'] = content(result);
    finish(open.span, at);
  }

  // ---- The worker's own lines ----------------------------------------------------------------

  function onWorkerLine(line, at) {
    let m;
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
      };
    } else if ((m = /^exit: (code (-?\d+)|signal (\S+)) after (\d+)s/.exec(line)) && verifyStep) {
      const code = m[2] !== undefined ? Number(m[2]) : null;
      verifyStep.attributes['updraft.tool.exit_code'] = code ?? undefined;
      if (code !== 0) {
        verifyStep.error = true;
        verifyStep.attributes['error.type'] = code === null ? `signal_${m[3]}` : 'exit_code';
      }
      finish(verifyStep, at);
      verifyStep = null;
    } else if ((m = /^---- end of verification: (\w+) ----$/.exec(line))) {
      if (verifyStep) finish(verifyStep, at);
      verifyStep = null;
      if (verifySpan) {
        if (m[1] !== 'passed') {
          verifySpan.error = true;
          verifySpan.attributes['error.type'] = `verify_${m[1]}`;
        }
        verifySpan.attributes['updraft.verify.result'] = m[1];
        finish(verifySpan, at);
        verifySpan = null;
      }
    } else if ((m = /^outcome: (\S+)/.exec(line))) {
      summary.outcome = m[1];
      if (agentSpan) {
        agentSpan.attributes['updraft.run.outcome'] = m[1];
        if (m[1] !== 'succeeded') {
          agentSpan.error = true;
          agentSpan.attributes['error.type'] ??= m[1];
        }
      }
    }
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

  return {
    header: h,
    summary,
    get conversationId() {
      return conversationId();
    },
    line(line, at) {
      if (phase === 'header') {
        if (line.startsWith('---- ')) onWorkerLine(line, at);
        else parseHeaderLine(line, h);
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
      if (verifyStep) finish(verifyStep, at);
      if (verifySpan) finish(verifySpan, at);
      verifyStep = verifySpan = null;
      if (agentSpan) {
        Object.assign(agentSpan.attributes, {
          'updraft.agent.tool_calls': summary.tools,
          'updraft.agent.tool_errors': summary.toolErrors,
          'gen_ai.usage.input_tokens': summary.inputTokens || undefined,
          'gen_ai.usage.output_tokens': summary.outputTokens || undefined,
        });
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
export function createAgentTracer({ runsDir, exporter, captureContent = false, redact = (t) => t, now = Date.now, log = () => {}, pollMs = TELEMETRY_POLL_MS, exportMs = EXPORT_INTERVAL_MS, fsImpl = fs }) {
  const traceId = newTraceId();
  const rootSpanId = newSpanId();
  const startedAt = now();
  const runs = new Map();
  const stats = { runs: 0, spans: 0, linesSkipped: 0 };
  let pollTimer = null;
  let exportTimer = null;
  let polling = Promise.resolve();

  const emit = (span) => {
    stats.spans += 1;
    exporter.push(span);
  };

  async function readRun(dir, entry) {
    const file = path.join(dir, 'run.log');
    let st;
    try {
      st = await fsImpl.stat(file);
    } catch {
      return;
    }
    if (!st.isFile() || st.size <= entry.offset) return;
    const length = Math.min(st.size - entry.offset, MAX_READ_BYTES);
    const handle = await fsImpl.open(file, 'r');
    try {
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
              const text = await fsImpl.readFile(path.join(dir, 'prompt.md'), 'utf8');
              return text.length > 256 * 1024 ? text.slice(0, 256 * 1024) : text;
            },
          }),
        };
        runs.set(name, entry);
        stats.runs += 1;
      }
      try {
        await readRun(path.join(runsDir, name), entry);
      } catch (error) {
        log(`agent telemetry: could not read ${name}/run.log: ${error?.code ?? error?.name ?? 'error'}`);
      }
    }
  }

  const schedulePoll = () => {
    polling = polling.then(poll).catch(() => {});
    return polling;
  };

  return {
    traceId,
    rootSpanId,
    stats,
    /** One look at the logs now (the timer does this every pollMs). */
    poll: schedulePoll,
    start() {
      pollTimer = setInterval(schedulePoll, pollMs);
      pollTimer.unref?.();
      exportTimer = setInterval(() => void exporter.flush(), exportMs);
      exportTimer.unref?.();
    },
    /** `outcome`: the job's (succeeded, failed, ...); `summary`: run-event's JSON summary, if any. */
    async stop({ outcome, summary, deliveryId, eventName, budgetMs = 15_000 } = {}) {
      clearInterval(pollTimer);
      clearInterval(exportTimer);
      try {
        await schedulePoll();
        const at = now();
        const traces = [...runs.values()].map((r) => r.trace);
        for (const t of traces) t.close(at);
        if (traces.length) {
          const conversationId = traces.find((t) => t.header.issue !== undefined)?.conversationId ?? traces[0].conversationId;
          const loop = summary?.loop && typeof summary.loop === 'object' ? summary.loop : null;
          const failed = outcome !== 'succeeded';
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
              'updraft.repository': traces[0].header.repository,
              'updraft.issue': traces[0].header.issue,
              'updraft.pull_request': typeof summary?.prNumber === 'number' ? summary.prNumber : undefined,
              'updraft.pull_request.url': typeof summary?.prUrl === 'string' ? summary.prUrl : undefined,
              'updraft.loop.stage': typeof loop?.stage === 'string' ? loop.stage : undefined,
              'updraft.loop.rounds': typeof loop?.rounds === 'number' ? loop.rounds : undefined,
              'updraft.loop.reviews': typeof loop?.reviews === 'number' ? loop.reviews : undefined,
              'updraft.loop.merged': typeof loop?.merged === 'boolean' ? loop.merged : undefined,
              'updraft.runs': traces.length,
              ...(failed ? { 'error.type': outcome ?? 'unknown' } : {}),
            },
          });
        }
        await Promise.race([exporter.flush(), new Promise((r) => setTimeout(r, budgetMs).unref?.())]);
      } catch (error) {
        log(`agent telemetry: ${error?.message ?? error}`);
      }
      const conversations = [...new Set([...runs.values()].map((r) => r.trace.conversationId))];
      return {
        traceId,
        conversationIds: conversations,
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
