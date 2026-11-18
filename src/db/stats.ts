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
  };
  backAndForth: {
    /** PRs opened in the window; the rest of this block counts their whole history. */
    prs: number;
    revisionsPerPr: { average: number | null; max: number | null; distribution: { '0': number; '1': number; '2': number; '3+': number } };
    reviewsPerPr: { average: number | null; max: number | null };
    /** PRs that reached maxRevisions in the window. */
    limitReached: number;
  };
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
}

interface QueueRow {
  repo_id: number;
  repo_full_name: string;
  status: 'queued' | 'running';
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
  };
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
export function computeStats(db: Db | null, o: { since: number | null; now: number; label: string; repo?: string | null }): StatsReport {
  const base = {
    version: STATS_JSON_VERSION,
    generatedAt: new Date(o.now).toISOString(),
    window: { label: o.label, since: o.since === null ? null : new Date(o.since).toISOString(), until: new Date(o.now).toISOString() },
    repo: o.repo ?? null,
  } as const;
  if (!db) return { ...base, database: false, facts: { total: 0, backfilled: 0 }, overall: emptySection(), byRepo: [] };

  let events = db.prepare('SELECT * FROM metric_events ORDER BY at, id').all() as unknown as EventRow[];
  let queue = db.prepare(QUEUE_SQL).all() as unknown as QueueRow[];

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
