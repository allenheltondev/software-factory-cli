import { describe, expect, it } from 'vitest';
import { effectiveArgs, agentProfile } from '../profile.js';
import { vibeAdapter } from './vibe.js';

const request = {
  launch: { file: 'vibe.exe', args: [] },
  promptFile: 'prompt.md',
  worktree: 'worktree',
  runDir: 'run',
  platform: 'win32' as const,
};

describe('Vibe adapter', () => {
  it('selects the configured alias and delivers the prompt on stdin', () => {
    const extraArgs = effectiveArgs('vibe', { model: 'devstral-local', args: ['--max-turns', '5'] });
    expect(vibeAdapter.buildInvocation({ ...request, extraArgs })).toEqual({
      file: 'vibe.exe',
      args: ['--workdir', 'worktree', '--output', 'text', '--max-turns', '5', '--model', 'devstral-local', '--prompt'],
      promptVia: 'stdin',
      separateStderr: true,
    });
  });

  it.each(['--prompt-file=other.md', '-pother', '--output=json', '--resume', '-c', '--worktree'])('rejects %s', (arg) => {
    expect(() => vibeAdapter.buildInvocation({ ...request, extraArgs: [arg] })).toThrow('Vibe args cannot');
  });

  it('flags conflicting model settings and unsupported effort shorthand', () => {
    expect(agentProfile('vibe', { model: 'local', args: ['--model=hosted'], effort: 'high' }).problems).toEqual([
      'model "local" contradicts args ("hosted"); keep one of them',
      'set reasoning effort in the Vibe model preset',
    ]);
  });

  it('reports provider failures as failed runs', () => {
    expect(vibeAdapter.interpretExit?.({
      code: 2, signal: null, output: 'Error: model is unavailable\n', outputTail: [], args: [],
    })).toEqual({ outcome: 'failed', error: 'Vibe exited with code 2: Error: model is unavailable' });
  });
});
