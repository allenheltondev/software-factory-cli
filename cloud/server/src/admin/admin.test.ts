import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { callerFromClaims, groupsFrom, type Caller } from '../caller.js';
import { createMemoryStore, type Job, type Tenant } from '../store/store.js';
import { adminAccess, isAdmin } from './access.js';
import { ADMIN_RELEASED_OUTCOME, createAdminService } from './admin.js';

const QUOTAS = { concurrentJobs: 1, jobsPerDay: 20, microvmMinutesPerMonth: 1200, platformConcurrentJobs: 20 };
const tenant = (installationId: number, accountLogin: string): Tenant => ({
  installationId,
  accountId: installationId * 10,
  accountLogin,
  accountType: 'Organization',
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 's',
});
const member = (installationId: number) => ({ installationId, sub: 's', role: 'owner' as const, githubUserId: 1, githubLogin: 'pat', addedAt: '' });

async function seeded() {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant(66, 'zeta'), member(66));
  await store.putTenantWithMember(tenant(55, 'acme'), member(55));
  return store;
}

async function launched(store: ReturnType<typeof createMemoryStore>, jobId: string, extra: Partial<Job> = {}): Promise<Job> {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const r = await store.reserveJob({ installationId: 55, jobId, holdUntil: now + 3_600_000, day, month: day.slice(0, 7), quotas: { ...QUOTAS, concurrentJobs: 5 } });
  if (!r.ok) throw new Error(r.limit);
  const job: Job = {
    jobId,
    tokenHash: 'ab',
    installationId: 55,
    repository: 'acme/web',
    repositoryId: 9,
    configVersion: 1,
    deliveryId: `d-${jobId}`,
    eventName: 'issues',
    status: 'launched',
    createdAt: new Date(now).toISOString(),
    expiresAt: now + 3_600_000,
    tenantSlot: r.tenantSlot,
    platformSlot: r.platformSlot,
    reservedSeconds: 3600,
    issue: 12,
    ...extra,
  };
  await store.putJob(job);
  return job;
}

describe('admin access', () => {
  it("is the stack's admin Cognito group, and nothing else", async () => {
    const access = adminAccess('admin');
    expect(await access.isAdmin({ sub: 'x', groups: ['rsc-pro', 'admin'] })).toBe(true);
    expect(await access.isAdmin({ sub: 'x', groups: ['rsc-pro', 'admins'] })).toBe(false);
    expect(await access.isAdmin({ sub: 'x' })).toBe(false);
    // No group configured: nobody.
    expect(await adminAccess('  ').isAdmin({ sub: 'x', groups: [''] })).toBe(false);
    expect(isAdmin({ sub: 'x', groups: ['updraft-admins'] }, 'updraft-admins')).toBe(true);
  });

  it("takes groups only from a verified token's array, where each name is exact", () => {
    expect(groupsFrom(['a', 'b'])).toEqual(['a', 'b']);
    // A legal group name with a comma stays one group, and matches only itself.
    expect(groupsFrom(['ops,updraft-admins'])).toEqual(['ops,updraft-admins']);
    expect(isAdmin({ sub: 'x', groups: groupsFrom(['ops,updraft-admins']) }, 'updraft-admins')).toBe(false);
    // The authorizer's flattened strings cannot keep those boundaries: they grant nothing.
    for (const flattened of ['[ops,updraft-admins]', '[a, updraft-admins]', 'updraft-admins', 'a,updraft-admins']) {
      expect(groupsFrom(flattened), flattened).toEqual([]);
    }
    expect(groupsFrom(undefined)).toEqual([]);
    expect(callerFromClaims({ sub: 's', aud: 'c', token_use: 'id', 'cognito:groups': '[updraft-admins]' }, 'c')).toEqual({ sub: 's' });
    expect(callerFromClaims({ sub: 's', aud: 'c', token_use: 'id', 'cognito:groups': ['updraft-admins'] }, 'c')).toEqual({ sub: 's', groups: ['updraft-admins'] });
  });
});

describe('the admin service', () => {
  it('lists every tenant with its quotas, overrides and usage, failures included', async () => {
    const store = await seeded();
    await store.setTenantLimits(55, { jobsPerDay: 50 });
    const job = await launched(store, 'job_failed001');
    await store.finishJob(job.jobId, 'failed');
    await store.recordThrottle(55, job.createdAt.slice(0, 7));
    const service = createAdminService({ store, quotas: QUOTAS, log: () => {} });

    const { tenants, platform } = await service.listTenants();
    expect(tenants.map((t) => t.accountLogin)).toEqual(['acme', 'zeta']);
    expect(tenants[0]).toMatchObject({
      installationId: 55,
      status: 'active',
      quotas: { ...QUOTAS, jobsPerDay: 50 },
      limits: { jobsPerDay: 50 },
      usage: { jobsToday: 1, jobsThisMonth: 1, failedThisMonth: 1, throttledThisMonth: 1 },
    });
    expect(tenants[1]).not.toHaveProperty('limits');
    expect(platform).toEqual({ activeJobs: 1, platformConcurrentJobs: 20 });
  });

  it("shows one tenant's recent jobs, newest first, and its running ones", async () => {
    const store = await seeded();
    const first = await launched(store, 'job_first0001', { createdAt: '2026-11-20T10:00:00.000Z' });
    await store.finishJob(first.jobId, 'succeeded');
    await store.releaseJob(first);
    await launched(store, 'job_second001', { createdAt: '2026-11-20T11:00:00.000Z', microvmId: 'mvm-2' });
    await store.markLaunching('job_second001');
    const detail = await createAdminService({ store, quotas: QUOTAS, log: () => {} }).tenant(55);
    expect(detail.recentJobs.map((j) => [j.jobId, j.status, j.outcome])).toEqual([
      ['job_second001', 'launched', undefined],
      ['job_first0001', 'finished', 'succeeded'],
    ]);
    expect(detail.activeJobs).toEqual([
      expect.objectContaining({ jobId: 'job_second001', phase: 'launching', repository: 'acme/web', issue: 12, microvmId: 'mvm-2' }),
    ]);
  });

  it('disables a tenant until an admin enables it, whatever GitHub does in between', async () => {
    const store = await seeded();
    const service = createAdminService({ store, quotas: QUOTAS, log: () => {} });
    const disabled = await service.disable(55, 'admin:ops@example.com', '  abuse report  ');
    expect(disabled).toMatchObject({ status: 'disabled', disabledReason: 'admin', adminDisabled: { by: 'admin:ops@example.com', reason: 'abuse report' } });

    // Suspended and unsuspended on GitHub meanwhile: still disabled.
    await store.setSuspended(55, true);
    expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'suspended' });
    await store.setSuspended(55, false);
    expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'admin' });

    expect(await service.enable(55, 'admin:ops@example.com')).toMatchObject({ status: 'active' });
    expect((await store.getTenant(55))?.adminDisabled).toBeUndefined();

    // Enabled while GitHub has it suspended: it stays suspended.
    await service.disable(55, 'admin:ops@example.com');
    await store.setSuspended(55, true);
    expect(await service.enable(55, 'admin:ops@example.com')).toMatchObject({ status: 'disabled', disabledReason: 'suspended' });
    await expect(service.disable(99, 'admin:x')).rejects.toMatchObject({ status: 404 });
  });

  it('overrides quotas within the ceiling, and clears them', async () => {
    const store = await seeded();
    const service = createAdminService({ store, quotas: QUOTAS, log: () => {} });
    expect(await service.setLimits(55, 'admin:x', { concurrentJobs: 3 })).toMatchObject({ limits: { concurrentJobs: 3 }, quotas: { concurrentJobs: 3 } });
    await expect(service.setLimits(55, 'admin:x', { concurrentJobs: 0 })).rejects.toMatchObject({ status: 400, code: 'invalid_limits' });
    expect(await service.setLimits(55, 'admin:x', null)).not.toHaveProperty('limits');
    expect(await service.setLimits(55, 'admin:x', {})).not.toHaveProperty('limits');
  });

  it("releases a stuck job's capacity once, and retires it", async () => {
    const store = await seeded();
    const job = await launched(store, 'job_stuck0001');
    await store.markLaunching(job.jobId);
    const service = createAdminService({ store, quotas: QUOTAS, log: () => {} });
    const detail = await service.releaseJob(job.jobId, 'admin:x');
    expect(detail.activeJobs).toEqual([]);
    const after = (await store.getJob(job.jobId))!;
    expect(after).toMatchObject({ status: 'finished', outcome: ADMIN_RELEASED_OUTCOME });
    expect(typeof after.stopRequestedAt).toBe('number');
    expect(await store.listPlatformSlots()).toEqual([]);
    expect(await store.startJob(after, after.expiresAt)).toEqual({ result: 'retired' });
    // Again: nothing more happens.
    await service.releaseJob(job.jobId, 'admin:x');
    await expect(service.releaseJob('job_nobody01', 'admin:x')).rejects.toMatchObject({ status: 404 });
  });

  it('finishes a release that failed part-way when it is retried', async () => {
    const store = await seeded();
    const job = await launched(store, 'job_partial01');
    await store.markLaunching(job.jobId);
    await store.claimDelivery(55, job.deliveryId, Date.now() + 3_600_000, job.jobId);
    const release = store.releaseDelivery.bind(store);
    store.releaseDelivery = vi.fn().mockRejectedValueOnce(new Error('throttled')).mockImplementation(release);
    const service = createAdminService({ store, quotas: QUOTAS, log: () => {} });
    await expect(service.releaseJob(job.jobId, 'admin:x')).rejects.toThrow('throttled');
    // Released (slots and refund), but the delivery is still claimed.
    expect(typeof (await store.getJob(job.jobId))?.releasedAt).toBe('number');
    expect(await store.claimDelivery(55, job.deliveryId, Date.now() + 60_000, 'job_next0001')).toBe(false);
    // The retry finishes it.
    await service.releaseJob(job.jobId, 'admin:x');
    expect(await store.claimDelivery(55, job.deliveryId, Date.now() + 60_000, 'job_next0001')).toBe(true);
  });

  it('gives back the counts of a reservation that never launched', async () => {
    const store = await seeded();
    const job = await launched(store, 'job_neverran1');
    const day = job.createdAt.slice(0, 10);
    expect((await store.getUsage(55, day, day.slice(0, 7))).jobsToday).toBe(1);
    await createAdminService({ store, quotas: QUOTAS, log: () => {} }).releaseJob(job.jobId, 'admin:x');
    expect((await store.getUsage(55, day, day.slice(0, 7))).jobsToday).toBe(0);
  });
});

describe('the admin routes', () => {
  async function app(caller: Caller, group = 'admin') {
    const store = await seeded();
    const service = createAdminService({ store, quotas: QUOTAS, log: () => {} });
    return {
      store,
      app: createApp({ resolveCaller: () => caller, admin: { access: adminAccess(group), service } }),
    };
  }
  const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('are refused to anyone outside the admin group, who /me says is no admin', async () => {
    const { app: a } = await app({ sub: 'someone', groups: ['rsc-pro'] });
    for (const [path, init] of [
      ['/api/v1/admin/tenants', {}],
      ['/api/v1/admin/tenants/55', {}],
      ['/api/v1/admin/tenants/55/disable', json({})],
      ['/api/v1/admin/jobs/job_abc12345/release', json({})],
    ] as const) {
      const res = await a.request(path, init);
      expect(res.status, path).toBe(403);
    }
    expect(await (await a.request('/api/v1/me')).json()).toMatchObject({ sub: 'someone', admin: false });
  });

  it("serve a member of the admin group, whichever group the stack names", async () => {
    const { app: a } = await app({ sub: 'x', groups: ['admin'] });
    expect(await (await a.request('/api/v1/me')).json()).toMatchObject({ admin: true });
    const list = (await (await a.request('/api/v1/admin/tenants')).json()) as { tenants: { accountLogin: string }[] };
    expect(list.tenants.map((t) => t.accountLogin)).toEqual(['acme', 'zeta']);
    expect((await a.request('/api/v1/admin/tenants/55')).status).toBe(200);
    expect((await a.request('/api/v1/admin/tenants/99')).status).toBe(404);

    const { app: other } = await app({ sub: 'x', groups: ['updraft-admins'] }, 'updraft-admins');
    expect((await other.request('/api/v1/admin/tenants')).status).toBe(200);
    expect((await (await app({ sub: 'x', groups: ['admin'] }, 'updraft-admins')).app.request('/api/v1/admin/tenants')).status).toBe(403);
  });

  it('disable, enable and set limits, recording who did it', async () => {
    const { app: a, store } = await app({ sub: 'x', email: 'ops@example.com', groups: ['admin'] });
    expect((await a.request('/api/v1/admin/tenants/55/disable', json({ reason: 'abuse' }))).status).toBe(200);
    expect((await store.getTenant(55))?.adminDisabled).toMatchObject({ by: 'admin:ops@example.com', reason: 'abuse' });
    expect((await a.request('/api/v1/admin/tenants/55/enable', json({}))).status).toBe(200);

    const put = (body: unknown) => a.request('/api/v1/admin/tenants/55/limits', { ...json(body), method: 'PUT' });
    expect(await (await put({ limits: { jobsPerDay: 5, concurrentJobs: '' } })).json()).toMatchObject({ limits: { jobsPerDay: 5 } });
    expect((await put({ limits: { jobsPerDay: 0 } })).status).toBe(400);
    expect((await put({ limits: { platformConcurrentJobs: 5 } })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect(await (await put({ limits: null })).json()).not.toHaveProperty('limits');
  });
});
