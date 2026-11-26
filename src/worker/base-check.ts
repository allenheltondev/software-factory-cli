// A clean copy of a run's base commit, for checking a failure against it (docs/worktrees.md,
// "Checking a failure against the base commit").
//
// An agent that sees a test fail in a file its change does not touch has to show whether the
// failure is its own. Inside a container it cannot do that in its worktree: the clone's git
// directory is mounted read-only apart from what a commit writes (container.ts, gitMounts), so
// `git stash` and checking out another commit fail there, and they would change the job branch's
// working tree if they did not. So the worker, before the agent starts, writes the files of the
// base commit into a directory of their own:
//
//   <dataDir>/base-checks/<run id>/base      the base commit's files (UPDRAFT_BASE_DIR)
//   <dataDir>/base-checks/<run id>/scratch   empty, for the agent (UPDRAFT_SCRATCH_DIR)
//
// The base directory is a plain tree of files: no `.git`, no hooks, no config, no credentials,
// and nothing that host git or the worker later reads, executes or pushes. A container gets it
// read-only and the scratch directory read-write; neither is a path a commit or a push ever
// sees. Both are removed when the run ends, whatever its outcome.
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit, type GitOptions } from '../git/git.js';
import { withCheckoutLock } from '../git/worktree.js';

/** The variable that names the base commit's files, for the agent. */
export const BASE_DIR_ENV = 'UPDRAFT_BASE_DIR';
/** The variable that names the agent's writable scratch directory. */
export const SCRATCH_DIR_ENV = 'UPDRAFT_SCRATCH_DIR';

/** Where a run's base checkout lives. Pure. */
export function baseCheckRoot(dataDir: string, runId: string): string {
  return join(dataDir, 'base-checks', runId.replace(/[^A-Za-z0-9_.-]/g, '-'));
}

export interface BaseCheckout {
  /** Holds both directories; removing it removes everything. */
  root: string;
  /** The files of `sha`, read-only for a containerized agent. */
  baseDir: string;
  /** Empty at the start; the agent's to write. */
  scratchDir: string;
  /** The commit whose files `baseDir` holds. */
  sha: string;
}

/**
 * Write the files of `sha` (a commit in the clone at `checkoutPath`) to `<root>/base` and create an
 * empty `<root>/scratch`. Uses a temporary index outside the clone, so the clone's own index, HEAD,
 * refs and worktrees are not touched, and runs no hook. Serialized with every other operation on
 * the clone. Throws when the commit cannot be checked out; whatever was written is removed then.
 */
export function prepareBaseCheckout(o: { checkoutPath: string; sha: string; root: string; git?: string }): Promise<BaseCheckout> {
  return withCheckoutLock(o.checkoutPath, async () => {
    if (!/^[0-9a-f]{40,64}$/.test(o.sha)) throw new Error(`"${o.sha}" is not a full commit id`);
    const baseDir = join(o.root, 'base');
    const scratchDir = join(o.root, 'scratch');
    const index = join(o.root, 'index');
    removeTree(o.root);
    try {
      await mkdir(baseDir, { recursive: true });
      await mkdir(scratchDir, { recursive: true });
      const opts: GitOptions = { cwd: o.checkoutPath, git: o.git, env: { ...process.env, GIT_INDEX_FILE: index } };
      await runGit(['read-tree', `${o.sha}^{tree}`], opts);
      // --prefix writes below baseDir, never into the clone's own working tree.
      await runGit(['checkout-index', '--all', `--prefix=${baseDir}/`], opts);
      await rm(index, { force: true });
    } catch (err) {
      removeTree(o.root);
      throw err;
    }
    return { root: o.root, baseDir, scratchDir, sha: o.sha };
  });
}

/**
 * Remove a directory tree that an agent may have written, without following any link in it.
 * Directories the agent made unwritable (or unreadable) are opened up first, since they are the
 * worker's own files. Never throws; returns why it failed, or null.
 */
export function removeTree(root: string): string | null {
  try {
    rmSync(root, { recursive: true, force: true });
    return null;
  } catch {
    // e.g. EACCES: a directory without write or search permission
  }
  try {
    openUp(root);
    rmSync(root, { recursive: true, force: true });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function openUp(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours; rmSync reports it
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) openUp(join(dir, entry));
}
