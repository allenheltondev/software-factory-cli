import type { Job, JobStop, Store } from '../store/store.js';
import { isTerminated, unusedTime } from './quotas.js';
import { workflowSubjects } from './workflow-gate.js';

export interface StopResult {
  jobId: string;
  state: 'stopping' | 'canceled' | 'finished';
  stop?: JobStop;
  /** Execution termination does not imply quota/refund cleanup succeeded. */
  accountingComplete: boolean;
}

export const stopSubjects = workflowSubjects;

export async function workflowPause(store: Pick<Store, 'getWorkflowPause'>, job: Pick<Job, 'installationId' | 'repositoryId' | 'issue' | 'pullRequest' | 'workflowIssue' | 'resumeOf'>) {
  for (const subject of stopSubjects(job)) {
    const pause = await store.getWorkflowPause(job.installationId, job.repositoryId, subject);
    if (pause && pause.jobId !== job.resumeOf) return pause;
  }
  return null;
}
/** Every subject this job's stop paused: what its pause records name, and the job's own. */
async function subjectsPausedBy(store: Pick<Store, 'getWorkflowPause'>, job: Pick<Job, 'jobId' | 'installationId' | 'repositoryId' | 'issue' | 'pullRequest' | 'workflowIssue'>): Promise<number[]> {
  const out = new Set<number>();
  for (const subject of stopSubjects(job)) {
    const pause = await store.getWorkflowPause(job.installationId, job.repositoryId, subject);
    if (pause?.jobId === job.jobId) for (const n of [subject, ...(pause.subjects ?? [])]) out.add(n);
  }
  return [...out];
}

export type ResumeOutcome = 'resumed' | 'not_paused' | 'stop_pending' | 'changed';

/**
 * Resume the pause that holds `subject` now, if it is `expected` (when given): every subject that
 * pause holds, in one transaction against exactly that pause, so a newer stop always wins. It
 * needs no job record: the pause says when its execution was confirmed ended, and a stopped job
 * whose record is gone (kept a week past its maximum run) can no longer be running. A job record
 * that still exists and is not confirmed means its execution may still run: not yet.
 */
export async function resumeWorkflowPause(
  store: Pick<Store, 'getWorkflowPause' | 'getJob' | 'resumeWorkflowPause'>,
  o: { installationId: number; repositoryId: number; subject: number; expected?: { jobId: string; at: number }; by: string; at: number },
): Promise<ResumeOutcome> {
  const pause = await store.getWorkflowPause(o.installationId, o.repositoryId, o.subject);
  if (!pause) return 'not_paused';
  if (o.expected && (o.expected.jobId !== pause.jobId || o.expected.at !== pause.at)) return 'changed';
  if (pause.confirmedAt === undefined) {
    const job = await store.getJob(pause.jobId);
    if (job && job.installationId === o.installationId && job.stop?.confirmedAt === undefined) return 'stop_pending';
  }
  const subjects = [...new Set([o.subject, ...(pause.subjects ?? [])])];
  return (await store.resumeWorkflowPause(o.installationId, o.repositoryId, pause, subjects, o.by, o.at)) ? 'resumed' : 'changed';
}

/**
 * Resume the pause a stopped job made, from the job (its page, or a retry of it): the pause on any
 * of its subjects, as a whole. A subject held by another job's newer stop: `changed`, nothing done.
 * Nothing paused any more (resumed from the workflow already): the job is marked resumed too.
 */
export async function resumeJobPause(
  store: Pick<Store, 'getWorkflowPause' | 'getJob' | 'resumeWorkflowPause'>,
  job: Job & { stop: NonNullable<Job['stop']> },
  subjects: number[],
  by: string,
  at: number,
): Promise<ResumeOutcome> {
  for (const subject of new Set(subjects)) {
    const pause = await store.getWorkflowPause(job.installationId, job.repositoryId, subject);
    if (!pause) continue;
    if (pause.jobId !== job.jobId) return 'changed';
    return resumeWorkflowPause(store, { installationId: job.installationId, repositoryId: job.repositoryId, subject, expected: pause, by, at });
  }
  return (await store.resumeWorkflowPause(job.installationId, job.repositoryId, { jobId: job.jobId, at: job.stop.requestedAt }, [], by, at)) ? 'resumed' : 'changed';
}

export async function workflowIsPaused(store: Pick<Store, 'getWorkflowPause'>, job: Parameters<typeof workflowPause>[1]): Promise<boolean> { return !!await workflowPause(store, job); }

/** Shared cancellation primitive. Callers authenticate the operator; execution
 * identifiers always come from the store, never from a request body. */
export function createJobStopper(d: {
  store: Store;
  terminateMicrovm(id: string): Promise<void>;
  microvmState(id: string): Promise<string | null>;
  native?: { stop(job: Job): Promise<boolean> };
  workflows?: import('../workflows/recorder.js').WorkflowRecorder;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}) {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((event) => console.log(JSON.stringify(event)));
  const result = (job: Job, accountingComplete = false): StopResult => ({ jobId: job.jobId, accountingComplete,
    state: job.stop && job.stop.confirmedAt === undefined ? 'stopping' : job.outcome === 'canceled' ? 'canceled' : 'finished',
    ...(job.stop ? { stop: job.stop } : {}),
  });
  /** The pause says its execution ended, so it can be resumed once the job's records are gone. Best effort: the job's record says so meanwhile. */
  async function confirmPause(job: Job, confirmedAt: number) {
    try {
      await d.store.confirmWorkflowPause(job, await subjectsPausedBy(d.store, job), confirmedAt);
    } catch (error) {
      log({ jobStop: 'pause_confirm_failed', jobId: job.jobId, name: (error as Error)?.name });
    }
  }
  async function retireReturnedVm(given: Job, microvmId: string): Promise<StopResult> {
    // Only the trusted launcher calls this with its own RunMicrovm response. No tenant
    // endpoint accepts VM identifiers. A storage outage must not prevent termination.
    let persisted = false;
    try {
      const stopped = await d.store.requestJobStop(given, { requestedAt: now(), by: 'workflow control', reason: 'VM registration failed; retiring this attempt', executionMicrovmId: microvmId }, []);
      if (stopped?.stop) { await d.store.recordJobStop(given, { executionMicrovmId: microvmId }); persisted = true; }
    } catch (error) { log({ jobStop: 'registration_failed', jobId: given.jobId, microvmId, name: (error as Error)?.name }); }
    // Ask for termination even if BOTH metadata writes failed. Keep the reservation and
    // report the exact target in server logs if physical termination cannot be confirmed.
    try { await d.terminateMicrovm(microvmId); }
    catch (error) {
      log({ jobStop: 'termination_failed', jobId: given.jobId, microvmId, name: (error as Error)?.name });
      if (!persisted) throw error;
      await d.store.recordJobStop(given, { error: 'Stopping the returned VM failed. Its identity is retained; reconciliation retries automatically.' });
      return result((await d.store.getJob(given.jobId)) ?? given);
    }
    if (!persisted) {
      const stopped = await d.store.requestJobStop(given, { requestedAt: now(), by: 'workflow control', reason: 'VM registration failed; retiring this attempt', executionMicrovmId: microvmId }, []);
      if (!stopped?.stop) throw new Error('Could not persist the returned VM retirement target');
      await d.store.recordJobStop(given, { executionMicrovmId: microvmId });
    }
    return advance(given);
  }
  async function advance(given: Job, returnedMicrovmId?: string): Promise<StopResult> {
    if (returnedMicrovmId !== undefined) return retireReturnedVm(given, returnedMicrovmId);
    const job = await d.store.getJob(given.jobId);
    if (!job || job.installationId !== given.installationId) throw new Error('Stop target disappeared');
    if (!job.stop) return result(job);
    let accountingComplete = false;
    let executionConfirmed = job.stop.confirmedAt !== undefined;
    try {
      if (job.stop.confirmedAt !== undefined) {
        await confirmPause(job, job.stop.confirmedAt);
        if (job.native) await d.native?.stop(job);
        await d.store.releaseJob(job, unusedTime(job, job.stop.confirmedAt));
        accountingComplete = true;
        await d.store.recordJobStop(job, { error: '' });
        return result((await d.store.getJob(job.jobId)) ?? job, true);
      }
      let ended = false;
      if (job.native) {
        if (!d.native) throw new Error('Subscription cancellation is unavailable');
        ended = await d.native.stop(job);
      } else if (job.microvmId ?? job.stop.executionMicrovmId) {
        const microvmId = (job.microvmId ?? job.stop.executionMicrovmId)!;
        if (!isTerminated(await d.microvmState(microvmId))) await d.terminateMicrovm(microvmId);
        ended = isTerminated(await d.microvmState(microvmId));
      } else {
        const entry = (await d.store.listActiveJobs()).find((e) => e.jobId === job.jobId);
        // markLaunching checks the same fence. A reservation won here can never launch.
        if (entry?.phase === 'reserved') ended = await d.store.cancelReservation(entry, 'reserved') === 'cancelled';
        // A lost launch response is not evidence that no VM exists. Retain capacity to expiry.
        else ended = (job.launchingAt === undefined && !entry) || now() > job.expiresAt;
      }
      if (ended) {
        const outcome = await d.store.finishJob(job.jobId, 'canceled', { at: now() });
        await d.workflows?.finished(job, outcome ?? 'canceled');
        const confirmedAt = now();
        await d.store.recordJobStop(job, { confirmedAt, error: '' });
        executionConfirmed = true;
        await confirmPause(job, confirmedAt);
        await d.store.releaseJob(job, unusedTime(job, now()));
        accountingComplete = true;
        log({ jobStop: 'confirmed', jobId: job.jobId, installationId: job.installationId, latencyMs: now() - job.stop.requestedAt });
      }
    } catch (error) {
      const name = (error as Error)?.name || 'Error';
      await d.store.recordJobStop(job, { error: executionConfirmed
        ? `Execution ended, but capacity cleanup failed (${name}). Reconciliation retries automatically; retry cleanup is safe.`
        : `Stopping failed (${name}). The request remains active; retry is safe.` });
      log({ jobStop: 'failed', jobId: job.jobId, installationId: job.installationId, name });
    }
    return result((await d.store.getJob(job.jobId)) ?? job, accountingComplete);
  }
  async function request(installationId: number, jobId: string, by: string, reason: string): Promise<StopResult | null> {
    const summary = await d.store.getJobSummary(installationId, jobId);
    const job = summary ? await d.store.getJob(jobId) : null;
    if (!job || job.installationId !== installationId) return null;
    if (job.releasedAt !== undefined && !job.stop) {
      await d.store.releaseJob(job);
      return result(job, true);
    }
    const stopped = await d.store.requestJobStop(job, { requestedAt: now(), by, reason }, stopSubjects(job, summary?.detail?.prNumber));
    if (!stopped) return null;
    log({ jobStop: 'requested', jobId, installationId, by: stopped.stop?.by, at: stopped.stop?.requestedAt });
    return advance(stopped);
  }
  return { request, advance };
}
