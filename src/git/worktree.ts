// Per-job branches and worktrees (design §4). The user's clone (checkoutPath) is only
// the source: each job gets its own branch and a worktree under the per-user data dir.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FactoryPaths } from '../paths.js';
import {
  addWorktree,
  redactRemoteUrl,
  assertValidBranchName,
  fetchBranch,
  isGitRepo,
  listRemotes,
  localBranchExists,
  selectRepoRemote,
  remoteDefaultBranch,
  type GitOptions,
} from './git.js';

/** Root for all job worktrees: <dataDir>/worktrees/<repoId>/<jobId>[-<attempt>]. */
export function worktreesRoot(paths: Pick<FactoryPaths, 'dataDir'>): string {
  return join(paths.dataDir, 'worktrees');
}

/**
 * Branch for a job: factory/issue-<n>-<jobId>. Later attempts (after `factory retry`)
 * get a -<attempt> suffix so the earlier attempt's branch and worktree stay inspectable.
 */
export function jobBranchName(job: { id: string; issueNumber: number }, attempt: number): string {
  return `factory/issue-${job.issueNumber}-${job.id}${attempt > 1 ? `-${attempt}` : ''}`;
}

export function jobWorktreePath(
  paths: Pick<FactoryPaths, 'dataDir'>,
  job: { id: string; repoId: number },
  attempt: number,
): string {
  return join(worktreesRoot(paths), String(job.repoId), `${job.id}${attempt > 1 ? `-${attempt}` : ''}`);
}

/** True if `p` is strictly inside `root` (lexically, after resolving). */
export function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function lockKey(p: string): string {
  let key = resolve(p);
  try {
    key = realpathSync.native(key);
  } catch {
    // not there (yet); the lexical path is the best key we have
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? key.toLowerCase() : key;
}

const checkoutQueues = new Map<string, Promise<void>>();

/**
 * Run `fn` after every earlier operation on the same checkout has settled. Concurrent
 * jobs on one repo would otherwise race on fetch ref locks and worktree metadata.
 * In-process only: the single-worker lock means one daemon touches a clone at a time.
 */
export function withCheckoutLock<T>(checkoutPath: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(checkoutPath);
  const previous = checkoutQueues.get(key) ?? Promise.resolve();
  const result = previous.then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  checkoutQueues.set(key, tail);
  void tail.then(() => {
    if (checkoutQueues.get(key) === tail) checkoutQueues.delete(key);
  });
  return result;
}

export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepareError';
  }
}

export interface PrepareRequest {
  /** Absolute path of the user's clone. */
  checkoutPath: string;
  /** OWNER/NAME the clone's remote must point at. */
  repoFullName: string;
  /** repositories.<repo>.remote: use exactly this remote (any host, OWNER/NAME must match). */
  remote?: string | undefined;
  /** Configured base branch; defaults to the remote's default branch. */
  baseBranch?: string | undefined;
  branch: string;
  worktreePath: string;
  git?: string;
  /** Aborts network operations (ls-remote, fetch). */
  signal?: AbortSignal;
}

export interface PreparedWorktree {
  remote: string;
  remoteUrl: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Verify the clone, fetch the base branch, and create the job's branch and worktree from
 * the fetched commit. Refuses to reuse an existing branch or worktree path. Serialized per clone.
 */
export function prepareJobWorktree(req: PrepareRequest): Promise<PreparedWorktree> {
  return withCheckoutLock(req.checkoutPath, async () => {
    const { checkoutPath, repoFullName, branch, worktreePath } = req;
    if (!isDirectory(checkoutPath)) throw new PrepareError(`checkoutPath ${checkoutPath} does not exist or is not a directory`);
    const opts: GitOptions = { cwd: checkoutPath, git: req.git };
    if (!(await isGitRepo(opts))) throw new PrepareError(`checkoutPath ${checkoutPath} is not a git repository`);

    const selection = selectRepoRemote(await listRemotes(opts), repoFullName, req.remote);
    if (!selection.ok) throw new PrepareError(`${checkoutPath}: ${selection.error}`);
    const remote = selection.remote;

    const net: GitOptions = { ...opts, signal: req.signal };
    const baseBranch = req.baseBranch ?? (await remoteDefaultBranch(remote.name, net));
    await assertValidBranchName(baseBranch, opts);
    await assertValidBranchName(branch, opts);
    const baseSha = await fetchBranch(remote.name, baseBranch, net);

    if (await localBranchExists(branch, opts)) {
      throw new PrepareError(`branch ${branch} already exists in ${checkoutPath}; refusing to reuse it`);
    }
    if (existsSync(worktreePath)) {
      throw new PrepareError(`worktree path ${worktreePath} already exists; refusing to reuse it`);
    }
    await mkdir(dirname(worktreePath), { recursive: true });
    await addWorktree(worktreePath, branch, baseSha, opts);
    return { remote: remote.name, remoteUrl: redactRemoteUrl(remote.url), baseBranch, baseSha, branch, worktreePath };
  });
}
