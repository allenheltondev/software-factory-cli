// OWNER: queue/worker workstream. Startup reconciliation of runs left open by a previous worker.
import { recordError, type Db } from '../db/database.js';
import { finishRun, listOpenRuns } from '../db/queue.js';
import type { Run } from '../types.js';
import { nowIso } from '../util/ids.js';
import type { Logger } from '../util/log.js';
import type { LockHolder } from './lock.js';
import type { ProcessControl } from './process.js';

export interface ReconcileOptions {
  /** Holder whose lock this worker took over (from acquireWorkerLock), if any. */
  previousHolder: LockHolder | null;
  hostname: string;
  processControl: ProcessControl;
  log: Logger;
  now?: () => number;
}

/**
 * Close every run a previous worker left open: if its recorded agent pid is alive on
 * this host, terminate it (best effort), then mark the run and its job 'interrupted'.
 * The run's checkout and log are kept. Jobs are NOT requeued; the user decides with
 * `factory retry`. Returns the runs that were interrupted.
 *
 * A pid is only signalled when the run belongs to the previous lock holder and that
 * holder was on this host, so a pid recorded on another machine (or reused) is never killed.
 */
export async function reconcileInterruptedRuns(db: Db, opts: ReconcileOptions): Promise<Run[]> {
  const now = opts.now ?? Date.now;
  const open = listOpenRuns(db);
  for (const run of open) {
    const sameHost =
      opts.previousHolder !== null &&
      opts.previousHolder.workerId === run.workerId &&
      opts.previousHolder.hostname === opts.hostname;
    let note = '';
    if (run.pid !== null) {
      if (sameHost && opts.processControl.isAlive(run.pid)) {
        opts.log.warn('terminating agent process left by previous worker', { runId: run.id, pid: run.pid });
        try {
          await opts.processControl.terminate(run.pid);
          note = `; terminated leftover agent process ${run.pid}`;
        } catch (err) {
          note = `; could not terminate agent process ${run.pid}: ${(err as Error).message}`;
        }
      } else if (!sameHost) {
        note = `; agent pid ${run.pid} was not signalled (recorded by another worker/host)`;
      }
    }
    finishRun(db, run.id, {
      outcome: 'interrupted',
      error: `worker ${run.workerId} stopped while the run was in progress${note}`,
      now,
    });
    opts.log.warn('marked run interrupted', { runId: run.id, jobId: run.jobId, agent: run.agent });
  }

  // Defensive: a job left 'running' with no open run would block its issue forever.
  const stranded = db
    .prepare(
      `SELECT id, repo_full_name FROM jobs WHERE status = 'running'
       AND id NOT IN (SELECT job_id FROM runs WHERE ended_at IS NULL)`,
    )
    .all() as { id: string; repo_full_name: string }[];
  for (const j of stranded) {
    const at = nowIso(now);
    const reason = 'job was running with no open run when the worker started';
    db.prepare("UPDATE jobs SET status = 'interrupted', status_reason = ?, updated_at = ? WHERE id = ?").run(
      reason,
      at,
      j.id,
    );
    recordError(db, { scope: 'worker', jobId: j.id, repoFullName: j.repo_full_name, message: reason, at });
  }
  return open;
}
