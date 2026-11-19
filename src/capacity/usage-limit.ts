/**
 * Best-effort classification of a failed agent CLI exit: did the subscription run out of
 * allowance, or did something else go wrong?
 *
 * Only text a CLI actually printed on exit is looked at (never a model's prose about limits in a
 * successful run, never HTTP calls of our own). The phrases below are what Claude Code, Codex CLI
 * and Kiro CLI print today; they are best effort and can change with CLI versions, which is why an
 * unrecognized failure is always `other` and keeps today's behavior (a plain failed run). Auth
 * failures are recognized first and never count as quota exhaustion.
 *
 * Pure: no I/O.
 */

export type CliFailureKind = 'usage-limit' | 'auth' | 'other';

export interface CliFailure {
  kind: CliFailureKind;
  /** The matched line, cleaned and capped, for status and logs. */
  detail: string;
  /** usage-limit only: milliseconds until the CLI says the allowance returns, when it said so reliably. */
  retryAfterMs?: number;
}

const AUTH: readonly RegExp[] = [
  /not (logged|signed) in/i,
  /please (run )?\/?(login|log in|sign in)/i,
  /\b(invalid|missing|expired) (api key|token|credentials|authentication)/i,
  /authentication (failed|error|required)/i,
  /\b401\b.*unauthori[sz]ed|unauthori[sz]ed.*\b401\b/i,
  /\bnot authenticated\b/i,
  /\brun `?(claude|codex|kiro-cli|kiro) (login|auth)/i,
];

const USAGE_LIMIT: readonly RegExp[] = [
  /usage limit/i,
  /you(?:'|’)ve hit your (?:\w+ )?limit/i,
  /\b(?:5-hour|five-hour|weekly|monthly|daily) limit (?:reached|exceeded|hit)/i,
  /\blimit reached\b.*\b(?:resets?|try again)/i,
  /\brate[- ]limit(?:ed)?\b/i,
  /\btoo many requests\b/i,
  /\b(?:http|status|error|code)\W{0,3}429\b/i,
  /\bquota (?:exceeded|exhausted|reached)\b/i,
  /\b(?:out of|no more|insufficient) (?:credits|requests)\b/i,
  /\bmonthly request limit\b/i,
];

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  second: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

/** "2 hours 30 minutes", "1 day 3 hrs", "45m": the total in ms, or undefined when no duration is stated. */
function parseDuration(text: string): number | undefined {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\b/gi)) {
    const unit = m[2]!.toLowerCase().replace(/s$/, '');
    const ms = UNIT_MS[unit];
    if (ms === undefined) continue;
    total += Number(m[1]) * ms;
    found = true;
  }
  return found && total > 0 ? Math.round(total) : undefined;
}

/**
 * A retry delay the CLI stated plainly: a `Retry-After: <seconds>` header, "try again in <duration>"
 * / "resets in <duration>", or Claude's legacy `...limit reached|<unix seconds>`. Anything vaguer
 * (a clock time without a date or zone, "later") is not reliable and yields undefined.
 */
function retryAfter(line: string, nowMs: number): number | undefined {
  const header = /retry-after\s*[:=]\s*(\d+)\b/i.exec(line);
  if (header) return Number(header[1]) * 1000;
  const rel = /(?:try again|retry|resets?|available again|wait)\s+in\s+([^.;,)]*?(?:\d[^.;,)]*))/i.exec(line);
  if (rel) {
    const d = parseDuration(rel[1]!);
    if (d !== undefined) return d;
  }
  const epoch = /limit reached\|(\d{10})\b/i.exec(line);
  if (epoch) {
    const at = Number(epoch[1]) * 1000;
    return at > nowMs ? at - nowMs : undefined;
  }
  return undefined;
}

const clean = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();

/** Lines worth testing: plain lines, and the text fields of JSON error lines (Claude/Codex `--json`). */
function candidateLines(output: string): string[] {
  const out: string[] = [];
  for (const raw of output.split('\n')) {
    const line = clean(raw);
    if (!line) continue;
    out.push(line);
    if (line.startsWith('{')) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        for (const v of [o.result, o.message, o.error, (o.error as Record<string, unknown> | undefined)?.message, o.detail]) {
          if (typeof v === 'string' && v.trim()) out.push(clean(v));
        }
      } catch {
        /* not JSON; the plain line stands */
      }
    }
  }
  return out;
}

/**
 * Classify the output of an agent CLI that exited unsuccessfully. `adapter` is only used to name
 * the CLI in the detail today; the phrase lists are shared because the three CLIs overlap and a
 * false negative merely leaves the run an ordinary failure.
 */
export function classifyCliFailure(adapter: string, output: string, nowMs: number = Date.now()): CliFailure {
  void adapter;
  const lines = candidateLines(output);
  // The error a CLI ends on is the one that stopped it: scan from the last line backwards.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (AUTH.some((r) => r.test(line)) && !USAGE_LIMIT.some((r) => r.test(line))) {
      return { kind: 'auth', detail: line.slice(0, 200) };
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (USAGE_LIMIT.some((r) => r.test(line))) {
      const after = retryAfter(line, nowMs) ?? retryAfter(lines.slice(i, i + 3).join(' '), nowMs);
      return { kind: 'usage-limit', detail: line.slice(0, 200), ...(after !== undefined ? { retryAfterMs: after } : {}) };
    }
  }
  return { kind: 'other', detail: '' };
}
