// `updraft stats`: how the factory is doing, from the metric_events rollup (docs/stats.md).
// Read-only and local: no database is created, an existing one is opened read-only (so it is
// neither migrated nor switched to WAL), and nothing is sent anywhere.
import { existsSync } from 'node:fs';
import { METRICS_SCHEMA_VERSION, SCHEMA_VERSION, schemaVersion } from '../db/database.js';
import {
  computeStats,
  FINISHED_STATUSES,
  JOB_KINDS,
  type CoveredDistribution,
  type Distribution,
  type KindCounts,
  type Rate,
  type RouteGroupStats,
  type StatsReport,
  type StatsSection,
} from '../db/stats.js';
import { parseAge } from './clean.js';
import { println, type CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';

export interface StatsOptions {
  json?: boolean;
  /** Window: a number and a unit (h, d, w), "today" (since local midnight), or "all". */
  since?: string;
  /** Only this repository (OWNER/REPO). */
  repo?: string;
}

export const DEFAULT_STATS_SINCE = '30d';

/** --since: milliseconds back from now, or null for "all". */
export function parseSince(text: string): number | null {
  if (text.trim().toLowerCase() === 'all') return null;
  return parseAge(text, '--since');
}

function parseRepo(text: string | undefined): string | null {
  if (text === undefined) return null;
  const repo = text.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new CliError(`Invalid --repo "${text}": use OWNER/REPO, for example octo/widgets.`, EXIT.USAGE);
  }
  return repo;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** A compact duration: 45s, 12m 05s, 3h 04m, 2d 03h. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  const s = Math.round(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86_400)}d ${pad(Math.floor((s % 86_400) / 3600))}h`;
}

const num = (n: number | null) => (n === null ? '-' : String(n));
const avg = (n: number | null) => (n === null ? '-' : n.toFixed(1));
const pct = (r: number | null) => (r === null ? '-' : `${Math.round(r * 100)}%`);

/** Rows of cells as aligned columns: the first left-aligned, the rest right-aligned. */
function table(rows: string[][], indent = '  '): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => `${indent}${r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')}`.trimEnd());
}

/** Label / value lines with the labels padded to one width. */
function pairs(rows: Array<[string, string]>, indent = '  '): string[] {
  const w = Math.max(...rows.map(([l]) => l.length));
  return rows.map(([l, v]) => `${indent}${l.padEnd(w)}  ${v}`);
}

const kindCells = (c: KindCounts) => [...JOB_KINDS.map((k) => String(c[k])), String(c.total)];

function timeRow(label: string, d: Distribution | CoveredDistribution): string[] {
  const n = 'total' in d && d.total !== d.count ? `${d.count} of ${d.total}` : String(d.count);
  return [label, n, formatDuration(d.averageMs), formatDuration(d.medianMs), formatDuration(d.p90Ms)];
}

function renderSection(s: StatsSection): string[] {
  const lines: string[] = [];
  const { work, time, outcomes, review, backAndForth: bf } = s;

  lines.push('Work items done', ...table([
    ['', ...JOB_KINDS, 'total'],
    ...FINISHED_STATUSES.map((st) => [st, ...kindCells(work.finished[st])]),
    ['all finished', ...kindCells(work.finished.total)],
    ['queued now', ...kindCells(work.current.queued)],
    ['running now', ...kindCells(work.current.running)],
  ]));
  const unknownKinds = work.finished.total.unknown + work.current.queued.unknown + work.current.running.unknown;
  if (unknownKinds) lines.push(`  (${unknownKinds} job(s) of unknown kind are only in the totals)`);

  const timeRows: string[][] = [['', 'n', 'avg', 'median', 'p90']];
  for (const k of JOB_KINDS) if (time.agentRun.byKind[k].total) timeRows.push(timeRow(`agent run, ${k}`, time.agentRun.byKind[k]));
  for (const [agent, d] of Object.entries(time.agentRun.byAgent)) timeRows.push(timeRow(`agent run, ${agent}`, d));
  for (const k of JOB_KINDS) if (time.queueWait.byKind[k].count) timeRows.push(timeRow(`queue wait, ${k}`, time.queueWait.byKind[k]));
  for (const [agent, d] of Object.entries(time.queueWait.byAgent)) timeRows.push(timeRow(`queue wait, ${agent}`, d));
  timeRows.push(timeRow('label to PR opened', time.labelToPr), timeRow('PR opened to merged', time.prToMerge));
  lines.push('', 'Time taken', ...table(timeRows));

  const r = outcomes.runs;
  const failedKinds = Object.entries(outcomes.failedRuns.byKind).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  const failedAgents = Object.entries(outcomes.failedRuns.byAgent).map(([a, n]) => `${a} ${n}`);
  const fr = outcomes.failedRuns;
  const mb = outcomes.mergeBlocked;
  lines.push('', 'Outcomes', ...pairs([
    ['PRs opened', String(outcomes.prsOpened)],
    ['merged by Updraft', String(outcomes.prsMerged)],
    [
      'auto-merge blocked',
      `${mb.heads} head(s) of ${mb.prs} PR(s)${mb.reasons.length ? `: ${mb.reasons.slice(0, 5).map((x) => `${x.code} ${x.count}`).join(', ')}` : ''}`,
    ],
    [
      'runs ended',
      `${r.total}: succeeded ${r.succeeded}, failed ${r.failed}, interrupted ${r.interrupted}, could not start ${r.start_failed}, ` +
        `canceled ${r.canceled}, closed before start ${r['not-started']}`,
    ],
    [
      'failed runs',
      fr.total
        ? `${fr.total}: ${failedKinds.join(', ')}; ${failedAgents.join(', ')}; verify commands failed in ${fr.verifyFailed}, no verify result in ${fr.verifyUnknown}`
        : '0',
    ],
  ]));

  const rv = review.reviewerRuns;
  const rounds = review.changesRequestedRounds;
  const f = review.findings;
  const byAgent = Object.entries(review.verdictsByAgent).map(([a, v]) => `${a} ${v.readyToMerge} ready / ${v.changesRequested} changes`);
  lines.push('', 'Caught in review', ...pairs([
    ['reviewer runs', `${rv.total}: ready-to-merge ${rv.readyToMerge}, changes-requested ${rv.changesRequested}, failed ${rv.failed}, other ${rv.other}`],
    ...(byAgent.length ? ([['verdicts by agent', byAgent.join(', ')]] as Array<[string, string]>) : []),
    ['changes requested', `by the reviewer ${rounds.reviewer} (${rounds.reviewerQueued} queued a revision), by people ${rounds.people} (${rounds.peopleQueued} queued a revision)`],
    [
      'findings',
      `${f.total} in ${f.withCount} changes-requested review(s) with a count (avg ${avg(f.average)}); ` +
        `${f.withoutCount} without a count; ${f.allReviewsWithoutCount} review(s) in all without a count`,
    ],
    ['first-pass ready', `${review.firstPass.readyToMerge} of ${review.firstPass.prs} PR(s) (${pct(review.firstPass.rate)})`],
  ]));

  const d = bf.revisionsPerPr.distribution;
  lines.push('', `Back-and-forths (${bf.prs} PR(s) opened in the window)`, ...pairs([
    ['revisions per PR', `avg ${avg(bf.revisionsPerPr.average)}, max ${num(bf.revisionsPerPr.max)}; 0: ${d['0']}, 1: ${d['1']}, 2: ${d['2']}, 3+: ${d['3+']}`],
    ['reviews per PR', `avg ${avg(bf.reviewsPerPr.average)}, max ${num(bf.reviewsPerPr.max)}`],
    ['reached maxRevisions', String(bf.limitReached)],
  ]));
  lines.push(...renderRouting(s));
  return lines;
}

const rateCell = (r: Rate) => (r.rate === null ? '-' : `${r.count}/${r.of} ${pct(r.rate)} (${pct(r.low)}-${pct(r.high)})`);

function routeTable(title: string, groups: Record<string, RouteGroupStats>): string[] {
  const keys = Object.keys(groups);
  if (!keys.length) return [];
  const rows = [['', 'jobs', 'success (95%)', 'review-ready (95%)', 'vfail', 'retry', 'esc in/out', 'rev/PR', 'to PR', 'wait']];
  for (const k of keys) {
    const g = groups[k]!;
    rows.push([
      g.smallSample ? `${k} *` : k,
      String(g.jobs),
      rateCell(g.success),
      rateCell(g.reviewReady),
      String(g.verificationFailures),
      String(g.retries),
      `${g.escalatedIn.jobs}/${g.escalatedOut}`,
      avg(g.revisions.average),
      formatDuration(g.labelToPr.medianMs),
      formatDuration(g.queueWait.medianMs),
    ]);
  }
  return ['', title, ...table(rows)];
}

function renderRouting(s: StatsSection): string[] {
  const { routing, pressure } = s;
  const lines: string[] = [];
  const d = routing.decisions;
  if (d.total || routing.selections || Object.keys(routing.byTier).length) {
    lines.push('', 'Model tiers (implement jobs; model and effort are as configured, not reported by the CLI)');
    if (d.total) {
      const src = Object.entries(d.bySource).map(([k, n]) => `${k} ${n}`).join(', ');
      lines.push(...pairs([['routing decisions', `${d.total}: ${src}${d.triageFallbacks ? `; ${d.triageFallbacks} fell back after triage was unavailable` : ''}`]]));
    }
    lines.push(...routeTable('By tier (a job counts for the tier of the run that ended it)', routing.byTier));
    lines.push(...routeTable('By profile', routing.byProfile));
    lines.push(...routeTable('By model (configured)', routing.byModel));
    lines.push(`  * fewer than ${routing.minSample} jobs: too few to compare. vfail: failed verification; esc in/out: escalated into / out of; to PR, wait: medians.`);
    lines.push('  "unknown" is work from before selections were recorded.');
  }
  const c = pressure.cooldowns;
  if (c.count || pressure.deferrals.count || pressure.unavailable.startFailedRuns) {
    const names = Object.entries(c.byName).map(([n, v]) => `${n} ${v.count}x ${formatDuration(v.totalMs)}`).join(', ');
    lines.push('', 'Subscription usage pressure (local signals; token and credit use is not recorded)', ...pairs([
      ['usage-limit cooldowns', `${c.count}, ${formatDuration(c.totalMs)} in all${names ? `: ${names}` : ''}`],
      ['jobs deferred', String(pressure.deferrals.count)],
      ['runs that could not start', String(pressure.unavailable.startFailedRuns)],
    ]));
  }
  return lines;
}

const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

export function renderStats(report: StatsReport): string {
  const w = report.window;
  const span =
    w.since === null ? 'all recorded history' : w.label === 'today' ? `today (since ${when(w.since)})` : `the last ${w.label} (since ${when(w.since)})`;
  const lines = [`Updraft stats for ${span}, ${report.repo ? report.repo : 'all repositories'}`];
  if (!report.database) {
    lines.push('No state database yet: nothing has been recorded. Run "updraft start" to begin.');
    return lines.join('\n');
  }
  const facts = report.facts;
  lines.push(`Facts in the window: ${facts.total}${facts.backfilled ? ` (${facts.backfilled} backfilled from state recorded before stats existed)` : ''}`);
  lines.push('', ...renderSection(report.overall));
  if (!report.repo && report.byRepo.length > 1) {
    const rows = [['', 'done', 'failed', 'PRs', 'merged', 'blocked', 'reviews', 'rounds bot/people', 'revisions/PR', 'run median']];
    for (const { repo, stats: s } of report.byRepo) {
      rows.push([
        repo,
        String(s.work.finished.total.total),
        String(s.work.finished.failed.total),
        String(s.outcomes.prsOpened),
        String(s.outcomes.prsMerged),
        String(s.outcomes.mergeBlocked.heads),
        String(s.review.reviewerRuns.total),
        `${s.review.changesRequestedRounds.reviewer}/${s.review.changesRequestedRounds.people}`,
        avg(s.backAndForth.revisionsPerPr.average),
        formatDuration(s.time.agentRun.all.medianMs),
      ]);
    }
    lines.push('', 'By repository (use --repo OWNER/REPO or --json for the full breakdown)', ...table(rows));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Local midnight (the CLI host's time zone) at the start of the day containing `now`, in epoch ms. */
export function startOfToday(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export async function statsCommand(ctx: CommandContext, opts: StatsOptions = {}): Promise<number> {
  const label = (opts.since ?? DEFAULT_STATS_SINCE).trim();
  const repo = parseRepo(opts.repo);
  const now = ctx.now();
  let window: { since: number | null; now: number; label: string; repo: string | null };
  if (label.toLowerCase() === 'today') {
    window = { since: startOfToday(now), now, label: 'today', repo };
  } else {
    const back = parseSince(label);
    window = { since: back === null ? null : now - back, now, label: back === null ? 'all' : label, repo };
  }

  // Looking must not change anything: no database is created, an existing one is opened read-only.
  let report: StatsReport;
  if (!existsSync(ctx.paths.dbFile)) {
    report = computeStats(null, window);
  } else {
    const db = ctx.openDbReadOnly(ctx.paths.dbFile);
    try {
      const version = schemaVersion(db);
      if (version > SCHEMA_VERSION) {
        throw new CliError(`The state database at ${ctx.paths.dbFile} is at schema v${version}, newer than this CLI supports (v${SCHEMA_VERSION}). Upgrade Updraft to read it.`);
      }
      if (version < METRICS_SCHEMA_VERSION) {
        throw new CliError(
          `The state database at ${ctx.paths.dbFile} is at schema v${version}, from before stats were recorded (v${METRICS_SCHEMA_VERSION}). ` +
            '"updraft stats" never changes the database; run "updraft status" once to upgrade it (which also backfills the stats from what is recorded), then try again.',
        );
      }
      report = computeStats(db, window);
    } finally {
      db.close();
    }
  }

  println(ctx.out, opts.json ? JSON.stringify(report, null, 2) : renderStats(report));
  return EXIT.OK;
}
