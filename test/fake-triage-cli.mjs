#!/usr/bin/env node
// Test-only stand-in for the Claude Code, Codex and Kiro CLIs in a triage run, spawned by the real
// adapters' triage invocations. Never used at runtime. It reads the prompt from stdin and prints
// FAKE_TRIAGE_REPLY (the model's answer) in the output mode of the CLI named by FAKE_TRIAGE_FORMAT:
//   claude  `-p --output-format stream-json --verbose`: init, assistant and result events
//   codex   `exec --json`: thread.started, item.completed(agent_message), turn.completed
//   kiro    `chat --no-interactive`: the answer as plain text on stdout, log records on stderr
// Other variables:
//   FAKE_TRIAGE_RECORD  path: append {argv, prompt, cwd} as one JSON line
//   FAKE_TRIAGE_EXIT    exit code (default 0); with claude/codex a failing run prints an error event
//   FAKE_TRIAGE_SLEEP   milliseconds to wait before answering (timeout tests)
//   FAKE_TRIAGE_REPLIES path: JSON array of replies, one per launch (the Nth launch gets the Nth)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const argv = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
if (env.FAKE_TRIAGE_RECORD) appendFileSync(env.FAKE_TRIAGE_RECORD, `${JSON.stringify({ argv, prompt, cwd: process.cwd() })}\n`);

let reply = env.FAKE_TRIAGE_REPLY ?? '';
if (env.FAKE_TRIAGE_REPLIES) {
  const counter = `${env.FAKE_TRIAGE_REPLIES}.n`;
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
  const all = JSON.parse(readFileSync(env.FAKE_TRIAGE_REPLIES, 'utf8'));
  reply = all[Math.min(n, all.length - 1)];
}
const format = env.FAKE_TRIAGE_FORMAT ?? 'claude';
const code = Number(env.FAKE_TRIAGE_EXIT ?? 0);
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);

await new Promise((r) => setTimeout(r, Number(env.FAKE_TRIAGE_SLEEP ?? 0)));

if (code !== 0) {
  if (format === 'claude') out({ type: 'result', subtype: 'success', is_error: true, result: env.FAKE_TRIAGE_ERROR ?? 'You have hit your usage limit', session_id: 's1' });
  else if (format === 'codex') out({ type: 'turn.failed', error: { message: env.FAKE_TRIAGE_ERROR ?? 'You have hit your usage limit' } });
  else process.stderr.write(`${env.FAKE_TRIAGE_ERROR ?? 'error: not logged in'}\n`);
  process.exit(code);
}

if (format === 'claude') {
  out({ type: 'system', subtype: 'init', session_id: 's1', tools: [] });
  out({ type: 'assistant', session_id: 's1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, num_turns: 1, session_id: 's1' });
} else if (format === 'codex') {
  out({ type: 'thread.started', thread_id: 't1' });
  out({ type: 'turn.started' });
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: reply } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
} else {
  process.stderr.write('[INFO] [KRS] <-- GenerateAssistantResponseCommand done totalEvents=3\n');
  process.stdout.write(`${reply}\n`);
}
