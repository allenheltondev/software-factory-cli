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
 *   The adapter is written against Kiro CLI 3.0.0, where V3 is the default harness; `--v3` exists
 *   in some earlier releases too, which are not verified here (discovery and doctor note an older
 *   CLI as a warning). `--v2`, `--v3` or
 *   `--agent-engine` in agents.<name>.args replaces it (they conflict with each other,
 *   https://kiro.dev/docs/reference/cli-commands/).
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
 * The summary is the run's last output lines (the executor's default). A reviewer run's verdict is
 * read from the output with Kiro's own `[LEVEL] [KRS]` log records taken out (finalMessage).
 *
 * Authentication: "Headless mode requires an API key set as the KIRO_API_KEY environment
 * variable" (https://kiro.dev/docs/cli/headless/). The worker passes its environment through, so
 * the key belongs in the worker's runtime environment, not in agents.<name>.env (see docs/agents/kiro.md).
 */
import type { AgentAdapter, AgentExit, AgentInvocation, AgentVerdict, InvocationRequest } from './adapter.js';
import { defaultVerdict } from './adapter.js';
import { failureLine } from '../failure-line.js';
import { hasOption } from './claude.js';

/** The flags that set Kiro's tool-trust profile; any of them in the config's args replaces the default. */
const TRUST_FLAGS = ['--trust-all-tools', '--trust-tools'];
/** The flags that select Kiro's agent harness; any of them in the config's args replaces the default. */
const HARNESS_FLAGS = ['--v3', '--v2', '--agent-engine'];
const NO_INTERACTIVE = '--no-interactive';

/**
 * The Kiro CLI release this adapter is written against: the one that made V3 the default harness.
 * It is a recommended baseline, not a minimum. `--v3`, which the adapter passes by default, also
 * exists in some 2.x releases, and nothing here has been run against them.
 */
export const KIRO_V3_BASELINE_VERSION = '3.0.0';

/** True when agents.<name>.args select the harness themselves, so the adapter adds no `--v3`. */
export function kiroArgsChooseHarness(args: readonly string[]): boolean {
  return HARNESS_FLAGS.some((f) => hasOption(args, f));
}

/**
 * Whether a Kiro CLI version (as discovery parsed it from `kiro-cli --version`) is at the
 * baseline ({@link KIRO_V3_BASELINE_VERSION}) or later: 'unknown' when there is no
 * `major.minor.patch` to read. 'no' means older than the baseline, which is unverified rather
 * than unsupported. Only the numeric part is compared, so a 3.0.0 pre-release counts as 3.0.0.
 */
export function kiroSupportsV3(version: string | null): 'yes' | 'no' | 'unknown' {
  const m = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return 'unknown';
  const have = m.slice(1, 4).map(Number);
  const need = KIRO_V3_BASELINE_VERSION.split('.').map(Number);
  for (let i = 0; i < need.length; i++) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]! ? 'yes' : 'no';
  }
  return 'yes';
}

/**
 * What to tell the user when the Kiro CLI is older than the baseline ('no') or its version could
 * not be read ('unknown'); null when it is at the baseline. Worded as a caution: an older CLI may
 * have `--v3` and work. `argsKey` names the config args to change.
 */
export function kiroV3Problem(version: string | null, supported: 'yes' | 'no' | 'unknown', argsKey = 'agents.<name>.args'): string | null {
  if (supported === 'yes') return null;
  const starts = 'Updraft starts Kiro with --v3';
  const remedy = `If live runs fail to start, upgrade Kiro CLI or add --v2 to ${argsKey}`;
  if (supported === 'no') {
    return (
      `Kiro CLI ${version} is older than ${KIRO_V3_BASELINE_VERSION}, the release Updraft is written against. ${starts}; ` +
      `earlier releases that have the V3 harness may work but are not verified. ${remedy}`
    );
  }
  return `could not read a Kiro CLI version${version ? ` from "${version}"` : ''}, so it is unknown whether it is ${KIRO_V3_BASELINE_VERSION} or later. ${starts}. ${remedy}`;
}

/** What Kiro's documented non-zero exit codes mean (https://kiro.dev/docs/reference/exit-codes/). */
const EXIT_MEANINGS: Readonly<Record<number, string>> = {
  1: 'general failure: an auth error, invalid arguments or a failed operation',
  3: 'an MCP server required by --require-mcp-startup did not start',
  4: 'the agent the run named (--agent or chat.defaultAgent) is not available',
};

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ANSI CSI sequences, which a log record may be wrapped in.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Kiro CLI's own log records, e.g. `[INFO] [KRS] <-- GenerateAssistantResponseCommand done
 * totalEvents=140` (kiro-cli 3.5.0). They go to stderr, which run.log interleaves with stdout, and
 * the last one can land on the same line as the agent's final line when that has no trailing
 * newline: `UPDRAFT-VERDICT: ready-to-merge[INFO] [KRS] <-- ...`. A record runs to the end of its
 * line. Only Kiro's `[KRS]` component with a log level is matched, so ordinary bracketed text in
 * the agent's message is left alone.
 */
const KIRO_LOG_RECORD = /\[(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR)\] \[KRS\][^\r\n]*/g;

/**
 * The output with Kiro's own log records taken out, so that what is left is the agent's text.
 * Taking text out can't create a verdict: the verdict parser still requires exactly one verdict
 * line, with nothing after it, in what remains.
 */
export function stripKiroLogRecords(output: string): string {
  return output.replace(ANSI, '').replace(KIRO_LOG_RECORD, '');
}

export const kiroAdapter: AgentAdapter = {
  name: 'kiro',

  buildInvocation(req: InvocationRequest): AgentInvocation {
    const extra = [...req.extraArgs];
    const args = [...req.launch.args, 'chat'];
    if (!extra.includes(NO_INTERACTIVE)) args.push(NO_INTERACTIVE);
    if (!kiroArgsChooseHarness(extra)) args.push('--v3');
    if (!TRUST_FLAGS.some((f) => hasOption(extra, f))) args.push('--trust-all-tools');
    args.push(...extra);
    return { file: req.launch.file, args, promptVia: 'stdin' };
  },

  interpretExit(exit: AgentExit): AgentVerdict {
    const fallback = defaultVerdict(exit);
    if (fallback.outcome === 'succeeded' || exit.code === null) return fallback;
    const meaning = EXIT_MEANINGS[exit.code];
    const said = failureLine(exit.output);
    return {
      outcome: 'failed',
      error: `kiro-cli exited with code ${exit.code}${meaning ? ` (${meaning})` : ''}${said ? `: ${clip(said)}` : ''}`,
    };
  },

  /**
   * Kiro's output is plain text, so the whole output is the message, minus Kiro's own log records
   * (see {@link stripKiroLogRecords}). Without this, a reviewer run's verdict line can carry a log
   * record on its end and is then not read as a verdict.
   */
  finalMessage(output: string): string {
    return stripKiroLogRecords(output);
  },
};
