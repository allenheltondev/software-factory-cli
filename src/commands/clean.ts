// `factory clean`: remove job worktrees that are no longer needed. Branches are kept.
import { existsSync, rmdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../config/io.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import { setRunProcess } from '../db/queue.js';
import { gitCommonDir, pruneWorktrees, removeWorktree } from '../git/git.js';
import { isInside, withCheckoutLock, worktreesRoot } from '../git/worktree.js';
import type { RunOutcome } from '../types.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';

export interface CleanOptions {
  dryRun?: boolean;
  /** git executable; defaults to "git" on PATH. */
  git?: string;
}

interface CheckoutRow {
  run_id: string;
  job_id: string;
  outcome: RunOutcome | null;
  ended_at: string | null;
  checkout_path: string;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
}

export type CleanVerdict = { remove: true; why: string } | { remove: false; why: string };

/**
 * Which worktrees `factory clean` removes. Succeeded runs, runs closed before their agent
 * started (canceled/released), and start failures (the agent never ran in the checkout)
 * are removed. Failed and interrupted runs are kept for inspection, and open runs are
 * never touched.
 */
export function cleanVerdict(run: { outcome: RunOutcome | null; endedAt: string | null }): CleanVerdict {
  if (run.endedAt === null) return { remove: false, why: 'run is still open' };
  switch (run.outcome) {
    case 'succeeded':
      return { remove: true, why: 'succeeded' };
    case 'start_failed':
      return { remove: true, why: 'agent never started' };
    case null:
      return { remove: true, why: 'closed before start' };
    case 'failed':
    case 'interrupted':
      return { remove: false, why: `${run.outcome}; kept for inspection` };
  }
}

function sourceCheckout(config: FactoryConfig | null, configDir: string, repoId: number): string | null {
  if (!config) return null;
  for (const repo of Object.values(config.repositories)) {
    if (repo.id === repoId && repo.checkoutPath) return resolve(configDir, repo.checkoutPath);
  }
  return null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function cleanCommand(ctx: CommandContext, opts: CleanOptions = {}): Promise<number> {
  const { paths } = ctx;
  if (!existsSync(paths.dbFile)) {
    println(ctx.out, 'No state database yet; nothing to clean.');
    return EXIT.OK;
  }
  // The config is only needed to prune worktrees whose directory is already gone.
  let config: FactoryConfig | null = null;
  try {
    config = loadConfig(paths.configFile).config;
  } catch {
    config = null;
  }

  const root = worktreesRoot(paths);
  const verb = opts.dryRun ? 'Would remove' : 'Removed';
  let removed = 0;
  let kept = 0;
  let failed = 0;
  const db: Db = ctx.openDb(paths.dbFile);
  try {
    const rows = db
      .prepare(
        `SELECT r.id AS run_id, r.job_id, r.outcome, r.ended_at, r.checkout_path,
                j.repo_id, j.repo_full_name, j.issue_number
         FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.checkout_path IS NOT NULL
         ORDER BY r.started_at, r.id`,
      )
      .all() as unknown as CheckoutRow[];

    for (const row of rows) {
      const path = row.checkout_path;
      const label = `${row.repo_full_name}#${row.issue_number}, job ${row.job_id}, run ${row.run_id}`;
      const verdict = cleanVerdict({ outcome: row.outcome, endedAt: row.ended_at });
      if (!verdict.remove) {
        kept++;
        println(ctx.out, `Kept ${path} (${label}: ${verdict.why})`);
        continue;
      }
      if (!isInside(root, path)) {
        kept++;
        println(ctx.out, `Kept ${path} (${label}): not under ${root}, so factory did not create it`);
        continue;
      }
      if (opts.dryRun) {
        removed++;
        println(ctx.out, `${verb} ${path} (${label}: ${verdict.why})`);
        continue;
      }
      try {
        if (existsSync(path)) {
          const common = await gitCommonDir({ cwd: path, git: opts.git });
          // The clone is the parent of a non-bare .git dir; lock on it like the worker does.
          const source = sourceCheckout(config, paths.configDir, row.repo_id) ?? dirname(common);
          await withCheckoutLock(source, () => removeWorktree(path, { cwd: common, git: opts.git }));
        } else {
          const source = sourceCheckout(config, paths.configDir, row.repo_id);
          if (source && existsSync(source)) {
            await withCheckoutLock(source, () => pruneWorktrees({ cwd: source, git: opts.git }));
          }
        }
        setRunProcess(db, row.run_id, { checkoutPath: null });
        try {
          rmdirSync(dirname(path)); // the per-repo directory, once empty
        } catch {
          // not empty, or already gone
        }
        removed++;
        println(ctx.out, `${verb} ${path} (${label}: ${verdict.why})`);
      } catch (err) {
        failed++;
        println(ctx.err, `Could not remove ${path} (${label}): ${message(err)}`);
      }
    }
  } finally {
    db.close();
  }

  const parts = [`${opts.dryRun ? 'would remove' : 'removed'} ${removed} worktree(s)`, `kept ${kept}`];
  if (failed) parts.push(`${failed} could not be removed`);
  println(ctx.out, `${parts.join(', ')}. Branches are kept; delete them with "git branch -D" when no longer needed.`);
  return failed ? EXIT.FAILURE : EXIT.OK;
}
