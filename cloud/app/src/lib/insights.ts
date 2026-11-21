import type { DailyStats, InsightsWindow, StatsReport, StatsSection } from '../api/client';

/**
 * What the Insights page computes from the CLI's report: a day for every day of the window
 * (the report lists only days with a fact), the per-repository rows, and words for numbers.
 */

export const WINDOWS: { value: InsightsWindow; label: string; days: number | null }[] = [
  { value: '24h', label: '24 hours', days: 1 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
  { value: 'all', label: 'All time', days: null },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY = (day: string): DailyStats => ({ day, jobsSucceeded: 0, jobsFailed: 0, prsOpened: 0, prsMerged: 0, reviews: 0, changesRequested: 0, findings: 0, revisions: 0 });

/**
 * Every UTC day from the window's start (or, for all time, the first day with a fact) to its end,
 * with zeros for the days that had nothing. At most `max` days, the latest.
 */
export function fillDays(daily: DailyStats[] | undefined, window: { since: string | null; until: string }, max = 120): DailyStats[] {
  const known = new Map((daily ?? []).map((d) => [d.day, d]));
  const end = Date.parse(window.until.slice(0, 10));
  const first = window.since ? Date.parse(window.since.slice(0, 10)) : daily?.length ? Date.parse(daily[0]!.day) : end;
  const start = Math.max(first, end - (max - 1) * DAY_MS);
  const out: DailyStats[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(known.get(day) ?? EMPTY(day));
  }
  return out;
}

export const pct = (rate: number | null | undefined, digits = 0) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(digits)}%`);
export const ratio = (n: number, of: number) => (of > 0 ? n / of : null);
export const avg = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '—' : n.toFixed(digits).replace(/\.0+$/, ''));

/** "42 s", "12 min", "3.5 h", "2.1 d", from milliseconds. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1).replace(/\.0$/, '')} h`;
  return `${(s / 86400).toFixed(1).replace(/\.0$/, '')} d`;
}

/** "Opus · effort high", "Codex default model": a model key of the report (`<adapter>/<model or cli-default>[ effort <e>]`), for people. */
export function modelName(key: string, m?: { adapter?: string | null; model?: string | null; effort?: string | null }): { name: string; via: string } {
  if (key === 'unknown') return { name: 'Not recorded', via: 'runs from before models were recorded' };
  const [adapter = '', rest = ''] = key.split('/', 2);
  const model = m?.model ?? (rest.split(' effort ')[0] === 'cli-default' ? null : rest.split(' effort ')[0]);
  const effort = m?.effort ?? (rest.includes(' effort ') ? rest.split(' effort ')[1]! : null);
  const cli = adapter ? adapter.charAt(0).toUpperCase() + adapter.slice(1) : 'Agent';
  return { name: model ?? `${cli} default model`, via: [cli, effort ? `effort ${effort}` : null].filter(Boolean).join(' · ') };
}

export interface RepoRow {
  repo: string;
  /** Issues worked: implement jobs that finished in the window. */
  issues: number;
  succeeded: number;
  failed: number;
  active: number;
  prsOpened: number;
  prsMerged: number;
  findings: number;
  changesRequested: number;
  avgRounds: number | null;
  firstPass: number | null;
  successRate: number | null;
}

export function repoRow(repo: string, s: StatsSection): RepoRow {
  const f = s.work.finished;
  const done = f.succeeded.implement;
  const failed = f.failed.implement;
  return {
    repo,
    issues: f.total.implement,
    succeeded: done,
    failed,
    active: s.work.current.queued.total + s.work.current.running.total,
    prsOpened: s.outcomes.prsOpened,
    prsMerged: s.outcomes.prsMerged,
    findings: s.review.findings.total,
    changesRequested: s.review.changesRequestedRounds.reviewer + s.review.changesRequestedRounds.people,
    avgRounds: s.backAndForth.revisionsPerPr.average,
    firstPass: s.review.firstPass.rate,
    successRate: ratio(done, done + failed),
  };
}

/** The repositories of the report, busiest first, and the configured ones with nothing yet. */
export function repoRows(report: StatsReport, configured: string[] = []): RepoRow[] {
  const rows = report.byRepo.map((r) => repoRow(r.repo, r.stats));
  const seen = new Set(rows.map((r) => r.repo.toLowerCase()));
  for (const name of configured) if (!seen.has(name.toLowerCase())) rows.push(repoRow(name, EMPTY_SECTION));
  return rows.sort((a, b) => b.issues - a.issues || b.active - a.active || a.repo.localeCompare(b.repo));
}

const zeroKinds = { implement: 0, revision: 0, review: 0, unknown: 0, total: 0 };
const zeroDist = { count: 0, averageMs: null, medianMs: null, p90Ms: null };
const EMPTY_SECTION: StatsSection = {
  work: { finished: { succeeded: zeroKinds, failed: zeroKinds, interrupted: zeroKinds, canceled: zeroKinds, total: zeroKinds }, current: { queued: zeroKinds, running: zeroKinds } },
  time: {
    agentRun: { all: { ...zeroDist, total: 0 }, byKind: { implement: { ...zeroDist, total: 0 }, revision: { ...zeroDist, total: 0 }, review: { ...zeroDist, total: 0 } }, byAgent: {} },
    queueWait: { all: zeroDist },
    labelToPr: { ...zeroDist, total: 0 },
    prToMerge: { ...zeroDist, total: 0 },
  },
  outcomes: { prsOpened: 0, prsMerged: 0, mergeBlocked: { heads: 0, prs: 0, reasons: [] }, runs: { total: 0 }, failedRuns: { total: 0, verifyFailed: 0 } },
  review: {
    reviewerRuns: { total: 0, readyToMerge: 0, changesRequested: 0, failed: 0, other: 0 },
    changesRequestedRounds: { reviewer: 0, people: 0, reviewerQueued: 0, peopleQueued: 0 },
    findings: { changesRequestedReviews: 0, withCount: 0, withoutCount: 0, total: 0, average: null, allReviewsWithoutCount: 0 },
    firstPass: { prs: 0, readyToMerge: 0, rate: null },
    byModel: {},
  },
  backAndForth: { prs: 0, revisionsPerPr: { average: null, max: null, distribution: { '0': 0, '1': 0, '2': 0, '3+': 0 } }, reviewsPerPr: { average: null, max: null }, limitReached: 0 },
  routing: { minSample: 20, byModel: {}, byProfile: {} },
  pressure: { cooldowns: { count: 0, totalMs: 0 }, deferrals: { count: 0 }, unavailable: { startFailedRuns: 0 } },
  daily: [],
};

/** Merge-block reason codes in words (docs/stats.md). */
export const MERGE_BLOCK: Record<string, string> = {
  config: 'Auto-merge is off',
  'not-verified': 'Not verified',
  'base-changed': 'Base branch changed',
  draft: 'Still a draft',
  unmergeable: 'Conflicts',
  'changes-requested': 'Changes requested',
  'checks-failed': 'Checks failed',
  'checks-unreadable': 'Checks unreadable',
  'wait-timeout': 'Checks took too long',
  'merge-refused': 'GitHub refused the merge',
  'no-answer': 'GitHub did not answer',
  'github-error': 'GitHub error',
  other: 'Other',
};
