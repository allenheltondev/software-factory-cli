import { JOB_PERMISSIONS } from '../broker/broker.js';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows, type TenantSummary } from '../flows/github.js';
import type { RetryResult } from '../jobs/retry.js';
import { resumeJobPause, resumeWorkflowPause, stopSubjects, type ResumeOutcome, type StopResult } from '../jobs/stop.js';
import { countBy, deliveryCounts, jobResult, notRetryableMessage, retryable, type JobResult } from '../jobs/status.js';
import type { DeliveryRecord, JobSummary, Store, TelemetrySettings } from '../store/store.js';
import { positions, queueView, type QueueCancelResult, type QueueView } from '../jobs/queue.js';
import { isWaiting, type QueueEntry, type QueueStore } from '../jobs/queue-store.js';
import type { AgentKeyService, AgentKeyView } from './agent-key-service.js';
import { AGENT_KEY_ENV, SUPPORTED_AGENT_KEY_ENV } from './agents.js';
import { redact } from './redact.js';
import type { TelemetryMarkKind, TelemetryTotals } from '../jobs/lifecycle.js';
import { parseOtlpEndpoint } from './otlp-destination.js';
import { conversationUrl, linkSettingsForJob, timelineUrl, traceUrl, type LinkSettings } from './telemetry-service.js';

/**
 * A tenant's status and diagnostics in the console (#71), for its members only:
 *
 *   overview     the installation's status (active, suspended, missing permissions, ...), the
 *                repositories it reaches and which are configured, the active config version,
 *                the agent keys, and the last 30 days of deliveries and jobs in counts
 *   deliveries   the recent webhook deliveries, each with what became of it (jobs/deliveries.ts)
 *   jobs         the recent jobs: status, issue and pull request, config version, duration and
 *                how it ended (jobs/status.ts)
 *   logs         a job's logs, read from the tenant's results (only the tenant's own jobs, found
 *                in its own partition), redacted once more on the way out
 *
 * Deliveries and job summaries are kept 30 days (their TTL); logs as long as the stack's
 * ResultRetentionDays (the daily cleanup).
 */

/** Reads the end of a log object: at most `maxBytes`, with the object's whole size; null when it is gone. */
export type LogReader = (key: string, maxBytes: number) => Promise<{ text: string; size: number } | null>;

/** The most of a log the API returns: its end, where a failure shows. */
export const LOG_TAIL_BYTES = 1024 * 1024;
const LIST_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** How many of each the overview counts: more than this in 30 days, and it says the counts are of the latest. */
export const ACTIVITY_SAMPLE = 500;

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

export interface MissingPermission {
  name: string;
  needs: string;
  /** What the installation grants now; absent when nothing. */
  granted?: string;
}

export type InstallationStatus = 'active' | 'suspended' | 'missing_permissions' | 'disabled' | 'uninstalled';

export interface JobView extends Omit<JobSummary, 'status'> {
  /** `queued`: it waits in the admission queue, and has no job record yet. */
  status: JobSummary['status'] | 'queued';
  /** Its time in the admission queue, when it waited there (before it started, or instead). */
  queue?: QueueView;
  /** An owner can cancel it while it waits. */
  canCancel?: boolean;
  canStop?: boolean;
  canResume?: boolean;
  result: JobResult;
  issueUrl?: string;
  prUrl?: string;
  /** Logs the API can serve (the job uploaded them; they may since have expired). */
  logs: string[];
  /** The console can run it again (jobs/status.ts retryable). `retriedAs` says when it already was. */
  retryable: boolean;
  /** Its agents' trace in the tenant's Honeycomb, when telemetry was on for it. */
  telemetry?: JobTelemetryView;
  /** The installation's telemetry setting now (nonsecret), apart from what this job exported. */
  telemetryStatus: TelemetryInstallationStatus;
}

/** `unknown`: the settings could not be read, which is not the same as not configured. */
export type TelemetryInstallationStatus = 'not_configured' | 'paused' | 'enabled' | 'unknown';

export interface JobTelemetryView {
  traceId: string;
  traceUrl?: string;
  conversationId?: string;
  /** Where the traces went, by name: the link's destination, for the console's words. */
  destination?: string;
  /** The conversation's spans, in the destination's own search. */
  conversationUrl?: string;
  /** What to do there, when it takes a step. */
  conversationHint?: string;
  /** The conversation in the destination's conversation view itself (Honeycomb: when the deployment set HONEYCOMB_TIMELINE_URL). */
  timelineUrl?: string;
  timelineLabel?: string;
  /**
   * The job's moments, in order: each run's agent, the first red and green test runs, a failed
   * verify command or step, each where it was in the job, with a link to its span when it was sent.
   */
  timeline?: JobTimelineEntry[];
  /** What the job's runs added up to. */
  totals?: TelemetryTotals;
  /** Nothing was sent (no destination): the timeline and totals are the runner's own reading. */
  local?: boolean;
  spans: number;
  exported: number;
  failed: number;
  lastError?: string;
}

export interface JobTimelineEntry {
  kind: TelemetryMarkKind;
  /** The trace opened at this span, when it was sent and the destination has links. */
  url?: string;
  offsetMs?: number;
  durationMs?: number;
  run?: string;
  agent?: string;
  failed?: boolean;
  thrashing?: boolean;
  verdict?: string;
  step?: string;
}

/** What links on a job need besides its own record: the time, and the deployment's Agent Timeline template. */
export interface JobViewOptions {
  now?: number;
  timelineTemplate?: string | null;
  /** The installation's settings could not be read. */
  settingsUnavailable?: boolean;
}

export interface Overview {
  tenant: TenantSummary;
  installation: {
    status: InstallationStatus;
    /** False when GitHub could not be asked just now: status is then the last known one. */
    checked: boolean;
    missingPermissions: MissingPermission[];
  };
  repositories: { fullName: string; htmlUrl?: string; private?: boolean; reachable: boolean; configured: boolean; paused: boolean }[];
  config: {
    activeVersion: number | null;
    publishedAt?: string;
    publishedBy?: string;
    /** The labels that start a job, by repository (enabled repositories only; at most 10): what to try first. */
    triggers?: { repository: string; label: string }[];
    /** Configured repositories GitHub now has under another id (recreated, or a new one by that name): the config must be published again for them. */
    replaced?: string[];
    /** Agents the viewer's labels run that this deployment no longer runs: those workflows need another agent. */
    retiredAgents?: string[];
  };
  keys: AgentKeyView[];
  /** Whether traces are set up to go somewhere (a destination and its key), and are on. */
  telemetry: { configured: boolean; enabled: boolean };
  /**
   * Counts over the last 30 days, or, when `window` says a list is not complete, over its latest
   * ACTIVITY_SAMPLE entries (running counts the latest jobs only).
   */
  activity: {
    window: { deliveries: number; deliveriesComplete: boolean; jobs: number; jobsComplete: boolean };
    deliveries: Partial<Record<DeliveryRecord['disposition'], number>>;
    jobs: Partial<Record<JobResult, number>>;
    lastDeliveryAt?: string;
    /** When the first job ever started: kept on the tenant, so it outlives the job records. */
    firstJobAt?: string;
    running: number;
  };
}

export interface StatusServiceDeps {
  store: Store;
  github: Pick<GitHubFlows, 'member' | 'installation' | 'repositories'>;
  agentKeys: Pick<AgentKeyService, 'list'>;
  readLog?: LogReader;
  /** Asks the launcher to run a job's event again (jobs/retry.ts). Absent: retrying is not offered. */
  requestRetry?: (installationId: number, jobId: string, by?: string) => Promise<RetryResult>;
  requestStop?: (installationId: number, jobId: string, by: string, reason: string) => Promise<StopResult | null>;
  /** The admission queue's entries (jobs/queue-store.ts), read only. Absent: no queue is shown. */
  queue?: Pick<QueueStore, 'list' | 'get'>;
  /** Asks the webhook function to cancel a queued job (jobs/queue.ts cancel). */
  requestQueueCancel?: (installationId: number, jobId: string, by: string) => Promise<QueueCancelResult>;
  /** The stack's ResultRetentionDays: a job's logs are expired once it ended longer ago than that. */
  resultRetentionDays?: number;
  /** HONEYCOMB_TIMELINE_URL, as parseTimelineTemplate accepted it: a link to a conversation in Agent Timeline. */
  timelineTemplate?: string | null;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

const JOB_ID = /^job_[A-Za-z0-9_-]{8,64}$/;
const LOG_NAMES = new Set(['updraft.log', 'run.log']);

/** What the installation grants below what jobs need (broker JOB_PERMISSIONS). */
export function missingPermissions(granted: Record<string, string> | undefined): MissingPermission[] {
  const out: MissingPermission[] = [];
  for (const [name, needs] of Object.entries(JOB_PERMISSIONS)) {
    const has = granted?.[name];
    if ((LEVEL[has ?? ''] ?? 0) < (LEVEL[needs] ?? 0)) out.push({ name, needs, ...(has ? { granted: has } : {}) });
  }
  return out;
}

/** Where a trace went, in words: Honeycomb, CloudWatch, or a custom endpoint's host. */
function destinationName(s: LinkSettings & { otlp?: { endpoint: string } }, host?: string): string {
  if (s.provider === 'cloudwatch') return 'CloudWatch';
  if (s.provider !== 'otlp') return 'Honeycomb';
  if (host) return host;
  const parsed = s.otlp ? parseOtlpEndpoint(s.otlp.endpoint) : null;
  return parsed && 'host' in parsed ? parsed.host : 'your OTLP endpoint';
}

/**
 * The conversation Agent Timeline groups a job's traces under: what its runner reported, else
 * `owner/repo#issue` for a job of an issue (the runner's telemetry.mjs names it the same way).
 */
export function conversationOf(job: JobSummary): string | undefined {
  return job.detail?.telemetry?.conversationId ?? (job.issue !== undefined ? `${job.repository}#${job.issue}` : undefined);
}

export function jobView(job: JobSummary, telemetry: TelemetrySettings | null = null, { now = Date.now(), timelineTemplate = null, settingsUnavailable = false }: JobViewOptions = {}): JobView {
  const telemetryStatus: TelemetryInstallationStatus = settingsUnavailable ? 'unknown' : !telemetry?.key ? 'not_configured' : telemetry.enabled ? 'enabled' : 'paused';
  const view: JobView = { ...job, telemetryStatus, result: jobResult(job), retryable: retryable(job), logs: job.deliveryId && job.microvmId ? (job.detail?.logs ?? []) : [] };
  if (job.issue !== undefined) view.issueUrl = `https://github.com/${job.repository}/issues/${job.issue}`;
  if (job.detail?.prUrl) view.prUrl = job.detail.prUrl;
  // A job of a pull request's event (its review loop): that pull request, whatever the run reported.
  else if (job.pullRequest !== undefined) view.prUrl = `https://github.com/${job.repository}/pull/${job.pullRequest}`;
  const t = job.detail?.telemetry;
  if (t) {
    const startedAt = t.startedAt ?? job.createdAt;
    // Links only to what reached the destination (nothing local, nothing from an export that sent
    // nothing), and only to the destination it reached: the job's own snapshot of it.
    const sent = !t.local && t.exported > 0 ? linkSettingsForJob(t.destination, t.sentTo, telemetry) : null;
    // A custom destination's trace link is its span link to the root, when its template wants a span.
    const url = traceUrl(sent, t.traceId, startedAt, job.finishedAt, sent?.provider === 'otlp' && sent.links?.trace?.includes('{span_id}') ? t.rootSpanId : undefined);
    const conversationId = conversationOf(job);
    const queryUrl = conversationId ? conversationUrl(sent, conversationId, startedAt, now) : null;
    const timeline = conversationId ? timelineUrl(timelineTemplate, sent, conversationId, startedAt, now) : null;
    const entries: JobTimelineEntry[] = (t.marks ?? []).map((m) => {
      const { spanId, sent: _sent, ...rest } = m;
      const at = m.sent === false ? null : traceUrl(sent, t.traceId, startedAt, job.finishedAt, spanId);
      return { ...rest, ...(at ? { url: at } : {}) };
    });
    view.telemetry = {
      traceId: t.traceId,
      ...(url ? { traceUrl: url } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(sent ? { destination: destinationName(sent, t.destination?.host) } : {}),
      ...(queryUrl ? { conversationUrl: queryUrl, ...(sent?.provider === 'honeycomb' ? { conversationHint: 'In the results, select the conversation id to open it in Agent Timeline.' } : {}) } : {}),
      ...(timeline ? { timelineUrl: timeline, timelineLabel: 'Open in Agent Timeline' } : {}),
      ...(entries.length ? { timeline: entries } : {}),
      ...(t.totals ? { totals: t.totals } : {}),
      ...(t.local ? { local: true } : {}),
      spans: t.spans,
      exported: t.exported,
      failed: t.failed,
      ...(t.lastError ? { lastError: t.lastError } : {}),
    };
  }
  return view;
}

/**
 * A queued job that has no job record (it waits, or it ended without starting) as a job of the
 * console: `queued` while it waits, never running, finished or throttled. Its link is its stable id.
 */
export function queuedJobView(e: QueueEntry, now: number, position?: number): JobView {
  const waiting = isWaiting(e);
  const view: JobView = {
    jobId: e.jobId,
    repository: e.repository,
    ...(e.issue !== undefined ? { issue: e.issue } : {}),
    ...(e.pullRequest !== undefined ? { pullRequest: e.pullRequest } : {}),
    ...(e.label ? { label: e.label } : {}),
    ...(e.sender ? { sender: e.sender } : {}),
    createdAt: new Date(e.enqueuedAt).toISOString(),
    status: waiting ? 'queued' : 'finished',
    ...(waiting ? {} : { outcome: `queue_${e.state}`, finishedAt: new Date(e.outcome?.at ?? now).toISOString() }),
    configVersion: e.configVersion,
    deliveryId: e.deliveryId,
    executionMode: e.route === 'standard' ? 'standard' : 'subscription',
    result: waiting ? 'queued' : e.state === 'canceled' ? 'canceled' : e.state === 'admitted' ? 'other' : 'not_run',
    retryable: false,
    logs: [],
    telemetryStatus: 'not_configured',
    queue: queueView(e, now, position),
  };
  if (e.issue !== undefined) view.issueUrl = `https://github.com/${e.repository}/issues/${e.issue}`;
  else if (e.pullRequest !== undefined) view.prUrl = `https://github.com/${e.repository}/pull/${e.pullRequest}`;
  return view;
}

/** A resume that did not happen, as the error the console shows. */
function resumed(outcome: ResumeOutcome): void {
  if (outcome === 'resumed') return;
  if (outcome === 'not_paused') throw new FlowError('not_found', 404, 'This workflow is not paused');
  if (outcome === 'stop_pending') throw new FlowError('stop_pending', 409, 'Wait until execution has stopped before resuming automation');
  throw new FlowError('pause_changed', 409, 'A newer stop controls this workflow; look at it again before resuming');
}

export function createStatusService({ store, github, agentKeys, readLog, requestRetry, requestStop, queue, requestQueueCancel, resultRetentionDays = 30, timelineTemplate = null, now = Date.now, log = (e) => console.log(JSON.stringify(e)) }: StatusServiceDeps) {
  const view = (job: JobSummary, telemetry: TelemetrySettings | null, settingsUnavailable = false) => jobView(job, telemetry, { now: now(), timelineTemplate, settingsUnavailable });
  const settingsOf = (installationId: number) => store.getTelemetry(installationId).then((t) => ({ t, unavailable: false }), () => ({ t: null, unavailable: true }));
  const limitOf = (raw: unknown) => {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? Math.min(n, LIST_LIMIT) : 50;
  };
  // The queue is read for display only; a failure to read it never hides the jobs.
  const queueOf = (installationId: number): Promise<QueueEntry[]> => (queue ? queue.list(installationId, LIST_LIMIT).catch(() => []) : Promise.resolve([]));

  return {
    async overview(caller: Caller, installationId: number): Promise<Overview> {
      const { tenant, summary, githubLogin } = await github.member(caller, installationId);
      // GitHub's view first: suspended or gone there is what the tenant needs to know, even before our record has caught up.
      let checked = true;
      let gh: Awaited<ReturnType<typeof github.installation>> | undefined;
      try {
        gh = await github.installation(caller, installationId);
      } catch (err) {
        checked = false;
        log({ installationId, warning: `could not read the installation from GitHub: ${(err as Error)?.name}` });
      }
      const missing = gh ? missingPermissions(gh.permissions) : [];
      const status: InstallationStatus =
        tenant.disabledReason === 'uninstalled' || gh === null
          ? 'uninstalled'
          : (gh && gh.suspendedAt !== null) || tenant.disabledReason === 'suspended'
            ? 'suspended'
            : tenant.disabledReason === 'admin'
              ? 'disabled'
              : missing.length > 0
                ? 'missing_permissions'
                : 'active';

      const [reachable, version, keys, deliveries, jobs, telemetrySettings] = await Promise.all([
        status === 'uninstalled' || status === 'suspended' ? Promise.resolve([]) : github.repositories(caller, installationId).then((r) => r.repositories).catch(() => []),
        tenant.activeConfigVersion !== undefined ? store.getConfigVersion(installationId, tenant.activeConfigVersion) : Promise.resolve(null),
        agentKeys.list(caller, installationId).then((v) => v.keys),
        store.listDeliveries(installationId, ACTIVITY_SAMPLE + 1),
        store.listRecentJobs(installationId, ACTIVITY_SAMPLE + 1),
        store.getTelemetry(installationId).catch(() => null),
      ]);

      const configured = version?.dispatch?.repositories ?? {};
      const repos = new Map<string, Overview['repositories'][number]>();
      const liveIds = new Map(reachable.map((r) => [r.fullName.toLowerCase(), r.id]));
      for (const r of reachable) {
        const c = configured[r.fullName.toLowerCase()];
        repos.set(r.fullName.toLowerCase(), { fullName: r.fullName, htmlUrl: r.htmlUrl, private: r.private, reachable: true, configured: Boolean(c), paused: Boolean(c?.paused) });
      }
      // Configured, but the installation no longer reaches it: a job for it cannot run.
      for (const [name, c] of Object.entries(configured)) {
        if (!repos.has(name)) repos.set(name, { fullName: name, reachable: false, configured: true, paused: Boolean(c.paused) });
      }

      // Counts of the last 30 days (what is kept), or of the latest ACTIVITY_SAMPLE when there are more.
      const deliveriesComplete = deliveries.length <= ACTIVITY_SAMPLE;
      const jobsComplete = jobs.length <= ACTIVITY_SAMPLE;
      deliveries.splice(ACTIVITY_SAMPLE);
      jobs.splice(ACTIVITY_SAMPLE);
      const results = jobs.map(jobResult);
      // A tenant whose first job started before the marker existed: seeded from the job records
      // still kept (one the broker started has a duration), before they expire. Best effort.
      let firstJobAt = tenant.firstJobAt;
      if (!firstJobAt) {
        const started = jobs.filter((j) => j.durationSeconds !== undefined).map((j) => j.createdAt).sort()[0];
        if (started) {
          firstJobAt = started;
          await store.markFirstJob(installationId, started).catch((err: unknown) => log({ installationId, warning: `could not seed the first job: ${(err as Error)?.name}` }));
        }
      }
      // The labels the viewer can start a job with: in a repository the installation reaches and
      // is not paused, by the dispatch rules' own actor check, named as the installation reports
      // the repository.
      const viewer = githubLogin?.toLowerCase();
      // Dispatch matches the published id too: a repository recreated under the same name is not the configured one.
      const replaced = Object.entries(configured)
        .filter(([name, c]) => liveIds.has(name) && liveIds.get(name) !== c.id)
        .map(([name]) => repos.get(name)!.fullName)
        .sort();
      // The viewer's labels, then only those whose agents this deployment runs (the launcher
      // refuses the others). A version from before keys were recorded: its keys are not known here.
      const offered = new Set<string>(Object.values(AGENT_KEY_ENV));
      const retired = new Set<string>();
      const triggers = viewer
        ? Object.entries(configured)
            .filter(([name, c]) => !c.paused && repos.get(name)?.reachable && liveIds.get(name) === c.id)
            .flatMap(([name, c]) =>
              c.triggers
                .filter((t) => (t.actors ?? c.actors ?? []).includes(viewer))
                .filter((t) => {
                  const off = (t.keys ?? c.keys ?? []).filter((k) => !offered.has(k));
                  for (const k of off) for (const [agent, key] of Object.entries(SUPPORTED_AGENT_KEY_ENV)) if (key === k) retired.add(agent);
                  return off.length === 0;
                })
                .map((t) => ({ repository: repos.get(name)!.fullName, label: t.label })),
            )
            .slice(0, 10)
        : [];
      const retiredAgents = triggers.length ? [] : [...retired].sort();
      return {
        tenant: summary,
        installation: { status, checked, missingPermissions: missing },
        repositories: [...repos.values()].sort((a, b) => Number(b.configured) - Number(a.configured) || a.fullName.localeCompare(b.fullName)),
        config: {
          activeVersion: tenant.activeConfigVersion ?? null,
          ...(version ? { publishedAt: version.publishedAt, publishedBy: version.publishedBy } : {}),
          ...(triggers.length ? { triggers } : {}),
          ...(replaced.length ? { replaced } : {}),
          ...(retiredAgents.length ? { retiredAgents } : {}),
        },
        keys,
        telemetry: { configured: Boolean(telemetrySettings?.key), enabled: Boolean(telemetrySettings?.key && telemetrySettings.enabled) },
        activity: {
          deliveries: deliveryCounts(deliveries),
          jobs: countBy(results.filter((r) => r !== 'running')),
          ...(deliveries[0] ? { lastDeliveryAt: deliveries[0].at } : {}),
          ...(firstJobAt ? { firstJobAt } : {}),
          running: results.filter((r) => r === 'running').length,
          window: { deliveries: deliveries.length, deliveriesComplete, jobs: jobs.length, jobsComplete },
        },
      };
    },

    async deliveries(caller: Caller, installationId: number, limit?: unknown): Promise<{ deliveries: DeliveryRecord[] }> {
      await github.member(caller, installationId);
      return { deliveries: await store.listDeliveries(installationId, limitOf(limit)) };
    },

    async jobs(caller: Caller, installationId: number, limit?: unknown): Promise<{ jobs: JobView[] }> {
      const member = await github.member(caller, installationId);
      const [jobs, settings, entries] = await Promise.all([store.listRecentJobs(installationId, limitOf(limit)), settingsOf(installationId), queueOf(installationId)]);
      const active = requestStop && member.summary.role === 'owner' ? new Set((await store.listActiveJobs()).filter((j) => j.installationId === installationId).map((j) => j.jobId)) : new Set<string>();
      const known = new Set(jobs.map((j) => j.jobId));
      const order = positions(entries);
      const byId = new Map(entries.map((e) => [e.jobId, e]));
      // Queued work first, oldest first (the order it starts in); then the jobs as before.
      const queued = entries.filter((e) => isWaiting(e) && !known.has(e.jobId)).sort((a, b) => a.enqueuedAt - b.enqueuedAt)
        .map((e) => ({ ...queuedJobView(e, now(), order.get(e.jobId)), canCancel: !!requestQueueCancel && member.summary.role === 'owner' && e.state === 'queued' }));
      return { jobs: [...queued, ...jobs.map((j) => {
        const e = byId.get(j.jobId);
        return { ...view(j, settings.t, settings.unavailable), ...(e ? { queue: queueView(e, now()) } : {}), canResume: member.summary.role === 'owner' && j.stop?.confirmedAt !== undefined && j.stop.resumedAt === undefined,
          canStop: !!requestStop && member.summary.role === 'owner' && (j.status !== 'finished' || !!j.stop && (j.stop.confirmedAt === undefined || !!j.stop.error) || active.has(j.jobId)) };
      })] };
    },

    /** The installation's admission queue: what waits (in the order it starts) and what ended without starting, kept 30 days. */
    async queue(caller: Caller, installationId: number, limit?: unknown): Promise<{ queue: JobView[] }> {
      const member = await github.member(caller, installationId);
      const entries = (await queueOf(installationId)).slice(0, limitOf(limit));
      const order = positions(entries);
      return { queue: entries.map((e) => ({ ...queuedJobView(e, now(), order.get(e.jobId)), canCancel: !!requestQueueCancel && member.summary.role === 'owner' && e.state === 'queued' })) };
    },

    /** An owner cancels a job that waits in the queue (one that has started is stopped instead). */
    async cancelQueued(caller: Caller, installationId: number, jobId: string): Promise<{ jobId: string; state: string }> {
      const member = await github.member(caller, installationId);
      if (member.summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only an installation owner may cancel queued jobs');
      if (!JOB_ID.test(jobId) || !queue) throw new FlowError('not_found', 404, 'There is no such queued job in this installation');
      // Read here first: only this tenant's entry is ever named to the webhook function.
      if (!(await queue.get(installationId, jobId))) throw new FlowError('not_found', 404, 'There is no such queued job in this installation');
      if (!requestQueueCancel) throw new FlowError('cancel_unavailable', 503, 'Canceling queued jobs is unavailable in this deployment');
      const out = await requestQueueCancel(installationId, jobId, member.githubLogin ?? caller.sub);
      if (!out.ok) throw new FlowError(out.code, out.status, out.message);
      return { jobId, state: out.state };
    },

    /**
     * One job, every kept attempt of its delivery, and the other recent jobs of its conversation
     * (the issue's implement run, reviews and revisions; newest first, among the latest jobs).
     */
    async job(caller: Caller, installationId: number, jobId: string): Promise<{ job: JobView; deliveries: DeliveryRecord[]; conversation: JobView[] }> {
      const member = await github.member(caller, installationId);
      const job = JOB_ID.test(jobId) ? await store.getJobSummary(installationId, jobId) : null;
      // The queue entry under the same id: the job before it started (its link works from the
      // acknowledgement on), or why it never did, and how long it waited before it started.
      const entry = JOB_ID.test(jobId) && queue ? await queue.get(installationId, jobId).catch(() => null) : null;
      if (!job && entry) {
        const order = isWaiting(entry) ? positions(await queueOf(installationId)) : new Map<string, number>();
        const deliveries = await store.listDeliveriesOf(installationId, entry.deliveryId).catch(() => []);
        return { job: { ...queuedJobView(entry, now(), order.get(entry.jobId)), canCancel: !!requestQueueCancel && member.summary.role === 'owner' && entry.state === 'queued' }, deliveries, conversation: [] };
      }
      if (!job) throw new FlowError('not_found', 404, 'There is no such job in this installation (jobs are kept 30 days)');
      // Every kept attempt of its delivery: GitHub reuses the id on a redelivery, so an earlier
      // attempt (one that failed to launch, a day before) is part of this job's history.
      const conversationId = conversationOf(job);
      const [deliveries, settings, recent] = await Promise.all([
        job.deliveryId ? store.listDeliveriesOf(installationId, job.deliveryId) : Promise.resolve([]),
        settingsOf(installationId),
        conversationId ? store.listRecentJobs(installationId, LIST_LIMIT).catch(() => []) : Promise.resolve([]),
      ]);
      const conversation = recent.filter((j) => j.jobId !== job.jobId && conversationOf(j) === conversationId).map((j) => view(j, settings.t, settings.unavailable));
      const execution = requestStop && member.summary.role === 'owner' ? await store.getJob(jobId) : null;
      return { job: { ...view(job, settings.t, settings.unavailable), ...(entry ? { queue: queueView(entry, now()) } : {}), canResume: member.summary.role === 'owner' && job.stop?.confirmedAt !== undefined && job.stop.resumedAt === undefined,
        canStop: !!requestStop && member.summary.role === 'owner' && (job.status !== 'finished' || !!job.stop && (job.stop.confirmedAt === undefined || !!job.stop.error) || !!execution && execution.releasedAt === undefined) }, deliveries, conversation };
    },

    /**
     * Runs a job that did not finish its work again, as a new job (the launcher starts it, so
     * the tenant's quotas, keys and active configuration apply as they do to any job). Members only.
     */
    async retry(caller: Caller, installationId: number, jobId: string): Promise<{ jobId: string }> {
      const member = await github.member(caller, installationId);
      const job = JOB_ID.test(jobId) ? await store.getJobSummary(installationId, jobId) : null;
      if (!job) throw new FlowError('not_found', 404, 'There is no such job in this installation (jobs are kept 30 days)');
      if (job.stop && member.summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only an installation owner may restart intentionally stopped work');
      if (job.stop && job.stop.confirmedAt === undefined) throw new FlowError('stop_pending', 409, 'Wait until execution has stopped before retrying');
      if (job.retriedAs) throw new FlowError('already_retried', 409, notRetryableMessage(job));
      if (!retryable(job)) throw new FlowError('not_retryable', 409, notRetryableMessage(job));
      if (!requestRetry) throw new FlowError('retry_unavailable', 503, 'Retrying is not available in this deployment');
      const out = job.stop ? await requestRetry(installationId, jobId, member.githubLogin ?? caller.sub) : await requestRetry(installationId, jobId);
      if (!out.ok) throw new FlowError(out.code, out.status, out.message);
      log({ installationId, jobId, retried: true, newJobId: out.jobId });
      return { jobId: out.jobId };
    },

    async stop(caller: Caller, installationId: number, jobId: string, reason: string): Promise<StopResult> {
      const member = await github.member(caller, installationId);
      if (member.summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only an installation owner may stop jobs');
      if (!JOB_ID.test(jobId)) throw new FlowError('not_found', 404, 'There is no such job in this installation');
      if (!requestStop) throw new FlowError('stop_unavailable', 503, 'Stopping jobs is unavailable in this deployment');
      const out = await requestStop(installationId, jobId, member.githubLogin ?? caller.sub, reason);
      if (!out) throw new FlowError('not_found', 404, 'There is no such job in this installation');
      return out;
    },

    /** Resume future automation without replaying an event or duplicating the current PR. */
    async resume(caller: Caller, installationId: number, jobId: string): Promise<{ resumed: true }> {
      const member = await github.member(caller, installationId);
      if (member.summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only an installation owner may resume stopped automation');
      const summary = JOB_ID.test(jobId) ? await store.getJobSummary(installationId, jobId) : null;
      const job = summary ? await store.getJob(jobId) : null;
      if (!job || job.installationId !== installationId || !job.stop) throw new FlowError('not_found', 404, 'There is no stopped job in this installation; a paused workflow can be resumed from its page');
      if (job.stop.confirmedAt === undefined) throw new FlowError('stop_pending', 409, 'Wait until execution has stopped before resuming automation');
      // The pause this job's stop made, on any of its subjects, as a whole; a newer stop is never lifted.
      resumed(await resumeJobPause(store, { ...job, stop: job.stop }, stopSubjects(job, summary?.detail?.prNumber), member.githubLogin ?? caller.sub, now()));
      return { resumed: true };
    },

    /**
     * Resume a paused workflow (`<repositoryId>-i<issue>` or `-p<n>`) from the pause itself: the
     * only way once the stopped job's records have expired. `expected` is the pause the owner saw,
     * so a newer stop is never lifted by mistake.
     */
    async resumeWorkflow(caller: Caller, installationId: number, workflowId: string, expected?: { jobId: string; at: number; subject?: number }): Promise<{ resumed: true }> {
      const member = await github.member(caller, installationId);
      if (member.summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only an installation owner may resume stopped automation');
      const m = /^([0-9]{1,20})-[ip]([0-9]{1,10})$/.exec(workflowId);
      if (!m) throw new FlowError('not_found', 404, 'There is no such workflow in this installation');
      // The subject the pause was shown on (the workflow's pull request, say), or the workflow's own.
      // Only exactly the pause named is lifted, wherever it is read: a newer one answers 409.
      const subject = expected?.subject ?? Number(m[2]);
      resumed(await resumeWorkflowPause(store, { installationId, repositoryId: Number(m[1]), subject, ...(expected ? { expected: { jobId: expected.jobId, at: expected.at } } : {}), by: member.githubLogin ?? caller.sub, at: now() }));
      return { resumed: true };
    },

    /** The end of one of a job's logs. The job is looked up in the tenant's own partition, so another tenant's log cannot be named. */
    async log(caller: Caller, installationId: number, jobId: string, name: string): Promise<{ name: string; text: string; size: number; truncated: boolean }> {
      await github.member(caller, installationId);
      const job = JOB_ID.test(jobId) ? await store.getJobSummary(installationId, jobId) : null;
      if (!job || !LOG_NAMES.has(name) || !jobView(job).logs.includes(name) || !readLog) {
        throw new FlowError('not_found', 404, 'This job has no such log');
      }
      // Read first: a log that is still there is served, however old. Only a missing one is
      // judged by the job's age against the stack's ResultRetentionDays, which the daily cleanup
      // deletes by: past it, expired. The object is written a little before the job's finish, so
      // the cleanup can take it up to that much before finish + retention: an hour of margin.
      const key = `tenants/${installationId}/results/${job.deliveryId}/${job.microvmId}/${name}`;
      const out = await readLog(key, LOG_TAIL_BYTES);
      if (!out) {
        const ended = Date.parse(job.finishedAt ?? job.createdAt);
        if (now() > ended + resultRetentionDays * DAY_MS - HOUR_MS) {
          throw new FlowError('log_expired', 410, 'This log has expired; logs are kept for the retention period of the deployment');
        }
        // Within the retention, and S3 has no such object for us (or would not say): not expired,
        // so something is wrong. Logged to look into; never shown as expired.
        log({ installationId, jobId, warning: `a log within the retention could not be read: ${key}` });
        throw new FlowError('log_unavailable', 502, 'The log could not be read just now; try again later');
      }
      // The runner redacted it with the job's keys; this catches anything shaped like a key it did not know.
      let text = redact(out.text);
      const truncated = out.size > LOG_TAIL_BYTES;
      // Cut to its end: start at a whole line.
      if (truncated) text = text.slice(text.indexOf('\n') + 1);
      return { name, text, size: out.size, truncated };
    },
  };
}

export type StatusService = ReturnType<typeof createStatusService>;
