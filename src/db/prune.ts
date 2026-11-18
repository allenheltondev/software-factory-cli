// Retention (`updraft clean --older-than`): delete old terminal jobs with everything that hangs
// off them, and old error rows. Nothing here runs on its own; the worker never prunes.
import { transaction, type Db } from './database.js';
import { TERMINAL_JOB_STATUSES, type JobStatus } from '../types.js';
import { nowIso } from '../util/ids.js';

/**
 * Tables with one or more rows per run, deleted together with a pruned job's runs. A new table
 * that references runs (by run id) needs one more entry here and nothing else.
 *
 * - `busy`: SQL condition (on that table's columns) under which the row is still being worked
 *   on, so its job must be kept whatever its age.
 * - `touched`: column holding the row's last change; a row changed after the cutoff keeps its job.
 */
const RUN_TABLES: ReadonlyArray<{ table: string; runColumn: string; what: string; busy?: string; touched?: string }> = [
  {
    table: 'publications',
    runColumn: 'run_id',
    what: 'publication',
    busy: "state = 'publishing' OR (state = 'failed' AND retryable = 1)",
    touched: 'updated_at',
  },
  {
    table: 'failure_comments',
    runColumn: 'run_id',
    what: 'failure comment',
    busy: "state = 'posting' OR (state = 'failed' AND retryable = 1)",
    touched: 'updated_at',
  },
  // The push and reply of a revision run. review_requests and revision_prs are deliberately not
  // here: they are what stops a review from being acted on twice, and keep a PR watched.
  {
    table: 'revisions',
    runColumn: 'run_id',
    what: 'revision push',
    busy: "state = 'publishing' OR (state = 'failed' AND retryable = 1)",
    touched: 'updated_at',
  },
];

export interface PrunableRun {
  id: string;
  logPath: string | null;
  checkoutPath: string | null;
}

export interface PrunableJob {
  id: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  status: JobStatus;
  /** When the job reached its terminal state. */
  finishedAt: string;
  runs: PrunableRun[];
  /** Why the job must be kept although it is old enough; null if it can be pruned. */
  keep: string | null;
}

const TERMINAL_SQL = TERMINAL_JOB_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Why a job cannot be pruned at `cutoff` (ISO time), or null if it can. Evaluated when listing
 * and again inside the deleting transaction, so a job that was retried, claimed or published in
 * between is left alone.
 */
function keepReason(db: Db, jobId: string, cutoff: string): string | null {
  const job = db.prepare('SELECT status, updated_at FROM jobs WHERE id = ?').get(jobId) as
    | { status: JobStatus; updated_at: string }
    | undefined;
  if (!job) return 'it no longer exists';
  if (!TERMINAL_JOB_STATUSES.includes(job.status)) return `it is ${job.status}`;
  if (job.updated_at >= cutoff) return 'it changed after the cutoff';
  const run = db
    .prepare('SELECT id, ended_at FROM runs WHERE job_id = ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 1')
    .get(jobId, cutoff) as { id: string; ended_at: string | null } | undefined;
  if (run) return run.ended_at === null ? `run ${run.id} is still open` : `run ${run.id} ended after the cutoff`;
  for (const t of RUN_TABLES) {
    const ofJob = `${t.runColumn} IN (SELECT id FROM runs WHERE job_id = ?)`;
    if (t.busy) {
      const row = db.prepare(`SELECT ${t.runColumn} AS run_id FROM ${t.table} WHERE ${ofJob} AND (${t.busy}) LIMIT 1`).get(jobId) as
        | { run_id: string }
        | undefined;
      if (row) return `the ${t.what} of run ${row.run_id} is in progress or awaiting retry`;
    }
    if (t.touched) {
      const row = db
        .prepare(`SELECT ${t.runColumn} AS run_id FROM ${t.table} WHERE ${ofJob} AND ${t.touched} >= ? LIMIT 1`)
        .get(jobId, cutoff) as { run_id: string } | undefined;
      if (row) return `the ${t.what} of run ${row.run_id} changed after the cutoff`;
    }
  }
  return null;
}

function runsOf(db: Db, jobId: string): PrunableRun[] {
  return (
    db.prepare('SELECT id, log_path, checkout_path FROM runs WHERE job_id = ? ORDER BY attempt').all(jobId) as {
      id: string;
      log_path: string | null;
      checkout_path: string | null;
    }[]
  ).map((r) => ({ id: r.id, logPath: r.log_path, checkoutPath: r.checkout_path }));
}

/**
 * Terminal jobs that reached their state before `cutoff` (ISO time), oldest first, each with its
 * runs and, when something still depends on it, the reason to keep it. Queued and running jobs
 * are never listed.
 */
export function listPrunableJobs(db: Db, cutoff: string): PrunableJob[] {
  const rows = db
    .prepare(
      `SELECT id, repo_id, repo_full_name, issue_number, status, updated_at FROM jobs
       WHERE status IN (${TERMINAL_SQL}) AND updated_at < ? ORDER BY updated_at, rowid`,
    )
    .all(cutoff) as { id: string; repo_id: number; repo_full_name: string; issue_number: number; status: JobStatus; updated_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    repoId: r.repo_id,
    repoFullName: r.repo_full_name,
    issueNumber: r.issue_number,
    status: r.status,
    finishedAt: r.updated_at,
    runs: runsOf(db, r.id),
    keep: keepReason(db, r.id, cutoff),
  }));
}

export type PruneResult = { pruned: true; runs: PrunableRun[]; errors: number } | { pruned: false; why: string };

/**
 * Delete one job with its runs, their rows in RUN_TABLES and its error rows, in one transaction
 * that first re-checks that the job may still go. The job's dedupe key (repository, workflow,
 * event) is kept in pruned_events in the same transaction: the poller re-reads recent events on
 * every scan and would otherwise enqueue the event again once its job row is gone.
 *
 * Returns the deleted runs, so the caller can remove their log directories afterwards, and how
 * many error rows went with the job.
 */
export function pruneJob(db: Db, jobId: string, cutoff: string, now?: () => number): PruneResult {
  const at = nowIso(now ?? Date.now);
  return transaction(db, (): PruneResult => {
    const why = keepReason(db, jobId, cutoff);
    if (why) return { pruned: false, why };
    const runs = runsOf(db, jobId);
    db.prepare(
      `INSERT INTO pruned_events (repo_id, workflow_id, event_id, pruned_at)
       SELECT repo_id, workflow_id, event_id, ? FROM jobs WHERE id = ?
       ON CONFLICT (repo_id, workflow_id, event_id) DO NOTHING`,
    ).run(at, jobId);
    for (const t of RUN_TABLES) {
      db.prepare(`DELETE FROM ${t.table} WHERE ${t.runColumn} IN (SELECT id FROM runs WHERE job_id = ?)`).run(jobId);
    }
    db.prepare('DELETE FROM runs WHERE job_id = ?').run(jobId);
    const errors = Number(db.prepare('DELETE FROM errors WHERE job_id = ?').run(jobId).changes);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
    return { pruned: true, runs, errors };
  });
}

/** How many error rows are older than `cutoff` (for --dry-run). */
export function countOldErrors(db: Db, cutoff: string): number {
  return (db.prepare('SELECT count(*) AS n FROM errors WHERE at < ?').get(cutoff) as { n: number }).n;
}

/** Delete error rows older than `cutoff`. Returns how many were deleted. */
export function pruneErrors(db: Db, cutoff: string): number {
  return Number(db.prepare('DELETE FROM errors WHERE at < ?').run(cutoff).changes);
}
