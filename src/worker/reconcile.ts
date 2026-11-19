// OWNER: queue/worker workstream. Startup reconciliation of runs left open by a previous worker.
import { recordError, transaction, type Db } from '../db/database.js';
import { noteJobFinished } from '../db/metrics.js';
import { finishRun, listOpenRuns, releaseClaim } from '../db/queue.js';
import type { Run } from '../types.js';
import { nowIso } from '../util/ids.js';
import type { Logger } from '../util/log.js';
import { defaultContainerControl, type ContainerControl } from './container.js';
import { terminateIfSameProcess, type ProcessControl } from './process.js';

export interface ReconcileOptions {
  /** This worker's host. Only pids recorded by runs claimed on this host are signalled. */
  hostname: string;
  processControl: ProcessControl;
  /** Removes a containerized run's container. Defaults to the real runtime client. */
  containers?: ContainerControl;
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
 *   job is NOT requeued; the user decides with `updraft retry`.
 *
 * A pid is only signalled when the run was claimed on this host (runs.hostname), whichever
 * earlier worker claimed it, and the process's OS start time still matches the one recorded
 * at spawn (runs.pid_start_time), so a pid recorded on another machine, or one the OS has
 * since given to another process, is never killed. Runs with no recorded host or start time
 * are never signalled.
 *
 * A containerized run (runs.container_name) also has its container removed, first, with the
 * runtime client recorded for the run: killing the client's pid alone can leave the container
 * running. The same host rule applies; the name carries the run id, so it can't be another
 * run's container.
 */
export async function reconcileInterruptedRuns(db: Db, opts: ReconcileOptions): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now;
  const result: ReconcileResult = { interrupted: [], requeued: [] };
  for (const run of listOpenRuns(db)) {
    if (run.executionStartedAt === null && run.pid === null && run.container === null) {
      releaseClaim(db, run.id, `requeued: worker ${run.workerId} stopped before the run started`, now);
      opts.log.info('requeued run that never started', { runId: run.id, jobId: run.jobId, agent: run.agent });
      result.requeued.push(run);
      continue;
    }
    const sameHost = run.hostname !== null && run.hostname === opts.hostname;
    let note = '';
    if (run.container !== null) {
      const c = run.container;
      if (sameHost) {
        const r = await (opts.containers ?? defaultContainerControl).remove(c.runtime, c.name);
        if (r.removed) opts.log.warn('removed container left by previous worker', { runId: run.id, container: c.name });
        else if (r.note) opts.log.warn('could not remove a recorded container', { runId: run.id, container: c.name, why: r.note });
        if (r.note) note = `; ${r.note}`;
      } else {
        note = `; container ${c.name} was not removed (recorded on ${run.hostname ? `host ${run.hostname}` : 'an unknown host'})`;
      }
    }
    if (run.pid !== null) {
      if (sameHost) {
        const r = await terminateIfSameProcess(opts.processControl, run.pid, run.pidStartTime);
        if (r.terminated) opts.log.warn('terminated agent process left by previous worker', { runId: run.id, pid: run.pid });
        else if (r.note) opts.log.warn('left a recorded agent pid alone', { runId: run.id, pid: run.pid, why: r.note });
        if (r.note) note += `; ${r.note}`;
      } else {
        note += `; agent pid ${run.pid} was not signalled (recorded on ${run.hostname ? `host ${run.hostname}` : 'an unknown host'})`;
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
    transaction(db, () => {
      db.prepare("UPDATE jobs SET status = 'interrupted', status_reason = ?, updated_at = ? WHERE id = ?").run(
        reason,
        at,
        j.id,
      );
      noteJobFinished(db, j.id);
      recordError(db, { scope: 'worker', jobId: j.id, repoFullName: j.repo_full_name, message: reason, at });
    });
  }
  return result;
}
