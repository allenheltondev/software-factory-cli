import { createHash, randomUUID } from 'node:crypto';
import { jobPaths } from '../broker/broker.js';
import type { Store } from '../store/store.js';
import { errorClassOf, newJobId, type Launcher } from './launch.js';
import { isBenchmarkLabel } from '../benchmarks/config.js';
import { BENCHMARK_RETRY_MESSAGE, notRetryableMessage, retryable } from './status.js';
import { resumeJobPause, stopSubjects } from './stop.js';

/**
 * Retrying a job from the console: the launcher runs the job's own event again.
 *
 * The API function decides who may ask (a member of the installation) and whether the job is one
 * that can be retried; this runs in the webhook function, which has the launcher and its
 * permissions, and is reached by a direct invoke (so only the API function can call it). The
 * event the job read is kept in the tenant's bucket under the job's delivery, and is launched
 * again under a delivery id of its own, so everything a new delivery gets is checked again against
 * the configuration active now: the tenant, the dispatch rules, the keys, the quotas.
 *
 * The job runs with `--retry` (the run-hook payload's `retry`): the CLI derives a job's id from its
 * event, so the shared state already holds the failed job of this event, and a plain delivery would
 * end as a duplicate. `updraft run-event --retry` requeues it there first, as `updraft retry` does.
 * Once a retry started a job, it is recorded on the original (`retriedAs`) and offered no more.
 */

/** What the API function sends the webhook function. */
export interface RetryRequest {
  updraftRetry: { installationId: number; jobId: string; by?: string };
}

/** Why a retry did not start a job; the API answers with it as the error code. */
export type RetryErrorCode =
  | 'not_found'
  | 'not_retryable'
  | 'event_unavailable'
  | 'event_gone'
  | 'already_retried'
  | 'throttled'
  | 'tenant_inactive'
  | 'no_config'
  | 'not_dispatched'
  | 'missing_key'
  | 'jobs_off'
  | 'coalesced'
  | 'launch_failed'
  | 'retry_pending'
  | 'retry_failed';

export type RetryResult =
  | { ok: true; jobId: string }
  | { ok: false; status: number; code: RetryErrorCode; message: string };

export const isRetryRequest = (event: unknown): event is RetryRequest => {
  const r = (event as RetryRequest | null)?.updraftRetry;
  return typeof r === 'object' && r !== null && Number.isSafeInteger(r.installationId) && typeof r.jobId === 'string' &&
    (r.by === undefined || typeof r.by === 'string' && r.by.length <= 200);
};

/**
 * The delivery id of a job's retry. One per job: asking twice for the same job finds the first
 * attempt's claim and starts nothing more, so a double click (or two members) cannot run it twice.
 * A delivery id is letters, digits and hyphens.
 */
export const retryDeliveryId = (jobId: string) => `retry-${createHash('sha256').update(jobId).digest('hex').slice(0, 32)}`;

/**
 * How long a request's claim on a job's retry lasts if it never ends it (the Lambda died): longer
 * than a launch takes, which the webhook function bounds at 20 seconds.
 */
export const RESERVATION_MS = 2 * 60 * 1000;
const RECORD_ATTEMPTS = 3;

export interface RetryDeps {
  store: Store;
  launch: Launcher;
  /** The event body the job was started with; null when it is gone. */
  readEvent: (key: string) => Promise<string | null>;
  /** The platform App's own login (`<slug>[bot]`), as the webhook gives the launcher. */
  appBot?: () => Promise<string | undefined>;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export function createRetryHandler({ store, launch, readEvent, appBot, now = Date.now, log = (e) => console.log(JSON.stringify(e)) }: RetryDeps) {
  const no = (status: number, code: RetryErrorCode, message: string): RetryResult => ({ ok: false, status, code, message });

  /**
   * What became of a launch that never said how it ended, from the job under the id its claim kept:
   *
   *   never      no record, or its launch failed; or a record with no sign that a microVM was asked
   *              for and its reservation gone (reconciliation cancels a reservation before it fails
   *              the job, and once it is cancelled the launch can no longer proceed)
   *   prelaunch  a record whose reservation is still `reserved`: the launch may have died before
   *              RunMicrovm (reconciliation fails it after five minutes) or still be under way
   *   started    its launch passed the point of no return: `launchingAt` on the job itself (written
   *              with the reservation's phase), or a microVM or a start on record, or a
   *              `launching` reservation (from before `launchingAt` existed)
   *
   * The reservation is read first: a launch that moves on after it can only add evidence to the job.
   */
  const childState = async (id: string): Promise<'never' | 'prelaunch' | 'started'> => {
    const entry = (await store.listActiveJobs()).find((a) => a.jobId === id);
    const child = await store.getJob(id);
    if (!child || (child.status === 'finished' && child.outcome === 'launch_failed')) return 'never';
    if (child.launchingAt !== undefined || child.microvmId !== undefined || child.startedAt !== undefined || entry?.phase === 'launching') return 'started';
    return entry?.phase === 'reserved' ? 'prelaunch' : 'never';
  };

  return async function retry({ updraftRetry: { installationId, jobId, by } }: RetryRequest): Promise<RetryResult> {
    const summary = await store.getJobSummary(installationId, jobId);
    // Another tenant's job is not found, however it was named.
    if (!summary) return no(404, 'not_found', 'There is no such job in this installation');
    if (summary.stop && summary.stop.confirmedAt === undefined) return no(409, 'not_retryable', 'Execution is still stopping; wait for confirmed cancellation');
    if (summary.retriedAs) return no(409, 'already_retried', notRetryableMessage(summary));
    if (!retryable(summary)) return no(409, 'not_retryable', notRetryableMessage(summary));
    // The job's own record says which event it ran (its delivery, its config version): kept a week
    // past the job's end, the summary 30 days.
    const job = await store.getJob(jobId);
    if (!job || job.installationId !== installationId) return no(410, 'event_gone', 'This job is too old to run again: its event is no longer kept. Apply the label again on GitHub instead');
    const resumeParent = async () => {
      if (!job.stop) return;
      try { await resumeJobPause(store, { ...job, stop: job.stop }, stopSubjects(job, summary.detail?.prNumber), by ?? 'authorized console retry', now()); }
      catch (error) { log({ installationId, jobId, warning: 'retry started; workflow pause could not be cleared, use Resume automation', name: (error as Error)?.name }); }
    };
    if (job.benchmark || isBenchmarkLabel(job.label)) return no(409, 'not_retryable', BENCHMARK_RETRY_MESSAGE);

    let body: string | null;
    try {
      body = await readEvent(jobPaths(job).eventKey);
    } catch (err) {
      log({ installationId, jobId, warning: `could not read the job's event: ${(err as Error)?.name}` });
      return no(502, 'event_unavailable', 'The job’s event could not be read just now; try again later');
    }
    if (body === null) return no(410, 'event_gone', 'The event this job ran for is no longer kept, so it cannot be run again. Apply the label again on GitHub instead');
    let payload: Parameters<Launcher>[0]['payload'];
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      return no(410, 'event_gone', 'The event this job ran for cannot be read, so it cannot be run again. Apply the label again on GitHub instead');
    }

    // One reading of the clock for everything below: a claim seen live is live for the write that
    // would take it, so one that runs out in between cannot be overwritten with another child's id.
    const at = now();
    // A claim that ran out with its holder never having said how it ended (the Lambda died, or the
    // record of a launch could not be written): settled before anything else is launched. The
    // child's id was kept with the claim, so whether a job was started for it can be told.
    const stale = await store.getJobRetryClaim(job);
    if (stale && stale.until < at) {
      const state = await childState(stale.child);
      if (state === 'prelaunch') {
        return no(409, 'retry_pending', 'An earlier retry of this job is still being settled; try again in a few minutes');
      }
      if (state === 'started') {
        // Recorded in the one conditional write that checks it is still the claim seen: another
        // request that has taken it since, or one that settled it, leaves this one nothing to do.
        if (!(await store.settleJobRetry(job, stale.child, at))) return no(409, 'already_retried', 'This job is being retried, or was already');
        await resumeParent();
        log({ installationId, jobId, newJobId: stale.child, recovered: true });
        return { ok: true, jobId: stale.child };
      }
      // Never launched (no record, or its launch failed): this request launches afresh.
    }

    // The claim on this job's retry, before anything is launched: only one request launches at a
    // time, and none once a job started. Two requests that both read the summary before either
    // recorded anything meet here, and the second stops. It names the job about to be launched.
    const token = randomUUID();
    const child = newJobId();
    if (!(await store.reserveJobRetry(job, token, at, at + RESERVATION_MS, child))) return no(409, 'already_retried', 'This job is being retried, or was already');
    const giveBack = () => store.releaseJobRetry(job, token).catch((err: unknown) => log({ installationId, jobId, warning: `could not give back the retry claim: ${(err as Error)?.name}` }));

    let result;
    try {
      const bot = await appBot?.();
      result = await launch({ installationId, deliveryId: retryDeliveryId(jobId), eventName: job.eventName, ...(bot ? { appBot: bot } : {}), body, payload, retry: true, retryRuntime: { ...(job.native ? { workerId: job.native.workerId } : {}), ...(job.stop ? { resumeOf: jobId } : {}) }, jobId: child });
    } catch (err) {
      log({ installationId, jobId, error: 'retry failed before launching', name: errorClassOf(err) });
      await giveBack();
      return no(500, 'launch_failed', 'The job could not be started; try again');
    }
    log({ installationId, jobId, retried: result.disposition, ...(result.jobId ? { newJobId: result.jobId } : {}) });
    if (result.disposition === 'launched' && result.jobId) {
      // On record for as long as the job is listed: the delivery's claim only lasts while a job
      // holds it, and a failed one gives it up. Retried, since a job is running for this now. If it
      // still cannot be written, the claim keeps the child's id: the next request finds the job
      // under it once the claim has run out, and records it then instead of launching another.
      let recorded = false;
      for (let attempt = 1; attempt <= RECORD_ATTEMPTS && !recorded; attempt++) {
        try {
          recorded = await store.markJobRetried(job, token, result.jobId);
          break;
        } catch (err) {
          log({ installationId, jobId, warning: `could not record the retry (attempt ${attempt}): ${(err as Error)?.name}` });
        }
      }
      if (!recorded) log({ installationId, jobId, newJobId: result.jobId, warning: 'the retry started a job but is not on record; the next request will settle it from the claim' });
      await resumeParent();
      return { ok: true, jobId: result.jobId };
    }
    // Nothing started: the retry can be asked for again.
    await giveBack();
    return no(...refusal(result));
  };
}

/** What the launcher's refusal means to the person who clicked, with an HTTP status. */
function refusal(r: { status: number; disposition: string; message?: string }): [number, RetryErrorCode, string] {
  switch (r.disposition) {
    case 'duplicate':
      return [409, 'already_retried', 'This job was already retried'];
    case 'throttled':
      return [429, 'throttled', 'Your installation is over a usage limit right now; try again later'];
    case 'tenant_inactive':
      return [409, 'tenant_inactive', 'This installation is not active, so no job can start'];
    case 'no_config':
      return [409, 'no_config', 'There is no active configuration: publish one first'];
    case 'not_dispatched':
      return [409, 'not_dispatched', r.message ?? 'The active configuration no longer starts a job for this event'];
    case 'missing_key':
      return [409, 'missing_key', r.message ?? 'An agent key this workflow needs is not set'];
    case 'jobs_off':
    case 'kill_switch':
      return [503, 'jobs_off', 'Jobs are switched off for now; try again later'];
    case 'coalesced':
      return [409, 'coalesced', r.message ?? 'Another job for this pull request is starting and will see it'];
    default:
      return [r.status >= 400 ? r.status : 500, 'launch_failed', r.message ?? 'The job could not be started; try again'];
  }
}
