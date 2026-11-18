import { homedir as osHomedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Default home directory name, under the user's home directory. */
export const HOME_DIR = '.updraft';

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
  homedir?: string;
}

/**
 * Where updraft keeps its files: one directory, the same on every OS.
 *
 * - Default: `~/.updraft` (`%USERPROFILE%\.updraft` on Windows), holding config.yaml,
 *   state.db and logs/. It is outside AppData on purpose: Windows redirects a packaged app's
 *   writes to new AppData folders into the package's private storage, so a CLI started from
 *   such an app (a desktop IDE or agent host) and one started from a terminal would each see
 *   their own copy.
 * - UPDRAFT_HOME moves that whole directory.
 * - UPDRAFT_CONFIG / --config override only the config file location.
 */
export function resolvePaths(opts: ResolvePathsOptions = {}): UpdraftPaths {
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? osHomedir();

  const root = env.UPDRAFT_HOME ? resolve(env.UPDRAFT_HOME) : join(home, HOME_DIR);
  let configDir = root;
  const dataDir = root;
  const logDir = join(root, 'logs');

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
