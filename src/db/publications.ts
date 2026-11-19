// Persistence for publication (push the job branch, open a PR, comment on the issue). Kept in
// its own table so publishing never changes a run's outcome. See src/publish/publish.ts.
import type { Publication, PublicationState } from '../types.js';
import { nowIso } from '../util/ids.js';
import { transaction, type Db } from './database.js';
import { notePrOpened } from './metrics.js';

interface PublicationRow {
  run_id: string;
  job_id: string;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
  mode: 'draft-pr' | 'pr';
  state: PublicationState;
  branch: string;
  base_branch: string | null;
  head_sha: string | null;
  pushed_at: string | null;
  pr_number: number | null;
  pr_url: string | null;
  comment_id: number | null;
  comment_url: string | null;
  error: string | null;
  retryable: number;
  attempts: number;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

function rowToPublication(r: PublicationRow): Publication {
  return {
    runId: r.run_id,
    jobId: r.job_id,
    repoId: r.repo_id,
    repoFullName: r.repo_full_name,
    issueNumber: r.issue_number,
    mode: r.mode,
    state: r.state,
    branch: r.branch,
    baseBranch: r.base_branch,
    headSha: r.head_sha,
    pushedAt: r.pushed_at,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    commentId: r.comment_id,
    commentUrl: r.comment_url,
    error: r.error,
    retryable: r.retryable === 1,
    attempts: r.attempts,
    leaseExpiresAt: r.lease_expires_at,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  };
}

export function getPublication(db: Db, runId: string): Publication | null {
  const row = db.prepare('SELECT * FROM publications WHERE run_id = ?').get(runId) as PublicationRow | undefined;
  return row ? rowToPublication(row) : null;
}

export interface BeginPublication {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  mode: 'draft-pr' | 'pr';
  branch: string;
  leaseSeconds: number;
  now?: () => number;
}

export type BeginResult =
  | { ok: true; publication: Publication }
  | { ok: false; reason: 'published' | 'in-progress'; publication: Publication };

/**
 * Take the publication of a run: create its row, or reopen a failed or skipped one, in state
 * 'publishing' with a lease. Refuses one that is already published, or being published by
 * another process whose lease has not expired (the worker and `updraft publish` share this).
 */
export function beginPublication(db: Db, b: BeginPublication): BeginResult {
  const clock = b.now ?? Date.now;
  const at = nowIso(clock);
  const lease = new Date(clock() + b.leaseSeconds * 1000).toISOString();
  return transaction(db, () => {
    const existing = getPublication(db, b.runId);
    if (!existing) {
      db.prepare(
        `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, attempts,
                                   lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'publishing', ?, 1, ?, ?, ?)`,
      ).run(b.runId, b.jobId, b.repoId, b.repoFullName, b.issueNumber, b.mode, b.branch, lease, at, at);
      return { ok: true, publication: getPublication(db, b.runId)! };
    }
    if (existing.state === 'published') return { ok: false, reason: 'published', publication: existing };
    if (existing.state === 'publishing' && existing.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) > clock()) {
      return { ok: false, reason: 'in-progress', publication: existing };
    }
    // The mode follows the current config, so switching draft-pr to pr after GitHub refused a
    // draft takes effect on the retry.
    db.prepare(
      `UPDATE publications SET state = 'publishing', mode = ?, attempts = attempts + 1, lease_expires_at = ?,
              next_attempt_at = NULL, updated_at = ? WHERE run_id = ?`,
    ).run(b.mode, lease, at, b.runId);
    return { ok: true, publication: getPublication(db, b.runId)! };
  });
}

/**
 * The attempt that wrote this no longer owns the publication: a newer attempt took it over (its
 * lease had expired), or it was finished. The stale attempt must stop without touching GitHub or
 * the row again.
 */
export class PublicationSupersededError extends Error {
  constructor(runId: string, attempt: number) {
    super(`publication of run ${runId}: attempt ${attempt} was superseded by a newer attempt`);
    this.name = 'PublicationSupersededError';
  }
}

/** Which attempt is writing, and how long each write extends its lease. */
export interface PublicationFence {
  attempt: number;
  leaseSeconds: number;
  now?: () => number;
}

const OWNED = `run_id = ? AND attempts = ? AND state = 'publishing'`;

/**
 * Confirm `fence.attempt` still owns the publication and extend its lease. Call before each
 * external write (push, PR, comment), each of which is bounded well inside the lease, so a newer
 * attempt can only take over once this one can no longer write. Throws PublicationSupersededError.
 */
export function holdPublication(db: Db, runId: string, fence: PublicationFence): void {
  const clock = fence.now ?? Date.now;
  const lease = new Date(clock() + fence.leaseSeconds * 1000).toISOString();
  const res = db.prepare(`UPDATE publications SET lease_expires_at = ?, updated_at = ? WHERE ${OWNED}`).run(lease, nowIso(clock), runId, fence.attempt);
  if (Number(res.changes) === 0) throw new PublicationSupersededError(runId, fence.attempt);
}

/** Progress recorded as each step completes, so a retry resumes after it. */
export interface PublicationProgress {
  baseBranch?: string;
  headSha?: string;
  pushedAt?: string;
  prNumber?: number;
  prUrl?: string;
  commentId?: number;
  commentUrl?: string;
}

const PROGRESS_COLUMNS: Record<keyof PublicationProgress, string> = {
  baseBranch: 'base_branch',
  headSha: 'head_sha',
  pushedAt: 'pushed_at',
  prNumber: 'pr_number',
  prUrl: 'pr_url',
  commentId: 'comment_id',
  commentUrl: 'comment_url',
};

/** Record progress for the owning attempt (and extend its lease). Throws PublicationSupersededError. */
export function recordPublicationProgress(db: Db, runId: string, fence: PublicationFence, p: PublicationProgress): void {
  const clock = fence.now ?? Date.now;
  const sets: string[] = ['lease_expires_at = ?'];
  const values: Array<string | number> = [new Date(clock() + fence.leaseSeconds * 1000).toISOString()];
  for (const [key, column] of Object.entries(PROGRESS_COLUMNS) as Array<[keyof PublicationProgress, string]>) {
    const v = p[key];
    if (v !== undefined) {
      sets.push(`${column} = ?`);
      values.push(v);
    }
  }
  const res = db
    .prepare(`UPDATE publications SET ${sets.join(', ')}, updated_at = ? WHERE ${OWNED}`)
    .run(...values, nowIso(clock), runId, fence.attempt);
  if (Number(res.changes) === 0) throw new PublicationSupersededError(runId, fence.attempt);
}

/**
 * Close the owning attempt's publication. Returns false (and changes nothing) when `attempt` no
 * longer owns it, so a stale attempt can't overwrite a newer attempt's state.
 */
export function finishPublication(
  db: Db,
  runId: string,
  attempt: number,
  r: { state: 'published' | 'failed' | 'skipped'; error?: string | null; retryable?: boolean; nextAttemptAt?: string | null; now?: () => number },
): boolean {
  const at = nowIso(r.now);
  return transaction(db, () => {
    const res = db
      .prepare(
        `UPDATE publications SET state = ?, error = ?, retryable = ?, next_attempt_at = ?, lease_expires_at = NULL,
                published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END, updated_at = ?
         WHERE ${OWNED}`,
      )
      .run(r.state, r.error ?? null, r.retryable ? 1 : 0, r.nextAttemptAt ?? null, r.state, at, at, runId, attempt);
    if (Number(res.changes) === 0) return false;
    if (r.state === 'published') notePrOpened(db, runId);
    return true;
  });
}

/**
 * Runs the worker should publish again now: retryable failures whose next attempt is due, and
 * publications whose worker stopped mid-way (lease expired), up to `maxAttempts` attempts.
 */
export function listDuePublications(db: Db, opts: { maxAttempts: number; now?: () => number }): string[] {
  const at = nowIso(opts.now);
  return (
    db
      .prepare(
        `SELECT run_id FROM publications
         WHERE attempts < ?
           AND ((state = 'failed' AND retryable = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (state = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
         ORDER BY updated_at`,
      )
      .all(opts.maxAttempts, at, at) as { run_id: string }[]
  ).map((r) => r.run_id);
}

/** Newest first, for `updraft status`. */
/**
 * Pull requests Updraft published, newest first, one row per PR (its newest published
 * publication), and how many there are in all. Filtered and deduplicated before the limit is
 * applied, so `limit` PRs come back whenever that many exist, however many failed or repeated
 * publications sit between them, and `total` counts the same set.
 */
export function listPublishedPulls(db: Db, limit: number): { pulls: Array<Publication & { prNumber: number }>; total: number } {
  const rows = db
    .prepare(
      `SELECT p.* FROM publications p
       WHERE p.state = 'published' AND p.pr_number IS NOT NULL
         AND p.rowid = (
           SELECT q.rowid FROM publications q
           WHERE q.state = 'published' AND q.repo_id = p.repo_id AND q.pr_number = p.pr_number
           ORDER BY q.updated_at DESC, q.rowid DESC LIMIT 1
         )
       ORDER BY p.updated_at DESC, p.rowid DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as PublicationRow[];
  const { n } = db
    .prepare("SELECT count(*) AS n FROM (SELECT DISTINCT repo_id, pr_number FROM publications WHERE state = 'published' AND pr_number IS NOT NULL)")
    .get() as { n: number };
  return { pulls: rows.map(rowToPublication) as Array<Publication & { prNumber: number }>, total: n };
}

export function listRecentPublications(db: Db, limit = 10): Publication[] {
  return (
    db.prepare('SELECT * FROM publications ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(limit) as unknown as PublicationRow[]
  ).map(rowToPublication);
}
