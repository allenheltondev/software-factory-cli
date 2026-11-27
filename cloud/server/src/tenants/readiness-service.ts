import type { Caller } from '../caller.js';
import type { GitHubFlows } from '../flows/github.js';
import type { GitHubInstallation, GitHubRepository } from '../github/client.js';
import type { KillSwitch, KillSwitchState } from '../jobs/kill-switch.js';
import { readinessAction, type NativeLaunch, type NativeReadiness } from '../jobs/launch.js';
import { dayOf, monthOf, tenantQuotas } from '../jobs/quotas.js';
import { jobResult, type JobResult } from '../jobs/status.js';
import type { NativeProvider } from '../native/provider.js';
import { legacyNativeTriggers, sameNativeTrigger, type NativeTrigger } from '../native/route.js';
import { isWaiting, type QueueEntry, type QueueStore } from '../jobs/queue-store.js';
import type { ConfigVersion, DispatchRules, HeldPause, JobSummary, Quotas, Store, Tenant, TelemetrySettings, Usage } from '../store/store.js';
import type { AgentKeyService, AgentKeyView } from './agent-key-service.js';
import { AGENT_KEY_ENV } from './agents.js';
import { missingPermissions } from './status-service.js';

/**
 * Repository readiness (#137): before a labeled issue consumes compute, whether each configured
 * repository's published workflow has what it needs to run from pickup through review, CI repair
 * and publication, and what to fix when it does not.
 *
 * Every check is one of three things, never more than it knows:
 *
 *   verified    read just now (or, for an agent key, checked with its provider when it was saved)
 *   failing     read, and missing or wrong: with the problem's kind and what to do about it
 *   unverified  not read: the read failed or this deployment cannot make it (`unverified`), or
 *               only an actual run can show it (`needs_run`: package registry egress, a model
 *               answering). Nothing unverified is ever reported as healthy or as missing.
 *
 * Optional integrations (telemetry, Actions log access for CI fixes) never hold a repository up:
 * they are `required: false`, and `off` when they are simply not in use.
 *
 * Only cheap, bounded reads: the tenant's records, GitHub's installation and repository list, the
 * kill switch and image parameters, and the subscription workers' heartbeats (Claude's and
 * Codex's, each only when a trigger runs on it; a VM state read at most). Nothing here starts a worker, calls a model, or writes anything. Readiness is advisory:
 * the launcher decides again with current state at dispatch, and before every privileged step.
 */

export type CheckState = 'verified' | 'failing' | 'unverified' | 'off';
/** What kind of problem a failing check is: whether a person must act, or it passes by itself. */
export type CheckProblem =
  /** The published configuration is wrong or out of date: change it and publish. */
  | 'invalid_config'
  /** An agent key, or the subscription sign-in, is missing or expired. */
  | 'missing_credentials'
  /** GitHub does not grant the App what jobs need (permissions, events, repository access). */
  | 'permissions'
  /** The subscription environment can never serve again: an owner reconnects it. */
  | 'reconnect'
  /** A capacity limit or a bounded gap (startup, a heartbeat) that clears by itself. */
  | 'transient'
  /** Someone paused it on purpose: an owner, an admin, or the platform's operator. */
  | 'paused'
  /** The deployment itself cannot run jobs right now (no job image is published). */
  | 'provider';
/** Why a check is unverified: a read that failed or is not available here, or what only a run shows. */
export type Unverified = 'read_failed' | 'not_checked' | 'needs_run';
export type ReadinessStage = 'installation' | 'config' | 'github' | 'credentials' | 'subscription' | 'review' | 'ci' | 'capacity' | 'pauses' | 'telemetry' | 'egress' | 'execution';
/** Where a fix is made: a console page of the installation, or its settings on GitHub. */
/** `job`: the repository's `lastJob`. `claude`, `codex`: the page of that subscription (Codex's is the ChatGPT page). */
export type FixTarget = 'config' | 'keys' | 'claude' | 'codex' | 'telemetry' | 'workflows' | 'job' | 'github';

export interface ReadinessCheck {
  id: string;
  stage: ReadinessStage;
  /** Mandatory for a job to run. An optional one never changes a repository's status. */
  required: boolean;
  state: CheckState;
  problem?: CheckProblem;
  unverified?: Unverified;
  summary: string;
  fix?: { text: string; target: FixTarget };
  /** A subscription check's provider when it is not Claude's (absent: Claude, as before). */
  provider?: 'codex';
}

export type RepositoryStatus = 'ready' | 'action_needed' | 'temporarily_unavailable' | 'paused' | 'unknown' | 'not_configured';

export interface RepositoryReadiness {
  repository: string;
  repositoryId?: number;
  status: RepositoryStatus;
  /** This repository's own checks; the installation's apply to it too and are counted in `status`. */
  checks: ReadinessCheck[];
  /** The latest finished job of this repository among those kept: evidence, not a promise. */
  lastJob?: { jobId: string; result: JobResult; at: string; configVersion?: number };
}

export interface ReadinessReport {
  checkedAt: string;
  /** Served from the last check (at `checkedAt`) rather than read again just now. */
  cached: boolean;
  configVersion: number | null;
  /** The installation's own checks: they apply to every repository. */
  installation: ReadinessCheck[];
  repositories: RepositoryReadiness[];
  /** What readiness cannot tell, in words, whatever the checks say. */
  limitations: string[];
}

/** A subscription (native) binding as dispatch sees it for the installation. */
export interface NativeBinding {
  enabled: boolean;
  triggers: NativeTrigger[];
  /** The owner chose triggers (mode.triggers): then only triggers that need the Anthropic key are routed. */
  explicitTriggers: boolean;
  readiness(): Promise<NativeReadiness>;
  /**
   * Codex's route on an image that cannot run Codex (NativeLaunch.unavailable, #196): dispatch
   * still routes its triggers there and refuses them, never asking the worker's readiness.
   */
  unavailable?: string;
  /** The worker's image version, named when it cannot run this provider. */
  image?: string;
}

/**
 * A subscription binding exactly as the launcher reads it (jobs/launch.ts): the same mode, the same
 * enabled fallback and the same triggers. Claude's falls back to the pinned route's legacy triggers
 * and is on unless it says otherwise; Codex's has only the triggers its owner chose, and is off
 * unless it says it is on.
 */
export async function nativeBindingOf(launch: NativeLaunch, provider: NativeProvider = 'claude'): Promise<NativeBinding> {
  const mode = await launch.mode?.();
  const enabled = mode?.enabled ?? await launch.enabled?.() ?? provider === 'claude';
  const triggers = mode?.triggers ?? (provider === 'claude' ? legacyNativeTriggers(launch.route) : []);
  return {
    enabled, triggers, explicitTriggers: provider === 'codex' || mode?.triggers !== undefined,
    // A worker that reports no reason keeps dispatch's meaning of not ready: sign-in.
    readiness: launch.readiness ? () => launch.readiness!() : async () => (launch.ready ? (await launch.ready()) ? 'ready' : 'auth-required' : 'ready'),
    ...(launch.unavailable ? { unavailable: launch.unavailable, image: launch.route.imageVersion } : {}),
  };
}

export interface ReadinessServiceDeps {
  store: Pick<Store, 'getConfigVersion' | 'getUsage' | 'listRecentJobs' | 'listWorkflowPauses' | 'getTelemetry'>;
  github: Pick<GitHubFlows, 'member' | 'installation' | 'repositories'>;
  agentKeys: Pick<AgentKeyService, 'list'>;
  /** The stack's default quotas (jobs/quotas.ts quotasFromEnv); absent: capacity is not checked. */
  quotas?: Quotas;
  killSwitch?: KillSwitch;
  /** The published job image version; null while jobs are off. Absent: not checked here. */
  imageVersion?: () => Promise<string | null>;
  native?: (installationId: number) => Promise<NativeBinding | undefined>;
  /** The installation's Codex session (ChatGPT plan, #196), as dispatch sees it (`resolveCodex`). Absent: none deployed. */
  codex?: (installationId: number) => Promise<NativeBinding | undefined>;
  /** The admission queue (jobs/queue-store.ts), read only: what waits, for information. */
  queue?: Pick<QueueStore, 'list' | 'depth'>;
  now?: () => number;
  /** How long a check is served again without asking (per installation, per Lambda container). */
  ttlMs?: number;
  /** A refresh sooner than this after the last check is served from it: bounded reads. */
  minRefreshMs?: number;
  /** The longest one read may take before its check is left unverified. */
  readTimeoutMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export const READINESS_TTL_MS = 60_000;
export const READINESS_MIN_REFRESH_MS = 10_000;
const READ_TIMEOUT_MS = 5_000;
const RECENT_JOBS = 200;
const PAUSES = 100;
const CACHE_ENTRIES = 200;
const SUCCESS = new Set<JobResult>(['success', 'nothing_to_do']);
/** Results that say nothing about whether the pipeline works. */
const NEUTRAL = new Set<JobResult>(['running', 'canceled', 'superseded', 'deferred', 'not_run']);

export const LIMITATIONS = [
  'Readiness reads configuration and current state; it does not run a job. A ready repository can still fail in a run (a model refusing, a test failing, a registry unreachable).',
  'Package registry access (egress) is only exercised when a job installs dependencies; per-installation registry policy is not reported here yet.',
  "Trigger labels are not looked up on GitHub here; `updraft doctor` checks them for a local configuration. Branch protection applies only when Updraft asks GitHub to merge.",
  'Every check is made again with current state when a job is dispatched, and before each privileged step: readiness grants nothing.',
];

/**
 * The queue as read: the tenant's waiting count (kept transactionally with every entry), and the
 * entries a bounded listing found. The listing can miss waiting entries; `depth` says whether it did.
 */
interface QueueRead { depth: number; entries: QueueEntry[] }

/** The repositories GitHub listed; `truncated`: it has more than were read. */
type Listed = GitHubRepository[] & { truncated?: true };
type Read<T> = { ok: true; value: T } | { ok: false };

/** A read that never throws and never takes longer than `ms`: a failure leaves its check unverified. */
async function within<T>(p: Promise<T> | (() => Promise<T>), ms: number): Promise<Read<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const promise = typeof p === 'function' ? p() : p;
    const value = await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const check = (c: ReadinessCheck): ReadinessCheck => c;
const unverifiedCheck = (id: string, stage: ReadinessStage, summary: string, why: Unverified = 'read_failed', required = true): ReadinessCheck =>
  ({ id, stage, required, state: 'unverified', unverified: why, summary });

/** A repository's status from its checks and the installation's: the most pressing of them. */
export function combineStatus(checks: ReadinessCheck[]): Exclude<RepositoryStatus, 'not_configured'> {
  const required = checks.filter((c) => c.required);
  const failing = required.filter((c) => c.state === 'failing');
  if (failing.some((c) => c.problem !== 'transient' && c.problem !== 'paused' && c.problem !== 'provider')) return 'action_needed';
  if (failing.some((c) => c.problem === 'paused')) return 'paused';
  if (failing.length) return 'temporarily_unavailable';
  // Unread is unknown; what only a run can show is a stated limitation, not a doubt about the rest.
  if (required.some((c) => c.state === 'unverified' && c.unverified !== 'needs_run')) return 'unknown';
  return 'ready';
}

const PROVIDER = {
  claude: { name: 'Claude', id: 'subscription', signIn: 'Sign in to Claude', reconnect: 'Reconnect Claude', session: 'Claude subscription', who: 'an owner signs in' },
  codex: { name: 'Codex', id: 'codex-subscription', signIn: 'Sign in with ChatGPT', reconnect: 'Reconnect ChatGPT', session: 'Codex subscription', who: 'an owner signs in with ChatGPT' },
} as const;

/**
 * The readiness of a subscription worker, as a check: what dispatch would do with a job now.
 * Claude's (the default) is as before; Codex's says Codex, and its fix is the ChatGPT page.
 */
export function subscriptionCheck(readiness: NativeReadiness, provider: NativeProvider = 'claude'): ReadinessCheck {
  const p = PROVIDER[provider];
  const target: FixTarget = provider;
  const base = { id: p.id, stage: 'subscription' as const, required: true, ...(provider === 'codex' ? { provider } : {}) };
  const action = readinessAction(readiness);
  if (action === 'none') return { ...base, state: 'verified', summary: provider === 'codex' ? 'The Codex subscription worker is connected and signed in with ChatGPT.' : 'The Claude subscription worker is connected and signed in.' };
  if (action === 'sign-in') {
    return { ...base, state: 'failing', problem: 'missing_credentials',
      summary: readiness === 'expired' ? `The ${p.session} sign-in has expired: jobs wait until ${provider === 'codex' ? 'an owner signs in with ChatGPT again' : 'an owner signs in again'}.`
        : readiness === 'not-connected' ? `No ${p.session} session is connected: jobs wait until ${p.who}.`
          : `The ${p.name} subscription worker needs sign-in: jobs wait until ${p.who}.`,
      fix: { text: p.signIn, target } };
  }
  if (action === 'reconnect') {
    const image = readiness.startsWith('image-') || readiness === 'protocol-incompatible';
    return { ...base, state: 'failing', problem: 'reconnect',
      summary: image ? `The ${p.name} environment's image is not approved to run jobs (${readiness}): jobs wait for a reconnect onto a compatible image.`
        : `The ${p.name} environment can no longer run jobs (${readiness}): jobs wait for a reconnect.`,
      fix: { text: p.reconnect, target } };
  }
  return { ...base, state: 'failing', problem: 'transient',
    summary: `The ${p.name} environment is not taking jobs right now (${readiness}); a waiting job starts on its own once it is.` };
}

/**
 * Codex routed on a worker image that cannot run Codex (#196): dispatch refuses these jobs, and
 * never moves them to an API key. An operator publishes an image verified with Codex, or an owner
 * takes the trigger off the ChatGPT plan.
 */
export function codexUnsupportedCheck(image: string | undefined): ReadinessCheck {
  return { id: PROVIDER.codex.id, stage: 'subscription', required: true, provider: 'codex', state: 'failing', problem: 'provider',
    summary: `This deployment's subscription worker image${image ? ` (${image})` : ''} does not support Codex yet, so Codex work on the ChatGPT plan is not started (and never moved to an API key).`,
    fix: { text: 'Review Codex routing', target: 'codex' } };
}

interface InstallationFacts {
  tenant: Tenant;
  gh: Read<GitHubInstallation | null>;
  version: Read<ConfigVersion | null> | null;
  /** null: not read (the installation is not active, so GitHub would list nothing). */
  reachable: Read<Listed> | null;
  keys: Read<AgentKeyView[]>;
  usage: Read<Usage> | null;
  jobs: Read<JobSummary[]>;
  pauses: Read<HeldPause[]>;
  telemetry: Read<TelemetrySettings | null>;
  killSwitch: Read<KillSwitchState> | null;
  imageVersion: Read<string | null> | null;
  native: Read<NativeBinding | undefined> | null;
  nativeReadiness: Read<NativeReadiness> | null;
  /** Codex's session (ChatGPT plan); absent or null: none deployed. */
  codex?: Read<NativeBinding | undefined> | null;
  codexReadiness?: Read<NativeReadiness> | null;
  quotas?: Quotas;
}

/** The installation's checks, which every repository depends on. Pure: the facts are read first. */
/**
 * `jobImage`: whether jobs here need the published job image. `uncertain`: subscription routing
 * could not be read, so whether any job does is not known; a missing image is then unverified.
 */
export function installationChecks(f: InstallationFacts, jobImage: 'required' | 'uncertain' | 'none' = 'required'): ReadinessCheck[] {
  const out: ReadinessCheck[] = [];
  const { tenant } = f;
  // The tenant record first: it is what the launcher reads.
  if (tenant.status !== 'active') {
    const why = tenant.disabledReason;
    out.push(why === 'admin'
      ? check({ id: 'tenant', stage: 'installation', required: true, state: 'failing', problem: 'paused', summary: `An Updraft administrator disabled this installation${tenant.adminDisabled?.reason ? `: ${tenant.adminDisabled.reason}` : ''}. No jobs start until it is enabled again.` })
      : why === 'suspended'
        ? check({ id: 'tenant', stage: 'installation', required: true, state: 'failing', problem: 'permissions', summary: 'The App is suspended on GitHub, so no jobs start.', fix: { text: 'Unsuspend the App on GitHub', target: 'github' } })
        : check({ id: 'tenant', stage: 'installation', required: true, state: 'failing', problem: 'permissions', summary: 'The App is no longer installed on this account.', fix: { text: 'Install the App again', target: 'github' } }));
  } else out.push(check({ id: 'tenant', stage: 'installation', required: true, state: 'verified', summary: 'The installation is active in Updraft.' }));

  if (!f.gh.ok) out.push(unverifiedCheck('github-permissions', 'github', 'GitHub could not be asked for the installation just now, so its permissions are unverified.'));
  else if (f.gh.value === null) out.push(check({ id: 'github-permissions', stage: 'github', required: true, state: 'failing', problem: 'permissions', summary: 'GitHub no longer has this installation.', fix: { text: 'Install the App again', target: 'github' } }));
  else if (f.gh.value.suspendedAt !== null && tenant.disabledReason !== 'suspended') {
    out.push(check({ id: 'github-permissions', stage: 'github', required: true, state: 'failing', problem: 'permissions', summary: 'The App is suspended on GitHub, so no jobs start.', fix: { text: 'Unsuspend the App on GitHub', target: 'github' } }));
  } else if (f.gh.value.permissions === undefined) {
    out.push(unverifiedCheck('github-permissions', 'github', 'GitHub did not report what the installation grants, so its permissions are unverified.'));
  } else {
    const missing = missingPermissions(f.gh.value.permissions);
    out.push(missing.length
      ? check({ id: 'github-permissions', stage: 'github', required: true, state: 'failing', problem: 'permissions',
        summary: `The App is missing permissions jobs need: ${missing.map((p) => `${p.name} (${p.granted ? `${p.granted}, needs ${p.needs}` : `needs ${p.needs}`})`).join(', ')}.`,
        fix: { text: 'Review and accept the permissions on GitHub', target: 'github' } })
      : check({ id: 'github-permissions', stage: 'github', required: true, state: 'verified', summary: 'The App has every permission jobs need.' }));
  }

  if (f.version === null) out.push(check({ id: 'config-published', stage: 'config', required: true, state: 'failing', problem: 'invalid_config', summary: 'No configuration is published, so labeled issues start nothing.', fix: { text: 'Configure and publish', target: 'config' } }));
  else if (!f.version.ok) out.push(unverifiedCheck('config-published', 'config', 'The published configuration could not be read just now.'));
  else if (!f.version.value?.dispatch) out.push(check({ id: 'config-published', stage: 'config', required: true, state: 'failing', problem: 'invalid_config', summary: `Configuration v${tenant.activeConfigVersion} has no dispatch rules: publish it again.`, fix: { text: 'Publish the configuration again', target: 'config' } }));
  else out.push(check({ id: 'config-published', stage: 'config', required: true, state: 'verified', summary: `Configuration v${f.version.value.version} is published and active${f.version.value.publishedAt ? ` (since ${f.version.value.publishedAt})` : ''}. Drafts in the editor take effect only once published.` }));

  if (f.killSwitch === null) out.push(unverifiedCheck('kill-switch', 'capacity', 'Whether the platform has paused all jobs is not checked in this deployment.', 'not_checked'));
  else if (!f.killSwitch.ok) out.push(unverifiedCheck('kill-switch', 'capacity', 'Whether the platform has paused all jobs could not be read just now (dispatch treats an unreadable switch as paused).'));
  else if (f.killSwitch.value === 'unreadable') out.push(unverifiedCheck('kill-switch', 'capacity', 'The platform kill switch could not be read just now. Until it can, dispatch treats it as on and starts nothing; this is not an operator pause.'));
  else out.push(f.killSwitch.value === 'on'
    ? check({ id: 'kill-switch', stage: 'capacity', required: true, state: 'failing', problem: 'paused', summary: "The platform's operator has paused all jobs. Nothing starts until they are resumed." })
    : check({ id: 'kill-switch', stage: 'capacity', required: true, state: 'verified', summary: 'The platform is accepting jobs.' }));

  if (jobImage !== 'none') {
    if (f.imageVersion === null) out.push(unverifiedCheck('job-image', 'capacity', 'Whether a job image is published is not checked in this deployment.', 'not_checked'));
    else if (!f.imageVersion.ok) out.push(unverifiedCheck('job-image', 'capacity', 'Whether a job image is published could not be read just now.'));
    else if (!f.imageVersion.value && jobImage === 'uncertain') out.push(unverifiedCheck('job-image', 'capacity', `No job image is published; whether these workflows need one (rather than the ${unreadSubscriptions(f)} subscription) could not be read just now.`));
    else out.push(f.imageVersion.value
      ? check({ id: 'job-image', stage: 'capacity', required: true, state: 'verified', summary: `Jobs run on image ${f.imageVersion.value}.` })
      : check({ id: 'job-image', stage: 'capacity', required: true, state: 'failing', problem: 'provider', summary: 'No job image is published in this deployment yet, so jobs are off.' }));
  }

  out.push(...capacityChecks(f));
  out.push(...telemetryChecks(f));
  return out;
}

/** The providers whose subscription routing could not be read: 'Claude', 'Codex' or 'Claude or Codex'. */
function unreadSubscriptions(f: InstallationFacts): string {
  const unread = [f.native && !f.native.ok ? 'Claude' : '', f.codex && !f.codex.ok ? 'Codex' : ''].filter(Boolean);
  return unread.length ? unread.join(' or ') : 'Codex';
}

function capacityChecks(f: InstallationFacts): ReadinessCheck[] {
  if (!f.quotas || f.usage === null) return [unverifiedCheck('quota', 'capacity', 'Quotas are not checked in this deployment; dispatch applies them.', 'not_checked')];
  if (!f.usage.ok || !f.jobs.ok) return [unverifiedCheck('quota', 'capacity', 'Usage could not be read just now, so whether a quota is reached is unverified.')];
  const q = tenantQuotas(f.quotas, f.tenant.limits);
  const u = f.usage.value;
  const running = f.jobs.value.filter((j) => jobResult(j) === 'running').length;
  const out: ReadinessCheck[] = [];
  if (u.jobsToday >= q.jobsPerDay) out.push({ id: 'quota-daily', stage: 'capacity', required: true, state: 'failing', problem: 'transient', summary: `Today's job limit is reached (${u.jobsToday} of ${q.jobsPerDay}); new jobs are throttled until 00:00 UTC.` });
  if (u.microvmSecondsThisMonth >= q.microvmMinutesPerMonth * 60) out.push({ id: 'quota-minutes', stage: 'capacity', required: true, state: 'failing', problem: 'transient', summary: `This month's compute minutes are used up (${Math.floor(u.microvmSecondsThisMonth / 60)} of ${q.microvmMinutesPerMonth}); new jobs are throttled until next month.` });
  if (running >= q.concurrentJobs) out.push({ id: 'quota-concurrent', stage: 'capacity', required: true, state: 'failing', problem: 'transient', summary: `${running} of ${q.concurrentJobs} concurrent job slots are in use; a new job waits until one finishes.` });
  if (!out.length) out.push({ id: 'quota', stage: 'capacity', required: true, state: 'verified',
    summary: `Within quotas: ${u.jobsToday} of ${q.jobsPerDay} jobs today, ${Math.floor(u.microvmSecondsThisMonth / 60)} of ${q.microvmMinutesPerMonth} minutes this month, ${running} of ${q.concurrentJobs} running. The platform-wide limit is checked at dispatch.` });
  return out;
}

function telemetryChecks(f: InstallationFacts): ReadinessCheck[] {
  if (!f.telemetry.ok) return [unverifiedCheck('telemetry', 'telemetry', 'Telemetry settings could not be read just now. Jobs run without telemetry either way.', 'read_failed', false)];
  const t = f.telemetry.value;
  if (!t?.key) return [{ id: 'telemetry', stage: 'telemetry', required: false, state: 'off', summary: 'Telemetry is not set up. It is optional: jobs run without it.', fix: { text: 'Set up telemetry', target: 'telemetry' } }];
  if (!t.enabled) return [{ id: 'telemetry', stage: 'telemetry', required: false, state: 'off', summary: 'Telemetry is paused. It is optional: jobs run without it.', fix: { text: 'Turn telemetry on', target: 'telemetry' } }];
  const last = f.jobs.ok ? f.jobs.value.find((j) => j.detail?.telemetry && !j.detail.telemetry.local) : undefined;
  const sent = last?.detail?.telemetry;
  if (sent && sent.exported === 0 && sent.failed > 0) {
    return [{ id: 'telemetry', stage: 'telemetry', required: false, state: 'failing', problem: 'invalid_config', summary: "The latest job's telemetry export failed; jobs still run without it.", fix: { text: 'Check telemetry settings', target: 'telemetry' } }];
  }
  return [{ id: 'telemetry', stage: 'telemetry', required: false, state: 'verified', summary: sent ? 'Telemetry is on, and the latest job exported its traces.' : 'Telemetry is on; no job has exported traces yet.' }];
}

type Rule = DispatchRules['repositories'][string];

/** The subscription bindings dispatch reads for an installation: Claude's, and Codex's (ChatGPT plan). */
export interface SubscriptionBindings { claude?: NativeBinding | undefined; codex?: NativeBinding | undefined }

const keysOf = (rule: Rule, t: Rule['triggers'][number]) => t.keys ?? rule.keys;

/**
 * Which subscription dispatch would route this trigger's issues to (jobs/launch.ts), or undefined
 * for the API-key path. Claude's is decided first, exactly as before: its triggers, and with
 * owner-chosen triggers only a workflow that needs the Anthropic key. Only when Claude does not
 * take it may Codex's: a workflow that needs CODEX_API_KEY, on a trigger chosen on the ChatGPT
 * page, with Codex routing on. A Codex route on an image that cannot run Codex still takes it
 * (dispatch refuses it there, never moving it to an API key).
 */
export function routedToSubscription(bindings: SubscriptionBindings, name: string, rule: Rule, t: Rule['triggers'][number]): NativeProvider | undefined {
  const at = { repositoryId: rule.id, repository: name, label: t.label };
  const keys = keysOf(rule, t);
  const { claude, codex } = bindings;
  if (claude?.enabled && !(claude.explicitTriggers && !keys?.includes('ANTHROPIC_API_KEY')) && claude.triggers.some((n) => sameNativeTrigger(n, at))) return 'claude';
  if (codex?.enabled && keys?.includes('CODEX_API_KEY') && codex.triggers.some((n) => sameNativeTrigger(n, at))) return 'codex';
  return undefined;
}

interface RepositoryFacts {
  name: string;
  rule: Rule;
  loop: boolean;
  live?: GitHubRepository | undefined;
  reachable: Read<Listed> | null;
  gh: Read<GitHubInstallation | null>;
  keys: Read<AgentKeyView[]>;
  pauses: Read<HeldPause[]>;
  native: Read<NativeBinding | undefined> | null;
  nativeReadiness: Read<NativeReadiness> | null;
  /** Codex's session (ChatGPT plan); absent or null: none deployed. */
  codex?: Read<NativeBinding | undefined> | null;
  codexReadiness?: Read<NativeReadiness> | null;
  /** null: this deployment has no admission queue to read. */
  queue?: Read<QueueRead> | null;
  now?: number;
}

/** One configured repository's checks. Pure: the facts are read first. */
export function repositoryChecks(f: RepositoryFacts): ReadinessCheck[] {
  const out: ReadinessCheck[] = [];
  const { rule, name } = f;

  if (f.reachable === null) out.push(unverifiedCheck('repository-access', 'github', 'Repository access is not read while the installation is not active.', 'not_checked'));
  else if (!f.reachable.ok) out.push(unverifiedCheck('repository-access', 'github', 'The repositories the App reaches could not be read just now.'));
  else if (!f.live && f.reachable.value.truncated) out.push(unverifiedCheck('repository-access', 'github', 'The App reaches more repositories than could be listed, so whether it reaches this one is unverified.'));
  else if (!f.live) out.push({ id: 'repository-access', stage: 'github', required: true, state: 'failing', problem: 'permissions', summary: 'The App no longer reaches this repository, so its jobs cannot run.', fix: { text: 'Choose repositories on GitHub', target: 'github' } });
  else if (f.live.id !== rule.id) out.push({ id: 'repository-access', stage: 'config', required: true, state: 'failing', problem: 'invalid_config', summary: 'GitHub now has a different repository under this name (recreated or replaced): publish the configuration again.', fix: { text: 'Publish the configuration again', target: 'config' } });
  else out.push({ id: 'repository-access', stage: 'github', required: true, state: 'verified', summary: 'The App reaches this repository.' });

  if (rule.paused) out.push({ id: 'repository-paused', stage: 'pauses', required: true, state: 'failing', problem: 'paused', summary: 'This repository is paused in the published configuration: labeled issues start nothing.', fix: { text: 'Resume it in the configuration', target: 'config' } });

  const labels = [...new Set(rule.triggers.map((t) => t.label))];
  const actors = new Set([...(rule.actors ?? []), ...rule.triggers.flatMap((t) => t.actors ?? [])]);
  out.push(labels.length
    ? { id: 'triggers', stage: 'config', required: true, state: 'verified', summary: `Started by ${labels.map((l) => `"${l}"`).join(', ')}, applied by ${actors.size === 1 ? 'one allowed login' : `${actors.size} allowed logins`}.` }
    : { id: 'triggers', stage: 'config', required: true, state: 'failing', problem: 'invalid_config', summary: 'No workflow trigger is published for this repository.', fix: { text: 'Add a workflow', target: 'config' } });

  // Agent keys, or the subscription, per trigger: what dispatch checks for the label it sees.
  const bindings: SubscriptionBindings = { claude: f.native?.ok ? f.native.value : undefined, codex: f.codex?.ok ? f.codex.value : undefined };
  const route = new Map(rule.triggers.map((t) => [t, routedToSubscription(bindings, name, rule, t)]));
  const routed = rule.triggers.filter((t) => route.get(t) === 'claude');
  const codexRouted = rule.triggers.filter((t) => route.get(t) === 'codex');
  const claudeUnread = !!f.native && !f.native.ok;
  const codexUnread = !!f.codex && !f.codex.ok;
  // With Codex's routing unread, a trigger Claude does not take whose workflow needs CODEX_API_KEY
  // may be Codex's: dispatch fails it, retryably, rather than run it on the key (jobs/launch.ts).
  const codexMaybe = codexUnread ? rule.triggers.filter((t) => route.get(t) !== 'claude' && !!keysOf(rule, t)?.includes('CODEX_API_KEY')) : [];
  const unknownKeys = rule.triggers.some((t) => keysOf(rule, t) === undefined);
  // `needed`: every key a trigger here may need. `uncertain`: ones that may not be, because the
  // routing that decides it could not be read: one of them not being set is unknown, not missing.
  const needed = new Set<string>();
  const certain = new Set<string>();
  for (const t of rule.triggers) {
    const r = route.get(t);
    const keys = keysOf(rule, t) ?? [];
    for (const k of keys) {
      // A subscription job never needs its own provider's key; another agent's (a reviewer's) it does.
      if (r === 'claude' && k === 'ANTHROPIC_API_KEY') continue;
      if (r === 'codex' && k === 'CODEX_API_KEY' && !(claudeUnread && keys.includes('ANTHROPIC_API_KEY'))) continue;
      needed.add(k);
      const unsure = (k === 'ANTHROPIC_API_KEY' && claudeUnread) || (k === 'CODEX_API_KEY' && (r === 'codex' || codexMaybe.includes(t)));
      if (!unsure) certain.add(k);
    }
  }
  if (claudeUnread) out.push(unverifiedCheck('subscription', 'subscription', 'Whether Claude subscription routing applies here could not be read just now.'));
  else if (routed.length) {
    const labels = `${routed.map((t) => `"${t.label}"`).join(', ')} ${routed.length > 1 ? 'run' : 'runs'} on the Claude subscription.`;
    if (f.nativeReadiness?.ok) {
      const c = subscriptionCheck(f.nativeReadiness.value);
      out.push({ ...c, summary: `${c.summary} ${labels}` });
    } else out.push(unverifiedCheck('subscription', 'subscription', `The Claude subscription worker could not be read just now. ${labels}`));
  }
  // Codex on a ChatGPT plan: only where some trigger is (or, unread, may be) routed to it.
  const codexId = PROVIDER.codex.id;
  if (codexMaybe.length) {
    out.push({ ...unverifiedCheck(codexId, 'subscription', `Whether Codex subscription routing (ChatGPT plan) applies here could not be read just now: ${codexMaybe.map((t) => `"${t.label}"`).join(', ')} may run on it. Until it can, dispatch retries these jobs rather than run them on CODEX_API_KEY.`), provider: 'codex' });
  } else if (!codexUnread && codexRouted.length) {
    const labels = `${codexRouted.map((t) => `"${t.label}"`).join(', ')} ${codexRouted.length > 1 ? 'run' : 'runs'} on the Codex subscription (ChatGPT plan).`;
    const c = bindings.codex?.unavailable ? codexUnsupportedCheck(bindings.codex.image)
      : f.codexReadiness?.ok ? subscriptionCheck(f.codexReadiness.value, 'codex') : undefined;
    out.push(c ? { ...c, summary: `${c.summary} ${labels}` }
      : { ...unverifiedCheck(codexId, 'subscription', `The Codex subscription worker could not be read just now. ${labels}`), provider: 'codex' });
  }
  if (unknownKeys) out.push(unverifiedCheck('agent-keys', 'credentials', 'This configuration was published before agent keys were recorded with it: publish it again so they can be checked.', 'not_checked'));
  if (!f.keys.ok) {
    if (needed.size) out.push(unverifiedCheck('agent-keys', 'credentials', 'The agent keys could not be read just now.'));
  } else if (needed.size) {
    const offered = new Set<string>(Object.values(AGENT_KEY_ENV));
    const retired = [...needed].filter((k) => !offered.has(k));
    const byName = new Map(f.keys.value.map((k) => [k.name, k]));
    // Subscription routing could not be read: a trigger that may run on a subscription needs no key
    // of that provider, so that key not being set is unknown here, not missing.
    const unset = [...needed].filter((k) => offered.has(k) && !byName.get(k)?.configured);
    const missing = unset.filter((k) => certain.has(k));
    const uncertain = unset.filter((k) => !missing.includes(k));
    const instead = [...new Set(uncertain.map((k) => k === 'CODEX_API_KEY' ? 'Codex' : 'Claude'))].join(' or ');
    if (retired.length) out.push({ id: 'agent-retired', stage: 'credentials', required: true, state: 'failing', problem: 'invalid_config', summary: `A workflow here runs an agent this deployment no longer runs (it needs ${retired.join(', ')}): choose another agent.`, fix: { text: 'Change the workflow', target: 'config' } });
    if (missing.length) out.push({ id: 'agent-keys', stage: 'credentials', required: true, state: 'failing', problem: 'missing_credentials', summary: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} needed by this repository's workflows (coding or review) and not set.`, fix: { text: missing.length > 1 ? 'Add the keys' : 'Add the key', target: 'keys' } });
    else if (uncertain.length) out.push(unverifiedCheck('agent-keys', 'credentials', `${uncertain.join(' and ')} ${uncertain.length > 1 ? 'are' : 'is'} not set. Whether these workflows need ${uncertain.length > 1 ? 'them' : 'it'}, or run on the ${instead} subscription instead, could not be read just now.`));
    else if (!retired.length && !unknownKeys) {
      // A key is checked with its provider when it is saved. A later job's failure is recorded on
      // it, but that job may have failed for any reason: it is said, never taken as a bad key.
      const list = [...needed];
      const afterFailure = list.filter((k) => byName.get(k)?.lastUsed?.ok === false);
      const usedOk = list.every((k) => byName.get(k)?.lastUsed?.ok === true);
      out.push({ id: 'agent-keys', stage: 'credentials', required: true, state: 'verified',
        summary: `${list.join(', ')} ${list.length > 1 ? 'are' : 'is'} set (checked with the provider when saved)${usedOk ? '; the last job that used each succeeded' : afterFailure.length ? `; the last job that used ${afterFailure.join(' and ')} did not succeed, which may or may not be the key` : ''}.` });
    }
  }

  // GitHub events the installation must deliver for each part of the loop.
  const events: { event: string; why: string; required: boolean }[] = [{ event: 'issues', why: 'labels start jobs', required: true }];
  if (rule.review) events.push({ event: 'pull_request', why: 'pushes are reviewed', required: true });
  if (rule.revise) events.push({ event: 'pull_request_review', why: 'change requests start revisions', required: true });
  if (rule.ci && rule.review) events.push({ event: 'check_suite', why: 'failing checks start CI fixes', required: true });
  if (!f.gh.ok || !f.gh.value) out.push(unverifiedCheck('github-events', 'github', 'The webhook events the App receives could not be read just now.'));
  else if (!f.gh.value.events) out.push(unverifiedCheck('github-events', 'github', 'GitHub did not report the webhook events the App receives.'));
  else {
    const has = new Set(f.gh.value.events);
    const missing = events.filter((e) => !has.has(e.event));
    out.push(missing.length
      ? { id: 'github-events', stage: 'github', required: true, state: 'failing', problem: 'permissions', summary: `The App is not subscribed to ${missing.map((e) => `${e.event} (${e.why})`).join(', ')}.`, fix: { text: 'Accept the App\'s requested events on GitHub', target: 'github' } }
      : { id: 'github-events', stage: 'github', required: true, state: 'verified', summary: `The App receives ${events.map((e) => e.event).join(', ')}.` });
  }
  // Commands by mention (#135): optional; without issue_comment, `@<app> pause` and the rest are never seen.
  if (f.gh.ok && f.gh.value?.events) {
    out.push(f.gh.value.events.includes('issue_comment')
      ? { id: 'github-mentions', stage: 'github', required: false, state: 'verified', summary: 'Comments reach Updraft, so allowed people can pause, resume, stop or cancel work by mentioning the App.' }
      : { id: 'github-mentions', stage: 'github', required: false, state: 'off', summary: 'The App is not subscribed to issue comments, so mention commands (pause, resume, stop, cancel) are not seen.', fix: { text: 'Subscribe the App to Issue comment events on GitHub', target: 'github' } });
  }

  // Review and revision loop.
  if ((rule.review || rule.revise) && !f.loop) out.push({ id: 'review', stage: 'review', required: true, state: 'failing', problem: 'invalid_config', summary: 'This configuration was published before pull request events started jobs: publish it again for review and revisions to run.', fix: { text: 'Publish the configuration again', target: 'config' } });
  else if (rule.review) out.push({ id: 'review', stage: 'review', required: true, state: 'verified', summary: `Pull requests are reviewed${rule.revise ? ', and change requests start revisions' : '; revisions are off, so a change request is only posted'}. Reviewer keys are part of the agent keys above.` });
  else if (rule.revise) out.push({ id: 'review', stage: 'review', required: false, state: 'off', summary: 'Review is off; change requests from allowed people start revisions.', fix: { text: 'Turn on review', target: 'config' } });
  else out.push({ id: 'review', stage: 'review', required: false, state: 'off', summary: 'Review is off: pull requests are published without an independent review.', fix: { text: 'Turn on review', target: 'config' } });

  // CI repair: needs review (it runs on pull requests the reviewer finds ready).
  if (rule.ci && rule.review) {
    out.push({ id: 'ci', stage: 'ci', required: true, state: 'verified', summary: 'Failing checks on pull requests the reviewer finds ready start a CI fix (Checks and Commit statuses: read are part of the permissions above).' });
    const perms = f.gh.ok && f.gh.value ? f.gh.value.permissions : undefined;
    if (!perms) out.push(unverifiedCheck('ci-logs', 'ci', 'Whether CI fixes can read job logs (Actions: read) is unverified.', 'read_failed', false));
    else if (perms.actions !== 'read' && perms.actions !== 'write') {
      out.push({ id: 'ci-logs', stage: 'ci', required: false, state: 'failing', problem: 'permissions', summary: 'The App cannot read Actions logs, so a CI fix works from check annotations and summaries only.', fix: { text: 'Grant Actions: read on GitHub', target: 'github' } });
    } else out.push({ id: 'ci-logs', stage: 'ci', required: false, state: 'verified', summary: 'CI fixes can read the failed job\'s logs.' });
  } else if (rule.review) out.push({ id: 'ci', stage: 'ci', required: false, state: 'off', summary: 'CI repair is not configured: failing checks on Updraft pull requests are left to people.', fix: { text: 'Turn on CI repair', target: 'config' } });
  else out.push({ id: 'ci', stage: 'ci', required: false, state: 'off', summary: 'CI repair needs review, which is off.' });

  // Workflows an owner stopped: they wait for a resume; new issues still start.
  if (!f.pauses.ok) out.push(unverifiedCheck('workflow-pauses', 'pauses', 'Paused workflows could not be read just now.', 'read_failed', false));
  else {
    const held = f.pauses.value.filter((p) => p.repositoryId === rule.id);
    const subjects = [...new Set(held.map((p) => p.issue ?? p.pullRequest ?? p.subject))].sort((a, b) => a - b);
    if (subjects.length) out.push({ id: 'workflow-pauses', stage: 'pauses', required: false, state: 'failing', problem: 'paused', summary: `${subjects.length === 1 ? 'One workflow is' : `${subjects.length} workflows are`} paused by an owner (${subjects.slice(0, 5).map((n) => `#${n}`).join(', ')}${subjects.length > 5 ? ', ...' : ''}); ${subjects.length === 1 ? 'it waits' : 'they wait'} for a resume. Other issues still start.`, fix: { text: 'Review paused workflows', target: 'workflows' } });
  }

  // The admission queue: informational only, since a waiting job starts once capacity frees.
  if (f.queue === null || f.queue === undefined) { /* no queue in this deployment */ }
  else if (!f.queue.ok) out.push(unverifiedCheck('queue', 'capacity', 'The admission queue could not be read just now.', 'read_failed', false));
  else {
    const { depth, entries } = f.queue.value;
    const found = entries.filter(isWaiting);
    // The listing found fewer waiting entries than the tenant's count: what it says of this
    // repository is a lower bound, and "none" is not known.
    const partial = found.length < depth;
    const waiting = found.filter((e) => e.repositoryId === rule.id);
    const oldest = Math.min(...waiting.map((e) => e.enqueuedAt));
    const minutes = waiting.length ? Math.max(0, Math.round(((f.now ?? Date.now()) - oldest) / 60_000)) : 0;
    const count = `${partial ? 'At least ' : ''}${waiting.length === 1 ? `${partial ? 'one' : 'One'} job waits` : `${waiting.length} jobs wait`}`;
    if (waiting.length) out.push({ id: 'queue', stage: 'capacity', required: false, state: 'failing', problem: 'transient', summary: `${count} in the admission queue (the oldest found for ${minutes} min); ${waiting.length === 1 && !partial ? 'it starts' : 'they start'} as capacity frees.`, fix: { text: 'Open the jobs', target: 'workflows' } });
    else if (partial) out.push(unverifiedCheck('queue', 'capacity', `${depth} ${depth === 1 ? 'job waits' : 'jobs wait'} in this installation's admission queue, and not all of them could be listed: whether any is this repository's is unverified.`, 'read_failed', false));
    else out.push({ id: 'queue', stage: 'capacity', required: false, state: 'verified', summary: 'No job of this repository waits in the admission queue.' });
  }

  out.push(unverifiedCheck('egress', 'egress', 'Package registry access is exercised only when a job installs dependencies.', 'needs_run'));
  return out;
}

function lastJobOf(jobs: Read<JobSummary[]>, name: string): RepositoryReadiness['lastJob'] {
  if (!jobs.ok) return undefined;
  const job = jobs.value.find((j) => j.repository.toLowerCase() === name && !NEUTRAL.has(jobResult(j)));
  return job ? { jobId: job.jobId, result: jobResult(job), at: job.finishedAt ?? job.createdAt, ...(job.configVersion !== undefined ? { configVersion: job.configVersion } : {}) } : undefined;
}

/** Evidence from the latest finished job: whether the pipeline has actually run under this configuration. */
export function executionCheck(last: RepositoryReadiness['lastJob'], activeVersion: number | undefined, jobsRead: boolean): ReadinessCheck {
  if (!jobsRead) return unverifiedCheck('execution', 'execution', 'Recent jobs could not be read just now.', 'read_failed', false);
  if (!last) return unverifiedCheck('execution', 'execution', 'No job of this repository has finished recently: an end-to-end run is unverified.', 'needs_run', false);
  const current = last.configVersion !== undefined && last.configVersion === activeVersion;
  if (SUCCESS.has(last.result)) {
    return current
      ? { id: 'execution', stage: 'execution', required: false, state: 'verified', summary: `The latest job succeeded at ${last.at} under this configuration. That is past evidence, not a promise for the next run.` }
      : unverifiedCheck('execution', 'execution', `The latest job succeeded at ${last.at}, under an earlier configuration: a run under v${activeVersion} is unverified.`, 'needs_run', false);
  }
  return { id: 'execution', stage: 'execution', required: false, state: 'failing', problem: 'transient', summary: `The latest job ended ${last.result.replace(/_/g, ' ')} at ${last.at}${current ? '' : ' under an earlier configuration'}: open it to see why.`, fix: { text: 'Open the job', target: 'job' } };
}

export function createReadinessService(d: ReadinessServiceDeps) {
  const now = d.now ?? Date.now;
  const ttl = d.ttlMs ?? READINESS_TTL_MS;
  const minRefresh = d.minRefreshMs ?? READINESS_MIN_REFRESH_MS;
  const timeout = d.readTimeoutMs ?? READ_TIMEOUT_MS;
  const log = d.log ?? ((e) => console.log(JSON.stringify(e)));
  /** Per installation: the last report, and the tenant state it was made under. */
  const cache = new Map<number, { key: string; at: number; report: Omit<ReadinessReport, 'cached'> }>();
  /** Assessments under way: concurrent misses for one installation share one (single flight). */
  const inflight = new Map<number, { key: string; promise: Promise<Omit<ReadinessReport, 'cached'>> }>();

  async function assess(caller: Caller, installationId: number, tenant: Tenant): Promise<Omit<ReadinessReport, 'cached'>> {
    const at = now();
    const read = <T>(p: () => Promise<T>) => within(p, timeout);
    const [gh, version, reachable, keys, usage, jobs, pauses, telemetry, killSwitch, imageVersion, native, codex, queue] = await Promise.all([
      read(() => d.github.installation(caller, installationId)),
      tenant.activeConfigVersion === undefined ? Promise.resolve(null) : read(() => d.store.getConfigVersion(installationId, tenant.activeConfigVersion!, { consistent: true })),
      tenant.status === 'active' ? read(() => d.github.repositories(caller, installationId).then((r): Listed => Object.assign([...r.repositories], r.truncated ? { truncated: true as const } : {}))) : Promise.resolve(null),
      read(() => d.agentKeys.list(caller, installationId).then((v) => v.keys)),
      d.quotas ? read(() => d.store.getUsage(installationId, dayOf(at), monthOf(at))) : Promise.resolve(null),
      read(() => d.store.listRecentJobs(installationId, RECENT_JOBS)),
      read(() => d.store.listWorkflowPauses(installationId, PAUSES)),
      read(() => d.store.getTelemetry(installationId)),
      d.killSwitch ? read(async (): Promise<KillSwitchState> => d.killSwitch!.state ? d.killSwitch!.state() : (await d.killSwitch!.engaged()) ? 'on' : 'off') : Promise.resolve(null),
      d.imageVersion ? read(() => d.imageVersion!()) : Promise.resolve(null),
      d.native ? read(() => d.native!(installationId)) : Promise.resolve(null),
      d.codex ? read(() => d.codex!(installationId)) : Promise.resolve(null),
      d.queue ? read(async (): Promise<QueueRead> => {
        // The waiting count first: nothing waits, nothing to list.
        const depth = await d.queue!.depth(installationId);
        return { depth, entries: depth > 0 ? await d.queue!.list(installationId, RECENT_JOBS) : [] };
      }) : Promise.resolve(null),
    ]);
    const rules = version?.ok ? version.value?.dispatch : undefined;
    const bindings: SubscriptionBindings = { claude: native?.ok ? native.value : undefined, codex: codex?.ok ? codex.value : undefined };
    const names = Object.entries(rules?.repositories ?? {});
    const routes = names.flatMap(([name, rule]) => rule.triggers.map((t) => ({ route: routedToSubscription(bindings, name, rule, t), codexKey: !!keysOf(rule, t)?.includes('CODEX_API_KEY') })));
    // Each worker's readiness is read once, and only when some trigger runs on its subscription
    // (never for a Codex route on an image that cannot run Codex: dispatch does not ask it either).
    const claudeBinding = bindings.claude;
    const codexBinding = bindings.codex;
    const [nativeReadiness, codexReadiness] = await Promise.all([
      claudeBinding && routes.some((r) => r.route === 'claude') ? read(() => claudeBinding.readiness()) : Promise.resolve(null),
      codexBinding && !codexBinding.unavailable && routes.some((r) => r.route === 'codex') ? read(() => codexBinding.readiness()) : Promise.resolve(null),
    ]);
    const allRouted = names.length > 0 && routes.every((r) => r.route !== undefined);
    // Codex's routing unread: a trigger that may be Codex's is not known to need the job image.
    const codexUncertain = codex !== null && !codex.ok && routes.some((r) => r.route === undefined && r.codexKey)
      && routes.every((r) => r.route !== undefined || r.codexKey);
    const facts: InstallationFacts = { tenant, gh, version, reachable, keys, usage, jobs, pauses, telemetry, killSwitch, imageVersion, native, nativeReadiness, codex, codexReadiness, ...(d.quotas ? { quotas: d.quotas } : {}) };
    const installation = installationChecks(facts, (native && !native.ok) || codexUncertain ? 'uncertain' : allRouted ? 'none' : 'required');
    const listed = reachable?.ok ? reachable.value : [];
    const live = new Map(listed.map((r) => [r.fullName.toLowerCase(), r]));
    const repositories: RepositoryReadiness[] = names.map(([name, rule]) => {
      const checks = repositoryChecks({ name, rule, loop: rules?.loop === true, live: live.get(name), reachable, gh, keys, pauses, native, nativeReadiness, codex, codexReadiness, queue, now: at });
      const last = lastJobOf(jobs, name);
      checks.push(executionCheck(last, tenant.activeConfigVersion, jobs.ok));
      return { repository: live.get(name)?.fullName ?? name, repositoryId: rule.id, status: combineStatus([...installation, ...checks]), checks, ...(last ? { lastJob: last } : {}) };
    });
    // Repositories the App reaches that the published configuration does not name: set them up to use them.
    for (const r of listed) {
      if (!rules?.repositories[r.fullName.toLowerCase()]) repositories.push({ repository: r.fullName, repositoryId: r.id, status: 'not_configured', checks: [] });
    }
    const order: Record<RepositoryStatus, number> = { action_needed: 0, temporarily_unavailable: 1, unknown: 2, paused: 3, ready: 4, not_configured: 5 };
    repositories.sort((a, b) => order[a.status] - order[b.status] || a.repository.localeCompare(b.repository));
    const unread = [gh, version, reachable, keys, usage, jobs, pauses, telemetry, killSwitch, imageVersion, native, nativeReadiness, codex, codexReadiness, queue].filter((r) => r && !r.ok).length;
    if (unread) log({ installationId, readiness: 'partial', unread });
    return { checkedAt: new Date(at).toISOString(), configVersion: tenant.activeConfigVersion ?? null, installation, repositories, limitations: LIMITATIONS };
  }

  return {
    /**
     * The installation's readiness, for its members only (membership is checked on every call,
     * cached or not). Served from the last check for a minute, and always re-read when the
     * published configuration or the tenant's status changed since; `refresh` reads again unless
     * the last check is only seconds old.
     *
     * Agent keys, the Claude and Codex sessions and workflow pauses change outside this service (and in other
     * containers), so they are not part of the cache key: the console asks with `refresh` whenever
     * the page is opened, which the 10 s floor bounds, and a non-refresh read is at most a minute old.
     */
    async readiness(caller: Caller, installationId: number, opts: { refresh?: boolean } = {}): Promise<ReadinessReport> {
      const { tenant } = await d.github.member(caller, installationId);
      const key = `${tenant.activeConfigVersion ?? '-'}:${tenant.status}:${tenant.disabledReason ?? '-'}`;
      const hit = cache.get(installationId);
      const age = hit ? now() - hit.at : Infinity;
      if (hit && hit.key === key && (opts.refresh ? age < minRefresh : age < ttl)) return { ...hit.report, cached: true };
      const running = inflight.get(installationId);
      if (running && running.key === key) return { ...await running.promise, cached: false };
      const promise = assess(caller, installationId, tenant).then((report) => {
        cache.delete(installationId);
        cache.set(installationId, { key, at: now(), report });
        while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
        return report;
      }).finally(() => {
        if (inflight.get(installationId)?.promise === promise) inflight.delete(installationId);
      });
      inflight.set(installationId, { key, promise });
      return { ...await promise, cached: false };
    },
  };
}

export type ReadinessService = ReturnType<typeof createReadinessService>;
