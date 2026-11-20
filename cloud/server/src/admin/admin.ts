import { FlowError } from '../flows/github.js';
import { dayOf, limitProblems, monthOf, tenantQuotas, unusedTime } from '../jobs/quotas.js';
import { RESERVATION_RECLAIM_MS } from '../jobs/reconcile.js';
import type { ActiveJob, JobSummary, Quotas, Store, Tenant, TenantLimits, Usage } from '../store/store.js';

/**
 * The admin view (#68): every tenant with its quotas, usage and failures; one tenant's recent and
 * running jobs; and what an admin may do about them: disable or enable the tenant, override its
 * quotas, and release a job that holds capacity it should not (a launch interrupted before
 * RunMicrovm answered keeps its slot for its maximum duration, since nothing can tell whether a
 * microVM started: an admin who has checked can give it back).
 *
 * Who is an admin is decided before any of this is called (access.ts).
 */

export const RECENT_JOBS = 25;
export const ADMIN_RELEASED_OUTCOME = 'released_by_admin';

export interface AdminTenant {
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: Tenant['status'];
  disabledReason?: Tenant['disabledReason'];
  adminDisabled?: Tenant['adminDisabled'];
  activeConfigVersion?: number;
  createdAt: string;
  /** Its quotas (the stack's defaults with its overrides), the overrides alone, and the defaults. */
  quotas: Quotas;
  limits?: TenantLimits;
  defaults: Quotas;
  usage: Usage;
}

export interface AdminActiveJob {
  jobId: string;
  phase: ActiveJob['phase'];
  reservedAt: string;
  expiresAt: string;
  repository?: string;
  issue?: number;
  microvmId?: string;
  startedAt?: string;
  outcome?: string;
}

export interface AdminTenantDetail extends AdminTenant {
  recentJobs: JobSummary[];
  activeJobs: AdminActiveJob[];
}

export function createAdminService({
  store,
  quotas,
  now = Date.now,
  log = (entry) => console.log(JSON.stringify(entry)),
}: {
  store: Store;
  /** The stack's default quotas. */
  quotas: Quotas;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  async function row(t: Tenant): Promise<AdminTenant> {
    const at = now();
    return {
      installationId: t.installationId,
      accountLogin: t.accountLogin,
      accountType: t.accountType,
      status: t.status,
      ...(t.disabledReason ? { disabledReason: t.disabledReason } : {}),
      ...(t.adminDisabled ? { adminDisabled: t.adminDisabled } : {}),
      ...(t.activeConfigVersion !== undefined ? { activeConfigVersion: t.activeConfigVersion } : {}),
      createdAt: t.createdAt,
      quotas: tenantQuotas(quotas, t.limits),
      ...(t.limits ? { limits: t.limits } : {}),
      defaults: quotas,
      usage: await store.getUsage(t.installationId, dayOf(at), monthOf(at)),
    };
  }

  async function tenantOr404(id: number): Promise<Tenant> {
    const t = await store.getTenant(id, { consistent: true });
    if (!t) throw new FlowError('not_found', 404, `There is no tenant for installation ${id}`);
    return t;
  }

  async function detail(id: number): Promise<AdminTenantDetail> {
    const t = await tenantOr404(id);
    const entries = (await store.listActiveJobs()).filter((e) => e.installationId === id);
    const activeJobs = await Promise.all(
      entries.map(async (e): Promise<AdminActiveJob> => {
        const job = await store.getJob(e.jobId);
        return {
          jobId: e.jobId,
          phase: e.phase,
          reservedAt: new Date(e.reservedAt).toISOString(),
          expiresAt: new Date(e.expiresAt).toISOString(),
          ...(job ? { repository: job.repository } : {}),
          ...(job?.issue !== undefined ? { issue: job.issue } : {}),
          ...(job?.microvmId ? { microvmId: job.microvmId } : {}),
          ...(job?.startedAt !== undefined ? { startedAt: new Date(job.startedAt).toISOString() } : {}),
          ...(job?.outcome ? { outcome: job.outcome } : {}),
        };
      }),
    );
    return { ...(await row(t)), recentJobs: await store.listRecentJobs(id, RECENT_JOBS), activeJobs };
  }

  return {
    async listTenants(): Promise<{ tenants: AdminTenant[]; platform: { activeJobs: number; platformConcurrentJobs: number } }> {
      const tenants = await Promise.all((await store.listTenants()).map(row));
      tenants.sort((a, b) => a.accountLogin.localeCompare(b.accountLogin));
      return { tenants, platform: { activeJobs: (await store.listActiveJobs()).length, platformConcurrentJobs: quotas.platformConcurrentJobs } };
    },

    tenant: detail,

    async disable(id: number, by: string, reason?: string): Promise<AdminTenantDetail> {
      const trimmed = reason?.trim().slice(0, 500);
      const result = await store.setAdminDisabled(id, { by, ...(trimmed ? { reason: trimmed } : {}) });
      if (result === 'no_tenant') throw new FlowError('not_found', 404, `There is no tenant for installation ${id}`);
      if (result === 'uninstalled') throw new FlowError('uninstalled', 409, 'The App was uninstalled from this account; there is nothing to disable');
      log({ admin: by, installationId: id, action: 'disable', reason: trimmed });
      return detail(id);
    },

    async enable(id: number, by: string): Promise<AdminTenantDetail> {
      const result = await store.setAdminDisabled(id, null);
      if (result === 'no_tenant') throw new FlowError('not_found', 404, `There is no tenant for installation ${id}`);
      log({ admin: by, installationId: id, action: 'enable' });
      return detail(id);
    },

    async setLimits(id: number, by: string, limits: TenantLimits | null): Promise<AdminTenantDetail> {
      if (limits) {
        const problems = limitProblems(limits);
        if (problems.length > 0) throw new FlowError('invalid_limits', 400, problems.join('; '));
      }
      const cleared = !limits || Object.keys(limits).length === 0;
      if ((await store.setTenantLimits(id, cleared ? null : limits)) === 'no_tenant') {
        throw new FlowError('not_found', 404, `There is no tenant for installation ${id}`);
      }
      log({ admin: by, installationId: id, action: 'limits', limits: cleared ? null : limits });
      return detail(id);
    },

    /**
     * Gives a job's capacity back by hand: it is retired (nothing more is served for it), its
     * slots freed, its unused microVM time refunded, and it is no longer reconciled. Only for a job
     * whose microVM an admin has seen is not running: one that is would run outside the quota.
     * Refused (409) while its launch may be under way: a reservation the launcher has just marked
     * launching, or a launching one younger than five minutes.
     */
    async releaseJob(jobId: string, by: string): Promise<AdminTenantDetail> {
      const job = await store.getJob(jobId);
      if (!job) throw new FlowError('not_found', 404, `There is no job ${jobId}`);
      const first = job.releasedAt === undefined;
      const entry = (await store.listActiveJobs()).find((e) => e.jobId === jobId);
      const launching = () =>
        new FlowError('launch_in_progress', 409, 'This job is being launched right now, so a microVM may be starting. Look again in a few minutes.');
      if (entry?.phase === 'reserved') {
        // Won against the launcher first, before anything else is touched: this cancel and the
        // launcher's markLaunching are conditional writes on the same entry, so only one of them
        // succeeds. If the launch won, its microVM may be starting: nothing is released.
        // The job is retired in the same write, so the launch sees an admin's release, not an error.
        if ((await store.cancelReservation(entry, 'reserved', { job, outcome: ADMIN_RELEASED_OUTCOME })) === 'mismatch') throw launching();
      } else if (entry?.phase === 'launching' && now() - entry.reservedAt < RESERVATION_RECLAIM_MS) {
        // RunMicrovm may still be in flight (the webhook allows 20 seconds; this is well past it).
        throw launching();
      }
      // From here every step is safe to repeat (the refund and the counts go back once, the slots
      // and the claim only from this job), so a retry after a failure part-way finishes what it left.
      await store.markStopping(jobId);
      await store.finishJob(jobId, ADMIN_RELEASED_OUTCOME);
      await store.releaseJob(job, unusedTime(job, now()));
      await store.releaseDelivery(job.installationId, job.deliveryId, jobId);
      log({ admin: by, installationId: job.installationId, jobId, action: first ? 'release' : 'release (again)', microvmId: job.microvmId });
      return detail(job.installationId);
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
