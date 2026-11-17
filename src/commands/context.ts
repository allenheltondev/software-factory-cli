import { defaultDiscoveryProbes, discoverAgents, type AgentReport, type DiscoverOptions } from '../agents/discovery.js';
import { openDatabase, type Db } from '../db/database.js';
import type { GitHubApi } from '../github/api.js';
import { createGitHubApi } from '../github/client.js';
import { resolvePaths, type FactoryPaths } from '../paths.js';
import type { Logger } from '../util/log.js';
import { createClackPrompter, type Prompter } from './prompter.js';

export interface Output {
  write(chunk: string): unknown;
}

/** Everything a command needs from the outside world, injected so commands are unit-testable. */
export interface CommandContext {
  paths: FactoryPaths;
  env: NodeJS.ProcessEnv;
  /** Command output (stdout). */
  out: Output;
  /** Diagnostics and errors (stderr). */
  err: Output;
  /** True when stdin and stdout are interactive terminals. */
  isTTY: boolean;
  createApi(opts?: { log?: Logger }): Promise<GitHubApi>;
  /** Lazily created so non-interactive commands never touch the terminal. */
  prompter(): Prompter;
  openDb(file: string): Db;
  now(): number;
  /** Find installed and usable coding agents in this process's environment (runs their CLIs). */
  discoverAgents(opts?: DiscoverOptions): Promise<AgentReport[]>;
}

export interface GlobalOptions {
  config?: string;
}

export function createDefaultContext(globals: GlobalOptions = {}): CommandContext {
  const env = process.env;
  let prompter: Prompter | undefined;
  return {
    paths: resolvePaths({ configPath: globals.config, env }),
    env,
    out: process.stdout,
    err: process.stderr,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    createApi: (opts) => createGitHubApi({ env, log: opts?.log }),
    prompter: () => (prompter ??= createClackPrompter()),
    openDb: (file) => openDatabase(file),
    now: () => Date.now(),
    discoverAgents: (opts) => discoverAgents(defaultDiscoveryProbes(env), opts),
  };
}

export function println(out: Output, line = ''): void {
  out.write(`${line}\n`);
}
