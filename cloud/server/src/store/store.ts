/**
 * What Updraft Cloud keeps, behind an interface (DynamoDB in production, memory in tests).
 *
 * Single table (UpdraftTable), pk/sk:
 *   OAUTH#<state>        STATE                 a pending link or install, single use, TTL 10 minutes
 *   USER#<sub>           PROFILE               the linked GitHub identity of an RSC user
 *   USER#<sub>           OFFER                 installations the user may connect, TTL 10 minutes
 *   GHUSER#<githubId>    LINK                  which RSC user a GitHub identity is linked to (unique)
 *   TENANT#<installId>   META                  a tenant: one installation of the Updraft App
 *   TENANT#<installId>   MEMBER#<sub>          a member, GSI1 USER#<sub> / TENANT#<installId>
 *   TENANT#<installId>   SLOT#<n>              a running job's place in the tenant's concurrency (TTL: until it ends)
 *   TENANT#<installId>   USAGE#DAY#<date>      jobs started that day (UTC)
 *   TENANT#<installId>   USAGE#MONTH#<yyyy-mm>  jobs, microVM seconds and throttled deliveries that month
 *   TENANT#<installId>   NOTICE#<repo>#<issue>#<date>  an over-quota comment was posted (once a day)
 *   PLATFORM#JOBS        SLOT#<n>              a running job's place in the platform-wide ceiling
 *
 * Everything in a TENANT# partition gets the table's `ttl` (epoch seconds) when the App is
 * uninstalled, so DynamoDB deletes the tenant and its members once the retention has passed.
 */

export type OAuthKind = 'link' | 'install';

export interface OAuthState {
  state: string;
  sub: string;
  kind: OAuthKind;
  /** PKCE verifier (link only: the install flow's authorization carries no challenge). */
  codeVerifier?: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface GitHubLink {
  githubUserId: number;
  githubLogin: string;
  linkedAt: string;
}

export type TenantStatus = 'active' | 'disabled';

export interface Tenant {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  status: TenantStatus;
  /** Why it is disabled: suspended or uninstalled on GitHub. Uninstalled is final. */
  disabledReason?: 'suspended' | 'uninstalled';
  /** Epoch ms after which an uninstalled tenant is gone (reads stop at once; DynamoDB TTL deletes it). */
  deleteAfter?: number;
  createdAt: string;
  createdBy: string;
  /** The config version jobs start with; absent until one is published (no config, no jobs). */
  activeConfigVersion?: number;
  /** An admin's overrides of the stack's default quotas (jobs/quotas.ts); absent: the defaults. */
  limits?: TenantLimits;
}

/** Per-tenant quotas an admin may override. Each one absent: the stack's default. */
export interface TenantLimits {
  concurrentJobs?: number;
  jobsPerDay?: number;
  microvmMinutesPerMonth?: number;
}

/** The quotas a launch is checked against: the tenant's (with overrides) and the platform's ceiling. */
export interface Quotas {
  concurrentJobs: number;
  jobsPerDay: number;
  microvmMinutesPerMonth: number;
  platformConcurrentJobs: number;
}

/** Which quota stopped a launch. */
export type QuotaLimit = 'concurrent_jobs' | 'jobs_per_day' | 'microvm_minutes' | 'platform_concurrency';

/** What reserveJob took for a job: its slots, and the day and month it counts against (UTC). */
export interface Reservation {
  installationId: number;
  jobId: string;
  tenantSlot: number;
  platformSlot: number;
  day: string;
  month: string;
}

/** A tenant's usage for a day and its month. */
export interface Usage {
  day: string;
  jobsToday: number;
  month: string;
  jobsThisMonth: number;
  microvmSecondsThisMonth: number;
  throttledThisMonth: number;
}

/** One published config: an immutable bundle under tenants/<id>/config/<version>/ in the tenant bucket. */
export interface ConfigVersion {
  installationId: number;
  version: number;
  /** pending: allocated, the upload may not have finished (never activated). ready: fully uploaded. */
  status: 'pending' | 'ready';
  sha256: string;
  files: string[];
  publishedBy: string;
  publishedAt: string;
  /** What the launcher checks before it starts a job with this version (tenants/dispatch.ts). */
  dispatch?: DispatchRules;
}

/**
 * The part of a compiled config the launcher needs, kept with the version so dispatch reads no
 * bundle: per repository (OWNER/REPO, lower-case), its GitHub id and its triggers, each with the
 * label (lower-case, as GitHub compares labels) and the logins allowed to apply it (lower-case).
 */
export interface DispatchRules {
  repositories: Record<string, { id: number; triggers: { label: string; actors: string[] }[] }>;
}

/** That an agent key is set (never its value, which lives only in Secrets Manager). */
export interface AgentKeyMeta {
  name: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * One job: a microVM the launcher (jobs/launch.ts) started for a tenant's webhook delivery. The broker
 * (broker/broker.ts) serves it only to whoever holds the job's token, only while it runs, and only
 * what this record pins: the tenant, the repository and the config version.
 */
export interface Job {
  jobId: string;
  /** sha256 hex of the job token; the token itself is only ever in the run-hook payload. */
  tokenHash: string;
  installationId: number;
  /** OWNER/REPO, and its GitHub id: the job's installation token reaches this repository only. */
  repository: string;
  repositoryId: number;
  /** The config version active when the job was dispatched; the job keeps it to the end. */
  configVersion: number;
  deliveryId: string;
  eventName: string;
  status: 'launched' | 'finished';
  /** The runner's outcome, once finished. */
  outcome?: string;
  createdAt: string;
  /** Epoch ms: launch time plus the microVM's maximum duration. Nothing is served after it. */
  expiresAt: number;
  /** The job's microVM, recorded by the launcher once RunMicrovm returns: the only one the job may stop. */
  microvmId?: string;
  /** What started it: the trigger label and who applied it. */
  label?: string;
  sender?: string;
  /** The MicroVM image version it runs. */
  imageVersion?: string;
  /** Its places in the tenant's and the platform's concurrency (reserveJob). */
  tenantSlot?: number;
  platformSlot?: number;
  /**
   * MicroVM seconds charged to the month of `createdAt` when it starts (its maximum duration);
   * finish refunds what it did not use.
   */
  reservedSeconds?: number;
  /** Epoch ms when the broker's `start` served it (startJob). */
  startedAt?: number;
}

export type MemberRole = 'owner' | 'editor';

export interface Member {
  installationId: number;
  sub: string;
  role: MemberRole;
  /** The GitHub identity whose authority earned this membership; it counts only while still linked. */
  githubUserId: number;
  githubLogin: string;
  addedAt: string;
}

/** An installation the user was shown to have authority over, for them to connect. */
export interface OfferedInstallation {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

export interface InstallationOffer {
  sub: string;
  githubUserId: number;
  githubLogin: string;
  installations: OfferedInstallation[];
  /** Epoch ms. */
  expiresAt: number;
}

export interface InstallationAccount {
  id: number;
  login: string;
  type: string;
}

export interface Store {
  putOAuthState(state: OAuthState): Promise<void>;
  /** Removes and returns the state, or null when it does not exist (never issued, or already used). */
  consumeOAuthState(state: string): Promise<OAuthState | null>;

  getLink(sub: string): Promise<GitHubLink | null>;
  /**
   * Links a GitHub identity to a user. `taken`: that identity belongs to another user.
   * `relink`: this user is already linked to a different identity (unlink first).
   */
  link(sub: string, link: GitHubLink): Promise<'linked' | 'taken' | 'relink'>;
  unlink(sub: string): Promise<void>;

  /** Replaces the user's offer (one at a time). */
  putOffer(offer: InstallationOffer): Promise<void>;
  getOffer(sub: string): Promise<InstallationOffer | null>;

  /** `consistent`: a strongly consistent read, for decisions that must see a suspend or uninstall just committed. */
  getTenant(installationId: number, options?: { consistent?: boolean }): Promise<Tenant | null>;
  /**
   * Creates the tenant if it is new (keeping an existing one as it is) and adds or updates the
   * member, atomically with a check that the tenant is not uninstalled (`uninstalled`: nothing added).
   */
  putTenantWithMember(tenant: Tenant, member: Member): Promise<'added' | 'uninstalled'>;
  /**
   * Uninstalled: final. Sets the deadline and the TTL of every item in the tenant's partition.
   * `already`: it was uninstalled before and keeps its original deadline; the partition sweep runs
   * again with that deadline, so one cut short by a failure completes on the next delivery.
   * `tombstone`: there was no tenant, so one is recorded already uninstalled (and expiring with the
   * same TTL): a Connect or install callback racing the delete cannot create the tenant afterwards.
   */
  markUninstalled(installationId: number, deleteAfter: number, account?: InstallationAccount): Promise<'marked' | 'already' | 'tombstone'>;
  /** An admin's quota overrides; null removes them (the stack's defaults again). */
  setTenantLimits(installationId: number, limits: TenantLimits | null): Promise<'updated' | 'no_tenant'>;
  /** Suspended or active again, unless the tenant was uninstalled (one conditional write). */
  setSuspended(installationId: number, suspended: boolean): Promise<'updated' | 'uninstalled' | 'no_tenant'>;
  getMember(installationId: number, sub: string): Promise<Member | null>;
  listMemberships(sub: string): Promise<Member[]>;

  /**
   * Allocates the next config version as `pending` (versions only ever grow). `uninstalled`: the
   * tenant is gone or going, so nothing is allocated; `no_tenant`: there is no such tenant.
   */
  createConfigVersion(installationId: number, meta: Omit<ConfigVersion, 'installationId' | 'version' | 'status'>): Promise<number | 'uninstalled' | 'no_tenant'>;
  /** The bundle is fully uploaded. */
  markConfigReady(installationId: number, version: number): Promise<void>;
  /**
   * Makes a ready version the one jobs start with, in one transaction with the checks. Only ever
   * forward: `superseded` when a newer version is active already (a slow publish finishing after
   * a later one). The previous active version stays active on any refusal.
   */
  activateConfig(installationId: number, version: number): Promise<'activated' | 'superseded' | 'not_ready' | 'uninstalled' | 'no_tenant'>;
  listConfigVersions(installationId: number): Promise<ConfigVersion[]>;
  getConfigVersion(installationId: number, version: number, options?: { consistent?: boolean }): Promise<ConfigVersion | null>;

  /** Refused (`uninstalled`) once the tenant is uninstalled or gone, so no row escapes the sweep. */
  putAgentKeyMeta(installationId: number, meta: AgentKeyMeta): Promise<'stored' | 'uninstalled'>;
  listAgentKeyMeta(installationId: number): Promise<AgentKeyMeta[]>;

  /**
   * Uninstalled tenants whose deadline has passed and whose data outside the table (the S3 prefix,
   * the key secrets) is not deleted yet. markUninstalled records them, without a TTL, so they
   * outlive the tenant's own rows.
   */
  listDueCleanups(now: number): Promise<CleanupEntry[]>;
  /** The tenant's data outside the table is gone: forget the entry. */
  completeCleanup(entry: CleanupEntry): Promise<void>;
  /**
   * At the deadline: deletes every row of the tenant's partition, including any an interrupted
   * uninstall sweep left without a TTL. Safe to repeat.
   */
  purgeTenantPartition(installationId: number): Promise<void>;

  /** Records a job (the launcher). Its own partition, expiring a week after the job may last. */
  putJob(job: Job): Promise<void>;
  getJob(jobId: string): Promise<Job | null>;
  /**
   * The runner said it is done: nothing more is served for it. Only the first outcome is kept, and
   * it is what this returns (null for an unknown job), so a repeated finish acts on the same one.
   * `refund`: microVM seconds given back to that month, only by the finish that records the outcome.
   */
  finishJob(jobId: string, outcome: string, refund?: { installationId: number; month: string; seconds: number }): Promise<string | null>;
  /** The launcher records the job's microVM. Set once: false when the job is unknown or already has one. */
  attachMicrovm(jobId: string, microvmId: string): Promise<boolean>;

  /**
   * Deduplication: claims a tenant's webhook delivery unless an unexpired claim exists (false: a
   * job was already started for it). `expiresAt` in epoch ms; the claim is the table's TTL too.
   * The claim is held by `jobId`, the job started for it.
   */
  claimDelivery(installationId: number, deliveryId: string, expiresAt: number, jobId: string): Promise<boolean>;
  /**
   * The broker's `start`, in one transaction: the job holds its delivery's claim and its slots
   * until `holdUntil` (epoch ms), taking back any that ran out and nobody took, is charged its
   * reserved seconds, and is marked started. `superseded`: a redelivery's job holds the claim;
   * `throttled`: another job holds one of its slots. Either way this job must not run, and nothing
   * changed. `already`: it was started before (a retried start), and is not charged again.
   */
  startJob(job: Job, holdUntil: number): Promise<'started' | 'already' | 'superseded' | 'throttled'>;
  /** Frees the job's slots (only while it holds them). Safe to repeat. */
  releaseJobSlots(job: Pick<Job, 'installationId' | 'jobId' | 'tenantSlot' | 'platformSlot'>): Promise<void>;

  /**
   * Quotas, at launch (jobs/launch.ts): takes a free slot of the tenant's and one of the
   * platform's, both held until `holdUntil` (epoch ms; the broker's start holds them for the job's
   * lifetime), and counts the job against the day and the month, in one transaction, while the
   * day's jobs and the month's microVM seconds are under their quotas. Or says which quota stopped
   * it, and takes nothing.
   */
  reserveJob(input: { installationId: number; jobId: string; holdUntil: number; day: string; month: string; quotas: Quotas }): Promise<
    { ok: true; tenantSlot: number; platformSlot: number } | { ok: false; limit: QuotaLimit }
  >;
  /** A launch that failed after reserveJob: frees the slots and takes back the day's and the month's count. */
  cancelReservation(reservation: Reservation): Promise<void>;
  /**
   * A delivery refused by a quota counts as throttled for the month. With `notice`: whether this is
   * the first for that issue that day, so the over-quota comment is posted once.
   */
  recordThrottle(installationId: number, month: string, notice?: { repositoryId: number; issue: number; day: string }): Promise<boolean>;
  getUsage(installationId: number, day: string, month: string): Promise<Usage>;
  /**
   * Lets a redelivery start the job again (it failed, or it never started). Only the job holding
   * the claim gives it up: a late release from an earlier job leaves a redelivery's claim alone.
   * Nothing happens when there is no such claim, so it is safe to repeat.
   */
  releaseDelivery(installationId: number, deliveryId: string, jobId: string): Promise<void>;
}

export interface CleanupEntry {
  installationId: number;
  deleteAfter: number;
}

/** In-memory Store for tests and local dev without AWS. `ttl` is recorded as DynamoDB would hold it. */
export function createMemoryStore(): Store & { ttlOf(installationId: number): { tenant?: number; members: (number | undefined)[] } } {
  const states = new Map<string, OAuthState>();
  const links = new Map<string, GitHubLink>();
  const owners = new Map<number, string>();
  const offers = new Map<string, InstallationOffer>();
  const tenants = new Map<number, Tenant & { ttl?: number }>();
  const members = new Map<string, Member & { ttl?: number }>();
  const configs = new Map<string, ConfigVersion>();
  const cleanups = new Map<number, CleanupEntry>();
  const keys = new Map<string, AgentKeyMeta>();
  const jobs = new Map<string, Job>();
  /** `<installationId>/<deliveryId>` -> expiry (epoch ms) and the job holding the claim. */
  const deliveries = new Map<string, { expiresAt: number; jobId: string }>();
  /** `<installationId>/<n>` or `platform/<n>` -> the job holding the slot, and until when (epoch ms). */
  const slots = new Map<string, { expiresAt: number; jobId: string }>();
  const days = new Map<string, number>();
  const months = new Map<string, { jobs: number; seconds: number; throttled: number }>();
  const notices = new Set<string>();
  const month = (key: string) => months.get(key) ?? { jobs: 0, seconds: 0, throttled: 0 };
  const free = (key: string, now: number) => {
    const s = slots.get(key);
    return s === undefined || s.expiresAt < now;
  };
  const mine = (key: string, jobId: string, now: number) => free(key, now) || slots.get(key)?.jobId === jobId;
  const slotKeys = (job: Pick<Job, 'installationId' | 'tenantSlot' | 'platformSlot'>) => [
    ...(job.tenantSlot !== undefined ? [`${job.installationId}/${job.tenantSlot}`] : []),
    ...(job.platformSlot !== undefined ? [`platform/${job.platformSlot}`] : []),
  ];
  const memberKey = (id: number, sub: string) => `${id}/${sub}`;
  const strip = <T extends { ttl?: number }>(item: T): Omit<T, 'ttl'> => {
    const { ttl: _ttl, ...rest } = item;
    return rest;
  };

  return {
    async putOAuthState(s) {
      states.set(s.state, { ...s });
    },
    async consumeOAuthState(state) {
      const s = states.get(state) ?? null;
      states.delete(state);
      return s;
    },
    async getLink(sub) {
      return links.get(sub) ?? null;
    },
    async link(sub, link) {
      const owner = owners.get(link.githubUserId);
      if (owner && owner !== sub) return 'taken';
      const existing = links.get(sub);
      if (existing && existing.githubUserId !== link.githubUserId) return 'relink';
      owners.set(link.githubUserId, sub);
      links.set(sub, { ...link });
      return 'linked';
    },
    async unlink(sub) {
      const existing = links.get(sub);
      if (existing) owners.delete(existing.githubUserId);
      links.delete(sub);
      offers.delete(sub);
    },
    async putOffer(offer) {
      offers.set(offer.sub, structuredClone(offer));
    },
    async getOffer(sub) {
      const o = offers.get(sub);
      return o ? structuredClone(o) : null;
    },
    async getTenant(id) {
      const t = tenants.get(id);
      return t ? (strip(t) as Tenant) : null;
    },
    async putTenantWithMember(tenant, member) {
      if (!tenants.has(tenant.installationId)) tenants.set(tenant.installationId, { ...tenant });
      if (tenants.get(tenant.installationId)?.disabledReason === 'uninstalled') return 'uninstalled';
      members.set(memberKey(member.installationId, member.sub), { ...member });
      return 'added';
    },
    async markUninstalled(id, deleteAfter, account) {
      const t = tenants.get(id);
      if (!t) {
        tenants.set(id, {
          installationId: id,
          accountId: account?.id ?? 0,
          accountLogin: account?.login ?? '',
          accountType: account?.type ?? '',
          status: 'disabled',
          disabledReason: 'uninstalled',
          deleteAfter,
          ttl: Math.ceil(deleteAfter / 1000),
          createdAt: new Date(0).toISOString(),
          createdBy: 'github:installation.deleted',
        });
        cleanups.set(id, { installationId: id, deleteAfter });
        return 'tombstone';
      }
      const already = t.disabledReason === 'uninstalled';
      const deadline = already ? (t.deleteAfter ?? deleteAfter) : deleteAfter;
      const ttl = Math.ceil(deadline / 1000);
      if (!already) tenants.set(id, { ...t, status: 'disabled', disabledReason: 'uninstalled', deleteAfter, ttl });
      for (const [k, m] of members) if (m.installationId === id && m.ttl !== ttl) members.set(k, { ...m, ttl });
      cleanups.set(id, { installationId: id, deleteAfter: deadline });
      return already ? 'already' : 'marked';
    },
    async setTenantLimits(id, limits) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      const next: Tenant & { ttl?: number } = { ...t };
      if (limits) next.limits = { ...limits };
      else delete next.limits;
      tenants.set(id, next);
      return 'updated';
    },
    async setSuspended(id, suspended) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      if (t.disabledReason === 'uninstalled') return 'uninstalled';
      const next: Tenant & { ttl?: number } = { ...t, status: suspended ? 'disabled' : 'active' };
      if (suspended) next.disabledReason = 'suspended';
      else delete next.disabledReason;
      tenants.set(id, next);
      return 'updated';
    },
    async getMember(id, sub) {
      const m = members.get(memberKey(id, sub));
      return m ? (strip(m) as Member) : null;
    },
    async listMemberships(sub) {
      return [...members.values()].filter((m) => m.sub === sub).map((m) => strip(m) as Member);
    },
    async createConfigVersion(id, meta) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      if (t.disabledReason === 'uninstalled') return 'uninstalled';
      const version = Math.max(0, ...[...configs.values()].filter((c) => c.installationId === id).map((c) => c.version)) + 1;
      configs.set(`${id}/${version}`, { ...meta, installationId: id, version, status: 'pending' });
      return version;
    },
    async markConfigReady(id, version) {
      const c = configs.get(`${id}/${version}`);
      if (c) configs.set(`${id}/${version}`, { ...c, status: 'ready' });
    },
    async activateConfig(id, version) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      if (t.disabledReason === 'uninstalled') return 'uninstalled';
      if (configs.get(`${id}/${version}`)?.status !== 'ready') return 'not_ready';
      if (t.activeConfigVersion !== undefined && t.activeConfigVersion >= version) return 'superseded';
      tenants.set(id, { ...t, activeConfigVersion: version });
      return 'activated';
    },
    async listConfigVersions(id) {
      return [...configs.values()].filter((c) => c.installationId === id).sort((a, b) => a.version - b.version).map((c) => ({ ...c }));
    },
    async getConfigVersion(id, version) {
      const c = configs.get(`${id}/${version}`);
      return c ? { ...c } : null;
    },
    async claimDelivery(id, deliveryId, expiresAt, jobId) {
      const key = `${id}/${deliveryId}`;
      const existing = deliveries.get(key);
      if (existing !== undefined && existing.expiresAt > Date.now()) return false;
      deliveries.set(key, { expiresAt, jobId });
      return true;
    },
    async startJob(job, holdUntil) {
      const now = Date.now();
      const current = jobs.get(job.jobId);
      if (current?.startedAt !== undefined) return 'already';
      const claimKey = `${job.installationId}/${job.deliveryId}`;
      const claim = deliveries.get(claimKey);
      if (claim !== undefined && claim.jobId !== job.jobId && claim.expiresAt > now) return 'superseded';
      if (!slotKeys(job).every((key) => mine(key, job.jobId, now))) return 'throttled';
      deliveries.set(claimKey, { expiresAt: holdUntil, jobId: job.jobId });
      for (const key of slotKeys(job)) slots.set(key, { expiresAt: holdUntil, jobId: job.jobId });
      if (job.reservedSeconds) {
        const key = `${job.installationId}/${job.createdAt.slice(0, 7)}`;
        months.set(key, { ...month(key), seconds: month(key).seconds + job.reservedSeconds });
      }
      if (current) jobs.set(job.jobId, { ...current, startedAt: now });
      return 'started';
    },
    async releaseJobSlots(job) {
      for (const key of slotKeys(job)) if (slots.get(key)?.jobId === job.jobId) slots.delete(key);
    },
    async reserveJob({ installationId: id, jobId, holdUntil, day, month: m, quotas }) {
      const now = Date.now();
      const tenantSlot = [...Array(quotas.concurrentJobs).keys()].find((n) => free(`${id}/${n}`, now));
      if (tenantSlot === undefined) return { ok: false, limit: 'concurrent_jobs' };
      const platformSlot = [...Array(quotas.platformConcurrentJobs).keys()].find((n) => free(`platform/${n}`, now));
      if (platformSlot === undefined) return { ok: false, limit: 'platform_concurrency' };
      const dayKey = `${id}/${day}`;
      if ((days.get(dayKey) ?? 0) >= quotas.jobsPerDay) return { ok: false, limit: 'jobs_per_day' };
      const monthKey = `${id}/${m}`;
      if (month(monthKey).seconds >= quotas.microvmMinutesPerMonth * 60) return { ok: false, limit: 'microvm_minutes' };
      slots.set(`${id}/${tenantSlot}`, { expiresAt: holdUntil, jobId });
      slots.set(`platform/${platformSlot}`, { expiresAt: holdUntil, jobId });
      days.set(dayKey, (days.get(dayKey) ?? 0) + 1);
      months.set(monthKey, { ...month(monthKey), jobs: month(monthKey).jobs + 1 });
      return { ok: true, tenantSlot, platformSlot };
    },
    async cancelReservation(r) {
      for (const key of slotKeys(r)) if (slots.get(key)?.jobId === r.jobId) slots.delete(key);
      const dayKey = `${r.installationId}/${r.day}`;
      days.set(dayKey, Math.max(0, (days.get(dayKey) ?? 0) - 1));
      const monthKey = `${r.installationId}/${r.month}`;
      months.set(monthKey, { ...month(monthKey), jobs: Math.max(0, month(monthKey).jobs - 1) });
    },
    async recordThrottle(id, m, notice) {
      const monthKey = `${id}/${m}`;
      months.set(monthKey, { ...month(monthKey), throttled: month(monthKey).throttled + 1 });
      if (!notice) return false;
      const key = `${id}/${notice.repositoryId}/${notice.issue}/${notice.day}`;
      if (notices.has(key)) return false;
      notices.add(key);
      return true;
    },
    async getUsage(id, day, m) {
      const u = month(`${id}/${m}`);
      return { day, jobsToday: days.get(`${id}/${day}`) ?? 0, month: m, jobsThisMonth: u.jobs, microvmSecondsThisMonth: u.seconds, throttledThisMonth: u.throttled };
    },
    async releaseDelivery(id, deliveryId, jobId) {
      const key = `${id}/${deliveryId}`;
      if (deliveries.get(key)?.jobId === jobId) deliveries.delete(key);
    },
    async putAgentKeyMeta(id, meta) {
      const t = tenants.get(id);
      if (!t || t.disabledReason === 'uninstalled') return 'uninstalled';
      keys.set(`${id}/${meta.name}`, { ...meta });
      return 'stored';
    },
    async listDueCleanups(now) {
      return [...cleanups.values()].filter((c) => c.deleteAfter <= now).map((c) => ({ ...c }));
    },
    async putJob(job) {
      jobs.set(job.jobId, { ...job });
    },
    async getJob(jobId) {
      const j = jobs.get(jobId);
      return j ? { ...j } : null;
    },
    async finishJob(jobId, outcome, refund) {
      const j = jobs.get(jobId);
      if (!j) return null;
      if (j.status === 'finished') return j.outcome ?? null;
      jobs.set(jobId, { ...j, status: 'finished', outcome });
      if (refund && refund.seconds > 0) {
        const key = `${refund.installationId}/${refund.month}`;
        months.set(key, { ...month(key), seconds: month(key).seconds - refund.seconds });
      }
      return outcome;
    },
    async attachMicrovm(jobId, microvmId) {
      const j = jobs.get(jobId);
      if (!j || j.microvmId !== undefined) return false;
      jobs.set(jobId, { ...j, microvmId });
      return true;
    },
    async purgeTenantPartition(id) {
      tenants.delete(id);
      for (const [k, m] of members) if (m.installationId === id) members.delete(k);
      for (const [k, c] of configs) if (c.installationId === id) configs.delete(k);
      for (const k of [...keys.keys()]) if (k.startsWith(`${id}/`)) keys.delete(k);
      for (const m of [slots, days, months]) for (const k of [...m.keys()]) if (k.startsWith(`${id}/`)) m.delete(k);
    },
    async completeCleanup(entry) {
      if (cleanups.get(entry.installationId)?.deleteAfter === entry.deleteAfter) cleanups.delete(entry.installationId);
    },
    async listAgentKeyMeta(id) {
      return [...keys.entries()].filter(([k]) => k.startsWith(`${id}/`)).map(([, v]) => ({ ...v })).sort((a, b) => a.name.localeCompare(b.name));
    },
    ttlOf(id) {
      return {
        tenant: tenants.get(id)?.ttl,
        members: [...members.values()].filter((m) => m.installationId === id).map((m) => m.ttl),
      };
    },
  };
}
