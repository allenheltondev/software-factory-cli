import type { Delivery, DeliveryDisposition, InstallationStatus, JobResult } from '../api/client';

/**
 * The words and tones the status pages use (#71), in one place: what a job's result, a
 * delivery's disposition and an installation's status mean, and what to do about them.
 */

export type Tone = 'success' | 'warning' | 'error' | 'primary' | 'neutral';

export const INSTALLATION: Record<InstallationStatus, { label: string; tone: Tone; help: string }> = {
  active: { label: 'Active', tone: 'success', help: 'Labeled issues in configured repositories start jobs.' },
  suspended: { label: 'Suspended', tone: 'warning', help: 'The App is suspended on GitHub, so nothing runs. Unsuspend it in the installation settings on GitHub.' },
  missing_permissions: {
    label: 'Missing permissions',
    tone: 'warning',
    help: 'The installation grants the App less than jobs need. Accept the requested permissions in the installation settings on GitHub.',
  },
  disabled: { label: 'Disabled by Updraft', tone: 'error', help: 'Updraft has disabled this account, so no jobs start. Contact Ready, Set, Cloud support.' },
  uninstalled: { label: 'Uninstalled', tone: 'error', help: 'The App was uninstalled from GitHub. Its data is deleted after the retention period.' },
};

export const JOB_RESULT: Record<JobResult, { label: string; tone: Tone; help: string }> = {
  running: { label: 'Running', tone: 'primary', help: 'The job is running in its microVM.' },
  success: { label: 'Succeeded', tone: 'success', help: 'The agent did the work and the pull request was published.' },
  nothing_to_do: { label: 'Nothing to do', tone: 'neutral', help: 'Updraft looked at the event and found nothing to do (for example, work that was already done).' },
  canceled: { label: 'Canceled', tone: 'neutral', help: 'The job was canceled before any agent started (the issue changed, or the work was no longer wanted).' },
  superseded: { label: 'Superseded', tone: 'neutral', help: 'The job ran, but another run of the same event published first. Nothing on GitHub was changed by this one.' },
  deferred: {
    label: 'Deferred',
    tone: 'warning',
    help: 'An agent’s usage limit was reached, so the rest of the work waits for the cooldown. Delivering the event again after it continues the work.',
  },
  agent_failure: { label: 'Agent failed', tone: 'error', help: 'An agent run failed, could not start, or was interrupted. The run log shows what the agent did.' },
  verify_failure: { label: 'Verification failed', tone: 'error', help: "The agent's change did not pass the workflow's verify commands. The run log shows which command failed." },
  publish_failure: { label: 'Publish failed', tone: 'error', help: 'The agent succeeded, but the pull request could not be published. Check the App can push and open pull requests.' },
  timeout: { label: 'Timed out', tone: 'error', help: 'The job ran out of time and was stopped. Make the issue smaller, or raise the workflow timeout.' },
  state_not_saved: { label: 'State not saved', tone: 'warning', help: 'The job ran, but what it recorded could not be saved. Redeliver the webhook from GitHub to put it back on record.' },
  terminated: { label: 'Stopped', tone: 'warning', help: 'The microVM was stopped while the job was running.' },
  runner_error: { label: 'Could not run', tone: 'error', help: 'The job could not start in its microVM. This is on Updraft’s side; try again, and contact support if it keeps happening.' },
  unconfirmed: { label: 'Unconfirmed', tone: 'warning', help: 'The job ended cleanly but reported no summary. Redelivering the webhook runs it again.' },
  not_run: { label: 'Not run', tone: 'neutral', help: 'The job never ran: over a quota, replaced by a redelivery, or released by Updraft.' },
  other: { label: 'Ended', tone: 'neutral', help: 'The job ended.' },
};

export const DISPOSITION: Record<DeliveryDisposition, { label: string; tone: Tone }> = {
  launched: { label: 'Launched', tone: 'success' },
  filtered: { label: 'Filtered', tone: 'neutral' },
  deduped: { label: 'Duplicate', tone: 'neutral' },
  coalesced: { label: 'Coalesced', tone: 'neutral' },
  throttled: { label: 'Throttled', tone: 'warning' },
  launch_failed: { label: 'Launch failed', tone: 'error' },
  routine_triggered: { label: 'Claude task started', tone: 'success' },
  routine_failed: { label: 'Claude task refused', tone: 'error' },
  routine_unknown: { label: 'Claude task uncertain', tone: 'warning' },
};

const REASON: Record<string, string> = {
  unknown_repo: 'The repository is not in the active configuration.',
  paused: 'The repository is paused.',
  not_trigger: 'The label is not a trigger.',
  actor_not_allowed: 'The person who applied the label may not start work.',
  event_not_accepted: 'Updraft Cloud does not act on this event.',
  tenant_inactive: 'The installation was not active.',
  no_config: 'No configuration was published yet.',
  no_rules: 'The configuration needs publishing again.',
  missing_key: 'An agent key is not set.',
  jobs_off: 'Jobs were not available yet.',
  jobs_paused: 'Updraft had paused all jobs.',
  concurrent_jobs: 'A job was already running (one at a time).',
  jobs_per_day: 'The daily job limit was reached.',
  microvm_minutes: 'The monthly compute allowance was used up.',
  platform_concurrency: 'Updraft was at capacity.',
  not_updraft_pr: 'The pull request is not one Updraft opened.',
  own_event: "Updraft's own review or push: the job that made it handles what follows.",
  comment_review: 'A comment review starts nothing; "Request changes" does.',
};

/** Why a delivery went the way it did, in words. */
export function deliveryReason(d: Delivery): string {
  if (d.disposition === 'launched') return 'A job was started.';
  if (d.disposition === 'deduped') return 'A redelivery of a delivery that already has a job.';
  if (d.disposition === 'coalesced') return d.pullRequest !== undefined ? `Folded into the job for pull request #${d.pullRequest}, which sees it.` : 'Folded into another delivery’s job.';
  // A pull request's event: who reviewed or pushed, not who applied a label; and the loop's own words.
  if (d.reason === 'actor_not_allowed' && d.event.startsWith('pull_request')) return 'The person who reviewed or pushed may not start work.';
  if (d.reason === 'loop_off' && d.message) return d.message.charAt(0).toUpperCase() + d.message.slice(1) + '.';
  if (d.disposition === 'launch_failed') return d.errorClass === 'ReleasedByAdmin' ? 'Released by Updraft before it started.' : `The job could not be started (${d.errorClass ?? 'Error'}).`;
  if (d.reason === 'missing_key' && d.message) return d.message.charAt(0).toUpperCase() + d.message.slice(1) + '.';
  return (d.reason && REASON[d.reason]) ?? (d.message ? d.message.charAt(0).toUpperCase() + d.message.slice(1) + '.' : 'Nothing to do.');
}

/** "2 min 5 s", "47 s", "1 h 3 min". */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return seconds % 60 ? `${m} min ${seconds % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "4.2 MB", "820 KB", "12 bytes". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The installation's settings on GitHub, where permissions are accepted and suspensions lifted. */
export function installationSettingsUrl(t: { installationId: number; accountLogin: string; accountType: string }): string {
  return t.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(t.accountLogin)}/settings/installations/${t.installationId}`
    : `https://github.com/settings/installations/${t.installationId}`;
}
