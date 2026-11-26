// `updraft clean`: remove job worktrees that are no longer needed. Branches are kept.
// With --older-than it also prunes old state: terminal jobs with their runs, publications and
// run logs, and old error rows.
import { existsSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfig } from '../config/io.js';
import type { UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import { countOldErrors, listPrunableJobs, pruneErrors, pruneJob, type PrunableJob } from '../db/prune.js';
import { setRunProcess } from '../db/queue.js';
import { housekeepManagedClone } from '../git/clone.js';
import { gitCommonDir, pruneWorktrees, removeWorktree, runGit } from '../git/git.js';
import { isInside, withCheckoutLock, worktreesRoot } from '../git/worktree.js';
import type { RunOutcome } from '../types.js';
import { println, type CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';

export interface CleanOptions {
  dryRun?: boolean;
  /**
   * Also prune terminal jobs that finished longer ago than this, and older error rows:
   * a number and a unit, e.g. "30d", "12h", "2w".
   */
  olderThan?: string;
  /** git executable; defaults to "git" on PATH. */
  git?: string;
}

interface CheckoutRow {
  run_id: string;
  job_id: string;
  outcome: RunOutcome | null;
  ended_at: string | null;
  execution_started_at: string | null;
  checkout_path: string;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
}

export type CleanVerdict = { remove: true; why: string } | { remove: false; why: string };

/**
 * Which worktrees `updraft clean` removes. Succeeded runs, runs closed before their agent
 * started (canceled/released), and start failures (the agent never ran in the checkout)
 * are removed. Failed and interrupted runs are kept for inspection, and so is a run the user
 * canceled after its agent started (closed with no outcome, like a run canceled before start,
 * but its worktree may hold work worth a look). Open runs are never touched.
 */
export function cleanVerdict(run: {
  outcome: RunOutcome | null;
  endedAt: string | null;
  executionStartedAt?: string | null;
}): CleanVerdict {
  if (run.endedAt === null) return { remove: false, why: 'run is still open' };
  switch (run.outcome) {
    case 'succeeded':
      return { remove: true, why: 'succeeded' };
    case 'start_failed':
      return { remove: true, why: 'agent never started' };
    case null:
      return run.executionStartedAt
        ? { remove: false, why: 'canceled after the agent started; kept for inspection' }
        : { remove: true, why: 'closed before start' };
    case 'failed':
    case 'interrupted':
      return { remove: false, why: `${run.outcome}; kept for inspection` };
  }
}

function sourceCheckout(config: UpdraftConfig | null, configDir: string, repoId: number): string | null {
  if (!config) return null;
  for (const repo of Object.values(config.repositories)) {
    if (repo.id === repoId && repo.checkoutPath) return resolve(configDir, repo.checkoutPath);
  }
  return null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const AGE_UNITS_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** Parse an --older-than value ("30d", "12h", "2w") into milliseconds. `option` names the flag in the error. */
export function parseAge(text: string, option = '--older-than'): number {
  const m = /^(\d+)\s*([hdw])$/i.exec(text.trim());
  if (!m) {
    throw new CliError(`Invalid ${option} "${text}": use a number and a unit (h, d or w), for example 30d.`, EXIT.USAGE);
  }
  return Number(m[1]) * AGE_UNITS_MS[m[2]!.toLowerCase()]!;
}

/** Everything the worktree-removing steps share. */
interface CleanEnv {
  ctx: CommandContext;
  db: Db;
  config: UpdraftConfig | null;
  /** Only worktrees under here were created by updraft. */
  root: string;
  git?: string;
  /** --dry-run only: runs whose worktree the worktree pass reported it would remove. */
  wouldRemove: Set<string>;
}

/**
 * Remove a run's worktree (git refuses if it has uncommitted or untracked changes), or prune
 * git's record of one whose directory is already gone, and clear the run's checkout path.
 */
async function removeCheckout(env: CleanEnv, run: { runId: string; repoId: number; path: string }): Promise<void> {
  const { paths } = env.ctx;
  const { path } = run;
  if (existsSync(path)) {
    const common = await gitCommonDir({ cwd: path, git: env.git });
    // The clone is the parent of a non-bare .git dir; lock on it like the worker does.
    const source = sourceCheckout(env.config, paths.configDir, run.repoId) ?? dirname(common);
    await withCheckoutLock(source, () => removeWorktree(path, { cwd: common, git: env.git }));
  } else {
    const source = sourceCheckout(env.config, paths.configDir, run.repoId);
    if (source && existsSync(source)) {
      await withCheckoutLock(source, () => pruneWorktrees({ cwd: source, git: env.git }));
    }
  }
  setRunProcess(env.db, run.runId, { checkoutPath: null });
  try {
    rmdirSync(dirname(path)); // the per-repo directory, once empty
  } catch {
    // not empty, or already gone
  }
}

/**
 * A run's log directory, if updraft created it: `<runsDir>/<runId>/`. A log path recorded
 * anywhere else is not ours to delete.
 */
function runLogDir(runsDir: string, run: { id: string; logPath: string | null }): string | null {
  const dir = run.logPath ? dirname(run.logPath) : join(runsDir, run.id);
  return isInside(runsDir, dir) && basename(dir) === run.id ? dir : null;
}

interface PruneTotals {
  jobs: number;
  runs: number;
  errors: number;
  logDirs: number;
  worktrees: number;
  kept: number;
  failed: number;
}

/**
 * Prune one old terminal job: its kept worktrees first, then its rows, then its run logs.
 *
 * A pruned job's rows are the only record of where its worktrees are, so a worktree is never
 * left behind silently: a clean one is removed (its commits stay on the job branch, which is
 * kept), and a job with a worktree that has uncommitted or untracked changes, or one updraft did
 * not create, is kept whole and reported.
 */
async function pruneOneJob(env: CleanEnv, job: PrunableJob, cutoff: string, dryRun: boolean, totals: PruneTotals): Promise<void> {
  const { ctx, db } = env;
  const label = `${job.repoFullName}#${job.issueNumber}, ${job.status}, finished ${job.finishedAt}`;
  const keep = (why: string) => {
    totals.kept++;
    println(ctx.out, `Kept job ${job.id} (${label}): ${why}`);
  };
  if (job.keep) return keep(job.keep);

  // What is left after the worktree pass (in a dry run, what would be left).
  const checkouts = job.runs.filter(
    (r): r is typeof r & { checkoutPath: string } => r.checkoutPath !== null && !env.wouldRemove.has(r.id),
  );
  for (const r of checkouts) {
    if (!isInside(env.root, r.checkoutPath)) {
      return keep(`its checkout ${r.checkoutPath} is not under ${env.root}, so updraft did not create it`);
    }
    if (!existsSync(r.checkoutPath)) continue;
    let changes: string;
    try {
      changes = (await runGit(['status', '--porcelain'], { cwd: r.checkoutPath, git: env.git })).stdout.trim();
    } catch (err) {
      return keep(`could not inspect its worktree ${r.checkoutPath}: ${message(err)}`);
    }
    if (changes) {
      return keep(`its worktree ${r.checkoutPath} has uncommitted or untracked changes; commit or discard them, or remove the worktree`);
    }
  }

  const logDirs = job.runs.map((r) => runLogDir(ctx.paths.runsDir, r)).filter((d): d is string => d !== null && existsSync(d));
  if (dryRun) {
    totals.jobs++;
    totals.runs += job.runs.length;
    totals.logDirs += logDirs.length;
    totals.worktrees += checkouts.length;
    println(ctx.out, `Would prune job ${job.id} (${label}): ${job.runs.length} run(s), ${logDirs.length} log dir(s), ${checkouts.length} worktree(s)`);
    return;
  }

  for (const r of checkouts) {
    try {
      await removeCheckout(env, { runId: r.id, repoId: job.repoId, path: r.checkoutPath });
      totals.worktrees++;
    } catch (err) {
      totals.failed++;
      println(ctx.err, `Could not remove ${r.checkoutPath} (job ${job.id}, run ${r.id}): ${message(err)}; the job was not pruned`);
      return;
    }
  }
  const result = pruneJob(db, job.id, cutoff, ctx.now);
  if (!result.pruned) return keep(result.why); // retried or published since it was listed
  totals.jobs++;
  totals.runs += result.runs.length;
  totals.errors += result.errors;
  // Rows first, logs second: if a directory cannot be deleted, a leftover log is harmless,
  // while a job whose logs vanished but whose rows stayed would point at nothing.
  for (const dir of logDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      totals.logDirs++;
    } catch (err) {
      totals.failed++;
      println(ctx.err, `Could not remove log directory ${dir} (job ${job.id}): ${message(err)}; delete it by hand`);
    }
  }
  println(ctx.out, `Pruned job ${job.id} (${label}): ${result.runs.length} run(s), ${logDirs.length} log dir(s), ${checkouts.length} worktree(s)`);
}

/** `--older-than`: prune terminal jobs finished before the cutoff, and error rows older than it. */
async function pruneOldState(env: CleanEnv, ageMs: number, dryRun: boolean): Promise<number> {
  const { ctx, db } = env;
  const cutoff = new Date(ctx.now() - ageMs).toISOString();
  const totals: PruneTotals = { jobs: 0, runs: 0, errors: 0, logDirs: 0, worktrees: 0, kept: 0, failed: 0 };
  for (const job of listPrunableJobs(db, cutoff)) await pruneOneJob(env, job, cutoff, dryRun, totals);
  // Error rows of the pruned jobs went with them; the rest go by age.
  const errors = dryRun ? countOldErrors(db, cutoff) : totals.errors + pruneErrors(db, cutoff);

  const parts = [
    `${dryRun ? 'would prune' : 'pruned'} ${totals.jobs} job(s) finished before ${cutoff} ` +
      `(${totals.runs} run(s), ${totals.logDirs} log dir(s), ${totals.worktrees} worktree(s)) and ${errors} old error row(s)`,
    `kept ${totals.kept} old job(s)`,
  ];
  if (totals.failed) parts.push(`${totals.failed} removal(s) failed`);
  println(ctx.out, `${parts.join(', ')}.`);
  return totals.failed;
}

export async function cleanCommand(ctx: CommandContext, opts: CleanOptions = {}): Promise<number> {
  const { paths } = ctx;
  // Reject a bad age before anything is removed.
  const pruneAgeMs = opts.olderThan === undefined ? null : parseAge(opts.olderThan);
  if (!existsSync(paths.dbFile)) {
    println(ctx.out, 'No state database yet; nothing to clean.');
    return EXIT.OK;
  }
  // The config is only needed to prune worktrees whose directory is already gone.
  let config: UpdraftConfig | null = null;
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
  const env: CleanEnv = { ctx, db, config, root, git: opts.git, wouldRemove: new Set() };
  try {
    const rows = db
      .prepare(
        `SELECT r.id AS run_id, r.job_id, r.outcome, r.ended_at, r.execution_started_at, r.checkout_path,
                j.repo_id, j.repo_full_name, j.issue_number
         FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.checkout_path IS NOT NULL
         ORDER BY r.started_at, r.id`,
      )
      .all() as unknown as CheckoutRow[];

    for (const row of rows) {
      const path = row.checkout_path;
      const label = `${row.repo_full_name}#${row.issue_number}, job ${row.job_id}, run ${row.run_id}`;
      const verdict = cleanVerdict({ outcome: row.outcome, endedAt: row.ended_at, executionStartedAt: row.execution_started_at });
      if (!verdict.remove) {
        kept++;
        println(ctx.out, `Kept ${path} (${label}: ${verdict.why})`);
        continue;
      }
      if (!isInside(root, path)) {
        kept++;
        println(ctx.out, `Kept ${path} (${label}): not under ${root}, so updraft did not create it`);
        continue;
      }
      if (opts.dryRun) {
        env.wouldRemove.add(row.run_id);
        removed++;
        println(ctx.out, `${verb} ${path} (${label}: ${verdict.why})`);
        continue;
      }
      try {
        await removeCheckout(env, { runId: row.run_id, repoId: row.repo_id, path });
        removed++;
        println(ctx.out, `${verb} ${path} (${label}: ${verdict.why})`);
      } catch (err) {
        failed++;
        println(ctx.err, `Could not remove ${path} (${label}): ${message(err)}`);
      }
    }

    const parts = [`${opts.dryRun ? 'would remove' : 'removed'} ${removed} worktree(s)`, `kept ${kept}`];
    if (failed) parts.push(`${failed} could not be removed`);
    println(ctx.out, `${parts.join(', ')}. Branches are kept; delete them with "git branch -D" when no longer needed.`);

    // After the worktree pass, so a pruned job's removable worktrees are already gone.
    if (pruneAgeMs !== null) failed += await pruneOldState(env, pruneAgeMs, Boolean(opts.dryRun));

    // Clones the worker made have git's automatic gc off for agents (src/git/clone.ts): collect here.
    if (!opts.dryRun && config) {
      for (const repo of Object.values(config.repositories)) {
        if (!repo.checkoutPath) continue;
        const checkoutPath = resolve(paths.configDir, repo.checkoutPath);
        if (!existsSync(checkoutPath)) continue;
        const gc = await housekeepManagedClone({ checkoutPath, intervalMs: 0, hooksPath: join(paths.dataDir, 'no-hooks'), ...(opts.git ? { git: opts.git } : {}) });
        if (gc.ran) println(ctx.out, `Collected garbage in ${checkoutPath} (git gc --auto)`);
        else if (gc.why.includes('failed')) println(ctx.err, `Could not collect garbage in ${checkoutPath}: ${gc.why}`);
      }
    }
  } finally {
    db.close();
  }
  return failed ? EXIT.FAILURE : EXIT.OK;
}
