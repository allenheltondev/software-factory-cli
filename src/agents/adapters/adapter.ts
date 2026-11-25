/**
 * The contract between live execution (src/worker/live.ts) and one coding-agent CLI.
 *
 * An adapter only describes its CLI: how to invoke it headlessly for one prompt, and how to read
 * the result. The executor owns everything else, identically for every agent: locating the CLI
 * (discovery, or agents.<name>.command), the worktree, spawning without a shell in its own process
 * group, recording the pid and its OS start time, stdout/stderr capture into run.log, the timeout,
 * shutdown, and the post-run summary.
 *
 * Rules for implementations:
 * - Never put prompt or issue text in `args`. Deliver the prompt file on stdin (`promptVia: 'stdin'`)
 *   or pass its path (`promptVia: 'file-arg'`). The file holds untrusted issue text.
 * - Build on `launch`: on Windows it is the resolved target of an npm `.cmd` shim (for example
 *   `node.exe` with the CLI's script in `launch.args`), never the shim itself.
 * - Be pure: no I/O in buildInvocation; the executor may call it before anything is spawned.
 */
import type { LaunchSpec } from '../discovery.js';

export interface InvocationRequest {
  /** Spawn target for the agent CLI: `launch.file` with `launch.args` before the adapter's own arguments. */
  launch: LaunchSpec;
  /** Absolute path of the rendered prompt (UTF-8 Markdown) in the run directory. */
  promptFile: string;
  /** The job's worktree. The agent runs with this as its working directory. */
  worktree: string;
  /** The run's directory (run.log, prompt.md). An adapter may name extra output files here. */
  runDir: string;
  /** agents.<name>.args from the config; the adapter places them where its CLI accepts options. */
  extraArgs: readonly string[];
  platform: NodeJS.Platform;
}

export interface AgentInvocation {
  /** Executable to spawn directly, never through a shell. */
  file: string;
  args: string[];
  /**
   * How the prompt reaches the agent. 'stdin': the prompt file is opened as the agent's stdin.
   * 'file-arg': `args` contains `promptFile`, and stdin is closed.
   */
  promptVia: 'stdin' | 'file-arg';
  /** Variables the adapter needs set. Applied over the worker's environment; agents.<name>.env wins over these. */
  env?: Record<string, string>;
  /**
   * Keep the agent's stderr apart from its stdout. Normally both go to run.log through one file
   * descriptor, so their writes interleave in no guaranteed order and a line of one can end up
   * glued to a line of the other. With this set, stderr goes to a file of its own while the agent
   * runs. The verdict and {@link AgentAdapter.finalMessage} then see stdout alone, and the stderr
   * is appended to run.log, under its own header, once the agent has exited. For CLIs that log to
   * stderr while writing their answer to stdout.
   */
  separateStderr?: boolean;
}

/** How the agent process ended on its own (not timed out, not stopped by the worker). */
export interface AgentExit {
  /** Exit code, or null when a signal ended it. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /**
   * The last lines of the agent's combined stdout and stderr, cleaned and capped for display.
   * With {@link AgentInvocation.separateStderr}, the last lines of its stdout.
   */
  outputTail: string[];
  /**
   * The agent's raw combined stdout and stderr from run.log: all of it, or its last
   * {@link RAW_OUTPUT_BYTES} bytes starting at a line boundary. For adapters that parse
   * structured output (lines are not cut or cleaned here). The line the window starts in is
   * left out, so a line is either complete here or absent, never partial. With
   * {@link AgentInvocation.separateStderr}, its stdout followed by its stderr, each read the same way.
   */
  output: string;
  /** The arguments the agent ran with (InvocationResult.args), so an adapter knows which output mode was in effect. */
  args: readonly string[];
}

/** How much of the agent's raw output {@link AgentExit.output} and {@link AgentAdapter.summarizeOutput} see. */
export const RAW_OUTPUT_BYTES = 16 * 1024 * 1024;

/** What a triage launch (src/triage) asks of an adapter: the CLI, and the profile args the user configured. */
export interface TriageInvocationRequest {
  launch: LaunchSpec;
  /** agents.<name>.args (and model/effort) from the config. Settings that widen access are refused. */
  extraArgs: readonly string[];
  platform: NodeJS.Platform;
}

/** How tightly a triage launch is confined; see docs/triage.md. */
export type TriageIsolation =
  /** The CLI is started with its tools turned off. */
  | 'no-tools'
  /** Tools exist but the CLI's own sandbox or approval policy blocks writes and commands. */
  | 'read-only'
  /** The adapter withholds trust for tools, but cannot promise the CLI has no read-only tool. */
  | 'best-effort';

export interface AgentVerdict {
  outcome: 'succeeded' | 'failed';
  /** Why the run failed, for the job's status reason. */
  error?: string;
}

export interface AgentAdapter {
  /** The adapter name agents.<name>.adapter refers to (e.g. "claude"). */
  readonly name: string;
  buildInvocation(req: InvocationRequest): AgentInvocation;
  /** Map the exit to an outcome. Defaults to {@link defaultVerdict}: exit 0 succeeds, anything else fails. */
  interpretExit?(exit: AgentExit): AgentVerdict;
  /**
   * Lines for the run summary's "last agent output", read from the agent's raw output (see
   * {@link AgentExit.output}): typically the agent's final message. Called for every run whose
   * agent started, including timed-out and interrupted ones. Return null (or nothing) to use the
   * generic last lines of output. The executor strips control characters and caps the lines.
   */
  summarizeOutput?(output: string): string[] | null;
  /**
   * The model the agent CLI itself reported in its raw output (see {@link AgentExit.output}) for
   * the run's main conversation, or null when it reported none. Only what the output says: never
   * the configured model, and nothing for a CLI whose output does not name one. Absent: the
   * adapter's output never names a model.
   */
  observedModel?(output: string): string | null;
  /**
   * The agent's own final message and nothing else (no status line, no tool output), read from
   * its raw output. A reviewer run's verdict is parsed from this. Null: the output is structured
   * but holds no final message (the run did not end normally). Undefined, or no such method: the
   * output is plain text, and the whole of it is the message.
   */
  finalMessage?(output: string): string | null | undefined;
  /**
   * Opt-in triage (src/triage): the invocation for one read-only classification run, the prompt
   * on stdin, in the same output mode as {@link buildInvocation} so {@link finalMessage} reads
   * the answer. Never grants write access; throws an Error (shown as the fallback reason) when
   * the configured args would. Absent: this adapter cannot triage.
   */
  buildTriageInvocation?(req: TriageInvocationRequest): AgentInvocation;
  /** How tightly {@link buildTriageInvocation} confines the run. */
  readonly triageIsolation?: TriageIsolation;
}

export function defaultVerdict(exit: AgentExit): AgentVerdict {
  if (exit.code === 0) return { outcome: 'succeeded' };
  if (exit.code !== null) return { outcome: 'failed', error: `agent exited with code ${exit.code}` };
  return { outcome: 'failed', error: `agent was ended by ${exit.signal ?? 'an unknown signal'}` };
}
