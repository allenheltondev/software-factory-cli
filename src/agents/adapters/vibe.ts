import type { AgentAdapter } from './adapter.js';
import { defaultVerdict } from './adapter.js';
import { failureLine } from '../failure-line.js';

export const vibeAdapter: AgentAdapter = {
  name: 'vibe',
  buildInvocation({ launch, extraArgs, worktree }) {
    // Keep the prompt in stdin and preserve the final text for Updraft's review parser.
    const reserved = extraArgs.some((arg) => /^-(?:p|c)/.test(arg) ||
      /^--(?:prompt(?:-file)?|output(?:-dir)?|workdir|worktree|continue|resume|setup)(?:=|$)/.test(arg) || arg === '--');
    if (reserved) throw new Error('Vibe args cannot override the job worktree, prompt, output format, or session');
    return {
      file: launch.file,
      args: [...launch.args, '--workdir', worktree, '--output', 'text', ...extraArgs, '--prompt'],
      promptVia: 'stdin',
      separateStderr: true,
    };
  },
  interpretExit(exit) {
    const verdict = defaultVerdict(exit);
    if (verdict.outcome === 'succeeded' || !exit.code) return verdict;
    const reason = failureLine(exit.output);
    return { outcome: 'failed', error: `Vibe exited with code ${exit.code}${reason ? `: ${reason.slice(0, 200)}` : ''}` };
  },
};
