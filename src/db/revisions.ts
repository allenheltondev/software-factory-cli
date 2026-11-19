// Persistence for the revision loop (repositories.<repo>.revise): the watched PRs, the change
// requests seen on them, the revision jobs they queue, and the push and reply of each revision
// run. See src/poller/reviews.ts (ingestion) and src/publish/revision.ts (push and reply).
import type { EventEnvelope, Job, PublicationState, Revision, RevisionTriggerKind } from '../types.js';
import { ENVELOPE_SCHEMA_VERSION } from '../types.js';
import { newId, nowIso } from '../util/ids.js';
import { rowToJob, transaction, type Db, type JobRow } from './database.js';
import type { NewJob } from './ingest.js';
import { noteChangeRequest, noteJobFinished, noteLimitReached, noteRevisionPushed } from './metrics.js';

/** Attempts (first try included) before the worker stops retrying a revision's push or reply on its own. */
export const REVISION_MAX_AUTO_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Watched pull requests
// ---------------------------------------------------------------------------

/** A PR Updraft opened, with what a revision job for it needs. */
export interface RevisionPr {
  repoId: number;
  prNumber: number;
  prUrl: string;
  sourceRunId: string;
  originalEventId: string;
  workflowId: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  label: string;
  labels: string[];
  action: string;
  pool: string;
  branch: string;
  baseBranch: string | null;
  state: 'open' | 'closed';
  /** The PR's updated_at when its reviews were last read; null before the first read. */
  seenUpdatedAt: string | null;
  limitReachedAt: string | null;
  limitCommentId: number | null;
  limitCommentUrl: string | null;
  limitCommentAttempts: number;
  limitCommentError: string | null;
}

export interface RevisionPrRow {
  repo_id: number;
  pr_number: number;
  pr_url: string;
  source_run_id: string;
  original_event_id: string;
  workflow_id: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  label: string;
  labels: string;
  action: string;
  pool: string;
  branch: string;
  base_branch: string | null;
  state: 'open' | 'closed';
  seen_updated_at: string | null;
  limit_reached_at: string | null;
  limit_comment_id: number | null;
  limit_comment_url: string | null;
  limit_comment_attempts: number;
  limit_comment_error: string | null;
}

function parseLabels(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToRevisionPr(r: RevisionPrRow): RevisionPr {
  return {
    repoId: r.repo_id,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    sourceRunId: r.source_run_id,
    originalEventId: r.original_event_id,
    workflowId: r.workflow_id,
    issueNumber: r.issue_number,
    issueTitle: r.issue_title,
    issueUrl: r.issue_url,
    label: r.label,
    labels: parseLabels(r.labels),
    action: r.action,
    pool: r.pool,
    branch: r.branch,
    baseBranch: r.base_branch,
    state: r.state,
    seenUpdatedAt: r.seen_updated_at,
    limitReachedAt: r.limit_reached_at,
    limitCommentId: r.limit_comment_id,
    limitCommentUrl: r.limit_comment_url,
    limitCommentAttempts: r.limit_comment_attempts,
    limitCommentError: r.limit_comment_error,
  };
}

/**
 * Start watching the PRs of this repository's published publications that are not watched yet.
 * Only publications qualify: a PR that Updraft did not open has no row there and is never
 * watched. Returns how many PRs were added.
 */
export function syncRevisionPrs(db: Db, repoId: number, now?: () => number): number {
  const at = nowIso(now);
  return transaction(db, () => {
    const rows = db
      .prepare(
        `SELECT p.run_id, p.pr_number, p.pr_url, p.branch, p.base_branch, j.*
         FROM publications p JOIN jobs j ON j.id = p.job_id
         WHERE p.repo_id = ? AND p.state = 'published' AND p.pr_number IS NOT NULL AND p.pr_url IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM revision_prs w WHERE w.repo_id = p.repo_id AND w.pr_number = p.pr_number)
         ORDER BY p.published_at, p.rowid`,
      )
      .all(repoId) as unknown as Array<JobRow & { run_id: string; pr_number: number; pr_url: string; branch: string; base_branch: string | null }>;
    const insert = db.prepare(
      `INSERT INTO revision_prs
         (repo_id, pr_number, pr_url, source_run_id, original_event_id, workflow_id, issue_number, issue_title, issue_url,
          label, labels, action, pool, branch, base_branch, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
       ON CONFLICT (repo_id, pr_number) DO NOTHING`,
    );
    let added = 0;
    for (const r of rows) {
      const job = rowToJob(r);
      // Only an issue job opens a PR; anything else here would be a row someone edited by hand.
      if (job.envelope.type !== 'issue.labeled') continue;
      const res = insert.run(
        repoId,
        r.pr_number,
        r.pr_url,
        r.run_id,
        job.eventId,
        job.workflowId,
        job.issueNumber,
        job.envelope.issue.title,
        job.envelope.issue.url,
        job.envelope.label,
        JSON.stringify(job.envelope.labelsAtEnqueue),
        job.action,
        job.pool,
        r.branch,
        r.base_branch,
        at,
        at,
      );
      added += Number(res.changes);
    }
    return added;
  });
}

export function getRevisionPr(db: Db, repoId: number, prNumber: number): RevisionPr | null {
  const row = db.prepare('SELECT * FROM revision_prs WHERE repo_id = ? AND pr_number = ?').get(repoId, prNumber) as RevisionPrRow | undefined;
  return row ? rowToRevisionPr(row) : null;
}

export function listOpenRevisionPrs(db: Db, repoId: number): RevisionPr[] {
  return (
    db.prepare("SELECT * FROM revision_prs WHERE repo_id = ? AND state = 'open' ORDER BY pr_number").all(repoId) as unknown as RevisionPrRow[]
  ).map(rowToRevisionPr);
}

/** Record that the PR's reviews were read when its updated_at was `updatedAt`. */
export function markRevisionPrSeen(db: Db, repoId: number, prNumber: number, updatedAt: string, now?: () => number): void {
  db.prepare('UPDATE revision_prs SET seen_updated_at = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ?').run(updatedAt, nowIso(now), repoId, prNumber);
}

/**
 * The PR was closed or merged (or can no longer be read): stop watching it and cancel the
 * revision jobs still queued for it, in one transaction. A revision that is running is left to
 * finish; its push checks this state again. Returns the ids of the jobs canceled.
 */
export function closeRevisionPr(db: Db, repoId: number, prNumber: number, reason: string, now?: () => number): string[] {
  const at = nowIso(now);
  return transaction(db, () => {
    db.prepare("UPDATE revision_prs SET state = 'closed', updated_at = ? WHERE repo_id = ? AND pr_number = ?").run(at, repoId, prNumber);
    const queued = db
      .prepare(
        `SELECT j.id FROM jobs j JOIN review_requests r ON r.job_id = j.id
         WHERE r.repo_id = ? AND r.pr_number = ? AND j.status = 'queued' ORDER BY j.created_at, j.rowid`,
      )
      .all(repoId, prNumber) as { id: string }[];
    const cancel = db.prepare("UPDATE jobs SET status = 'canceled', status_reason = ?, updated_at = ? WHERE id = ? AND status = 'queued'");
    for (const j of queued) {
      cancel.run(reason, at, j.id);
      noteJobFinished(db, j.id);
    }
    return queued.map((j) => j.id);
  });
}

// ---------------------------------------------------------------------------
// Listing checkpoint
// ---------------------------------------------------------------------------

export interface ReviewCheckpoint {
  etag: string | null;
  /** Newest updated_at seen by the last committed scan of the pull request listing. */
  lastUpdatedAt: string | null;
}

export function getReviewCheckpoint(db: Db, repoId: number): ReviewCheckpoint | null {
  const r = db.prepare('SELECT etag, last_updated_at FROM review_checkpoints WHERE repo_id = ?').get(repoId) as
    | { etag: string | null; last_updated_at: string | null }
    | undefined;
  return r ? { etag: r.etag, lastUpdatedAt: r.last_updated_at } : null;
}

/** Store the listing position. `lastUpdatedAt` never moves backwards; null keeps the stored value. */
export function saveReviewCheckpoint(db: Db, repoId: number, cp: ReviewCheckpoint, now?: () => number): void {
  db.prepare(
    `INSERT INTO review_checkpoints (repo_id, etag, last_updated_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET
       etag = excluded.etag,
       last_updated_at = CASE
         WHEN review_checkpoints.last_updated_at IS NULL THEN excluded.last_updated_at
         WHEN excluded.last_updated_at IS NULL THEN review_checkpoints.last_updated_at
         WHEN julianday(excluded.last_updated_at) > julianday(review_checkpoints.last_updated_at) THEN excluded.last_updated_at
         ELSE review_checkpoints.last_updated_at
       END,
       updated_at = excluded.updated_at`,
  ).run(repoId, cp.etag, cp.lastUpdatedAt, nowIso(now));
}

// ---------------------------------------------------------------------------
// Change requests
// ---------------------------------------------------------------------------

/**
 * queued: a revision job was created. over-limit: the PR had used up maxRevisions. ignored: it
 * would have triggered, but something made it unsafe or impossible (see `reason`). not-allowed:
 * its author is not an allowed actor (kept only so the review is never looked at again).
 */
export type ReviewRequestState = 'queued' | 'over-limit' | 'ignored' | 'not-allowed';

export interface ReviewRequest {
  repoId: number;
  reviewId: string;
  prNumber: number;
  reviewer: string | null;
  trigger: RevisionTriggerKind;
  reviewUrl: string | null;
  submittedAt: string | null;
  state: ReviewRequestState;
  reason: string | null;
  jobId: string | null;
  createdAt: string;
}

interface ReviewRequestRow {
  repo_id: number;
  review_id: string;
  pr_number: number;
  reviewer: string | null;
  trigger_kind: RevisionTriggerKind;
  review_url: string | null;
  submitted_at: string | null;
  state: ReviewRequestState;
  reason: string | null;
  job_id: string | null;
  created_at: string;
}

function rowToReviewRequest(r: ReviewRequestRow): ReviewRequest {
  return {
    repoId: r.repo_id,
    reviewId: r.review_id,
    prNumber: r.pr_number,
    reviewer: r.reviewer,
    trigger: r.trigger_kind,
    reviewUrl: r.review_url,
    submittedAt: r.submitted_at,
    state: r.state,
    reason: r.reason,
    jobId: r.job_id,
    createdAt: r.created_at,
  };
}

export function getReviewRequest(db: Db, repoId: number, reviewId: string): ReviewRequest | null {
  const row = db.prepare('SELECT * FROM review_requests WHERE repo_id = ? AND review_id = ?').get(repoId, reviewId) as ReviewRequestRow | undefined;
  return row ? rowToReviewRequest(row) : null;
}

/**
 * Revision jobs this PR has been given: change requests that queued a job, except those whose
 * job was canceled before it ran to an end. A job that was pruned still counts, and so does one
 * that was canceled because another machine had already made the revision ("superseded: ",
 * src/publish/revision.ts): the pull request got that revision, whoever made it.
 */
export function countRevisions(db: Db, repoId: number, prNumber: number): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM review_requests r LEFT JOIN jobs j ON j.id = r.job_id
         WHERE r.repo_id = ? AND r.pr_number = ? AND r.state = 'queued'
           AND (j.id IS NULL OR j.status != 'canceled' OR substr(coalesce(j.status_reason, ''), 1, 12) = 'superseded: ')`,
      )
      .get(repoId, prNumber) as { n: number }
  ).n;
}

export interface NewReviewRequest {
  repoId: number;
  reviewId: string;
  prNumber: number;
  reviewer: string | null;
  trigger: RevisionTriggerKind;
  reviewUrl: string | null;
  submittedAt: string | null;
}

const INSERT_REVIEW_REQUEST = `INSERT INTO review_requests
    (repo_id, review_id, pr_number, reviewer, trigger_kind, review_url, submitted_at, state, reason, job_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (repo_id, review_id) DO NOTHING`;

/**
 * Record a change request that queues nothing. `over-limit` also stamps the PR, so the worker
 * posts its one comment about the limit. Returns false when the review was already recorded.
 */
export function recordReviewRequest(
  db: Db,
  r: NewReviewRequest & { state: Exclude<ReviewRequestState, 'queued'>; reason: string },
  now?: () => number,
): boolean {
  const at = nowIso(now);
  return transaction(db, () => {
    const res = db
      .prepare(INSERT_REVIEW_REQUEST)
      .run(r.repoId, r.reviewId, r.prNumber, r.reviewer, r.trigger, r.reviewUrl, r.submittedAt, r.state, r.reason, null, at);
    if (Number(res.changes) === 0) return false;
    noteChangeRequest(db, r.repoId, r.reviewId);
    if (r.state === 'over-limit') {
      db.prepare('UPDATE revision_prs SET limit_reached_at = coalesce(limit_reached_at, ?), updated_at = ? WHERE repo_id = ? AND pr_number = ?').run(
        at,
        at,
        r.repoId,
        r.prNumber,
      );
      noteLimitReached(db, r.repoId, r.prNumber);
    }
    return true;
  });
}

export type EnqueueRevisionResult =
  | { status: 'queued'; job: Job }
  /** The PR had already been given `max` revision jobs; recorded as over-limit. */
  | { status: 'over-limit'; count: number }
  /** The review was recorded before, or its job was pruned; nothing changed. */
  | { status: 'duplicate' };

/**
 * In ONE transaction: check the review is new, check the PR's revision count against `max`, and
 * insert the revision job with the review's record. The job goes through the same dedupe as an
 * issue job (the jobs unique key and the pruned_events tombstones), so a review can never queue
 * twice whatever was replayed or pruned in between.
 */
export function enqueueRevision(db: Db, r: NewReviewRequest & { job: NewJob; max: number }, now?: () => number): EnqueueRevisionResult {
  const at = nowIso(now);
  return transaction(db, (): EnqueueRevisionResult => {
    if (getReviewRequest(db, r.repoId, r.reviewId)) return { status: 'duplicate' };
    const record = db.prepare(INSERT_REVIEW_REQUEST);
    const count = countRevisions(db, r.repoId, r.prNumber);
    if (count >= r.max) {
      record.run(
        r.repoId,
        r.reviewId,
        r.prNumber,
        r.reviewer,
        r.trigger,
        r.reviewUrl,
        r.submittedAt,
        'over-limit',
        `pull request #${r.prNumber} already has ${count} revision(s); the limit (maxRevisions) is ${r.max}`,
        null,
        at,
      );
      noteChangeRequest(db, r.repoId, r.reviewId);
      db.prepare('UPDATE revision_prs SET limit_reached_at = coalesce(limit_reached_at, ?), updated_at = ? WHERE repo_id = ? AND pr_number = ?').run(
        at,
        at,
        r.repoId,
        r.prNumber,
      );
      noteLimitReached(db, r.repoId, r.prNumber);
      return { status: 'over-limit', count };
    }
    const j = r.job;
    const id = newId('job');
    const res = db
      .prepare(
        `INSERT INTO jobs
           (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope,
            status, status_reason, attempts, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM pruned_events WHERE repo_id = ? AND workflow_id = ? AND event_id = ?)
         ON CONFLICT (repo_id, workflow_id, event_id) DO NOTHING`,
      )
      .run(id, j.repoId, j.repoFullName, j.workflowId, j.eventId, j.issueNumber, j.action, j.pool, JSON.stringify(j.envelope), at, at, j.repoId, j.workflowId, j.eventId);
    if (Number(res.changes) === 0) {
      record.run(r.repoId, r.reviewId, r.prNumber, r.reviewer, r.trigger, r.reviewUrl, r.submittedAt, 'ignored', 'a job for this review existed before', null, at);
      noteChangeRequest(db, r.repoId, r.reviewId);
      return { status: 'duplicate' };
    }
    record.run(r.repoId, r.reviewId, r.prNumber, r.reviewer, r.trigger, r.reviewUrl, r.submittedAt, 'queued', null, id, at);
    noteChangeRequest(db, r.repoId, r.reviewId);
    return { status: 'queued', job: rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow) };
  });
}

/** Change requests worth showing in `updraft status` (everything but reviews by non-allowed actors), newest first. */
export function listRecentReviewRequests(db: Db, limit = 10): ReviewRequest[] {
  return (
    db
      .prepare("SELECT * FROM review_requests WHERE state != 'not-allowed' ORDER BY created_at DESC, review_id DESC LIMIT ?")
      .all(limit) as unknown as ReviewRequestRow[]
  ).map(rowToReviewRequest);
}

// ---------------------------------------------------------------------------
// The comment that says a PR reached maxRevisions
// ---------------------------------------------------------------------------

/** Open PRs that reached the limit and whose one comment about it is still to be posted. */
export function listPendingLimitNotices(db: Db, maxAttempts: number): RevisionPr[] {
  return (
    db
      .prepare(
        `SELECT * FROM revision_prs
         WHERE state = 'open' AND limit_reached_at IS NOT NULL AND limit_comment_id IS NULL AND limit_comment_attempts < ?
         ORDER BY limit_reached_at`,
      )
      .all(maxAttempts) as unknown as RevisionPrRow[]
  ).map(rowToRevisionPr);
}

/** Record the outcome of one attempt to post the limit comment. */
export function recordLimitNotice(
  db: Db,
  repoId: number,
  prNumber: number,
  r: { commentId: number; commentUrl: string } | { error: string },
  now?: () => number,
): void {
  const at = nowIso(now);
  if ('error' in r) {
    db.prepare(
      'UPDATE revision_prs SET limit_comment_attempts = limit_comment_attempts + 1, limit_comment_error = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ?',
    ).run(r.error, at, repoId, prNumber);
  } else {
    db.prepare(
      `UPDATE revision_prs SET limit_comment_id = ?, limit_comment_url = ?, limit_comment_error = NULL,
              limit_comment_attempts = limit_comment_attempts + 1, updated_at = ? WHERE repo_id = ? AND pr_number = ?`,
    ).run(r.commentId, r.commentUrl, at, repoId, prNumber);
  }
}

/** PRs that reached their limit, newest first, for `updraft status`. */
export function listLimitedRevisionPrs(db: Db, limit = 10): RevisionPr[] {
  return (
    db.prepare('SELECT * FROM revision_prs WHERE limit_reached_at IS NOT NULL ORDER BY limit_reached_at DESC LIMIT ?').all(limit) as unknown as RevisionPrRow[]
  ).map(rowToRevisionPr);
}

// ---------------------------------------------------------------------------
// The push and reply of a revision run. Same shape as publications: a lease while an attempt
// works, and an attempt number every write is fenced by.
// ---------------------------------------------------------------------------

interface RevisionRow {
  run_id: string;
  job_id: string;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
  pr_number: number;
  review_id: string;
  trigger_kind: RevisionTriggerKind;
  state: PublicationState;
  branch: string;
  base_sha: string | null;
  head_sha: string | null;
  pushed_at: string | null;
  moved: number;
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

function rowToRevision(r: RevisionRow): Revision {
  return {
    runId: r.run_id,
    jobId: r.job_id,
    repoId: r.repo_id,
    repoFullName: r.repo_full_name,
    issueNumber: r.issue_number,
    prNumber: r.pr_number,
    reviewId: r.review_id,
    trigger: r.trigger_kind,
    state: r.state,
    branch: r.branch,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    pushedAt: r.pushed_at,
    moved: r.moved === 1,
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

export function getRevision(db: Db, runId: string): Revision | null {
  const row = db.prepare('SELECT * FROM revisions WHERE run_id = ?').get(runId) as RevisionRow | undefined;
  return row ? rowToRevision(row) : null;
}

export interface BeginRevision {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  prNumber: number;
  reviewId: string;
  trigger: RevisionTriggerKind;
  branch: string;
  baseSha: string;
  leaseSeconds: number;
  now?: () => number;
}

export type BeginRevisionResult = { ok: true; revision: Revision } | { ok: false; reason: 'done' | 'in-progress'; revision: Revision };

/**
 * Take the push and reply of a revision run: create its row, or reopen a failed one, in state
 * 'publishing' with a lease. Refuses one that is finished (published or skipped), or being
 * worked on by another process whose lease has not expired.
 */
export function beginRevision(db: Db, b: BeginRevision): BeginRevisionResult {
  const clock = b.now ?? Date.now;
  const at = nowIso(clock);
  const lease = new Date(clock() + b.leaseSeconds * 1000).toISOString();
  return transaction(db, () => {
    const existing = getRevision(db, b.runId);
    if (!existing) {
      db.prepare(
        `INSERT INTO revisions (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, review_id, trigger_kind, state, branch,
                                base_sha, attempts, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'publishing', ?, ?, 1, ?, ?, ?)`,
      ).run(b.runId, b.jobId, b.repoId, b.repoFullName, b.issueNumber, b.prNumber, b.reviewId, b.trigger, b.branch, b.baseSha, lease, at, at);
      return { ok: true, revision: getRevision(db, b.runId)! };
    }
    if (existing.state === 'published' || existing.state === 'skipped') return { ok: false, reason: 'done', revision: existing };
    if (existing.state === 'publishing' && existing.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) > clock()) {
      return { ok: false, reason: 'in-progress', revision: existing };
    }
    db.prepare(
      `UPDATE revisions SET state = 'publishing', attempts = attempts + 1, lease_expires_at = ?, next_attempt_at = NULL, updated_at = ?
       WHERE run_id = ?`,
    ).run(lease, at, b.runId);
    return { ok: true, revision: getRevision(db, b.runId)! };
  });
}

/** The attempt no longer owns the revision: a newer attempt took it over, or it was finished. It must stop without writing. */
export class RevisionSupersededError extends Error {
  constructor(runId: string, attempt: number) {
    super(`revision of run ${runId}: attempt ${attempt} was superseded by a newer attempt`);
    this.name = 'RevisionSupersededError';
  }
}

/** Which attempt is writing, and how long each write extends its lease. */
export interface RevisionFence {
  attempt: number;
  leaseSeconds: number;
  now?: () => number;
}

const OWNED = `run_id = ? AND attempts = ? AND state = 'publishing'`;

/** Progress recorded as each step completes, so a retry resumes after it. */
export interface RevisionProgress {
  headSha?: string;
  pushedAt?: string;
  moved?: boolean;
  commentId?: number;
  commentUrl?: string;
}

/**
 * Confirm `fence.attempt` still owns the revision, extend its lease and record any progress.
 * Call before each external write (push, comment). Throws RevisionSupersededError.
 */
export function holdRevision(db: Db, runId: string, fence: RevisionFence, p: RevisionProgress = {}): void {
  const clock = fence.now ?? Date.now;
  const sets: string[] = ['lease_expires_at = ?'];
  const values: Array<string | number> = [new Date(clock() + fence.leaseSeconds * 1000).toISOString()];
  const add = (column: string, v: string | number | undefined) => {
    if (v === undefined) return;
    sets.push(`${column} = ?`);
    values.push(v);
  };
  add('head_sha', p.headSha);
  add('pushed_at', p.pushedAt);
  add('moved', p.moved === undefined ? undefined : p.moved ? 1 : 0);
  add('comment_id', p.commentId);
  add('comment_url', p.commentUrl);
  const update = () => db.prepare(`UPDATE revisions SET ${sets.join(', ')}, updated_at = ? WHERE ${OWNED}`).run(...values, nowIso(clock), runId, fence.attempt);
  // Recording the push is a fact for the rollup, written with it; other progress needs no transaction.
  const changed =
    p.pushedAt === undefined
      ? Number(update().changes) > 0
      : transaction(db, () => {
          if (Number(update().changes) === 0) return false;
          noteRevisionPushed(db, runId);
          return true;
        });
  if (!changed) throw new RevisionSupersededError(runId, fence.attempt);
}

/** Close the owning attempt. Returns false (and changes nothing) when `attempt` no longer owns the revision. */
export function finishRevision(
  db: Db,
  runId: string,
  attempt: number,
  r: { state: 'published' | 'failed' | 'skipped'; error?: string | null; retryable?: boolean; nextAttemptAt?: string | null; now?: () => number },
): boolean {
  const at = nowIso(r.now);
  const res = db
    .prepare(
      `UPDATE revisions SET state = ?, error = ?, retryable = ?, next_attempt_at = ?, lease_expires_at = NULL,
              published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END, updated_at = ?
       WHERE ${OWNED}`,
    )
    .run(r.state, r.error ?? null, r.retryable ? 1 : 0, r.nextAttemptAt ?? null, r.state, at, at, runId, attempt);
  return Number(res.changes) > 0;
}

/** A revision the worker will still work on by itself: in progress, or a transient failure with attempts left. */
const UNSETTLED = `(state = 'publishing' AND (lease_expires_at > ? OR attempts < ?)) OR (state = 'failed' AND retryable = 1 AND attempts < ?)`;

/** Runs whose push or reply the worker should try again now (see listDuePublications). */
export function listDueRevisions(db: Db, opts: { now?: () => number } = {}): string[] {
  const at = nowIso(opts.now);
  return (
    db
      .prepare(
        `SELECT run_id FROM revisions
         WHERE attempts < ?
           AND ((state = 'failed' AND retryable = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (state = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
         ORDER BY updated_at`,
      )
      .all(REVISION_MAX_AUTO_ATTEMPTS, at, at) as { run_id: string }[]
  ).map((r) => r.run_id);
}

/**
 * Issues with a revision whose push has not settled. The next revision of the same PR starts
 * from the remote head, so it must wait until the previous one's commits are there (or are known
 * not to be coming); claimNextJob treats these issues as busy.
 */
export function issuesAwaitingRevisionPush(db: Db, now?: () => number): Array<{ repoId: number; issueNumber: number }> {
  const at = nowIso(now);
  return (
    db
      .prepare(`SELECT DISTINCT repo_id, issue_number FROM revisions WHERE ${UNSETTLED}`)
      .all(at, REVISION_MAX_AUTO_ATTEMPTS, REVISION_MAX_AUTO_ATTEMPTS) as { repo_id: number; issue_number: number }[]
  ).map((r) => ({ repoId: r.repo_id, issueNumber: r.issue_number }));
}

/** Newest first, for `updraft status`. */
export function listRecentRevisions(db: Db, limit = 10): Revision[] {
  return (db.prepare('SELECT * FROM revisions ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(limit) as unknown as RevisionRow[]).map(rowToRevision);
}

// ---------------------------------------------------------------------------
// The revision job
// ---------------------------------------------------------------------------

/** The job a change request on `pr` queues: same workflow, action, pool and issue as the job that opened the PR. */
export function revisionJob(
  repo: { id: number; fullName: string },
  pr: RevisionPr,
  revision: NonNullable<EventEnvelope['revision']>,
): NewJob {
  const eventId = `review:${revision.review.id}`;
  return {
    repoId: repo.id,
    repoFullName: repo.fullName,
    workflowId: pr.workflowId,
    eventId,
    issueNumber: pr.issueNumber,
    action: pr.action,
    pool: pr.pool,
    envelope: {
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      type: 'pull_request.changes_requested',
      repo: { id: repo.id, fullName: repo.fullName },
      issue: { number: pr.issueNumber, title: pr.issueTitle, url: pr.issueUrl },
      eventId,
      url: revision.review.url,
      actor: revision.review.author,
      label: pr.label,
      labelsAtEnqueue: pr.labels,
      createdAt: revision.review.submittedAt,
      revision,
    },
  };
}
