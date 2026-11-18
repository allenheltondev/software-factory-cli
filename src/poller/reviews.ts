// Review poller for the revision loop (repositories.<repo>.revise). Runs inside pollOnce, after
// the repository's issue events, and shares its error handling and backoff. Per repository:
//   1. Watch the PRs of published publications (and no others). No open watched PR: no request.
//   2. One conditional GET of page 1 of the repository's pull requests, most recently updated
//      first, with the stored ETag. 304: nothing on any PR changed.
//   3. Otherwise page back until every open watched PR was listed, or the listing is older than
//      (newest updated_at the last scan saw minus OVERLAP_MS). A watched PR that is closed or
//      merged stops being watched and its queued revision jobs are canceled.
//   4. Only for a watched PR whose updated_at differs from the one its reviews were last read
//      at: one GraphQL request for its reviews, their comments and who edited them. Each review
//      not recorded yet is put to reviewTrigger (review-trigger.ts); a trigger is snapshotted
//      and queued as a revision job, in one transaction with its record, so a review is acted on
//      once whatever is replayed.
//   5. The checkpoint (ETag, newest updated_at) is stored only after every PR was processed; an
//      API error leaves it where it was and the scan is repeated.
import { allowedActorsFor, DEFAULT_MAX_REVISIONS, reviseActive, workflowId, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import {
  closeRevisionPr,
  enqueueRevision,
  getReviewCheckpoint,
  getReviewRequest,
  getRevisionPr,
  listOpenRevisionPrs,
  markRevisionPrSeen,
  recordReviewRequest,
  revisionJob,
  saveReviewCheckpoint,
  syncRevisionPrs,
  type RevisionPr,
} from '../db/revisions.js';
import { GitHubError, type GitHubApi, type GitHubReview, type PullRequestReviews, type PullRequestUpdate } from '../github/api.js';
import { revisionOf, type IssueSnapshot, type Job, type RepoRef, type ReviewSnapshot, type RevisionRequest } from '../types.js';
import type { Logger } from '../util/log.js';
import { isAllowedActor, reviewTrigger, reviewWithdrawn } from './review-trigger.js';

/** Pull requests per page. Keep constant: the stored page-1 ETag depends on the query string. */
export const PULLS_PER_PAGE = 100;
/** Max listing pages per scan. A watched PR further back than this is read directly instead. */
export const MAX_PULL_PAGES = 10;
/** How far before the newest previously seen updated_at to keep reading (GitHub's clocks and replication). */
export const REVIEW_OVERLAP_MS = 5 * 60 * 1000;

const MAX_REVIEW_BODY = 20_000;
const MAX_COMMENT_BODY = 6_000;
const MAX_DIFF_HUNK = 2_000;
const MAX_COMMENTS = 50;

export interface ReviewPollResult {
  /** Watched PRs whose reviews were read this cycle (one request each). */
  pullRequestsRead: number;
  revisionsQueued: number;
  jobsCanceled: number;
}

interface ReviewPollDeps {
  db: Db;
  api: GitHubApi;
  config: UpdraftConfig;
  now?: () => number;
}

/** Deleted, transferred or no longer readable. */
function isGone(err: unknown): boolean {
  return err instanceof GitHubError && [301, 404, 410].includes(err.status);
}

const sameTime = (a: string | null, b: string) => a !== null && Date.parse(a) === Date.parse(b);

function capEnd(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The end of a diff hunk is where the comment is attached, so that is the part to keep. */
function capStart(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

/** The review as the agent will be given it: only what reviewTrigger let through, capped. */
function snapshotReview(review: GitHubReview, decision: Extract<ReturnType<typeof reviewTrigger>, { triggers: true }>): ReviewSnapshot {
  const kept = decision.comments.slice(0, MAX_COMMENTS);
  return {
    id: review.id,
    url: review.url,
    author: decision.author,
    submittedAt: review.submittedAt ?? '',
    body: capEnd(decision.body, MAX_REVIEW_BODY),
    comments: kept.map((c) => ({
      path: c.path,
      line: c.line,
      body: capEnd(c.body, MAX_COMMENT_BODY),
      diffHunk: capStart(c.diffHunk, MAX_DIFF_HUNK),
    })),
    omittedComments: decision.omittedComments + (decision.comments.length - kept.length),
  };
}

/**
 * Poll one repository's watched PRs for change requests. Returns null when the revision loop is
 * off for it (no request is made, no state is touched). Throws for API errors, like pollRepo.
 */
export async function pollRepoReviews(deps: ReviewPollDeps, repo: RepoRef, cfg: RepositoryConfig, log: Logger): Promise<ReviewPollResult | null> {
  if (!reviseActive(deps.config, cfg)) return null;
  const { db, api } = deps;
  const result: ReviewPollResult = { pullRequestsRead: 0, revisionsQueued: 0, jobsCanceled: 0 };

  const added = syncRevisionPrs(db, repo.id, deps.now);
  if (added) log.info('watching pull requests for change requests', { added });
  const watched = new Map(listOpenRevisionPrs(db, repo.id).map((w) => [w.prNumber, w]));
  if (watched.size === 0) return result;

  const cp = getReviewCheckpoint(db, repo.id);
  const boundary = cp?.lastUpdatedAt ? Date.parse(cp.lastUpdatedAt) - REVIEW_OVERLAP_MS : null;
  const listed = new Map<number, PullRequestUpdate>();
  let etag = cp?.etag ?? null;
  let newest = cp?.lastUpdatedAt ?? null;
  let page = 1;
  // False when the page budget ran out first: a watched PR that was not listed may have changed.
  let complete = false;
  for (let fetched = 0; fetched < MAX_PULL_PAGES; fetched++) {
    const res = await api.listPullRequestUpdates(repo, { page, perPage: PULLS_PER_PAGE, etag: page === 1 ? etag : null });
    complete = true;
    // Sorted by update time, so any change to any PR changes page 1 and its ETag.
    if (res.notModified) break;
    if (page === 1) etag = res.etag;
    for (const p of res.pulls) {
      // Pages shift while PRs are updated; the first (newest) sighting of a PR wins.
      if (!listed.has(p.number)) listed.set(p.number, p);
      if (newest === null || Date.parse(p.updatedAt) > Date.parse(newest)) newest = p.updatedAt;
    }
    if (res.nextPage === null) break;
    if ([...watched.keys()].every((n) => listed.has(n))) break;
    if (boundary !== null && res.pulls.some((p) => Date.parse(p.updatedAt) < boundary)) break;
    page = res.nextPage;
    complete = false;
  }

  const close = (w: RevisionPr, why: string) => {
    const canceled = closeRevisionPr(db, repo.id, w.prNumber, why, deps.now);
    result.jobsCanceled += canceled.length;
    log.info('pull request no longer watched for change requests', { pr: w.prNumber, reason: why, jobsCanceled: canceled.length });
  };

  for (const w of watched.values()) {
    const seen = listed.get(w.prNumber);
    if (seen && seen.state !== 'open') {
      close(w, `pull request #${w.prNumber} was ${seen.merged ? 'merged' : 'closed'}`);
      continue;
    }
    // Not listed: unchanged since the last scan, unless its reviews were never read (a PR that
    // was already old when revise was turned on can sit beyond the pages read) or the listing
    // was cut short; then the PR is read directly.
    if (seen ? sameTime(w.seenUpdatedAt, seen.updatedAt) : w.seenUpdatedAt !== null && complete) continue;

    let pr: PullRequestReviews;
    try {
      pr = await api.getPullRequestReviews(repo, w.prNumber);
    } catch (err) {
      if (!isGone(err)) throw err;
      close(w, `pull request #${w.prNumber} was deleted or is no longer accessible`);
      continue;
    }
    result.pullRequestsRead++;
    if (pr.state !== 'open') {
      close(w, `pull request #${w.prNumber} was ${pr.merged ? 'merged' : 'closed'}`);
      continue;
    }
    result.revisionsQueued += ingestReviews(deps, repo, cfg, w, pr, log);
    // The listed time, not the read's: a review that landed between the two is then read again.
    markRevisionPrSeen(db, repo.id, w.prNumber, seen?.updatedAt ?? pr.updatedAt, deps.now);
  }

  saveReviewCheckpoint(db, repo.id, { etag, lastUpdatedAt: newest }, deps.now);
  return result;
}

/** Decide every review of `pr` that has no record yet, oldest first. Returns how many revision jobs were queued. */
function ingestReviews(deps: ReviewPollDeps, repo: RepoRef, cfg: RepositoryConfig, w: RevisionPr, pr: PullRequestReviews, log: Logger): number {
  const { db } = deps;
  const wf = cfg.workflows.find((x) => workflowId(x) === w.workflowId);
  const reviews = [...pr.reviews].sort((a, b) => Date.parse(a.submittedAt ?? '') - Date.parse(b.submittedAt ?? ''));
  let queued = 0;
  for (const review of reviews) {
    if (getReviewRequest(db, repo.id, review.id)) continue;
    // Without its workflow there is no allowlist to judge the review by: nobody is allowed.
    const decision = reviewTrigger(review, wf ? allowedActorsFor(deps.config, wf) : []);
    if (decision.kind === null) continue;
    const ctx = { pr: w.prNumber, review: review.url, reviewer: review.author };
    const record = { repoId: repo.id, reviewId: review.id, prNumber: w.prNumber, reviewer: review.author, trigger: decision.kind, reviewUrl: review.url, submittedAt: review.submittedAt };
    if (!decision.triggers) {
      const reason = wf ? decision.reason : `workflow "${w.workflowId}" no longer exists in config for ${repo.fullName}`;
      recordReviewRequest(db, { ...record, state: wf ? decision.disposition : 'ignored', reason }, deps.now);
      log.info('change request not acted on', { ...ctx, reason });
      continue;
    }
    if (pr.headRef !== w.branch) {
      // Updraft only ever pushes to the branch it created; a PR whose head is something else is not ours to revise.
      const reason = `the head of pull request #${w.prNumber} is ${pr.headRef}, not the branch ${w.branch} that was published`;
      recordReviewRequest(db, { ...record, state: 'ignored', reason }, deps.now);
      log.warn('change request not acted on', { ...ctx, reason });
      continue;
    }
    const revision: RevisionRequest = {
      trigger: decision.kind,
      pullRequest: { number: w.prNumber, url: w.prUrl, branch: w.branch },
      sourceRunId: w.sourceRunId,
      originalEventId: w.originalEventId,
      review: snapshotReview(review, decision),
    };
    const max = cfg.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    const res = enqueueRevision(db, { ...record, job: revisionJob(repo, w, revision), max }, deps.now);
    if (res.status === 'queued') {
      queued++;
      log.info('revision job queued', { ...ctx, job: res.job.id, issue: res.job.issueNumber, workflow: res.job.workflowId, pool: res.job.pool });
    } else if (res.status === 'over-limit') {
      log.info('change request recorded but not acted on: the pull request reached maxRevisions', { ...ctx, revisions: res.count, max });
    }
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Checks on a revision job after it was queued
// ---------------------------------------------------------------------------

/**
 * Why a revision job no longer applies under the current config, or null. No request: this runs
 * for every queued revision job on every poll.
 */
function configProblem(config: UpdraftConfig, job: Job, revision: RevisionRequest): string | null {
  const found = Object.entries(config.repositories).find(([, r]) => r.id === job.repoId);
  if (!found) return `repository ${job.repoFullName} is no longer configured`;
  const [fullName, cfg] = found;
  if (!reviseActive(config, cfg)) {
    return config.execution.mode !== 'live'
      ? `revisions apply only in live mode (execution.mode is ${config.execution.mode})`
      : `revisions are off for ${fullName} (repositories.${fullName}.revise, together with publish)`;
  }
  const wf = cfg.workflows.find((w) => workflowId(w) === job.workflowId);
  if (!wf) return `workflow "${job.workflowId}" no longer exists in config for ${fullName}`;
  if (!isAllowedActor(allowedActorsFor(config, wf), revision.review.author)) {
    return `${revision.review.author}, who requested the changes, is no longer an allowed actor for this workflow`;
  }
  return null;
}

/**
 * The poller's per-cycle check of a queued revision job: a cancel reason, or null. Uses only the
 * config and what the listing already recorded about the PR, so it costs no request.
 */
export function queuedRevisionProblem(config: UpdraftConfig, db: Db, job: Job): string | null {
  const revision = revisionOf(job);
  if (!revision) return 'the job has no revision request';
  const problem = configProblem(config, job, revision);
  if (problem) return problem;
  const pr = getRevisionPr(db, job.repoId, revision.pullRequest.number);
  if (pr && pr.state !== 'open') return `pull request #${revision.pullRequest.number} is closed`;
  return null;
}

/**
 * Final check before the worker starts a revision job: the config still asks for it, the PR is
 * still open on the branch that was published, and the review still stands. One request.
 *
 * `vouchIssue` runs the issue job's own check against the label application that queued the
 * original job. When it finds the issue text is no longer text an allowed actor stands behind
 * (edited since, label removed, issue closed), the revision still runs, because the review is
 * what it acts on, but the issue body is withheld from the agent.
 *
 * Resolves `{ ok: false, reason }` when the job should be canceled; rejects for transient API
 * failures, in which case the job stays queued.
 */
export async function checkRevisionDispatchable(
  deps: { api: GitHubApi; config: UpdraftConfig },
  job: Job,
  vouchIssue: (original: Job) => Promise<{ ok: true; issue?: IssueSnapshot } | { ok: false; reason: string }>,
): Promise<{ ok: true; issue?: IssueSnapshot } | { ok: false; reason: string }> {
  const revision = revisionOf(job);
  if (!revision) return { ok: false, reason: 'the job has no revision request' };
  const problem = configProblem(deps.config, job, revision);
  if (problem) return { ok: false, reason: problem };

  const n = revision.pullRequest.number;
  // By its current name: GraphQL addresses the repository by owner and name.
  const fullName = Object.entries(deps.config.repositories).find(([, r]) => r.id === job.repoId)?.[0] ?? job.repoFullName;
  let pr: PullRequestReviews;
  try {
    pr = await deps.api.getPullRequestReviews({ id: job.repoId, fullName }, n);
  } catch (err) {
    if (isGone(err)) return { ok: false, reason: `pull request #${n} was deleted or is no longer accessible` };
    throw err;
  }
  if (pr.state !== 'open') return { ok: false, reason: `pull request #${n} was ${pr.merged ? 'merged' : 'closed'}` };
  if (pr.headRef !== revision.pullRequest.branch) {
    return { ok: false, reason: `the head of pull request #${n} is ${pr.headRef}, not the published branch ${revision.pullRequest.branch}` };
  }
  const withdrawn = reviewWithdrawn(revision, pr.reviews);
  if (withdrawn) return { ok: false, reason: withdrawn };

  const issue = await vouchIssue({ ...job, eventId: revision.originalEventId });
  if (issue.ok) return issue;
  return {
    ok: true,
    issue: { title: job.envelope.issue.title, body: '', labels: job.envelope.labelsAtEnqueue, url: job.envelope.issue.url, withheld: issue.reason },
  };
}
