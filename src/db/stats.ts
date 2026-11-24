// `updraft stats`: what the factory did over a window, computed from the metric_events rollup
// (src/db/metrics.ts) and nothing else, except the current queue snapshot, which reads the jobs
// table as it is now. Read-only. The JSON shape (StatsReport) is documented in docs/stats.md and
// versioned by STATS_JSON_VERSION.
import type { Db } from './database.js';
import type { MergeBlockCode } from './metrics.js';

export const STATS_JSON_VERSION = 1;

export type JobKind = 'implement' | 'revision' | 'review';
export const JOB_KINDS: readonly JobKind[] = ['implement', 'revision', 'review'];
export type FinishedStatus = 'succeeded' | 'failed' | 'interrupted' | 'canceled';
export const FINISHED_STATUSES: readonly FinishedStatus[] = ['succeeded', 'failed', 'interrupted', 'canceled'];
/** How a run ended: its outcome, or canceled (by the user) / not-started (closed before its agent started). */
export type RunEnd = 'succeeded' | 'failed' | 'interrupted' | 'start_failed' | 'canceled' | 'not-started';
export const RUN_ENDS: readonly RunEnd[] = ['succeeded', 'failed', 'interrupted', 'start_failed', 'canceled', 'not-started'];
/** Runs whose agent ran: the ones agent run time is measured over. */
const EXECUTED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'interrupted', 'canceled']);

/** Average, median and 90th percentile of the rows that have the value; `count` is how many do. */
export interface Distribution {
  count: number;
  averageMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
}

/** A distribution over some of `total` rows: the others lack what it needs (see docs/stats.md). */
export interface CoveredDistribution extends Distribution {
  total: number;
}

export interface KindCounts {
  implement: number;
  revision: number;
  review: number;
  /** Jobs whose kind could not be read. */
  unknown: number;
  total: number;
}

export interface StatsSection {
  work: {
    /** Jobs whose latest terminal status was reached in the window, by that status and by kind. */
    finished: Record<FinishedStatus, KindCounts> & { total: KindCounts };
    /** The queue right now (not windowed). */
    current: { queued: KindCounts; running: KindCounts };
  };
  time: {
    /** Agent start to run end, over runs whose agent ran, by job kind and by agent. */
    agentRun: { all: CoveredDistribution; byKind: Record<JobKind, CoveredDistribution>; byAgent: Record<string, CoveredDistribution> };
    /** Job queued to the start of its first run's agent. */
    queueWait: { all: Distribution; byKind: Record<JobKind, Distribution>; byAgent: Record<string, Distribution> };
    /** Trigger label applied to the PR opened, over PRs opened in the window. */
    labelToPr: CoveredDistribution;
    /** PR opened to merged by Updraft, over PRs merged in the window. */
    prToMerge: CoveredDistribution;
  };
  outcomes: {
    prsOpened: number;
    prsMerged: number;
    /** Heads auto-merge gave up on, the PRs they belong to, and the reasons, most frequent first. */
    mergeBlocked: { heads: number; prs: number; reasons: Array<{ code: MergeBlockCode | string; count: number }> };
    runs: Record<RunEnd, number> & { total: number };
    /** Runs that ended failed, by job kind and agent. `verifyFailed`: of these, the ones whose verify commands failed; `verifyUnknown`: no verify result was recorded. */
    failedRuns: { total: number; byKind: Record<JobKind | 'unknown', number>; byAgent: Record<string, number>; verifyFailed: number; verifyUnknown: number };
  };
  review: {
    /** Reviewer runs whose agent ran, and what came of them. */
    reviewerRuns: { total: number; readyToMerge: number; changesRequested: number; failed: number; other: number };
    /** Verdicts recorded, by reviewing agent. */
    verdictsByAgent: Record<string, { readyToMerge: number; changesRequested: number }>;
    /** Change-request rounds: changes-requested verdicts of Updraft's reviewer, and people's "Request changes" reviews that counted. */
    changesRequestedRounds: { reviewer: number; people: number; reviewerQueued: number; peopleQueued: number };
    /** UPDRAFT-FINDINGS counts of changes-requested verdicts. `average` is over `withCount`. */
    findings: { changesRequestedReviews: number; withCount: number; withoutCount: number; total: number; average: number | null; allReviewsWithoutCount: number };
    /** PRs whose first review is in the window, and how many of those got ready-to-merge on their first reviewed head. */
    firstPass: { prs: number; readyToMerge: number; rate: number | null };
    /**
     * Reviewer runs whose agent ran, by the model their selection configured (the key is as in
     * `routing.byModel`; "unknown" before selections were recorded): what each verdict was and the
     * findings it counted. `failed`: no readable verdict, or the agent failed.
     */
    byModel: Record<string, ReviewModelStats>;
  };
  backAndForth: {
    /** PRs opened in the window; the rest of this block counts their whole history. */
    prs: number;
    revisionsPerPr: { average: number | null; max: number | null; distribution: { '0': number; '1': number; '2': number; '3+': number } };
    reviewsPerPr: { average: number | null; max: number | null };
    /** PRs that reached maxRevisions in the window. */
    limitReached: number;
  };
  /** Model-tier measurement (docs/stats.md, "Model tiers"). */
  routing: RoutingStats;
  /** Subscription usage pressure from local signals only. */
  pressure: PressureStats;
  /** Waits on pull requests in other repositories (docs/dependencies.md). */
  dependencies: DependencyStats;
  /** The same window day by day (UTC), oldest first; only days with a fact are listed. */
  daily: DailyStats[];
}

export interface ReviewModelStats {
  adapter: string | null;
  model: string | null;
  effort: string | null;
  /** Reviewer runs whose agent ran. */
  runs: number;
  readyToMerge: number;
  changesRequested: number;
  failed: number;
  /** UPDRAFT-FINDINGS counts over this model's changes-requested verdicts that have one. */
  findings: { total: number; withCount: number; average: number | null };
}

/** One UTC day of the window. Jobs by their latest final status that day; the rest as their facts. */
export interface DailyStats {
  /** YYYY-MM-DD, UTC. */
  day: string;
  jobsSucceeded: number;
  jobsFailed: number;
  prsOpened: number;
  prsMerged: number;
  /** Reviewer verdicts recorded. */
  reviews: number;
  changesRequested: number;
  /** UPDRAFT-FINDINGS counts of that day's changes-requested verdicts. */
  findings: number;
  revisions: number;
}

export interface DependencyStats {
  /** Waits that began in the window. */
  started: number;
  /** Waits that ended in the window, by how they ended. */
  ended: { resumed: number; closed: number; canceled: number; expired: number };
  /** How long the waits that resumed in the window had waited for their pull request to merge. */
  waitToMerge: Distribution;
  /** Waiting right now (not windowed). */
  waitingNow: number;
}

/** A rate with the sample behind it: `low` is the bound of a 95% Wilson interval. */
export interface Rate {
  /** Successes. */
  count: number;
  /** Sample size. */
  of: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}

/** What one tier, profile or model did over the implement jobs attributed to it. */
export interface RouteGroupStats {
  /** Jobs that finished in the window and are attributed to this group (the group of the run that ended them). */
  jobs: number;
  /** Fewer than MIN_SAMPLE jobs: the numbers are anecdotes, not a comparison. */
  smallSample: boolean;
  success: Rate;
  /** Jobs attributed here after at least one escalation, and how many of them succeeded. */
  escalatedIn: { jobs: number; succeeded: number };
  /** Jobs moved to a more capable tier after a run in this group. */
  escalatedOut: number;
  retries: number;
  /** Runs of this group whose verify commands failed. */
  verificationFailures: number;
  /** PRs opened in the window by jobs attributed here, and what review made of them. */
  prsOpened: number;
  reviewed: number;
  reviewReady: Rate;
  changesRequested: number;
  revisions: { average: number | null; total: number };
  labelToPr: CoveredDistribution;
  queueWait: Distribution;
  /** Of these runs' selections, how the model and effort are known. */
  modelSources: Record<string, number>;
}

export interface RoutingStats {
  /** Below this many jobs a group is flagged `smallSample`. */
  minSample: number;
  /** Routing decisions made in the window, by how the pool was chosen and by tier. */
  decisions: { total: number; bySource: Record<string, number>; byTier: Record<string, number>; triageFallbacks: number };
  /** Runs selected in the window; those from before selections were recorded are not counted (they are "unknown" in the groups). */
  selections: number;
  byTier: Record<string, RouteGroupStats>;
  byProfile: Record<string, RouteGroupStats>;
  /** Keyed "<adapter>/<model or cli-default>[ effort <effort>]". The model is the one configured, not one the CLI reported. */
  byModel: Record<string, RouteGroupStats & { adapter: string | null; model: string | null; effort: string | null; modelSource: 'configured' | 'observed' | 'unknown' }>;
}

export interface PressureStats {
  /** Cooldowns started by a recognized CLI usage-limit exit. */
  cooldowns: { count: number; totalMs: number; byName: Record<string, { count: number; totalMs: number; stated: number }> };
  /** Jobs requeued to wait out a usage limit. */
  deferrals: { count: number; byAgent: Record<string, number> };
  /** Runs whose agent could not be started, by profile. */
  unavailable: { startFailedRuns: number; byAgent: Record<string, number> };
  /** Token and credit usage are not recorded: the supported CLIs give no trustworthy figure. */
  tokenUsage: { reported: false };
}

export interface StatsReport {
  version: typeof STATS_JSON_VERSION;
  generatedAt: string;
  window: { label: string; since: string | null; until: string };
  /** The --repo filter, or null. */
  repo: string | null;
  /** Whether a state database was there to read. */
  database: boolean;
  /** metric_events rows in the window, and how many of them migration 13 backfilled. */
  facts: { total: number; backfilled: number };
  overall: StatsSection;
  /** The same per repository with facts in the window or jobs now queued or running, by name. */
  byRepo: Array<{ repo: string; repoId: number; stats: StatsSection }>;
}

interface EventRow {
  id: number;
  kind: string;
  subject_id: string;
  at: string;
  repo_id: number;
  repo_full_name: string | null;
  job_id: string | null;
  job_kind: string | null;
  pr_number: number | null;
  agent: string | null;
  pool: string | null;
  outcome: string | null;
  reason: string | null;
  start_at: string | null;
  wait_ms: number | null;
  findings: number | null;
  backfilled: number;
  // Added by migration 16; NULL on every fact recorded before it.
  tier: string | null;
  requested_tier: string | null;
  risk: string | null;
  adapter: string | null;
  model: string | null;
  effort: string | null;
  model_source: string | null;
  route_source: string | null;
  confidence: number | null;
  hops: number | null;
  retries: number | null;
  head_sha: string | null;
}

/** A row of a database not yet at schema v16 lacks the routing columns: they read as unknown (null). */
function normalize(e: Partial<EventRow>): EventRow {
  return {
    tier: null,
    requested_tier: null,
    risk: null,
    adapter: null,
    model: null,
    effort: null,
    model_source: null,
    route_source: null,
    confidence: null,
    hops: null,
    retries: null,
    head_sha: null,
    ...e,
  } as EventRow;
}

interface QueueRow {
  repo_id: number;
  repo_full_name: string;
  /** waiting: a wait on another repository's pull request (dependency_waits), not a job. */
  status: 'queued' | 'running' | 'waiting';
  job_kind: string | null;
}

/** Linear interpolation between closest ranks (the common "type 7" percentile). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    averageMs: sorted.length ? sum / sorted.length : null,
    medianMs: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
  };
}

function covered(values: readonly (number | null)[]): CoveredDistribution {
  return { ...distribution(values.filter((v): v is number => v !== null)), total: values.length };
}

const ms = (from: string | null, to: string): number | null => {
  if (!from) return null;
  const d = Date.parse(to) - Date.parse(from);
  return Number.isFinite(d) && d >= 0 ? d : null;
};

const kindOf = (k: string | null): JobKind | 'unknown' => (JOB_KINDS.includes(k as JobKind) ? (k as JobKind) : 'unknown');
const agentOf = (a: string | null) => a ?? '(unknown)';
const prKey = (e: { repo_id: number; pr_number: number | null }) => `${e.repo_id}#${e.pr_number}`;

function kindCounts(kinds: Array<string | null>): KindCounts {
  const c: KindCounts = { implement: 0, revision: 0, review: 0, unknown: 0, total: 0 };
  for (const k of kinds) {
    c[kindOf(k)]++;
    c.total++;
  }
  return c;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function byKey<T, V>(rows: readonly T[], key: (r: T) => string, f: (rows: T[]) => V): Record<string, V> {
  return Object.fromEntries([...groupBy(rows, key)].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, f(v)]));
}

/** Below this many jobs a route group is flagged as a small sample. */
export const MIN_SAMPLE = 20;

/** 95% Wilson score interval for `count` successes in `n` trials. */
export function rate(count: number, n: number): Rate {
  if (n === 0) return { count, of: n, rate: null, low: null, high: null };
  const z = 1.96;
  const p = count / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { count, of: n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const UNKNOWN = 'unknown';

function modelLabel(s: EventRow | undefined): string {
  if (!s || !s.adapter) return UNKNOWN;
  return `${s.adapter}/${s.model ?? 'cli-default'}${s.effort ? ` effort ${s.effort}` : ''}`;
}

/**
 * Tier, profile and model views over implement jobs. A job's outcome belongs to the run that
 * ended it (its newest run.selected), so a job escalated from routine to complex counts for
 * complex, flagged `escalatedIn`, and its earlier failed runs count for routine (verification
 * failures, escalatedOut). Runs and jobs from before selections were recorded are "unknown".
 */
function routingSection(windowed: readonly EventRow[], all: readonly EventRow[], jobs: readonly EventRow[], prsOpenedRows: readonly EventRow[]): RoutingStats {
  const of = (rows: readonly EventRow[], kind: string) => rows.filter((e) => e.kind === kind);
  const selections = of(all, 'run.selected');
  const selByRun = new Map(selections.map((s) => [s.subject_id, s]));
  const selsOfJob = groupBy(selections, (s) => s.job_id ?? '');
  /** The job's newest selection at or before `at`. */
  const selAt = (jobId: string | null, than: EventRow | null): EventRow | undefined => {
    const list = jobId ? selsOfJob.get(jobId) : undefined;
    if (!list) return undefined;
    let best: EventRow | undefined;
    for (const s of list) if (than === null || s.at < than.at || (s.at === than.at && s.id < than.id)) best = s; // list is in (at, id) order
    return best;
  };
  const implementJobs = jobs.filter((j) => j.job_kind === 'implement');
  const jobKindOf = new Map<string, string | null>(all.filter((e) => e.job_id && e.job_kind).map((e) => [e.job_id!, e.job_kind]));
  const isImplement = (jobId: string | null) => jobKindOf.get(jobId ?? '') === 'implement';

  const runs = of(windowed, 'run.ended').filter((r) => isImplement(r.job_id));
  const escalations = of(windowed, 'job.escalated');
  const retried = of(windowed, 'job.retried');
  const opened = prsOpenedRows.filter((o) => isImplement(o.job_id));
  const verdictsOf = groupBy(of(all, 'review.verdict'), prKey);
  const revisionsOf = groupBy(of(all, 'revision.pushed'), prKey);

  const dims = {
    tier: (s: EventRow | undefined) => s?.tier ?? UNKNOWN,
    profile: (s: EventRow | undefined, fallback: string | null) => s?.agent ?? fallback ?? UNKNOWN,
    model: (s: EventRow | undefined) => modelLabel(s),
  };
  type Dim = 'tier' | 'profile' | 'model';
  const keyOf = (dim: Dim, s: EventRow | undefined, fallbackAgent: string | null) =>
    dim === 'tier' ? dims.tier(s) : dim === 'profile' ? dims.profile(s, fallbackAgent) : dims.model(s);

  function view(dim: Dim): Map<string, RouteGroupStats & { sample?: EventRow }> {
    const keys = new Map<string, { jobs: EventRow[]; runs: EventRow[]; sample?: EventRow }>();
    const slot = (k: string, s?: EventRow) => {
      let g = keys.get(k);
      if (!g) keys.set(k, (g = { jobs: [], runs: [], sample: s }));
      else if (s && !g.sample) g.sample = s;
      return g;
    };
    const jobKey = new Map<string, string>();
    for (const j of implementJobs) {
      const s = selAt(j.job_id, null);
      const k = keyOf(dim, s, j.agent);
      slot(k, s).jobs.push(j);
      jobKey.set(j.job_id ?? '', k);
    }
    for (const r of runs) {
      const s = selByRun.get(r.subject_id);
      slot(keyOf(dim, s, r.agent), s).runs.push(r);
    }
    const outs = new Map<string, number>();
    for (const e of escalations) {
      if (!isImplement(e.job_id)) continue;
      const k = keyOf(dim, selAt(e.job_id, e), e.agent);
      outs.set(k, (outs.get(k) ?? 0) + 1);
      slot(k);
    }
    const retriesBy = new Map<string, number>();
    for (const e of retried) {
      if (!isImplement(e.job_id)) continue;
      const k = keyOf(dim, selAt(e.job_id, e), null);
      retriesBy.set(k, (retriesBy.get(k) ?? 0) + 1);
      slot(k);
    }
    const openedBy = new Map<string, EventRow[]>();
    for (const o of opened) {
      const k = jobKey.get(o.job_id ?? '') ?? keyOf(dim, selAt(o.job_id, o), o.agent);
      const list = openedBy.get(k);
      if (list) list.push(o);
      else openedBy.set(k, [o]);
      slot(k);
    }

    const out = new Map<string, RouteGroupStats & { sample?: EventRow }>();
    for (const [k, g] of keys) {
      const done = g.jobs.filter((j) => j.outcome === 'succeeded').length;
      const failed = g.jobs.filter((j) => j.outcome === 'failed').length;
      const escalatedJobs = g.jobs.filter((j) => (selAt(j.job_id, null)?.hops ?? 0) > 0);
      const prs = openedBy.get(k) ?? [];
      const prVerdicts = prs.map((p) => verdictsOf.get(prKey(p)) ?? []);
      const reviewedPrs = prVerdicts.filter((v) => v.length > 0);
      const latestReady = reviewedPrs.filter((v) => v.reduce((a, b) => (b.at >= a.at ? b : a)).outcome === 'ready-to-merge').length;
      const revs = prs.map((p) => revisionsOf.get(prKey(p))?.length ?? 0);
      const modelSource: Record<string, number> = {};
      for (const j of g.jobs) {
        const m = selAt(j.job_id, null)?.model_source ?? UNKNOWN;
        modelSource[m] = (modelSource[m] ?? 0) + 1;
      }
      out.set(k, {
        jobs: g.jobs.length,
        smallSample: g.jobs.length < MIN_SAMPLE,
        success: rate(done, done + failed),
        escalatedIn: { jobs: escalatedJobs.length, succeeded: escalatedJobs.filter((j) => j.outcome === 'succeeded').length },
        escalatedOut: outs.get(k) ?? 0,
        retries: retriesBy.get(k) ?? 0,
        verificationFailures: g.runs.filter((r) => r.reason === 'verify-failed').length,
        prsOpened: prs.length,
        reviewed: reviewedPrs.length,
        reviewReady: rate(latestReady, reviewedPrs.length),
        changesRequested: prVerdicts.flat().filter((v) => v.outcome === 'changes-requested').length,
        revisions: { average: revs.length ? revs.reduce((a, b) => a + b, 0) / revs.length : null, total: revs.reduce((a, b) => a + b, 0) },
        labelToPr: covered(prs.map((p) => ms(p.start_at, p.at))),
        queueWait: distribution(g.runs.filter((r) => r.wait_ms !== null).map((r) => r.wait_ms!)),
        modelSources: modelSource,
        sample: g.sample,
      });
    }
    return out;
  }

  const plain = (m: Map<string, RouteGroupStats & { sample?: EventRow }>): Record<string, RouteGroupStats> =>
    Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, { sample: _s, ...v }]) => [k, v]));
  const models = view('model');
  const decided = of(windowed, 'route.decided');
  const count = (rows: readonly EventRow[], f: (r: EventRow) => string) => Object.fromEntries([...groupBy(rows, f)].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.length]));

  return {
    minSample: MIN_SAMPLE,
    decisions: {
      total: decided.length,
      bySource: count(decided, (d) => d.route_source ?? UNKNOWN),
      byTier: count(decided, (d) => d.tier ?? UNKNOWN),
      triageFallbacks: decided.filter((d) => d.route_source === 'fallback').length,
    },
    selections: of(windowed, 'run.selected').length,
    byTier: plain(view('tier')),
    byProfile: plain(view('profile')),
    byModel: Object.fromEntries(
      [...models]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, { sample, ...v }]) => [
          k,
          { ...v, adapter: sample?.adapter ?? null, model: sample?.model ?? null, effort: sample?.effort ?? null, modelSource: (sample?.model_source as 'configured' | 'observed') ?? 'unknown' },
        ]),
    ),
  };
}

function pressureSection(windowed: readonly EventRow[], runs: readonly EventRow[]): PressureStats {
  const cooldowns = windowed.filter((e) => e.kind === 'capacity.cooldown');
  const deferred = windowed.filter((e) => e.kind === 'job.deferred');
  const startFailed = runs.filter((r) => r.outcome === 'start_failed');
  return {
    cooldowns: {
      count: cooldowns.length,
      totalMs: cooldowns.reduce((a, c) => a + (c.wait_ms ?? 0), 0),
      byName: byKey(cooldowns, (c) => c.agent ?? UNKNOWN, (rows) => ({
        count: rows.length,
        totalMs: rows.reduce((a, c) => a + (c.wait_ms ?? 0), 0),
        stated: rows.filter((c) => c.reason === 'stated').length,
      })),
    },
    deferrals: { count: deferred.length, byAgent: byKey(deferred, (d) => agentOf(d.agent), (rows) => rows.length) },
    unavailable: { startFailedRuns: startFailed.length, byAgent: byKey(startFailed, (r) => agentOf(r.agent), (rows) => rows.length) },
    tokenUsage: { reported: false },
  };
}

/**
 * One section of the report. `windowed` are the facts in the window; `all` every fact of the same
 * repositories (for the first review of a PR and the whole history of the PRs opened in the window).
 */
function section(windowed: readonly EventRow[], all: readonly EventRow[], queue: readonly QueueRow[]): StatsSection {
  const of = (rows: readonly EventRow[], kind: string) => rows.filter((e) => e.kind === kind);

  // 1. Work items: each job once, with its latest terminal status.
  const latest = new Map<string, EventRow>();
  for (const e of of(windowed, 'job.finished')) {
    const prev = latest.get(e.job_id ?? e.subject_id);
    if (!prev || e.at >= prev.at) latest.set(e.job_id ?? e.subject_id, e);
  }
  const jobs = [...latest.values()];
  const finished = Object.fromEntries(
    FINISHED_STATUSES.map((s) => [s, kindCounts(jobs.filter((j) => j.outcome === s).map((j) => j.job_kind))]),
  ) as Record<FinishedStatus, KindCounts>;

  // 2. Time.
  const runs = of(windowed, 'run.ended');
  const executed = runs.filter((r) => EXECUTED.has(r.outcome ?? ''));
  const runTime = (rows: EventRow[]) => covered(rows.map((r) => ms(r.start_at, r.at)));
  const waited = runs.filter((r) => r.wait_ms !== null);
  const wait = (rows: EventRow[]) => distribution(rows.map((r) => r.wait_ms!));
  const opened = of(windowed, 'pr.opened');
  const merged = of(windowed, 'pr.merged');

  // 3. Outcomes.
  const blocked = of(windowed, 'pr.merge_blocked');
  const reasons = [...groupBy(blocked, (b) => b.reason ?? 'other')]
    .map(([code, rows]) => ({ code, count: rows.length }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const runEnds = Object.fromEntries(RUN_ENDS.map((o) => [o, runs.filter((r) => r.outcome === o).length])) as Record<RunEnd, number>;
  const failed = runs.filter((r) => r.outcome === 'failed');
  const failedByKind = { implement: 0, revision: 0, review: 0, unknown: 0 };
  for (const r of failed) failedByKind[kindOf(r.job_kind)]++;

  // 4. Review.
  const reviewRuns = executed.filter((r) => r.job_kind === 'review');
  const verdicts = of(windowed, 'review.verdict');
  const verdictOfRun = new Map(verdicts.map((v) => [v.subject_id, v.outcome]));
  const changes = verdicts.filter((v) => v.outcome === 'changes-requested');
  const counted = changes.filter((v) => v.findings !== null);
  const findingsTotal = counted.reduce((a, v) => a + v.findings!, 0);
  const requests = of(windowed, 'change_request');
  const human = requests.filter((q) => q.reason === 'changes_requested' && (q.outcome === 'queued' || q.outcome === 'over-limit'));
  const firstReview = new Map<string, EventRow>();
  for (const v of of(all, 'review.verdict')) {
    const prev = firstReview.get(prKey(v));
    if (!prev || v.at < prev.at) firstReview.set(prKey(v), v);
  }
  const windowedVerdict = new Set(verdicts.map((v) => v.subject_id));
  const firsts = [...firstReview.values()].filter((v) => windowedVerdict.has(v.subject_id));
  const firstReady = firsts.filter((v) => v.outcome === 'ready-to-merge').length;
  const selByRun = new Map(of(all, 'run.selected').map((e) => [e.subject_id, e]));
  const reviewByModel = byKey(reviewRuns, (r) => modelLabel(selByRun.get(r.subject_id)), (rows) => {
    const sample = selByRun.get(rows[0]!.subject_id);
    const runIds = new Set(rows.map((r) => r.subject_id));
    const asked = changes.filter((v) => runIds.has(v.subject_id) && v.findings !== null);
    const total = asked.reduce((a, v) => a + v.findings!, 0);
    return {
      adapter: sample?.adapter ?? null,
      model: sample?.model ?? null,
      effort: sample?.effort ?? null,
      runs: rows.length,
      readyToMerge: rows.filter((r) => verdictOfRun.get(r.subject_id) === 'ready-to-merge').length,
      changesRequested: rows.filter((r) => verdictOfRun.get(r.subject_id) === 'changes-requested').length,
      failed: rows.filter((r) => r.outcome === 'failed').length,
      findings: { total, withCount: asked.length, average: asked.length ? total / asked.length : null },
    } satisfies ReviewModelStats;
  });

  // 5. Back-and-forths, over the whole history of the PRs opened in the window.
  const prs = [...new Set(opened.map(prKey))];
  const revisionsOf = groupBy(of(all, 'revision.pushed'), prKey);
  const reviewsOf = groupBy(of(all, 'review.verdict'), prKey);
  const revisions = prs.map((p) => revisionsOf.get(p)?.length ?? 0);
  const reviews = prs.map((p) => reviewsOf.get(p)?.length ?? 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

  return {
    work: {
      finished: { ...finished, total: kindCounts(jobs.map((j) => j.job_kind)) },
      current: {
        queued: kindCounts(queue.filter((q) => q.status === 'queued').map((q) => q.job_kind)),
        running: kindCounts(queue.filter((q) => q.status === 'running').map((q) => q.job_kind)),
      },
    },
    time: {
      agentRun: {
        all: runTime(executed),
        byKind: Object.fromEntries(JOB_KINDS.map((k) => [k, runTime(executed.filter((r) => r.job_kind === k))])) as Record<JobKind, CoveredDistribution>,
        byAgent: byKey(executed, (r) => agentOf(r.agent), runTime),
      },
      queueWait: {
        all: wait(waited),
        byKind: Object.fromEntries(JOB_KINDS.map((k) => [k, wait(waited.filter((r) => r.job_kind === k))])) as Record<JobKind, Distribution>,
        byAgent: byKey(waited, (r) => agentOf(r.agent), wait),
      },
      labelToPr: covered(opened.map((o) => ms(o.start_at, o.at))),
      prToMerge: covered(merged.map((m) => ms(m.start_at, m.at))),
    },
    outcomes: {
      prsOpened: prs.length,
      prsMerged: new Set(merged.map(prKey)).size,
      mergeBlocked: { heads: blocked.length, prs: new Set(blocked.map(prKey)).size, reasons },
      runs: { ...runEnds, total: runs.length },
      failedRuns: {
        total: failed.length,
        byKind: failedByKind,
        byAgent: byKey(failed, (r) => agentOf(r.agent), (rows) => rows.length),
        verifyFailed: failed.filter((r) => r.reason === 'verify-failed').length,
        verifyUnknown: failed.filter((r) => r.reason === null).length,
      },
    },
    review: {
      reviewerRuns: {
        total: reviewRuns.length,
        readyToMerge: reviewRuns.filter((r) => verdictOfRun.get(r.subject_id) === 'ready-to-merge').length,
        changesRequested: reviewRuns.filter((r) => verdictOfRun.get(r.subject_id) === 'changes-requested').length,
        failed: reviewRuns.filter((r) => r.outcome === 'failed').length,
        other: reviewRuns.filter((r) => r.outcome !== 'failed' && !verdictOfRun.has(r.subject_id)).length,
      },
      verdictsByAgent: byKey(verdicts, (v) => agentOf(v.agent), (rows) => ({
        readyToMerge: rows.filter((v) => v.outcome === 'ready-to-merge').length,
        changesRequested: rows.filter((v) => v.outcome === 'changes-requested').length,
      })),
      changesRequestedRounds: {
        reviewer: changes.length,
        people: human.length,
        reviewerQueued: requests.filter((q) => q.reason === 'updraft_review' && q.outcome === 'queued').length,
        peopleQueued: human.filter((q) => q.outcome === 'queued').length,
      },
      findings: {
        changesRequestedReviews: changes.length,
        withCount: counted.length,
        withoutCount: changes.length - counted.length,
        total: findingsTotal,
        average: counted.length ? findingsTotal / counted.length : null,
        allReviewsWithoutCount: verdicts.filter((v) => v.findings === null).length,
      },
      firstPass: { prs: firsts.length, readyToMerge: firstReady, rate: firsts.length ? firstReady / firsts.length : null },
      byModel: reviewByModel,
    },
    backAndForth: {
      prs: prs.length,
      revisionsPerPr: {
        average: avg(revisions),
        max: max(revisions),
        distribution: {
          '0': revisions.filter((n) => n === 0).length,
          '1': revisions.filter((n) => n === 1).length,
          '2': revisions.filter((n) => n === 2).length,
          '3+': revisions.filter((n) => n >= 3).length,
        },
      },
      reviewsPerPr: { average: avg(reviews), max: max(reviews) },
      limitReached: new Set(of(windowed, 'pr.limit_reached').map(prKey)).size,
    },
    routing: routingSection(windowed, all, jobs, opened),
    pressure: pressureSection(windowed, runs),
    dependencies: dependencySection(windowed, queue),
    daily: dailySection(windowed, jobs),
  };
}

/** The window day by day (UTC). `jobs` are the window's jobs at their latest final status. */
function dailySection(windowed: readonly EventRow[], jobs: readonly EventRow[]): DailyStats[] {
  const days = new Map<string, DailyStats>();
  const day = (at: string): DailyStats => {
    const d = new Date(Date.parse(at)).toISOString().slice(0, 10);
    let row = days.get(d);
    if (!row) days.set(d, (row = { day: d, jobsSucceeded: 0, jobsFailed: 0, prsOpened: 0, prsMerged: 0, reviews: 0, changesRequested: 0, findings: 0, revisions: 0 }));
    return row;
  };
  for (const j of jobs) {
    if (j.outcome === 'succeeded') day(j.at).jobsSucceeded++;
    else if (j.outcome === 'failed') day(j.at).jobsFailed++;
  }
  for (const e of windowed) {
    if (e.kind === 'pr.opened') day(e.at).prsOpened++;
    else if (e.kind === 'pr.merged') day(e.at).prsMerged++;
    else if (e.kind === 'revision.pushed') day(e.at).revisions++;
    else if (e.kind === 'review.verdict') {
      const d = day(e.at);
      d.reviews++;
      if (e.outcome === 'changes-requested') {
        d.changesRequested++;
        d.findings += e.findings ?? 0;
      }
    }
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function dependencySection(windowed: readonly EventRow[], queue: readonly QueueRow[]): DependencyStats {
  const ended = windowed.filter((e) => e.kind === 'dependency.ended');
  const count = (outcome: string) => ended.filter((e) => e.outcome === outcome).length;
  return {
    started: windowed.filter((e) => e.kind === 'dependency.waiting').length,
    ended: { resumed: count('resumed'), closed: count('closed'), canceled: count('canceled'), expired: count('expired') },
    waitToMerge: distribution(ended.filter((e) => e.outcome === 'resumed' && e.wait_ms !== null).map((e) => e.wait_ms!)),
    waitingNow: queue.filter((q) => q.status === 'waiting').length,
  };
}

/** Waits still waiting, as queue rows; none in a database from before dependency_waits existed. */
function waitingRows(db: Db): QueueRow[] {
  try {
    return db.prepare("SELECT repo_id, repo_full_name, 'waiting' AS status, 'implement' AS job_kind FROM dependency_waits WHERE state = 'waiting'").all() as unknown as QueueRow[];
  } catch {
    return [];
  }
}

const QUEUE_SQL = `
  SELECT repo_id, repo_full_name, status,
    CASE WHEN json_valid(envelope) THEN CASE json_extract(envelope, '$.type') WHEN 'issue.labeled' THEN 'implement'
      WHEN 'pull_request.changes_requested' THEN 'revision' WHEN 'pull_request.review' THEN 'review' END END AS job_kind
  FROM jobs WHERE status IN ('queued', 'running')`;

/** An empty report section, for a state database that does not exist yet. */
export function emptySection(): StatsSection {
  return section([], [], []);
}

/**
 * The report for facts at or after `since` (null: all of them) up to `now`, for every repository
 * or the one named by `repo` (OWNER/REPO, case-insensitive; matched against every name a
 * repository's facts or jobs were recorded under).
 */
export function computeStats(db: Db | null, o: {
  since: number | null; now: number; label: string; repo?: string | null;
  stepModels?: ReadonlyMap<string, { model: string; adapter?: string; effort?: string; modelSource?: 'configured' | 'response' }>;
}): StatsReport {
  const base = {
    version: STATS_JSON_VERSION,
    generatedAt: new Date(o.now).toISOString(),
    window: { label: o.label, since: o.since === null ? null : new Date(o.since).toISOString(), until: new Date(o.now).toISOString() },
    repo: o.repo ?? null,
  } as const;
  if (!db) return { ...base, database: false, facts: { total: 0, backfilled: 0 }, overall: emptySection(), byRepo: [] };

  let events = (db.prepare('SELECT * FROM metric_events ORDER BY at, id').all() as unknown as Partial<EventRow>[]).map(normalize);
  if (o.stepModels) {
    for (const event of events) {
      if (event.kind !== 'run.selected') continue;
      const model = o.stepModels.get(event.subject_id);
      if (!model) continue;
      event.model = model.model;
      event.adapter = model.adapter ?? event.adapter;
      event.effort = model.effort ?? event.effort;
      event.model_source = model.modelSource === 'response' ? 'observed' : 'configured';
    }
  }
  let queue = [...(db.prepare(QUEUE_SQL).all() as unknown as QueueRow[]), ...waitingRows(db)];

  // Every name each repository was seen under, and the newest one to show.
  const names = new Map<number, { shown: string; at: string; all: Set<string> }>();
  const seen = (id: number, name: string | null, at: string) => {
    if (!name) return;
    const n = names.get(id);
    if (!n) names.set(id, { shown: name, at, all: new Set([name.toLowerCase()]) });
    else {
      n.all.add(name.toLowerCase());
      if (at >= n.at) Object.assign(n, { shown: name, at });
    }
  };
  for (const e of events) seen(e.repo_id, e.repo_full_name, e.at);
  for (const q of queue) seen(q.repo_id, q.repo_full_name, '');

  let repo = base.repo;
  if (o.repo) {
    const wanted = o.repo.toLowerCase();
    const matched = [...names].filter(([, n]) => n.all.has(wanted));
    const ids = new Set(matched.map(([id]) => id));
    // Shown as recorded; a repository renamed since shows under its newest name.
    if (matched.length === 1) repo = matched[0]![1].shown;
    events = events.filter((e) => ids.has(e.repo_id));
    queue = queue.filter((q) => ids.has(q.repo_id));
  }
  const since = o.since;
  const windowed = since === null ? events : events.filter((e) => Date.parse(e.at) >= since);

  const repoIds = [...new Set([...windowed.map((e) => e.repo_id), ...queue.map((q) => q.repo_id)])];
  const byRepo = repoIds
    .map((id) => ({
      repo: names.get(id)?.shown ?? `repository ${id}`,
      repoId: id,
      stats: section(
        windowed.filter((e) => e.repo_id === id),
        events.filter((e) => e.repo_id === id),
        queue.filter((q) => q.repo_id === id),
      ),
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));

  return {
    ...base,
    repo,
    database: true,
    facts: { total: windowed.length, backfilled: windowed.filter((e) => e.backfilled === 1).length },
    overall: section(windowed, events, queue),
    byRepo,
  };
}
