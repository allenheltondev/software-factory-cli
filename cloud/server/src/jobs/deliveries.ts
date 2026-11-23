import type { DeliveryRecord } from '../store/store.js';
import type { LaunchResult } from './launch.js';

/**
 * What became of a tenant's webhook delivery, as the console lists it (#71): one disposition each.
 *
 *   filtered       nothing to do, with the reason: unknown_repo, paused, not_trigger,
 *                  actor_not_allowed, event_not_accepted, for pull request events loop_off,
 *                  not_updraft_pr, own_event and comment_review, and the tenant's own state
 *                  (tenant_inactive, no_config, no_rules, missing_key) or the platform's
 *                  (jobs_off, jobs_paused)
 *   deduped        a redelivery of a delivery that already has a job
 *   coalesced      folded into another delivery's job: a pull request event within a few
 *                  seconds of one that started a job for the same pull request (launch.ts)
 *   throttled      over a quota; the reason is the limit
 *   launch_failed  the job could not be started; errorClass is the AWS error's class
 *   launched       a job was started; jobId is it
 *
 * Deliveries of no tenant are not recorded (there is no one to show them to), nor are the App's
 * own lifecycle events (installation, installation_repositories).
 */

export type DeliveryEvent = Pick<DeliveryRecord, 'at' | 'deliveryId' | 'event' | 'action' | 'repository' | 'issue' | 'pullRequest' | 'label' | 'sender'>;

/** The record of a delivery the launcher handled (an issue's label, a pull request's event); null when it is not one to record. */
export function deliveryFromLaunch(base: DeliveryEvent, result: LaunchResult): DeliveryRecord | null {
  const filtered = (reason: string, message?: string): DeliveryRecord => ({ ...base, disposition: 'filtered', reason, ...(message ? { message } : {}) });
  switch (result.disposition) {
    case 'no_tenant':
    case 'bad_delivery_id':
      return null;
    case 'ignored':
      return filtered('event_not_accepted');
    case 'tenant_inactive':
    case 'no_config':
      return filtered(result.disposition);
    case 'not_dispatched':
      if (result.reason === 'native_waiting_for_sign_in' && result.jobId) {
        return { ...filtered(result.reason, result.message), jobId: result.jobId };
      }
      return filtered(result.reason ?? 'not_trigger', result.message);
    case 'jobs_off':
      return filtered('jobs_off');
    case 'kill_switch':
      return filtered('jobs_paused');
    case 'missing_key':
      return filtered('missing_key', result.message);
    case 'duplicate':
      return { ...base, disposition: 'deduped' };
    case 'coalesce_unconfirmed':
      return { ...base, disposition: 'launch_failed', errorClass: 'CoalesceUnconfirmed', ...(result.message ? { message: result.message } : {}) };
    case 'coalesced':
      return { ...base, disposition: 'coalesced', ...(result.message ? { message: result.message } : {}) };
    case 'throttled':
      return { ...base, disposition: 'throttled', ...(result.reason ? { reason: result.reason } : {}) };
    case 'launch_failed':
      return { ...base, disposition: 'launch_failed', errorClass: result.errorClass ?? 'Error', ...(result.jobId ? { jobId: result.jobId } : {}) };
    case 'cancelled':
      return { ...base, disposition: 'launch_failed', errorClass: 'ReleasedByAdmin', ...(result.jobId ? { jobId: result.jobId } : {}) };
    case 'launched':
      return { ...base, disposition: 'launched', ...(result.jobId ? { jobId: result.jobId } : {}) };
    default:
      return filtered(result.disposition);
  }
}

/** Events that are the App's own lifecycle, not work: never listed as deliveries. */
export const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(['ping', 'installation', 'installation_repositories', 'github_app_authorization']);
