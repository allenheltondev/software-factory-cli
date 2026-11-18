import { homedir as osHomedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const APP_DIR = 'updraft';

export interface UpdraftPaths {
  configFile: string;
  /** Directory holding config.yaml; relative paths in the config resolve against it. */
  configDir: string;
  /** Durable state: SQLite DB. */
  dataDir: string;
  dbFile: string;
  logDir: string;
  /** Per-run log directories live under here. */
  runsDir: string;
}

export interface ResolvePathsOptions {
  /** Explicit --config path. Wins over UPDRAFT_CONFIG. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}

/**
 * Per-user locations for the host OS.
 *
 * - UPDRAFT_HOME puts config, data and logs under one directory.
 * - UPDRAFT_CONFIG / --config override only the config file location.
 */
export function resolvePaths(opts: ResolvePathsOptions = {}): UpdraftPaths {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.homedir ?? osHomedir();

  let configDir: string;
  let dataDir: string;
  let logDir: string;

  if (env.UPDRAFT_HOME) {
    const root = resolve(env.UPDRAFT_HOME);
    configDir = root;
    dataDir = root;
    logDir = join(root, 'logs');
  } else if (platform === 'win32') {
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    configDir = join(roaming, APP_DIR);
    dataDir = join(local, APP_DIR);
    logDir = join(local, APP_DIR, 'logs');
  } else if (platform === 'darwin') {
    configDir = join(home, 'Library', 'Application Support', APP_DIR);
    dataDir = configDir;
    logDir = join(home, 'Library', 'Logs', APP_DIR);
  } else {
    const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config');
    const xdgState = env.XDG_STATE_HOME || join(home, '.local', 'state');
    configDir = join(xdgConfig, APP_DIR);
    dataDir = join(xdgState, APP_DIR);
    logDir = join(xdgState, APP_DIR, 'logs');
  }

  const explicit = opts.configPath ?? env.UPDRAFT_CONFIG;
  const configFile = explicit ? resolve(explicit) : join(configDir, 'config.yaml');
  if (explicit) configDir = dirname(configFile);

  return {
    configFile,
    configDir,
    dataDir,
    dbFile: join(dataDir, 'state.db'),
    logDir,
    runsDir: join(logDir, 'runs'),
  };
}
