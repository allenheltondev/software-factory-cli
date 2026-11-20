import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, type Job } from '../store/store.js';
import { createReconciler } from './reconcile.js';

const QUOTAS = { concurrentJobs: 5, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 };

async function admitted(store: ReturnType<typeof createMemoryStore>, jobId: string, extra: Partial<Job> = {}): Promise<Job> {
  const now = Date.now();
  const r = await store.reserveJob({ installationId: 55, jobId, holdUntil: now + 3_600_000, day: '2026-11-20', month: '2026-11', quotas: QUOTAS });
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
    ...extra,
  };
  await store.putJob(job);
  // As the launcher does just before RunMicrovm.
  await store.markLaunching(jobId);
  return job;
}

describe('quota reconciliation', () => {
  it("leaves a launched job alone when its stale listing still says reserved", async () => {
    const store = createMemoryStore();
    // Listed while young and reserved; launched (and running) before this run reached it.
    const job = await admitted(store, 'job_launched1', { microvmId: 'mvm-run' });
    const [entry] = await store.listActiveJobs();
    const stale = { ...entry!, phase: 'reserved' as const, reservedAt: Date.now() - 6 * 60_000 };
    store.listActiveJobs = async () => [stale];
    const report = await createReconciler({ store, microvmState: async () => 'RUNNING', log: () => {} })();
    expect(report.released).toEqual([]);
    // Not retired, its slots and its entry intact, its usage still counted.
    const after = (await store.getJob(job.jobId))!;
    expect(after.status).toBe('launched');
    expect(after.stopRequestedAt).toBeUndefined();
    expect((await store.listPlatformSlots()).map((s) => s.jobId)).toEqual([job.jobId]);
    expect((await store.reserveJob({ installationId: 55, jobId: 'job_other0001', holdUntil: Date.now() + 60_000, day: '2026-11-20', month: '2026-11', quotas: { ...QUOTAS, concurrentJobs: 1 } }))).toEqual({ ok: false, limit: 'concurrent_jobs' });
    expect((await store.getUsage(55, '2026-11-20', '2026-11')).jobsToday).toBe(1);
  });

  it('reclaims an abandoned reservation once, however many runs overlap', async () => {
    const store = createMemoryStore();
    const quotas = { ...QUOTAS, jobsPerDay: 2 };
    const reserve = (jobId: string) => store.reserveJob({ installationId: 55, jobId, holdUntil: Date.now() + 3_600_000, day: '2026-11-20', month: '2026-11', quotas });
    // One launched job, and one reservation whose launch stopped before RunMicrovm.
    await admitted(store, 'job_running01', { microvmId: 'mvm-run' });
    expect(await reserve('job_abandon01')).toMatchObject({ ok: true });
    expect((await store.getUsage(55, '2026-11-20', '2026-11')).jobsToday).toBe(2);

    const later = Date.now() + 6 * 60_000;
    const run = () => createReconciler({ store, microvmState: async () => 'RUNNING', now: () => later, log: () => {} })();
    const reports = await Promise.all([run(), run(), run()]);
    expect(reports.flatMap((r) => r.released)).toEqual(['job_abandon01']);
    // The launched job still counts: one job given back, not three.
    expect((await store.getUsage(55, '2026-11-20', '2026-11')).jobsToday).toBe(1);
    expect(await reserve('job_next00001')).toMatchObject({ ok: true });
    expect(await reserve('job_over00001')).toEqual({ ok: false, limit: 'jobs_per_day' });
  });

  it('releases a job with no recorded microVM only after its maximum duration', async () => {
    const store = createMemoryStore();
    const job = await admitted(store, 'job_novm00001');
    const reconcile = (at: number) => createReconciler({ store, microvmState: vi.fn(), now: () => at, log: () => {} })();
    expect(await reconcile(job.expiresAt - 1)).toMatchObject({ released: [], held: 1 });
    expect(await reconcile(job.expiresAt + 1)).toMatchObject({ released: ['job_novm00001'], held: 0 });
    expect(await store.listActiveJobs()).toEqual([]);
  });

  it('releases only the jobs whose microVM Lambda shows terminated or has no more', async () => {
    const store = createMemoryStore();
    await admitted(store, 'job_running01', { microvmId: 'mvm-run' });
    await admitted(store, 'job_ending001', { microvmId: 'mvm-end' });
    await admitted(store, 'job_done00001', { microvmId: 'mvm-done' });
    await admitted(store, 'job_gone00001', { microvmId: 'mvm-gone' });
    // Never recorded a microVM: held until its slots run out.
    await admitted(store, 'job_novm00001');
    const states: Record<string, string | null> = { 'mvm-run': 'RUNNING', 'mvm-end': 'TERMINATING', 'mvm-done': 'TERMINATED', 'mvm-gone': null };
    const reconcile = createReconciler({ store, microvmState: async (id) => states[id]!, log: () => {} });

    const report = await reconcile();
    expect(report.released.sort()).toEqual(['job_done00001', 'job_gone00001']);
    expect(report).toMatchObject({ held: 3, failed: 0 });
    expect((await store.listPlatformSlots()).map((s) => s.jobId).sort()).toEqual(['job_ending001', 'job_novm00001', 'job_running01']);
    expect(typeof (await store.getJob('job_done00001'))?.releasedAt).toBe('number');
  });

  it("keeps going past a job it cannot look at, and frees a released job's leftover slot", async () => {
    const store = createMemoryStore();
    await admitted(store, 'job_broken001', { microvmId: 'mvm-broken' });
    const leftover = await admitted(store, 'job_leftover1', { microvmId: 'mvm-left', releasedAt: Date.now() });
    await admitted(store, 'job_done00001', { microvmId: 'mvm-done' });
    const microvmState = vi.fn(async (id: string) => {
      if (id === 'mvm-broken') throw new Error('throttled');
      return 'TERMINATED';
    });
    const log = vi.fn();
    const report = await createReconciler({ store, microvmState, log })();
    expect(report).toEqual({ released: ['job_done00001'], held: 0, failed: 1 });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ reconcile: 'error', jobId: 'job_broken001' }));
    // The leftover is freed without asking Lambda again.
    expect(microvmState).not.toHaveBeenCalledWith(leftover.microvmId);
    expect((await store.listPlatformSlots()).map((s) => s.jobId)).toEqual(['job_broken001']);
  });
});
