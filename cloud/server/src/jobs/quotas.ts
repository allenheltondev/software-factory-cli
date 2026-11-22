import type { Job, QuotaLimit, Quotas, TenantLimits } from '../store/store.js';

/**
 * Quotas and abuse controls (#68). Per tenant: concurrent jobs, jobs per day and microVM minutes
 * per month; for the platform: a ceiling on concurrent jobs, and the kill switch (kill-switch.ts).
 *
 * The stack sets the defaults (template parameters); an admin overrides them per tenant
 * (`limits` on the tenant record, scripts/tenant-admin.ts). The launcher checks them all in one
 * transaction (Store.reserveJob):
 *
 *   concurrent jobs     a slot per running job, the tenant's and the platform's,
 *                       taken at launch for the job's lifetime, before its microVM exists, and
 *                       freed once Lambda shows that microVM terminated (reconciliation), or when
 *                       the launch fails.
 *   jobs per day        counted at launch (UTC days), whatever becomes of the job
 *   microVM minutes     checked at launch, and again by the broker's start in the transaction that
 *                       charges the job its maximum duration, so launches that pass together are
 *                       not all charged on one remainder. A job starts while the month is under its
 *                       quota, so the last one can end over it. What it did not use is refunded
 *                       once Lambda shows its microVM terminated (the broker's terminate, or
 *                       reconciliation every five minutes: reconcile.ts).
 *
 * A delivery over a quota starts nothing: it is recorded as throttled, and the issue gets one
 * comment a day saying why. Re-applying the label is how to try again.
 */

/** An over-quota comment to post on the issue whose label started nothing, or the pull request whose event did. */
export interface ThrottleNotice {
  installationId: number;
  repository: string;
  repositoryId: number;
  /** The issue's number, or the pull request's (`pullRequest`). */
  issue: number;
  /** The event was its pull request's (a review, a push): the comment says how to try again there. */
  pullRequest?: boolean;
  limit: QuotaLimit;
  quotas: Quotas;
}

/** The installation token's permissions for an over-quota comment: a pull request's conversation needs pull_requests too. */
export const throttleCommentPermissions = (pullRequest?: boolean): Record<string, 'write'> => (pullRequest ? { issues: 'write', pull_requests: 'write' } : { issues: 'write' });

export const DEFAULT_QUOTAS: Quotas = {
  concurrentJobs: 1,
  jobsPerDay: 20,
  microvmMinutesPerMonth: 1200,
  platformConcurrentJobs: 20,
};

/** The largest value an admin may set; a typo should not lift a tenant's limits for good. */
export const LIMIT_CEILING: Required<TenantLimits> = { concurrentJobs: 20, jobsPerDay: 1000, microvmMinutesPerMonth: 100_000 };

const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
};

/** The stack's defaults, from the webhook function's environment. */
export function quotasFromEnv(env: Record<string, string | undefined>): Quotas {
  return {
    concurrentJobs: positive(env.QUOTA_CONCURRENT_JOBS, DEFAULT_QUOTAS.concurrentJobs),
    jobsPerDay: positive(env.QUOTA_JOBS_PER_DAY, DEFAULT_QUOTAS.jobsPerDay),
    microvmMinutesPerMonth: positive(env.QUOTA_MICROVM_MINUTES_PER_MONTH, DEFAULT_QUOTAS.microvmMinutesPerMonth),
    platformConcurrentJobs: positive(env.PLATFORM_CONCURRENT_JOBS, DEFAULT_QUOTAS.platformConcurrentJobs),
  };
}

/** A tenant's quotas: the defaults, with its overrides. */
export function tenantQuotas(defaults: Quotas, limits: TenantLimits | undefined): Quotas {
  return { ...defaults, ...Object.fromEntries(Object.entries(limits ?? {}).filter(([, v]) => typeof v === 'number')) };
}

/** Checks an admin's overrides: whole numbers from 1 to the ceiling. Returns the problems. */
export function limitProblems(limits: TenantLimits): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(limits) as [keyof TenantLimits, unknown][]) {
    if (!(name in LIMIT_CEILING)) problems.push(`${name} is not a limit`);
    else if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > LIMIT_CEILING[name]) {
      problems.push(`${name} must be a whole number from 1 to ${LIMIT_CEILING[name]}`);
    }
  }
  return problems;
}

/** Lambda's word that a microVM's resources are free: TERMINATED, or no such microVM (null). */
export const isTerminated = (state: string | null) => state === null || state === 'TERMINATED';

/** The microVM time a started job was charged and did not use, refunded when it is released. */
export function unusedTime(job: Job, now: number): { month: string; seconds: number } | undefined {
  if (job.startedAt === undefined || !job.reservedSeconds) return undefined;
  const used = Math.min(job.reservedSeconds, Math.max(0, Math.ceil((now - job.startedAt) / 1000)));
  return { month: job.createdAt.slice(0, 7), seconds: job.reservedSeconds - used };
}

/** The UTC day and month a time counts against: `2026-11-20`, `2026-11`. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** The comment on an issue whose label started nothing because of a quota, or on a pull request whose event did not. */
export function throttledComment(limit: QuotaLimit, quotas: Quotas, pullRequest = false): string {
  const why: Record<QuotaLimit, string> = {
    concurrent_jobs:
      quotas.concurrentJobs === 1
        ? 'another Updraft job is already running for this account, and it runs one at a time'
        : `${quotas.concurrentJobs} Updraft jobs are already running for this account, the most it runs at once`,
    jobs_per_day: `this account has started its ${quotas.jobsPerDay} Updraft jobs for today (UTC)`,
    microvm_minutes: `this account has used its ${quotas.microvmMinutesPerMonth} minutes of Updraft job time for this month (UTC)`,
    platform_concurrency: 'Updraft Cloud is running as many jobs as it can right now',
  };
  const when: Record<QuotaLimit, string> = {
    concurrent_jobs: 'once the running job finishes',
    jobs_per_day: 'tomorrow',
    microvm_minutes: 'next month',
    platform_concurrency: 'in a few minutes',
  };
  if (pullRequest) {
    return [
      `Updraft did not act on this pull request's latest review or push: ${why[limit]}.`,
      '',
      `To try again ${when[limit]}, submit the review again or push a commit.`,
      '',
      '<sub>Updraft posts this once a day per pull request.</sub>',
    ].join('\n');
  }
  return [
    `Updraft did not start a job for this label: ${why[limit]}.`,
    '',
    `To try again ${when[limit]}, remove the label and add it again.`,
    '',
    '<sub>Updraft posts this once a day per issue.</sub>',
  ].join('\n');
}
