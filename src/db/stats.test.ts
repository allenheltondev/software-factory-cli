import { describe, expect, it } from 'vitest';
import { buildHistory, DAY, HOUR, MIN } from '../../test/factory-history.js';
import { computeStats, distribution, percentile } from './stats.js';

const END = Date.parse('2026-11-18T12:00:00.000Z');
const last30 = { since: END - 30 * DAY, now: END, label: '30d' };

describe('percentile and distribution', () => {
  it('interpolates between closest ranks', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBeCloseTo(91);
    expect(distribution([30, 10, 20])).toEqual({ count: 3, averageMs: 20, medianMs: 20, p90Ms: 28 });
    expect(distribution([])).toEqual({ count: 0, averageMs: null, medianMs: null, p90Ms: null });
  });
});

describe('computeStats', () => {
  it('reports the last 30 days over every repository', () => {
    const { db } = buildHistory(END);
    const r = computeStats(db, last30);
    expect(r).toMatchObject({ version: 1, database: true, repo: null, window: { label: '30d', since: '2026-10-19T12:00:00.000Z', until: '2026-11-18T12:00:00.000Z' } });
    const s = r.overall;

    // 1. Work items: issue 3 failed and was retried; it counts once, as succeeded.
    expect(s.work.finished.succeeded).toMatchObject({ implement: 3, revision: 2, review: 4, total: 9 });
    expect(s.work.finished.failed).toMatchObject({ implement: 1, total: 1 });
    expect(s.work.finished.total.total).toBe(10);
    expect(s.work.current.queued).toMatchObject({ implement: 1, total: 1 });
    expect(s.work.current.running).toMatchObject({ implement: 1, total: 1 });

    // 2. Time: implement runs of 20, 15, 9, 2 and 30 minutes.
    expect(s.time.agentRun.byKind.implement).toEqual({ count: 5, total: 5, averageMs: 15.2 * MIN, medianMs: 15 * MIN, p90Ms: 26 * MIN });
    expect(s.time.agentRun.byAgent).toMatchObject({ claude: { count: 6 }, codex: { count: 4 }, kiro: { count: 1, medianMs: 30 * MIN } });
    // Queue wait is of each job's first started run only: issue 3's retry does not count.
    expect(s.time.queueWait.byKind.implement).toMatchObject({ count: 4, medianMs: 3.5 * MIN });
    expect(s.time.queueWait.byKind.review).toMatchObject({ count: 4 });
    expect(s.time.labelToPr).toMatchObject({ count: 3, total: 3, medianMs: 100 * MIN });
    expect(s.time.prToMerge).toEqual({ count: 1, total: 1, averageMs: 187 * MIN, medianMs: 187 * MIN, p90Ms: 187 * MIN });

    // 3. Outcomes.
    expect(s.outcomes).toMatchObject({
      prsOpened: 3,
      prsMerged: 1,
      mergeBlocked: { heads: 1, prs: 1, reasons: [{ code: 'checks-failed', count: 1 }] },
      runs: { total: 11, succeeded: 9, failed: 2 },
      failedRuns: { total: 2, byKind: { implement: 2 }, byAgent: { claude: 2 }, verifyFailed: 1, verifyUnknown: 1 },
    });

    // 4. Review.
    expect(s.review.reviewerRuns).toEqual({ total: 4, readyToMerge: 2, changesRequested: 2, failed: 0, other: 0 });
    expect(s.review.verdictsByAgent).toEqual({ codex: { readyToMerge: 2, changesRequested: 2 } });
    // Two reviewer rounds; two people's requests, the second refused by maxRevisions but still a round.
    expect(s.review.changesRequestedRounds).toEqual({ reviewer: 2, people: 2, reviewerQueued: 1, peopleQueued: 1 });
    expect(s.review.findings).toEqual({ changesRequestedReviews: 2, withCount: 1, withoutCount: 1, total: 3, average: 3, allReviewsWithoutCount: 2 });
    // PR 102's first head got changes requested; 103 and art#9 were ready at once.
    expect(s.review.firstPass).toEqual({ prs: 3, readyToMerge: 2, rate: 2 / 3 });

    // 5. Back-and-forths of the three PRs opened in the window: 2, 0 and 0 revisions.
    expect(s.backAndForth).toEqual({
      prs: 3,
      revisionsPerPr: { average: 2 / 3, max: 2, distribution: { '0': 2, '1': 0, '2': 1, '3+': 0 } },
      reviewsPerPr: { average: 4 / 3, max: 2 },
      limitReached: 1,
    });

    // Per repository, the same sections.
    expect(r.byRepo.map((b) => [b.repo, b.repoId, b.stats.outcomes.prsOpened, b.stats.work.finished.total.total])).toEqual([
      ['octo/art', 7, 1, 2],
      ['octo/widgets', 42, 2, 8],
    ]);
  });

  it('widens to all history and narrows to one repository by any case of its name', () => {
    const { db } = buildHistory(END);
    const r = computeStats(db, { since: null, now: END, label: 'all', repo: 'Octo/Widgets' });
    expect(r.repo).toBe('octo/widgets');
    expect(r.window.since).toBeNull();
    expect(r.byRepo.map((b) => b.repo)).toEqual(['octo/widgets']);
    const s = r.overall;
    // PR 101, 35 days back, is in now: merged after one revision, first head changes-requested.
    expect(s.outcomes).toMatchObject({ prsOpened: 3, prsMerged: 1 });
    expect(s.time.prToMerge).toMatchObject({ count: 1, medianMs: 50 * MIN });
    expect(s.review.firstPass).toEqual({ prs: 3, readyToMerge: 1, rate: 1 / 3 });
    expect(s.review.findings).toMatchObject({ withCount: 2, total: 5, average: 2.5 });
    expect(s.backAndForth.revisionsPerPr.distribution).toEqual({ '0': 1, '1': 1, '2': 1, '3+': 0 });
    // Nothing from octo/art.
    expect(s.time.agentRun.byAgent).not.toHaveProperty('kiro');
    expect(s.work.finished.total.total).toBe(12);

    const none = computeStats(db, { ...last30, repo: 'octo/nothing' });
    expect(none.overall.work.finished.total.total).toBe(0);
    expect(none.overall.work.current.queued.total).toBe(0);
    expect(none.byRepo).toEqual([]);
  });

  it('counts a fact at the start of the window, and none before it', () => {
    const { db } = buildHistory(END);
    const opened = db.prepare("SELECT at FROM metric_events WHERE kind = 'pr.opened' AND subject_id = '7#9'").get() as { at: string };
    const at = Date.parse(opened.at);
    expect(computeStats(db, { since: at, now: END, label: 'x', repo: 'octo/art' }).overall.outcomes.prsOpened).toBe(1);
    expect(computeStats(db, { since: at + 1, now: END, label: 'x', repo: 'octo/art' }).overall.outcomes.prsOpened).toBe(0);
    // A window that only holds the merge still knows when the PR was opened.
    expect(computeStats(db, { since: END - DAY - 21 * HOUR, now: END, label: 'x' }).overall.time.prToMerge).toMatchObject({ count: 1, total: 1 });
  });

  it('shows how many rows a measure covers instead of skewing it with rows that lack the field', () => {
    const { db } = buildHistory(END);
    // As a backfill leaves rows: a PR whose label time is unknown, a run with no start.
    db.prepare("UPDATE metric_events SET start_at = NULL, backfilled = 1 WHERE kind = 'pr.opened' AND subject_id = '42#102'").run();
    db.prepare("UPDATE metric_events SET start_at = NULL, backfilled = 1 WHERE kind = 'run.ended' AND agent = 'kiro'").run();
    const s = computeStats(db, last30);
    expect(s.facts.backfilled).toBe(2);
    expect(s.overall.time.labelToPr).toMatchObject({ count: 2, total: 3 });
    expect(s.overall.time.agentRun.byAgent.kiro).toEqual({ count: 0, total: 1, averageMs: null, medianMs: null, p90Ms: null });
    expect(s.overall.time.agentRun.byKind.implement).toMatchObject({ count: 4, total: 5 });
  });

  it('reports zeros, not an error, without a database', () => {
    const r = computeStats(null, last30);
    expect(r).toMatchObject({ database: false, facts: { total: 0, backfilled: 0 }, byRepo: [] });
    expect(r.overall.work.finished.total.total).toBe(0);
    expect(r.overall.time.agentRun.all).toEqual({ count: 0, total: 0, averageMs: null, medianMs: null, p90Ms: null });
    expect(r.overall.review.firstPass.rate).toBeNull();
  });
});
