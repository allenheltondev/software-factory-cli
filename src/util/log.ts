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
  level?: LogLevel;
  /** JSON-lines log file. Created on first write. */
  file?: string;
  /** Human-readable output; defaults to process.stderr. Pass null to silence. */
  stream?: NodeJS.WritableStream | null;
  base?: LogFields;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const stream = opts.stream === undefined ? process.stderr : opts.stream;
  let fileReady = false;

  const write = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (ORDER[level] < min) return;
    const at = new Date().toISOString();
    const all = { ...opts.base, ...fields };
    if (stream) {
      const extra = Object.entries(all)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      stream.write(`${at} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? ` ${extra}` : ''}\n`);
    }
    if (opts.file) {
      try {
        if (!fileReady) {
          mkdirSync(dirname(opts.file), { recursive: true });
          fileReady = true;
        }
        appendFileSync(opts.file, `${JSON.stringify({ at, level, msg, ...all })}\n`);
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
