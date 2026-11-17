import { describe, expect, it } from 'vitest';
import {
  agentMessage,
  command,
  errorEvent,
  fileChange,
  reasoning,
  stream,
  THREAD,
  threadStarted,
  turnCompleted,
  turnFailed,
  turnStarted,
} from '../../../test/codex-stream.js';
import type { AgentExit, InvocationRequest } from './adapter.js';
import { codexAdapter, configKeys, findTurnEnd, setsPermissions } from './codex.js';
import { getAdapter, implementedAdapters } from './registry.js';

function request(o: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    launch: { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] },
    promptFile: 'C:\\logs\\runs\\run_1\\prompt.md',
    worktree: 'C:\\state\\worktrees\\job_1',
    runDir: 'C:\\logs\\runs\\run_1',
    extraArgs: [],
    platform: 'win32',
    ...o,
  };
}

/** Args as the adapter builds them by default (--json). */
const JSON_ARGS = codexAdapter.buildInvocation(request()).args;

const exit = (
  output: string,
  code: number | null = 0,
  signal: NodeJS.Signals | null = null,
  o: { args?: readonly string[] } = {},
): AgentExit => ({
  code,
  signal,
  output,
  outputTail: output.split('\n').filter(Boolean).slice(-20),
  args: o.args ?? JSON_ARGS,
});

const verdict = (output: string, code: number | null = 0, signal: NodeJS.Signals | null = null) => codexAdapter.interpretExit!(exit(output, code, signal));
const summary = (output: string) => codexAdapter.summarizeOutput!(output);

const FINAL = [
  '## Summary',
  '- Added the dragon art gallery (src/gallery.ts) and its route.',
  '- Tests: `npm test` passed (42 tests).',
  '',
  'Open question: should sketches be shown?',
].join('\n');

const STATUS_OK = `codex: turn completed, 24763 input tokens (24448 cached), 122 output tokens, thread ${THREAD}`;

describe('codex adapter: invocation', () => {
  it('is registered as the built-in codex adapter', () => {
    expect(getAdapter('codex')).toBe(codexAdapter);
    expect(implementedAdapters()).toContain('codex');
  });

  it('runs codex exec after the resolved launch target, JSONL events, full auto, prompt on stdin', () => {
    const req = request();
    const inv = codexAdapter.buildInvocation(req);
    expect(inv).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
      promptVia: 'stdin',
    });
    expect(inv.env).toBeUndefined();
    // Never a prompt, a "-" prompt placeholder, or the prompt's path on the command line.
    expect(inv.args).not.toContain(req.promptFile);
    expect(inv.args).not.toContain('-');
  });

  it('works with a native binary launch (no script argument)', () => {
    const inv = codexAdapter.buildInvocation(request({ launch: { file: '/opt/homebrew/bin/codex', args: [] }, platform: 'darwin' }));
    expect(inv.file).toBe('/opt/homebrew/bin/codex');
    expect(inv.args).toEqual(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox']);
  });

  it('appends config args last, so multi-value options like --image cannot swallow the adapter flags', () => {
    const extraArgs = ['--model', 'gpt-5-codex', '-c', 'model_reasoning_effort="high"', '--add-dir', '/tmp/cache'];
    const inv = codexAdapter.buildInvocation(request({ extraArgs }));
    expect(inv.args.slice(-extraArgs.length)).toEqual(extraArgs);
    expect(inv.args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it.each([
    [['--sandbox', 'workspace-write']],
    [['--sandbox=read-only']],
    [['-s', 'workspace-write']],
    [['-sworkspace-write']],
    [['--ask-for-approval', 'never']],
    [['-a', 'on-request']],
    [['--full-auto']],
    [['--approve-for-me']],
    [['--not-so-yolo']],
    [['--yolo']],
    [['--dangerously-bypass-approvals-and-sandbox']],
    [['-c', 'sandbox_mode="workspace-write"']],
    [['--config', 'approval_policy = "never"']],
    [['--config=sandbox_mode=read-only']],
    [['-csandbox_mode=read-only']],
  ])('a sandbox or approval setting in config args replaces the full-auto default: %j', (extraArgs) => {
    const inv = codexAdapter.buildInvocation(request({ extraArgs }));
    expect(inv.args.filter((a) => a === '--dangerously-bypass-approvals-and-sandbox')).toHaveLength(extraArgs.includes('--dangerously-bypass-approvals-and-sandbox') ? 1 : 0);
    expect(inv.args.slice(-extraArgs.length)).toEqual(extraArgs);
  });

  it('other -c overrides, --cd and --model keep the default', () => {
    for (const extraArgs of [['-c', 'sandbox_workspace_write.network_access=true'], ['-C', 'elsewhere'], ['-m', 'o3'], ['--profile', 'ci']]) {
      expect(setsPermissions(extraArgs)).toBe(false);
    }
    expect(configKeys(['-c', 'a.b=1', '--config=c = 2', '-cd=3', '--model', 'x'])).toEqual(['a.b', 'c', 'd']);
  });

  it('--json (or its alias) in config args is not repeated', () => {
    for (const flag of ['--json', '--experimental-json']) {
      const inv = codexAdapter.buildInvocation(request({ extraArgs: [flag] }));
      expect(inv.args.filter((a) => a === '--json' || a === '--experimental-json')).toEqual([flag]);
    }
  });
});

describe('codex adapter: results', () => {
  const run = (...events: Array<Record<string, unknown> | string>) =>
    stream(
      threadStarted(),
      turnStarted(),
      reasoning('item_0', 'Looking at the gallery route.'),
      command('item_1', 'bash -lc "npm test"', 'Tests: 42 passed'),
      fileChange('item_2', 'src/gallery.ts'),
      ...events,
    );

  it('success: exit 0 after turn.completed; the summary is the final message plus a status line', () => {
    const out = run(agentMessage('item_3', FINAL), turnCompleted());
    expect(verdict(out)).toEqual({ outcome: 'succeeded' });
    expect(summary(out)).toEqual([...FINAL.split('\n'), STATUS_OK]);
  });

  it('the final message is the last agent message, not an earlier one', () => {
    const out = run(agentMessage('item_3', 'Starting on the gallery.'), agentMessage('item_4', 'Done.'), turnCompleted({ cached_input_tokens: 0 }));
    expect(summary(out)).toEqual(['Done.', `codex: turn completed, 24763 input tokens, 122 output tokens, thread ${THREAD}`]);
  });

  it('turn.failed fails the run with its message, and the summary keeps what Codex last said', () => {
    const out = run(agentMessage('item_3', 'Halfway through the gallery.'), turnFailed('stream disconnected before completion: rate limit\ndetails'));
    expect(verdict(out, 1)).toEqual({ outcome: 'failed', error: 'codex turn failed: stream disconnected before completion: rate limit' });
    expect(summary(out)).toEqual([
      'Halfway through the gallery.',
      'stream disconnected before completion: rate limit',
      'details',
      `codex: turn failed, thread ${THREAD}`,
    ]);
  });

  it('turn.failed fails even with exit 0', () => {
    expect(verdict(run(turnFailed('boom')), 0)).toEqual({ outcome: 'failed', error: 'codex turn failed: boom' });
  });

  it('a retried error event before a completed turn does not fail the run', () => {
    const out = run(errorEvent('Reconnecting... 1/5'), agentMessage('item_3', FINAL), turnCompleted());
    expect(verdict(out)).toEqual({ outcome: 'succeeded' });
  });

  it('a completed turn with a non-zero exit, or a signal, is not a success', () => {
    const out = run(agentMessage('item_3', FINAL), turnCompleted());
    expect(verdict(out, 1)).toEqual({ outcome: 'failed', error: 'codex completed its turn but exited with code 1' });
    expect(verdict(out, null, 'SIGKILL')).toEqual({ outcome: 'failed', error: 'codex completed its turn but was ended by SIGKILL' });
    expect(verdict(`${out}${JSON.stringify(errorEvent('failed to write rollout'))}\n`, 1)).toEqual({
      outcome: 'failed',
      error: 'codex completed its turn but exited with code 1: failed to write rollout',
    });
  });

  it('no turn end, non-zero exit: an error event is the reason (e.g. sign-in)', () => {
    const out = stream(threadStarted(), turnStarted(), errorEvent('unexpected status 401 Unauthorized: Missing bearer authentication'));
    expect(verdict(out, 1)).toEqual({
      outcome: 'failed',
      error: 'agent exited with code 1 before finishing its turn: unexpected status 401 Unauthorized: Missing bearer authentication',
    });
    expect(summary(out)).toEqual([`codex: no turn result, thread ${THREAD}`]);
  });

  it('no turn end: a bad flag before the run fails with what stderr said', () => {
    const out = "error: unexpected argument '--frobnicate' found\n";
    expect(verdict(out, 2)).toEqual({ outcome: 'failed', error: "agent exited with code 2 before finishing its turn: error: unexpected argument '--frobnicate' found" });
    expect(summary(out)).toBeNull();
  });

  it('an interrupted turn (no turn end, exit 1) fails', () => {
    const out = run(agentMessage('item_3', 'Running the full test suite now.'));
    expect(verdict(out, 1)).toMatchObject({ outcome: 'failed', error: 'agent exited with code 1 before finishing its turn' });
    expect(summary(out)).toEqual(['Running the full test suite now.', `codex: no turn result, thread ${THREAD}`]);
  });

  it('fails closed: exit 0 with --json but no turn end', () => {
    expect(verdict(run(agentMessage('item_3', 'Done.')))).toEqual({
      outcome: 'failed',
      error: 'codex exited with code 0, but no turn.completed or turn.failed event could be read from its --json output (none was printed, or it was too large to read)',
    });
    // What the executor passes when the turn end is cut off at the start of the output window.
    expect(verdict('Warning: something on stderr\n')).toMatchObject({ outcome: 'failed' });
  });

  it('without --json (not something the adapter builds), exit 0 alone succeeds', () => {
    expect(codexAdapter.interpretExit!(exit('All done.\n', 0, null, { args: ['exec', '--sandbox', 'workspace-write'] }))).toEqual({ outcome: 'succeeded' });
  });

  it('finds the turn end behind stderr printed after it, past a large final message', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const diag = 'Warning: no last agent message; wrote empty content to out.md\n(node:123) ExperimentalWarning: ...\n';
    const ok = `${run(agentMessage('item_3', huge), turnCompleted())}${diag}`;
    expect(verdict(ok)).toEqual({ outcome: 'succeeded' });
    expect(summary(ok)?.at(-1)).toBe(STATUS_OK);
    expect(findTurnEnd(`${run(turnFailed('bad'))}${diag}`)).toMatchObject({ type: 'turn.failed' });
  });

  it('an agent message that quotes a turn event is not mistaken for one', () => {
    const out = run(agentMessage('item_3', '{"type":"turn.completed","usage":{}}'));
    expect(findTurnEnd(out)).toBeNull();
    expect(verdict(out).outcome).toBe('failed');
  });

  it('tolerates junk and partial lines around the JSON', () => {
    const out = `{"type":"item.comp\nnot json\n${run(agentMessage('item_3', 'ok'), turnCompleted())}trailing text\n`;
    expect(verdict(out)).toEqual({ outcome: 'succeeded' });
    expect(summary(out)?.[0]).toBe('ok');
  });
});
