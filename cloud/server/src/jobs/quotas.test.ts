import { describe, expect, it, vi } from 'vitest';
import { createKillSwitch, isEngagedValue } from './kill-switch.js';
import { DEFAULT_QUOTAS, dayOf, limitProblems, monthOf, quotasFromEnv, tenantQuotas, throttleCommentPermissions, throttledComment } from './quotas.js';

describe('quotas', () => {
  it("reads the stack's defaults, falling back on anything that is not a positive whole number", () => {
    expect(quotasFromEnv({})).toEqual(DEFAULT_QUOTAS);
    expect(quotasFromEnv({ QUOTA_CONCURRENT_JOBS: '2', QUOTA_JOBS_PER_DAY: '0', QUOTA_MICROVM_MINUTES_PER_MONTH: 'lots', PLATFORM_CONCURRENT_JOBS: '50' })).toEqual({
      ...DEFAULT_QUOTAS,
      concurrentJobs: 2,
      platformConcurrentJobs: 50,
    });
  });

  it("applies a tenant's overrides, each on its own", () => {
    expect(tenantQuotas(DEFAULT_QUOTAS, undefined)).toEqual(DEFAULT_QUOTAS);
    expect(tenantQuotas(DEFAULT_QUOTAS, { jobsPerDay: 5 })).toEqual({ ...DEFAULT_QUOTAS, jobsPerDay: 5 });
  });

  it("checks an admin's overrides", () => {
    expect(limitProblems({ concurrentJobs: 3, jobsPerDay: 1000 })).toEqual([]);
    expect(limitProblems({ concurrentJobs: 0 })).toEqual(['concurrentJobs must be a whole number from 1 to 20']);
    expect(limitProblems({ jobsPerDay: 1.5 })).toHaveLength(1);
    expect(limitProblems({ microvmMinutesPerMonth: 100_001 })).toHaveLength(1);
    expect(limitProblems({ platformConcurrentJobs: 5 } as never)).toEqual(['platformConcurrentJobs is not a limit']);
  });

  it('counts by UTC day and month', () => {
    const late = Date.UTC(2026, 10, 30, 23, 59);
    expect(dayOf(late)).toBe('2026-11-30');
    expect(monthOf(late)).toBe('2026-11');
    expect(monthOf(late + 60_000)).toBe('2026-12');
  });

  it('says on the issue which quota stopped it and how to try again', () => {
    const one = throttledComment('concurrent_jobs', DEFAULT_QUOTAS);
    expect(one).toContain('another Updraft job is already running');
    expect(one).toContain('remove the label and add it again');
    expect(throttledComment('concurrent_jobs', { ...DEFAULT_QUOTAS, concurrentJobs: 3 })).toContain('3 Updraft jobs are already running');
    expect(throttledComment('jobs_per_day', DEFAULT_QUOTAS)).toContain('its 20 Updraft jobs for today');
    expect(throttledComment('microvm_minutes', DEFAULT_QUOTAS)).toContain('1200 minutes');
    expect(throttledComment('platform_concurrency', DEFAULT_QUOTAS)).toContain('in a few minutes');
  });

  it("says on a pull request how to try its review or push again, with a token that may comment there", () => {
    const pr = throttledComment('jobs_per_day', DEFAULT_QUOTAS, true);
    expect(pr).toContain("did not act on this pull request's latest review or push");
    expect(pr).toContain('submit the review again or push a commit');
    expect(pr).not.toContain('label');
    expect(throttleCommentPermissions(true)).toEqual({ issues: 'write', pull_requests: 'write' });
    expect(throttleCommentPermissions()).toEqual({ issues: 'write' });
  });
});

describe('the kill switch', () => {
  it('is on for on, true, 1 or engaged, in any case; anything else and no parameter are off', () => {
    for (const v of ['on', 'TRUE', ' 1 ', 'Engaged']) expect(isEngagedValue(v), v).toBe(true);
    for (const v of ['off', 'false', '0', '', 'no']) expect(isEngagedValue(v), v).toBe(false);
    expect(isEngagedValue(null)).toBe(false);
  });

  it('reads the parameter at most once per interval, and counts an unreadable one as on', async () => {
    let clock = 0;
    const read = vi.fn<() => Promise<string | null>>().mockResolvedValue('off');
    const log = vi.fn();
    const ks = createKillSwitch({ read, now: () => clock, ttlMs: 30_000, log });
    expect(await ks.engaged()).toBe(false);
    read.mockResolvedValue('on');
    clock = 29_000;
    expect(await ks.engaged()).toBe(false);
    clock = 30_000;
    expect(await ks.engaged()).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);

    read.mockRejectedValue(new Error('AccessDenied'));
    clock = 60_000;
    expect(await ks.engaged()).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ warning: expect.stringContaining('treating it as on') }));

    read.mockResolvedValue(null);
    clock = 90_000;
    expect(await ks.engaged()).toBe(false);
  });
});
