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
import { settleUnfinished, STEP_TABLES } from '../db/merge.js';
import { getJob, retryJob } from '../db/queue.js';

/** What `updraft run-event --json` says about an abandoned run it settled (RunEventSummary.abandonedRun). */
export interface AbandonedRunSummary {
  jobId: string;
  /** The run that was left open; null when the job was `running` with no open run. */
  runId: string | null;
  /** When the hold of the run that vanished ended (its expiry, or its release); null when the state has no hold for the job. */
  heldUntil: string | null;
  /** How the run was closed: `interrupted` (its agent had started) or `released` (it was only claimed). */
  settled: 'interrupted' | 'released';
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
