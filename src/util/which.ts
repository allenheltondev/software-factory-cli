import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface WhichOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injected for tests. Defaults to "is a regular file (and executable on POSIX)". */
  isExecutable?: (path: string) => boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Environment lookup that is case-insensitive on Windows (PATH vs Path). */
function getEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function defaultIsExecutable(platform: NodeJS.Platform) {
  return (p: string): boolean => {
    try {
      if (!statSync(p).isFile()) return false;
      if (platform === 'win32') return true;
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/** PATH entries (empty entries dropped, surrounding quotes stripped on Windows). */
export function pathEntries(opts: Pick<WhichOptions, 'env' | 'platform'> = {}): string[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const delimiter = platform === 'win32' ? win32.delimiter : posix.delimiter;
  return (getEnv(env, 'PATH', platform) ?? '')
    .split(delimiter)
    .map((p) => (platform === 'win32' ? p.replace(/^"(.*)"$/, '$1') : p).trim())
    .filter(Boolean);
}

/**
 * Find an executable on PATH without spawning a shell. On Windows, tries each
 * PATHEXT extension (and the name as given if it already has one). A name with a
 * path separator is checked directly. Returns the full path or null.
 */
export function which(command: string, opts: WhichOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isExecutable = opts.isExecutable ?? defaultIsExecutable(platform);
  const path = platform === 'win32' ? win32 : posix;
  if (!command) return null;

  let candidates: string[] = [''];
  if (platform === 'win32') {
    const exts = (getEnv(env, 'PATHEXT', platform) || DEFAULT_PATHEXT)
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const ext = path.extname(command).toLowerCase();
    candidates = ext && exts.includes(ext) ? [''] : exts;
  }

  const hasSep = platform === 'win32' ? /[\\/]/.test(command) : command.includes('/');
  const dirs = hasSep ? [''] : pathEntries({ env, platform });
  for (const dir of dirs) {
    const base = dir ? path.join(dir, command) : command;
    for (const ext of candidates) {
      const full = base + ext;
      if (isExecutable(full)) return full;
    }
  }
  return null;
}
