import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Minimum level; defaults to UPDRAFT_LOG_LEVEL (debug|info|warn|error), else info. */
  level?: LogLevel;
  /** JSON-lines log file. Created on first write. */
  file?: string;
  /** Human-readable output; defaults to process.stderr. Pass null to silence. */
  stream?: NodeJS.WritableStream | null;
  base?: LogFields;
  /** Force color on or off for the human-readable stream; unset detects it (see {@link resolveColor}). */
  color?: boolean;
  /** Environment used for level and color detection; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Longest field value shown on the console; the JSONL file always keeps the full value. */
const MAX_FIELD_CHARS = 160;

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

function levelFromEnv(env: NodeJS.ProcessEnv): LogLevel | undefined {
  const v = env.UPDRAFT_LOG_LEVEL?.trim().toLowerCase();
  return v && v in ORDER ? (v as LogLevel) : undefined;
}

/**
 * Whether to colorize the human-readable stream. Precedence: explicit option, UPDRAFT_COLOR
 * (always/never, 1/0, true/false), NO_COLOR, FORCE_COLOR, then automatic detection: a TTY that is
 * not TERM=dumb and not CI. Redirected output, pipes and Task Scheduler logs are never colored
 * unless forced.
 */
export function resolveColor(
  stream: object | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  const own = env.UPDRAFT_COLOR?.trim().toLowerCase();
  if (own === 'always' || own === '1' || own === 'true') return true;
  if (own === 'never' || own === '0' || own === 'false') return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  const force = env.FORCE_COLOR?.trim().toLowerCase();
  if (force !== undefined && force !== '') return !(force === '0' || force === 'false');
  if (!(stream as { isTTY?: boolean } | null | undefined)?.isTTY) return false;
  if (env.TERM === 'dumb') return false;
  if (env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false') return false;
  return true;
}

const CONTROL = /[\u0000-\u001f\u007f]/g;

function escapeControl(s: string): string {
  return s.replace(CONTROL, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

function truncate(s: string): string {
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}…(+${s.length - MAX_FIELD_CHARS} chars)` : s;
}

/** One field value on one line: quoted when it holds whitespace, quotes, `=` or control characters. */
function formatValue(v: unknown): string {
  const raw = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  const text = truncate(raw);
  if (text === '') return '""';
  // Backslashes stay as they are so Windows paths remain readable.
  if (/[\s"=\u0000-\u001f\u007f]/.test(text)) return `"${escapeControl(text).replace(/"/g, '\\"')}"`;
  return text;
}

const LEVEL_COLOR: Record<LogLevel, string> = { debug: ANSI.dim, info: '', warn: ANSI.yellow, error: ANSI.red };

const LIFECYCLE: Array<[RegExp, string]> = [
  [/\b(failed|crashed)\b/i, ANSI.red],
  [/\b(retrying|retry|superseded|blocked|canceled)\b/i, ANSI.yellow],
  [/\b(queued|started|starting|published|merged|posted|succeeded|stopped)\b/i, ANSI.green],
];

/** Field order after the message: identifying fields first, then call-site order, `error` last. */
const LEAD_FIELDS = ['issue', 'pr', 'job', 'jobId', 'pool', 'workflow', 'run', 'runId', 'agent', 'attempt', 'reason'];

/** The source column: the most specific of job, run, repo, component. */
function scopeOf(fields: LogFields): { label: string; used: string | null } {
  const pick = (keys: string[], prefix: string) => {
    for (const k of keys) {
      const v = fields[k];
      if (typeof v === 'string' && v) return { label: prefix ? `${prefix}:${v}` : v, used: k };
    }
    return null;
  };
  return (
    pick(['job', 'jobId'], 'job') ??
    pick(['runId', 'run'], 'run') ??
    pick(['repo'], 'repo') ??
    pick(['component'], '') ?? { label: 'worker', used: null }
  );
}

/** Render one event for people. Pure: no I/O, so it can be tested with fixed input. */
export function formatConsoleLine(at: Date, level: LogLevel, msg: string, fields: LogFields, color: boolean): string {
  const paint = (s: string, code: string) => (color && code ? `${code}${s}${ANSI.reset}` : s);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
  const { label, used } = scopeOf(fields);

  let message = escapeControl(msg);
  if (color) {
    for (const [re, code] of LIFECYCLE) {
      if (re.test(message)) {
        message = message.replace(re, (m) => `${code}${m}${ANSI.reset}`);
        break;
      }
    }
  }

  const keys = Object.keys(fields).filter((k) => k !== used && fields[k] !== undefined);
  const rank = (k: string) => (k === 'error' ? 2 : LEAD_FIELDS.includes(k) ? 0 : 1);
  const ordered = [
    ...keys.filter((k) => rank(k) === 0).sort((a, b) => LEAD_FIELDS.indexOf(a) - LEAD_FIELDS.indexOf(b)),
    ...keys.filter((k) => rank(k) === 1),
    ...keys.filter((k) => rank(k) === 2),
  ];
  const extra = ordered.map((k) => `${paint(`${escapeControl(k)}=`, ANSI.dim)}${formatValue(fields[k])}`).join(' ');

  const lvl = paint(level.toUpperCase().padEnd(5), LEVEL_COLOR[level]);
  const scope = paint(`[${escapeControl(label)}]`, ANSI.cyan);
  // Pad on the visible text so alignment is the same with and without color.
  const gap = ' '.repeat(Math.max(1, 24 - (label.length + 2)));
  return `${paint(time, ANSI.dim)}  ${lvl}  ${scope}${gap}${message}${extra ? `  ${extra}` : ''}\n`;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const env = opts.env ?? process.env;
  const min = ORDER[opts.level ?? levelFromEnv(env) ?? 'info'];
  const stream = opts.stream === undefined ? process.stderr : opts.stream;
  const color = stream ? resolveColor(stream, env, opts.color) : false;
  let fileReady = false;

  const write = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (ORDER[level] < min) return;
    const now = new Date();
    const all = { ...opts.base, ...fields };
    if (stream) stream.write(formatConsoleLine(now, level, msg, all, color));
    if (opts.file) {
      try {
        if (!fileReady) {
          mkdirSync(dirname(opts.file), { recursive: true });
          fileReady = true;
        }
        appendFileSync(opts.file, `${JSON.stringify({ at: now.toISOString(), level, msg, ...all })}\n`);
      } catch {
        // Logging must never crash the worker.
      }
    }
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger({ ...opts, base: { ...opts.base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ stream: null });
