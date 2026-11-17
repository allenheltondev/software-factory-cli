import { describe, expect, it } from 'vitest';
import { assistantText, assistantToolUse, errorResult, init, SESSION, stream, success, toolResult } from '../../../test/claude-stream.js';
import type { AgentExit, InvocationRequest } from './adapter.js';
import { claudeAdapter, findResult } from './claude.js';
import { getAdapter, implementedAdapters } from './registry.js';

function request(o: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    launch: { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'] },
    promptFile: 'C:\\logs\\runs\\run_1\\prompt.md',
    worktree: 'C:\\state\\worktrees\\job_1',
    runDir: 'C:\\logs\\runs\\run_1',
    extraArgs: [],
    platform: 'win32',
    ...o,
  };
}

const exit = (output: string, code: number | null = 0, signal: NodeJS.Signals | null = null): AgentExit => ({
  code,
  signal,
  output,
  outputTail: output.split('\n').filter(Boolean).slice(-20),
});

const FINAL = [
  '## Summary',
  '- Added the dragon roster page (src/roster.ts) and its route.',
  '- Tests: `npm test` passed (42 tests).',
  '',
  'Open question: should retired dragons be listed?',
].join('\n');

describe('claude adapter: invocation', () => {
  it('is registered as the built-in claude adapter', () => {
    expect(getAdapter('claude')).toBe(claudeAdapter);
    expect(implementedAdapters()).toEqual(['claude']);
  });

  it('runs claude -p after the resolved launch target, streaming JSON, full auto, prompt on stdin', () => {
    const req = request();
    const inv = claudeAdapter.buildInvocation(req);
    expect(inv).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
      ],
      promptVia: 'stdin',
    });
    // The adapter needs no environment of its own; agents.<name>.env is applied by the executor.
    expect(inv.env).toBeUndefined();
    // Never a prompt (or the prompt's path) on the command line.
    expect(inv.args).not.toContain(req.promptFile);
  });

  it('works with a native binary launch (no script argument)', () => {
    const inv = claudeAdapter.buildInvocation(request({ launch: { file: '/home/me/.local/bin/claude', args: [] }, platform: 'linux' }));
    expect(inv.file).toBe('/home/me/.local/bin/claude');
    expect(inv.args.slice(0, 2)).toEqual(['-p', '--output-format']);
  });

  it('appends config args last, so variadic options like --allowedTools cannot swallow the adapter flags', () => {
    const inv = claudeAdapter.buildInvocation(request({ extraArgs: ['--model', 'sonnet', '--max-turns', '40', '--disallowedTools', 'WebFetch'] }));
    expect(inv.args.slice(-6)).toEqual(['--model', 'sonnet', '--max-turns', '40', '--disallowedTools', 'WebFetch']);
    expect(inv.args).toContain('bypassPermissions');
  });

  it.each([
    [['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(npm test *)', 'Read']],
    [['--permission-mode=dontAsk']],
    [['--dangerously-skip-permissions']],
  ])('a permission flag in config args replaces the full-auto default: %j', (extraArgs) => {
    const inv = claudeAdapter.buildInvocation(request({ extraArgs }));
    expect(inv.args).not.toContain('bypassPermissions');
    expect(inv.args.slice(-extraArgs.length)).toEqual(extraArgs);
  });

  it('an --output-format in config args replaces the stream-json default', () => {
    const inv = claudeAdapter.buildInvocation(request({ extraArgs: ['--output-format', 'json'] }));
    expect(inv.args.filter((a) => a === '--output-format')).toHaveLength(1);
    expect(inv.args).not.toContain('--verbose');
    expect(inv.args.slice(-2)).toEqual(['--output-format', 'json']);
  });
});

describe('claude adapter: results', () => {
  const run = (...events: Array<Record<string, unknown> | string>) =>
    stream(init(), assistantToolUse('toolu_1', 'npm test'), toolResult('toolu_1', 'Tests: 42 passed'), ...events);

  it('success: exit 0 and a success result; the summary is the final message plus a status line', () => {
    const out = run(assistantText(FINAL), success(FINAL));
    expect(claudeAdapter.interpretExit!(exit(out))).toEqual({ outcome: 'succeeded' });
    expect(claudeAdapter.summarizeOutput!(out)).toEqual([
      ...FINAL.split('\n'),
      `claude: success after 14 turns, $0.42 estimated, session ${SESSION}`,
    ]);
  });

  it('uses the last result when background work started another turn', () => {
    const out = run(success('first turn'), assistantText('more'), success('second turn', { num_turns: 2 }));
    expect(findResult(out)?.result).toBe('second turn');
  });

  it('reads a single --output-format json result too', () => {
    const out = stream(success(FINAL));
    expect(claudeAdapter.interpretExit!(exit(out))).toEqual({ outcome: 'succeeded' });
  });

  it('is_error on a success result fails the run with the reported text (e.g. missing authentication)', () => {
    const out = stream(init(), success('Invalid API key · Please run /login', { is_error: true, num_turns: 1, api_error_status: 401, terminal_reason: 'api_error' }));
    expect(claudeAdapter.interpretExit!(exit(out, 1))).toEqual({
      outcome: 'failed',
      error: 'claude reported an error (API status 401) (api_error): Invalid API key · Please run /login',
    });
    expect(claudeAdapter.summarizeOutput!(out)?.at(-1)).toBe(`claude: success (is_error) after 1 turn, $0.42 estimated, session ${SESSION}`);
  });

  it('error_max_turns fails, and the summary keeps what Claude last said', () => {
    const out = run(assistantText('Still working on the roster tests.'), errorResult('error_max_turns', { terminal_reason: 'max_turns' }));
    expect(claudeAdapter.interpretExit!(exit(out, 1))).toEqual({ outcome: 'failed', error: 'claude stopped at its turn limit (--max-turns) after 30 turns' });
    expect(claudeAdapter.summarizeOutput!(out)).toEqual([
      'Still working on the roster tests.',
      `claude: error_max_turns after 30 turns, $1.25 estimated, session ${SESSION}`,
    ]);
  });

  it('error_max_budget_usd fails with the spend', () => {
    const out = run(errorResult('error_max_budget_usd'));
    expect(claudeAdapter.interpretExit!(exit(out, 1))).toEqual({
      outcome: 'failed',
      error: 'claude stopped at its spending limit (--max-budget-usd) at $1.25 estimated',
    });
  });

  it('error_during_execution fails with its errors', () => {
    const out = run(errorResult('error_during_execution', { errors: ['Tool execution failed\nstack...', 'second'], terminal_reason: 'model_error' }));
    const verdict = claudeAdapter.interpretExit!(exit(out, 1));
    expect(verdict).toEqual({ outcome: 'failed', error: 'claude failed during execution (model_error): Tool execution failed; second' });
    expect(claudeAdapter.summarizeOutput!(out)).toContain('Tool execution failed');
  });

  it('an unknown error subtype still fails', () => {
    expect(claudeAdapter.interpretExit!(exit(run(errorResult('error_something_new')), 1))).toEqual({
      outcome: 'failed',
      error: 'claude ended with error_something_new',
    });
  });

  it('a success result with a non-zero exit, or a signal, is not a success', () => {
    const out = run(success(FINAL));
    expect(claudeAdapter.interpretExit!(exit(out, 2))).toEqual({ outcome: 'failed', error: 'claude reported success but exited with code 2' });
    expect(claudeAdapter.interpretExit!(exit(out, null, 'SIGKILL'))).toEqual({ outcome: 'failed', error: 'claude reported success but was ended by SIGKILL' });
  });

  it('lists permission denials in the status line', () => {
    const out = run(success('done', { permission_denials: [{ tool_name: 'WebFetch', tool_use_id: 't1', tool_input: {} }, { tool_name: 'WebFetch', tool_use_id: 't2', tool_input: {} }] }));
    expect(claudeAdapter.summarizeOutput!(out)?.at(-1)).toBe(`claude: success after 14 turns, $0.42 estimated, 2 permission denial(s): WebFetch, session ${SESSION}`);
  });

  it('no result: a bad flag before the run fails with what stderr said', () => {
    const out = "error: unknown option '--frobnicate'\n";
    expect(claudeAdapter.interpretExit!(exit(out, 1))).toEqual({
      outcome: 'failed',
      error: "agent exited with code 1 before reporting a result: error: unknown option '--frobnicate'",
    });
    expect(claudeAdapter.summarizeOutput!(out)).toBeNull();
  });

  it('no result: exit 0 falls back to the exit code', () => {
    expect(claudeAdapter.interpretExit!(exit('plain text output\n', 0))).toEqual({ outcome: 'succeeded' });
  });

  it('no result (timed out): the summary is the last main-conversation message and the session', () => {
    const out = run(assistantText('Running the full test suite now.'), assistantText('subagent chatter', 'toolu_9'), assistantToolUse('toolu_2', 'npm test'));
    expect(claudeAdapter.summarizeOutput!(out)).toEqual(['Running the full test suite now.', `claude: no result message, session ${SESSION}`]);
  });

  it('tolerates junk and partial lines around the JSON', () => {
    const out = `{"type":"assist\nnot json\n${stream(success('ok'))}Waiting for background work to finish\n`;
    expect(claudeAdapter.interpretExit!(exit(out))).toEqual({ outcome: 'succeeded' });
  });
});
