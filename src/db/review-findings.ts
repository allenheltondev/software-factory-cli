// review_findings (migration 19): the structured findings of Updraft's reviewer runs and the
// review thread each is discussed in (docs/review-loop.md, "Findings as threads").
//
// A thread is named by the key of the finding that started it (its root). A finding that repeats
// an earlier one (`sameAs`) is discussed in that finding's thread, so the coding agent's reply
// and the next reviewer's check go to one place, and a thread's status is kept on its root row.
import type { FindingSeverity, StructuredFinding } from '../agents/findings.js';
import { findingKey } from '../agents/findings.js';
import type { Db } from './database.js';

export type FindingStatus = 'open' | 'verified' | 'unresolved';
export type FindingResolution = 'fixed' | 'disagreed' | 'deferred' | 'unable' | 'unreported';
/** How the suggestion step closed a suggestion's thread (src/publish/suggestions.ts). */
export type SettledAs = 'fixed' | 'declined' | 'deferred';

export interface ReviewFinding {
  repoId: number;
  prNumber: number;
  key: string;
  runId: string;
  findingId: string;
  headSha: string;
  severity: FindingSeverity;
  title: string;
  problem: string;
  suggestion: string | null;
  path: string | null;
  line: number | null;
  threadKey: string;
  reviewId: number | null;
  commentId: number | null;
  commentUrl: string | null;
  status: FindingStatus;
  statusSha: string | null;
  statusNote: string | null;
  statusAt: string | null;
  resolution: FindingResolution | null;
  resolutionNote: string | null;
  resolutionSha: string | null;
  resolutionRunId: string | null;
  threadResolvedAt: string | null;
  settledAs: SettledAs | null;
  settledAt: string | null;
  settledIssue: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  repo_id: number;
  pr_number: number;
  finding_key: string;
  run_id: string;
  finding_id: string;
  head_sha: string;
  severity: FindingSeverity;
  title: string;
  problem: string;
  suggestion: string | null;
  path: string | null;
  line: number | null;
  thread_key: string;
  review_id: number | null;
  comment_id: number | null;
  comment_url: string | null;
  status: FindingStatus;
  status_sha: string | null;
  status_note: string | null;
  status_at: string | null;
  resolution: FindingResolution | null;
  resolution_note: string | null;
  resolution_sha: string | null;
  resolution_run_id: string | null;
  thread_resolved_at: string | null;
  settled_as?: SettledAs | null;
  settled_at?: string | null;
  settled_issue?: number | null;
  created_at: string;
  updated_at: string;
}

const toFinding = (r: Row): ReviewFinding => ({
  repoId: r.repo_id,
  prNumber: r.pr_number,
  key: r.finding_key,
  runId: r.run_id,
  findingId: r.finding_id,
  headSha: r.head_sha,
  severity: r.severity,
  title: r.title,
  problem: r.problem,
  suggestion: r.suggestion,
  path: r.path,
  line: r.line,
  threadKey: r.thread_key,
  reviewId: r.review_id,
  commentId: r.comment_id,
  commentUrl: r.comment_url,
  status: r.status,
  statusSha: r.status_sha,
  statusNote: r.status_note,
  statusAt: r.status_at,
  resolution: r.resolution,
  resolutionNote: r.resolution_note,
  resolutionSha: r.resolution_sha,
  resolutionRunId: r.resolution_run_id,
  threadResolvedAt: r.thread_resolved_at,
  settledAs: r.settled_as ?? null,
  settledAt: r.settled_at ?? null,
  settledIssue: r.settled_issue ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const iso = (now?: () => number) => new Date((now ?? Date.now)()).toISOString();

export function getFinding(db: Db, repoId: number, prNumber: number, key: string): ReviewFinding | null {
  const r = db.prepare('SELECT * FROM review_findings WHERE repo_id = ? AND pr_number = ? AND finding_key = ?').get(repoId, prNumber, key) as unknown as Row | undefined;
  return r ? toFinding(r) : null;
}

/** The findings of one reviewer run, in the order it wrote them. */
export function findingsOfRun(db: Db, runId: string): ReviewFinding[] {
  return (db.prepare('SELECT * FROM review_findings WHERE run_id = ? ORDER BY rowid').all(runId) as unknown as Row[]).map(toFinding);
}

/** The root of the thread `key` is discussed in, or null when the key is not a finding of this pull request. */
export function threadOf(db: Db, repoId: number, prNumber: number, key: string): ReviewFinding | null {
  const f = getFinding(db, repoId, prNumber, key);
  if (!f) return null;
  return f.threadKey === f.key ? f : getFinding(db, repoId, prNumber, f.threadKey);
}

/** How many earlier findings one reviewer is given to re-check: as many as one review can check. */
export const MAX_OPEN_FINDINGS = 50;

/**
 * The threads of a pull request that a later reviewer has not verified: what the next reviewer
 * re-checks. Blockers first, then oldest first, at most `limit`, so a long list of suggestions
 * never pushes a blocker out of the reviewer's sight.
 */
export function openThreads(db: Db, repoId: number, prNumber: number, limit = MAX_OPEN_FINDINGS): ReviewFinding[] {
  return (
    db
      .prepare(
        `SELECT * FROM review_findings WHERE repo_id = ? AND pr_number = ? AND thread_key = finding_key AND status != 'verified'
          ORDER BY CASE severity WHEN 'blocker' THEN 0 ELSE 1 END, created_at, rowid LIMIT ?`,
      )
      .all(repoId, prNumber, limit) as unknown as Row[]
  ).map(toFinding);
}

/** How many threads of a pull request no reviewer has verified. */
export function countOpenThreads(db: Db, repoId: number, prNumber: number): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM review_findings WHERE repo_id = ? AND pr_number = ? AND thread_key = finding_key AND status != 'verified'").get(repoId, prNumber) as { n: number } | undefined;
  return r?.n ?? 0;
}

/** Every blocker thread of a pull request that no reviewer has verified, however many: what a ready verdict must have verified. */
export function unverifiedBlockers(db: Db, repoId: number, prNumber: number): ReviewFinding[] {
  return (
    db
      .prepare("SELECT * FROM review_findings WHERE repo_id = ? AND pr_number = ? AND thread_key = finding_key AND status != 'verified' AND severity = 'blocker' ORDER BY created_at, rowid")
      .all(repoId, prNumber) as unknown as Row[]
  ).map(toFinding);
}

/**
 * The suggestion threads of a pull request the suggestion step has not closed yet: roots whose
 * severity is suggestion (a repeat never lowers a blocker), oldest first, that no reviewer has
 * verified, or that were verified without their thread being resolved on GitHub.
 */
export function openSuggestions(db: Db, repoId: number, prNumber: number, limit = MAX_OPEN_FINDINGS): ReviewFinding[] {
  return (
    db
      .prepare(
        `SELECT * FROM review_findings WHERE repo_id = ? AND pr_number = ? AND thread_key = finding_key AND severity = 'suggestion' AND settled_as IS NULL
            AND (status != 'verified' OR (comment_id IS NOT NULL AND thread_resolved_at IS NULL))
          ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(repoId, prNumber, limit) as unknown as Row[]
  ).map(toFinding);
}

/**
 * Thread roots a reviewer verified whose thread on GitHub is not recorded as resolved, on pull
 * requests of `repoId` that are still open: what the resolve step of each poll
 * (src/publish/thread-resolve.ts) resolves. By pull request, oldest first, at most `limit`.
 */
export function verifiedUnresolvedThreads(db: Db, repoId: number, limit = 200): ReviewFinding[] {
  return (
    db
      .prepare(
        `SELECT f.* FROM review_findings f JOIN revision_prs p ON p.repo_id = f.repo_id AND p.pr_number = f.pr_number
          WHERE f.repo_id = ? AND p.state = 'open' AND f.thread_key = f.finding_key AND f.status = 'verified'
            AND f.comment_id IS NOT NULL AND f.thread_resolved_at IS NULL
          ORDER BY f.pr_number, f.created_at, f.rowid LIMIT ?`,
      )
      .all(repoId, limit) as unknown as Row[]
  ).map(toFinding);
}

/** The suggestions of a pull request deferred to follow-up issue `issue`, oldest first: what that issue lists. */
export function deferredSuggestions(db: Db, repoId: number, prNumber: number, issue: number): ReviewFinding[] {
  return (
    db
      .prepare("SELECT * FROM review_findings WHERE repo_id = ? AND pr_number = ? AND thread_key = finding_key AND settled_as = 'deferred' AND settled_issue = ? ORDER BY created_at, rowid")
      .all(repoId, prNumber, issue) as unknown as Row[]
  ).map(toFinding);
}

/** The suggestion step closed this thread (`issue`: the follow-up issue it was deferred to): it is not answered again (until a reviewer repeats it). */
export function markSettled(db: Db, repoId: number, prNumber: number, threadKey: string, as: SettledAs, now?: () => number, issue?: number | null): void {
  db.prepare('UPDATE review_findings SET settled_as = ?, settled_at = ?, settled_issue = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ?').run(
    as,
    iso(now),
    issue ?? null,
    iso(now),
    repoId,
    prNumber,
    threadKey,
  );
}

/**
 * Record the findings of a reviewer run once its review is on GitHub. Idempotent: a retry of the
 * same run finds its rows and only fills in what it learned (the review, a thread's comment).
 * A finding that repeats an earlier finding of this pull request (`sameAs`) joins that finding's
 * thread; one that names a key this pull request does not have starts its own.
 */
export function recordFindings(
  db: Db,
  r: { repoId: number; prNumber: number; runId: string; headSha: string; reviewId: number | null; findings: StructuredFinding[]; now?: () => number },
): ReviewFinding[] {
  const at = iso(r.now);
  const insert = db.prepare(`
    INSERT INTO review_findings (repo_id, pr_number, finding_key, run_id, finding_id, head_sha, severity, title, problem, suggestion, path, line,
                                 thread_key, review_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo_id, pr_number, finding_key) DO UPDATE SET
      review_id = COALESCE(review_findings.review_id, excluded.review_id),
      updated_at = CASE WHEN review_findings.review_id IS NULL AND excluded.review_id IS NOT NULL THEN excluded.updated_at ELSE review_findings.updated_at END
  `);
  for (const f of r.findings) {
    const key = findingKey(r.runId, f.id);
    const root = f.sameAs ? threadOf(db, r.repoId, r.prNumber, f.sameAs) : null;
    insert.run(
      r.repoId,
      r.prNumber,
      key,
      r.runId,
      f.id,
      r.headSha,
      f.severity,
      f.title,
      f.problem,
      f.suggestion,
      f.path,
      f.location?.line ?? null,
      root && root.key !== key ? root.key : key,
      r.reviewId,
      at,
      at,
    );
  }
  return findingsOfRun(db, r.runId);
}

/** The thread's first comment, as the worker posted it with its review. */
export function setThreadComment(db: Db, repoId: number, prNumber: number, key: string, comment: { id: number; url: string }, now?: () => number): void {
  db.prepare('UPDATE review_findings SET comment_id = ?, comment_url = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ? AND comment_id IS NULL').run(
    comment.id,
    comment.url,
    iso(now),
    repoId,
    prNumber,
    key,
  );
}

/** The coding agent's report on a thread, recorded once its revision's push is confirmed. A claim, never a check. */
export function recordResolution(
  db: Db,
  repoId: number,
  prNumber: number,
  threadKey: string,
  r: { resolution: FindingResolution; note: string | null; sha: string; runId: string; now?: () => number },
): void {
  db.prepare(
    'UPDATE review_findings SET resolution = ?, resolution_note = ?, resolution_sha = ?, resolution_run_id = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ?',
  ).run(r.resolution, r.note, r.sha, r.runId, iso(r.now), repoId, prNumber, threadKey);
}

/**
 * A later reviewer's check of a thread against the head it reviewed. `at` is when that review
 * was recorded: a check from a review older than the one behind the thread's status changes
 * nothing, so a late retry of an old review never overwrites a newer verdict. Returns whether it
 * was recorded.
 */
export function recordCheck(db: Db, repoId: number, prNumber: number, threadKey: string, c: { status: 'verified' | 'unresolved'; sha: string; note: string; at: string; now?: () => number }): boolean {
  const res = db
    .prepare(
      'UPDATE review_findings SET status = ?, status_sha = ?, status_note = ?, status_at = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ? AND (status_at IS NULL OR status_at <= ?)',
    )
    .run(c.status, c.sha, c.note, c.at, iso(c.now), repoId, prNumber, threadKey, c.at);
  return Number(res.changes) > 0;
}

/**
 * A finding of a current review that repeats an earlier one: the thread is unresolved again, and
 * carries what the reviewer found now (its text and place), so the next round sees the finding as
 * it is, not as it was first written. Its severity only ever goes up: a blocker that is repeated is
 * still not fixed, so a repeat that calls it a suggestion does not make it one. Guarded like
 * recordCheck.
 */
export function applyRepeat(db: Db, repoId: number, prNumber: number, threadKey: string, repeat: ReviewFinding, at: string, now?: () => number): boolean {
  const res = db
    .prepare(
      `UPDATE review_findings SET severity = CASE WHEN severity = 'blocker' THEN 'blocker' ELSE ? END, title = ?, problem = ?, suggestion = ?, path = ?, line = ?,
              status = 'unresolved', status_sha = ?, status_note = ?, status_at = ?, settled_as = NULL, settled_at = NULL, settled_issue = NULL,
              updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ? AND (status_at IS NULL OR status_at <= ?)`,
    )
    .run(repeat.severity, repeat.title, repeat.problem, repeat.suggestion, repeat.path, repeat.line, repeat.headSha, repeat.problem, at, iso(now), repoId, prNumber, threadKey, at);
  return Number(res.changes) > 0;
}

/**
 * The thread of `alias` (a repeat) moves to `alias` itself: the earlier finding had no thread on
 * GitHub, and the repeat was posted inline. Every finding of the old thread follows it, and the
 * new root takes over the old root's report, so nothing of the thread's history is lost.
 */
export function promoteThread(db: Db, repoId: number, prNumber: number, alias: string, now?: () => number): void {
  const a = getFinding(db, repoId, prNumber, alias);
  if (!a || a.threadKey === a.key) return;
  const old = getFinding(db, repoId, prNumber, a.threadKey);
  const at = iso(now);
  db.prepare('UPDATE review_findings SET thread_key = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND (thread_key = ? OR finding_key = ?)').run(alias, at, repoId, prNumber, a.threadKey, alias);
  if (old) {
    db.prepare(
      `UPDATE review_findings SET status = ?, status_sha = ?, status_note = ?, status_at = ?, resolution = ?, resolution_note = ?, resolution_sha = ?, resolution_run_id = ?,
              severity = CASE WHEN ? = 'blocker' THEN 'blocker' ELSE severity END, updated_at = ?
       WHERE repo_id = ? AND pr_number = ? AND finding_key = ?`,
    ).run(old.status, old.statusSha, old.statusNote, old.statusAt, old.resolution, old.resolutionNote, old.resolutionSha, old.resolutionRunId, old.severity, at, repoId, prNumber, alias);
  }
}

/** The thread was reopened on GitHub (a later review found it unresolved again). */
export function markThreadReopened(db: Db, repoId: number, prNumber: number, threadKey: string, now?: () => number): void {
  db.prepare('UPDATE review_findings SET thread_resolved_at = NULL, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ?').run(iso(now), repoId, prNumber, threadKey);
}

export function markThreadResolved(db: Db, repoId: number, prNumber: number, threadKey: string, now?: () => number): void {
  db.prepare('UPDATE review_findings SET thread_resolved_at = COALESCE(thread_resolved_at, ?), updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ?').run(
    iso(now),
    iso(now),
    repoId,
    prNumber,
    threadKey,
  );
}

/** Which round of review a reviewer run is on its pull request: 1 for the first Updraft review, and so on. */
export function reviewRound(db: Db, runId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pr_reviews p, pr_reviews me
        WHERE me.run_id = ? AND p.repo_id = me.repo_id AND p.pr_number = me.pr_number
          AND (p.created_at < me.created_at OR (p.created_at = me.created_at AND p.rowid <= me.rowid))`,
    )
    .get(runId) as { n: number } | undefined;
  return Math.max(1, row?.n ?? 1);
}
