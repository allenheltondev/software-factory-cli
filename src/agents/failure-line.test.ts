import { describe, expect, it } from 'vitest';
import { failureLine, firstMeaningfulLine } from './failure-line.js';

const USAGE_LIMIT =
  "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:33 PM.";

// What `codex exec --skip-git-repo-check --ephemeral --sandbox read-only "<prompt>"` (codex-cli
// 0.170.0, stdin not a TTY) printed on stderr when the account was over its usage limit.
const CODEX_USAGE_LIMIT_STDERR = [
  'Reading additional input from stdin...',
  'OpenAI Codex v0.170.0 (research preview)',
  '--------',
  'workdir: C:\\Users\\jane\\AppData\\Local\\Temp',
  'model: gpt-5.5',
  'provider: openai',
  'approval: never',
  'sandbox: read-only',
  'session id: 019a8c1e-7f2b-7c31-9d4e-2b6f0e1a3c55',
  '--------',
  'user',
  'Reply with the single word OK and nothing else.',
  USAGE_LIMIT,
  '',
].join('\n');

const CONFIG_WARNING = '⚠ Codex is ignoring 2 unrecognized configuration settings in C:\\Users\\jane\\.codex\\config.toml: model_reasoning, tui.theme';

describe('failureLine', () => {
  it("picks Codex's usage-limit error over its stdin banner and session header", () => {
    expect(failureLine(CODEX_USAGE_LIMIT_STDERR)).toBe(USAGE_LIMIT);
  });

  it('never reports the stdin banner, even when it is all there is', () => {
    expect(failureLine('Reading additional input from stdin...\n')).toBe('');
    expect(failureLine('Reading prompt from stdin...\n')).toBe('');
  });

  it("skips Codex's config warnings in favor of the line after them", () => {
    expect(failureLine(`${CONFIG_WARNING}\nReading additional input from stdin...\nunexpected status 401 Unauthorized\n`)).toBe('unexpected status 401 Unauthorized');
    expect(failureLine(`Reading additional input from stdin...\n${CONFIG_WARNING}\n`)).toBe(CONFIG_WARNING);
    expect(failureLine('WARNING: proceeding, even though we could not update PATH\nsomething broke\n')).toBe('something broke');
  });

  it("reads Claude Code's JSON result with is_error: true", () => {
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      duration_ms: 412,
      num_turns: 1,
      result: 'Invalid API key · Please run /login',
      session_id: '5b1c3a52-1f0e-4d2b-9a77-0e3c2f6d8a10',
      total_cost_usd: 0,
    });
    expect(failureLine(`${result}\n`)).toBe('Invalid API key · Please run /login');
    expect(failureLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['', 'Tool permission stream closed'] }))).toBe(
      'Tool permission stream closed',
    );
    expect(failureLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }))).toBe('error_max_turns (is_error)');
  });

  it('reads error JSON from Codex and HTTP APIs', () => {
    expect(failureLine(JSON.stringify({ type: 'error', message: 'stream disconnected before completion' }))).toBe('stream disconnected before completion');
    expect(failureLine(JSON.stringify({ type: 'turn.failed', error: { message: 'model not supported\nmore' } }))).toBe('model not supported');
    expect(failureLine(`some text\n${JSON.stringify({ detail: "The 'gpt-9' model is not supported when using Codex with a ChatGPT account." })}\n`)).toBe(
      "The 'gpt-9' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it('prefers the last error line, then the last ordinary line, then non-error JSON', () => {
    expect(failureLine('error: first\nnoise\nError: second\ntrailing note\n')).toBe('Error: second');
    expect(failureLine('first\nsecond\n')).toBe('second');
    expect(failureLine('fatal: not a git repository\nhint: try again\n')).toBe('fatal: not a git repository');
    expect(failureLine('2026-11-18T19:02:11.512Z ERROR codex_core::client: request failed\nbye\n')).toBe('2026-11-18T19:02:11.512Z ERROR codex_core::client: request failed');
    const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });
    expect(failureLine(`${ok}\n`)).toBe(ok);
    expect(failureLine(`${ok}\nexited early\n`)).toBe('exited early');
  });

  it('cleans escape sequences, spinner redraws and CRLF, and is empty for blank output', () => {
    expect(failureLine('⠋ Working\r⠙ Working\r\x1b[31mError: boom\x1b[0m\r\n')).toBe('Error: boom');
    expect(failureLine('\n \r\n')).toBe('');
  });
});

describe('firstMeaningfulLine', () => {
  it('skips banners and warnings, falling back to the first warning', () => {
    expect(firstMeaningfulLine(`${CONFIG_WARNING}\nLogged in using ChatGPT\n`)).toBe('Logged in using ChatGPT');
    expect(firstMeaningfulLine(`Reading additional input from stdin...\n${CONFIG_WARNING}\n`)).toBe(CONFIG_WARNING);
    expect(firstMeaningfulLine('Reading additional input from stdin...\n')).toBe('');
  });
});
