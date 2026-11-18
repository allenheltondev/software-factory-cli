// What follows a reviewer run (repositories.<repo>.review): its verdict is written down, posted
// on the pull request for people to read, and acted on. See docs/review-loop.md.
//
// GitHub does not let an account approve or request changes on its own pull request, and the
// reviewer runs as the account that opened it. So the verdict is the worker's own record
// (pr_reviews, and the newest one on the PR's row); what GitHub gets is one COMMENT review per
// reviewer run, found again by a hidden marker so a retry never posts a second one. Nothing is
// decided by reading that review back.
//
// Once the review is posted, and only if the verdict is still about the PR's current head:
// - changes-requested queues a revision job from local state, through the same trigger function
//   and the same maxRevisions count as a person's "Request changes" review;
// - ready-to-merge marks a draft PR ready for review. That is the end unless autoMerge is on
//   (merge.ts).
// A verdict for a commit that is no longer the head is recorded as stale and changes nothing.
//
// Same lease and attempt fence around every write as publication and the revision push.
import { appendFile } from 'node:fs/promises';
import { DEFAULT_MAX_REVISIONS, autoMergeMethod, reviewActive, reviseActive, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import { recordError } from '../db/database.js';
import {
  beginPrReview,
  finishPrReview,
  getLoopPr,
  getPrReview,
  holdPrReview,
  listDuePrReviews,
  markReadyRecorded,
  observeHead,
  PrReviewSupersededError,
  recordVerdict,
  REVIEW_MAX_AUTO_ATTEMPTS,
  scheduleAllReviews,
  type PrReview,
  type PrReviewProgress,
  type ReviewOutcome,
} from '../db/pr-reviews.js';
import { getJob, getRun } from '../db/queue.js';
import { countRevisions, enqueueRevision, getReviewRequest, revisionJob } from '../db/revisions.js';
import { GitHubError, type PullRequestReviewSummary } from '../github/api.js';
import { sameLogin, workerLogin } from '../github/identity.js';
import { verdictTrigger } from '../poller/review-trigger.js';
import { reviewOf, type Job, type ReviewResult, type ReviewRunRequest, type ReviewVerdict, type RevisionRequest, type Run } from '../types.js';
import { findRepoConfig } from '../worker/executor.js';
import { code } from './failure-comment.js';
import { evaluateAutoMerges, postMergeNotices } from './merge.js';
import {
  cap,
  classifyFailure,
  fenced,
  inline,
  PUBLISH_ATTEMPT_SECONDS,
  PUBLISH_LEASE_SECONDS,
  PublishRefusal,
  TransientError,
  type PublishDeps,
  type Publisher,
} from './publish.js';

const BASE_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 60 * 60;
const MAX_BODY = 60_000;

export type ReviewPostResult =
  /** The review is on the PR and the verdict was acted on (see `review.outcome`). */
  | { status: 'published'; review: PrReview; already: boolean }
  /** The verdict was recorded but not posted, by design (the PR was closed meanwhile). */
  | { status: 'skipped'; reason: string; review: PrReview }
  /** Not a succeeded reviewer run with a verdict, or reviews no longer apply. Nothing recorded. */
  | { status: 'not-eligible'; reason: string }
  /** Another process is posting this review right now. */
  | { status: 'busy'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean; review: PrReview };

/** Hidden marker on the comment review of a reviewer run. */
export function reviewMarker(runId: string): string {
  return `<!-- updraft-review: ${runId} -->`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string) => sha.slice(0, 12);

const VERDICT_WORDS: Record<ReviewVerdict, string> = { 'ready-to-merge': 'ready to merge', 'changes-requested': 'changes requested' };

/**
 * The body of the comment review: the verdict, the reviewed commit, the reviewing agent and the
 * findings. The findings are an agent's text about untrusted code, so they are fenced: mentions,
 * links and closing keywords in them stay inert, as in the PR body.
 */
export function renderReview(o: {
  runId: string;
  agent: string;
  verdict: ReviewVerdict;
  headSha: string;
  findings: string;
  /** What the worker does with this verdict under the current config, in its own words. */
  next: string;
}): string {
  const marker = reviewMarker(o.runId);
  const body = [
    `**Updraft review: ${VERDICT_WORDS[o.verdict]}**`,
    '',
    `Automated review of commit ${code(short(o.headSha))} by agent ${inline(o.agent)} (run ${code(o.runId)}). It is posted as a comment because the ` +
      'account that opened a pull request cannot approve or request changes on it; the verdict itself is recorded by the worker.',
    '',
    '**Findings**',
    '',
    fenced(o.findings.trim() || '(the reviewer wrote no findings)'),
    '',
    o.next,
  ].join('\n');
  return `${cap(body, MAX_BODY - marker.length - 2)}\n\n${marker}`;
}

/** The sentence under the findings: what happens next, as far as the config says. */
function nextStep(config: UpdraftConfig, repo: RepositoryConfig, verdict: ReviewVerdict, used: number): string {
  if (verdict === 'changes-requested') {
    if (!reviseActive(config, repo)) return 'Revisions are off for this repository, so the changes are up to a person.';
    const max = repo.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    return used >= max
      ? `This pull request has used its ${max} automatic revision(s), so the changes are up to a person.`
      : `If this is still the head commit, Updraft queues a revision for these findings (revision ${used + 1} of at most ${max}).`;
  }
  const method = autoMergeMethod(config, repo);
  return method
    ? `If this is still the head commit, Updraft merges it (${method}) once its checks have passed and nothing else stands in the way; otherwise it says why here.`
    : 'Merging is up to a person.';
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

interface Eligible {
  run: Run;
  job: Job;
  request: ReviewRunRequest;
  result: ReviewResult;
  repoFullName: string;
  repo: NonNullable<ReturnType<typeof findRepoConfig>>['repo'];
}

function eligibility(deps: PublishDeps, runId: string): { ok: true; e: Eligible } | { ok: false; reason: string } {
  const run = getRun(deps.db, runId);
  if (!run) return { ok: false, reason: `run ${runId} not found` };
  const job = getJob(deps.db, run.jobId);
  if (!job) return { ok: false, reason: `job ${run.jobId} of run ${runId} not found` };
  const request = reviewOf(job);
  if (!request) return { ok: false, reason: `run ${runId} is not a reviewer run` };
  const found = findRepoConfig(deps.config, job);
  if (!found) return { ok: false, reason: `${job.repoFullName} is no longer configured` };
  if (!reviewActive(deps.config, found.repo)) {
    return {
      ok: false,
      reason:
        deps.config.execution.mode !== 'live'
          ? `reviews apply only in live mode (execution.mode is ${deps.config.execution.mode})`
          : `review is off for ${found.fullName} (set repositories.${found.fullName}.review, together with publish)`,
    };
  }
  if (run.outcome !== 'succeeded') {
    return { ok: false, reason: `run ${runId} ${run.outcome ? `ended ${run.outcome}` : 'has not finished'}; only a reviewer run that ended with a verdict is posted` };
  }
  const result = run.summary?.review;
  if (!result) return { ok: false, reason: `run ${runId} recorded no verdict` };
  if (result.headSha !== request.headSha) return { ok: false, reason: `run ${runId} reviewed ${short(result.headSha)}, not the commit ${short(request.headSha)} it was queued for` };
  return { ok: true, e: { run, job, request, result, repoFullName: found.fullName, repo: found.repo } };
}

// ---------------------------------------------------------------------------
// Posting, and what follows from the verdict
// ---------------------------------------------------------------------------

/**
 * Record the verdict of one succeeded reviewer run, post it on the PR and act on it, or resume
 * doing so. Never throws for GitHub problems: the result (and the pr_reviews table) says what
 * happened. Nothing is awaited before the pr_reviews row exists.
 */
export async function postReview(deps: PublishDeps, runId: string, opts: { signal?: AbortSignal } = {}): Promise<ReviewPostResult> {
  const now = deps.now ?? Date.now;
  const check = eligibility(deps, runId);
  if (!check.ok) return { status: 'not-eligible', reason: check.reason };
  const { run, job, request, result, repoFullName, repo } = check.e;
  const prNumber = request.pullRequest.number;
  const headSha = result.headSha;
  const repoRef = { id: job.repoId, fullName: repoFullName };
  const log = deps.log.child({ runId, repo: repoFullName, pr: prNumber });

  const begun = beginPrReview(deps.db, {
    runId,
    jobId: job.id,
    repoId: job.repoId,
    repoFullName,
    issueNumber: job.issueNumber,
    prNumber,
    headSha,
    agent: run.agent,
    verdict: result.verdict,
    findings: result.findings,
    leaseSeconds: PUBLISH_LEASE_SECONDS,
    now,
  });
  if (!begun.ok) {
    const r = begun.review;
    if (begun.reason === 'in-progress') {
      return { status: 'busy', reason: `the review of run ${runId} is being posted by another process (lease until ${r.leaseExpiresAt})` };
    }
    return r.state === 'published' ? { status: 'published', review: r, already: true } : { status: 'skipped', reason: r.error ?? 'nothing to post', review: r };
  }
  let rev = begun.review;
  const fence = { attempt: rev.attempts, leaseSeconds: PUBLISH_LEASE_SECONDS, now };
  const attemptStarted = now();
  /** Before each external write: still the owner (renewing the lease), within the deadline, not stopping. */
  const hold = (progress: PrReviewProgress = {}) => {
    holdPrReview(deps.db, runId, fence, progress);
    rev = getPrReview(deps.db, runId)!;
    if (opts.signal?.aborted) throw new TransientError('the worker stopped before the review was posted');
    if (now() - attemptStarted > PUBLISH_ATTEMPT_SECONDS * 1000) {
      throw new TransientError(`review attempt ${fence.attempt} ran past its ${PUBLISH_ATTEMPT_SECONDS / 60}-minute deadline`);
    }
  };
  const runLog = async (lines: string[]) => {
    if (!run.logPath) return;
    try {
      await appendFile(run.logPath, `${lines.map((l) => `review: ${l}`).join('\n')}\n`, 'utf8');
    } catch (err) {
      log.warn('could not write to run.log', { error: message(err) });
    }
  };
  const finish = (r: Parameters<typeof finishPrReview>[3]) => {
    if (!finishPrReview(deps.db, runId, fence.attempt, { ...r, now })) throw new PrReviewSupersededError(runId, fence.attempt);
    return getPrReview(deps.db, runId)!;
  };

  await runLog([`attempt ${rev.attempts} at ${new Date(now()).toISOString()}: verdict ${result.verdict} for ${short(headSha)} of pull request #${prNumber}`]);
  try {
    const watched = getLoopPr(deps.db, job.repoId, prNumber);
    if (!watched) throw new PublishRefusal(`pull request #${prNumber} is not one this worker published; refusing to review it`);
    if (watched.state !== 'open') {
      recordVerdict(deps.db, { repoId: job.repoId, prNumber, runId, verdict: result.verdict, headSha, now });
      const reason = `pull request #${prNumber} was closed or merged before the review could be posted`;
      hold({ outcome: 'closed', outcomeDetail: reason });
      const done = finish({ state: 'skipped', error: reason });
      await runLog([`not posted: ${reason}`]);
      return { status: 'skipped', reason, review: done };
    }

    // 1. The comment review: recorded, found by its marker among the worker's own reviews, or new.
    const login = await workerLogin(deps.api);
    if (!rev.reviewId) {
      hold();
      const marker = reviewMarker(runId);
      const found = (await deps.api.listPullRequestReviews(repoRef, prNumber)).find((r) => r.body.includes(marker) && sameLogin(r.user, login));
      let posted: PullRequestReviewSummary | undefined = found;
      if (!posted) {
        const body = renderReview({
          runId,
          agent: run.agent,
          verdict: result.verdict,
          headSha,
          findings: result.findings,
          next: nextStep(deps.config, repo, result.verdict, countRevisions(deps.db, job.repoId, prNumber)),
        });
        hold(); // the lookup may have outlived the lease
        try {
          posted = await deps.api.createPullRequestReview(repoRef, prNumber, { body, commitId: headSha });
        } catch (err) {
          // The commit is no longer part of the pull request (its branch was rewritten). The body
          // names the commit, so the review is still worth having, unpinned.
          if (!(err instanceof GitHubError) || err.status !== 422) throw err;
          hold();
          posted = await deps.api.createPullRequestReview(repoRef, prNumber, { body });
          await runLog([`GitHub refused to attach the review to ${short(headSha)} (${err.message}); posted it without a commit`]);
        }
      }
      hold({ reviewId: posted.id, reviewUrl: posted.htmlUrl });
      await runLog([found ? `review already on pull request #${prNumber}: ${posted.htmlUrl}` : `posted a comment review on pull request #${prNumber}: ${posted.htmlUrl}`]);
    }

    // 2. The verdict, from the worker's own record. Only a verdict for the current head acts.
    const { current, open } = recordVerdict(deps.db, { repoId: job.repoId, prNumber, runId, verdict: result.verdict, headSha, now });
    let outcome: ReviewOutcome;
    let detail: string | null = null;
    let revisionJobId: string | undefined;
    const decision = verdictTrigger({
      runId,
      verdict: result.verdict,
      findings: result.findings,
      headSha,
      reviewer: login,
      reviewUrl: rev.reviewUrl ?? request.pullRequest.url,
      recordedAt: rev.createdAt,
    });
    if (!open) {
      outcome = 'closed';
    } else if (!current) {
      outcome = 'stale';
      detail = `the pull request is at ${watched.headSha ? short(watched.headSha) : 'another commit'} now; this verdict was for ${short(headSha)}`;
    } else if (decision.triggers) {
      if (!reviseActive(deps.config, repo)) {
        outcome = 'no-revise';
      } else {
        const revision: RevisionRequest = {
          trigger: decision.kind,
          pullRequest: { number: prNumber, url: watched.prUrl, branch: watched.branch },
          sourceRunId: watched.sourceRunId,
          originalEventId: watched.originalEventId,
          review: decision.review,
          reviewedSha: decision.reviewedSha,
        };
        const max = repo.maxRevisions ?? DEFAULT_MAX_REVISIONS;
        const record = {
          repoId: job.repoId,
          reviewId: decision.reviewId,
          prNumber,
          reviewer: login,
          trigger: decision.kind,
          reviewUrl: decision.review.url,
          submittedAt: decision.review.submittedAt,
        };
        const queued = enqueueRevision(deps.db, { ...record, job: revisionJob(repoRef, watched, revision), max }, now);
        // A retry of this step finds the record the first try wrote.
        const recorded = queued.status === 'duplicate' ? getReviewRequest(deps.db, job.repoId, decision.reviewId) : null;
        if (queued.status === 'queued' || recorded?.state === 'queued') {
          outcome = 'revision-queued';
          revisionJobId = queued.status === 'queued' ? queued.job.id : (recorded?.jobId ?? undefined);
          log.info('revision job queued for the reviewer findings', { job: revisionJobId });
        } else {
          outcome = 'over-limit';
          detail = `pull request #${prNumber} has used its ${max} revision(s) (maxRevisions)`;
          log.info('changes requested by the reviewer, but the pull request reached maxRevisions', { max });
        }
      }
    } else {
      outcome = 'ready';
      // 3. Ready for the current head: a draft becomes ready for review. Checked against GitHub
      // first, since someone may have pushed since the worker last looked.
      hold();
      const readAt = new Date(now()).toISOString();
      const pr = await deps.api.getPullRequest(repoRef, prNumber);
      if (pr.state !== 'open') {
        outcome = 'closed';
      } else if (pr.headSha !== headSha) {
        observeHead(deps.db, job.repoId, prNumber, pr.headSha, readAt);
        outcome = 'stale';
        detail = `the pull request is at ${short(pr.headSha)} now; this verdict was for ${short(headSha)}`;
      } else if (pr.draft) {
        hold();
        await deps.api.markPullRequestReady(repoRef, pr.nodeId);
        markReadyRecorded(deps.db, job.repoId, prNumber, now);
        await runLog([`marked pull request #${prNumber} ready for review`]);
      }
    }
    hold({ outcome, outcomeDetail: detail, ...(revisionJobId ? { revisionJobId } : {}) });
    const done = finish({ state: 'published' });
    await runLog([`verdict ${result.verdict}: ${outcome}${detail ? ` (${detail})` : ''}`]);
    log.info('review posted', { verdict: result.verdict, outcome, review: done.reviewUrl });
    return { status: 'published', review: done, already: false };
  } catch (err) {
    if (err instanceof PrReviewSupersededError) {
      log.warn('review attempt superseded', { attempt: fence.attempt });
      await runLog([`attempt ${fence.attempt} stopped: a newer attempt took over`]);
      return { status: 'busy', reason: err.message };
    }
    const classified = classifyFailure(err, { repoFullName, runId, aborted: Boolean(opts.signal?.aborted) });
    const { retryable, retryAfter } = classified;
    const error = classified.error.replace(/^publication was stopped/, 'posting the review was stopped');
    const attempts = rev.attempts;
    let nextAttemptAt: string | null = null;
    if (retryable && attempts < REVIEW_MAX_AUTO_ATTEMPTS) {
      const backoff = retryAfter ?? Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** (attempts - 1));
      nextAttemptAt = new Date(now() + backoff * 1000).toISOString();
    }
    if (!finishPrReview(deps.db, runId, fence.attempt, { state: 'failed', error, retryable, nextAttemptAt, now })) {
      log.warn('review attempt superseded', { attempt: fence.attempt, error });
      return { status: 'busy', reason: new PrReviewSupersededError(runId, fence.attempt).message };
    }
    const hint = nextAttemptAt ? `the worker retries at ${nextAttemptAt}; "updraft publish ${runId}" retries now` : `fix the cause, then run "updraft publish ${runId}"`;
    await runLog([`failed: ${error}`, hint]);
    log.warn('review not posted', { error, retryable, attempts });
    try {
      recordError(deps.db, { scope: 'review', repoFullName, jobId: job.id, message: `run ${runId}: ${error} (${hint})`, at: new Date(now()).toISOString() });
    } catch {
      // the pr_reviews row already holds the error
    }
    return { status: 'failed', error, retryable, review: getPrReview(deps.db, runId)! };
  }
}

// ---------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------

/**
 * The worker's publisher when the review loop is on. A reviewer run goes to postReview; every
 * other run goes to `inner` (publication and the revision push, when those are on), and whatever
 * that pushed gets its reviewer job right after, from local state. After each poll it also
 * retries review postings that are due and takes the auto-merge step (merge.ts).
 */
export function createReviewLoopPublisher(deps: PublishDeps, inner?: Publisher): Publisher {
  const post = async (runId: string, signal?: AbortSignal) => {
    try {
      const r = await postReview(deps, runId, { signal });
      if (r.status === 'not-eligible') deps.log.debug('reviewer run not posted', { runId, reason: r.reason });
    } catch (err) {
      deps.log.error('posting a review crashed', { runId, error: message(err) });
    }
  };
  const schedule = () => {
    try {
      for (const job of scheduleAllReviews(deps.db, deps.config, deps.now)) {
        deps.log.info('reviewer job queued', { job: job.id, repo: job.repoFullName, pr: job.envelope.review?.pullRequest.number, head: job.envelope.review?.headSha, pool: job.pool });
      }
    } catch (err) {
      deps.log.error('could not queue reviewer jobs', { error: message(err) });
    }
  };
  const isReviewRun = (runId: string): boolean => {
    try {
      const run = getRun(deps.db, runId);
      const job = run ? getJob(deps.db, run.jobId) : null;
      return job !== null && reviewOf(job) !== null;
    } catch {
      return false;
    }
  };
  return {
    // Not an async function: `inner` (the revision push) must create its row before this returns to the worker.
    afterRun: (runId, signal) => (isReviewRun(runId) ? post(runId, signal) : (inner?.afterRun(runId, signal) ?? Promise.resolve())).then(schedule),
    async retryDue(signal) {
      await inner?.retryDue(signal);
      let due: string[] = [];
      try {
        due = listDuePrReviews(deps.db, { now: deps.now });
      } catch (err) {
        deps.log.error('could not list reviews to retry', { error: message(err) });
      }
      for (const runId of due) {
        if (signal?.aborted) return;
        await post(runId, signal);
      }
      schedule();
      if (signal?.aborted) return;
      await evaluateAutoMerges(deps, signal);
      if (!signal?.aborted) await postMergeNotices(deps, signal);
    },
  };
}

/** True when reviewer runs happen for any repository. */
export function reviewsEnabled(config: UpdraftConfig): boolean {
  return Object.values(config.repositories).some((r) => reviewActive(config, r));
}
