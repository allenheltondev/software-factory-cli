import { defaultDiscoveryProbes, discoverAgents, type AgentReport, type DiscoverOptions } from '../agents/discovery.js';
import { openDatabase, type Db, openDatabaseReadOnly } from '../db/database.js';
import type { GitHubApi } from '../github/api.js';
import type { UpdraftConfig } from '../config/schema.js';
import { createGitHubApi, resolveGitHubToken } from '../github/client.js';
import { createWorkerCredentials, type GitHubCredentials } from '../github/credentials.js';
import { createUserPublisher, type UserPublisher } from '../github/publisher.js';
import { findLegacyInstall, legacyInstallNotice, resolvePaths, type LegacyInstall, type UpdraftPaths } from '../paths.js';
import type { Logger } from '../util/log.js';
import { createClackPrompter, type Prompter } from './prompter.js';

export interface Output {
  write(chunk: string): unknown;
}

/** Everything a command needs from the outside world, injected so commands are unit-testable. */
export interface CommandContext {
  paths: UpdraftPaths;
  env: NodeJS.ProcessEnv;
  /** Command output (stdout). */
  out: Output;
  /** Diagnostics and errors (stderr). */
  err: Output;
  /** True when stdin and stdout are interactive terminals. */
  isTTY: boolean;
  /**
   * The GitHub API. With `credentials`, as the worker (see createCredentials); without, as the
   * person's own gh sign-in, which is what the interactive commands use.
   */
  createApi(opts?: { log?: Logger; credentials?: GitHubCredentials }): Promise<GitHubApi>;
  /**
   * The credentials the worker acts with for this config: the GitHub App of github.app when
   * configured, else the gh sign-in. Throws when the App's private key cannot be used.
   */
  createCredentials(config: Pick<UpdraftConfig, 'github'> | null, opts?: { log?: Logger }): GitHubCredentials;
  /**
   * The consenting person of github.publisher (src/github/publisher.ts), or null when none is
   * configured: their own `gh` sign-in, checked against the named account on every use. Optional:
   * contexts without it publish as no person, and a pull request recorded as one stops.
   */
  createUserPublisher?(config: Pick<UpdraftConfig, 'github'> | null, opts?: { log?: Logger }): UserPublisher | null;
  /** Lazily created so non-interactive commands never touch the terminal. */
  prompter(): Prompter;
  openDb(file: string): Db;
  /** Open an existing state database without migrating or writing to it. */
  openDbReadOnly(file: string): Db;
  /**
   * An install an earlier version left in the per-OS locations, when this run uses the default
   * home and has no config there. Optional: contexts without it never report one.
   */
  findLegacyInstall?(): LegacyInstall | null;
  now(): number;
  /**
   * Find installed and usable coding agents (runs their CLIs), in this process's environment or
   * in `env` when given.
   */
  discoverAgents(opts?: DiscoverOptions & { env?: NodeJS.ProcessEnv }): Promise<AgentReport[]>;
}

export interface GlobalOptions {
  config?: string;
}

export function createDefaultContext(globals: GlobalOptions = {}): CommandContext {
  const env = process.env;
  let prompter: Prompter | undefined;
  const paths = resolvePaths({ configPath: globals.config, env });
  return {
    paths,
    env,
    out: process.stdout,
    err: process.stderr,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    createApi: (opts) => createGitHubApi({ env, log: opts?.log, ...(opts?.credentials ? { credentials: opts.credentials } : {}) }),
    createCredentials: (config, opts) =>
      createWorkerCredentials(config, { configDir: paths.configDir, env, userToken: () => resolveGitHubToken(env), ...(opts?.log ? { log: opts.log } : {}) }),
    createUserPublisher: (config, opts) => userPublisherFor(config, { env, ...(opts?.log ? { log: opts.log } : {}) }),
    prompter: () => (prompter ??= createClackPrompter()),
    openDb: (file) => openDatabase(file),
    openDbReadOnly: (file) => openDatabaseReadOnly(file),
    findLegacyInstall: () => findLegacyInstall({ configPath: globals.config, env }),
    now: () => Date.now(),
    discoverAgents: (opts) => discoverAgents(defaultDiscoveryProbes(opts?.env ?? env), opts),
  };
}

/** Lines describing a legacy install worth pointing out, or none. */
export function legacyNotice(ctx: CommandContext): string[] {
  const legacy = ctx.findLegacyInstall?.() ?? null;
  return legacy ? legacyInstallNotice(legacy, ctx.paths) : [];
}

export function println(out: Output, line = ''): void {
  out.write(`${line}\n`);
}

/**
 * The person of github.publisher, or null: their `gh` sign-in (GH_TOKEN / GITHUB_TOKEN, else
 * `gh auth token`), read again and checked for every publication step. Never the App's credentials.
 */
export function userPublisherFor(config: Pick<UpdraftConfig, 'github'> | null, o: { env: NodeJS.ProcessEnv; log?: Logger }): UserPublisher | null {
  const expected = config?.github?.publisher;
  if (!expected) return null;
  return createUserPublisher({
    expected: { login: expected.login, ...(expected.id !== undefined ? { id: expected.id } : {}) },
    readToken: () => resolveGitHubToken(o.env),
    apiFor: (token) => createGitHubApi({ token, env: o.env, ...(o.log ? { log: o.log } : {}) }),
  });
}
