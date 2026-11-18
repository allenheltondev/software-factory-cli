// Persistence for the failure comment (repositories.<repo>.commentOnFailure): one comment on the
// issue when a live run leaves its job failed. Kept apart from runs so commenting never changes a
// run's outcome, and apart from publications, which only exist for succeeded runs. The lease and
// attempt fence work the way publications' do. See src/publish/failure-comment.ts.
import { nowIso } from '../util/ids.js';
import { transaction, type Db } from './database.js';

export type FailureCommentState = 'posting' | 'posted' | 'failed' | 'skipped';

/** The comment that tells an issue its run failed, or why it was not posted. */
export interface FailureComment {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  state: FailureCommentState;
  commentId: number | null;
  commentUrl: string | null;
  /** Why it failed, or why it was skipped. */
  error: string | null;
  /** A transient failure (network, 5xx, rate limit) the worker retries on its own. */
  retryable: boolean;
  attempts: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  postedAt: string | null;
}

interface FailureCommentRow {
  run_id: string;
  job_id: string;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
  state: FailureCommentState;
  comment_id: number | null;
  comment_url: string | null;
  error: string | null;
  retryable: number;
  attempts: number;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  posted_at: string | null;
}

function rowToFailureComment(r: FailureCommentRow): FailureComment {
  return {
    runId: r.run_id,
    jobId: r.job_id,
    repoId: r.repo_id,
    repoFullName: r.repo_full_name,
    issueNumber: r.issue_number,
    state: r.state,
    commentId: r.comment_id,
    commentUrl: r.comment_url,
    error: r.error,
    retryable: r.retryable === 1,
    attempts: r.attempts,
    leaseExpiresAt: r.lease_expires_at,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    postedAt: r.posted_at,
  };
}

export function getFailureComment(db: Db, runId: string): FailureComment | null {
  const row = db.prepare('SELECT * FROM failure_comments WHERE run_id = ?').get(runId) as FailureCommentRow | undefined;
  return row ? rowToFailureComment(row) : null;
}

export interface BeginFailureComment {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  leaseSeconds: number;
  now?: () => number;
}

export type BeginFailureCommentResult =
  | { ok: true; comment: FailureComment }
  | { ok: false; reason: 'posted' | 'in-progress'; comment: FailureComment };

/**
 * Take the failure comment of a run: create its row, or reopen a failed or skipped one, in state
 * 'posting' with a lease. Refuses one that is already posted, or being posted by another process
 * whose lease has not expired.
 */
export function beginFailureComment(db: Db, b: BeginFailureComment): BeginFailureCommentResult {
  const clock = b.now ?? Date.now;
  const at = nowIso(clock);
  const lease = new Date(clock() + b.leaseSeconds * 1000).toISOString();
  return transaction(db, () => {
    const existing = getFailureComment(db, b.runId);
    if (!existing) {
      db.prepare(
        `INSERT INTO failure_comments (run_id, job_id, repo_id, repo_full_name, issue_number, state, attempts,
                                       lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'posting', 1, ?, ?, ?)`,
      ).run(b.runId, b.jobId, b.repoId, b.repoFullName, b.issueNumber, lease, at, at);
      return { ok: true, comment: getFailureComment(db, b.runId)! };
    }
    if (existing.state === 'posted') return { ok: false, reason: 'posted', comment: existing };
    if (existing.state === 'posting' && existing.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) > clock()) {
      return { ok: false, reason: 'in-progress', comment: existing };
    }
    db.prepare(
      `UPDATE failure_comments SET state = 'posting', attempts = attempts + 1, lease_expires_at = ?,
              next_attempt_at = NULL, updated_at = ? WHERE run_id = ?`,
    ).run(lease, at, b.runId);
    return { ok: true, comment: getFailureComment(db, b.runId)! };
  });
}

/**
 * The attempt that wrote this no longer owns the comment: a newer attempt took it over (its lease
 * had expired), or it was finished. The stale attempt must stop without touching GitHub or the
 * row again.
 */
export class FailureCommentSupersededError extends Error {
  constructor(runId: string, attempt: number) {
    super(`failure comment for run ${runId}: attempt ${attempt} was superseded by a newer attempt`);
    this.name = 'FailureCommentSupersededError';
  }
}

/** Which attempt is writing, and how long each write extends its lease. */
export interface FailureCommentFence {
  attempt: number;
  leaseSeconds: number;
  now?: () => number;
}

const OWNED = `run_id = ? AND attempts = ? AND state = 'posting'`;

/**
 * Confirm `fence.attempt` still owns the comment and extend its lease. Call before each request
 * to GitHub, so a newer attempt can only take over once this one can no longer write. Throws
 * FailureCommentSupersededError.
 */
export function holdFailureComment(db: Db, runId: string, fence: FailureCommentFence): void {
  const clock = fence.now ?? Date.now;
  const lease = new Date(clock() + fence.leaseSeconds * 1000).toISOString();
  const res = db.prepare(`UPDATE failure_comments SET lease_expires_at = ?, updated_at = ? WHERE ${OWNED}`).run(lease, nowIso(clock), runId, fence.attempt);
  if (Number(res.changes) === 0) throw new FailureCommentSupersededError(runId, fence.attempt);
}

/**
 * Close the owning attempt, recording the comment when there is one. Returns false (and changes
 * nothing) when `attempt` no longer owns it, so a stale attempt can't overwrite a newer one's state.
 */
export function finishFailureComment(
  db: Db,
  runId: string,
  attempt: number,
  r: {
    state: 'posted' | 'failed' | 'skipped';
    commentId?: number;
    commentUrl?: string;
    error?: string | null;
    retryable?: boolean;
    nextAttemptAt?: string | null;
    now?: () => number;
  },
): boolean {
  const at = nowIso(r.now);
  const res = db
    .prepare(
      `UPDATE failure_comments SET state = ?, comment_id = coalesce(?, comment_id), comment_url = coalesce(?, comment_url),
              error = ?, retryable = ?, next_attempt_at = ?, lease_expires_at = NULL,
              posted_at = CASE WHEN ? = 'posted' THEN ? ELSE posted_at END, updated_at = ?
       WHERE ${OWNED}`,
    )
    .run(r.state, r.commentId ?? null, r.commentUrl ?? null, r.error ?? null, r.retryable ? 1 : 0, r.nextAttemptAt ?? null, r.state, at, at, runId, attempt);
  return Number(res.changes) > 0;
}

/**
 * Runs whose failure comment the worker should try again now: retryable failures whose next
 * attempt is due, and comments whose worker stopped mid-way (lease expired), up to `maxAttempts`.
 */
export function listDueFailureComments(db: Db, opts: { maxAttempts: number; now?: () => number }): string[] {
  const at = nowIso(opts.now);
  return (
    db
      .prepare(
        `SELECT run_id FROM failure_comments
         WHERE attempts < ?
           AND ((state = 'failed' AND retryable = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (state = 'posting' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
         ORDER BY updated_at`,
      )
      .all(opts.maxAttempts, at, at) as { run_id: string }[]
  ).map((r) => r.run_id);
}

/** Newest first, for `factory status`. */
export function listRecentFailureComments(db: Db, limit = 10): FailureComment[] {
  return (
    db.prepare('SELECT * FROM failure_comments ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(limit) as unknown as FailureCommentRow[]
  ).map(rowToFailureComment);
}
