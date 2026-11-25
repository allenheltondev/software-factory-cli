// Persistence for the review loop (repositories.<repo>.review, autoMerge): where each watched PR
// stands (its head, the newest verdict, the merge), the reviewer jobs, and the posting of each
// reviewer run's verdict. See src/publish/review.ts (posting and what follows from a verdict),
// src/publish/merge.ts (auto-merge) and docs/review-loop.md.
//
// The PRs are the rows of revision_prs (src/db/revisions.ts): one row per PR Updraft opened,
// shared with the revision loop. The columns this module owns were added by migration 11.
import { countOpenThreads, openThreads } from './review-findings.js';
import { allowedActorsFor, reviewActive, reviewPoolFor, workflowId, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import {
  ENVELOPE_SCHEMA_VERSION,
  type EventEnvelope,
  type Job,
  type JobStatus,
  type PriorReviewSnapshot,
  type PublicationState,
  type ReviewRunRequest,
  type ReviewSnapshot,
  type ReviewVerdict,
  type RunSummary,
} from '../types.js';
import { newId, nowIso } from '../util/ids.js';
import { rowToJob, transaction, type Db, type JobRow } from './database.js';
import { noteMergeBlocked, notePrMerged, noteReview, type MergeBlockCode } from './metrics.js';
import { countRevisions, rowToRevisionPr, syncRevisionPrs, type RevisionPr, type RevisionPrRow } from './revisions.js';

/** Attempts (first try included) before the worker stops retrying the posting of a review on its own. */
export const REVIEW_MAX_AUTO_ATTEMPTS = 5;
/** Earlier reviews and change requests given to a reviewer run, newest ones kept. */
const MAX_PRIOR_REVIEWS = 5;
const MAX_PRIOR_FINDINGS = 8_000;
const MAX_CHANGE_REQUESTS = 5;

// ---------------------------------------------------------------------------
// The PR's place in the loop
// ---------------------------------------------------------------------------

export type MergeState = 'waiting' | 'merging' | 'merged' | 'blocked';
/** The CI step for one head: waiting for checks, passed, a fix was queued, or a person has to act. */
export type CiState = 'waiting' | 'passed' | 'fixing' | 'blocked';

/** A watched PR with what the review loop knows about it. */
export interface LoopPr extends RevisionPr {
  /** The newest head commit the worker knows of; null until its first push or read. */
  headSha: string | null;
  headAt: string | null;
  /** Agent of the PR's latest code run. */
  authorAgent: string | null;
  /** The newest recorded verdict, and the head commit it is for. */
  verdict: ReviewVerdict | null;
  verdictSha: string | null;
  verdictRunId: string | null;
  verdictAt: string | null;
  readyMarkedAt: string | null;
  /** Auto-merge of the head `mergeSha`; null when it was not looked at yet. */
  mergeState: MergeState | null;
  mergeSha: string | null;
  mergeReason: string | null;
  mergeWaitStartedAt: string | null;
  mergeAttempts: number;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeCommentId: number | null;
  mergeCommentUrl: string | null;
  mergeCommentAttempts: number;
  mergeCommentError: string | null;
  /** The CI step (repositories.<repo>.ciFix) for the head `ciSha`; null when it was not looked at yet. */
  ciState: CiState | null;
  ciSha: string | null;
  ciReason: string | null;
  ciWaitStartedAt: string | null;
  ciCheckedAt: string | null;
  ciSignature: string | null;
  ciFixJobId: string | null;
  /** CI-fix revisions the PR was given, across heads. */
  ciFixes: number;
  ciLastFixSignature: string | null;
  ciCommentSha: string | null;
  ciCommentId: number | null;
  ciCommentUrl: string | null;
  ciCommentAttempts: number;
}

interface LoopPrRow extends RevisionPrRow {
  head_sha: string | null;
  head_at: string | null;
  author_agent: string | null;
  verdict: ReviewVerdict | null;
  verdict_sha: string | null;
  verdict_run_id: string | null;
  verdict_at: string | null;
  ready_marked_at: string | null;
  merge_state: MergeState | null;
  merge_sha: string | null;
  merge_reason: string | null;
  merge_wait_started_at: string | null;
  merge_attempts: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  merge_comment_id: number | null;
  merge_comment_url: string | null;
  merge_comment_attempts: number;
  merge_comment_error: string | null;
  ci_state: CiState | null;
  ci_sha: string | null;
  ci_reason: string | null;
  ci_wait_started_at: string | null;
  ci_checked_at: string | null;
  ci_signature: string | null;
  ci_fix_job_id: string | null;
  ci_fixes: number;
  ci_last_fix_signature: string | null;
  ci_comment_sha: string | null;
  ci_comment_id: number | null;
  ci_comment_url: string | null;
  ci_comment_attempts: number;
}

function rowToLoopPr(r: LoopPrRow): LoopPr {
  return {
    ...rowToRevisionPr(r),
    headSha: r.head_sha,
    headAt: r.head_at,
    authorAgent: r.author_agent,
    verdict: r.verdict,
    verdictSha: r.verdict_sha,
    verdictRunId: r.verdict_run_id,
    verdictAt: r.verdict_at,
    readyMarkedAt: r.ready_marked_at,
    mergeState: r.merge_state,
    mergeSha: r.merge_sha,
    mergeReason: r.merge_reason,
    mergeWaitStartedAt: r.merge_wait_started_at,
    mergeAttempts: r.merge_attempts,
    mergedAt: r.merged_at,
    mergeCommitSha: r.merge_commit_sha,
    mergeCommentId: r.merge_comment_id,
    mergeCommentUrl: r.merge_comment_url,
    mergeCommentAttempts: r.merge_comment_attempts,
    mergeCommentError: r.merge_comment_error,
    ciState: r.ci_state,
    ciSha: r.ci_sha,
    ciReason: r.ci_reason,
    ciWaitStartedAt: r.ci_wait_started_at,
    ciCheckedAt: r.ci_checked_at,
    ciSignature: r.ci_signature,
    ciFixJobId: r.ci_fix_job_id,
    ciFixes: r.ci_fixes,
    ciLastFixSignature: r.ci_last_fix_signature,
    ciCommentSha: r.ci_comment_sha,
    ciCommentId: r.ci_comment_id,
    ciCommentUrl: r.ci_comment_url,
    ciCommentAttempts: r.ci_comment_attempts,
  };
}

export function getLoopPr(db: Db, repoId: number, prNumber: number): LoopPr | null {
  const row = db.prepare('SELECT * FROM revision_prs WHERE repo_id = ? AND pr_number = ?').get(repoId, prNumber) as LoopPrRow | undefined;
  return row ? rowToLoopPr(row) : null;
}

export function listOpenLoopPrs(db: Db, repoId: number): LoopPr[] {
  return (db.prepare("SELECT * FROM revision_prs WHERE repo_id = ? AND state = 'open' ORDER BY pr_number").all(repoId) as unknown as LoopPrRow[]).map(
    rowToLoopPr,
  );
}

/** Watched PRs, most recently changed first, for `updraft status`. */
export function listRecentLoopPrs(db: Db, limit = 20): LoopPr[] {
  return (db.prepare('SELECT * FROM revision_prs ORDER BY updated_at DESC, pr_number DESC LIMIT ?').all(limit) as unknown as LoopPrRow[]).map(rowToLoopPr);
}

/**
 * Take over, as each open PR's head, the newest commit the worker itself pushed to it (the
 * publication, or a revision push), when that push is newer than what the row holds. Local state
 * only: the worker knows when it pushed. Returns how many heads changed.
 */
export function adoptOwnPushes(db: Db, repoId: number, now?: () => number): number {
  const at = nowIso(now);
  return transaction(db, () => {
    let changed = 0;
    for (const pr of listOpenLoopPrs(db, repoId)) {
      const pushed = db
        .prepare(
          `SELECT sha, pushed_at, agent FROM (
             SELECT p.head_sha AS sha, p.pushed_at AS pushed_at, r.agent AS agent
               FROM publications p LEFT JOIN runs r ON r.id = p.run_id
              WHERE p.run_id = ? AND p.head_sha IS NOT NULL AND p.pushed_at IS NOT NULL
             UNION ALL
             SELECT v.head_sha, v.pushed_at, r.agent
               FROM revisions v LEFT JOIN runs r ON r.id = v.run_id
              WHERE v.repo_id = ? AND v.pr_number = ? AND v.head_sha IS NOT NULL AND v.pushed_at IS NOT NULL
           ) ORDER BY pushed_at DESC LIMIT 1`,
        )
        .get(pr.sourceRunId, repoId, pr.prNumber) as { sha: string; pushed_at: string; agent: string | null } | undefined;
      if (!pushed) continue;
      if (pr.headAt !== null && pushed.pushed_at <= pr.headAt) continue;
      db.prepare(
        'UPDATE revision_prs SET head_sha = ?, head_at = ?, author_agent = coalesce(?, author_agent), updated_at = ? WHERE repo_id = ? AND pr_number = ?',
      ).run(pushed.sha, pushed.pushed_at, pushed.agent, at, repoId, pr.prNumber);
      if (pushed.sha !== pr.headSha) changed++;
    }
    return changed;
  });
}

/**
 * The PR was read from GitHub and its head is `sha`. `observedAt` is when the read was started:
 * an observation older than what the row holds (a read that raced the worker's own push) is
 * ignored. Returns true when the head changed.
 */
export function observeHead(db: Db, repoId: number, prNumber: number, sha: string, observedAt: string): boolean {
  const res = db
    .prepare(
      `UPDATE revision_prs SET head_sha = ?, head_at = ?, updated_at = ?
       WHERE repo_id = ? AND pr_number = ? AND (head_sha IS NULL OR head_sha != ?) AND (head_at IS NULL OR head_at < ?)`,
    )
    .run(sha, observedAt, observedAt, repoId, prNumber, sha, observedAt);
  return Number(res.changes) > 0;
}

/** The Updraft run whose push put `sha` at the head of the PR (its publication or a revision), or null when someone else pushed it. */
export function codeRunForHead(db: Db, repoId: number, prNumber: number, sha: string): string | null {
  const row = db
    .prepare(
      `SELECT run_id FROM publications WHERE repo_id = ? AND pr_number = ? AND head_sha = ?
       UNION ALL
       SELECT run_id FROM revisions WHERE repo_id = ? AND pr_number = ? AND head_sha = ? AND pushed_at IS NOT NULL
       LIMIT 1`,
    )
    .get(repoId, prNumber, sha, repoId, prNumber, sha) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

// ---------------------------------------------------------------------------
// Reviewer jobs
// ---------------------------------------------------------------------------

/** Event id of the reviewer job for one head of one PR: the dedupe key that makes it one review per (PR, head). */
export function reviewEventId(prNumber: number, headSha: string): string {
  return `pr-review:${prNumber}:${headSha}`;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Findings of the newest earlier Updraft reviews of the PR, oldest first. */
function priorReviews(db: Db, repoId: number, prNumber: number): PriorReviewSnapshot[] {
  const rows = db
    .prepare('SELECT head_sha, verdict, agent, findings FROM pr_reviews WHERE repo_id = ? AND pr_number = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(repoId, prNumber, MAX_PRIOR_REVIEWS) as { head_sha: string; verdict: ReviewVerdict; agent: string; findings: string }[];
  return rows.reverse().map((r) => ({ headSha: r.head_sha, verdict: r.verdict, agent: r.agent, findings: cap(r.findings, MAX_PRIOR_FINDINGS) }));
}

/**
 * The change requests by people that queued a revision of the PR, oldest first: the snapshots
 * taken when each review was ingested (the text reviewTrigger let through), never a new read.
 * Only those whose author is still an allowed actor.
 */
function humanChangeRequests(db: Db, repoId: number, prNumber: number, allowedActors: readonly string[]): ReviewSnapshot[] {
  const rows = db
    .prepare(
      `SELECT j.envelope FROM review_requests r JOIN jobs j ON j.id = r.job_id
       WHERE r.repo_id = ? AND r.pr_number = ? AND r.trigger_kind = 'changes_requested' AND r.state = 'queued'
       ORDER BY r.created_at DESC, r.review_id DESC LIMIT ?`,
    )
    .all(repoId, prNumber, MAX_CHANGE_REQUESTS) as { envelope: string }[];
  const out: ReviewSnapshot[] = [];
  for (const r of rows.reverse()) {
    let review: ReviewSnapshot | undefined;
    try {
      review = (JSON.parse(r.envelope) as EventEnvelope).revision?.review;
    } catch {
      review = undefined;
    }
    const author = review?.author.toLowerCase();
    if (review && allowedActors.some((a) => a.toLowerCase() === author)) out.push(review);
  }
  return out;
}

/**
 * The acceptance report of the Updraft run whose push put `sha` at the head of the PR
 * (docs/acceptance.md): the coding agent's claims, for the reviewer to check. Null when someone
 * else pushed it, or the run wrote none.
 */
function acceptanceClaimsFor(db: Db, repoId: number, prNumber: number, sha: string): ReviewRunRequest['acceptanceClaims'] | null {
  const runId = codeRunForHead(db, repoId, prNumber, sha);
  if (!runId) return null;
  const row = db.prepare('SELECT summary FROM runs WHERE id = ?').get(runId) as { summary: string | null } | undefined;
  let report: RunSummary['acceptanceReport'];
  try {
    report = row?.summary ? (JSON.parse(row.summary) as RunSummary).acceptanceReport : undefined;
  } catch {
    report = undefined;
  }
  if (!report || typeof report.fingerprint !== 'string' || !Array.isArray(report.claims)) return null;
  return { runId, fingerprint: report.fingerprint, claims: report.claims };
}

/**
 * Queue the reviewer job for the PR's current head, unless one exists or existed (the jobs unique
 * key and the pruned_events tombstones, as for every job). Same workflow, action and issue as the
 * job that opened the PR; the pool is chosen by reviewPoolFor (`o.pool`). Returns
 * the job, or null when nothing was queued.
 */
export function enqueueReviewJob(
  db: Db,
  o: { repo: { id: number; fullName: string }; pr: LoopPr; pool: string; allowedActors: readonly string[]; now?: () => number },
): Job | null {
  const { repo, pr } = o;
  if (pr.state !== 'open' || !pr.headSha) return null;
  const headSha = pr.headSha;
  const at = nowIso(o.now);
  const eventId = reviewEventId(pr.prNumber, headSha);
  return transaction(db, () => {
    const exists = db
      .prepare(
        `SELECT 1 AS x FROM jobs WHERE repo_id = ? AND workflow_id = ? AND event_id = ?
         UNION ALL SELECT 1 FROM pruned_events WHERE repo_id = ? AND workflow_id = ? AND event_id = ?`,
      )
      .get(repo.id, pr.workflowId, eventId, repo.id, pr.workflowId, eventId);
    if (exists) return null;
    const review: ReviewRunRequest = {
      pullRequest: { number: pr.prNumber, url: pr.prUrl, branch: pr.branch, baseBranch: pr.baseBranch },
      headSha,
      authorAgent: pr.authorAgent,
      sourceRunId: pr.sourceRunId,
      originalEventId: pr.originalEventId,
      priorReviews: priorReviews(db, repo.id, pr.prNumber),
      changeRequests: humanChangeRequests(db, repo.id, pr.prNumber, o.allowedActors),
      openFindings: openThreads(db, repo.id, pr.prNumber).map((f) => ({
        key: f.key,
        severity: f.severity,
        title: f.title,
        problem: cap(f.problem, 2_000),
        path: f.path,
        line: f.line,
        status: f.status === 'unresolved' ? ('unresolved' as const) : ('open' as const),
        resolution: f.resolution && f.resolutionSha ? { status: f.resolution, note: f.resolutionNote, sha: f.resolutionSha } : null,
      })),
    };
    const unlisted = countOpenThreads(db, repo.id, pr.prNumber) - (review.openFindings?.length ?? 0);
    if (unlisted > 0) review.openFindingsOmitted = unlisted;
    const claims = acceptanceClaimsFor(db, repo.id, pr.prNumber, headSha);
    if (claims) review.acceptanceClaims = claims;
    const envelope: EventEnvelope = {
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      type: 'pull_request.review',
      repo: { id: repo.id, fullName: repo.fullName },
      issue: { number: pr.issueNumber, title: pr.issueTitle, url: pr.issueUrl },
      eventId,
      url: pr.prUrl,
      actor: null,
      label: pr.label,
      labelsAtEnqueue: pr.labels,
      createdAt: pr.headAt ?? at,
      review,
    };
    const id = newId('job');
    const res = db
      .prepare(
        `INSERT INTO jobs
           (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope,
            status, status_reason, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, ?, ?)
         ON CONFLICT (repo_id, workflow_id, event_id) DO NOTHING`,
      )
      .run(id, repo.id, repo.fullName, pr.workflowId, eventId, pr.issueNumber, pr.action, o.pool, JSON.stringify(envelope), at, at);
    if (Number(res.changes) === 0) return null;
    return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow);
  });
}

/**
 * Bring one repository's review loop up to date from local state: watch newly published PRs, take
 * over the heads the worker pushed, and queue the reviewer job of every open PR's current head
 * that has none. No GitHub request. Returns the jobs queued; nothing when review is off for it.
 */
export function scheduleReviews(
  db: Db,
  config: UpdraftConfig,
  repoFullName: string,
  cfg: RepositoryConfig,
  now?: () => number,
  /** Queue reviewer jobs for these pull requests only (a single-event run; see PublishDeps.scope). */
  only?: (pr: LoopPr) => boolean,
): Job[] {
  if (!reviewActive(config, cfg)) return [];
  syncRevisionPrs(db, cfg.id, now);
  adoptOwnPushes(db, cfg.id, now);
  const queued: Job[] = [];
  for (const pr of listOpenLoopPrs(db, cfg.id)) {
    if (!pr.headSha || (only && !only(pr))) continue;
    const wf = cfg.workflows.find((w) => workflowId(w) === pr.workflowId);
    const job = enqueueReviewJob(db, {
      repo: { id: cfg.id, fullName: repoFullName },
      pr,
      pool: reviewPoolFor(cfg, wf, pr.pool),
      // Without its workflow there is no allowlist: nobody's change request is passed on.
      allowedActors: wf ? allowedActorsFor(config, wf) : [],
      now,
    });
    if (job) queued.push(job);
  }
  return queued;
}

/** scheduleReviews for every configured repository. */
export function scheduleAllReviews(db: Db, config: UpdraftConfig, now?: () => number, only?: (pr: LoopPr) => boolean): Job[] {
  return Object.entries(config.repositories).flatMap(([fullName, cfg]) => scheduleReviews(db, config, fullName, cfg, now, only));
}

// ---------------------------------------------------------------------------
// The verdict of a reviewer run and its posting. Same shape as publications and revisions: a
// lease while an attempt works, and an attempt number every write is fenced by.
// ---------------------------------------------------------------------------

/**
 * What the worker did with a verdict once its review was posted. ready: ready to merge for the
 * current head. revision-queued / over-limit / no-revise: a changes-requested verdict queued a
 * revision, met maxRevisions, or found the revision loop off. needs-verification: mandatory
 * acceptance criteria are unverified or unclear and no revision can settle them, so a person has
 * to (docs/acceptance.md). stale: the PR's head had moved on. closed: the PR was no longer open.
 */
export type ReviewOutcome = 'ready' | 'revision-queued' | 'over-limit' | 'no-revise' | 'needs-verification' | 'stale' | 'closed';

export interface PrReview {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  agent: string;
  verdict: ReviewVerdict;
  findings: string;
  /** The reviewer's UPDRAFT-FINDINGS count; null when it gave none that could be read. Telemetry only. */
  findingsCount: number | null;
  state: PublicationState;
  reviewId: number | null;
  reviewUrl: string | null;
  outcome: ReviewOutcome | null;
  outcomeDetail: string | null;
  revisionJobId: string | null;
  error: string | null;
  retryable: boolean;
  attempts: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

interface PrReviewRow {
  run_id: string;
  job_id: string;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
  pr_number: number;
  head_sha: string;
  agent: string;
  verdict: ReviewVerdict;
  findings: string;
  findings_count: number | null;
  state: PublicationState;
  review_id: number | null;
  review_url: string | null;
  outcome: ReviewOutcome | null;
  outcome_detail: string | null;
  revision_job_id: string | null;
  error: string | null;
  retryable: number;
  attempts: number;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

function rowToPrReview(r: PrReviewRow): PrReview {
  return {
    runId: r.run_id,
    jobId: r.job_id,
    repoId: r.repo_id,
    repoFullName: r.repo_full_name,
    issueNumber: r.issue_number,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    agent: r.agent,
    verdict: r.verdict,
    findings: r.findings,
    findingsCount: r.findings_count,
    state: r.state,
    reviewId: r.review_id,
    reviewUrl: r.review_url,
    outcome: r.outcome,
    outcomeDetail: r.outcome_detail,
    revisionJobId: r.revision_job_id,
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

export function getPrReview(db: Db, runId: string): PrReview | null {
  const row = db.prepare('SELECT * FROM pr_reviews WHERE run_id = ?').get(runId) as PrReviewRow | undefined;
  return row ? rowToPrReview(row) : null;
}

export interface BeginPrReview {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  agent: string;
  verdict: ReviewVerdict;
  findings: string;
  /** The reviewer's UPDRAFT-FINDINGS count, or null. */
  findingsCount?: number | null;
  leaseSeconds: number;
  now?: () => number;
}

export type BeginPrReviewResult = { ok: true; review: PrReview } | { ok: false; reason: 'done' | 'in-progress'; review: PrReview };

/**
 * Take the posting of a reviewer run's verdict: create its row (which is where the verdict is
 * first written down), or reopen a failed one, in state 'publishing' with a lease. Refuses one
 * that is finished, or being worked on by another process whose lease has not expired.
 */
export function beginPrReview(db: Db, b: BeginPrReview): BeginPrReviewResult {
  const clock = b.now ?? Date.now;
  const at = nowIso(clock);
  const lease = new Date(clock() + b.leaseSeconds * 1000).toISOString();
  return transaction(db, () => {
    const existing = getPrReview(db, b.runId);
    if (!existing) {
      db.prepare(
        `INSERT INTO pr_reviews (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, head_sha, agent, verdict, findings,
                                 findings_count, state, attempts, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publishing', 1, ?, ?, ?)`,
      ).run(b.runId, b.jobId, b.repoId, b.repoFullName, b.issueNumber, b.prNumber, b.headSha, b.agent, b.verdict, b.findings, b.findingsCount ?? null, lease, at, at);
      noteReview(db, b.runId);
      return { ok: true, review: getPrReview(db, b.runId)! };
    }
    if (existing.state === 'published' || existing.state === 'skipped') return { ok: false, reason: 'done', review: existing };
    if (existing.state === 'publishing' && existing.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) > clock()) {
      return { ok: false, reason: 'in-progress', review: existing };
    }
    db.prepare(
      `UPDATE pr_reviews SET state = 'publishing', attempts = attempts + 1, lease_expires_at = ?, next_attempt_at = NULL, updated_at = ?
       WHERE run_id = ?`,
    ).run(lease, at, b.runId);
    return { ok: true, review: getPrReview(db, b.runId)! };
  });
}

/** The attempt no longer owns the review: a newer attempt took it over, or it was finished. It must stop without writing. */
export class PrReviewSupersededError extends Error {
  constructor(runId: string, attempt: number) {
    super(`review of run ${runId}: attempt ${attempt} was superseded by a newer attempt`);
    this.name = 'PrReviewSupersededError';
  }
}

export interface PrReviewFence {
  attempt: number;
  leaseSeconds: number;
  now?: () => number;
}

const OWNED = `run_id = ? AND attempts = ? AND state = 'publishing'`;

/** Progress recorded as each step completes, so a retry resumes after it. */
export interface PrReviewProgress {
  reviewId?: number;
  reviewUrl?: string;
  outcome?: ReviewOutcome;
  outcomeDetail?: string | null;
  revisionJobId?: string;
}

/** Confirm `fence.attempt` still owns the review, extend its lease and record any progress. Throws PrReviewSupersededError. */
export function holdPrReview(db: Db, runId: string, fence: PrReviewFence, p: PrReviewProgress = {}): void {
  const clock = fence.now ?? Date.now;
  const sets: string[] = ['lease_expires_at = ?'];
  const values: Array<string | number | null> = [new Date(clock() + fence.leaseSeconds * 1000).toISOString()];
  const add = (column: string, v: string | number | null | undefined) => {
    if (v === undefined) return;
    sets.push(`${column} = ?`);
    values.push(v);
  };
  add('review_id', p.reviewId);
  add('review_url', p.reviewUrl);
  add('outcome', p.outcome);
  add('outcome_detail', p.outcomeDetail);
  add('revision_job_id', p.revisionJobId);
  const res = db.prepare(`UPDATE pr_reviews SET ${sets.join(', ')}, updated_at = ? WHERE ${OWNED}`).run(...values, nowIso(clock), runId, fence.attempt);
  if (Number(res.changes) === 0) throw new PrReviewSupersededError(runId, fence.attempt);
}

/** Close the owning attempt. Returns false (and changes nothing) when `attempt` no longer owns the review. */
export function finishPrReview(
  db: Db,
  runId: string,
  attempt: number,
  r: { state: 'published' | 'failed' | 'skipped'; error?: string | null; retryable?: boolean; nextAttemptAt?: string | null; now?: () => number },
): boolean {
  const at = nowIso(r.now);
  const res = db
    .prepare(
      `UPDATE pr_reviews SET state = ?, error = ?, retryable = ?, next_attempt_at = ?, lease_expires_at = NULL,
              published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END, updated_at = ?
       WHERE ${OWNED}`,
    )
    .run(r.state, r.error ?? null, r.retryable ? 1 : 0, r.nextAttemptAt ?? null, r.state, at, at, runId, attempt);
  return Number(res.changes) > 0;
}

/** Runs whose review the worker should try to post again now (see listDuePublications). */
export function listDuePrReviews(db: Db, opts: { now?: () => number } = {}): string[] {
  const at = nowIso(opts.now);
  return (
    db
      .prepare(
        `SELECT run_id FROM pr_reviews
         WHERE attempts < ?
           AND ((state = 'failed' AND retryable = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (state = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
         ORDER BY updated_at`,
      )
      .all(REVIEW_MAX_AUTO_ATTEMPTS, at, at) as { run_id: string }[]
  ).map((r) => r.run_id);
}

/** Newest first, for `updraft status`. */
export function listRecentPrReviews(db: Db, limit = 10): PrReview[] {
  return (db.prepare('SELECT * FROM pr_reviews ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(limit) as unknown as PrReviewRow[]).map(rowToPrReview);
}

/**
 * Write a verdict onto its PR as the PR's newest one. A verdict for a commit that is not the
 * PR's head never replaces one that is. Returns whether it is for the current head, and whether
 * the PR is still open.
 */
export function recordVerdict(
  db: Db,
  v: { repoId: number; prNumber: number; runId: string; verdict: ReviewVerdict; headSha: string; now?: () => number },
): { current: boolean; open: boolean } {
  const at = nowIso(v.now);
  return transaction(db, () => {
    const pr = getLoopPr(db, v.repoId, v.prNumber);
    if (!pr) return { current: false, open: false };
    const current = pr.headSha === v.headSha;
    if (pr.verdictRunId !== v.runId && (current || pr.verdictSha !== pr.headSha)) {
      db.prepare(
        'UPDATE revision_prs SET verdict = ?, verdict_sha = ?, verdict_run_id = ?, verdict_at = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ?',
      ).run(v.verdict, v.headSha, v.runId, at, at, v.repoId, v.prNumber);
    }
    return { current, open: pr.state === 'open' };
  });
}

export function markReadyRecorded(db: Db, repoId: number, prNumber: number, now?: () => number): void {
  const at = nowIso(now);
  db.prepare('UPDATE revision_prs SET ready_marked_at = coalesce(ready_marked_at, ?), updated_at = ? WHERE repo_id = ? AND pr_number = ?').run(at, at, repoId, prNumber);
}

// ---------------------------------------------------------------------------
// Auto-merge
// ---------------------------------------------------------------------------

/**
 * Open PRs whose newest verdict is ready-to-merge for their current head and whose merge has not
 * settled for that head: not looked at, waiting for checks, or sent with an unknown result.
 */
export function listMergeCandidates(db: Db, repoId: number, opts: { requireCi?: boolean } = {}): LoopPr[] {
  // With the CI step on, a head is not a candidate before its checks passed there: a failure is
  // the CI step's to fix, not the merge's to refuse for good.
  const ci = opts.requireCi ? "AND ci_sha = head_sha AND ci_state = 'passed'" : '';
  return (
    db
      .prepare(
        `SELECT * FROM revision_prs
         WHERE repo_id = ? AND state = 'open' AND verdict = 'ready-to-merge' AND head_sha IS NOT NULL AND verdict_sha = head_sha ${ci}
           AND (merge_sha IS NULL OR merge_sha != head_sha OR merge_state IS NULL OR merge_state IN ('waiting', 'merging'))
         ORDER BY pr_number`,
      )
      .all(repoId) as unknown as LoopPrRow[]
  ).map(rowToLoopPr);
}

/**
 * Point the PR's merge columns at `sha`, clearing what was recorded for an earlier head (its
 * state, its wait and its comment belong to that head). No-op when they already are about `sha`.
 */
export function startMergeFor(db: Db, repoId: number, prNumber: number, sha: string, now?: () => number): void {
  db.prepare(
    `UPDATE revision_prs SET merge_sha = ?, merge_state = NULL, merge_reason = NULL, merge_wait_started_at = NULL, merge_attempts = 0,
            merge_comment_id = NULL, merge_comment_url = NULL, merge_comment_attempts = 0, merge_comment_error = NULL, updated_at = ?
     WHERE repo_id = ? AND pr_number = ? AND (merge_sha IS NULL OR merge_sha != ?)`,
  ).run(sha, nowIso(now), repoId, prNumber, sha);
}

export type MergeStep =
  | { state: 'waiting'; reason: string }
  | { state: 'merging' }
  | { state: 'merged'; mergeCommitSha: string | null }
  /** `code` sorts `reason` for `updraft stats`, which never keeps the reason's text. */
  | { state: 'blocked'; reason: string; code: MergeBlockCode };

/**
 * Record a step of the merge of `sha`. Changes nothing unless the merge columns are still about
 * `sha` and not final. A merge or a block is recorded in the rollup in the same transaction.
 */
export function setMergeState(db: Db, repoId: number, prNumber: number, sha: string, s: MergeStep, now?: () => number): boolean {
  return transaction(db, () => {
    const changed = applyMergeStep(db, repoId, prNumber, sha, s, now);
    if (changed && s.state === 'merged') notePrMerged(db, repoId, prNumber);
    if (changed && s.state === 'blocked') noteMergeBlocked(db, repoId, prNumber, s.code);
    return changed;
  });
}

function applyMergeStep(db: Db, repoId: number, prNumber: number, sha: string, s: MergeStep, now?: () => number): boolean {
  const at = nowIso(now);
  const where = `repo_id = ? AND pr_number = ? AND merge_sha = ? AND (merge_state IS NULL OR merge_state IN ('waiting', 'merging'))`;
  let changes: number | bigint;
  switch (s.state) {
    case 'waiting':
      changes = db
        .prepare(`UPDATE revision_prs SET merge_state = 'waiting', merge_reason = ?, merge_wait_started_at = coalesce(merge_wait_started_at, ?), updated_at = ? WHERE ${where}`)
        .run(s.reason, at, at, repoId, prNumber, sha).changes;
      break;
    case 'merging':
      changes = db
        .prepare(`UPDATE revision_prs SET merge_state = 'merging', merge_reason = NULL, merge_attempts = merge_attempts + 1, updated_at = ? WHERE ${where}`)
        .run(at, repoId, prNumber, sha).changes;
      break;
    case 'merged':
      changes = db
        .prepare(`UPDATE revision_prs SET merge_state = 'merged', merge_reason = NULL, merged_at = ?, merge_commit_sha = ?, updated_at = ? WHERE ${where}`)
        .run(at, s.mergeCommitSha, at, repoId, prNumber, sha).changes;
      break;
    case 'blocked':
      changes = db.prepare(`UPDATE revision_prs SET merge_state = 'blocked', merge_reason = ?, updated_at = ? WHERE ${where}`).run(s.reason, at, repoId, prNumber, sha).changes;
      break;
  }
  return Number(changes) > 0;
}

/** Open PRs whose merge was blocked and whose one comment about it is still to be posted. */
export function listPendingMergeNotices(db: Db, maxAttempts: number): LoopPr[] {
  return (
    db
      .prepare(
        `SELECT * FROM revision_prs
         WHERE state = 'open' AND merge_state = 'blocked' AND merge_comment_id IS NULL AND merge_comment_attempts < ?
         ORDER BY updated_at`,
      )
      .all(maxAttempts) as unknown as LoopPrRow[]
  ).map(rowToLoopPr);
}

/** Record the outcome of one attempt to post the comment that says why the PR was not merged. */
export function recordMergeNotice(
  db: Db,
  repoId: number,
  prNumber: number,
  sha: string,
  r: { commentId: number; commentUrl: string } | { error: string },
  now?: () => number,
): void {
  const at = nowIso(now);
  if ('error' in r) {
    db.prepare(
      'UPDATE revision_prs SET merge_comment_attempts = merge_comment_attempts + 1, merge_comment_error = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND merge_sha = ?',
    ).run(r.error, at, repoId, prNumber, sha);
  } else {
    db.prepare(
      `UPDATE revision_prs SET merge_comment_id = ?, merge_comment_url = ?, merge_comment_error = NULL,
              merge_comment_attempts = merge_comment_attempts + 1, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND merge_sha = ?`,
    ).run(r.commentId, r.commentUrl, at, repoId, prNumber, sha);
  }
}

// ---------------------------------------------------------------------------
// The CI step (repositories.<repo>.ciFix, src/publish/ci.ts)
// ---------------------------------------------------------------------------

/**
 * Open PRs whose newest verdict is ready-to-merge for their current head and whose CI step has
 * not settled for that head: not looked at, or waiting for checks.
 */
export function listCiCandidates(db: Db, repoId: number): LoopPr[] {
  return (
    db
      .prepare(
        `SELECT * FROM revision_prs
         WHERE repo_id = ? AND state = 'open' AND verdict = 'ready-to-merge' AND head_sha IS NOT NULL AND verdict_sha = head_sha
           AND (ci_sha IS NULL OR ci_sha != head_sha OR ci_state IS NULL OR ci_state = 'waiting')
         ORDER BY pr_number`,
      )
      .all(repoId) as unknown as LoopPrRow[]
  ).map(rowToLoopPr);
}

/**
 * Point the PR's CI columns at `sha`, clearing what was recorded for an earlier head. What spans
 * heads stays: the number of CI fixes and the failure the newest one was for. No-op when they are
 * already about `sha`.
 */
export function startCiFor(db: Db, repoId: number, prNumber: number, sha: string, now?: () => number): void {
  db.prepare(
    `UPDATE revision_prs SET ci_sha = ?, ci_state = NULL, ci_reason = NULL, ci_wait_started_at = NULL, ci_checked_at = NULL, ci_signature = NULL,
            ci_fix_job_id = NULL, ci_comment_attempts = 0, updated_at = ?
     WHERE repo_id = ? AND pr_number = ? AND (ci_sha IS NULL OR ci_sha != ?)`,
  ).run(sha, nowIso(now), repoId, prNumber, sha);
}

export type CiStep =
  | { state: 'waiting'; reason: string }
  | { state: 'passed'; reason: string }
  /** A revision was queued for the failure `signature` (null: nothing was read that could tell it apart from the next). */
  | { state: 'fixing'; reason: string; jobId: string; signature: string | null }
  | { state: 'blocked'; reason: string; signature?: string | null };

/**
 * Record a step of the CI step for `sha`. Changes nothing unless the CI columns are still about
 * `sha` and not final (not looked at, or waiting). Returns whether it changed the row.
 */
export function setCiState(db: Db, repoId: number, prNumber: number, sha: string, s: CiStep, now?: () => number): boolean {
  const at = nowIso(now);
  const where = `repo_id = ? AND pr_number = ? AND ci_sha = ? AND (ci_state IS NULL OR ci_state = 'waiting')`;
  let changes: number | bigint;
  switch (s.state) {
    case 'waiting':
      changes = db
        .prepare(
          `UPDATE revision_prs SET ci_state = 'waiting', ci_reason = ?, ci_wait_started_at = coalesce(ci_wait_started_at, ?), ci_checked_at = ?, updated_at = ? WHERE ${where}`,
        )
        .run(s.reason, at, at, at, repoId, prNumber, sha).changes;
      break;
    case 'passed':
      changes = db.prepare(`UPDATE revision_prs SET ci_state = 'passed', ci_reason = ?, ci_checked_at = ?, updated_at = ? WHERE ${where}`).run(s.reason, at, at, repoId, prNumber, sha).changes;
      break;
    case 'fixing':
      changes = db
        .prepare(
          `UPDATE revision_prs SET ci_state = 'fixing', ci_reason = ?, ci_checked_at = ?, ci_signature = ?, ci_fix_job_id = ?, ci_fixes = ci_fixes + 1,
                  ci_last_fix_signature = ?, updated_at = ? WHERE ${where}`,
        )
        .run(s.reason, at, s.signature, s.jobId, s.signature, at, repoId, prNumber, sha).changes;
      break;
    case 'blocked':
      changes = db
        .prepare(`UPDATE revision_prs SET ci_state = 'blocked', ci_reason = ?, ci_checked_at = ?, ci_signature = coalesce(?, ci_signature), updated_at = ? WHERE ${where}`)
        .run(s.reason, at, s.signature ?? null, at, repoId, prNumber, sha).changes;
      break;
  }
  return Number(changes) > 0;
}

/**
 * Open PRs whose CI step queued a fix or stopped for a person, or whose checks passed after an
 * automatic CI fix of the pull request (the outcome of that fix), and whose one comment about that
 * head is still to be posted. A head that passed without any CI fix gets no comment.
 */
export function listPendingCiNotices(db: Db, maxAttempts: number): LoopPr[] {
  return (
    db
      .prepare(
        `SELECT * FROM revision_prs
         WHERE state = 'open' AND (ci_state IN ('fixing', 'blocked') OR (ci_state = 'passed' AND ci_fixes > 0)) AND ci_sha IS NOT NULL
           AND (ci_comment_sha IS NULL OR ci_comment_sha != ci_sha) AND ci_comment_attempts < ?
         ORDER BY updated_at`,
      )
      .all(maxAttempts) as unknown as LoopPrRow[]
  ).map(rowToLoopPr);
}

/** Record the outcome of one attempt to post the CI comment for `sha`. */
export function recordCiNotice(db: Db, repoId: number, prNumber: number, sha: string, r: { commentId: number; commentUrl: string } | { error: string }, now?: () => number): void {
  const at = nowIso(now);
  if ('error' in r) {
    db.prepare('UPDATE revision_prs SET ci_comment_attempts = ci_comment_attempts + 1, updated_at = ? WHERE repo_id = ? AND pr_number = ? AND ci_sha = ?').run(
      at,
      repoId,
      prNumber,
      sha,
    );
  } else {
    db.prepare(
      `UPDATE revision_prs SET ci_comment_sha = ?, ci_comment_id = ?, ci_comment_url = ?, ci_comment_attempts = ci_comment_attempts + 1, updated_at = ?
       WHERE repo_id = ? AND pr_number = ? AND ci_sha = ?`,
    ).run(sha, r.commentId, r.commentUrl, at, repoId, prNumber, sha);
  }
}

/** A revision job of the PR that is queued or running, whatever asked for it, except the one for `exceptReviewId`; or null. */
export function activeRevisionJob(db: Db, repoId: number, prNumber: number, exceptReviewId?: string): string | null {
  const row = db
    .prepare(
      `SELECT j.id FROM review_requests r JOIN jobs j ON j.id = r.job_id
       WHERE r.repo_id = ? AND r.pr_number = ? AND r.review_id != ? AND j.status IN ('queued', 'running') ORDER BY j.created_at LIMIT 1`,
    )
    .get(repoId, prNumber, exceptReviewId ?? '') as { id: string } | undefined;
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Stage, for `updraft status`
// ---------------------------------------------------------------------------

export type PrStage =
  | 'awaiting-review'
  | 'reviewing'
  | 'changes-requested'
  | 'revising'
  | 'waiting-for-ci'
  | 'fixing-ci'
  | 'ready-to-merge'
  | 'merging'
  | 'merged'
  | 'needs-human'
  | 'closed';

export interface PrStageInfo {
  stage: PrStage;
  /** One line of detail; for needs-human, why. */
  detail: string;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : '?');

/**
 * Where a watched PR stands in the loop, from local state alone. `maxRevisions` is the
 * repository's limit. Stages and their transitions are listed in docs/review-loop.md.
 */
export function prStage(db: Db, pr: LoopPr, maxRevisions: number, opts: { ci?: boolean } = {}): PrStageInfo {
  if (pr.mergeState === 'merged') return { stage: 'merged', detail: `merged by Updraft at ${pr.mergedAt ?? '?'} (head ${short(pr.mergeSha)})` };
  if (pr.state === 'closed') return { stage: 'closed', detail: 'closed or merged on GitHub; no longer watched' };

  const revisionJobs = db
    .prepare(
      `SELECT j.id, j.status, j.status_reason FROM review_requests r JOIN jobs j ON j.id = r.job_id
       WHERE r.repo_id = ? AND r.pr_number = ? ORDER BY j.created_at DESC, j.rowid DESC`,
    )
    .all(pr.repoId, pr.prNumber) as { id: string; status: JobStatus; status_reason: string | null }[];
  const reviewJobs = db
    .prepare('SELECT id, status, status_reason, event_id FROM jobs WHERE repo_id = ? AND event_id LIKE ? ORDER BY created_at DESC, rowid DESC')
    .all(pr.repoId, `pr-review:${pr.prNumber}:%`) as { id: string; status: JobStatus; status_reason: string | null; event_id: string }[];
  const push = db
    .prepare('SELECT run_id, state, retryable, error FROM revisions WHERE repo_id = ? AND pr_number = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(pr.repoId, pr.prNumber) as { run_id: string; state: PublicationState; retryable: number; error: string | null } | undefined;
  const round = `round ${countRevisions(db, pr.repoId, pr.prNumber)} of ${maxRevisions}`;

  const revising = revisionJobs.find((j) => j.status === 'running');
  if (revising) {
    if (revising.id === pr.ciFixJobId) return { stage: 'fixing-ci', detail: `revision job ${revising.id} is fixing the failed checks (${round})` };
    return { stage: 'revising', detail: `revision job ${revising.id} is running (${round})` };
  }
  if (push && (push.state === 'publishing' || (push.state === 'failed' && push.retryable === 1))) {
    return { stage: 'revising', detail: `the revision of run ${push.run_id} is being pushed (${round})` };
  }
  const reviewing = reviewJobs.find((j) => j.status === 'running');
  if (reviewing) return { stage: 'reviewing', detail: `reviewer job ${reviewing.id} is running` };
  const queuedRevision = revisionJobs.find((j) => j.status === 'queued');
  if (queuedRevision) {
    if (queuedRevision.id === pr.ciFixJobId) return { stage: 'fixing-ci', detail: `checks failed on ${short(pr.ciSha)}; ${round}; revision job ${queuedRevision.id} is queued` };
    return { stage: 'changes-requested', detail: `${round}; revision job ${queuedRevision.id} is queued` };
  }
  const queuedReview = reviewJobs.find((j) => j.status === 'queued');
  if (queuedReview) return { stage: 'awaiting-review', detail: `reviewer job ${queuedReview.id} is queued` };
  if (!pr.headSha) return { stage: 'awaiting-review', detail: 'the head commit is not known yet' };

  const head = short(pr.headSha);
  const reviewJob = reviewJobs.find((j) => j.event_id === reviewEventId(pr.prNumber, pr.headSha!));
  const posting = reviewJob
    ? (db.prepare('SELECT p.* FROM pr_reviews p JOIN runs r ON r.id = p.run_id WHERE r.job_id = ? ORDER BY r.attempt DESC LIMIT 1').get(reviewJob.id) as
        | PrReviewRow
        | undefined)
    : undefined;

  if (pr.verdictSha === pr.headSha && pr.verdict === 'ready-to-merge') {
    if (opts.ci) {
      const ci = pr.ciSha === pr.headSha ? pr.ciState : null;
      if (ci === null) return { stage: 'waiting-for-ci', detail: `${head} was found ready; its checks have not been looked at yet` };
      if (ci === 'waiting') return { stage: 'waiting-for-ci', detail: `${head} was found ready; waiting since ${pr.ciWaitStartedAt ?? '?'}: ${pr.ciReason ?? 'checks are pending'}` };
      if (ci === 'blocked') return { stage: 'needs-human', detail: `${head} was found ready, but its checks need a person: ${pr.ciReason ?? 'no reason recorded'}` };
      if (ci === 'fixing') {
        const job = revisionJobs.find((j) => j.id === pr.ciFixJobId);
        if (job && job.status !== 'succeeded') {
          return { stage: 'needs-human', detail: `the CI fix (revision job ${job.id}) is ${job.status}${job.status_reason ? `: ${job.status_reason}` : ''}; "updraft retry ${job.id}" tries again` };
        }
        if (push && push.state !== 'published') return { stage: 'needs-human', detail: `the CI fix for ${head} pushed nothing: ${push.error ?? 'no reason recorded'}` };
        return { stage: 'fixing-ci', detail: `checks failed on ${head}: ${pr.ciReason ?? 'a fix was queued'}` };
      }
    }
    if (pr.mergeSha === pr.headSha) {
      if (pr.mergeState === 'waiting') return { stage: 'merging', detail: `waiting since ${pr.mergeWaitStartedAt ?? '?'}: ${pr.mergeReason ?? 'checks are pending'}` };
      if (pr.mergeState === 'merging') return { stage: 'merging', detail: `the merge of ${head} was requested` };
      if (pr.mergeState === 'blocked') return { stage: 'ready-to-merge', detail: `${head} is ready; not merged by Updraft: ${pr.mergeReason ?? 'blocked'}` };
    }
    return { stage: 'ready-to-merge', detail: `${head} was found ready to merge` };
  }

  if (pr.verdictSha === pr.headSha && pr.verdict === 'changes-requested') {
    const verdictRow = pr.verdictRunId ? getPrReview(db, pr.verdictRunId) : null;
    if (verdictRow?.outcome === 'over-limit' || (pr.limitReachedAt && !verdictRow?.revisionJobId)) {
      return { stage: 'needs-human', detail: `changes were requested for ${head}, but the pull request used its ${maxRevisions} revision(s) (maxRevisions)` };
    }
    if (verdictRow?.outcome === 'needs-verification') {
      return { stage: 'needs-human', detail: `${head} is held back by its acceptance criteria: ${verdictRow.outcomeDetail ?? 'some are unverified'}` };
    }
    if (verdictRow?.outcome === 'no-revise') return { stage: 'needs-human', detail: `changes were requested for ${head}, and revise is off, so nothing acts on them` };
    const job = verdictRow?.revisionJobId ? revisionJobs.find((j) => j.id === verdictRow.revisionJobId) : undefined;
    if (job && job.status !== 'succeeded') {
      return { stage: 'needs-human', detail: `revision job ${job.id} is ${job.status}${job.status_reason ? `: ${job.status_reason}` : ''}; "updraft retry ${job.id}" tries again` };
    }
    if (push && push.state !== 'published') return { stage: 'needs-human', detail: `the revision for ${head} pushed nothing: ${push.error ?? 'no reason recorded'}` };
    return { stage: 'needs-human', detail: `changes were requested for ${head} and no revision is on its way` };
  }

  if (reviewJob) {
    if (reviewJob.status !== 'succeeded') {
      return {
        stage: 'needs-human',
        detail: `the review of ${head} did not finish (job ${reviewJob.id} is ${reviewJob.status}${reviewJob.status_reason ? `: ${reviewJob.status_reason}` : ''}); "updraft retry ${reviewJob.id}" tries again`,
      };
    }
    if (posting?.state === 'failed' && posting.retryable !== 1) {
      return { stage: 'needs-human', detail: `the review of ${head} could not be posted: ${posting.error ?? 'unknown error'}; "updraft publish ${posting.run_id}" tries again` };
    }
    if (posting?.state === 'publishing' || posting?.state === 'failed') return { stage: 'reviewing', detail: `the review of ${head} is being posted` };
  }
  return { stage: 'awaiting-review', detail: `${head} has no review yet` };
}
