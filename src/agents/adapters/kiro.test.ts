import { describe, expect, it } from 'vitest';
import type { AgentExit, InvocationRequest } from './adapter.js';
import { kiroAdapter, kiroArgsChooseHarness, kiroSupportsV3 } from './kiro.js';
import { getAdapter, implementedAdapters } from './registry.js';

function request(o: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    launch: { file: 'C:\\Users\\Jane Doe\\AppData\\Local\\Microsoft\\WinGet\\Links\\kiro-cli.exe', args: [] },
    promptFile: 'C:\\logs\\runs\\run_1\\prompt.md',
    worktree: 'C:\\state\\worktrees\\job_1',
    runDir: 'C:\\logs\\runs\\run_1',
    extraArgs: [],
    platform: 'win32',
    ...o,
  };
}

const DEFAULT_ARGS = ['chat', '--no-interactive', '--v3', '--trust-all-tools'];
const args = (extraArgs: string[]) => kiroAdapter.buildInvocation(request({ extraArgs })).args;

const exit = (output: string, code: number | null = 0, signal: NodeJS.Signals | null = null): AgentExit => ({
  code,
  signal,
  output,
  outputTail: output.split('\n').filter(Boolean).slice(-20),
  args: DEFAULT_ARGS,
});

describe('kiro adapter: invocation', () => {
  it('is registered as the built-in kiro adapter', () => {
    expect(getAdapter('kiro')).toBe(kiroAdapter);
    expect(implementedAdapters()).toEqual(expect.arrayContaining(['claude', 'kiro']));
  });

  it('runs kiro-cli chat --no-interactive on V3, trusting all tools, with the prompt on stdin', () => {
    const req = request();
    const inv = kiroAdapter.buildInvocation(req);
    expect(inv).toEqual({ file: req.launch.file, args: DEFAULT_ARGS, promptVia: 'stdin' });
    expect(inv.env).toBeUndefined();
    // Never a prompt (or the prompt's path) on the command line: a positional would replace stdin.
    expect(inv.args).not.toContain(req.promptFile);
  });

  it('builds on the launch target and its args', () => {
    const inv = kiroAdapter.buildInvocation(request({ launch: { file: '/usr/bin/node', args: ['/opt/kiro/cli.js'] }, platform: 'linux' }));
    expect(inv.file).toBe('/usr/bin/node');
    expect(inv.args).toEqual(['/opt/kiro/cli.js', ...DEFAULT_ARGS]);
  });

  it('appends config args last', () => {
    expect(args(['--model', 'claude-sonnet-4', '--agent', 'updraft'])).toEqual([...DEFAULT_ARGS, '--model', 'claude-sonnet-4', '--agent', 'updraft']);
  });

  it('a trust flag in the config args replaces the full-auto default', () => {
    expect(args(['--trust-tools=read_file,grep_search'])).toEqual(['chat', '--no-interactive', '--v3', '--trust-tools=read_file,grep_search']);
    expect(args(['--trust-tools', 'read_file'])).toEqual(['chat', '--no-interactive', '--v3', '--trust-tools', 'read_file']);
    expect(args(['--trust-all-tools'])).toEqual(['chat', '--no-interactive', '--v3', '--trust-all-tools']);
  });

  it('a harness flag in the config args replaces --v3 (they conflict)', () => {
    expect(args(['--v2'])).toEqual(['chat', '--no-interactive', '--trust-all-tools', '--v2']);
    expect(args(['--agent-engine', 'v2'])).toEqual(['chat', '--no-interactive', '--trust-all-tools', '--agent-engine', 'v2']);
    expect(args(['--agent-engine=v3'])).toEqual(['chat', '--no-interactive', '--trust-all-tools', '--agent-engine=v3']);
  });

  it('does not repeat --no-interactive, and passes an --output-format through', () => {
    expect(args(['--no-interactive'])).toEqual(['chat', '--v3', '--trust-all-tools', '--no-interactive']);
    expect(args(['--output-format', 'stream-json'])).toEqual([...DEFAULT_ARGS, '--output-format', 'stream-json']);
  });
});

describe('kiro adapter: version baseline', () => {
  it('3.0.0 is the baseline the adapter is written against; an unreadable version is unknown', () => {
    expect(kiroSupportsV3('2.9.9')).toBe('no');
    expect(kiroSupportsV3('1.20.0-beta.1')).toBe('no');
    expect(kiroSupportsV3('3.0.0')).toBe('yes');
    expect(kiroSupportsV3('3.0.0-beta.1')).toBe('yes');
    expect(kiroSupportsV3('10.2.0')).toBe('yes');
    expect(kiroSupportsV3('nightly')).toBe('unknown');
    expect(kiroSupportsV3(null)).toBe('unknown');
  });

  it('the harness flags that replace --v3 are the ones buildInvocation reads', () => {
    for (const a of [['--v2'], ['--v3'], ['--agent-engine', 'v2'], ['--agent-engine=v3']]) {
      expect(kiroArgsChooseHarness(a)).toBe(true);
      expect(args(a).filter((x) => x === '--v3').length).toBe(a[0] === '--v3' ? 1 : 0);
    }
    expect(kiroArgsChooseHarness(['--model', 'x'])).toBe(false);
  });
});

describe('kiro adapter: results', () => {
  it('exit 0 succeeds; the summary is left to the last output lines', () => {
    expect(kiroAdapter.interpretExit!(exit('Added the roster page and its tests.\n'))).toEqual({ outcome: 'succeeded' });
    expect(kiroAdapter.summarizeOutput).toBeUndefined();
  });

  it('exit 1 fails with its documented meaning and the last thing Kiro printed', () => {
    const out = 'Thinking...\n\x1b[31merror:\x1b[0m API key is invalid or expired\n\n';
    expect(kiroAdapter.interpretExit!(exit(out, 1))).toEqual({
      outcome: 'failed',
      error: 'kiro-cli exited with code 1 (general failure: an auth error, invalid arguments or a failed operation): error: API key is invalid or expired',
    });
  });

  it('exit 3 and 4 name the MCP startup failure and the missing agent', () => {
    expect(kiroAdapter.interpretExit!(exit('', 3))).toEqual({
      outcome: 'failed',
      error: 'kiro-cli exited with code 3 (an MCP server required by --require-mcp-startup did not start)',
    });
    expect(kiroAdapter.interpretExit!(exit('agent "updraft" not found\n', 4)).error).toBe(
      'kiro-cli exited with code 4 (the agent the run named (--agent or chat.defaultAgent) is not available): agent "updraft" not found',
    );
  });

  it('an undocumented exit code or a signal still fails', () => {
    expect(kiroAdapter.interpretExit!(exit('', 101))).toEqual({ outcome: 'failed', error: 'kiro-cli exited with code 101' });
    expect(kiroAdapter.interpretExit!(exit('', null, 'SIGKILL'))).toEqual({ outcome: 'failed', error: 'agent was ended by SIGKILL' });
  });

  it('clips a long last line', () => {
    const error = kiroAdapter.interpretExit!(exit(`${'x'.repeat(500)}\n`, 1)).error!;
    expect(error).toMatch(/: x+…$/);
    expect(error.length).toBeLessThan(350);
  });

  it('the reason skips blank lines, escape sequences and spinner redraws', () => {
    const why = (out: string) => kiroAdapter.interpretExit!(exit(out, 101)).error;
    expect(why('done\r\n\r\n')).toBe('kiro-cli exited with code 101: done');
    expect(why('⠋ Working\r⠙ Working\rFinished: 3 files changed\n')).toBe('kiro-cli exited with code 101: Finished: 3 files changed');
    expect(why('ok\n\x1b]0;title\x07\x1b[2K\n')).toBe('kiro-cli exited with code 101: ok');
  });

  it('the reason is the error Kiro printed, not a line it printed after it', () => {
    const out = 'Thinking...\nError: The model is currently overloaded\nSee https://kiro.dev/docs/cli/ for help\n';
    expect(kiroAdapter.interpretExit!(exit(out, 101)).error).toBe('kiro-cli exited with code 101: Error: The model is currently overloaded');
  });
});
