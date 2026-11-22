import { JOB_PERMISSIONS } from '../broker/broker.js';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows, type TenantSummary } from '../flows/github.js';
import type { RetryResult } from '../jobs/retry.js';
import { countBy, deliveryCounts, jobResult, retryable, type JobResult } from '../jobs/status.js';
import type { DeliveryRecord, JobSummary, Store, TelemetrySettings } from '../store/store.js';
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

export interface JobView extends JobSummary {
  result: JobResult;
  issueUrl?: string;
  prUrl?: string;
  /** Logs the API can serve (the job uploaded them; they may since have expired). */
  logs: string[];
  /** The console can run it again (jobs/status.ts retryable). `retriedAs` says when it already was. */
  retryable: boolean;
  /** Its agents' trace in the tenant's Honeycomb, when telemetry was on for it. */
  telemetry?: JobTelemetryView;
}

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
  requestRetry?: (installationId: number, jobId: string) => Promise<RetryResult>;
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

export function jobView(job: JobSummary, telemetry: TelemetrySettings | null = null, { now = Date.now(), timelineTemplate = null }: JobViewOptions = {}): JobView {
  const view: JobView = { ...job, result: jobResult(job), retryable: retryable(job), logs: job.deliveryId && job.microvmId ? (job.detail?.logs ?? []) : [] };
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

export function createStatusService({ store, github, agentKeys, readLog, requestRetry, resultRetentionDays = 30, timelineTemplate = null, now = Date.now, log = (e) => console.log(JSON.stringify(e)) }: StatusServiceDeps) {
  const view = (job: JobSummary, telemetry: TelemetrySettings | null) => jobView(job, telemetry, { now: now(), timelineTemplate });
  const limitOf = (raw: unknown) => {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? Math.min(n, LIST_LIMIT) : 50;
  };

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
      await github.member(caller, installationId);
      const [jobs, telemetry] = await Promise.all([store.listRecentJobs(installationId, limitOf(limit)), store.getTelemetry(installationId).catch(() => null)]);
      return { jobs: jobs.map((j) => view(j, telemetry)) };
    },

    /**
     * One job, every kept attempt of its delivery, and the other recent jobs of its conversation
     * (the issue's implement run, reviews and revisions; newest first, among the latest jobs).
     */
    async job(caller: Caller, installationId: number, jobId: string): Promise<{ job: JobView; deliveries: DeliveryRecord[]; conversation: JobView[] }> {
      await github.member(caller, installationId);
      const job = JOB_ID.test(jobId) ? await store.getJobSummary(installationId, jobId) : null;
      if (!job) throw new FlowError('not_found', 404, 'There is no such job in this installation (jobs are kept 30 days)');
      // Every kept attempt of its delivery: GitHub reuses the id on a redelivery, so an earlier
      // attempt (one that failed to launch, a day before) is part of this job's history.
      const conversationId = conversationOf(job);
      const [deliveries, telemetry, recent] = await Promise.all([
        job.deliveryId ? store.listDeliveriesOf(installationId, job.deliveryId) : Promise.resolve([]),
        store.getTelemetry(installationId).catch(() => null),
        conversationId ? store.listRecentJobs(installationId, LIST_LIMIT).catch(() => []) : Promise.resolve([]),
      ]);
      const conversation = recent.filter((j) => j.jobId !== job.jobId && conversationOf(j) === conversationId).map((j) => view(j, telemetry));
      return { job: view(job, telemetry), deliveries, conversation };
    },

    /**
     * Runs a job that did not finish its work again, as a new job (the launcher starts it, so
     * the tenant's quotas, keys and active configuration apply as they do to any job). Members only.
     */
    async retry(caller: Caller, installationId: number, jobId: string): Promise<{ jobId: string }> {
      await github.member(caller, installationId);
      const job = JOB_ID.test(jobId) ? await store.getJobSummary(installationId, jobId) : null;
      if (!job) throw new FlowError('not_found', 404, 'There is no such job in this installation (jobs are kept 30 days)');
      if (job.retriedAs) throw new FlowError('already_retried', 409, 'This job was already retried');
      if (!retryable(job)) {
        throw new FlowError('not_retryable', 409, jobResult(job) === 'running' ? 'This job is still running' : 'This job did not end in a way that can be retried');
      }
      if (!requestRetry) throw new FlowError('retry_unavailable', 503, 'Retrying is not available in this deployment');
      const out = await requestRetry(installationId, jobId);
      if (!out.ok) throw new FlowError(out.code, out.status, out.message);
      log({ installationId, jobId, retried: true, newJobId: out.jobId });
      return { jobId: out.jobId };
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
