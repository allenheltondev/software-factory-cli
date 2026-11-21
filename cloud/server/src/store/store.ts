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
 *   TENANT#<installId>   JOB#<createdAt>#<jobId>  a job's summary, for the admin view (TTL 30 days)
 *   PLATFORM#JOBS        SLOT#<n>              a running job's place in the platform-wide ceiling
 *   PLATFORM#ACTIVE      JOB#<jobId>           a reservation not yet released: what reconciliation looks at
 *
 * Everything in a TENANT# partition gets the table's `ttl` (epoch seconds) when the App is
 * uninstalled, so DynamoDB deletes the tenant and its members once the retention has passed.
 */

import type { JobLoop, JobStep, JobTelemetryReport } from '../jobs/lifecycle.js';

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
  /**
   * Why it is disabled: suspended or uninstalled on GitHub (uninstalled is final), or `admin`: an
   * Updraft admin disabled it (`adminDisabled`) and GitHub has it active.
   */
  disabledReason?: 'suspended' | 'uninstalled' | 'admin';
  /** An Updraft admin disabled it: jobs stop, whatever GitHub says, until an admin enables it. */
  adminDisabled?: { at: string; by: string; reason?: string };
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

/**
 * A reservation reconciliation looks at, from reserveJob until the job is released. `reserved`: no
 * microVM has been asked for yet, so one this old is a launch that stopped partway and can be
 * reclaimed. `launching`: RunMicrovm may have been called, so a microVM may exist.
 */
export interface ActiveJob extends Reservation {
  phase: 'reserved' | 'launching';
  /** Epoch ms. */
  reservedAt: number;
  /** Epoch ms: the job's maximum duration, when its slots run out. */
  expiresAt: number;
}

/** A tenant's usage for a day and its month. */
export interface Usage {
  day: string;
  jobsToday: number;
  month: string;
  jobsThisMonth: number;
  microvmSecondsThisMonth: number;
  throttledThisMonth: number;
  /** Jobs that month whose first outcome was a failure (jobs/quotas.ts FAILED_OUTCOMES). */
  failedThisMonth: number;
}

/** A job as the admin view lists it: what started it and how it ended. */
export interface JobSummary {
  jobId: string;
  repository: string;
  issue?: number;
  label?: string;
  sender?: string;
  createdAt: string;
  status: Job['status'];
  outcome?: string;
  /** The config version the job pinned (#71). Absent on summaries from before it was recorded. */
  configVersion?: number;
  /** What the job's finish reported (#71); absent while it runs, and for a job that never ran. */
  finishedAt?: string;
  /** From the broker's start to the finish. */
  durationSeconds?: number;
  /** Its microVM: where its logs are, `results/<delivery>/<microvmId>/`. */
  microvmId?: string;
  deliveryId?: string;
  detail?: JobFinishDetail;
}

/**
 * What a job's runner reports at its finish, beyond the outcome (#71), as the broker checked it:
 * shown in the console, never trusted for anything else.
 */
export interface JobFinishDetail {
  /** `updraft run-event`'s own outcome (succeeded, failed, publish-failed, nothing-to-do, ...). */
  updraftOutcome?: string;
  /** false: the job's verify commands failed. */
  verificationPassed?: boolean;
  /** The pull request it opened or updated: a URL of the job's own repository. */
  prUrl?: string;
  prNumber?: number;
  /** The logs it uploaded: updraft.log, run.log. */
  logs?: string[];
  /** Where the review loop left its pull request (jobs/lifecycle.ts). */
  loop?: JobLoop;
  /** Each step the run took, in order: its own job, then reviewer runs and revisions. */
  steps?: JobStep[];
  /** The trace its agents' telemetry was sent as. */
  telemetry?: JobTelemetryReport;
}

/**
 * One webhook delivery of a tenant, and what became of it (#71), kept 30 days. `reason` is a code
 * (jobs/deliveries.ts), `message` the words for people.
 */
export interface DeliveryRecord {
  at: string;
  deliveryId: string;
  event: string;
  action?: string;
  repository?: string;
  issue?: number;
  label?: string;
  sender?: string;
  disposition: 'filtered' | 'deduped' | 'coalesced' | 'throttled' | 'launch_failed' | 'launched';
  reason?: string;
  message?: string;
  /** launch_failed: the AWS error's class (its name), never its message. */
  errorClass?: string;
  jobId?: string;
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
  /** Published by re-activating this earlier version: a copy of it, under a new number. */
  copiedFrom?: number;
}

/**
 * The part of a compiled config the launcher needs, kept with the version so dispatch reads no
 * bundle: per repository (OWNER/REPO, lower-case), its GitHub id and its triggers, each with the
 * label (lower-case, as GitHub compares labels) and the logins allowed to apply it (lower-case).
 */
export interface DispatchRules {
  /**
   * `paused`: the repository stays configured, but no labeled issue of it starts a job.
   * `actors`: when every trigger allows the same logins, they are stored once here and the
   * triggers carry none (a version's record is one DynamoDB item); otherwise each trigger has its
   * own. Versions stored before this have them on every trigger.
   * `keys`: the agent keys (variable names) a job the trigger starts can need; the launcher
   * refuses it while one is not set. Stored once on the repository when every trigger needs the
   * same, like `actors`. Absent everywhere on versions published before #70 (the launcher then
   * reads them from the bundle, key-needs.ts).
   */
  repositories: Record<string, { id: number; paused?: boolean; actors?: string[]; keys?: string[]; triggers: { label: string; actors?: string[]; keys?: string[] }[] }>;
}

/** That an agent key is set (never its value, which lives only in Secrets Manager). */
export interface AgentKeyMeta {
  name: string;
  /** When the value was last set: "last rotated". */
  updatedAt: string;
  updatedBy: string;
  /** The last job that ran with this key, and whether it worked. Cleared when the key is rotated. */
  lastUsedAt?: string;
  lastUsedOk?: boolean;
}

/**
 * A tenant's agent telemetry (tenants/telemetry-service.ts): where jobs send traces of what their
 * agents did. The key itself is a secret (`agent-keys/HONEYCOMB_API_KEY`); this holds only that
 * it is set, which Honeycomb team and environment it belongs to, and how the last export went.
 */
export interface TelemetrySettings {
  provider: 'honeycomb';
  enabled: boolean;
  region: 'us' | 'eu';
  /** `service.name`: the dataset traces land in. */
  serviceName: string;
  /** Record prompts, model output and tool arguments and results (redacted). */
  captureContent: boolean;
  updatedAt: string;
  updatedBy: string;
  key?: {
    updatedAt: string;
    updatedBy: string;
    /** What Honeycomb's /1/auth said the key is. */
    type?: string;
    team?: { name: string; slug: string };
    environment?: { name: string; slug: string };
  };
  lastExport?: TelemetryExport;
}

export interface TelemetryExport {
  at: string;
  jobId: string;
  traceId?: string;
  spans: number;
  exported: number;
  failed: number;
  lastError?: string;
}

/** A launch the launcher refused, and why, kept 30 days for the console (never anything secret). */
export interface DispatchRefusal {
  at: string;
  deliveryId: string;
  repository: string;
  issue: number;
  reason: string;
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
   * what it did not use is refunded once its microVM is seen stopping (releaseJob).
   */
  reservedSeconds?: number;
  /** The tenant's quotas when it was launched: `start` checks the month against them, and a refusal says why. */
  quotas?: Quotas;
  /** The agent keys (variable names) this job needs; at finish each is marked used, OK or failed. */
  agentKeys?: string[];
  /** The issue whose label started it, for an over-quota comment. */
  issue?: number;
  /** Epoch ms when the broker's `start` committed it (startJob): nothing else is served before. */
  startedAt?: number;
  /**
   * Epoch ms when its microVM was asked to stop (the broker's terminate, or a refused start):
   * nothing is served for it after, and it can never start, whatever its outcome says.
   */
  stopRequestedAt?: number;
  /** Epoch ms when its slots and unused time were given back (releaseJob), once Lambda showed its microVM terminated. */
  releasedAt?: number;
}

/** What the broker's `start` did (Store.startJob). */
export type StartResult =
  | { result: 'started' | 'already' | 'retired' | 'superseded' }
  | { result: 'throttled'; limit: QuotaLimit };

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
  /**
   * An admin disables the tenant (jobs stop at once: the launcher and the broker read its status)
   * or enables it again. Enabling makes it active only if GitHub has it active too.
   */
  setAdminDisabled(installationId: number, disabled: { by: string; reason?: string } | null): Promise<'updated' | 'uninstalled' | 'no_tenant'>;
  /** Every tenant, for the admin view (a scan: the table is small, and admins are few). */
  listTenants(): Promise<Tenant[]>;
  /** The tenant's most recent jobs, newest first. */
  listRecentJobs(installationId: number, limit: number): Promise<JobSummary[]>;
  /** One of the tenant's job summaries (30 days), or null: never another tenant's. */
  getJobSummary(installationId: number, jobId: string): Promise<JobSummary | null>;
  recordDelivery(installationId: number, delivery: DeliveryRecord): Promise<void>;
  /** Newest first. */
  listDeliveries(installationId: number, limit: number): Promise<DeliveryRecord[]>;
  /** Every kept attempt of a delivery (GitHub reuses the id on a redelivery), oldest first. */
  listDeliveriesOf(installationId: number, deliveryId: string): Promise<DeliveryRecord[]>;
  /**
   * Suspended or active again, unless the tenant was uninstalled (one conditional write). An
   * unsuspend leaves a tenant an admin disabled disabled.
   */
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
  activateConfig(
    installationId: number,
    version: number,
    options?: {
      /**
       * The active version this publish was checked against (null: none). The write also requires
       * it still to be active, so two editors who both saw it can't both win; the loser gets
       * `changed`.
       */
      expectedActive?: number | null;
    },
  ): Promise<'activated' | 'superseded' | 'changed' | 'not_ready' | 'uninstalled' | 'no_tenant'>;
  listConfigVersions(installationId: number): Promise<ConfigVersion[]>;
  getConfigVersion(installationId: number, version: number, options?: { consistent?: boolean }): Promise<ConfigVersion | null>;

  /** Refused (`uninstalled`) once the tenant is uninstalled or gone, so no row escapes the sweep. */
  putAgentKeyMeta(installationId: number, meta: AgentKeyMeta): Promise<'stored' | 'uninstalled'>;
  listAgentKeyMeta(installationId: number): Promise<AgentKeyMeta[]>;
  /**
   * Records the outcome of a job that used the key. Nothing when the key is not set, or was
   * rotated after `jobStartedAt` (ISO): the job ran with the value before.
   */
  recordAgentKeyUse(installationId: number, name: string, use: { at: string; ok: boolean; jobStartedAt: string }): Promise<void>;
  getTelemetry(installationId: number): Promise<TelemetrySettings | null>;
  /** Refused (`uninstalled`) once the tenant is uninstalled or gone, like a key's metadata. */
  putTelemetry(installationId: number, settings: TelemetrySettings): Promise<'stored' | 'uninstalled'>;
  /** How a job's export went; nothing when telemetry was never set up. */
  recordTelemetryExport(installationId: number, result: TelemetryExport): Promise<void>;
  recordRefusal(installationId: number, refusal: DispatchRefusal): Promise<void>;
  /** Newest first. */
  listRefusals(installationId: number, limit: number): Promise<DispatchRefusal[]>;

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

  /**
   * Records a job (the launcher), before its microVM is started: its own partition, expiring a
   * week after the job may last, and in the same write its summary in the tenant's partition.
   */
  putJob(job: Job): Promise<void>;
  /**
   * The launcher is about to call RunMicrovm: the job's active entry becomes `launching`, and is
   * no longer reclaimable. Throws when there is no `reserved` entry (it was reclaimed): no launch.
   */
  markLaunching(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<Job | null>;
  /**
   * The runner said it is done: nothing more is served for it. Only the first outcome is kept, and
   * it is what this returns (null for an unknown job), so a repeated finish acts on the same one.
   * The first one also goes on the job's summary, and a failure counts in the month's usage.
   */
  finishJob(jobId: string, outcome: string, finish?: { at: number; detail?: JobFinishDetail }): Promise<string | null>;
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
   * reserved seconds while the month is under its quota (`job.quotas`), and is marked started.
   * Refusals change nothing, and the job must not run: `retired` (it is finished), `superseded`
   * (a redelivery's job holds the claim), `throttled` (another job holds one of its slots, or the
   * month is spent). `already`: it was started before (a retried start), and is not charged again.
   */
  startJob(job: Job, holdUntil: number): Promise<StartResult>;
  /** Frees the job's slots (only while it holds them). Safe to repeat. */
  releaseJobSlots(job: Pick<Job, 'installationId' | 'jobId' | 'tenantSlot' | 'platformSlot'>): Promise<void>;
  /**
   * Lambda shows the job's microVM terminated (or it has none): refunds the microVM seconds it did
   * not use (`refund`) and marks it released (and stopping, so it can never start), at most once,
   * then frees its slots and drops it from the active jobs. Safe to repeat.
   */
  releaseJob(job: Job, refund?: { month: string; seconds: number }): Promise<void>;
  /** Its microVM was asked to stop: the job is retired for serving and starting. Set once. */
  markStopping(jobId: string): Promise<void>;
  /**
   * Holds the job's slots (its own, or free) until `until` (epoch ms), each on its own and only
   * while the job is not released (nothing to hold then): a running microVM keeps its capacity
   * until it is seen terminated, or runs out. False when another job holds one of them: this job's
   * microVM runs outside the quota.
   */
  holdSlots(job: Pick<Job, 'installationId' | 'jobId' | 'tenantSlot' | 'platformSlot'>, until: number): Promise<boolean>;
  /** The platform's unexpired slots and the jobs holding them. */
  listPlatformSlots(): Promise<{ jobId: string; expiresAt: number }[]>;
  /** The reservations not yet released (reserveJob to releaseJob): what reconciliation looks at. */
  listActiveJobs(): Promise<ActiveJob[]>;
  /** An active entry whose job is gone, past its maximum duration: frees its slots and drops it. */
  forgetActiveJob(entry: ActiveJob): Promise<void>;

  /**
   * Quotas, at launch (jobs/launch.ts): takes a free slot of the tenant's and one of the
   * platform's, both held until `holdUntil` (epoch ms, the job's maximum duration), counts the job
   * against the day and the month, and records a `reserved` active entry for reconciliation, in
   * one transaction, while the day's jobs and the month's microVM seconds are under their quotas.
   * Or says which quota stopped it, and takes nothing.
   */
  reserveJob(input: { installationId: number; jobId: string; holdUntil: number; day: string; month: string; quotas: Quotas }): Promise<
    { ok: true; tenantSlot: number; platformSlot: number } | { ok: false; limit: QuotaLimit }
  >;
  /**
   * A launch that failed after reserveJob, or one reconciliation reclaims: takes back the day's
   * and the month's count and drops the active entry, in one transaction, only while that entry
   * exists in `phase`, so it happens once however often or concurrently it is tried:
   *   cancelled   this call did it, and freed the slots
   *   gone        it was done before (no entry): the slots are freed again (owner-checked), so a
   *               cancel cut short after its transaction finishes
   *   mismatch    the entry is in another phase (a launch moved it on): nothing is touched
   * `retire`: in the same transaction, the job is finished with that outcome (unless it already has
   * one) and marked stopping, so a launch that finds its reservation gone sees why.
   */
  cancelReservation(
    reservation: Reservation,
    phase: ActiveJob['phase'],
    retire?: { job: Pick<Job, 'jobId' | 'installationId' | 'createdAt'>; outcome: string },
  ): Promise<'cancelled' | 'gone' | 'mismatch'>;
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

/**
 * Outcomes that count as a failed job in the admin view: anything but a clean success, an
 * unconfirmed one (it ran, without a summary), jobs that never ran for a quota or a redelivery
 * (throttled, superseded), and an admin's release.
 */
export const NOT_FAILURES: ReadonlySet<string> = new Set(['succeeded', 'unconfirmed', 'throttled', 'superseded', 'released_by_admin']);
export const isFailure = (outcome: string) => !NOT_FAILURES.has(outcome);

export interface CleanupEntry {
  installationId: number;
  deleteAfter: number;
}

/** The fields a finish adds to a job's summary: when, how long it ran, its microVM, and what it reported. */
export function finishFields(job: Pick<Job, 'startedAt' | 'microvmId'>, finish?: { at: number; detail?: JobFinishDetail }): Partial<JobSummary> {
  if (!finish) return {};
  return {
    finishedAt: new Date(finish.at).toISOString(),
    ...(job.startedAt !== undefined ? { durationSeconds: Math.max(0, Math.round((finish.at - job.startedAt) / 1000)) } : {}),
    ...(job.microvmId ? { microvmId: job.microvmId } : {}),
    ...(finish.detail && Object.keys(finish.detail).length ? { detail: finish.detail } : {}),
  };
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
  const telemetry = new Map<number, TelemetrySettings>();
  const refusals: { id: number; r: DispatchRefusal }[] = [];
  const deliveries2: { id: number; d: DeliveryRecord }[] = [];
  const jobs = new Map<string, Job>();
  /** `<installationId>/<deliveryId>` -> expiry (epoch ms) and the job holding the claim. */
  const deliveries = new Map<string, { expiresAt: number; jobId: string }>();
  /** `<installationId>/<n>` or `platform/<n>` -> the job holding the slot, and until when (epoch ms). */
  const slots = new Map<string, { expiresAt: number; jobId: string }>();
  const days = new Map<string, number>();
  const months = new Map<string, { jobs: number; seconds: number; throttled: number }>();
  const notices = new Set<string>();
  const active = new Map<string, ActiveJob>();
  const summaries = new Map<string, JobSummary & { installationId: number }>();
  const failed = new Map<string, number>();
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
    async setAdminDisabled(id, disabled) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      if (t.disabledReason === 'uninstalled') return 'uninstalled';
      const next: Tenant & { ttl?: number } = { ...t };
      if (disabled) {
        next.adminDisabled = { at: new Date().toISOString(), by: disabled.by, ...(disabled.reason ? { reason: disabled.reason } : {}) };
        next.status = 'disabled';
        if (!next.disabledReason) next.disabledReason = 'admin';
      } else {
        delete next.adminDisabled;
        if (next.disabledReason === 'admin') {
          delete next.disabledReason;
          next.status = 'active';
        }
      }
      tenants.set(id, next);
      return 'updated';
    },
    async listTenants() {
      return [...tenants.values()].map((t) => strip(t) as Tenant);
    },
    async listRecentJobs(id, limit) {
      return [...summaries.values()]
        .filter((s) => s.installationId === id)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, limit)
        .map(({ installationId: _id, ...s }) => ({ ...s }));
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
      const next: Tenant & { ttl?: number } = { ...t, status: suspended || t.adminDisabled ? 'disabled' : 'active' };
      if (suspended) next.disabledReason = 'suspended';
      else if (t.adminDisabled) next.disabledReason = 'admin';
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
    async activateConfig(id, version, options) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      if (t.disabledReason === 'uninstalled') return 'uninstalled';
      if (configs.get(`${id}/${version}`)?.status !== 'ready') return 'not_ready';
      if (options?.expectedActive !== undefined && (t.activeConfigVersion ?? null) !== options.expectedActive) return 'changed';
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
      if (!current || current.status === 'finished' || current.stopRequestedAt !== undefined) return { result: 'retired' };
      if (current.startedAt !== undefined) return { result: 'already' };
      const claimKey = `${job.installationId}/${job.deliveryId}`;
      const claim = deliveries.get(claimKey);
      if (claim !== undefined && claim.jobId !== job.jobId && claim.expiresAt > now) return { result: 'superseded' };
      if (job.tenantSlot !== undefined && !mine(`${job.installationId}/${job.tenantSlot}`, job.jobId, now)) return { result: 'throttled', limit: 'concurrent_jobs' };
      if (job.platformSlot !== undefined && !mine(`platform/${job.platformSlot}`, job.jobId, now)) return { result: 'throttled', limit: 'platform_concurrency' };
      const monthKey = `${job.installationId}/${job.createdAt.slice(0, 7)}`;
      if (job.reservedSeconds && job.quotas && month(monthKey).seconds >= job.quotas.microvmMinutesPerMonth * 60) return { result: 'throttled', limit: 'microvm_minutes' };
      deliveries.set(claimKey, { expiresAt: holdUntil, jobId: job.jobId });
      for (const key of slotKeys(job)) slots.set(key, { expiresAt: holdUntil, jobId: job.jobId });
      if (job.reservedSeconds) months.set(monthKey, { ...month(monthKey), seconds: month(monthKey).seconds + job.reservedSeconds });
      jobs.set(job.jobId, { ...current, startedAt: now });
      return { result: 'started' };
    },
    async markStopping(jobId) {
      const current = jobs.get(jobId);
      if (current && current.stopRequestedAt === undefined) jobs.set(jobId, { ...current, stopRequestedAt: Date.now() });
    },
    async holdSlots(job, until) {
      const now = Date.now();
      const current = jobs.get(job.jobId);
      if (!current || current.releasedAt !== undefined) return true;
      let all = true;
      for (const key of slotKeys(job)) {
        if (mine(key, job.jobId, now)) slots.set(key, { expiresAt: until, jobId: job.jobId });
        else all = false;
      }
      return all;
    },
    async listActiveJobs() {
      return [...active.values()].map((a) => ({ ...a }));
    },
    async forgetActiveJob(entry) {
      for (const key of slotKeys(entry)) if (slots.get(key)?.jobId === entry.jobId) slots.delete(key);
      active.delete(entry.jobId);
    },
    async markLaunching(jobId) {
      const entry = active.get(jobId);
      if (!entry || entry.phase !== 'reserved') throw new Error(`job ${jobId} has no reservation to launch`);
      active.set(jobId, { ...entry, phase: 'launching' });
    },
    async listPlatformSlots() {
      const now = Date.now();
      return [...slots.entries()].filter(([key, s]) => key.startsWith('platform/') && s.expiresAt >= now).map(([, s]) => ({ ...s }));
    },
    async releaseJob(job, refund) {
      const current = jobs.get(job.jobId);
      if (current && current.releasedAt === undefined) {
        const at = Date.now();
        jobs.set(job.jobId, { ...current, releasedAt: at, stopRequestedAt: current.stopRequestedAt ?? at });
        if (refund && refund.seconds > 0) {
          const key = `${job.installationId}/${refund.month}`;
          months.set(key, { ...month(key), seconds: month(key).seconds - refund.seconds });
        }
      }
      for (const key of slotKeys(job)) if (slots.get(key)?.jobId === job.jobId) slots.delete(key);
      active.delete(job.jobId);
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
      active.set(jobId, { installationId: id, jobId, tenantSlot, platformSlot, day, month: m, phase: 'reserved', reservedAt: now, expiresAt: holdUntil });
      return { ok: true, tenantSlot, platformSlot };
    },
    async cancelReservation(r, phase, retire) {
      const entry = active.get(r.jobId);
      if (entry !== undefined && entry.phase !== phase) return 'mismatch';
      for (const key of slotKeys(r)) if (slots.get(key)?.jobId === r.jobId) slots.delete(key);
      if (entry === undefined) return 'gone';
      active.delete(r.jobId);
      const j = retire ? jobs.get(retire.job.jobId) : undefined;
      if (retire && j) {
        const outcome = j.outcome ?? retire.outcome;
        jobs.set(j.jobId, { ...j, status: 'finished', outcome, stopRequestedAt: j.stopRequestedAt ?? Date.now() });
        const s = summaries.get(j.jobId);
        if (s) summaries.set(j.jobId, { ...s, status: 'finished', outcome: s.outcome ?? outcome });
      }
      const dayKey = `${r.installationId}/${r.day}`;
      days.set(dayKey, Math.max(0, (days.get(dayKey) ?? 0) - 1));
      const monthKey = `${r.installationId}/${r.month}`;
      months.set(monthKey, { ...month(monthKey), jobs: Math.max(0, month(monthKey).jobs - 1) });
      return 'cancelled';
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
      return {
        day,
        jobsToday: days.get(`${id}/${day}`) ?? 0,
        month: m,
        jobsThisMonth: u.jobs,
        microvmSecondsThisMonth: u.seconds,
        throttledThisMonth: u.throttled,
        failedThisMonth: failed.get(`${id}/${m}`) ?? 0,
      };
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
      summaries.set(job.jobId, {
        installationId: job.installationId,
        jobId: job.jobId,
        repository: job.repository,
        ...(job.issue !== undefined ? { issue: job.issue } : {}),
        ...(job.label ? { label: job.label } : {}),
        ...(job.sender ? { sender: job.sender } : {}),
        createdAt: job.createdAt,
        status: job.status,
        configVersion: job.configVersion,
        deliveryId: job.deliveryId,
      });
    },
    async getJobSummary(id, jobId) {
      const s = summaries.get(jobId);
      if (!s || s.installationId !== id) return null;
      const { installationId: _id, ...rest } = s;
      return structuredClone(rest);
    },
    async recordDelivery(id, d) {
      deliveries2.push({ id, d: { ...d } });
    },
    async listDeliveriesOf(id, deliveryId) {
      return deliveries2.filter((x) => x.id === id && x.d.deliveryId === deliveryId).map((x) => ({ ...x.d })).sort((a, b) => a.at.localeCompare(b.at));
    },
    async listDeliveries(id, limit) {
      return deliveries2.filter((x) => x.id === id).map((x) => ({ ...x.d })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    },
    async getJob(jobId) {
      const j = jobs.get(jobId);
      return j ? { ...j } : null;
    },
    async finishJob(jobId, outcome, finish) {
      const j = jobs.get(jobId);
      if (!j) return null;
      if (j.status === 'finished') return j.outcome ?? null;
      jobs.set(jobId, { ...j, status: 'finished', outcome });
      const s = summaries.get(jobId);
      if (s) summaries.set(jobId, { ...s, status: 'finished', outcome, ...finishFields(j, finish) });
      if (isFailure(outcome)) {
        const key = `${j.installationId}/${j.createdAt.slice(0, 7)}`;
        failed.set(key, (failed.get(key) ?? 0) + 1);
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
      telemetry.delete(id);
      for (let i = refusals.length - 1; i >= 0; i--) if (refusals[i]!.id === id) refusals.splice(i, 1);
      for (let i = deliveries2.length - 1; i >= 0; i--) if (deliveries2[i]!.id === id) deliveries2.splice(i, 1);
      for (const m of [slots, days, months]) for (const k of [...m.keys()]) if (k.startsWith(`${id}/`)) m.delete(k);
    },
    async completeCleanup(entry) {
      if (cleanups.get(entry.installationId)?.deleteAfter === entry.deleteAfter) cleanups.delete(entry.installationId);
    },
    async recordAgentKeyUse(id, name, use) {
      const k = keys.get(`${id}/${name}`);
      if (k && k.updatedAt <= use.jobStartedAt) keys.set(`${id}/${name}`, { ...k, lastUsedAt: use.at, lastUsedOk: use.ok });
    },
    async recordRefusal(id, r) {
      refusals.push({ id, r: { ...r } });
    },
    async getTelemetry(id) {
      const t = telemetry.get(id);
      return t ? structuredClone(t) : null;
    },
    async putTelemetry(id, settings) {
      const t = tenants.get(id);
      if (!t || t.disabledReason === 'uninstalled') return 'uninstalled';
      telemetry.set(id, structuredClone(settings));
      return 'stored';
    },
    async recordTelemetryExport(id, result) {
      const t = telemetry.get(id);
      if (t) telemetry.set(id, { ...t, lastExport: { ...result } });
    },
    async listRefusals(id, limit) {
      return refusals.filter((x) => x.id === id).map((x) => ({ ...x.r })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
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
