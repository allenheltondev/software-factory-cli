// OWNER: queue/worker workstream. Startup reconciliation of runs left open by a previous worker.
import { recordError, type Db } from '../db/database.js';
import { finishRun, listOpenRuns, releaseClaim } from '../db/queue.js';
import type { Run } from '../types.js';
import { nowIso } from '../util/ids.js';
import type { Logger } from '../util/log.js';
import type { ProcessControl } from './process.js';

export interface ReconcileOptions {
  /** This worker's host. Only pids recorded by runs claimed on this host are signalled. */
  hostname: string;
  processControl: ProcessControl;
  log: Logger;
  now?: () => number;
}

export interface ReconcileResult {
  /** Runs whose execution had started; they and their jobs are now 'interrupted'. */
  interrupted: Run[];
  /** Runs that were claimed but never started; closed without an outcome, jobs requeued. */
  requeued: Run[];
}

/**
 * Close every run a previous worker left open.
 *
 * - Never started (no execution_started_at and no recorded pid; e.g. the worker was still
 *   in the pre-start check, or died between claim and launch): close the run without an
 *   outcome and put the job back to 'queued'. No agent touched anything, so no human is needed.
 * - Started: if its recorded agent pid is alive on this host, terminate it (best effort),
 *   then mark the run and its job 'interrupted'. The run's checkout and log are kept. The
 *   job is NOT requeued; the user decides with `factory retry`.
 *
 * A pid is only signalled when the run was claimed on this host (runs.hostname), whichever
 * earlier worker claimed it, so a pid recorded on another machine is never killed. Runs
 * with no recorded host are never signalled.
 */
export async function reconcileInterruptedRuns(db: Db, opts: ReconcileOptions): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now;
  const result: ReconcileResult = { interrupted: [], requeued: [] };
  for (const run of listOpenRuns(db)) {
    if (run.executionStartedAt === null && run.pid === null) {
      releaseClaim(db, run.id, `requeued: worker ${run.workerId} stopped before the run started`, now);
      opts.log.info('requeued run that never started', { runId: run.id, jobId: run.jobId, agent: run.agent });
      result.requeued.push(run);
      continue;
    }
    const sameHost = run.hostname !== null && run.hostname === opts.hostname;
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
        note = `; agent pid ${run.pid} was not signalled (recorded on ${run.hostname ? `host ${run.hostname}` : 'an unknown host'})`;
      }
    }
    finishRun(db, run.id, {
      outcome: 'interrupted',
      error: `worker ${run.workerId} stopped while the run was in progress${note}`,
      now,
    });
    opts.log.warn('marked run interrupted', { runId: run.id, jobId: run.jobId, agent: run.agent });
    result.interrupted.push(run);
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
  return result;
}
