import { existsSync } from 'node:fs';
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

/** Where builds before `~/.updraft` kept their files. */
export interface LegacyInstall {
  configFile: string;
  /** Held state.db and worktrees/ (and, except on macOS, logs/). */
  dataDir: string;
}

export interface FindLegacyInstallOptions extends ResolvePathsOptions {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

/** The per-OS locations earlier builds used, whether or not anything is there. */
export function legacyLocations(opts: FindLegacyInstallOptions = {}): LegacyInstall {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.homedir ?? osHomedir();
  const app = 'updraft';
  if (platform === 'win32') {
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return { configFile: join(roaming, app, 'config.yaml'), dataDir: join(local, app) };
  }
  if (platform === 'darwin') {
    const dir = join(home, 'Library', 'Application Support', app);
    return { configFile: join(dir, 'config.yaml'), dataDir: dir };
  }
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config');
  const xdgState = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return { configFile: join(xdgConfig, app, 'config.yaml'), dataDir: join(xdgState, app) };
}

/**
 * An install left in the per-OS locations, when this run uses the default `~/.updraft` and has
 * no config there yet. Null when UPDRAFT_HOME, UPDRAFT_CONFIG or --config is set: then the
 * user already chose where the files are.
 */
export function findLegacyInstall(opts: FindLegacyInstallOptions = {}): LegacyInstall | null {
  const env = opts.env ?? process.env;
  if (opts.configPath || env.UPDRAFT_HOME || env.UPDRAFT_CONFIG) return null;
  const exists = opts.exists ?? existsSync;
  if (exists(resolvePaths(opts).configFile)) return null;
  const legacy = legacyLocations(opts);
  return exists(legacy.configFile) ? legacy : null;
}

/** What to tell the user about a legacy install: how to keep it as is, or where to read about moving. */
export function legacyInstallNotice(legacy: LegacyInstall, paths: Pick<UpdraftPaths, 'configDir'>): string[] {
  return [
    `An install from an earlier version is still at ${legacy.configFile} (state in ${legacy.dataDir}).`,
    `This version keeps its files in ${paths.configDir} and does not read the old folders. To keep`,
    `using that install unchanged, with its history, set both:`,
    `  UPDRAFT_CONFIG=${legacy.configFile}`,
    `  UPDRAFT_HOME=${legacy.dataDir}`,
    `To start over in ${paths.configDir} instead, see "Moving from the per-OS locations" in the README.`,
  ];
}
