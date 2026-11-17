// OWNER: GitHub/poller workstream.
//
// Issue-event poller. Per configured repo:
//   1. No checkpoint: record the newest event id as the starting point (nothing enqueued),
//      unless `backfillSince` is set, in which case matching events created at/after it
//      are processed.
//   2. Otherwise conditional GET of page 1 with the stored ETag (304 → nothing new), then
//      page back until events are older than (newest created_at seen by the last scan
//      minus OVERLAP_MS), or GitHub's last servable page. API errors leave the checkpoint
//      untouched so the whole range is retried.
//   3. Events newer than the id watermark, or inside the overlap window, are evaluated
//      oldest → newest. The endpoint orders by created_at, and ids are not monotonic in
//      that order (see client.ts), so stopping at the first already-seen id could skip a
//      new event on the next page. Re-evaluated events dedupe on the jobs unique key.
//   4. Matching labeled events are checked against the issue's current state and routed;
//      jobs and the new checkpoint are committed in one transaction, so a crash replays
//      the batch and the unique (repo, workflow, event) key drops the duplicates.
//   5. Every queued job is re-checked and canceled if its issue closed, lost the trigger
//      label, or its workflow disappeared from config.
import { allowedActorsFor, workflowId, type FactoryConfig, type RepositoryConfig, type WorkflowConfig } from '../config/schema.js';
import { recordError, type Db } from '../db/database.js';
import { cancelQueuedJob, commitPollBatch, getCheckpoint, listQueuedJobs, type Checkpoint, type NewJob } from '../db/ingest.js';
import { GitHubError, type GitHubApi, type GitHubIssue, type GitHubIssueEvent, type IssueEventsPage } from '../github/api.js';
import { labelEquals, selectPool } from '../routing.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope, type Job, type RepoRef } from '../types.js';
import type { Logger } from '../util/log.js';

/** Events per page. Keep constant: the stored page-1 ETag depends on the query string. */
export const EVENTS_PER_PAGE = 100;
/**
 * Max event pages per scan. Equal to GitHub's own limit for this endpoint (page 301
 * returns 422), so a scan only stops short of the checkpoint when GitHub cannot serve
 * older events at all.
 */
export const MAX_PAGES = 300;
/** How far before the newest previously seen created_at to rescan (see scanWindow). */
export const OVERLAP_MS = 5 * 60 * 1000;
export const BACKOFF_BASE_SECONDS = 30;
export const BACKOFF_MAX_SECONDS = 15 * 60;

export interface RepoBackoffState {
  failures: number;
  /** Epoch millis before which the repo is not polled. */
  until: number;
}

export interface PollerDeps {
  db: Db;
  api: GitHubApi;
  config: FactoryConfig;
  log: Logger;
  now?: () => number;
  /**
   * Per-repo backoff state keyed by repo ID. Kept in memory across cycles; defaults to
   * a map attached to `db`, so successive pollOnce calls with the same db share it.
   */
  backoff?: Map<number, RepoBackoffState>;
}

export interface RepoPollResult {
  repo: string;
  ok: boolean;
  eventsSeen: number;
  jobsEnqueued: number;
  error?: string;
  /** True when the repo was skipped because it is backing off after errors. */
  skipped?: boolean;
}

export interface PollSummary {
  repos: RepoPollResult[];
  jobsCanceled: number;
}

const defaultBackoff = new WeakMap<Db, Map<number, RepoBackoffState>>();

function backoffFor(deps: PollerDeps): Map<number, RepoBackoffState> {
  if (deps.backoff) return deps.backoff;
  let m = defaultBackoff.get(deps.db);
  if (!m) defaultBackoff.set(deps.db, (m = new Map()));
  return m;
}

/** Backoff delay in seconds after `failures` consecutive failures, honoring Retry-After. */
export function backoffSeconds(failures: number, retryAfterSeconds: number | null): number {
  const exp = Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.max(0, failures - 1));
  return Math.max(exp, retryAfterSeconds ?? 0);
}

/** Deleted (410), transferred (301) or no longer readable (404). */
function isGone(err: unknown): boolean {
  return err instanceof GitHubError && [301, 404, 410].includes(err.status);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type IssueLookup = (repo: RepoRef, issueNumber: number) => Promise<GitHubIssue>;

/** Per-cycle cache: one GET per issue per cycle (errors are cached too). */
function cachedIssueLookup(api: GitHubApi): IssueLookup {
  const cache = new Map<string, Promise<GitHubIssue>>();
  return (repo, n) => {
    const key = `${repo.id}#${n}`;
    let p = cache.get(key);
    if (!p) {
      p = api.getIssue(repo, n);
      p.catch(() => {}); // handled by the awaiting caller
      cache.set(key, p);
    }
    return p;
  };
}

function findRepo(config: FactoryConfig, repoId: number): { fullName: string; cfg: RepositoryConfig } | null {
  for (const [fullName, cfg] of Object.entries(config.repositories)) {
    if (cfg.id === repoId) return { fullName, cfg };
  }
  return null;
}

function actorAllowed(config: FactoryConfig, wf: WorkflowConfig, actor: string | null): boolean {
  if (!actor) return false;
  return allowedActorsFor(config, wf).some((a) => a.toLowerCase() === actor.toLowerCase());
}

/**
 * One poll cycle: for every configured repo, ingest new issue events and enqueue
 * matching jobs; then re-check queued jobs and cancel ones whose issue closed or
 * lost its dispatch label. Never throws for per-repo API errors (records them).
 */
export async function pollOnce(deps: PollerDeps): Promise<PollSummary> {
  const now = deps.now ?? Date.now;
  const backoff = backoffFor(deps);
  const getIssue = cachedIssueLookup(deps.api);
  const results: RepoPollResult[] = [];

  for (const [fullName, cfg] of Object.entries(deps.config.repositories)) {
    const repo: RepoRef = { id: cfg.id, fullName };
    const log = deps.log.child({ repo: fullName });
    const b = backoff.get(repo.id);
    if (b && b.until > now()) {
      log.debug('repo backing off; skipping this cycle', { until: new Date(b.until).toISOString() });
      results.push({
        repo: fullName,
        ok: false,
        skipped: true,
        eventsSeen: 0,
        jobsEnqueued: 0,
        error: `backing off until ${new Date(b.until).toISOString()}`,
      });
      continue;
    }
    try {
      results.push(await pollRepo(deps, repo, cfg, getIssue, log));
      backoff.delete(repo.id);
    } catch (err) {
      const failures = (b?.failures ?? 0) + 1;
      const retryAfter = err instanceof GitHubError ? err.retryAfterSeconds : null;
      const delay = backoffSeconds(failures, retryAfter);
      backoff.set(repo.id, { failures, until: now() + delay * 1000 });
      const message = `poll failed: ${errMessage(err)}; checkpoint kept, retrying in ${delay}s`;
      log.warn(message, { failures });
      safeRecordError(deps, { scope: 'poll', repoFullName: fullName, message });
      results.push({ repo: fullName, ok: false, eventsSeen: 0, jobsEnqueued: 0, error: errMessage(err) });
    }
  }

  const jobsCanceled = await recheckQueuedJobs(deps, getIssue, backoff);
  return { repos: results, jobsCanceled };
}

function safeRecordError(deps: PollerDeps, e: { scope: string; message: string; repoFullName?: string; jobId?: string }) {
  try {
    recordError(deps.db, { ...e, at: new Date((deps.now ?? Date.now)()).toISOString() });
  } catch (err) {
    deps.log.error('could not record error', { error: errMessage(err), original: e.message });
  }
}

async function pollRepo(
  deps: PollerDeps,
  repo: RepoRef,
  cfg: RepositoryConfig,
  getIssue: IssueLookup,
  log: Logger,
): Promise<RepoPollResult> {
  const { api, db } = deps;
  const cp = getCheckpoint(db, repo.id);
  const base: RepoPollResult = { repo: repo.fullName, ok: true, eventsSeen: 0, jobsEnqueued: 0 };

  // First poll without backfill: start at the current stream position.
  if (!cp && !cfg.backfillSince) {
    const page1 = await api.listIssueEvents(repo, { page: 1, perPage: EVENTS_PER_PAGE });
    const newest = maxId(page1.events);
    const newestAt = maxCreatedAt(page1.events);
    commitPollBatch(db, {
      repoId: repo.id,
      fullName: repo.fullName,
      lastEventId: newest,
      lastEventCreatedAt: newestAt,
      // Everything up to the newest visible event predates the subscription.
      subscriptionStart: { eventId: newest ?? 0, createdAt: null },
      page1CoversOverlap: coversOverlap(page1.events, page1.nextPage, newestAt),
      etag: page1.etag,
      jobs: [],
      now: deps.now,
    });
    log.info('subscription initialized at current event position; earlier events are not enqueued', {
      lastEventId: newest,
    });
    return base;
  }

  const firstBackfill = !cp && cfg.backfillSince ? cfg.backfillSince : null;
  const window = scanWindow(cp, firstBackfill !== null ? Date.parse(firstBackfill) : null);
  const afterStart = subscriptionFilter(cp);

  const byId = new Map<number, GitHubIssueEvent>();
  let page1Etag: string | null = null;
  let page = 1;
  let historyEnd: string | null = null;
  let legacyExtraPage = false;
  let page1Events: GitHubIssueEvent[] | null = null;
  let page1Next: number | null = null;
  // A page-1 304 may end the cycle only when page 1 alone reaches past the overlap: then
  // any event that could still matter would sort onto page 1 and change its ETag. When the
  // overlap spans pages, fetch page 1 unconditionally so every scan sees the whole overlap
  // (buildJobs needs later unlabeled events next to the applications they supersede).
  const conditionalEtag = cp?.page1CoversOverlap === true ? cp.etag : null;
  for (let fetched = 0; ; fetched++) {
    if (fetched >= MAX_PAGES) {
      historyEnd = `reached GitHub's ${MAX_PAGES}-page limit for issue events`;
      break;
    }
    let res: IssueEventsPage;
    try {
      res = await api.listIssueEvents(repo, {
        page,
        perPage: EVENTS_PER_PAGE,
        etag: page === 1 ? conditionalEtag : null,
      });
    } catch (err) {
      // GitHub answers 422 past the last page it is willing to serve.
      if (page > 1 && err instanceof GitHubError && err.status === 422) {
        historyEnd = `GitHub stopped serving issue events at page ${page}`;
        break;
      }
      throw err; // checkpoint stays where it was; the whole range is retried later
    }
    if (page === 1) {
      if (res.notModified) return base; // only requested when page 1 covers the overlap
      page1Etag = res.etag;
      page1Events = res.events;
      page1Next = res.nextPage;
    }
    // Pages shift while new events arrive, so dedupe by id across pages.
    for (const e of res.events) byId.set(e.id, e);
    if (res.nextPage === null || legacyExtraPage) break;
    if (res.events.some(window.pastBoundary)) {
      if (!window.legacy) break;
      legacyExtraPage = true; // no stored time: read one more page past the id boundary
    }
    page = res.nextPage;
  }

  if (historyEnd && window.boundaryKnown) {
    // The boundary was never reached and GitHub will not serve anything older, so the
    // unread gap cannot be recovered by retrying. Record it loudly, then advance.
    const message = `${historyEnd} before reaching the last checkpoint; older events were not seen and may have been missed`;
    log.error(message);
    safeRecordError(deps, { scope: 'poll', repoFullName: repo.fullName, message });
  }

  const all = [...byId.values()];
  const unseen = all.filter((e) => window.inWindow(e) && afterStart(e)).sort((a, b) => a.id - b.id);
  const jobs = await buildJobs(deps, repo, cfg, unseen, getIssue, log);
  const inserted = commitPollBatch(db, {
    repoId: repo.id,
    fullName: repo.fullName,
    lastEventId: maxId(all),
    lastEventCreatedAt: maxCreatedAt(all),
    subscriptionStart: { eventId: null, createdAt: firstBackfill },
    // page1Events is null only if page 1 itself failed with 422, which the loop never allows.
    page1CoversOverlap:
      page1Events === null
        ? null
        : coversOverlap(page1Events, page1Next, newestCreatedAt(cp?.lastEventCreatedAt ?? null, maxCreatedAt(all))),
    etag: page1Etag,
    jobs,
    now: deps.now,
  });
  for (const j of inserted) {
    log.info('job queued', { job: j.id, issue: j.issueNumber, workflow: j.workflowId, pool: j.pool, event: j.eventId });
  }
  return { ...base, eventsSeen: unseen.length, jobsEnqueued: inserted.length };
}

interface ScanWindow {
  /**
   * Events to evaluate. Re-evaluating an already-processed event is harmless: the
   * jobs table's (repo, workflow, event) key drops duplicates.
   */
  inWindow: (e: GitHubIssueEvent) => boolean;
  /** True for an event at or past the point where scanning can stop. */
  pastBoundary: (e: GitHubIssueEvent) => boolean;
  /** Whether a boundary exists at all (false: scan everything GitHub serves). */
  boundaryKnown: boolean;
  /** Checkpoint predates last_event_created_at: fall back to the id boundary plus one page. */
  legacy: boolean;
}

/**
 * Events that existed before the subscription started are never dispatched, even when a
 * later scan's overlap window reaches back over them (initialization creates no jobs, so
 * the jobs unique key cannot suppress them).
 */
function subscriptionFilter(cp: Checkpoint | null): (e: GitHubIssueEvent) => boolean {
  const startId = cp?.startEventId ?? null;
  const startAt = cp?.startCreatedAt ? Date.parse(cp.startCreatedAt) : null;
  return (e) => (startId === null || e.id > startId) && (startAt === null || Date.parse(e.createdAt) >= startAt);
}

/** Does page 1 reach past the overlap boundary that the *next* scan will use? */
function coversOverlap(page1: GitHubIssueEvent[], nextPage: number | null, newestAt: string | null): boolean {
  // A short last page is the whole stream: any new event lands among its first slots. A
  // *full* last page is not: one late event sorting after all of it starts page 2 and
  // leaves page 1 (and its ETag) unchanged.
  if (nextPage === null && page1.length < EVENTS_PER_PAGE) return true;
  if (newestAt === null) return false;
  const boundary = Date.parse(newestAt) - OVERLAP_MS;
  return page1.some((e) => Date.parse(e.createdAt) < boundary);
}

function newestCreatedAt(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * Which events to read and where to stop. The endpoint orders by created_at desc while
 * ids follow insertion order, so an event with a new (higher) id can sit below an
 * already-seen one, even on the next page. Any event inserted after the last scan has
 * created_at >= (newest created_at that scan saw) - (insertion/replication lag), so
 * scanning back to that time minus OVERLAP_MS covers every unseen event.
 */
function scanWindow(cp: Checkpoint | null, backfillSince: number | null): ScanWindow {
  const t = (e: GitHubIssueEvent) => Date.parse(e.createdAt);
  if (backfillSince !== null) {
    return {
      inWindow: (e) => t(e) >= backfillSince,
      pastBoundary: (e) => t(e) < backfillSince,
      boundaryKnown: true,
      legacy: false,
    };
  }
  const watermark = cp?.lastEventId ?? null;
  const newestSeen = cp?.lastEventCreatedAt ? Date.parse(cp.lastEventCreatedAt) : Number.NaN;
  if (Number.isFinite(newestSeen)) {
    const boundary = newestSeen - OVERLAP_MS;
    return {
      inWindow: (e) => watermark === null || e.id > watermark || t(e) >= boundary,
      pastBoundary: (e) => t(e) < boundary,
      boundaryKnown: true,
      legacy: false,
    };
  }
  return {
    inWindow: (e) => watermark === null || e.id > watermark,
    pastBoundary: (e) => watermark !== null && e.id <= watermark,
    boundaryKnown: watermark !== null,
    legacy: watermark !== null,
  };
}

function maxId(events: GitHubIssueEvent[]): number | null {
  return events.length ? Math.max(...events.map((e) => e.id)) : null;
}

function maxCreatedAt(events: GitHubIssueEvent[]): string | null {
  let best: string | null = null;
  for (const e of events) if (best === null || Date.parse(e.createdAt) > Date.parse(best)) best = e.createdAt;
  return best;
}

async function buildJobs(
  deps: PollerDeps,
  repo: RepoRef,
  cfg: RepositoryConfig,
  events: GitHubIssueEvent[],
  getIssue: IssueLookup,
  log: Logger,
): Promise<NewJob[]> {
  const jobs: NewJob[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.event !== 'labeled' || !ev.label || !ev.issue || ev.issue.isPullRequest) continue;
    const label = ev.label;
    const issueNumber = ev.issue.number;
    const workflows = cfg.workflows.filter((wf) => labelEquals(wf.trigger.label, label));
    if (!workflows.length) continue;

    // Label removed again later in this same batch: this application is superseded.
    const removedLater = events
      .slice(i + 1)
      .some((e) => e.event === 'unlabeled' && e.issue?.number === issueNumber && e.label && labelEquals(e.label, label));

    for (const wf of workflows) {
      const wfId = workflowId(wf);
      const ctx = { issue: issueNumber, workflow: wfId, event: ev.id, actor: ev.actor };
      if (!actorAllowed(deps.config, wf, ev.actor)) {
        log.info('ignoring trigger label applied by an actor not in the allowlist', ctx);
        continue;
      }
      if (removedLater) {
        log.info('ignoring trigger label that was removed later in the same batch', ctx);
        continue;
      }
      let issue: GitHubIssue;
      try {
        issue = await getIssue(repo, issueNumber);
      } catch (err) {
        if (isGone(err)) {
          log.info('skipping event: issue was deleted, transferred or is no longer accessible', ctx);
          continue;
        }
        throw err;
      }
      if (issue.isPullRequest) continue;
      if (issue.state !== 'open') {
        log.info('skipping event: issue is closed', ctx);
        continue;
      }
      if (!issue.labels.some((l) => labelEquals(l, wf.trigger.label))) {
        log.info('skipping event: issue no longer carries the trigger label', ctx);
        continue;
      }
      const pool = selectPool(wf.pool, issue.labels);
      const envelope: EventEnvelope = {
        schemaVersion: ENVELOPE_SCHEMA_VERSION,
        type: 'issue.labeled',
        repo: { id: repo.id, fullName: repo.fullName },
        issue: { number: issue.number, title: issue.title, url: issue.htmlUrl },
        eventId: String(ev.id),
        url: issue.htmlUrl,
        actor: ev.actor,
        label,
        labelsAtEnqueue: [...issue.labels],
        createdAt: ev.createdAt,
      };
      jobs.push({
        repoId: repo.id,
        repoFullName: repo.fullName,
        workflowId: wfId,
        eventId: String(ev.id),
        issueNumber: issue.number,
        action: wf.action,
        pool,
        envelope,
      });
    }
  }
  return jobs;
}

export type DispatchCheck = { ok: true } | { ok: false; reason: string };

/** Shared dispatchability check. Throws for transient API errors (never a cancel reason). */
async function evaluateJob(config: FactoryConfig, job: Job, getIssue: IssueLookup): Promise<DispatchCheck> {
  const found = findRepo(config, job.repoId);
  if (!found) return { ok: false, reason: `repository ${job.repoFullName} is no longer configured` };
  const wf = found.cfg.workflows.find((w) => workflowId(w) === job.workflowId);
  if (!wf) return { ok: false, reason: `workflow "${job.workflowId}" no longer exists in config for ${found.fullName}` };
  let issue: GitHubIssue;
  try {
    issue = await getIssue({ id: job.repoId, fullName: found.fullName }, job.issueNumber);
  } catch (err) {
    if (isGone(err)) {
      return { ok: false, reason: `issue #${job.issueNumber} was deleted, transferred or is no longer accessible` };
    }
    throw err;
  }
  if (issue.state !== 'open') return { ok: false, reason: `issue #${job.issueNumber} is closed` };
  if (!issue.labels.some((l) => labelEquals(l, wf.trigger.label))) {
    return { ok: false, reason: `issue #${job.issueNumber} no longer carries trigger label "${wf.trigger.label}"` };
  }
  return { ok: true };
}

async function recheckQueuedJobs(
  deps: PollerDeps,
  getIssue: IssueLookup,
  backoff: Map<number, RepoBackoffState>,
): Promise<number> {
  const now = deps.now ?? Date.now;
  let canceled = 0;
  let queued: Job[];
  try {
    queued = listQueuedJobs(deps.db);
  } catch (err) {
    deps.log.error('could not list queued jobs', { error: errMessage(err) });
    return 0;
  }

  for (const job of queued) {
    const b = backoff.get(job.repoId);
    if (b && b.until > now()) continue; // don't hammer a repo that is failing
    let check: DispatchCheck;
    try {
      check = await evaluateJob(deps.config, job, getIssue);
    } catch (err) {
      deps.log.warn('could not re-check queued job; leaving it queued', { job: job.id, error: errMessage(err) });
      continue;
    }
    if (!check.ok && cancelQueuedJob(deps.db, job.id, check.reason, deps.now)) {
      canceled++;
      deps.log.info('queued job canceled', { job: job.id, repo: job.repoFullName, issue: job.issueNumber, reason: check.reason });
    }
  }
  return canceled;
}

/**
 * Final check before the worker starts a job: issue still open and still carries
 * the workflow's trigger label. Used by the worker immediately before a claim.
 * Resolves `{ ok: false, reason }` when the job should be canceled; rejects with a
 * GitHubError for transient API failures (rate limit, network, 5xx), in which case
 * the caller should leave the job queued and try later.
 */
export async function checkJobDispatchable(deps: Pick<PollerDeps, 'api' | 'config'>, job: Job): Promise<DispatchCheck> {
  return evaluateJob(deps.config, job, (repo, n) => deps.api.getIssue(repo, n));
}
