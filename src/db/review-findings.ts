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
  resolution: FindingResolution | null;
  resolutionNote: string | null;
  resolutionSha: string | null;
  resolutionRunId: string | null;
  threadResolvedAt: string | null;
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
  resolution: FindingResolution | null;
  resolution_note: string | null;
  resolution_sha: string | null;
  resolution_run_id: string | null;
  thread_resolved_at: string | null;
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
  resolution: r.resolution,
  resolutionNote: r.resolution_note,
  resolutionSha: r.resolution_sha,
  resolutionRunId: r.resolution_run_id,
  threadResolvedAt: r.thread_resolved_at,
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

/**
 * The threads of a pull request that a later reviewer has not verified, oldest first: what the
 * next reviewer re-checks. At most `limit`.
 */
export function openThreads(db: Db, repoId: number, prNumber: number, limit = 30): ReviewFinding[] {
  return (
    db
      .prepare("SELECT * FROM review_findings WHERE repo_id = ? AND pr_number = ? AND thread_key = finding_key AND status != 'verified' ORDER BY created_at, rowid LIMIT ?")
      .all(repoId, prNumber, limit) as unknown as Row[]
  ).map(toFinding);
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
    // A repeated finding reopens its thread: the reviewer found it is still there.
    if (root && root.key !== key && root.status === 'verified') {
      db.prepare("UPDATE review_findings SET status = 'unresolved', status_sha = ?, status_note = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ?").run(
        r.headSha,
        f.problem,
        at,
        r.repoId,
        r.prNumber,
        root.key,
      );
    }
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

/** A later reviewer's check of a thread against the head it reviewed. */
export function recordCheck(db: Db, repoId: number, prNumber: number, threadKey: string, c: { status: 'verified' | 'unresolved'; sha: string; note: string; now?: () => number }): void {
  db.prepare('UPDATE review_findings SET status = ?, status_sha = ?, status_note = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND finding_key = ?').run(
    c.status,
    c.sha,
    c.note,
    iso(c.now),
    repoId,
    prNumber,
    threadKey,
  );
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
