// Per-job branches and worktrees (design §4). The user's clone (checkoutPath) is only
// the source: each job gets its own branch and a worktree under the per-user data dir.
import { existsSync, realpathSync, rmSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { UpdraftPaths } from '../paths.js';
import {
  addWorktree,
  listWorktreePaths,
  redactRemoteUrl,
  assertValidBranchName,
  fetchBranch,
  isGitRepo,
  listRemotes,
  localBranchExists,
  selectRepoRemote,
  remoteDefaultBranch,
  runGit,
  type GitOptions,
} from './git.js';

/** Root for all job worktrees: <dataDir>/worktrees/<repoId>/<jobId>[-<attempt>]. */
export function worktreesRoot(paths: Pick<UpdraftPaths, 'dataDir'>): string {
  return join(paths.dataDir, 'worktrees');
}

/**
 * Branch for a job: updraft/issue-<n>-<jobId>. Later attempts (after `updraft retry`)
 * get a -<attempt> suffix so the earlier attempt's branch and worktree stay inspectable.
 */
export function jobBranchName(job: { id: string; issueNumber: number }, attempt: number): string {
  return `updraft/issue-${job.issueNumber}-${job.id}${attempt > 1 ? `-${attempt}` : ''}`;
}

/** Is `branch` shaped like a job branch? Publication and revisions push to nothing else. */
export function isJobBranchName(branch: string): boolean {
  return /^updraft\/issue-\d+-job_[A-Za-z0-9]+(-\d+)?$/.test(branch);
}

export function jobWorktreePath(
  paths: Pick<UpdraftPaths, 'dataDir'>,
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

/** `sha` as a full commit id when the clone has that commit, else null. */
async function tryCommit(sha: string, opts: GitOptions): Promise<string | null> {
  try {
    return (await runGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], opts)).stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Remove a throwaway worktree and its branch, whatever state they are in (uncommitted changes,
 * new commits): a reviewer run's worktree, of which nothing is kept. Serialized per clone like
 * every other operation on it. Returns notes about anything that could not be removed.
 */
export function discardWorktree(o: { checkoutPath: string; worktreePath: string; branch: string; git?: string }): Promise<string[]> {
  return withCheckoutLock(o.checkoutPath, async () => {
    const opts: GitOptions = { cwd: o.checkoutPath, git: o.git };
    const notes: string[] = [];
    const attempt = async (what: string, args: string[]) => {
      try {
        await runGit(args, opts);
      } catch (err) {
        notes.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await attempt(`could not remove the worktree ${o.worktreePath}`, ['worktree', 'remove', '--force', o.worktreePath]);
    if (existsSync(o.worktreePath)) {
      // Git refuses when the directory is in a state it does not understand; nothing in it is kept.
      try {
        rmSync(o.worktreePath, { recursive: true, force: true });
        notes.length = 0;
      } catch (err) {
        notes.push(`could not delete ${o.worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await attempt('could not prune worktree records', ['worktree', 'prune']);
    }
    if (await localBranchExists(o.branch, opts)) await attempt(`could not delete the branch ${o.branch}`, ['branch', '-D', o.branch]);
    return notes;
  });
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
  /**
   * Start the worktree at exactly this commit instead of the fetched head of `baseBranch` (a
   * reviewer run reviews one commit). The branch is still fetched; the commit must then be in the clone.
   */
  atSha?: string | undefined;
  branch: string;
  worktreePath: string;
  git?: string;
  /** Aborts network operations (ls-remote, fetch). */
  signal?: AbortSignal;
  /**
   * Called as soon as the job's worktree exists, including when `git worktree add` created it
   * and then failed (e.g. a post-checkout hook exited non-zero), so the run can record it.
   */
  onCheckout?: (worktreePath: string) => void;
}

export interface PreparedWorktree {
  remote: string;
  remoteUrl: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
}

/** Comparable form of a path: resolved, symlinks followed where possible, case-folded where the FS usually is. */
function comparablePath(p: string): string {
  let out = resolve(p);
  try {
    out = realpathSync.native(out);
  } catch {
    try {
      out = join(realpathSync.native(dirname(out)), basename(out));
    } catch {
      // neither the path nor its parent exists; keep the lexical form
    }
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? out.toLowerCase() : out;
}

/** Did a failed `git worktree add` leave this attempt's worktree behind (on disk or registered)? */
async function worktreeWasCreated(worktreePath: string, opts: GitOptions): Promise<boolean> {
  if (existsSync(worktreePath)) return true;
  try {
    const want = comparablePath(worktreePath);
    return (await listWorktreePaths(opts)).some((p) => comparablePath(p) === want);
  } catch {
    return false;
  }
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
    let baseSha = await fetchBranch(remote.name, baseBranch, net);
    if (req.atSha !== undefined && req.atSha !== baseSha) {
      if (!/^[0-9a-f]{40,64}$/.test(req.atSha) || (await tryCommit(req.atSha, opts)) !== req.atSha) {
        throw new PrepareError(`commit ${req.atSha} is not in ${checkoutPath} after fetching ${baseBranch} (now at ${baseSha}); the branch was rewritten`);
      }
      baseSha = req.atSha;
    }

    if (await localBranchExists(branch, opts)) {
      throw new PrepareError(`branch ${branch} already exists in ${checkoutPath}; refusing to reuse it`);
    }
    if (existsSync(worktreePath)) {
      throw new PrepareError(`worktree path ${worktreePath} already exists; refusing to reuse it`);
    }
    await mkdir(dirname(worktreePath), { recursive: true });
    try {
      await addWorktree(worktreePath, branch, baseSha, opts);
    } catch (err) {
      // Git can create the branch and worktree and still exit non-zero. Keep what it made
      // (failed runs stay inspectable; updraft clean leaves them alone) and say so.
      if (await worktreeWasCreated(worktreePath, opts)) {
        req.onCheckout?.(worktreePath);
        const detail = err instanceof Error ? err.message : String(err);
        throw new PrepareError(`${detail} (the worktree at ${worktreePath} was created and is kept for inspection)`);
      }
      throw err;
    }
    req.onCheckout?.(worktreePath);
    return { remote: remote.name, remoteUrl: redactRemoteUrl(remote.url), baseBranch, baseSha, branch, worktreePath };
  });
}
