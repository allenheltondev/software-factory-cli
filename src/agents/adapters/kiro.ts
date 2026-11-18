/**
 * Kiro adapter: one headless `kiro-cli chat --no-interactive` run per job, prompt on stdin.
 *
 * Invocation (`launch` is the resolved CLI, normally the native `kiro-cli` binary):
 *
 *   <launch> chat --no-interactive --v3 --trust-all-tools <agents.<name>.args>
 *
 * - `chat --no-interactive` runs one instruction to completion without the terminal UI
 *   (https://kiro.dev/docs/cli/headless/; `--no-interactive`: "Print first response to STDOUT
 *   without interactive mode", https://kiro.dev/docs/reference/cli-commands/). "When stdin is
 *   piped and no positional argument is given, Kiro reads the full stream as the instruction"
 *   (https://kiro.dev/docs/cli/headless/). The executor opens prompt.md as stdin and no prompt
 *   argument is ever passed, so no issue text is on the command line. A positional argument in
 *   agents.<name>.args would replace the prompt: "V2 and V3 only read stdin when no positional
 *   argument is present".
 * - `--v3` pins the agent harness. The docs recommend naming it in scripts: a headless run with
 *   no harness named runs V2, except that `--trust-all-tools` takes the interactive default
 *   (V3 on a capable machine, V2 on older-glibc Linux), so "pass `--v2` or `--v3` explicitly so
 *   the pipeline doesn't change when defaults do" (https://kiro.dev/docs/cli/agent-harness/).
 *   V3 needs Kiro CLI 3.0.0 or later. `--v2`, `--v3` or `--agent-engine` in agents.<name>.args
 *   replaces it (they conflict with each other, https://kiro.dev/docs/reference/cli-commands/).
 * - `--trust-all-tools` ("Allow the model to use any tool without confirmation",
 *   https://kiro.dev/docs/reference/cli-commands/) is the project's default profile: full auto
 *   inside the job worktree. Headless runs can't answer approval prompts, so without it a tool
 *   call that needs approval is denied (https://kiro.dev/docs/cli/headless/). `--trust-all-tools`
 *   or `--trust-tools` in agents.<name>.args replaces it, so a narrower profile is e.g.
 *   `args: [--trust-tools=read_file,grep_search]`.
 * - Config args go last.
 *
 * Output: plain text by default. `--output-format stream-json` exists (JSON Lines on stdout,
 * V2/V3 only, https://kiro.dev/docs/cli/headless/), and the docs say a failed run "ends with an
 * error record instead of a completion record", but as of this writing they don't document the
 * records' names or fields. So this adapter doesn't request or parse it; set it in the config
 * args to keep the event stream in run.log, and the exit code still decides.
 *
 * Result: the exit code decides (https://kiro.dev/docs/reference/exit-codes/): 0 "Command
 * completed successfully"; 1 "General failure (auth error, invalid args, operation failed)";
 * 3 an MCP server required by `--require-mcp-startup` did not start; 4 the agent a
 * non-interactive run named is unavailable (possibly after tool calls already ran). "If stdout
 * closes before completion, Kiro exits with a nonzero status" (https://kiro.dev/docs/cli/headless/).
 * The summary is the run's last output lines (the executor's default).
 *
 * Authentication: "Headless mode requires an API key set as the KIRO_API_KEY environment
 * variable" (https://kiro.dev/docs/cli/headless/). The worker passes its environment through, so
 * the key belongs in the worker's runtime environment, not in agents.<name>.env (see docs/agents/kiro.md).
 */
import type { AgentAdapter, AgentExit, AgentInvocation, AgentVerdict, InvocationRequest } from './adapter.js';
import { defaultVerdict } from './adapter.js';
import { hasOption } from './claude.js';

/** The flags that set Kiro's tool-trust profile; any of them in the config's args replaces the default. */
const TRUST_FLAGS = ['--trust-all-tools', '--trust-tools'];
/** The flags that select Kiro's agent harness; any of them in the config's args replaces the default. */
const HARNESS_FLAGS = ['--v3', '--v2', '--agent-engine'];
const NO_INTERACTIVE = '--no-interactive';

/** What Kiro's documented non-zero exit codes mean (https://kiro.dev/docs/reference/exit-codes/). */
const EXIT_MEANINGS: Readonly<Record<number, string>> = {
  1: 'general failure: an auth error, invalid arguments or a failed operation',
  3: 'an MCP server required by --require-mcp-startup did not start',
  4: 'the agent the run named (--agent or chat.defaultAgent) is not available',
};

// CSI and OSC escape sequences, which a CLI may print even when stdout is not a terminal.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The last non-blank line of the output, cleaned of escape sequences and carriage-return redraws. */
export function lastOutputLine(output: string): string | null {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const redraws = lines[i]!.replace(ANSI, '').split('\r');
    const line = (redraws.reverse().find((l) => l.trim()) ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (line) return line;
  }
  return null;
}

export const kiroAdapter: AgentAdapter = {
  name: 'kiro',

  buildInvocation(req: InvocationRequest): AgentInvocation {
    const extra = [...req.extraArgs];
    const args = [...req.launch.args, 'chat'];
    if (!extra.includes(NO_INTERACTIVE)) args.push(NO_INTERACTIVE);
    if (!HARNESS_FLAGS.some((f) => hasOption(extra, f))) args.push('--v3');
    if (!TRUST_FLAGS.some((f) => hasOption(extra, f))) args.push('--trust-all-tools');
    args.push(...extra);
    return { file: req.launch.file, args, promptVia: 'stdin' };
  },

  interpretExit(exit: AgentExit): AgentVerdict {
    const fallback = defaultVerdict(exit);
    if (fallback.outcome === 'succeeded' || exit.code === null) return fallback;
    const meaning = EXIT_MEANINGS[exit.code];
    const said = lastOutputLine(exit.output);
    return {
      outcome: 'failed',
      error: `kiro-cli exited with code ${exit.code}${meaning ? ` (${meaning})` : ''}${said ? `: ${clip(said)}` : ''}`,
    };
  },
};
