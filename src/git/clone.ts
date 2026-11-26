// A clone the worker makes for itself, and the worker's own credentials for fetching into it.
//
// `updraft start` works from a clone a person made (repositories.<repo>.checkoutPath) and
// fetches with that machine's git credentials. `updraft run-event` runs where there is neither:
// a fresh machine per event. So it creates the clone when it is missing, and its fetches carry
// the worker's GitHub token (the gh account's, or the GitHub App installation's).
//
// The clone is `git init` plus a remote: no objects are fetched here. The run's own preparation
// (prepareJobWorktree) then fetches the one branch it builds on, with full history and no tags.
// It is deliberately neither shallow nor partial:
// - Publication pushes from a throwaway repository that borrows this clone's objects and does
//   not know about a shallow boundary. When the base branch moved during the run, the remote no
//   longer advertises the commit the job branch starts from, git has to walk past it, and a
//   shallow clone has nothing there: the push would fail exactly when the repository is busy.
// - A partial clone fetches missing blobs whenever a command needs one. The agent works in a
//   worktree of this clone and is never given credentials, so its `git diff` or `git log -p`
//   would fail on any file the worker happened not to have.
//
// The token reaches git exactly as it does for a push (publishGitEnv): as an Authorization
// header scoped to https://github.com/, in GIT_CONFIG_* environment variables of the worker's own
// git process. Never in argv, never in a URL, never in the clone's config or any other file.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { isHttpsGitHub, publishGitEnv, redactSecret } from '../publish/publish.js';
import { isGitRepo, runGit as defaultRunGit, type GitOptions, type GitOutput } from './git.js';
import { withCheckoutLock } from './worktree.js';

/** Marks a clone `ensureClone` created; a clone carrying it is always fetched with the worker's credentials. */
export const MANAGED_CLONE_KEY = 'updraft.managedClone';

/** Set in a clone ensureClone creates; see there. */
export const MANAGED_CLONE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
];

type RunGit = (args: readonly string[], opts: GitOptions) => Promise<GitOutput>;

export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneError';
  }
}

/** The URL a clone of `repoFullName` is created from. Carries no credentials. */
export function githubCloneUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`;
}

export interface EnsureCloneRequest {
  /** Absolute path of the clone (repositories.<repo>.checkoutPath, resolved). */
  checkoutPath: string;
  /** Where a new clone's `origin` points. Used only when the clone is created. */
  cloneUrl: string;
  git?: string;
  /** Injected in tests to record what reaches git. */
  runGit?: RunGit;
  now?: () => number;
}

export interface EnsuredClone {
  /** True when this call created the clone. */
  created: boolean;
  /** True when the clone was created by ensureClone, now or earlier. */
  managed: boolean;
}

function isEmptyDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/**
 * Make sure `checkoutPath` is a git repository: an existing clone is left exactly as it is, a
 * missing (or empty) directory becomes an empty repository whose `origin` is `cloneUrl`. Fetches
 * nothing and needs no credentials. Refuses a directory that has content but is not a repository.
 */
export async function ensureClone(req: EnsureCloneRequest): Promise<EnsuredClone> {
  const { checkoutPath } = req;
  const run = req.runGit ?? defaultRunGit;
  const opts: GitOptions = { cwd: checkoutPath, git: req.git };
  if (existsSync(checkoutPath) && !isEmptyDir(checkoutPath)) {
    if (!statSync(checkoutPath).isDirectory() || !(await isGitRepo(opts))) {
      throw new CloneError(`${checkoutPath} exists and is not a git repository; refusing to create a clone there`);
    }
    const marked = await run(['config', '--local', '--get', MANAGED_CLONE_KEY], opts).catch(() => null);
    return { created: false, managed: marked?.stdout.trim() === 'true' };
  }
  mkdirSync(checkoutPath, { recursive: true });
  await run(['init', '--quiet'], opts);
  await run(['remote', 'add', 'origin', req.cloneUrl], opts);
  await run(['config', '--local', MANAGED_CLONE_KEY, 'true'], opts);
  // No automatic housekeeping. A contained agent commits through a git directory whose top
  // level is read-only (src/worker/container.ts, gitMounts), and the gc that `git commit` may
  // start packs refs there: it fails, with a "packed-refs.lock: Read-only file system" warning
  // in the agent's output. The worker collects garbage itself instead, outside any agent run
  // (housekeepManagedClone).
  for (const [key, value] of MANAGED_CLONE_CONFIG) await run(['config', '--local', key, value], opts);
  await run(['config', '--local', LAST_GC_KEY, String(req.now?.() ?? Date.now())], opts);
  return { created: true, managed: true };
}

/** When the worker last ran `git gc --auto` in a clone it made (ms since the epoch). */
export const LAST_GC_KEY = 'updraft.lastGc';
/** How often housekeepManagedClone collects garbage in one clone. */
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The automatic gc that ensureClone turns off for agents, run by the worker itself: `git gc
 * --auto` on the host, with git's default threshold, no hooks (gc --auto runs pre-auto-gc), and
 * serialized with every other operation on the clone, so never while an agent of it runs. At most
 * once per `intervalMs` (0: whenever asked, as `updraft clean` does). Only for a clone ensureClone
 * made; a clone a person made keeps its own gc. Never throws: returns what it did.
 */
export function housekeepManagedClone(o: {
  checkoutPath: string;
  git?: string;
  runGit?: RunGit;
  now?: () => number;
  intervalMs?: number;
  /** A path that does not exist: core.hooksPath for gc. */
  hooksPath: string;
}): Promise<{ ran: boolean; why: string }> {
  const run = o.runGit ?? defaultRunGit;
  const opts: GitOptions = { cwd: o.checkoutPath, git: o.git };
  const now = o.now?.() ?? Date.now();
  return withCheckoutLock(o.checkoutPath, async () => {
    try {
      const marked = await run(['config', '--local', '--get', MANAGED_CLONE_KEY], opts).catch(() => null);
      if (marked?.stdout.trim() !== 'true') return { ran: false, why: 'not a clone the worker made' };
      const last = Number((await run(['config', '--local', '--get', LAST_GC_KEY], opts).catch(() => null))?.stdout.trim() ?? NaN);
      const interval = o.intervalMs ?? GC_INTERVAL_MS;
      if (interval > 0 && Number.isFinite(last) && now - last < interval) return { ran: false, why: 'collected recently' };
      await run(['-c', 'gc.auto=6700', '-c', 'gc.autoDetach=false', '-c', 'maintenance.auto=false', '-c', `core.hooksPath=${o.hooksPath}`, 'gc', '--auto', '--quiet'], opts);
      await run(['config', '--local', LAST_GC_KEY, String(now)], opts);
      return { ran: true, why: 'git gc --auto' };
    } catch (err) {
      return { ran: false, why: `git gc --auto failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

/** What a network git command of the worker runs with, and how to keep its credential out of messages. */
export interface NetworkGit {
  env: NodeJS.ProcessEnv;
  redact: (text: string) => string;
}

/**
 * The environment for the worker's own fetch from `remoteUrl`: hooks off (the hooks of a clone
 * are not the worker's, and would run with the header in their environment), no tracing, and for
 * an https://github.com remote the worker's token as a header scoped to https://github.com/.
 * The token is read only for such a remote; any other remote (SSH, a host alias, a local path)
 * keeps git's own credentials.
 */
export async function workerNetworkGit(o: {
  base: NodeJS.ProcessEnv;
  remoteUrl: string;
  repoFullName: string;
  token: (repoFullName: string) => Promise<string>;
  /** A path that does not exist: core.hooksPath for these commands. */
  hooksPath: string;
}): Promise<NetworkGit> {
  const token = isHttpsGitHub(o.remoteUrl) ? await o.token(o.repoFullName) : null;
  return {
    env: publishGitEnv({ base: o.base, pushUrl: o.remoteUrl, token, hooksPath: o.hooksPath }),
    redact: (text) => redactSecret(text, token),
  };
}
