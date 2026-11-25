import { isBenchmarkLabel } from '../benchmarks/config.js';
import type { DeliveryRecord, JobSummary } from '../store/store.js';

export const BENCHMARK_RETRY_MESSAGE = 'To rerun this benchmark, submit a fresh arm through the benchmark harness';

/**
 * How a job ended, as the console shows it (#71). From the outcome the runner reported to the
 * broker and what it said with it (JobFinishDetail).
 *
 *   queued           waiting in the admission queue for capacity: no job has started (queue.ts)
 *   running          not finished yet
 *   success          it ran and published (or had nothing to publish)
 *   nothing_to_do    run-event found nothing to do for the event
 *   canceled         the job was canceled before any agent started
 *   superseded       it ran, and another run of the same event published first
 *   deferred         its work waits behind a usage-limit cooldown; delivering the event again later continues it
 *   agent_failure    an agent run failed, could not start or was interrupted
 *   verify_failure   the agent's change failed the workflow's verify commands
 *   publish_failure  the run succeeded; its pull request could not be published
 *   timeout          stopped by the watchdog before the microVM's maximum duration
 *   state_not_saved  it ran, and what it changed in the shared state was not saved
 *   terminated       the microVM was stopped while the job ran
 *   runner_error     the job could not run (the runner, or the sandbox check, failed)
 *   unconfirmed      it exited cleanly without a summary
 *   not_run          never ran: over a quota, superseded by a redelivery, released by an admin
 *   other            anything else (a newer outcome)
 */
export type JobResult =
  /** Waiting in the admission queue for capacity (jobs/queue.ts): not started, nothing reserved. */
  | 'queued'
  | 'running'
  | 'success'
  | 'nothing_to_do'
  | 'canceled'
  | 'superseded'
  | 'deferred'
  | 'agent_failure'
  | 'verify_failure'
  | 'publish_failure'
  | 'timeout'
  | 'state_not_saved'
  | 'terminated'
  | 'runner_error'
  | 'unconfirmed'
  | 'not_run'
  | 'other';

export function jobResult(job: Pick<JobSummary, 'status' | 'outcome' | 'detail' | 'stop'>): JobResult {
  if (job.stop && job.stop.confirmedAt === undefined) return 'running';
  if (job.status !== 'finished' || job.outcome === undefined) return 'running';
  const d = job.detail ?? {};
  switch (job.outcome) {
    case 'succeeded':
      // run-event exits 0 for these too: they completed nothing.
      if (d.updraftOutcome === 'nothing-to-do') return 'nothing_to_do';
      if (d.updraftOutcome === 'canceled') return 'canceled';
      if (d.updraftOutcome === 'superseded') return 'superseded';
      return 'success';
    case 'failed':
      if (d.updraftOutcome === 'deferred') return 'deferred';
      if (d.updraftOutcome === 'not-started') return 'not_run';
      if (d.updraftOutcome === 'publish-failed') return 'publish_failure';
      if (d.verificationPassed === false) return 'verify_failure';
      return 'agent_failure';
    case 'timed_out':
      return 'timeout';
    case 'canceled':
      return 'canceled';
    case 'microvm_gone':
      return 'terminated';
    case 'state_not_saved':
    case 'terminated':
    case 'runner_error':
    case 'unconfirmed':
      return job.outcome;
    case 'start_failed':
      return 'runner_error';
    case 'throttled':
    case 'superseded':
    case 'launch_failed':
    case 'released_by_admin':
      return 'not_run';
    default:
      return 'other';
  }
}

/** The results of a job that ended without finishing its work, which the console can run again. */
const RETRYABLE: ReadonlySet<JobResult> = new Set<JobResult>([
  'canceled',
  'agent_failure',
  'verify_failure',
  'timeout',
  'state_not_saved',
  'terminated',
  'runner_error',
  'unconfirmed',
  'not_run',
]);

/**
 * Whether the console offers a retry: the job ended, and not with work done or a better run's
 * (success, nothing to do, superseded), nor waiting out a usage limit (deferred: running it again
 * only defers it again; the cooldown's end continues it), nor a publication that failed after the
 * agent succeeded (its job is `succeeded` in the shared state, so the event would end as a
 * duplicate and publish nothing: `updraft run-event --retry` requeues only failed work).
 */
type RetryStatus = Pick<JobSummary, 'status' | 'outcome' | 'detail' | 'retriedAs' | 'pullRequest' | 'benchmark' | 'label'>;

export function retryable(job: RetryStatus): boolean {
  if (job.benchmark || isBenchmarkLabel(job.label)) return false;
  // A retry started a job for it already: that one is the one to look at (and to retry).
  if (job.retriedAs) return false;
  // A job of a pull request's review loop (a revision, a review): the loop's own records decide
  // what is left to do for it (the same change request or head is not queued twice), so running its
  // event again finds nothing new. It starts again from GitHub: a push, or a review.
  if (job.pullRequest !== undefined) return false;
  // A run another one beat to publishing is not a failure; `not_run` also covers a redelivery's.
  if (job.outcome === 'superseded') return false;
  return RETRYABLE.has(jobResult(job));
}

/** Why a job cannot be retried, in words, for the one that asked. */
export function notRetryableMessage(job: RetryStatus): string {
  if (job.benchmark || isBenchmarkLabel(job.label)) return BENCHMARK_RETRY_MESSAGE;
  if (job.retriedAs) return 'This job was already retried';
  if (jobResult(job) === 'running') return 'This job is still running';
  if (jobResult(job) === 'publish_failure') return 'The agent’s work succeeded and only publishing it failed, so running the event again would not publish it: check the App can push and open pull requests, then apply the label again on GitHub';
  if (job.pullRequest !== undefined) return 'A job of a pull request’s review loop cannot be retried here: push to the pull request, or review it again, on GitHub';
  return 'This job did not end in a way that can be retried';
}

/** Counts of each value, for a summary row. */
export function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export const deliveryCounts = (deliveries: readonly DeliveryRecord[]) => countBy(deliveries.map((d) => d.disposition));
