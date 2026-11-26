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
//      label, or its workflow disappeared from config; in live mode also if the label
//      application was superseded or the issue was edited since by someone not allowed to
//      dispatch. That includes jobs queued in this same cycle, so an edit made between the
//      label and the poll that ingested it is caught here (and again before the agent starts).
//
// With repositories.<repo>.revise, each repository's cycle also reads change requests on the PRs
// the worker opened and queues revision jobs (reviews.ts). Those jobs sit in the same queue but
// are checked by their own rules, in step 5 and before start. With repositories.<repo>.review the
// same read also queues a reviewer job for each new head of such a PR (review-jobs.ts).
import { allowedActorsFor, workflowId, type UpdraftConfig, type RepositoryConfig, type WorkflowConfig } from '../config/schema.js';
import { recordError, type Db } from '../db/database.js';
import { cancelQueuedJob, commitPollBatch, getCheckpoint, listQueuedJobs, type Checkpoint, type NewJob } from '../db/ingest.js';
import {
  GitHubError,
  type GitHubApi,
  type GitHubIssue,
  type GitHubIssueBodyEdit,
  type GitHubIssueEvent,
  type IssueEventsPage,
} from '../github/api.js';
import { labelEquals } from '../routing.js';
import { classifyIssue } from '../classify.js';
import { describeRouting, routeJob, triageWanted } from '../tier-routing.js';
import { createTriageRunner, type TriageOutcome, type TriageRunner } from '../triage/triage.js';
import { ENVELOPE_SCHEMA_VERSION, labelEventIdOf, reviewOf, revisionOf, type EventEnvelope, type IssueSnapshot, type Job, type RepoRef } from '../types.js';
import type { Logger } from '../util/log.js';
import { checkReviewDispatchable, queuedReviewProblem } from './review-jobs.js';
import { checkRevisionDispatchable, pollRepoReviews, queuedRevisionProblem } from './reviews.js';
import { controlsEnabled, pollRepoControls } from './controls.js';
import { holdPausedJob, pauseProblem } from '../control/local.js';
import { holdUnderPause } from '../db/control.js';
import type { WorkerIdentity } from '../github/credentials.js';

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
  config: UpdraftConfig;
  log: Logger;
  now?: () => number;
  /**
   * Per-repo backoff state keyed by repo ID. Kept in memory across cycles; defaults to
   * a map attached to `db`, so successive pollOnce calls with the same db share it.
   */
  backoff?: Map<number, RepoBackoffState>;
  /** Directory of the config file, for resolving a relative agents.<name>.command used by triage. */
  configDir?: string;
  /** CLI triage of ambiguous issues (docs/triage.md). Default: launch the configured agent CLI. Tests inject a stub. */
  triage?: TriageRunner;
}

export interface RepoPollResult {
  repo: string;
  ok: boolean;
  eventsSeen: number;
  jobsEnqueued: number;
  /** Revision jobs queued from change requests (repositories.<repo>.revise); absent when that is off. */
  revisionsQueued?: number;
  /** Reviewer jobs queued (repositories.<repo>.review); absent when nothing was queued. */
  reviewsQueued?: number;
  /** Mention commands handled (docs/controls.md); absent when there were none. */
  controlsHandled?: number;
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
export function isGone(err: unknown): boolean {
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

export function findRepo(config: UpdraftConfig, repoId: number): { fullName: string; cfg: RepositoryConfig } | null {
  for (const [fullName, cfg] of Object.entries(config.repositories)) {
    if (cfg.id === repoId) return { fullName, cfg };
  }
  return null;
}

function actorAllowed(config: UpdraftConfig, wf: WorkflowConfig, actor: string | null): boolean {
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
  let revisionJobsCanceled = 0;
  // Human steering (docs/controls.md): who the worker is decides which mentions are for it.
  let identity: WorkerIdentity | null = null;

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
      const polled = await pollRepo(deps, repo, cfg, getIssue, log);
      // Change requests on PRs the worker opened (reviews.ts). Under the same error handling: a
      // failure here backs the repository off, and each of the two keeps its own checkpoint.
      const reviews = await pollRepoReviews(deps, repo, cfg, log);
      revisionJobsCanceled += reviews?.jobsCanceled ?? 0;
      // Commands by mention: after the events, so a pause given now holds what they just queued
      // (the re-check below), and under the same error handling.
      let controls = 0;
      if (controlsEnabled(deps.config)) {
        identity ??= await deps.api.getWorkerIdentity();
        controls = await pollRepoControls(deps, repo, cfg, identity, log);
      }
      results.push(
        {
          ...(reviews ? { ...polled, revisionsQueued: reviews.revisionsQueued, ...(reviews.reviewsQueued ? { reviewsQueued: reviews.reviewsQueued } : {}) } : polled),
          ...(controls ? { controlsHandled: controls } : {}),
        },
      );
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
  return { repos: results, jobsCanceled: jobsCanceled + revisionJobsCanceled };
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

  // First poll without backfill: start at the current stream position. The stream is in
  // created_at order, so an event that already exists can sort onto page 2+ with a higher id
  // than anything on page 1. Snapshot the same overlap later scans re-read, and take the
  // highest id in it as the subscription start; only events inserted after that are new.
  if (!cp && !cfg.backfillSince) {
    const page1 = await api.listIssueEvents(repo, { page: 1, perPage: EVENTS_PER_PAGE });
    const newestAt = maxCreatedAt(page1.events);
    const snapshot = [...page1.events];
    if (newestAt !== null) {
      const boundary = Date.parse(newestAt) - OVERLAP_MS;
      let res = page1;
      for (let page = 2; res.nextPage !== null && !res.events.some((e) => Date.parse(e.createdAt) < boundary); page++) {
        if (page > MAX_PAGES) break;
        try {
          res = await api.listIssueEvents(repo, { page: res.nextPage, perPage: EVENTS_PER_PAGE });
        } catch (err) {
          if (err instanceof GitHubError && err.status === 422) break; // nothing older is served
          throw err; // no checkpoint yet; initialization is retried next cycle
        }
        snapshot.push(...res.events);
      }
    }
    const startId = maxId(snapshot);
    commitPollBatch(db, {
      repoId: repo.id,
      fullName: repo.fullName,
      lastEventId: startId,
      lastEventCreatedAt: newestAt,
      // Everything visible in the overlap snapshot predates the subscription.
      subscriptionStart: { eventId: startId ?? 0, createdAt: null },
      page1CoversOverlap: coversOverlap(page1.events, page1.nextPage, newestAt),
      etag: page1.etag,
      jobs: [],
      now: deps.now,
    });
    log.info('subscription initialized at current event position; earlier events are not enqueued', {
      lastEventId: startId,
      snapshotEvents: snapshot.length,
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
    const routing = j.envelope.routing;
    log.info('job queued', {
      job: j.id,
      issue: j.issueNumber,
      workflow: j.workflowId,
      pool: j.pool,
      event: j.eventId,
      ...(routing?.tier ? { tier: routing.tier, risk: routing.risk, rule: routing.rule, routing: describeRouting(routing) } : {}),
    });
    if (routing?.hold) {
      cancelQueuedJob(db, j.id, `needs human: ${routing.hold}`, deps.now);
      log.warn('job held for a human: no eligible pool', { job: j.id, issue: j.issueNumber, reason: routing.hold });
    }
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

/** Why a label event that matches a workflow queued no job. */
export type IngestSkipReason = 'actor-not-allowed' | 'label-removed' | 'issue-gone' | 'pull-request' | 'issue-closed' | 'label-missing';

/**
 * The ingestion rules: which of `events` (oldest first, with every later event of the same scan
 * after them) queue a job, checked against each issue's current state. The poller's only way to
 * queue an issue job, and `updraft run-event`'s too (src/poller/webhook.ts). `onSkip` hears why a
 * matching event queued nothing.
 */
export async function buildJobs(
  deps: Pick<PollerDeps, 'config' | 'db' | 'log' | 'configDir' | 'now' | 'triage'>,
  repo: RepoRef,
  cfg: RepositoryConfig,
  events: GitHubIssueEvent[],
  getIssue: IssueLookup,
  log: Logger,
  onSkip?: (reason: IngestSkipReason, message: string) => void,
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
      const skip = (reason: IngestSkipReason, message: string) => {
        log.info(message, ctx);
        onSkip?.(reason, message);
      };
      if (!actorAllowed(deps.config, wf, ev.actor)) {
        skip('actor-not-allowed', 'ignoring trigger label applied by an actor not in the allowlist');
        continue;
      }
      if (removedLater) {
        skip('label-removed', 'ignoring trigger label that was removed later in the same batch');
        continue;
      }
      let issue: GitHubIssue;
      try {
        issue = await getIssue(repo, issueNumber);
      } catch (err) {
        if (isGone(err)) {
          skip('issue-gone', 'skipping event: issue was deleted, transferred or is no longer accessible');
          continue;
        }
        throw err;
      }
      if (issue.isPullRequest) {
        onSkip?.('pull-request', 'skipping event: it is on a pull request');
        continue;
      }
      if (issue.state !== 'open') {
        skip('issue-closed', 'skipping event: issue is closed');
        continue;
      }
      if (!issue.labels.some((l) => labelEquals(l, wf.trigger.label))) {
        skip('label-missing', 'skipping event: issue no longer carries the trigger label');
        continue;
      }
      const routeDeps = { poolAvailable: (p: string) => (deps.config.pools[p]?.agents ?? []).some((a) => deps.config.agents[a]?.enabled) };
      let routing = routeJob(wf.pool, wf.tiers, issue, routeDeps);
      const triageCfg = wf.tiers?.triage;
      if (triageCfg && triageWanted(routing, issue.labels, triageCfg)) {
        // Ambiguous (or explicitly requested): one bounded, cached, read-only CLI triage, then route again with its answer.
        const classified = classifyIssue(issue);
        const run = (deps.triage ?? createTriageRunner({ db: deps.db, config: deps.config, log: deps.log, ...(deps.configDir ? { configDir: deps.configDir } : {}), ...(deps.now ? { now: deps.now } : {}) }));
        const outcome = await run(triageCfg, {
          repoId: repo.id,
          repo: repo.fullName,
          action: wf.action,
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          localSignals: classified.reasons,
          localRisk: classified.risk,
        }).catch((err: unknown): TriageOutcome => ({ ok: false, agent: triageCfg.agent, reason: `triage failed: ${err instanceof Error ? err.message : String(err)}` }));
        routing = routeJob(wf.pool, wf.tiers, issue, { ...routeDeps, triage: outcome });
        const note = routing.triage;
        log.info('issue triaged', {
          issue: issue.number,
          workflow: wfId,
          agent: triageCfg.agent,
          origin: note?.origin,
          ...(outcome.ok ? { complexity: outcome.verdict.complexity, risk: outcome.verdict.risk, confidence: outcome.verdict.confidence } : { reason: outcome.reason }),
          tier: routing.tier,
        });
      }
      const pool = routing.pool;
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
        ...(wf.tiers ? { routing } : {}),
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

/** `issue` is the issue as fetched by the check, for the executor (live runs render it into the prompt). */
/** `retry`: not now, and not a reason to cancel either; the job stays queued for the next pass (a reviewer job whose pushed head GitHub does not show yet, #197). */
export type DispatchCheck = { ok: true; issue?: IssueSnapshot } | { ok: false; reason: string; retry?: true };

/** Shared dispatchability check. Throws for transient API errors (never a cancel reason). */
type IssueEventsLookup = (repo: RepoRef, issueNumber: number) => Promise<GitHubIssueEvent[]>;
type IssueBodyEditLookup = (repo: RepoRef, issueNumber: number) => Promise<GitHubIssueBodyEdit>;

/**
 * Live mode: is the label application that queued this job still the one in force, and is its
 * actor still allowed? The issue carrying the label isn't enough: if the label was removed and
 * reapplied by someone outside the allowlist, the reapplication is rejected at ingestion but the
 * label is back on the issue. A newer application by an allowed actor queues its own job.
 * Returns a cancel reason, or the issue's events and the application's position in them.
 */
async function triggerApplication(
  config: UpdraftConfig,
  wf: WorkflowConfig,
  job: Job,
  repo: RepoRef,
  getEvents: IssueEventsLookup,
): Promise<{ problem: string } | { events: GitHubIssueEvent[]; index: number }> {
  let events: GitHubIssueEvent[];
  try {
    events = await getEvents(repo, job.issueNumber);
  } catch (err) {
    if (isGone(err)) return { problem: `issue #${job.issueNumber} was deleted, transferred or is no longer accessible` };
    throw err;
  }
  const label = wf.trigger.label;
  // Oldest first, in GitHub's order (created_at ties keep their real order).
  const index = events.findLastIndex(
    (e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label !== null && labelEquals(e.label, label),
  );
  const latest = events[index];
  // A follow-up job (docs/dependencies.md) carries on the work the original label application asked for.
  if (!latest || latest.event !== 'labeled' || String(latest.id) !== labelEventIdOf(job)) {
    return {
      problem: `the "${label}" label application that queued this job is no longer the current one (the label was removed or reapplied since)`,
    };
  }
  if (!actorAllowed(config, wf, latest.actor)) {
    return { problem: `"${label}" was applied by ${latest.actor ?? 'an unknown actor'}, who is not an allowed actor for this workflow` };
  }
  return { events, index };
}

/**
 * Live mode: is the issue text the agent would be given text an allowed actor stands behind?
 * Applying the trigger label approves the title and body as they were then. Whoever opened the
 * issue can still edit both without being able to label, so an edit made after the application
 * by anyone outside the allowlist withdraws that approval; applying the label again (a new event
 * and a new job) approves the edited text. Only the newest edit of each counts: an allowed
 * actor who edits the text has seen what they saved.
 *
 * Call this only after the text handed to the agent was fetched. An edit that lands after these
 * lookups is then not in that text, and one that landed before them is seen here.
 * Returns a cancel reason, or null when the text is approved.
 */
async function issueEditProblem(
  config: UpdraftConfig,
  wf: WorkflowConfig,
  job: Job,
  repo: RepoRef,
  application: { events: GitHubIssueEvent[]; index: number },
  getBodyEdit: IssueBodyEditLookup,
): Promise<string | null> {
  const { events, index } = application;
  const appliedAt = Date.parse(events[index]!.createdAt);
  // Timestamps have one-second resolution, so "not provably before" is the only safe reading of
  // a tie (and of a time that does not parse).
  const beforeApplication = (at: string) => Date.parse(at) < appliedAt;
  const reason = (what: string, who: string | null) =>
    `issue #${job.issueNumber}'s ${what} was edited by ${who ?? 'an unknown user'} after the "${wf.trigger.label}" label was applied; ` +
    'remove and re-apply the label to dispatch the edited issue';

  // Title changes are `renamed` events, with the actor who made them.
  const rename = events.findLast((e, i) => e.event === 'renamed' && (i > index || !beforeApplication(e.createdAt)));
  if (rename && !actorAllowed(config, wf, rename.actor)) return reason('title', rename.actor);

  let edit: GitHubIssueBodyEdit;
  try {
    edit = await getBodyEdit(repo, job.issueNumber);
  } catch (err) {
    if (isGone(err)) return `issue #${job.issueNumber} was deleted, transferred or is no longer accessible`;
    throw err; // unknown is not "unedited": the job stays queued until this can be read
  }
  if (edit.lastEditedAt !== null && !beforeApplication(edit.lastEditedAt) && !actorAllowed(config, wf, edit.editor)) {
    return reason('body', edit.editor);
  }
  return null;
}

async function evaluateJob(
  config: UpdraftConfig,
  job: Job,
  getIssue: IssueLookup,
  getEvents: IssueEventsLookup,
  getBodyEdit: IssueBodyEditLookup,
): Promise<DispatchCheck> {
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
  if (config.execution.mode === 'live') {
    const repo: RepoRef = { id: job.repoId, fullName: found.fullName };
    // Both lookups run after `issue` was fetched; issueEditProblem depends on that order.
    const application = await triggerApplication(config, wf, job, repo, getEvents);
    if ('problem' in application) return { ok: false, reason: application.problem };
    const edited = await issueEditProblem(config, wf, job, repo, application, getBodyEdit);
    if (edited) return { ok: false, reason: edited };
  }
  return { ok: true, issue: { title: issue.title, body: issue.body, labels: issue.labels, url: issue.htmlUrl } };
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
    // A paused workflow (docs/controls.md) starts nothing: its queued work is held for resume.
    const paused = pauseProblem(deps.db, job);
    if (paused) {
      if (holdPausedJob(deps.db, job, paused, deps.now)) {
        canceled++;
        deps.log.info('queued job held: its workflow is paused', { job: job.id, repo: job.repoFullName, issue: job.issueNumber });
      }
      continue;
    }
    let check: DispatchCheck;
    try {
      if (revisionOf(job)) {
        // A revision job is not judged by its issue's label: see reviews.ts.
        const problem = queuedRevisionProblem(deps.config, deps.db, job);
        check = problem ? { ok: false, reason: problem } : { ok: true };
      } else if (reviewOf(job)) {
        // Nor is a reviewer job: see review-jobs.ts.
        const problem = queuedReviewProblem(deps.config, deps.db, job);
        check = problem ? { ok: false, reason: problem } : { ok: true };
      } else {
        check = await evaluateJob(
          deps.config,
          job,
          getIssue,
          (repo, n) => deps.api.listEventsForIssue(repo, n),
          (repo, n) => deps.api.getIssueBodyEdit(repo, n),
        );
      }
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
 * the workflow's trigger label; in live mode, also that the label application that queued
 * the job is still the current one, its actor is still allowed, and nobody outside the allowlist
 * has edited the issue's title or body since. Used by the worker immediately before a claim.
 * Resolves `{ ok: false, reason }` when the job should be canceled; rejects with a
 * GitHubError for transient API failures (rate limit, network, 5xx), in which case
 * the caller should leave the job queued and try later.
 */
export async function checkJobDispatchable(deps: Pick<PollerDeps, 'api' | 'config' | 'now'> & { db?: Db }, job: Job): Promise<DispatchCheck> {
  // A paused workflow (docs/controls.md): the job is not started, and resume puts it back.
  const paused = deps.db ? pauseProblem(deps.db, job) : null;
  if (paused) {
    holdUnderPause(deps.db!, job.repoId, job.issueNumber, job.id);
    return { ok: false, reason: paused };
  }
  const check = (j: Job) =>
    evaluateJob(
      deps.config,
      j,
      (repo, n) => deps.api.getIssue(repo, n),
      (repo, n) => deps.api.listEventsForIssue(repo, n),
      (repo, n) => deps.api.getIssueBodyEdit(repo, n),
    );
  // A revision job has its own check; the issue check above only decides whether the issue's
  // text may still be given to the agent.
  if (reviewOf(job)) return checkReviewDispatchable(deps, job, check);
  return revisionOf(job) ? checkRevisionDispatchable(deps, job, check) : check(job);
}
