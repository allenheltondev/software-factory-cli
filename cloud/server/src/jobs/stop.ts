import type { Job, JobStop, Store } from '../store/store.js';
import { isTerminated, unusedTime } from './quotas.js';
import { workflowSubjects } from './workflow-gate.js';

export interface StopResult {
  jobId: string;
  state: 'stopping' | 'canceled' | 'finished';
  stop?: JobStop;
}

export const stopSubjects = workflowSubjects;

export async function workflowIsPaused(store: Store, job: Pick<Job, 'installationId' | 'repositoryId' | 'issue' | 'pullRequest' | 'workflowIssue' | 'resumeOf'>): Promise<boolean> {
  for (const subject of stopSubjects(job)) {
    const pause = await store.getWorkflowPause(job.installationId, job.repositoryId, subject);
    if (pause && pause.jobId !== job.resumeOf) return true;
  }
  return false;
}

/** Shared cancellation primitive. Callers authenticate the operator; execution
 * identifiers always come from the store, never from a request body. */
export function createJobStopper(d: {
  store: Store;
  terminateMicrovm(id: string): Promise<void>;
  microvmState(id: string): Promise<string | null>;
  native?: { stop(job: Job): Promise<boolean> };
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}) {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((event) => console.log(JSON.stringify(event)));
  const result = (job: Job): StopResult => ({ jobId: job.jobId,
    state: job.stop && job.stop.confirmedAt === undefined ? 'stopping' : job.outcome === 'canceled' ? 'canceled' : 'finished',
    ...(job.stop ? { stop: job.stop } : {}),
  });
  async function advance(given: Job): Promise<StopResult> {
    const job = await d.store.getJob(given.jobId);
    if (!job || job.installationId !== given.installationId) throw new Error('Stop target disappeared');
    if (!job.stop) return result(job);
    try {
      if (job.stop.confirmedAt !== undefined) {
        if (job.native) await d.native?.stop(job);
        await d.store.releaseJob(job, unusedTime(job, job.stop.confirmedAt));
        return result((await d.store.getJob(job.jobId)) ?? job);
      }
      let ended = false;
      if (job.native) {
        if (!d.native) throw new Error('Subscription cancellation is unavailable');
        ended = await d.native.stop(job);
      } else if (job.microvmId) {
        if (!isTerminated(await d.microvmState(job.microvmId))) await d.terminateMicrovm(job.microvmId);
        ended = isTerminated(await d.microvmState(job.microvmId));
      } else {
        const entry = (await d.store.listActiveJobs()).find((e) => e.jobId === job.jobId);
        // markLaunching checks the same fence. A reservation won here can never launch.
        if (entry?.phase === 'reserved') ended = await d.store.cancelReservation(entry, 'reserved') === 'cancelled';
        // A lost launch response is not evidence that no VM exists. Retain capacity to expiry.
        else ended = (job.launchingAt === undefined && !entry) || now() > job.expiresAt;
      }
      if (ended) {
        await d.store.finishJob(job.jobId, 'canceled', { at: now() });
        await d.store.recordJobStop(job, { confirmedAt: now(), error: '' });
        await d.store.releaseJob(job, unusedTime(job, now()));
        log({ jobStop: 'confirmed', jobId: job.jobId, installationId: job.installationId, latencyMs: now() - job.stop.requestedAt });
      }
    } catch (error) {
      const name = (error as Error)?.name || 'Error';
      await d.store.recordJobStop(job, { error: `Stopping failed (${name}). The request remains active; retry is safe.` });
      log({ jobStop: 'failed', jobId: job.jobId, installationId: job.installationId, name });
    }
    return result((await d.store.getJob(job.jobId)) ?? job);
  }
  async function request(installationId: number, jobId: string, by: string, reason: string): Promise<StopResult | null> {
    const summary = await d.store.getJobSummary(installationId, jobId);
    const job = summary ? await d.store.getJob(jobId) : null;
    if (!job || job.installationId !== installationId) return null;
    if (job.status === 'finished' && !job.stop) return result(job);
    const stopped = await d.store.requestJobStop(job, { requestedAt: now(), by, reason }, stopSubjects(job, summary?.detail?.prNumber));
    if (!stopped) return null;
    log({ jobStop: 'requested', jobId, installationId, by: stopped.stop?.by, at: stopped.stop?.requestedAt });
    return advance(stopped);
  }
  return { request, advance };
}
