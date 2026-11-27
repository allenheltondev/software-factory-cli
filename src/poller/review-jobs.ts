// Checks on a reviewer job (repositories.<repo>.review) after it was queued: the counterpart of
// the revision job checks in reviews.ts. A reviewer job is for one head commit of one PR; once
// the PR is closed or its head has moved, the job is canceled (a job for the new head is queued
// separately), so an agent is never spent on a commit nobody will merge.
import { reviewActive, workflowId, type UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import { getLoopPr, HEAD_LAG_GRACE_MS, HEAD_LAG_LIMIT_MS, ownPushReplacing } from '../db/pr-reviews.js';
import { GitHubError, type GitHubApi, type PullRequestReviews } from '../github/api.js';
import { branchSha } from './head-lag.js';
import { sameLogin, workerLogin } from '../github/identity.js';
import { reviewOf, type IssueSnapshot, type Job, type RepoRef, type ReviewRunRequest } from '../types.js';

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

/** Hidden marker on the one comment that says GitHub's pull request never showed the worker's push of `sha` (#199). */
export function lagStuckMarker(sha: string): string {
  return `<!-- updraft-lag-stuck: ${sha} -->`;
}

/** The please-act comment of a head GitHub's pull request never caught up with: what happened, and what to do. */
export function renderLagStuckNotice(o: { prNumber: number; pushedSha: string; githubHead: string; minutes: number }): string {
  return [
    `GitHub has not updated pull request #${o.prNumber} to the commit Updraft pushed: its branch is at \`${short(o.pushedSha)}\`, but the pull request still shows \`${short(o.githubHead)}\` after ${o.minutes} minutes, so Updraft stopped waiting and did not review it. ` +
      'Please re-run the review (or retry the job) once the pull request shows the commit, or push a commit to the branch to continue.',
    '',
    lagStuckMarker(o.pushedSha),
  ].join('\n');
}

/**
 * Whether to wait for GitHub's pull request to show the worker's own push of `review.headSha`
 * (#197): `wait` with why, `stuck` once it has waited long enough, or null for a real move.
 *
 * GitHub's pull request still names `githubHead`, the commit that push replaced. That is GitHub
 * catching up, not a move, when the branch's git ref is at the pushed commit (or, for a client
 * that cannot read the ref, when the push is less than HEAD_LAG_GRACE_MS old; a push dated after
 * `now`, a clock that ran ahead, is not). Canceling as moved then would leave the head the worker
 * pushed without a review: its dedupe key would be spent, and the worker's own push starts no
 * event. With the ref at the push, the wait is bounded by HEAD_LAG_LIMIT_MS from the push (#199):
 * past it (or for a push dated after `now`), `stuck`.
 */
export async function laggingHead(
  deps: { api: Pick<GitHubApi, 'getBranchSha'>; db?: Db; now?: () => number },
  job: Job,
  review: ReviewRunRequest,
  githubHead: string,
): Promise<{ wait: string } | { stuck: string } | null> {
  if (!deps.db) return null;
  const pushedAt = ownPushReplacing(deps.db, job.repoId, review.pullRequest.number, review.headSha, githubHead);
  if (!pushedAt) return null;
  const why = `GitHub's pull request #${review.pullRequest.number} still shows ${short(githubHead)}, the commit the worker's push of ${short(review.headSha)} (at ${pushedAt}) replaced`;
  const branch = await branchSha(deps.api, { id: job.repoId, fullName: job.repoFullName }, review.pullRequest.branch);
  const age = (deps.now ?? Date.now)() - Date.parse(pushedAt);
  if (branch === review.headSha) {
    if (age >= 0 && age < HEAD_LAG_LIMIT_MS) return { wait: `${why}, and its branch is at ${short(review.headSha)}: GitHub has not caught up yet` };
    return { stuck: `${LAG_STUCK}: ${why}, and its branch is at ${short(review.headSha)}: GitHub did not catch up within ${HEAD_LAG_LIMIT_MS / 60_000} minutes of the push, so the review was not started` };
  }
  if (branch !== undefined) return null;
  return age >= 0 && age < HEAD_LAG_GRACE_MS ? { wait: `${why}, less than ${HEAD_LAG_GRACE_MS / 60_000} minutes ago` } : null;
}

/** The code a reviewer job canceled because GitHub never showed its head starts its reason with (#199). */
export const LAG_STUCK = 'lag_stuck';

/**
 * The please-act comment for a reviewer job that stopped waiting for GitHub (laggingHead `stuck`),
 * once per pushed head: posted unless the worker's own comment with the marker is there. Rejects
 * for a transient failure (the job then stays queued, and this is tried again); any other failure
 * is returned, and the job is canceled all the same.
 */
async function noticeLagStuck(api: GitHubApi, repo: RepoRef, review: ReviewRunRequest, githubHead: string): Promise<string | null> {
  try {
    const login = await workerLogin(api);
    const marker = lagStuckMarker(review.headSha);
    const n = review.pullRequest.number;
    if ((await api.listIssueComments(repo, n)).some((c) => c.body.includes(marker) && sameLogin(c.user, login))) return null;
    await api.createIssueComment(repo, n, renderLagStuckNotice({ prNumber: n, pushedSha: review.headSha, githubHead, minutes: HEAD_LAG_LIMIT_MS / 60_000 }));
    return null;
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 0 || err.status >= 500 || err.isRateLimit)) throw err;
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Final check before the worker starts a reviewer job: the config still asks for it, and the PR
 * is still open with the commit under review as its head. One request, two when GitHub's pull
 * request may only lag behind the worker's own push of that commit (laggingHead): then the job
 * is not canceled but left queued for the next pass (`retry`), for at most HEAD_LAG_LIMIT_MS
 * after the push; past that it is canceled (its reason starts with LAG_STUCK), and a please-act
 * comment on the pull request says so (#199).
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
): Promise<{ ok: true; issue?: IssueSnapshot } | { ok: false; reason: string; retry?: true }> {
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
    const lag = await laggingHead(deps, job, review, pr.headSha);
    if (lag && 'wait' in lag) return { ok: false, reason: lag.wait, retry: true };
    if (lag) {
      // Waited long enough (#199): a person is told on the pull request, and the job is canceled.
      const failed = await noticeLagStuck(deps.api, { id: job.repoId, fullName }, review, pr.headSha);
      return { ok: false, reason: failed ? `${lag.stuck} (the comment saying so could not be posted: ${failed})` : lag.stuck };
    }
    return { ok: false, reason: moved(review, pr.headSha) };
  }

  const issue = await vouchIssue({ ...job, eventId: review.originalEventId });
  if (issue.ok) return issue;
  return {
    ok: true,
    issue: { title: job.envelope.issue.title, body: '', labels: job.envelope.labelsAtEnqueue, url: job.envelope.issue.url, withheld: issue.reason },
  };
}
