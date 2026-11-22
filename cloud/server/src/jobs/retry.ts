import { createHash } from 'node:crypto';
import { jobPaths } from '../broker/broker.js';
import type { Store } from '../store/store.js';
import { errorClassOf, type Launcher } from './launch.js';
import { jobResult, retryable } from './status.js';

/**
 * Retrying a job from the console: the launcher runs the job's own event again.
 *
 * The API function decides who may ask (a member of the installation) and whether the job is one
 * that can be retried; this runs in the webhook function, which has the launcher and its
 * permissions, and is reached by a direct invoke (so only the API function can call it). The
 * event the job read is kept in the tenant's bucket under the job's delivery, and is launched
 * again under a delivery id of its own, so everything a new delivery gets is checked again against
 * the configuration active now: the tenant, the dispatch rules, the keys, the quotas.
 */

/** What the API function sends the webhook function. */
export interface RetryRequest {
  updraftRetry: { installationId: number; jobId: string };
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
  | 'retry_failed';

export type RetryResult =
  | { ok: true; jobId: string }
  | { ok: false; status: number; code: RetryErrorCode; message: string };

export const isRetryRequest = (event: unknown): event is RetryRequest => {
  const r = (event as RetryRequest | null)?.updraftRetry;
  return typeof r === 'object' && r !== null && Number.isSafeInteger(r.installationId) && typeof r.jobId === 'string';
};

/**
 * The delivery id of a job's retry. One per job: asking twice for the same job finds the first
 * attempt's claim and starts nothing more, so a double click (or two members) cannot run it twice.
 * A delivery id is letters, digits and hyphens.
 */
export const retryDeliveryId = (jobId: string) => `retry-${createHash('sha256').update(jobId).digest('hex').slice(0, 32)}`;

export interface RetryDeps {
  store: Store;
  launch: Launcher;
  /** The event body the job was started with; null when it is gone. */
  readEvent: (key: string) => Promise<string | null>;
  /** The platform App's own login (`<slug>[bot]`), as the webhook gives the launcher. */
  appBot?: () => Promise<string | undefined>;
  log?: (entry: Record<string, unknown>) => void;
}

export function createRetryHandler({ store, launch, readEvent, appBot, log = (e) => console.log(JSON.stringify(e)) }: RetryDeps) {
  const no = (status: number, code: RetryErrorCode, message: string): RetryResult => ({ ok: false, status, code, message });

  return async function retry({ updraftRetry: { installationId, jobId } }: RetryRequest): Promise<RetryResult> {
    const job = await store.getJob(jobId);
    // Another tenant's job is not found, however it was named.
    if (!job || job.installationId !== installationId) return no(404, 'not_found', 'There is no such job in this installation');
    const summary = await store.getJobSummary(installationId, jobId);
    if (!summary || !retryable(summary)) {
      return no(409, 'not_retryable', summary && jobResult(summary) === 'running' ? 'This job is still running' : 'This job did not end in a way that can be retried');
    }

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

    let result;
    try {
      const bot = await appBot?.();
      result = await launch({ installationId, deliveryId: retryDeliveryId(jobId), eventName: job.eventName, ...(bot ? { appBot: bot } : {}), body, payload });
    } catch (err) {
      log({ installationId, jobId, error: 'retry failed before launching', name: errorClassOf(err) });
      return no(500, 'launch_failed', 'The job could not be started; try again');
    }
    log({ installationId, jobId, retried: result.disposition, ...(result.jobId ? { newJobId: result.jobId } : {}) });
    if (result.disposition === 'launched' && result.jobId) return { ok: true, jobId: result.jobId };
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
