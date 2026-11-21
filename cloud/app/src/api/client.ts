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

export interface AgentKeysView {
  keys: AgentKeyView[];
  refusals: { at: string; deliveryId: string; repository: string; issue: number; reason: string }[];
}

// A tenant's status and diagnostics (server/src/tenants/status-service.ts).

export type InstallationStatus = 'active' | 'suspended' | 'missing_permissions' | 'disabled' | 'uninstalled';
export type DeliveryDisposition = 'filtered' | 'deduped' | 'coalesced' | 'throttled' | 'launch_failed' | 'launched';
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
  label?: string;
  sender?: string;
  disposition: DeliveryDisposition;
  reason?: string;
  message?: string;
  errorClass?: string;
  jobId?: string;
}

export interface JobView {
  jobId: string;
  repository: string;
  issue?: number;
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
}

export interface Overview {
  tenant: TenantSummary;
  installation: { status: InstallationStatus; checked: boolean; missingPermissions: { name: string; needs: string; granted?: string }[] };
  repositories: { fullName: string; htmlUrl?: string; private?: boolean; reachable: boolean; configured: boolean; paused: boolean }[];
  config: { activeVersion: number | null; publishedAt?: string; publishedBy?: string };
  keys: AgentKeyView[];
  activity: {
    /** Counts over 30 days, or of the latest entries when a list is not complete. */
    window: { deliveries: number; deliveriesComplete: boolean; jobs: number; jobsComplete: boolean };
    deliveries: Partial<Record<DeliveryDisposition, number>>;
    jobs: Partial<Record<JobResult, number>>;
    lastDeliveryAt?: string;
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

export type AgentAdapter = 'claude' | 'codex';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface ConsoleAgent {
  adapter: AgentAdapter;
  model?: string;
  effort?: string;
}

export interface ConsoleWorkflow {
  agent: ConsoleAgent;
  prompt: string;
  reviewer: ConsoleAgent & { prompt: string };
  revisePrompt: string;
  verify: string[];
  timeoutMinutes?: number;
  verifyTimeoutMinutes?: number;
}

export interface ConsoleTrigger {
  label: string;
  workflow: string;
}

export interface ConsoleRepository {
  /** false: paused. */
  enabled: boolean;
  triggers: ConsoleTrigger[];
  allowedActors: string[];
  baseBranch?: string;
  publish: 'draft-pr' | 'pr';
  commentOnFailure: boolean;
  review: boolean;
  revise: boolean;
  maxRevisions?: number;
  /** Absent: off. */
  autoMerge?: { method: MergeMethod; waitMinutes?: number; requiredChecks?: string[] };
}

export interface ConsoleConfig {
  version: 1;
  workflows: Record<string, ConsoleWorkflow>;
  repositories: Record<string, ConsoleRepository>;
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
  activeVersion: number | null;
  source: 'console' | 'tenant' | 'none';
  config: ConsoleConfig;
  defaults: { prompts: { implement: string; review: string; revise: string } };
  limits: {
    ceilings: { timeoutMinutes: number; verifyTimeoutMinutes: number; autoMergeWaitMinutes: number; maxRevisions: number };
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
    deliveries: (installationId: number, limit = 100) => request<{ deliveries: Delivery[] }>(`/installations/${installationId}/deliveries?limit=${limit}`),
    jobs: (installationId: number, limit = 100) => request<{ jobs: JobView[] }>(`/installations/${installationId}/jobs?limit=${limit}`),
    job: (installationId: number, jobId: string) => request<{ job: JobView; deliveries: Delivery[] }>(`/installations/${installationId}/jobs/${encodeURIComponent(jobId)}`),
    /** The end of a log; throws ApiError `log_expired` (410) once it is past the retention. */
    jobLog: (installationId: number, jobId: string, name: string) =>
      request<JobLog>(`/installations/${installationId}/jobs/${encodeURIComponent(jobId)}/logs/${encodeURIComponent(name)}`),
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
