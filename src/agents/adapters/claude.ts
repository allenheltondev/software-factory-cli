/**
 * Claude Code adapter: one headless `claude -p` run per job, prompt on stdin.
 *
 * Invocation (`launch` is the resolved CLI, e.g. node + cli.js behind the npm shim on Windows):
 *
 *   <launch> -p --output-format stream-json --verbose --permission-mode bypassPermissions <agents.<name>.args>
 *
 * - `-p` / `--print` runs non-interactively; with no prompt argument it reads the prompt from
 *   stdin ("Non-interactive mode reads stdin", https://code.claude.com/docs/en/headless#pipe-data-through-claude;
 *   `cat file | claude -p` in https://code.claude.com/docs/en/cli-reference). The executor opens
 *   prompt.md as stdin, so no prompt text is ever on the command line.
 * - `--output-format stream-json` writes one JSON event per line as the run goes, so run.log is a
 *   transcript even when the run times out, and "the last line of the stream is a `result`
 *   message" (https://code.claude.com/docs/en/headless#stream-responses). The headless docs pair
 *   it with `--verbose`.
 * - `--permission-mode bypassPermissions` (the documented equivalent of
 *   `--dangerously-skip-permissions`, https://code.claude.com/docs/en/cli-reference) is the
 *   project's default profile: full auto inside the job worktree. A permission mode or
 *   `--dangerously-skip-permissions` in agents.<name>.args replaces it, so a narrower profile is
 *   e.g. `args: [--permission-mode, acceptEdits, --allowedTools, "Bash(npm test *)"]`.
 *   Claude Code refuses bypassPermissions as root on Linux and macOS
 *   (https://code.claude.com/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode).
 * - Config args go last: options such as `--allowedTools <tools...>` are variadic and would
 *   swallow anything after them.
 *
 * Result: Claude Code "exits with code 0 on success and a non-zero code when the run fails", and a
 * failure inside the run (such as missing authentication) is printed as the result
 * (https://code.claude.com/docs/en/headless#basic-usage). The result message's shape is
 * `SDKResultMessage` in https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage:
 * `subtype` "success" (with `result`, the final text, and `is_error`) or one of
 * "error_max_turns" | "error_during_execution" | "error_max_budget_usd" |
 * "error_max_structured_output_retries" (with `errors: string[]`); both carry `session_id`,
 * `num_turns`, `total_cost_usd`, `permission_denials` and optionally `terminal_reason`.
 * Only those documented fields are read here. With a JSON output format, a run that exits 0
 * without a readable result fails; with `--output-format text` in the config args, the exit
 * code decides.
 */
import type { AgentAdapter, AgentExit, AgentInvocation, AgentVerdict, InvocationRequest } from './adapter.js';
import { defaultVerdict } from './adapter.js';
import { failureLine } from '../failure-line.js';

/** The flags that set Claude Code's permission profile; any of them in the config's args replaces the default. */
const PERMISSION_FLAGS = ['--permission-mode', '--dangerously-skip-permissions'];
const OUTPUT_FORMAT_FLAG = '--output-format';

/** Does `args` set option `name`, as `--name value` or `--name=value`? */
export function hasOption(args: readonly string[], name: string): boolean {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}

/** The documented fields of a stream-json `result` message that this adapter reads. */
interface ResultMessage {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
  api_error_status?: number | null;
  terminal_reason?: string;
  permission_denials?: Array<{ tool_name?: string }>;
}

/** A stream-json `assistant` message (SDKAssistantMessage): `message` is an API message with `content` blocks. */
interface AssistantMessage {
  type: 'assistant';
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: Array<{ type?: string; text?: string }> };
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

/** Parsed stream-json events, newest first, plus the output lines that are not JSON (stderr, warnings). */
function scan(output: string): { events: Record<string, unknown>[]; text: string[] } {
  const events: Record<string, unknown>[] = [];
  const text: string[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const ev = parseLine(line);
    if (ev) events.push(ev);
    else if (line.trim()) text.push(line.trim());
  }
  return { events, text };
}

function isResult(ev: Record<string, unknown>): ev is Record<string, unknown> & ResultMessage {
  return ev.type === 'result' && typeof ev.subtype === 'string';
}

/**
 * The last `result` message in the output (a run whose background work starts another turn
 * prints one per turn), looking back past anything printed after it, such as stderr diagnostics.
 * Only complete lines reach the adapter, and the output window is a suffix of run.log, so when
 * the last result is too long to fit, every earlier result is outside the window too: the run
 * then has no result, and can't be mistaken for an earlier turn's.
 */
export function findResult(output: string): ResultMessage | null {
  let end = output.length;
  while (end > 0) {
    const start = output.lastIndexOf('\n', end - 1) + 1;
    const line = output.slice(start, end);
    if (line.includes('"result"')) {
      const ev = parseLine(line);
      if (ev && isResult(ev)) return ev;
    }
    end = start - 1;
  }
  return null;
}

/** The `--output-format` in effect: the last one in `args`, else Claude Code's default, text. */
export function outputFormat(args: readonly string[]): string {
  let format = 'text';
  args.forEach((a, i) => {
    if (a === OUTPUT_FORMAT_FLAG && i + 1 < args.length) format = args[i + 1]!;
    else if (a.startsWith(`${OUTPUT_FORMAT_FLAG}=`)) format = a.slice(OUTPUT_FORMAT_FLAG.length + 1);
  });
  return format;
}

const firstLine = (s: string | undefined) => (s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function turns(r: ResultMessage): string {
  return typeof r.num_turns === 'number' ? ` after ${r.num_turns} turn${r.num_turns === 1 ? '' : 's'}` : '';
}

function cost(r: ResultMessage): string | null {
  return typeof r.total_cost_usd === 'number' ? `$${r.total_cost_usd.toFixed(2)} estimated` : null;
}

function reason(r: ResultMessage): string {
  return r.terminal_reason ? ` (${r.terminal_reason})` : '';
}

/** Why a result counts as a failure, or null when it reports success. */
function resultError(r: ResultMessage): string | null {
  switch (r.subtype) {
    case 'success': {
      if (!r.is_error) return null;
      const status = typeof r.api_error_status === 'number' ? ` (API status ${r.api_error_status})` : '';
      const what = clip(firstLine(r.result));
      return `claude reported an error${status}${reason(r)}${what ? `: ${what}` : ''}`;
    }
    case 'error_max_turns':
      return `claude stopped at its turn limit (--max-turns)${turns(r)}`;
    case 'error_max_budget_usd':
      return `claude stopped at its spending limit (--max-budget-usd)${cost(r) ? ` at ${cost(r)}` : ''}`;
    case 'error_during_execution': {
      const errs = (r.errors ?? []).filter((e) => typeof e === 'string' && e.trim());
      return `claude failed during execution${reason(r)}${errs.length ? `: ${clip(errs.map((e) => firstLine(e)).join('; '))}` : ''}`;
    }
    case 'error_max_structured_output_retries':
      return 'claude could not produce valid structured output';
    default:
      return `claude ended with ${r.subtype}${reason(r)}`;
  }
}

/** One line describing the result, for the end of the run summary (and `updraft status`). */
function statusLine(r: ResultMessage): string {
  const parts = [`claude: ${r.subtype}${r.subtype === 'success' && r.is_error ? ' (is_error)' : ''}${turns(r)}`];
  const c = cost(r);
  if (c) parts.push(c);
  const denials = (r.permission_denials ?? []).map((d) => d?.tool_name).filter((n): n is string => typeof n === 'string');
  if (denials.length) parts.push(`${denials.length} permission denial(s): ${[...new Set(denials)].join(', ')}`);
  if (r.session_id) parts.push(`session ${r.session_id}`);
  return parts.join(', ');
}

/** Text of the newest main-conversation assistant message that has any (subagent messages carry a parent_tool_use_id). */
function lastAssistantText(events: Record<string, unknown>[]): string | null {
  for (const ev of events) {
    if (ev.type !== 'assistant') continue;
    const m = ev as unknown as AssistantMessage;
    if (m.parent_tool_use_id) continue;
    const text = (m.message?.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return null;
}

export const claudeAdapter: AgentAdapter = {
  name: 'claude',

  buildInvocation(req: InvocationRequest): AgentInvocation {
    const extra = [...req.extraArgs];
    const args = [...req.launch.args, '-p'];
    if (!hasOption(extra, OUTPUT_FORMAT_FLAG)) args.push(OUTPUT_FORMAT_FLAG, 'stream-json', '--verbose');
    if (!PERMISSION_FLAGS.some((f) => hasOption(extra, f))) args.push('--permission-mode', 'bypassPermissions');
    args.push(...extra);
    return { file: req.launch.file, args, promptVia: 'stdin' };
  },

  interpretExit(exit: AgentExit): AgentVerdict {
    const result = findResult(exit.output);
    if (!result) {
      const fallback = defaultVerdict(exit);
      if (fallback.outcome === 'succeeded') {
        // Only plain text output (chosen in agents.<name>.args) has no result to read.
        const format = outputFormat(exit.args);
        if (format === 'text') return fallback;
        return {
          outcome: 'failed',
          error: `claude exited with code 0, but no result message could be read from its ${format} output (none was printed, or it was too large to read)`,
        };
      }
      // Typically a bad flag or a crash before the run started; Claude Code prints those on stderr.
      const said = failureLine([...scan(exit.output).text].reverse().join('\n'));
      return { outcome: 'failed', error: `${fallback.error} before reporting a result${said ? `: ${clip(said)}` : ''}` };
    }
    const error = resultError(result);
    if (error) return { outcome: 'failed', error };
    if (exit.code === 0) return { outcome: 'succeeded' };
    return {
      outcome: 'failed',
      error: `claude reported success but ${exit.code !== null ? `exited with code ${exit.code}` : `was ended by ${exit.signal ?? 'a signal'}`}`,
    };
  },

  /**
   * The final message (the result's `result` text; for an error result, the last thing Claude
   * said and the result's `errors`), then a status line with the
   * result subtype, turns, estimated cost, permission denials and session id (so the session can
   * be inspected with `claude --resume <id>` in the worktree). Without a result (timeout, crash),
   * the last thing Claude said and the session id.
   */
  finalMessage(output: string): string | null | undefined {
    const result = findResult(output);
    if (result) return result.subtype === 'success' && !result.is_error && typeof result.result === 'string' ? result.result : null;
    // No JSON at all: plain text output was chosen in agents.<name>.args.
    return scan(output).events.length ? null : undefined;
  },

  summarizeOutput(output: string): string[] | null {
    const { events } = scan(output);
    const result = findResult(output);
    if (result) {
      const body =
        result.subtype === 'success'
          ? (result.result ?? '')
          : [lastAssistantText(events) ?? '', ...(result.errors ?? []).filter((e) => typeof e === 'string')].join('\n');
      return [...body.split(/\r?\n/), statusLine(result)];
    }
    if (!events.length) return null;
    const said = lastAssistantText(events);
    const session = events.map((e) => e.session_id).find((id): id is string => typeof id === 'string');
    return [
      ...(said ? said.split(/\r?\n/) : []),
      `claude: no result message${session ? `, session ${session}` : ''}`,
    ];
  },
};
