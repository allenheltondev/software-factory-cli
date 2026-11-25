import { getFreshIdToken, signOut } from '@readysetcloud/ui/auth';

/**
 * Fetch for the Updraft API.
 *
 * - Paths are relative to `/api/v1` and stay same-origin: CloudFront routes `/api/*` to API
 *   Gateway in the cloud, and Vite proxies it locally.
 * - Every request carries `Authorization: Bearer <ID token>`, which API Gateway's Cognito
 *   authorizer verifies (the same header form rsc-core's own clients send).
 * - A 401 means the API refused the session, so it is dropped and the app returns to sign-in.
 */

export const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  /** A message the server meant for people (flow errors carry one), or a generic one. */
  constructor(status: number, code: string, message?: string) {
    super(message ?? `API request failed (${status} ${code})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  getToken: () => Promise<string | null>;
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

export interface TenantSummary {
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: 'active' | 'disabled';
  disabledReason?: 'suspended' | 'uninstalled' | 'admin';
  role: 'owner' | 'editor';
}

export interface GitHubStatus {
  configured: boolean;
  appSlug?: string;
  linked: { githubLogin: string; githubUserId: number } | null;
  tenants: TenantSummary[];
}

export interface Repository {
  id: number;
  fullName: string;
  private: boolean;
  htmlUrl: string;
}

export interface CallbackInput {
  code?: string;
  state?: string;
  installationId?: string;
  setupAction?: string;
}

export interface ConnectableInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  connected: boolean;
}

export type CallbackResult =
  | { kind: 'linked'; githubLogin: string; installations: ConnectableInstallation[] }
  | { kind: 'installed'; githubLogin: string; installationId: number; accountLogin: string }
  | { kind: 'requested'; githubLogin: string };

export interface Me {
  sub: string;
  email?: string;
  name?: string;
  /** May use the admin view (the server's allow-list). */
  admin?: boolean;
}

// The admin view (server/src/admin/admin.ts).

export interface Quotas {
  concurrentJobs: number;
  jobsPerDay: number;
  microvmMinutesPerMonth: number;
  platformConcurrentJobs: number;
}

export type TenantLimits = Partial<Pick<Quotas, 'concurrentJobs' | 'jobsPerDay' | 'microvmMinutesPerMonth'>>;

export interface Usage {
  day: string;
  jobsToday: number;
  month: string;
  jobsThisMonth: number;
  microvmSecondsThisMonth: number;
  throttledThisMonth: number;
  failedThisMonth: number;
}

export interface AdminTenant {
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: 'active' | 'disabled';
  disabledReason?: 'suspended' | 'uninstalled' | 'admin';
  adminDisabled?: { at: string; by: string; reason?: string };
  activeConfigVersion?: number;
  createdAt: string;
  quotas: Quotas;
  limits?: TenantLimits;
  defaults: Quotas;
  usage: Usage;
}

export interface JobSummary {
  jobId: string;
  repository: string;
  issue?: number;
  /** The pull request whose event started it (its review loop). */
  pullRequest?: number;
  label?: string;
  sender?: string;
  createdAt: string;
  status: 'launched' | 'finished';
  outcome?: string;
}

export interface AdminActiveJob {
  jobId: string;
  phase: 'reserved' | 'launching';
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

export interface AdminOverview {
  tenants: AdminTenant[];
  platform: { activeJobs: number; platformConcurrentJobs: number };
}

// A tenant's agent keys (server/src/tenants/agent-key-service.ts). Values are write-only.

export interface AgentKeyView {
  name: string;
  configured: boolean;
  /** The active config runs an agent that needs it. */
  required: boolean;
  lastRotatedAt?: string;
  lastRotatedBy?: string;
  lastUsed?: { at: string; ok: boolean };
}

/** Public metadata only: routine trigger tokens are never returned. */
export interface RoutineRule {
  id: string;
  repositoryId: number;
  repository: string;
  label: string;
  url: string;
  updatedAt: string;
  updatedBy: string;
  allowedActors: string[];
}
export interface RoutinesView { rules: RoutineRule[]; }

export interface AgentKeysView {
  keys: AgentKeyView[];
  refusals: { at: string; deliveryId: string; repository: string; issue: number; reason: string }[];
}

// Native Claude subscription mode never exposes Claude CLI credentials.
export interface NativeClaudeTrigger {
  repositoryId: number;
  repository: string;
  label: string;
}

export interface NativeClaudeLoginGrant {
  generation?: string;
  expiresAt?: string;
  url: string;
  token: string;
  port: number;
}

export interface ClaudeWaitingRequest {
  status: 'waiting' | 'started' | 'canceled' | 'expired';
  expiresAt: string;
  jobId?: string;
  reason?: string;
}

export interface NativeClaudeView {
  /** A reserved session is booting; readiness still requires its live heartbeat. */
  preparing?: boolean;
  startupFailed?: boolean;
  retired?: boolean;
  retirementReason?: string;
  idleExpiresAt?: string;
  connectionPolicy?: { maxSessionSeconds: number; idleSeconds: number; concurrentSessions: number; tenantDailySeconds: number; platformDailySeconds: number; tenantLaunchesPerDay: number; platformLaunchesPerDay: number };
  sessionExpiresAt?: string;
  recovery?: { state: 'required' | 'stopping' | 'stopped' };
  managed?: boolean;
  /** The worker runs an older image than the deployed one and must be restarted. */
  upgrade?: { from: string; to: string; state: 'required' | 'stopping' | 'stopped'; reason?: string };
  upgradeBlocked?: boolean;
  updateAvailable?: { from: string; to: string; state: 'required' | 'stopping' | 'stopped'; reason?: string };
  /** A GitHub job waiting for a signed-in worker, which a new worker can be started for. */
  pendingRequest?: string;
  /** The caller owns the installation: only owners restart the worker or sign in. */
  owner?: boolean;
  browserLogin?: boolean;
  triggers?: NativeClaudeTrigger[];
  availableTriggers?: NativeClaudeTrigger[];
  configured: boolean;
  enabled: boolean;
  repository?: string;
  labels?: string[];
  worker: null | {
    status: 'connected' | 'auth-required' | 'expired' | 'unavailable' | 'offline';
    online: boolean;
    busy: boolean;
    lastHeartbeatAt: string;
    workerVersion: string;
    generation?: string;
  };
}

// A tenant's status and diagnostics (server/src/tenants/status-service.ts).

export type InstallationStatus = 'active' | 'suspended' | 'missing_permissions' | 'disabled' | 'uninstalled';
export type DeliveryDisposition = 'filtered' | 'deduped' | 'coalesced' | 'throttled' | 'launch_failed' | 'launched' | 'routine_triggered' | 'routine_failed' | 'routine_unknown';
export type JobResult =
  | 'running'
  | 'success'
  | 'nothing_to_do'
  | 'canceled'
  | 'superseded'
  | 'deferred'
  | 'agent_failure'
  | 'verify_failure'
  | 'publish_failure'
  | 'timeout'
  | 'state_not_saved'
  | 'terminated'
  | 'runner_error'
  | 'unconfirmed'
  | 'not_run'
  | 'other';

export interface Delivery {
  at: string;
  deliveryId: string;
  event: string;
  action?: string;
  repository?: string;
  issue?: number;
  pullRequest?: number;
  label?: string;
  sender?: string;
  disposition: DeliveryDisposition;
  reason?: string;
  message?: string;
  errorClass?: string;
  jobId?: string;
}

/** An issue's whole story across jobs (#139): what Updraft recorded, never agent text. */
export type WorkflowStatus = 'active' | 'waiting' | 'blocked' | 'finished';

export interface WorkflowView {
  workflowId: string;
  repository: string;
  repositoryId: number;
  issue?: number;
  pullRequest?: number;
  prUrl?: string;
  generation: number;
  status: WorkflowStatus;
  stage: string;
  reason?: string;
  message?: string;
  nextAction?: string;
  lastJobId?: string;
  nextCheckAt?: string;
  waitingSince?: string;
  /** Pull requests of earlier runs, and the run each belongs to. */
  pastPullRequests?: { number: number; generation: number }[];
  createdAt: string;
  updatedAt: string;
  /** Rebuilt from job records (jobs from before workflows were recorded): read only, with what it cannot know. */
  reconstructed?: true;
  gaps?: string[];
}

/** A stop's pause of a workflow: it lasts until an owner resumes it. */
export interface WorkflowPause {
  jobId: string;
  at: number;
  by: string;
  reason?: string;
  subjects?: number[];
  confirmedAt?: number;
  /** The issue or pull request number the pause was found on: what resuming it names. */
  subject: number;
  canResume: boolean;
}

export interface WorkflowTotals {
  jobs: number;
  retries: number;
  reviews: number;
  revisions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  stepsWithoutCost: number;
  subscription: boolean;
  activeSeconds: number;
  wallSeconds: number;
  running: boolean;
}

export interface WorkflowEvent {
  id: string;
  at: string;
  kind: 'job_started' | 'job_finished' | 'ci_checked' | 'blocked' | 'finished' | 'waiting' | 'label_missed' | 'finish_recovered';
  generation: number;
  jobId?: string;
  eventName?: string;
  retry?: boolean;
  outcome?: string;
  stage?: string;
  prNumber?: number;
  prUrl?: string;
  steps?: { kind: string; agent?: string; outcome?: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number } }[];
  subscription?: boolean;
  loop?: { rounds: number; maxRevisions?: number; reviews: number; verdict?: 'ready-to-merge' | 'changes-requested' };
  headSha?: string;
  message?: string;
}

export interface JobView {
  canStop?: boolean;
  stop?: { requestedAt: number; by: string; reason: string; confirmedAt?: number; error?: string; reconnectRequired?: boolean; resumedAt?: number; resumedBy?: string };
  canResume?: boolean;
  executionMode?: 'subscription' | 'standard';
  jobId: string;
  repository: string;
  issue?: number;
  /** The pull request whose event started it (its review loop). */
  pullRequest?: number;
  label?: string;
  sender?: string;
  createdAt: string;
  status: 'launched' | 'finished';
  outcome?: string;
  configVersion?: number;
  finishedAt?: string;
  durationSeconds?: number;
  deliveryId?: string;
  result: JobResult;
  issueUrl?: string;
  prUrl?: string;
  logs: string[];
  /** The job ended without finishing its work, and the console can run it again. */
  retryable?: boolean;
  benchmark?: { runId: string; caseId: string; arm: string };
  /** The job a retry started for this one. */
  retriedAs?: string;
  /** What the runner reported at the finish (as the broker checked it). */
  detail?: JobDetail;
  /** Its agents' trace in the installation's tracing tool, when telemetry was on. */
  telemetry?: JobTelemetry;
  /** The installation's telemetry setting now; apart from what this job exported. Absent from an older server. */
  telemetryStatus?: 'not_configured' | 'paused' | 'enabled' | 'unknown';
}

export interface JobTelemetry {
  traceId: string;
  traceUrl?: string;
  conversationId?: string;
  /** Where the traces went, by name (Honeycomb, or the host of a custom OTLP endpoint). */
  destination?: string;
  /** The conversation's spans, in the destination's own search. */
  conversationUrl?: string;
  /** What to do there, when it takes a step (Honeycomb: select the id to open Agent Timeline). */
  conversationHint?: string;
  /** The conversation in the destination's conversation view itself, when the deployment knows how to link to it. */
  timelineUrl?: string;
  /** That link's words (Honeycomb: "Open in Agent Timeline"). */
  timelineLabel?: string;
  /** The job's moments, in order, each where it was in the job; with a link to its span when it was sent. */
  timeline?: JobTimelineEntry[];
  /** What the job's runs added up to. */
  totals?: JobTotals;
  /** Nothing was sent (no destination): the timeline and totals are the runner's own reading. */
  local?: boolean;
  spans: number;
  exported: number;
  failed: number;
  lastError?: string;
}

export interface JobTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  toolCalls: number;
  toolErrors: number;
  thrashing: boolean;
  durationMs: number;
}

export type JobTimelineKind = 'agent' | 'test_failed' | 'test_green' | 'verify_failed' | 'step_failed';
export interface JobTimelineEntry {
  kind: JobTimelineKind;
  /** The trace opened at this span, when it was sent and the destination has links. */
  url?: string;
  offsetMs?: number;
  durationMs?: number;
  /** implement, review, revision */
  run?: string;
  agent?: string;
  failed?: boolean;
  thrashing?: boolean;
  verdict?: string;
  step?: string;
}

export type TelemetryRegion = 'us' | 'eu';
export type TelemetryProvider = 'honeycomb' | 'cloudwatch' | 'otlp';
/** The destination and its key, saved together: a custom endpoint never changes without its key. */
export type TelemetryKeyInput =
  /** `auto`: the region is found from the key (the US, then the EU). */
  | { provider?: 'honeycomb'; value: string; region: TelemetryRegion | 'auto' }
  | { provider: 'cloudwatch'; value: string; awsRegion: string }
  | { provider: 'otlp'; value: string; endpoint: string; header: string };
export interface TelemetryLinks {
  trace?: string;
  conversation?: string;
}
export interface TelemetryView {
  provider: TelemetryProvider;
  enabled: boolean;
  /** A custom destination: where it sends and the header the key goes in (never the key). */
  otlp?: { endpoint: string; header: string; host: string };
  /** CloudWatch: the AWS region it sends to. */
  aws?: { region: string };
  /** A custom destination's link templates. */
  links?: TelemetryLinks;
  region: TelemetryRegion;
  serviceName: string;
  captureContent: boolean;
  keyConfigured: boolean;
  key?: { updatedAt: string; updatedBy: string; type?: string; team?: { name: string; slug: string }; environment?: { name: string; slug: string } };
  lastExport?: { at: string; jobId: string; traceId?: string; traceUrl?: string; spans: number; exported: number; failed: number; lastError?: string };
  environmentUrl?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export type StepKind = 'implement' | 'revision' | 'review';
export type LoopStage =
  | 'awaiting-review'
  | 'reviewing'
  | 'changes-requested'
  | 'revising'
  | 'waiting-for-ci'
  | 'fixing-ci'
  | 'ready-to-merge'
  | 'merging'
  | 'merged'
  | 'needs-human'
  | 'closed';

export interface JobDetail {
  updraftOutcome?: string;
  verificationPassed?: boolean;
  prNumber?: number;
  /** Where the review loop left the pull request. */
  loop?: { rounds: number; maxRevisions?: number; reviews: number; verdict?: 'ready-to-merge' | 'changes-requested'; stage?: LoopStage; merged?: boolean };
  /** Each step of the run, in order: the job itself, then reviews and revisions. */
  steps?: Array<{ kind: StepKind; agent?: string; model?: string; effort?: string; outcome?: string; verificationPassed?: boolean; publication?: string }>;
}

/**
 * Insights: `updraft stats --json` over the tenant's shared state (docs/stats.md). Only the
 * fields the console reads are typed here.
 */
export type InsightsWindow = '24h' | '7d' | '30d' | '90d' | 'all';

export interface Distribution {
  count: number;
  averageMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
}
export interface CoveredDistribution extends Distribution {
  total: number;
}
export interface KindCounts {
  implement: number;
  revision: number;
  review: number;
  unknown: number;
  total: number;
}
export interface Rate {
  count: number;
  of: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}
export interface CodingModelStats {
  jobs: number;
  smallSample: boolean;
  success: Rate;
  escalatedIn: { jobs: number; succeeded: number };
  escalatedOut: number;
  retries: number;
  verificationFailures: number;
  prsOpened: number;
  reviewed: number;
  reviewReady: Rate;
  changesRequested: number;
  revisions: { average: number | null; total: number };
  labelToPr: CoveredDistribution;
  queueWait: Distribution;
  adapter?: string | null;
  model?: string | null;
  effort?: string | null;
  modelSource?: 'configured' | 'observed' | 'unknown';
}
export interface ReviewModelStats {
  adapter: string | null;
  model: string | null;
  effort: string | null;
  runs: number;
  readyToMerge: number;
  changesRequested: number;
  failed: number;
  findings: { total: number; withCount: number; average: number | null };
}
export interface DailyStats {
  day: string;
  jobsSucceeded: number;
  jobsFailed: number;
  prsOpened: number;
  prsMerged: number;
  reviews: number;
  changesRequested: number;
  findings: number;
  revisions: number;
}
export interface StatsSection {
  work: {
    finished: { succeeded: KindCounts; failed: KindCounts; interrupted: KindCounts; canceled: KindCounts; total: KindCounts };
    current: { queued: KindCounts; running: KindCounts };
  };
  time: {
    agentRun: { all: CoveredDistribution; byKind: Record<StepKind, CoveredDistribution>; byAgent: Record<string, CoveredDistribution> };
    queueWait: { all: Distribution };
    labelToPr: CoveredDistribution;
    prToMerge: CoveredDistribution;
  };
  outcomes: {
    prsOpened: number;
    prsMerged: number;
    mergeBlocked: { heads: number; prs: number; reasons: Array<{ code: string; count: number }> };
    runs: Record<string, number> & { total: number };
    failedRuns: { total: number; verifyFailed: number };
  };
  review: {
    reviewerRuns: { total: number; readyToMerge: number; changesRequested: number; failed: number; other: number };
    changesRequestedRounds: { reviewer: number; people: number; reviewerQueued: number; peopleQueued: number };
    findings: { changesRequestedReviews: number; withCount: number; withoutCount: number; total: number; average: number | null; allReviewsWithoutCount: number };
    firstPass: { prs: number; readyToMerge: number; rate: number | null };
    /** Absent in a report from before reviewer models were reported. */
    byModel?: Record<string, ReviewModelStats>;
  };
  backAndForth: {
    prs: number;
    revisionsPerPr: { average: number | null; max: number | null; distribution: { '0': number; '1': number; '2': number; '3+': number } };
    reviewsPerPr: { average: number | null; max: number | null };
    limitReached: number;
  };
  routing: { minSample: number; byModel: Record<string, CodingModelStats>; byProfile: Record<string, CodingModelStats> };
  pressure: { cooldowns: { count: number; totalMs: number }; deferrals: { count: number }; unavailable: { startFailedRuns: number } };
  /** Absent in a report from before the daily series. */
  daily?: DailyStats[];
}
export interface StatsReport {
  version: number;
  generatedAt: string;
  window: { label: string; since: string | null; until: string };
  repo: string | null;
  database: boolean;
  facts: { total: number; backfilled: number };
  overall: StatsSection;
  byRepo: Array<{ repo: string; repoId: number; stats: StatsSection }>;
}
export interface Insights {
  window: InsightsWindow;
  hasState: boolean;
  stateUpdatedAt?: string;
  report: StatsReport;
}

/** Repository readiness (#137): server/src/tenants/readiness-service.ts. */
export type ReadinessCheckState = 'verified' | 'failing' | 'unverified' | 'off';
export type ReadinessProblem = 'invalid_config' | 'missing_credentials' | 'permissions' | 'reconnect' | 'transient' | 'paused' | 'provider';
export type ReadinessFixTarget = 'config' | 'keys' | 'claude' | 'telemetry' | 'workflows' | 'job' | 'github';
export interface ReadinessCheck {
  id: string;
  stage: 'installation' | 'config' | 'github' | 'credentials' | 'subscription' | 'review' | 'ci' | 'capacity' | 'pauses' | 'telemetry' | 'egress' | 'execution';
  required: boolean;
  state: ReadinessCheckState;
  problem?: ReadinessProblem;
  unverified?: 'read_failed' | 'not_checked' | 'needs_run';
  summary: string;
  fix?: { text: string; target: ReadinessFixTarget };
}
export type RepositoryReadinessStatus = 'ready' | 'action_needed' | 'temporarily_unavailable' | 'paused' | 'unknown' | 'not_configured';
export interface RepositoryReadiness {
  repository: string;
  repositoryId?: number;
  status: RepositoryReadinessStatus;
  checks: ReadinessCheck[];
  lastJob?: { jobId: string; result: JobResult; at: string; configVersion?: number };
}
export interface ReadinessReport {
  checkedAt: string;
  cached: boolean;
  configVersion: number | null;
  installation: ReadinessCheck[];
  repositories: RepositoryReadiness[];
  limitations: string[];
}

export interface Overview {
  tenant: TenantSummary;
  installation: { status: InstallationStatus; checked: boolean; missingPermissions: { name: string; needs: string; granted?: string }[] };
  repositories: { fullName: string; htmlUrl?: string; private?: boolean; reachable: boolean; configured: boolean; paused: boolean }[];
  config: { activeVersion: number | null; publishedAt?: string; publishedBy?: string; triggers?: { repository: string; label: string }[];
    /** Configured repositories GitHub now has under another id: publish again for them. */
    replaced?: string[];
    /** Agents the viewer's labels run that the deployment no longer runs. */
    retiredAgents?: string[];
  };
  keys: AgentKeyView[];
  /** Whether traces are set up to go somewhere, and are on. Absent from an older API. */
  telemetry?: { configured: boolean; enabled: boolean };
  activity: {
    /** Counts over 30 days, or of the latest entries when a list is not complete. */
    window: { deliveries: number; deliveriesComplete: boolean; jobs: number; jobsComplete: boolean };
    deliveries: Partial<Record<DeliveryDisposition, number>>;
    jobs: Partial<Record<JobResult, number>>;
    lastDeliveryAt?: string;
    /** When the first job ever started (kept for good). */
    firstJobAt?: string;
    running: number;
  };
}

export interface JobLog {
  name: string;
  text: string;
  size: number;
  truncated: boolean;
}

// A tenant's configuration (server/src/tenants/console.ts and config-service.ts).

export type AgentAdapter = 'claude' | 'codex' | 'kiro' | 'vibe';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface ConsoleAgent {
  adapter: AgentAdapter;
  model?: string;
  effort?: string;
  /** false: never chosen, and its key is not needed. */
  enabled: boolean;
}

export interface ConsolePool {
  /** Roster agent names, taken in turn. */
  agents: string[];
}

export interface ConsoleWorkflow {
  /** The issue label that starts it. */
  label: string;
  /** The pool that does the work. */
  pool: string;
  prompt: string;
  timeoutMinutes?: number;
  review: { enabled: boolean; pool: string; prompt: string; allowSameAgent: boolean };
  revise: { enabled: boolean; prompt: string; maxRevisions?: number };
}

export interface ConsoleRepository {
  /** false: paused. */
  enabled: boolean;
  workflows: string[];
  /** Absent: the installation's list. */
  allowedActors?: string[];
  baseBranch?: string;
  publish: 'draft-pr' | 'pr';
  commentOnFailure: boolean;
  verify: string[];
  verifyTimeoutMinutes?: number;
  /** Absent: off. */
  autoMerge?: { method: MergeMethod; waitMinutes?: number; requiredChecks?: string[] };
  /** Absent: off. CI is part of the review loop: a failing check on a head the reviewer found ready queues a fix. */
  ci?: { checks?: string[]; ignore?: string[]; waitMinutes?: number };
}

export interface ConsoleConfig {
  version: 2;
  agents: Record<string, ConsoleAgent>;
  pools: Record<string, ConsolePool>;
  allowedActors: string[];
  workflows: Record<string, ConsoleWorkflow>;
  repositories: Record<string, ConsoleRepository>;
  /** Settings upgraded from the first console: names kept for work in flight. The editor passes it on unchanged. */
  legacy?: { pools: Record<string, string>; workflows: Record<string, string> };
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigView {
  tenant: TenantSummary;
  githubLogin: string;
  repositories: Repository[];
  agentKeys: Record<string, boolean>;
  /** The agents this deployment runs: what the editor offers. Absent from an older API: Claude and Codex. */
  agents?: AgentAdapter[];
  activeVersion: number | null;
  source: 'console' | 'tenant' | 'none';
  config: ConsoleConfig;
  /** What upgrading the active version's settings could not keep as it was. Absent from an older API. */
  notices?: string[];
  defaults: { prompts: { implement: string; review: string; revise: string } };
  limits: {
    ceilings: { timeoutMinutes: number; verifyTimeoutMinutes: number; autoMergeWaitMinutes: number; maxRevisions: number; /** Absent from an older API. */ ciWaitMinutes?: number };
    console: Record<string, number>;
  };
}

export type PreviewResult =
  | { ok: true; yaml: string; warnings: ConfigIssue[]; autoMergeTurnedOn: string[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

export interface PublishResult {
  ok: true;
  version: number;
  yaml: string;
  warnings: ConfigIssue[];
}

export interface VersionSummary {
  version: number;
  status: 'pending' | 'ready';
  publishedAt: string;
  publishedBy: string;
  sha256: string;
  active: boolean;
  copiedFrom?: number;
}

export interface VersionFiles {
  version: VersionSummary;
  /** config.yaml and prompts/<name>.md, as jobs see them. */
  files: Record<string, string>;
}

/** A publish the server refused as invalid: every problem, with the field it is about. */
export class ConfigInvalidError extends ApiError {
  readonly errors: ConfigIssue[];
  readonly warnings: ConfigIssue[];
  constructor(errors: ConfigIssue[], warnings: ConfigIssue[]) {
    super(400, 'invalid_config', 'The configuration has problems; nothing was published');
    this.name = 'ConfigInvalidError';
    this.errors = errors;
    this.warnings = warnings;
  }
}

export function createApiClient({ getToken, onUnauthorized, fetch: fetchImpl = (...a) => fetch(...a) }: ApiClientOptions) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getToken();
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const response = await fetchImpl(`${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`, { ...init, headers });
    if (response.status === 401) onUnauthorized?.();
    if (!response.ok) {
      let code = 'error';
      let message: string | undefined;
      let issues: { errors: ConfigIssue[]; warnings: ConfigIssue[] } | null = null;
      try {
        const body = (await response.json()) as { error?: unknown; message?: unknown; errors?: unknown; warnings?: unknown };
        if (typeof body.error === 'string') code = body.error;
        if (typeof body.message === 'string') message = body.message;
        if (code === 'invalid_config' && Array.isArray(body.errors)) {
          issues = { errors: body.errors as ConfigIssue[], warnings: Array.isArray(body.warnings) ? (body.warnings as ConfigIssue[]) : [] };
        }
      } catch {
        // Not JSON (an API Gateway or CloudFront error page): keep the generic code.
      }
      if (issues) throw new ConfigInvalidError(issues.errors, issues.warnings);
      throw new ApiError(response.status, code, message);
    }
    return (await response.json()) as T;
  }

  return {
    request,
    me: () => request<Me>('/me'),
    githubStatus: () => request<GitHubStatus>('/github'),
    startLink: () => request<{ url: string }>('/github/link', { method: 'POST' }),
    unlink: () => request<{ ok: true }>('/github/link', { method: 'DELETE' }),
    startInstall: () => request<{ url: string }>('/github/install', { method: 'POST' }),
    completeCallback: (input: CallbackInput) =>
      request<CallbackResult>('/github/callback', { method: 'POST', body: JSON.stringify(input) }),
    connect: (installationId: number) =>
      request<{ installationId: number; accountLogin: string }>(`/github/connect/${installationId}`, { method: 'POST' }),
    repositories: (installationId: number) =>
      request<{ tenant: TenantSummary; repositories: Repository[] }>(`/installations/${installationId}/repositories`),
    config: (installationId: number) => request<ConfigView>(`/installations/${installationId}/config`),
    previewConfig: (installationId: number, config: ConsoleConfig) =>
      request<PreviewResult>(`/installations/${installationId}/config/preview`, { method: 'POST', body: JSON.stringify({ config }) }),
    /** Throws ConfigInvalidError (400), or ApiError `config_changed` / `auto_merge_unconfirmed` (409). */
    publishConfig: (installationId: number, input: { config: ConsoleConfig; baseVersion: number | null; confirmAutoMerge?: boolean }) =>
      request<PublishResult>(`/installations/${installationId}/config/publish`, { method: 'POST', body: JSON.stringify(input) }),
    configVersions: (installationId: number) =>
      request<{ activeVersion: number | null; versions: VersionSummary[] }>(`/installations/${installationId}/config/versions`),
    configVersion: (installationId: number, version: number) => request<VersionFiles>(`/installations/${installationId}/config/versions/${version}`),
    reactivateConfig: (installationId: number, version: number, input: { confirmAutoMerge?: boolean } = {}) =>
      request<PublishResult>(`/installations/${installationId}/config/versions/${version}/reactivate`, { method: 'POST', body: JSON.stringify(input) }),
    overview: (installationId: number) => request<Overview>(`/installations/${installationId}/overview`),
    /** Per-repository preflight; `refresh` reads again rather than serving the last check (bounded by the server). */
    readiness: (installationId: number, refresh = false) => request<ReadinessReport>(`/installations/${installationId}/readiness${refresh ? '?refresh=1' : ''}`),
    insights: (installationId: number, query: { window?: InsightsWindow; repo?: string } = {}) => {
      const q = new URLSearchParams();
      if (query.window) q.set('window', query.window);
      if (query.repo) q.set('repo', query.repo);
      const qs = q.toString();
      return request<Insights>(`/installations/${installationId}/insights${qs ? `?${qs}` : ''}`);
    },
    deliveries: (installationId: number, limit = 100) => request<{ deliveries: Delivery[] }>(`/installations/${installationId}/deliveries?limit=${limit}`),
    jobs: (installationId: number, limit = 100) => request<{ jobs: JobView[] }>(`/installations/${installationId}/jobs?limit=${limit}`),
    job: (installationId: number, jobId: string) => request<{ job: JobView; deliveries: Delivery[]; conversation?: JobView[] }>(`/installations/${installationId}/jobs/${encodeURIComponent(jobId)}`),
    workflows: (installationId: number, limit = 100) => request<{ workflows: WorkflowView[] }>(`/installations/${installationId}/workflows?limit=${limit}`),
    workflow: (installationId: number, workflowId: string) =>
      request<{ workflow: WorkflowView; events: WorkflowEvent[]; totals?: WorkflowTotals; pause?: WorkflowPause }>(`/installations/${installationId}/workflows/${encodeURIComponent(workflowId)}`),
    /** Lift exactly this pause (the one shown), even after the stopped job's records expired; a newer stop answers 409. */
    resumeWorkflow: (installationId: number, workflowId: string, pause: Pick<WorkflowPause, 'jobId' | 'at' | 'subject'>) =>
      request<{ resumed: true }>(`/installations/${installationId}/workflows/${encodeURIComponent(workflowId)}/resume`, { method: 'POST', body: JSON.stringify({ jobId: pause.jobId, at: pause.at, subject: pause.subject }) }),
    /** The workflow a job belongs to; null when none was recorded (a job from before workflows). */
    jobWorkflow: (installationId: number, jobId: string) => request<{ workflowId: string | null }>(`/installations/${installationId}/jobs/${encodeURIComponent(jobId)}/workflow`),
    /** Runs a job that did not finish its work again, as a new job (its id). Throws ApiError: `not_retryable`, `already_retried`, `throttled`, `event_gone`, ... (409, 410, 429). */
    retryJob: (installationId: number, jobId: string) =>
      request<{ jobId: string }>(`/installations/${installationId}/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }),
    stopJob: (installationId: number, jobId: string, reason = 'Stopped from the console') =>
      request<{ jobId: string; state: 'stopping' | 'canceled' | 'finished' }>(`/installations/${installationId}/jobs/${encodeURIComponent(jobId)}/stop`, { method: 'POST', body: JSON.stringify({ reason }) }),
    resumeJob: (installationId: number, jobId: string) => request<{ resumed: true }>(`/installations/${installationId}/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST' }),
    /** The end of a log; throws ApiError `log_expired` (410) once it is past the retention. */
    jobLog: (installationId: number, jobId: string, name: string) =>
      request<JobLog>(`/installations/${installationId}/jobs/${encodeURIComponent(jobId)}/logs/${encodeURIComponent(name)}`),
    telemetry: (installationId: number) => request<TelemetryView>(`/installations/${installationId}/telemetry`),
    updateTelemetry: (installationId: number, input: { enabled?: boolean; serviceName?: string; captureContent?: boolean; links?: TelemetryLinks }) =>
      request<TelemetryView>(`/installations/${installationId}/telemetry`, { method: 'PUT', body: JSON.stringify(input) }),
    /** The key is sent once and never comes back. */
    setTelemetryKey: (installationId: number, input: TelemetryKeyInput) =>
      request<TelemetryView>(`/installations/${installationId}/telemetry/key`, { method: 'PUT', body: JSON.stringify(input) }),
    removeTelemetryKey: (installationId: number) => request<TelemetryView>(`/installations/${installationId}/telemetry/key`, { method: 'DELETE' }),
    routines: (installationId: number) => request<RoutinesView>(`/installations/${installationId}/routines`),
    setRoutine: (installationId: number, input: { repositoryId: number; label: string; url: string; token: string; allowedActors?: string[] }) =>
      request<RoutinesView>(`/installations/${installationId}/routines`, { method: 'PUT', body: JSON.stringify(input) }),
    removeRoutine: (installationId: number, ruleId: string) =>
      request<RoutinesView>(`/installations/${installationId}/routines/${encodeURIComponent(ruleId)}`, { method: 'DELETE' }),
    nativeClaudeWaiting: (installationId: number, id: string, signal?: AbortSignal) =>
      request<ClaudeWaitingRequest>(`/installations/${installationId}/claude-subscription/requests/${encodeURIComponent(id)}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }),
    nativeClaudeStart: (installationId: number, id?: string) =>
      request<NativeClaudeView>(id ? `/installations/${installationId}/claude-subscription/requests/${encodeURIComponent(id)}/start` : `/installations/${installationId}/claude-subscription/connect`, { method: 'POST', signal: AbortSignal.timeout(30000) }),
    nativeClaudeRestart: (installationId: number) =>
      request<NativeClaudeView>(`/installations/${installationId}/claude-subscription/restart`, { method: 'POST', signal: AbortSignal.timeout(30000) }),
    nativeClaudeLogin: (installationId: number, signal?: AbortSignal) =>
      request<NativeClaudeLoginGrant>(`/installations/${installationId}/claude-subscription/login`, { method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }),
    nativeClaude: (installationId: number, signal?: AbortSignal) => request<NativeClaudeView>('/installations/' + installationId + '/claude-subscription', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }),
    setNativeClaudeMode: (installationId: number, enabled: boolean, triggers?: NativeClaudeTrigger[]) =>
      request<NativeClaudeView>('/installations/' + installationId + '/claude-subscription', { method: 'PUT', body: JSON.stringify({ enabled, triggers }) }),
    agentKeys: (installationId: number) => request<AgentKeysView>(`/installations/${installationId}/agent-keys`),
    /** The key is sent once and never comes back. */
    setAgentKey: (installationId: number, name: string, value: string) =>
      request<AgentKeysView>(`/installations/${installationId}/agent-keys/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
    adminTenants: () => request<AdminOverview>('/admin/tenants'),
    adminTenant: (installationId: number) => request<AdminTenantDetail>(`/admin/tenants/${installationId}`),
    adminDisable: (installationId: number, reason?: string) =>
      request<AdminTenantDetail>(`/admin/tenants/${installationId}/disable`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
    adminEnable: (installationId: number) => request<AdminTenantDetail>(`/admin/tenants/${installationId}/enable`, { method: 'POST', body: '{}' }),
    adminSetLimits: (installationId: number, limits: TenantLimits | null) =>
      request<AdminTenantDetail>(`/admin/tenants/${installationId}/limits`, { method: 'PUT', body: JSON.stringify({ limits }) }),
    adminReleaseJob: (jobId: string) => request<AdminTenantDetail>(`/admin/jobs/${encodeURIComponent(jobId)}/release`, { method: 'POST', body: '{}' }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api = createApiClient({
  getToken: async () => (await getFreshIdToken()) ?? null,
  onUnauthorized: () => void signOut(),
});
