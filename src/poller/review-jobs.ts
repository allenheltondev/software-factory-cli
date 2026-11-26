// Checks on a reviewer job (repositories.<repo>.review) after it was queued: the counterpart of
// the revision job checks in reviews.ts. A reviewer job is for one head commit of one PR; once
// the PR is closed or its head has moved, the job is canceled (a job for the new head is queued
// separately), so an agent is never spent on a commit nobody will merge.
import { reviewActive, workflowId, type UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import { getLoopPr, HEAD_LAG_GRACE_MS, ownPushReplacing } from '../db/pr-reviews.js';
import { GitHubError, type GitHubApi, type PullRequestReviews } from '../github/api.js';
import { reviewOf, type IssueSnapshot, type Job, type ReviewRunRequest } from '../types.js';

const short = (sha: string) => sha.slice(0, 12);

function isGone(err: unknown): boolean {
  return err instanceof GitHubError && [301, 404, 410].includes(err.status);
}

/** Why a reviewer job no longer applies under the current config, or null. No request. */
function configProblem(config: UpdraftConfig, job: Job): string | null {
  const found = Object.entries(config.repositories).find(([, r]) => r.id === job.repoId);
  if (!found) return `repository ${job.repoFullName} is no longer configured`;
  const [fullName, cfg] = found;
  if (!reviewActive(config, cfg)) {
    return config.execution.mode !== 'live'
      ? `reviewer runs apply only in live mode (execution.mode is ${config.execution.mode})`
      : `review is off for ${fullName} (repositories.${fullName}.review, together with publish)`;
  }
  if (!cfg.workflows.some((w) => workflowId(w) === job.workflowId)) return `workflow "${job.workflowId}" no longer exists in config for ${fullName}`;
  return null;
}

function moved(review: ReviewRunRequest, headSha: string): string {
  return `the head of pull request #${review.pullRequest.number} moved from ${short(review.headSha)} to ${short(headSha)}; the new head gets its own review`;
}

/**
 * The poller's per-cycle check of a queued reviewer job: a cancel reason, or null. Uses only the
 * config and what the worker already recorded about the PR, so it costs no request.
 */
export function queuedReviewProblem(config: UpdraftConfig, db: Db, job: Job): string | null {
  const review = reviewOf(job);
  if (!review) return 'the job has no review request';
  const problem = configProblem(config, job);
  if (problem) return problem;
  const pr = getLoopPr(db, job.repoId, review.pullRequest.number);
  if (!pr) return `pull request #${review.pullRequest.number} is not one this worker published`;
  if (pr.state !== 'open') return `pull request #${review.pullRequest.number} is closed`;
  if (pr.headSha && pr.headSha !== review.headSha) return moved(review, pr.headSha);
  return null;
}

/**
 * GitHub's pull request still names the commit the worker's own push of `review.headSha`
 * replaced, and that push is recent: GitHub has not caught up with it yet (#197). Not a move:
 * canceling would leave the head the worker pushed without a review for good (its dedupe key is
 * spent, and the worker's own push starts no event). The reason to wait, or null.
 */
export function laggingHead(db: Db | undefined, job: Job, review: ReviewRunRequest, githubHead: string, now: () => number = Date.now): string | null {
  if (!db) return null;
  const pushedAt = ownPushReplacing(db, job.repoId, review.pullRequest.number, review.headSha, githubHead);
  if (!pushedAt || now() - Date.parse(pushedAt) >= HEAD_LAG_GRACE_MS) return null;
  return `GitHub still shows ${short(githubHead)} as the head of pull request #${review.pullRequest.number}, the commit the worker's push of ${short(review.headSha)} (at ${pushedAt}) replaced; looked at again shortly`;
}

/**
 * Final check before the worker starts a reviewer job: the config still asks for it, and the PR
 * is still open with the commit under review as its head. One request. With `db`, a read that
 * has not caught up with the worker's own push of that commit keeps the job queued (it rejects).
 *
 * `vouchIssue` is the issue job's own check, as for a revision: when the issue's text is no
 * longer text an allowed actor stands behind, the review still runs (the commit is what it
 * reviews), but the issue body is withheld from the reviewer.
 *
 * Resolves `{ ok: false, reason }` when the job should be canceled; rejects for transient API
 * failures, in which case the job stays queued.
 */
export async function checkReviewDispatchable(
  deps: { api: GitHubApi; config: UpdraftConfig; db?: Db; now?: () => number },
  job: Job,
  vouchIssue: (original: Job) => Promise<{ ok: true; issue?: IssueSnapshot } | { ok: false; reason: string }>,
): Promise<{ ok: true; issue?: IssueSnapshot } | { ok: false; reason: string }> {
  const review = reviewOf(job);
  if (!review) return { ok: false, reason: 'the job has no review request' };
  const problem = configProblem(deps.config, job);
  if (problem) return { ok: false, reason: problem };

  const n = review.pullRequest.number;
  const fullName = Object.entries(deps.config.repositories).find(([, r]) => r.id === job.repoId)?.[0] ?? job.repoFullName;
  let pr: PullRequestReviews;
  try {
    pr = await deps.api.getPullRequestReviews({ id: job.repoId, fullName }, n);
  } catch (err) {
    if (isGone(err)) return { ok: false, reason: `pull request #${n} was deleted or is no longer accessible` };
    throw err;
  }
  if (pr.state !== 'open') return { ok: false, reason: `pull request #${n} was ${pr.merged ? 'merged' : 'closed'}` };
  if (pr.headRef !== review.pullRequest.branch) {
    return { ok: false, reason: `the head of pull request #${n} is ${pr.headRef}, not the published branch ${review.pullRequest.branch}` };
  }
  if (pr.headSha !== review.headSha) {
    const lag = laggingHead(deps.db, job, review, pr.headSha, deps.now);
    if (lag) throw new Error(lag);
    return { ok: false, reason: moved(review, pr.headSha) };
  }

  const issue = await vouchIssue({ ...job, eventId: review.originalEventId });
  if (issue.ok) return issue;
  return {
    ok: true,
    issue: { title: job.envelope.issue.title, body: '', labels: job.envelope.labelsAtEnqueue, url: job.envelope.issue.url, withheld: issue.reason },
  };
}
