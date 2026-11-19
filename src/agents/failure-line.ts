/**
 * Picks the one line of a failed agent command's output that best says why it failed.
 *
 * The first line is often not it: Codex CLI prints "Reading additional input from stdin..." on
 * stderr whenever stdin is not a terminal, and warnings about its config, before the real error
 * (for example "ERROR: You've hit your usage limit. ..."). Claude Code's `--output-format json`
 * prints one JSON object whose `result` holds the error when `is_error` is true.
 *
 * Order of preference: the last line that reads as an error (an `ERROR:` / `error:` / `fatal:`
 * line, or a JSON line carrying an error), then the last ordinary line, then the last warning or
 * other JSON line. Informational banners are never chosen. Empty when nothing qualifies.
 */

// CSI and OSC escape sequences, which a CLI may print even when its output is not a terminal.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Lines that only say what the CLI is doing, never why it failed. */
const BANNERS: readonly RegExp[] = [
  // Codex CLI (0.170.0) when stdin is not a TTY; earlier builds said "Reading prompt from stdin...".
  /^reading (additional input|prompt) from stdin\b/i,
];

/** Lines worth showing only when nothing better was printed. */
const WARNINGS: readonly RegExp[] = [
  /\bcodex is ignoring \d+ unrecognized configuration settings?\b/i,
  /^(\W\s*)?warn(ing)?\b/i,
];

// "ERROR: ...", "error: ...", "Error: ...", "fatal: ...", "[error] ...", and Rust tracing's "... ERROR codex_core::x: ...".
const ERROR_LINE = /(^|[\s[\]:])(error|fatal)\b\s*[:\]]|^error\b/i;
const TRACING_ERROR = /\bERROR\s+[\w:]+:/;

type Ranked = { text: string; rank: 0 | 1 | 2 };

/** Text of an error a JSON line carries, null for JSON that is not an error, undefined when the line is not JSON. */
function jsonError(line: string): string | null | undefined {
  if (!line.startsWith('{')) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const text = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? cleanLine(x) : null);
  // Claude Code: {"type":"result","subtype":"success","is_error":true,"result":"..."}.
  if (o.is_error === true) {
    const errors = Array.isArray(o.errors) ? o.errors.map(text).filter((e): e is string => !!e) : [];
    return text(o.result) ?? errors[0] ?? (typeof o.subtype === 'string' ? `${o.subtype} (is_error)` : 'is_error');
  }
  // Codex --json: {"type":"error","message":"..."} and {"type":"turn.failed","error":{"message":"..."}}.
  if (o.type === 'error') return text(o.message);
  const err = o.error;
  if (err && typeof err === 'object' && !Array.isArray(err)) return text((err as Record<string, unknown>).message);
  if (typeof err === 'string') return text(err);
  // HTTP API error bodies, such as {"detail":"..."}.
  if (typeof o.detail === 'string') return text(o.detail);
  return null;
}

/** The first non-blank line of a (possibly multi-line) string, cleaned. */
function cleanLine(s: string): string {
  for (const raw of s.split('\n')) {
    const line = clean(raw);
    if (line) return line;
  }
  return '';
}

function clean(raw: string): string {
  const redraws = raw.replace(ANSI, '').split('\r');
  return (redraws.reverse().find((l) => l.trim()) ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
}

function rank(line: string): Ranked | null {
  const fromJson = jsonError(line);
  if (fromJson) return { text: fromJson, rank: 0 };
  if (fromJson === null) return { text: line, rank: 2 };
  if (BANNERS.some((b) => b.test(line))) return null;
  if (ERROR_LINE.test(line) || TRACING_ERROR.test(line)) return { text: line, rank: 0 };
  if (WARNINGS.some((w) => w.test(line))) return { text: line, rank: 2 };
  return { text: line, rank: 1 };
}

/** The line of `output` that best explains a failure (see the module comment), or '' when there is none. */
export function failureLine(output: string): string {
  let best: Ranked | null = null;
  for (const raw of output.split('\n')) {
    const line = clean(raw);
    if (!line) continue;
    const r = rank(line);
    // Later lines win ties: the error a CLI ends on is usually the one that stopped it.
    if (r && (!best || r.rank <= best.rank)) best = r;
  }
  return best?.text ?? '';
}

/** The first line of `output` that is not an informational banner or warning, falling back to the first warning. */
export function firstMeaningfulLine(output: string): string {
  let warning = '';
  for (const raw of output.split('\n')) {
    const line = clean(raw);
    if (!line || BANNERS.some((b) => b.test(line))) continue;
    if (WARNINGS.some((w) => w.test(line))) {
      warning ||= line;
      continue;
    }
    return line;
  }
  return warning;
}
