// A job of this event that the shared state shows as `running`, and that nobody is running any
// more: a machine checkpointed while its agent was at work and then vanished, with no final merge
// of its database. docs/run-event.md, "An abandoned run".
//
// `updraft run-event` never reconciles (an open run in a shared database is another machine's,
// and may be at work), with this one exception: the job of its OWN event, once no live hold of
// another run covers it. A run that is alive holds its job from before it claims it until it
// ends, and a checkpoint carries the hold with the job; a hold that has expired or was released
// says that the run is over. Then the job is settled exactly as the final merge of that run's
// database would have settled it (settleUnfinished), so the normal rules apply to it again.
import type { Db } from '../db/database.js';
import { holdKey, listHolds } from '../db/holds.js';
import { settleUnfinished, STEP_TABLES, UNFINISHED_PUSH_NOTE } from '../db/merge.js';
import { getPublication } from '../db/publications.js';
import { getJob, latestRunOfJob, retryJob } from '../db/queue.js';

/** What `updraft run-event --json` says about an abandoned run it settled (RunEventSummary.abandonedRun). */
export interface AbandonedRunSummary {
  jobId: string;
  /** The run that was left open; null when the job was `running` with no open run. */
  runId: string | null;
  /** When the hold of the run that vanished ended (its expiry, or its release); null when the state has no hold for the job. */
  heldUntil: string | null;
  /**
   * How the run was closed: `interrupted` (its agent had started) or `released` (it was only
   * claimed); `publication` when its agent had finished and only its publication was left
   * mid-step (taken over, or failed when its commits are not on GitHub as the run ended).
   */
  settled: 'interrupted' | 'released' | 'publication';
  /** True when this run then did the job itself, as its next attempt. */
  resumed: boolean;
  /** The job branch GitHub already has for the event, which is why nothing was started; null otherwise. */
  existingBranch: string | null;
  /** One line for a person: what was found and what was done. */
  detail: string;
}

/** When the hold on `jobId` ended: its release, or its expiry. Null when there is none on record. */
export function holdEnd(db: Db, jobId: string): string | null {
  const hold = listHolds(db).find((h) => h.key === holdKey({ job: jobId }));
  return hold ? (hold.releasedAt ?? hold.until) : null;
}

/**
 * Close what the vanished run left open for `jobId`, and nothing else: its open runs, the job
 * itself, the steps towards GitHub of its runs, and its hold. Every other row of the database is
 * another event's and is not read. The caller has established that no live hold covers the job.
 */
export function settleAbandonedJob(db: Db, jobId: string, now: () => number): { runId: string | null; settled: 'interrupted' | 'released'; status: string } {
  const runs = (db.prepare('SELECT id FROM runs WHERE job_id = ? ORDER BY started_at, rowid').all(jobId) as Array<{ id: string }>).map((r) => r.id);
  const open = (db.prepare('SELECT id FROM runs WHERE job_id = ? AND ended_at IS NULL ORDER BY started_at, rowid').all(jobId) as Array<{ id: string }>).map((r) => r.id);
  const done = settleUnfinished(db, { runs: open, jobs: [jobId], steps: new Map(STEP_TABLES.map((t) => [t, runs])), holds: [holdKey({ job: jobId })] }, now);
  return { runId: open[open.length - 1] ?? null, settled: done.runsReleased > 0 && done.runsInterrupted === 0 ? 'released' : 'interrupted', status: getJob(db, jobId)?.status ?? 'unknown' };
}

/**
 * Put a settled job back in the queue for this run: the redelivery is the retry. The same
 * requeue as `updraft retry` (and with its refusals), under a reason that says who asked.
 */
export function requeueAbandonedJob(db: Db, jobId: string, reason: string, now: () => number): void {
  retryJob(db, jobId, now);
  db.prepare("UPDATE jobs SET status_reason = ? WHERE id = ? AND status = 'queued'").run(reason, jobId);
}

/**
 * A job of this event whose agent finished but whose publication never did: the job is
 * `succeeded` and its publication has no pull request and is either still `publishing` (a
 * checkpoint carried it, and the machine vanished before the rest of its database was saved) or
 * `failed` only because a final merge closed it unfinished (UNFINISHED_PUSH_NOTE; the runner
 * merged what was there before the machine went). A publication GitHub or Updraft refused is not
 * this, and stays as it is. The caller has established that no live hold covers the job.
 */
export interface StalledPublication {
  jobId: string;
  runId: string;
  branch: string;
  /** The commit the run ended on (its summary): what may be published, and nothing else. */
  endedSha: string | null;
}

/** The publication rows findStalledPublication takes; one parameter, UNFINISHED_PUSH_NOTE. */
const STALLED = "(state = 'publishing' OR (state = 'failed' AND retryable = 0 AND instr(coalesce(error, ''), ?) > 0))";

export function findStalledPublication(db: Db, jobId: string): StalledPublication | null {
  if (getJob(db, jobId)?.status !== 'succeeded') return null;
  const run = latestRunOfJob(db, jobId);
  if (!run || run.outcome !== 'succeeded') return null;
  const pub = getPublication(db, run.id);
  if (!pub || pub.prNumber !== null) return null;
  const unfinished = pub.state === 'publishing' || (pub.state === 'failed' && !pub.retryable && (pub.error ?? '').includes(UNFINISHED_PUSH_NOTE));
  if (!unfinished) return null;
  return { jobId, runId: run.id, branch: pub.branch, endedSha: run.summary?.headSha ?? null };
}

/**
 * The run's commit is on GitHub, exactly as it ended: hand the publication back to the publisher,
 * due now, as a retryable failure. Its next attempt finds the branch already pushed and opens
 * the pull request; no agent runs again.
 */
export function resumeStalledPublication(db: Db, runId: string, reason: string, now: () => number): void {
  const at = new Date(now()).toISOString();
  // Due since the vanished run's lease on it ran out: that moment has passed on any clock.
  db.prepare(
    `UPDATE publications SET state = 'failed', retryable = 1, next_attempt_at = coalesce(lease_expires_at, updated_at), lease_expires_at = NULL,
            error = ?, updated_at = ?
     WHERE run_id = ? AND ${STALLED}`,
  ).run(reason, at, runId, UNFINISHED_PUSH_NOTE);
}

/**
 * The run's commit is not on GitHub as it ended (absent, or another commit is on its branch):
 * nothing can be published for it. The publication fails for good and the job is `failed`, which
 * `updraft retry` takes; the caller decides whether this delivery runs it again.
 */
export function failStalledPublication(db: Db, s: StalledPublication, reason: string, now: () => number): void {
  const at = new Date(now()).toISOString();
  db.prepare(
    `UPDATE publications SET state = 'failed', retryable = 0, next_attempt_at = NULL, lease_expires_at = NULL, error = ?, updated_at = ?
     WHERE run_id = ? AND ${STALLED}`,
  ).run(reason, at, s.runId, UNFINISHED_PUSH_NOTE);
  db.prepare("UPDATE jobs SET status = 'failed', status_reason = ?, updated_at = ? WHERE id = ? AND status = 'succeeded'").run(reason, at, s.jobId);
}
