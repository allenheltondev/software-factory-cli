import { describe, expect, it } from 'vitest';
import { buildHistory, DAY, History, HOUR, metricRows, MIN } from '../../test/factory-history.js';
import { openDatabase, transaction, type Db } from './database.js';
import { cancelQueuedJob } from './ingest.js';
import {
  backfillMetrics,
  mergeReasonCodeSql,
  noteChangeRequest,
  noteJobFinished,
  noteLimitReached,
  noteMergeBlocked,
  notePrMerged,
  notePrOpened,
  noteReview,
  noteRevisionPushed,
  noteRunEnded,
  type MergeBlockCode,
} from './metrics.js';
import { finishPublication } from './publications.js';
import { getLoopPr, setMergeState } from './pr-reviews.js';
import { finishRun, requestJobCancel } from './queue.js';
import { closeRevisionPr, holdRevision, recordReviewRequest } from './revisions.js';

const END = Date.parse('2026-11-18T12:00:00.000Z');
const W = { repoId: 42, fullName: 'octo/widgets' };

const count = (db: Db, kind?: string) =>
  (db.prepare(`SELECT count(*) AS n FROM metric_events${kind ? ' WHERE kind = ?' : ''}`).get(...(kind ? [kind] : [])) as { n: number }).n;
const rowsOf = (db: Db, kind: string) =>
  db.prepare('SELECT * FROM metric_events WHERE kind = ? ORDER BY at, id').all(kind) as Array<Record<string, unknown>>;

/** One PR through publication, a changes-requested review and a revision, on a fresh DB. */
function onePr() {
  const h = new History(END - DAY);
  h.queueIssue({ ...W, issue: 1, labelAgo: 30 * MIN });
  const code = h.run({ wait: MIN, runMs: 10 * MIN, verify: true });
  h.publish(code.runId, { ...W, issue: 1, pr: 5, delay: MIN });
  const review = h.review({ ...W, pr: 5, verdict: 'changes-requested', findings: 4, wait: MIN, runMs: 3 * MIN });
  const revision = h.revise({ ...W, pr: 5, wait: MIN, runMs: 5 * MIN });
  return { h, code, review, revision };
}

describe('metric_events writers', () => {
  it('records each fact once, in the shape stats reads, with ids, numbers and codes only', () => {
    const { h, code, review, revision } = onePr();
    const { db } = h;
    expect(rowsOf(db, 'run.ended')[0]).toMatchObject({
      subject_id: code.runId,
      repo_id: 42,
      repo_full_name: 'octo/widgets',
      job_kind: 'implement',
      agent: 'claude',
      pool: 'general',
      outcome: 'succeeded',
      reason: 'verify-passed',
      wait_ms: MIN,
      backfilled: 0,
    });
    const [ended] = rowsOf(db, 'run.ended');
    expect(Date.parse(ended!.at as string) - Date.parse(ended!.start_at as string)).toBe(10 * MIN);
    expect(rowsOf(db, 'job.finished').map((r) => [r.job_kind, r.outcome])).toEqual([
      ['implement', 'succeeded'],
      ['review', 'succeeded'],
      ['revision', 'succeeded'],
    ]);
    expect(rowsOf(db, 'pr.opened')).toMatchObject([{ subject_id: '42#5', pr_number: 5, outcome: 'draft-pr', reason: null, agent: 'claude' }]);
    const [opened] = rowsOf(db, 'pr.opened');
    // Label applied 30m before the job was queued; queued + 1m wait + 10m run + 1m to publish.
    expect(Date.parse(opened!.at as string) - Date.parse(opened!.start_at as string)).toBe(42 * MIN);
    expect(rowsOf(db, 'review.verdict')).toMatchObject([{ subject_id: review, pr_number: 5, agent: 'codex', outcome: 'changes-requested', findings: 4 }]);
    expect(rowsOf(db, 'change_request')).toMatchObject([{ subject_id: `42:updraft-review:${review}`, outcome: 'queued', reason: 'updraft_review', agent: null }]);
    expect(rowsOf(db, 'revision.pushed')).toMatchObject([{ subject_id: revision, pr_number: 5, agent: 'claude', reason: 'updraft_review' }]);

    // Nothing but ids, numbers, timestamps, names and codes: no issue, review or findings text,
    // no paths, no error messages.
    const text = JSON.stringify(db.prepare('SELECT * FROM metric_events').all());
    for (const leak of ['text that must not reach the rollup', 'Issue 1', 'please change it', '/runs', '/wt', 'run.log', 'agent failed', 'allen']) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('never records a fact twice: every writer, called again for the same state, changes nothing', () => {
    const { h, code, review, revision } = onePr();
    const { db } = h;
    h.merge({ ...W, pr: 5, step: { state: 'blocked', reason: 'it is still a draft', code: 'draft' } });
    db.prepare("UPDATE revision_prs SET limit_reached_at = ? WHERE repo_id = 42 AND pr_number = 5").run(h.iso());
    noteLimitReached(db, 42, 5);
    const before = metricRows(db);
    const replay = () => {
      noteRunEnded(db, code.runId);
      noteJobFinished(db, code.jobId);
      notePrOpened(db, code.runId);
      noteReview(db, review);
      noteChangeRequest(db, 42, `updraft-review:${review}`);
      noteRevisionPushed(db, revision);
      noteMergeBlocked(db, 42, 5, 'draft');
      noteLimitReached(db, 42, 5);
      // A different code for the same blocked head is still the same fact.
      noteMergeBlocked(db, 42, 5, 'checks-failed');
    };
    replay();
    replay();
    expect(metricRows(db)).toEqual(before);
    // A restart re-runs nothing that adds rows either; nor does the migration's backfill.
    backfillMetrics(db);
    expect(metricRows(db)).toEqual(before);
    expect(count(db, 'pr.merge_blocked')).toBe(1);
  });

  it('replays of the state changes themselves record nothing more', () => {
    const { h, code } = onePr();
    const { db } = h;
    const n = count(db);
    // finishRun on a closed run, a second publication finish, a request recorded twice, a merge
    // state that is already final: each is a no-op on state and so on the rollup.
    expect(finishRun(db, code.runId, { outcome: 'failed', now: h.now })).toBeNull();
    expect(finishPublication(db, code.runId, 1, { state: 'published', now: h.now })).toBe(false);
    const request = { repoId: 42, reviewId: 'PRR_1', prNumber: 5, reviewer: 'allen', trigger: 'changes_requested' as const, reviewUrl: null, submittedAt: null };
    expect(recordReviewRequest(db, { ...request, state: 'ignored', reason: 'r' }, h.now)).toBe(true);
    expect(recordReviewRequest(db, { ...request, state: 'ignored', reason: 'r' }, h.now)).toBe(false);
    expect(count(db)).toBe(n + 1);
    h.merge({ ...W, pr: 5, step: { state: 'merged', mergeCommitSha: 'm' } });
    const sha = getLoopPr(db, 42, 5)!.headSha!;
    expect(setMergeState(db, 42, 5, sha, { state: 'merged', mergeCommitSha: 'm' }, h.now)).toBe(false);
    expect(setMergeState(db, 42, 5, sha, { state: 'blocked', reason: 'late', code: 'other' }, h.now)).toBe(false);
    notePrMerged(db, 42, 5);
    notePrMerged(db, 42, 5);
    expect(count(db)).toBe(n + 2);
    expect(rowsOf(db, 'pr.merged')).toHaveLength(1);
    expect(rowsOf(db, 'pr.merge_blocked')).toHaveLength(0);
  });

  it('writes in the transaction of the state change: a change that is rolled back leaves no fact', () => {
    const { h, code } = onePr();
    const { db } = h;
    const n = count(db);
    // A stale publication attempt changes nothing, so it records nothing.
    expect(finishPublication(db, code.runId, 99, { state: 'published', now: h.now })).toBe(false);
    // A revision push by a superseded attempt throws, and its fact is not left behind.
    expect(() => holdRevision(db, 'run_missing', { attempt: 1, leaseSeconds: 60, now: h.now }, { pushedAt: h.iso() })).toThrow(/superseded/);
    // An outer failure after the change rolls both back.
    h.queueIssue({ ...W, issue: 2 });
    const job = db.prepare("SELECT id FROM jobs WHERE status = 'queued'").get() as { id: string };
    expect(() =>
      transaction(db, () => {
        db.prepare("UPDATE jobs SET status = 'canceled' WHERE id = ?").run(job.id);
        noteJobFinished(db, job.id);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count(db)).toBe(n);
    // And the real cancel records exactly one fact.
    expect(cancelQueuedJob(db, job.id, 'issue closed', h.now)).toBe(true);
    expect(cancelQueuedJob(db, job.id, 'issue closed', h.now)).toBe(false);
    expect(rowsOf(db, 'job.finished').filter((r) => r.job_id === job.id)).toMatchObject([{ outcome: 'canceled', agent: null }]);
  });

  it('records every way a job ends: user cancel, canceled with its PR, start failures, retries', () => {
    const h = new History(END - DAY);
    const { db } = h;
    // Canceled while queued by the user.
    const a = h.queueIssue({ ...W, issue: 1 });
    expect(requestJobCancel(db, a, h.now).kind).toBe('canceled');
    // Three start failures in a row fail the job; each closed run is its own fact.
    const b = h.queueIssue({ ...W, issue: 2 });
    for (let i = 0; i < 3; i++) h.run({ outcome: 'start_failed', wait: MIN });
    expect(rowsOf(db, 'run.ended').map((r) => [r.outcome, r.start_at, r.wait_ms])).toEqual([
      ['start_failed', null, null],
      ['start_failed', null, null],
      ['start_failed', null, null],
    ]);
    expect(rowsOf(db, 'job.finished').map((r) => [r.job_id, r.outcome])).toEqual([
      [a, 'canceled'],
      [b, 'failed'],
    ]);
    // A PR closed on GitHub cancels its queued revision.
    const c = h.queueIssue({ ...W, issue: 3 });
    const run = h.run({ runMs: MIN });
    expect(run.jobId).toBe(c);
    h.publish(run.runId, { ...W, issue: 3, pr: 30 });
    h.changeRequest({ ...W, pr: 30, reviewId: 'PRR_x' });
    const [revisionJob] = closeRevisionPr(db, 42, 30, 'closed', h.now);
    expect(rowsOf(db, 'job.finished').find((r) => r.job_id === revisionJob)).toMatchObject({ job_kind: 'revision', outcome: 'canceled', pr_number: 30 });
    expect(rowsOf(db, 'change_request')).toMatchObject([{ subject_id: '42:PRR_x', reason: 'changes_requested', outcome: 'queued' }]);
  });
});

describe('mergeReasonCodeSql', () => {
  const code = (db: Db, reason: string | null) =>
    (db.prepare(`SELECT ${mergeReasonCodeSql('t.r')} AS code FROM (SELECT ? AS r) t`).get(reason) as { code: MergeBlockCode }).code;

  // The reasons src/publish/merge.ts writes, with the code it records for each.
  it.each([
    ['action "implement-issue" is no longer configured, so it is unknown which verify commands apply', 'config'],
    ['workflow "wf" no longer exists in the config, so nobody\'s change requests could be honoured', 'config'],
    ['abc123 was not pushed by an Updraft run, so the verify commands of action "x" never ran on it', 'not-verified'],
    ['there is no record that the verify commands passed in run run_1, which pushed abc', 'not-verified'],
    ['the verify commands of run run_1 ran on abc, not on def, the commit to merge', 'not-verified'],
    ['the verify commands of run run_1 passed, but not on exactly abc: the worktree held uncommitted files', 'not-verified'],
    ['the merge was requested 3 times without an answer from GitHub, and the pull request is still open', 'no-answer'],
    ['the branch this pull request was opened against is not on record', 'base-changed'],
    ['its base branch is now dev, not main, which it was opened against', 'base-changed'],
    ['it is still a draft', 'draft'],
    ['GitHub reports that it cannot be merged as it is (dirty); it probably conflicts with main', 'unmergeable'],
    ['a "Request changes" review by allen is outstanding; it has to be approved or dismissed by a person', 'changes-requested'],
    ['2 check(s) of abc did not pass: test, lint', 'checks-failed'],
    ['the checks of abc could not all be read (40 seen), so it is unknown whether they passed', 'checks-unreadable'],
    ['gave up after waiting 60 minute(s): 1 check(s) of abc are pending: test', 'wait-timeout'],
    ['GitHub did not merge it: no reason given', 'merge-refused'],
    ['GitHub refused the merge (405): Base branch was modified', 'merge-refused'],
    ['GitHub could not be asked what the merge needs to know: boom', 'github-error'],
    ['something else entirely', 'other'],
  ])('reads %s as %s', (reason, expected) => {
    const db = openDatabase(':memory:');
    expect(code(db, reason)).toBe(expected);
    expect(code(db, null)).toBe('other');
  });
});

describe('backfillMetrics', () => {
  it('computes from existing rows exactly what the live writers recorded, except history the rows no longer hold', () => {
    const h = buildHistory(END);
    const live = metricRows(h.db);
    h.db.exec('DELETE FROM metric_events');
    backfillMetrics(h.db);
    const backfilled = metricRows(h.db);
    // The one difference: issue 3 failed, was retried and succeeded. The jobs table only holds
    // its final status, so the backfill cannot know of the failure before the retry.
    const lost = live.filter((r) => !backfilled.some((b) => b.kind === r.kind && b.subject_id === r.subject_id));
    expect(lost).toMatchObject([{ kind: 'job.finished', outcome: 'failed', subject_id: expect.stringMatching(/:1:failed$/) }]);
    expect(backfilled).toEqual(live.filter((r) => !lost.includes(r)));
    expect(h.db.prepare('SELECT DISTINCT backfilled FROM metric_events').all()).toEqual([{ backfilled: 1 }]);
    // The merge block code read from the recorded reason matches the one the live writer was given.
    expect(rowsOf(h.db, 'pr.merge_blocked')).toMatchObject([{ reason: 'checks-failed' }]);
  });

  it('still counts a PR whose publication was pruned, as approximate and without a lead time', () => {
    const h = new History(END - 2 * DAY);
    h.queueIssue({ ...W, issue: 1, labelAgo: HOUR });
    const r = h.run({ runMs: MIN });
    h.publish(r.runId, { ...W, issue: 1, pr: 77 });
    h.merge({ ...W, pr: 77, step: { state: 'merged', mergeCommitSha: 'm' }, delay: HOUR });
    h.db.exec('DELETE FROM metric_events; DELETE FROM publications; DELETE FROM runs; DELETE FROM jobs');
    backfillMetrics(h.db);
    expect(rowsOf(h.db, 'pr.opened')).toMatchObject([{ subject_id: '42#77', reason: 'approximate', start_at: null, repo_full_name: null }]);
    expect(rowsOf(h.db, 'pr.merged')).toMatchObject([{ subject_id: '42#77', start_at: null }]);
  });
});
