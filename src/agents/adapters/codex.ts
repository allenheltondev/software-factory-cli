/**
 * Codex adapter: one headless `codex exec` run per job, prompt on stdin.
 *
 * Invocation (`launch` is the resolved CLI, e.g. node + bin/codex.js behind the npm shim on Windows):
 *
 *   <launch> exec --json --dangerously-bypass-approvals-and-sandbox <agents.<name>.args>
 *
 * Sources. developers.openai.com/codex/* now redirects (308) to learn.chatgpt.com/docs/*; both are
 * OpenAI's own docs, and the redirect targets are given where the page moved.
 * - Non-interactive mode, https://developers.openai.com/codex/noninteractive
 *   (-> https://learn.chatgpt.com/docs/non-interactive-mode): `codex exec` reads the prompt from
 *   stdin when no prompt argument is given ("Use `-` to pipe the prompt from stdin" in the CLI
 *   reference; `codex exec --help` 0.104.0: "If not provided as an argument (or if `-` is used),
 *   instructions are read from stdin"). The executor opens prompt.md as stdin and no prompt
 *   argument is passed, so no prompt text is ever on the command line. The official TypeScript
 *   SDK runs `codex exec --experimental-json` the same way, writing the prompt to stdin
 *   (https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts).
 * - `--json` (alias `--experimental-json`): "stdout becomes a JSON Lines (JSONL) stream" of
 *   events (non-interactive mode page, "Make output machine-readable"; CLI reference
 *   https://developers.openai.com/codex/cli/reference -> https://learn.chatgpt.com/docs/developer-commands?surface=cli).
 *   Without it, progress goes to stderr and only the final message to stdout. The event shapes
 *   are `ThreadEvent` in https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
 *   and https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts ("based on event
 *   types from codex-rs/exec/src/exec_events.rs"): `thread.started` {thread_id},
 *   `turn.started`, `turn.completed` {usage}, `turn.failed` {error: {message}},
 *   `item.started|updated|completed` {item}, and `error` {message}. The final response is the
 *   text of the last completed `agent_message` item (the SDK's `Thread.run` reads it that way).
 * - `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`): "No sandbox; no approvals"
 *   (https://developers.openai.com/codex/agent-approvals-security
 *   -> https://learn.chatgpt.com/docs/agent-approvals-security; CLI reference: "only use inside
 *   an isolated runner"). It is the project's default profile, full auto inside the job worktree.
 *   The sandboxed alternative OpenAI recommends for non-interactive runs, `--sandbox
 *   workspace-write`, keeps "`<writable_root>/.git` ... read-only whether it appears as a
 *   directory or file", and the `gitdir:` target of a `.git` pointer file too (same page, and
 *   https://github.com/openai/codex/blob/main/codex-rs/core/README.md). A job worktree's `.git`
 *   is such a pointer file, so a sandboxed Codex could edit files but not commit them. Any
 *   sandbox or approval flag in agents.<name>.args (see PERMISSION_FLAGS) replaces the default.
 *   `--full-auto` still exists in codex-cli 0.104.0, but the current docs say it "is no longer
 *   supported".
 * - Config args go last: options such as `--image <FILE>...` take several values and would
 *   swallow anything after them. The exception is `--ask-for-approval` / `-a`, a top-level option
 *   that `codex exec` rejects; it goes before `exec` (see splitGlobalArgs).
 *
 * Result: the docs don't state exit codes. The exec source exits 1 when the turn fails or is
 * interrupted, or a non-retried error was reported, "for automation-friendly signaling"
 * (https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs, and its JSONL output in
 * codex-rs/exec/src/event_processor_with_jsonl_output.rs), and the SDK treats any non-zero exit
 * or `turn.failed` as a failure. So a run succeeds only when Codex exits 0 after a
 * `turn.completed` event. `turn.failed` fails with its message; an `error` event alone does not
 * decide anything (Codex also reports errors it is about to retry that way). With `--json`, a run
 * that exits 0 without a readable `turn.completed` / `turn.failed` fails. Only the documented
 * fields above are read here.
 */
import type { AgentAdapter, AgentExit, AgentInvocation, AgentVerdict, InvocationRequest } from './adapter.js';
import { defaultVerdict } from './adapter.js';

/** Long flags that set Codex's sandbox or approval policy; any of them in the config's args replaces the default. */
const PERMISSION_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--sandbox',
  '--ask-for-approval',
  '--full-auto',
  '--approve-for-me',
  '--not-so-yolo',
];
/** Short forms: `-s <mode>` (--sandbox) and `-a <policy>` (--ask-for-approval). */
const PERMISSION_SHORT_FLAGS = ['-s', '-a'];
/** Config keys that set the same policies through `-c key=value`. */
const PERMISSION_CONFIG_KEYS = ['sandbox_mode', 'approval_policy'];
const JSON_FLAGS = ['--json', '--experimental-json'];
const BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

/** Does `args` set option `name`, as `--name value` or `--name=value`? */
function hasOption(args: readonly string[], name: string): boolean {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}

/** Does `args` set short option `flag` (`-s value`, `-s=value` or `-svalue`)? */
function hasShortOption(args: readonly string[], flag: string): boolean {
  return args.some((a) => a.startsWith(flag) && !a.startsWith('--'));
}

/** The keys set with `-c` / `--config` in `args` (`-c key=value`, `-ckey=value`, `--config=key=value`). */
export function configKeys(args: readonly string[]): string[] {
  const keys: string[] = [];
  args.forEach((a, i) => {
    let value: string | undefined;
    if (a === '-c' || a === '--config') value = args[i + 1];
    else if (a.startsWith('--config=')) value = a.slice('--config='.length);
    else if (a.startsWith('-c') && !a.startsWith('--')) value = a.slice(2).replace(/^=/, '');
    const eq = value?.indexOf('=') ?? -1;
    if (value && eq > 0) keys.push(value.slice(0, eq).trim());
  });
  return keys;
}

/** Does `args` set Codex's sandbox or approval policy? */
export function setsPermissions(args: readonly string[]): boolean {
  return (
    PERMISSION_FLAGS.some((f) => hasOption(args, f)) ||
    PERMISSION_SHORT_FLAGS.some((f) => hasShortOption(args, f)) ||
    configKeys(args).some((k) => PERMISSION_CONFIG_KEYS.includes(k))
  );
}

/**
 * Split config args into options that belong before the `exec` subcommand and the rest.
 * `--ask-for-approval` / `-a` is a top-level `codex` option: `codex exec` rejects it as an
 * unexpected argument (checked with codex-cli 0.167.0-alpha.4), while `codex --ask-for-approval
 * never exec` accepts it. Everything else keeps its order, after the adapter's own flags.
 */
export function splitGlobalArgs(args: readonly string[]): { global: string[]; rest: string[] } {
  const global: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--ask-for-approval' || a === '-a') {
      global.push(a, ...(i + 1 < args.length ? [args[++i]!] : []));
    } else if (a.startsWith('--ask-for-approval=') || (a.startsWith('-a') && !a.startsWith('--'))) {
      global.push(a);
    } else {
      rest.push(a);
    }
  }
  return { global, rest };
}

/** Was the run's output JSONL (`--json` or its alias)? */
export function jsonMode(args: readonly string[]): boolean {
  return args.some((a) => JSON_FLAGS.includes(a));
}

/** A `turn.completed` or `turn.failed` event: how Codex reports the end of the turn. */
interface TurnEnd {
  type: 'turn.completed' | 'turn.failed';
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function parseLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parsed JSONL events, newest first, plus the output lines that are not JSON (stderr, warnings). */
function scan(output: string): { events: Record<string, unknown>[]; text: string[] } {
  const events: Record<string, unknown>[] = [];
  const text: string[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const ev = parseLine(line);
    if (ev && typeof ev.type === 'string') events.push(ev);
    else if (line.trim()) text.push(line.trim());
  }
  return { events, text };
}

/**
 * The last `turn.completed` / `turn.failed` event in the output, looking back past anything
 * printed after it (stderr warnings). Only complete lines reach the adapter, so an event cut off
 * at the start of the output window is simply absent.
 */
export function findTurnEnd(output: string): TurnEnd | null {
  let end = output.length;
  while (end > 0) {
    const start = output.lastIndexOf('\n', end - 1) + 1;
    const line = output.slice(start, end);
    if (line.includes('"turn.')) {
      const ev = parseLine(line);
      if (ev && (ev.type === 'turn.completed' || ev.type === 'turn.failed')) return ev as unknown as TurnEnd;
    }
    end = start - 1;
  }
  return null;
}

const firstLine = (s: string | undefined) => (s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Text of the newest completed agent message (the final response, as the SDK reads it). */
function lastAgentMessage(events: Record<string, unknown>[]): string | null {
  for (const ev of events) {
    if (ev.type !== 'item.completed') continue;
    const item = ev.item as { type?: unknown; text?: unknown } | undefined;
    if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  }
  return null;
}

/** Message of the newest top-level `error` event. */
function lastError(events: Record<string, unknown>[]): string | null {
  for (const ev of events) {
    if (ev.type === 'error' && typeof ev.message === 'string' && ev.message.trim()) return ev.message;
  }
  return null;
}

function threadId(events: Record<string, unknown>[]): string | null {
  const ev = events.find((e) => e.type === 'thread.started' && typeof e.thread_id === 'string');
  return ev ? (ev.thread_id as string) : null;
}

function tokens(end: TurnEnd): string | null {
  const u = end.usage;
  if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  const cached = typeof u.cached_input_tokens === 'number' && u.cached_input_tokens > 0 ? ` (${u.cached_input_tokens} cached)` : '';
  return `${u.input_tokens} input tokens${cached}, ${u.output_tokens} output tokens`;
}

function failureMessage(end: TurnEnd): string {
  return clip(firstLine(end.error?.message)) || 'turn failed';
}

export const codexAdapter: AgentAdapter = {
  name: 'codex',

  buildInvocation(req: InvocationRequest): AgentInvocation {
    const extra = [...req.extraArgs];
    const { global, rest } = splitGlobalArgs(extra);
    const args = [...req.launch.args, ...global, 'exec'];
    if (!jsonMode(extra)) args.push('--json');
    if (!setsPermissions(extra)) args.push(BYPASS_FLAG);
    args.push(...rest);
    return { file: req.launch.file, args, promptVia: 'stdin' };
  },

  interpretExit(exit: AgentExit): AgentVerdict {
    const end = findTurnEnd(exit.output);
    if (end?.type === 'turn.failed') return { outcome: 'failed', error: `codex turn failed: ${failureMessage(end)}` };
    if (end?.type === 'turn.completed') {
      if (exit.code === 0) return { outcome: 'succeeded' };
      const how = exit.code !== null ? `exited with code ${exit.code}` : `was ended by ${exit.signal ?? 'a signal'}`;
      const err = lastError(scan(exit.output).events);
      return { outcome: 'failed', error: `codex completed its turn but ${how}${err ? `: ${clip(firstLine(err))}` : ''}` };
    }
    const fallback = defaultVerdict(exit);
    if (fallback.outcome === 'succeeded') {
      if (!jsonMode(exit.args)) return fallback;
      return {
        outcome: 'failed',
        error: 'codex exited with code 0, but no turn.completed or turn.failed event could be read from its --json output (none was printed, or it was too large to read)',
      };
    }
    // An interrupted turn, a fatal error, or a bad flag before the run started (printed on stderr).
    const { events, text } = scan(exit.output);
    const said = lastError(events) ?? text[0];
    return { outcome: 'failed', error: `${fallback.error} before finishing its turn${said ? `: ${clip(firstLine(said))}` : ''}` };
  },

  /**
   * The final message (the last completed agent message), then a status line with how the turn
   * ended, token usage and the thread id (so the session can be inspected with
   * `codex resume <id>` in the worktree). A failed turn adds its error after what Codex last said.
   */
  finalMessage(output: string): string | null | undefined {
    const { events } = scan(output);
    // No JSON at all: --json was turned off in agents.<name>.args, and the output is plain text.
    if (!events.length) return undefined;
    return findTurnEnd(output)?.type === 'turn.completed' ? lastAgentMessage(events) : null;
  },

  summarizeOutput(output: string): string[] | null {
    const { events } = scan(output);
    if (!events.length) return null;
    const said = lastAgentMessage(events);
    const thread = threadId(events);
    const threadPart = thread ? `thread ${thread}` : null;
    const end = findTurnEnd(output);
    const body = said ? said.split(/\r?\n/) : [];
    if (end?.type === 'turn.completed') {
      return [...body, ['codex: turn completed', tokens(end), threadPart].filter(Boolean).join(', ')];
    }
    if (end?.type === 'turn.failed') {
      return [...body, ...(end.error?.message ?? '').split(/\r?\n/).filter((l) => l.trim()), ['codex: turn failed', threadPart].filter(Boolean).join(', ')];
    }
    return [...body, ['codex: no turn result', threadPart].filter(Boolean).join(', ')];
  },
};
