import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as claude from '../../../test/claude-stream.ts';
import * as codex from '../../../test/codex-stream.ts';
import { createRedactor } from '../image/runner/redact.mjs';
import { MAX_ATTRIBUTE_CHARS, createAgentTracer, createExporter, otlpRequest, parseHeaderLine, toOtlpSpan } from '../image/runner/telemetry.mjs';

/** The header the worker writes at the top of run.log (src/worker/live.ts). */
function header({ runId = 'run_1', kind = 'implement', agent = 'claude-opus', adapter = 'claude', model = 'claude-opus-4-1' } = {}) {
  return [
    `updraft run ${runId}`,
    'written: 2026-11-21T10:00:00.000Z',
    'mode: live. The routed agent runs in the job worktree.',
    '',
    'job: job_ev9001 (attempt 1)',
    'repository: octo/widgets (id 42)',
    'issue: #7 Add a dark mode toggle',
    'issue url: https://github.com/octo/widgets/issues/7',
    'workflow: wf',
    ...(kind === 'review'
      ? ['trigger: pull_request.review of head abc', 'pull request: #100 https://github.com/octo/widgets/pull/100', 'code written by agent: claude-opus; this run reviews it and publishes nothing']
      : kind === 'revision'
        ? ['trigger: pull_request.changes_requested (updraft_review) by updraft at x', 'pull request: #100 https://github.com/octo/widgets/pull/100', 'review: https://example.invalid/r (2 inline comment(s), as read when it was ingested)']
        : ['trigger: issue.labeled label "updraft:ready" by allen at x']),
    '',
    'pool: deep',
    `agent: ${agent} (adapter ${adapter})`,
    `profile: ${agent} (adapter ${adapter}); model "${model}" (config); effort "high" (config); as configured, not necessarily what the CLI resolved`,
    'action: implement-issue (output pull-request, timeout 30 min)',
    '',
    '---- agent output (stdout and stderr) ----',
  ].join('\n');
}

function setup({ captureContent = false, keys = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-telemetry-'));
  const runsDir = path.join(dir, 'logs', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const clock = { t: Date.parse('2026-11-21T10:00:00.000Z') };
  const sent = [];
  const exporter = {
    spans: [],
    stats: { exported: 0, failed: 0, dropped: 0, lastError: null },
    push(s) {
      this.spans.push(s);
    },
    async flush() {
      this.stats.exported = this.spans.length;
    },
    pending: () => 0,
  };
  const tracer = createAgentTracer({ runsDir, exporter, captureContent, redact: createRedactor(keys), now: () => clock.t, pollMs: 1e9, exportMs: 1e9 });
  const write = (run, text) => {
    fs.mkdirSync(path.join(runsDir, run), { recursive: true });
    fs.appendFileSync(path.join(runsDir, run, 'run.log'), text);
  };
  /** Writes, lets time pass, and has the tracer look. */
  const step = async (run, text, ms = 1000) => {
    write(run, text);
    clock.t += ms;
    await tracer.poll();
  };
  return { dir, runsDir, clock, tracer, exporter, sent, write, step };
}

const byName = (spans, name) => spans.filter((s) => s.name === name);
const one = (spans, name) => {
  const found = byName(spans, name);
  expect(found, name).toHaveLength(1);
  return found[0];
};

describe('agent telemetry: Claude Code', () => {
  it('turns a run log into invoke_workflow, invoke_agent, chat and execute_tool spans with real timing and token usage', async () => {
    const t = setup();
    await t.step('run_1', `${header()}\n`, 0);
    await t.step('run_1', claude.stream(claude.init()), 500);
    await t.step('run_1', claude.stream(claude.assistantToolUse('toolu_1', 'npm test')), 4000);
    await t.step('run_1', claude.stream(claude.toolResult('toolu_1', '12 passing')), 9000);
    await t.step('run_1', claude.stream(claude.assistantText('All tests pass.')), 3000);
    await t.step('run_1', claude.stream(claude.success('Done: added the toggle.')), 100);
    await t.step('run_1', ['---- end of agent output ----', 'exit: code 0 after 17s', ''].join('\n'), 100);
    await t.step(
      'run_1',
      ['', '---- verification (run by the worker: 1 command(s), 10 min in total) ----', '---- verify 1/1: npm test ----', 'command: ["npm","test"]', 'exit: code 0 after 6s', '---- end of verification: passed ----', 'outcome: succeeded', ''].join('\n'),
      6000,
    );
    const out = await t.tracer.stop({ outcome: 'succeeded', summary: { outcome: 'succeeded', prNumber: 100, prUrl: 'https://github.com/octo/widgets/pull/100', loop: { stage: 'awaiting-review', rounds: 0, reviews: 0, merged: false } }, deliveryId: 'd-1', eventName: 'issues' });
    const spans = t.exporter.spans;

    const root = one(spans, 'invoke_workflow updraft');
    const agent = one(spans, 'invoke_agent claude-opus');
    const tool = one(spans, 'execute_tool Bash');
    const chats = byName(spans, 'chat claude-sonnet-4-5');
    expect(chats).toHaveLength(2);

    // One trace, one conversation per issue, every span in it.
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([out.traceId]));
    for (const s of spans) expect(s.attributes['gen_ai.conversation.id'], s.name).toBe('octo/widgets#7');
    expect(out.conversationIds).toEqual(['octo/widgets#7']);

    expect(root.parentSpanId).toBeUndefined();
    expect(root).toMatchObject({ attributes: { 'gen_ai.operation.name': 'invoke_workflow', 'gen_ai.agent.name': 'updraft', 'updraft.pull_request': 100, 'updraft.loop.stage': 'awaiting-review' } });
    expect(agent).toMatchObject({
      parentSpanId: root.spanId,
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'claude-opus',
        'gen_ai.agent.id': claude.SESSION,
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.request.model': 'claude-opus-4-1',
        'updraft.job.kind': 'implement',
        'updraft.run.outcome': 'succeeded',
        'updraft.agent.tool_calls': 1,
      },
    });
    expect(agent.error).toBeFalsy();

    // The first model response asked for the tool; it started when the agent did.
    const [first, second] = chats;
    expect(first.parentSpanId).toBe(agent.spanId);
    expect(first.kind).toBe(3);
    expect(first.end - first.start).toBe(4500);
    expect(first.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.response.model': 'claude-sonnet-4-5',
      // Anthropic's input count excludes cache reads; the conventions' includes them.
      'gen_ai.usage.input_tokens': 2000,
      'gen_ai.usage.cache_read.input_tokens': 800,
      'gen_ai.usage.output_tokens': 340,
      'gen_ai.response.finish_reasons': ['tool_call'],
    });
    // The tool ran from its call to its result.
    expect(tool).toMatchObject({ parentSpanId: agent.spanId, attributes: { 'gen_ai.tool.name': 'Bash', 'gen_ai.tool.call.id': 'toolu_1', 'gen_ai.tool.type': 'function' } });
    expect(tool.end - tool.start).toBe(9000);
    // The second response started when the tool's result came back.
    expect(second.start).toBe(tool.end);
    expect(second.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);

    // Verification is Updraft's own step, on the "updraft" lane.
    const verify = one(spans, 'execute_tool verify');
    expect(verify).toMatchObject({ attributes: { 'gen_ai.agent.name': 'updraft', 'updraft.verify.command': 'npm test', 'updraft.tool.exit_code': 0 } });
    expect(one(spans, 'invoke_workflow verify').attributes['updraft.verify.result']).toBe('passed');

    // Content is not recorded unless asked for.
    for (const s of spans) {
      for (const k of ['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result']) expect(s.attributes[k], `${s.name} ${k}`).toBeUndefined();
    }
    expect(out).toMatchObject({ spans: spans.length, exported: spans.length, failed: 0 });
    expect(out.runs).toEqual([expect.objectContaining({ runId: 'run_1', kind: 'implement', agent: 'claude-opus', chats: 2, tools: 1, inputTokens: 4000, outputTokens: 680 })]);
  });

  it('records content when asked, redacted and cut to size', async () => {
    const key = 'sk-ant-api03-THISISASECRETVALUE0123456789';
    const t = setup({ captureContent: true, keys: [key] });
    fs.mkdirSync(path.join(t.runsDir, 'run_1'), { recursive: true });
    fs.writeFileSync(path.join(t.runsDir, 'run_1', 'prompt.md'), 'Implement issue #7.');
    await t.step('run_1', `${header()}\n`, 0);
    await t.step('run_1', claude.stream(claude.assistantToolUse('toolu_1', `echo ${key}`)), 1000);
    await t.step('run_1', claude.stream(claude.toolResult('toolu_1', 'x'.repeat(MAX_ATTRIBUTE_CHARS + 50))), 1000);
    await t.step('run_1', claude.stream(claude.assistantText('done'), claude.success('Added it.')), 1000);
    await t.step('run_1', '---- end of agent output ----\noutcome: succeeded\n', 10);
    await t.tracer.stop({ outcome: 'succeeded' });
    const spans = t.exporter.spans;
    const tool = one(spans, 'execute_tool Bash');
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('{"command":"echo [redacted]"}');
    expect(tool.attributes['gen_ai.tool.call.result']).toMatch(/… \[50 more characters\]$/);
    const agent = one(spans, 'invoke_agent claude-opus');
    expect(JSON.parse(agent.attributes['gen_ai.input.messages'])).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'Implement issue #7.' }] }]);
    expect(JSON.parse(agent.attributes['gen_ai.output.messages'])[0].parts[0].content).toBe('Added it.');
    const [, second] = byName(spans, 'chat claude-sonnet-4-5');
    expect(JSON.parse(second.attributes['gen_ai.input.messages'])[0]).toMatchObject({ role: 'tool', parts: [{ type: 'tool_call_response', id: 'toolu_1' }] });
    expect(JSON.parse(second.attributes['gen_ai.output.messages'])).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'done' }], finish_reason: 'stop' }]);
    expect(JSON.stringify(spans)).not.toContain(key);
  });

  it('gives a subagent its own invoke_agent span and name, under the tool call that started it', async () => {
    const t = setup();
    const task = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg_task', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { subagent_type: 'Explore', description: 'find the theme code', prompt: 'look' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
    };
    await t.step('run_1', `${header()}\n`, 0);
    await t.step('run_1', claude.stream(task), 1000);
    await t.step('run_1', claude.stream(claude.assistantText('found it in theme.ts', 'toolu_task')), 2000);
    await t.step('run_1', claude.stream({ ...claude.toolResult('toolu_task', 'theme.ts') }), 500);
    await t.step('run_1', '---- end of agent output ----\noutcome: succeeded\n', 10);
    await t.tracer.stop({ outcome: 'succeeded' });
    const spans = t.exporter.spans;
    const tool = one(spans, 'execute_tool Task');
    const sub = one(spans, 'invoke_agent claude-opus/Explore');
    expect(sub.parentSpanId).toBe(tool.spanId);
    expect(sub.attributes['gen_ai.agent.name']).toBe('claude-opus/Explore');
    const subChat = spans.find((s) => s.name.startsWith('chat') && s.parentSpanId === sub.spanId);
    expect(subChat.attributes['gen_ai.agent.name']).toBe('claude-opus/Explore');
  });

  it('marks failures: a tool error, a failed run, a failed verify command', async () => {
    const t = setup();
    const err = claude.toolResult('toolu_1', 'command not found');
    err.message.content[0].is_error = true;
    await t.step('run_1', `${header()}\n`, 0);
    await t.step('run_1', claude.stream(claude.assistantToolUse('toolu_1', 'nmp test'), err, claude.errorResult('error_max_turns')), 1000);
    await t.step('run_1', '---- end of agent output ----\n---- verification (x) ----\n---- verify 1/1: npm test ----\nexit: code 1 after 3s\n---- end of verification: failed ----\noutcome: failed\n', 1000);
    await t.tracer.stop({ outcome: 'failed' });
    const spans = t.exporter.spans;
    expect(one(spans, 'execute_tool Bash')).toMatchObject({ error: true, attributes: { 'error.type': 'tool_error' } });
    expect(one(spans, 'invoke_agent claude-opus')).toMatchObject({ error: true, attributes: { 'error.type': 'error_max_turns' } });
    expect(one(spans, 'execute_tool verify')).toMatchObject({ error: true, attributes: { 'error.type': 'exit_code', 'updraft.tool.exit_code': 1 } });
    expect(one(spans, 'invoke_workflow updraft')).toMatchObject({ error: true, attributes: { 'error.type': 'failed' } });
  });
});

describe('agent telemetry: Codex and the review loop', () => {
  it('reads codex exec --json, and puts the review and the revision in the same conversation', async () => {
    const t = setup();
    await t.step('run_1', `${header()}\n${claude.stream(claude.assistantText('done'), claude.success('ok'))}---- end of agent output ----\noutcome: succeeded\n`, 2000);
    const run2 = header({ runId: 'run_2', kind: 'review', agent: 'codex', adapter: 'codex', model: 'gpt-5-codex' });
    await t.step('run_2', `${run2}\n`, 0);
    await t.step('run_2', codex.stream(codex.threadStarted(), codex.turnStarted()), 100);
    await t.step('run_2', codex.stream({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'git diff', status: 'in_progress' } }), 1500);
    await t.step('run_2', codex.stream(codex.command('item_1', 'git diff', 'diff --git ...')), 2500);
    await t.step('run_2', codex.stream(codex.agentMessage('item_2', 'UPDRAFT-VERDICT: changes-requested'), codex.turnCompleted()), 4000);
    await t.step('run_2', '---- end of agent output ----\noutcome: succeeded\n', 10);
    await t.step('run_3', `${header({ runId: 'run_3', kind: 'revision' })}\n${claude.stream(claude.assistantText('fixed'))}---- end of agent output ----\noutcome: succeeded\n`, 3000);
    const out = await t.tracer.stop({ outcome: 'succeeded' });
    const spans = t.exporter.spans;

    const review = one(spans, 'invoke_agent codex');
    expect(review.attributes).toMatchObject({ 'gen_ai.provider.name': 'openai', 'updraft.job.kind': 'review', 'gen_ai.agent.id': codex.THREAD, 'updraft.pull_request': 100 });
    const turn = one(spans, 'chat gpt-5-codex');
    expect(turn.parentSpanId).toBe(review.spanId);
    // OpenAI's input count already includes the cached tokens.
    expect(turn.attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 24763, 'gen_ai.usage.cache_read.input_tokens': 24448, 'gen_ai.usage.output_tokens': 122, 'gen_ai.response.finish_reasons': ['tool_call'] });
    const shell = one(spans, 'execute_tool shell');
    expect(shell.end - shell.start).toBe(2500);
    expect(shell.attributes['updraft.tool.exit_code']).toBe(0);

    const agents = byName(spans, 'invoke_agent claude-opus');
    expect(agents.map((a) => a.attributes['updraft.job.kind']).sort()).toEqual(['implement', 'revision']);
    expect(out.conversationIds).toEqual(['octo/widgets#7']);
    expect(out.runs.map((r) => r.kind)).toEqual(['implement', 'review', 'revision']);
  });

  it('times a line by when it was written, across polls, and ignores what is not a run', async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.runsDir, '..weird name'), { recursive: true });
    await t.step('run_1', `${header()}\n`, 0);
    // Half a line now, the rest later: it is read whole, and timed when complete.
    const line = JSON.stringify(claude.assistantText('hi'));
    await t.step('run_1', line.slice(0, 20), 1000);
    await t.step('run_1', `${line.slice(20)}\n`, 1000);
    await t.step('run_1', '---- end of agent output ----\n', 1000);
    await t.tracer.stop({ outcome: 'succeeded' });
    const chat = t.exporter.spans.find((s) => s.name.startsWith('chat'));
    expect(chat.end - chat.start).toBe(2000);
    expect(t.tracer.stats.runs).toBe(1);
  });

  it('sends nothing for a job that ran no agent', async () => {
    const t = setup();
    const out = await t.tracer.stop({ outcome: 'succeeded' });
    expect(t.exporter.spans).toEqual([]);
    expect(out.spans).toBe(0);
  });
});

describe('the header', () => {
  it('reads the agent, adapter, model and kind', () => {
    const h = { kind: 'implement' };
    for (const line of header({ kind: 'review', agent: 'codex', adapter: 'codex', model: 'gpt-5' }).split('\n')) parseHeaderLine(line, h);
    expect(h).toMatchObject({ runId: 'run_1', jobId: 'job_ev9001', repository: 'octo/widgets', issue: 7, agent: 'codex', adapter: 'codex', model: 'gpt-5', effort: 'high', kind: 'review', pullRequest: 100 });
  });
});

describe('the OTLP exporter', () => {
  const span = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'chat x', kind: 3, start: 1000, end: 2500, attributes: { 'gen_ai.usage.input_tokens': 12, 'gen_ai.response.finish_reasons': ['stop'], skip: undefined, ok: true, ratio: 0.5 } };

  it('writes OTLP/JSON: hex ids, nanosecond strings, typed attributes', () => {
    expect(toOtlpSpan(span)).toEqual({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'chat x',
      kind: 3,
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '2500000000',
      attributes: [
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '12' } },
        { key: 'gen_ai.response.finish_reasons', value: { arrayValue: { values: [{ stringValue: 'stop' }] } } },
        { key: 'ok', value: { boolValue: true } },
        { key: 'ratio', value: { doubleValue: 0.5 } },
      ],
      status: { code: 1 },
    });
    expect(otlpRequest([span], { 'service.name': 'updraft' }).resourceSpans[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'updraft' } }]);
  });

  it('posts to /v1/traces with the Honeycomb header, retries a 5xx, and gives up on a 401 without throwing', async () => {
    const calls = [];
    const answers = [503, 200, 401];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: answers[0] === 200, status: answers.shift() };
    };
    const exporter = createExporter({ endpoint: 'https://api.honeycomb.io/', apiKey: 'hcaik_key', resource: { 'service.name': 'updraft' }, fetch });
    exporter.push(span);
    await exporter.flush();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api.honeycomb.io/v1/traces');
    expect(calls[0].init.headers).toMatchObject({ 'content-type': 'application/json', 'x-honeycomb-team': 'hcaik_key' });
    expect(JSON.parse(calls[0].init.body).resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    expect(exporter.stats).toMatchObject({ exported: 1, failed: 0 });
    exporter.push(span);
    await exporter.flush();
    expect(calls).toHaveLength(3);
    expect(exporter.stats).toMatchObject({ exported: 1, failed: 1, lastError: 'HTTP 401' });
  });
});
