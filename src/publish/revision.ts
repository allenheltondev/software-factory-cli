// The push and reply of a revision run (repositories.<repo>.revise): after a revision job's run
// succeeded, the worker (never the agent) pushes its commits to the pull request's branch and
// comments once on the pull request. Nothing here approves, merges, dismisses a review, resolves
// a thread or marks a PR ready.
//
// This is the one place the worker moves a branch that already exists on the remote, and it can
// only do so one way: the PR's own job branch, fast-forwarded from exactly the commit the run
// started from.
// - which branch: the head recorded when Updraft published the PR (revision_prs.branch), which
//   must be a job branch name and must not be the base or default branch.
// - from where: `git push --force-with-lease=<ref>:<base>` with a non-`+` refspec. The lease
//   makes the remote refuse the update unless the branch is still at <base>, the remote head the
//   run's worktree was created from. A lease by itself would also allow a rewrite, so the worker
//   first checks that the run's commit descends from <base>: both together make it a fast-forward
//   of that exact head or nothing.
// - a branch that moved is never retried or rebased: the revision is recorded as not pushed and
//   one comment on the PR says so.
// Destination validation, the throwaway repository, hooks-off and the token handling are
// publication's (openPushTarget), as are the lease and attempt fence around every write.
import { quietFor } from './status-comment.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_MAX_REVISIONS, reviseActive, type UpdraftConfig } from '../config/schema.js';
import { recordError } from '../db/database.js';
import { getJob, getRun, ownEntry } from '../db/queue.js';
import {
  beginRevision,
  finishRevision,
  getRevision,
  getRevisionPr,
  holdRevision,
  listDueRevisions,
  listPendingLimitNotices,
  recordLimitNotice,
  REVISION_MAX_AUTO_ATTEMPTS,
  RevisionSupersededError,
  type RevisionPr,
  type RevisionProgress,
} from '../db/revisions.js';
import { assertValidBranchName, GitError, redactRemoteUrl, remoteDefaultBranch, runGit as defaultRunGit, type GitOptions } from '../git/git.js';
import { isJobBranchName, jobBranchName, withCheckoutLock } from '../git/worktree.js';
import { GitHubError, type GitHubApi, type GitHubIssueComment } from '../github/api.js';
import { getPublication } from '../db/publications.js';
import { codingRole } from './publisher-role.js';
import { isWorkerLogin } from '../github/credentials.js';
import { revisionOf, type Job, type RepoRef, type Revision, type RevisionRequest, type Run, type RunSummary } from '../types.js';
import { findRepoConfig } from '../worker/executor.js';
import { code } from './failure-comment.js';
import { runDetails, selectionLine } from './run-details.js';
import { safeMarkdown } from './markdown.js';
import { answerFindings, commitUrl } from './threads.js';
import { checkLink } from './ci.js';
import { workerLogin } from '../github/identity.js';
import {
  cap,
  classifyFailure,
  mergePolicy,
  mergeSentence,
  withMergeSentence,
  type MergePolicy,
  classifyGit,
  fenced,
  inline,
  openPushTarget,
  PUBLISH_ATTEMPT_SECONDS,
  PUBLISH_LEASE_SECONDS,
  PublishRefusal,
  redactSecret,
  renderRunResult,
  TransientError,
  type PublishDeps,
  type Publisher,
} from './publish.js';

const BASE_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 60 * 60;
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const MAX_FINAL_MESSAGE = 6_000;
const MAX_BODY = 60_000;

export type ReviseResult =
  /** The PR branch has the run's commits and the reply is posted. */
  | { status: 'published'; revision: Revision; already: boolean }
  /** Nothing was pushed, by design (no commits, or the PR was closed meanwhile). Recorded. */
  | { status: 'skipped'; reason: string; revision: Revision }
  /** Not a succeeded revision run, or revisions no longer apply. Nothing recorded. */
  | { status: 'not-eligible'; reason: string }
  /** Another process is working on this revision right now. */
  | { status: 'busy'; reason: string }
  /** `moved`: the push was refused because the PR branch was no longer where the run started. */
  | { status: 'failed'; error: string; retryable: boolean; moved: boolean; revision: Revision };

/** Hidden marker on the PR comment of a revision run (the reply, or the notice that nothing was pushed). */
export function revisionMarker(runId: string): string {
  return `<!-- updraft-revision: ${runId} -->`;
}

// ---------------------------------------------------------------------------
// One revision per review, across machines (PublishDeps.claimReviews)
// ---------------------------------------------------------------------------
//
// The long-running worker acts on a review once because its one database records the review by
// its id. Single-event runs each have a copy of the state, and two of them can meet the same
// review without either having seen the other's record (the machine the review's delivery
// started, and the last look of the run that opened the pull request). Their state databases
// cannot settle that before the merge; the pull request can, because both read and write it:
//
// - before it pushes, a revision posts its comment on the pull request, carrying the review's id
//   and the commits it is about to move the branch between (the "claim"); after the push the
//   same comment becomes the reply;
// - a revision whose claim another one has already made good on (the claimed head is in the
//   history this run started from, or is where the branch now is) pushes nothing and ends
//   `skipped` with a reason that begins "superseded: ";
// - the push itself is the fast-forward from the exact commit the run started from, as always.
//   Of two runs that started from the same head only one push is accepted; the other finds the
//   branch at the head the first one claimed, and ends the same way.
// A claim is posted before its push, so a run that fetches a branch holding another's revision
// can always see that claim; and a run that cannot see it has not built on it, so its lease fails.

/** The words a revision's `error` (and a canceled job's reason) begins with when another run handled the review. */
export const SUPERSEDED_PREFIX = 'superseded: ';

/** Hidden marker on a revision's comment: which review it answers, and from which commit to which it moves the branch. */
export function revisionClaimMarker(reviewId: string, baseSha: string, headSha: string): string {
  return `<!-- updraft-revision-of: ${reviewId} ${baseSha}..${headSha} -->`;
}

const CLAIM = /<!-- updraft-revision-of: (\S+) ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64}) -->/;
const RUN_MARKER = /<!-- updraft-revision: (\S+) -->/;

export interface RevisionClaim {
  reviewId: string;
  /** The branch head the revision started from, and the commit it pushes (equal when it has nothing to push). */
  baseSha: string;
  headSha: string;
  /** The run that made it. */
  runId: string | null;
  commentId: number;
  url: string;
}

/**
 * The claims on a pull request for one review: comments by the worker's own identity that carry
 * the marker. Anybody can write a comment that looks like one, so the author is checked: a
 * comment by someone else is not a claim.
 */
export async function findRevisionClaims(api: Pick<GitHubApi, 'listIssueComments' | 'getWorkerIdentity'>, repo: RepoRef, prNumber: number, reviewId: string): Promise<RevisionClaim[]> {
  const marked = (await api.listIssueComments(repo, prNumber)).flatMap((c) => {
    const m = CLAIM.exec(c.body);
    return m && m[1] === reviewId ? [{ c, m }] : [];
  });
  if (!marked.length) return [];
  const identity = await api.getWorkerIdentity();
  return marked
    .filter(({ c }) => isWorkerLogin(identity, c.user))
    .map(({ c, m }) => ({ reviewId, baseSha: m[2]!, headSha: m[3]!, runId: RUN_MARKER.exec(c.body)?.[1] ?? null, commentId: c.id, url: c.htmlUrl }));
}

/**
 * Quiet notifications: a CI fix's claim is a ref on the remote, never a comment on the pull request.
 * `refs/updraft/revision-claims/<review>/<run>` points at the commit the run pushes. GitHub shows
 * no branch or tag for it, and a fetch of branches never brings it.
 */
export function revisionClaimRef(reviewId: string, runId?: string): string {
  const key = reviewId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '-').replace(/^[.-]+|[.]+$/g, '').slice(0, 120) || 'review';
  return `refs/updraft/revision-claims/${key}/${runId ? runId.replace(/[^A-Za-z0-9_-]/g, '-') : ''}`;
}

/** The ref claims of the runs that revised for `reviewId`, as the remote has them now. */
export async function findRefClaims(
  run1: (args: readonly string[], opts: GitOptions) => Promise<{ stdout: string }>,
  pushUrl: string,
  net: GitOptions,
  reviewId: string,
  repoFullName: string,
  prNumber: number,
): Promise<RevisionClaim[]> {
  const prefix = revisionClaimRef(reviewId);
  const listed = (await run1(['ls-remote', pushUrl, `${prefix}*`], net)).stdout;
  return listed
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length >= 2 && /^[0-9a-f]{40,64}$/.test(parts[0]!) && parts[1]!.startsWith(prefix))
    .map(([sha, ref]) => ({ reviewId, baseSha: '', headSha: sha, runId: ref.slice(prefix.length) || null, commentId: 0, url: `https://github.com/${repoFullName}/pull/${prNumber}` }));
}

/** Hidden marker on the one comment that says a PR reached maxRevisions. */
export const REVISION_LIMIT_MARKER = '<!-- updraft-revision-limit -->';

/** The push was refused for a reason the PR should be told about; never retried. */
class NotPushed extends PublishRefusal {
  constructor(
    message: string,
    /** The same, for the PR comment: no local paths. */
    readonly notice: string,
    readonly moved: boolean,
  ) {
    super(message);
    this.name = 'NotPushed';
  }
}

/** Another run has answered the review (claimReviews): this one pushes nothing and says nothing. Not a failure. */
class Superseded extends Error {
  constructor(readonly claim: RevisionClaim) {
    super(`another run answered the review first (${claim.url})`);
    this.name = 'Superseded';
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string) => sha.slice(0, 12);

// ---------------------------------------------------------------------------
// Comment text
// ---------------------------------------------------------------------------

function withMarker(lines: string[], marker: string): string {
  return `${cap(lines.join('\n'), MAX_BODY - marker.length - 2)}\n\n${marker}`;
}

/**
 * What a revision was for, in its reply's words. A CI fix was asked for by failed checks, not by a
 * person: its "review" is the worker's own summary of them, so it is not named as a change request.
 */
function askedFor(review: RevisionRequest['review'], trigger: RevisionRequest['trigger'] | undefined): string {
  if (trigger === 'ci_failure') {
    // A CI fix's URL is a failed check's or a commit status's target, which any integration that
    // can write statuses sets: linked only when it is a plain https link, else left out.
    const link = checkLink(review.url);
    return `the checks that failed on ${code(short(review.headSha ?? '?'))}${link ? ` (${link})` : ''}`;
  }
  if (trigger === 'suggestions') return `the review's suggestions on ${code(short(review.headSha ?? '?'))} (${review.url})`;
  return `the changes requested by ${code(review.author)} in ${review.url}`;
}

/** The reply after a push: the new commits, the verification result and the agent's final message, all inert. */
export function renderRevisionReply(o: {
  runId: string;
  agent: string;
  review: RevisionRequest['review'];
  summary: RunSummary;
  commitCount: number;
  perFinding?: string[];
  selection?: string;
  /** What asked for the revision; a CI fix (ci_failure) is answered by the Coding agent with the commit it pushed. */
  trigger?: RevisionRequest['trigger'];
  /** The commit the push left the pull request at, and its page. */
  pushed?: { sha: string; url: string | null };
  /** What merge.ts will do with the pull request (publish.ts mergePolicy); absent: up to a person. */
  merge?: MergePolicy;
}): string {
  const at = o.pushed ? (o.pushed.url ? `[${code(short(o.pushed.sha))}](${o.pushed.url})` : code(short(o.pushed.sha))) : null;
  return withMarker(
    [
      ...(o.perFinding?.length
        ? [
            `**Coding agent** · pushed ${o.commitCount} commit(s) for the findings in ${o.review.url}`,
            '',
            '**Per finding** (the coding agent\'s account; the review agent checks it on the new head)',
            '',
            ...o.perFinding,
            '',
          ]
        : o.trigger === 'ci_failure'
          ? [
              `**Coding agent** · pushed ${o.commitCount} commit(s) to fix ${askedFor(o.review, o.trigger)}${at ? `; the pull request is now at ${at}` : ''}.`,
              '',
              "This is the coding agent's account, not a verification: the review agent reviews the new head, and Updraft · CI reads its checks again.",
              '',
            ]
          : [`Updraft pushed ${o.commitCount} commit(s) to this pull request for the changes requested by ${code(o.review.author)} in ${o.review.url}`, '']),
      `From run ${code(o.runId)} (agent ${inline(o.agent)}). ${o.merge?.auto ? `Updraft merges it (${code(o.merge.method)}) once review and required checks pass.` : `Review it before merging; ${mergeSentence(o.merge ?? { auto: false, reason: null }).replace(/^M/, 'm')}`}`,
      '',
      ...(o.selection ? [`<sub>${o.selection}</sub>`, ''] : []),
      ...renderRunResult(o.summary, o.commitCount),
    ],
    revisionMarker(o.runId),
  );
}

/** Restate the PR body's merge sentence after a push. Best effort: the body is not what decides a merge. */
async function restateMerge(deps: PublishDeps, repo: RepoRef, prNumber: number, merge: MergePolicy, log: PublishDeps['log']): Promise<void> {
  if (!deps.api.updatePullRequestBody) return;
  try {
    const body = (await deps.api.getPullRequest(repo, prNumber)).body;
    const next = body ? withMergeSentence(body, merge) : null;
    if (next) await deps.api.updatePullRequestBody(repo, prNumber, next);
  } catch (err) {
    log.warn('could not restate the merge sentence of the pull request body', { error: message(err) });
  }
}

/** With claimReviews: what a revision posts just before its push, and then replaces with the reply (or with why it pushed nothing). */
export function renderRevisionClaim(o: { runId: string; review: RevisionRequest['review']; commitCount: number }): string {
  return withMarker(
    [
      `Updraft is pushing ${o.commitCount} commit(s) to this pull request for the changes requested by ${code(o.review.author)} in ${o.review.url}`,
      '',
      `From run ${code(o.runId)}. This comment is replaced by the result as soon as the push is done.`,
    ],
    revisionMarker(o.runId),
  );
}

/** With claimReviews: what is left of a claim whose push another run's got ahead of. One line, and no longer a claim. */
export function renderSupersededNote(o: { runId: string; review: RevisionRequest['review']; otherUrl: string }): string {
  return withMarker(
    [
      `Another Updraft run pushed for the changes requested by ${code(o.review.author)} in ${o.review.url} first (${o.otherUrl}). ` +
        `Run ${code(o.runId)} pushed nothing, and nothing on this pull request's branch was changed by it.`,
    ],
    revisionMarker(o.runId),
  );
}

/** The reply when the run succeeded without committing anything. */
export function renderNoChangeReply(o: { runId: string; agent: string; review: RevisionRequest['review']; summary: RunSummary; selection?: string; trigger?: RevisionRequest['trigger'] }): string {
  return withMarker(
    [
      `Updraft ran a revision for ${askedFor(o.review, o.trigger)}, but the agent made no commits, so nothing was pushed.`,
      ...(o.trigger === 'ci_failure' ? ['', 'The failed checks stay failed on this commit, and Updraft will not try again for it: fixing them is up to a person.'] : []),
      ...(o.trigger === 'suggestions' ? ['', 'Each suggestion is answered in its thread: declined with the reason, or deferred to a follow-up issue.'] : []),
      '',
      `From run ${code(o.runId)} (agent ${inline(o.agent)}).`,
      '',
      ...(o.selection ? [`<sub>${o.selection}</sub>`, ''] : []),
      "**The agent's final message**",
      '',
      safeMarkdown(o.summary.lastOutput.join('\n').trim() || '(no output)', MAX_FINAL_MESSAGE),
    ],
    revisionMarker(o.runId),
  );
}

/** The comment when the push was refused. Carries the worker's own words only: no agent output, no local paths. */
export function renderNotPushedNotice(o: { runId: string; review: RevisionRequest['review']; reason: string; localBranch: string; trigger?: RevisionRequest['trigger'] }): string {
  return withMarker(
    [
      `Updraft ran a revision for ${askedFor(o.review, o.trigger)}, but did not push it.`,
      '',
      '**Reason**',
      '',
      fenced(o.reason),
      '',
      `Nothing on this pull request's branch was changed, and the worker will not retry or rebase on its own. The run's commits are on ` +
        `the worker's machine (branch ${code(o.localBranch)}, run ${code(o.runId)}).`,
      '',
      o.trigger === 'ci_failure'
        ? 'Updraft will not fix the checks of this commit again by itself. A new commit on this branch gets a new review and new checks.'
        : o.trigger === 'suggestions'
          ? 'The commit the reviewer found ready is unchanged; its open suggestions go into a follow-up issue.'
          : 'To get a revision that builds on the current head, submit a new review that requests changes.',
    ],
    revisionMarker(o.runId),
  );
}

export function renderLimitNotice(o: { max: number; repoFullName: string }): string {
  return [
    `This pull request has reached its limit of ${o.max} automatic revision(s) (${code(`repositories.${o.repoFullName}.maxRevisions`)}).`,
    '',
    'Further change requests are recorded on the machine running the worker (`updraft status`) but are not acted on. ' +
      'From here the changes are up to a person: push to this branch, or raise the limit and submit a new review.',
    '',
    REVISION_LIMIT_MARKER,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

interface Eligible {
  run: Run & { summary: RunSummary };
  job: Job;
  request: RevisionRequest;
  repoFullName: string;
  repo: NonNullable<ReturnType<typeof findRepoConfig>>['repo'];
  checkoutPath: string;
}

function eligibility(deps: PublishDeps, runId: string): { ok: true; e: Eligible } | { ok: false; reason: string } {
  const run = getRun(deps.db, runId);
  if (!run) return { ok: false, reason: `run ${runId} not found` };
  const job = getJob(deps.db, run.jobId);
  if (!job) return { ok: false, reason: `job ${run.jobId} of run ${runId} not found` };
  const request = revisionOf(job);
  if (!request) return { ok: false, reason: `run ${runId} is not a revision run` };
  const found = findRepoConfig(deps.config, job);
  if (!found) return { ok: false, reason: `${job.repoFullName} is no longer configured` };
  if (!reviseActive(deps.config, found.repo)) {
    return {
      ok: false,
      reason:
        deps.config.execution.mode !== 'live'
          ? `revisions apply only in live mode (execution.mode is ${deps.config.execution.mode})`
          : `revisions are off for ${found.fullName} (set repositories.${found.fullName}.revise, together with publish)`,
    };
  }
  const action = ownEntry(deps.config.actions, job.action);
  if (!action || action.output !== 'local-branch') {
    return { ok: false, reason: `action "${job.action}" ${action ? `has output ${action.output}` : 'is no longer configured'}; only local-branch actions are revised` };
  }
  if (run.outcome !== 'succeeded') {
    return { ok: false, reason: `run ${runId} ${run.outcome ? `ended ${run.outcome}` : 'has not finished'}; only a succeeded revision run is pushed` };
  }
  if (!run.summary) return { ok: false, reason: `run ${runId} has no agent summary` };
  if (!found.repo.checkoutPath) return { ok: false, reason: `repositories.${found.fullName}.checkoutPath is not set` };
  return {
    ok: true,
    e: {
      run: run as Run & { summary: RunSummary },
      job,
      request,
      repoFullName: found.fullName,
      repo: found.repo,
      checkoutPath: resolve(deps.paths.configDir, found.repo.checkoutPath),
    },
  };
}

// ---------------------------------------------------------------------------
// The push and the reply
// ---------------------------------------------------------------------------

/**
 * Push one succeeded revision run to its PR and reply there, or resume doing so. Never throws for
 * push or GitHub problems: the result (and the revisions table) says what happened.
 *
 * Nothing is awaited before the revisions row exists. The worker calls this in the same turn in
 * which it closed the run, so no other job for the issue can be claimed in between: the next
 * revision of the PR waits (issuesAwaitingRevisionPush) and then starts from what was pushed.
 */
export async function reviseRun(deps: PublishDeps, runId: string, opts: { signal?: AbortSignal } = {}): Promise<ReviseResult> {
  const now = deps.now ?? Date.now;
  const check = eligibility(deps, runId);
  if (!check.ok) return { status: 'not-eligible', reason: check.reason };
  const { run, job, request, repoFullName, repo, checkoutPath } = check.e;
  const selectionOf = (r: typeof run) => selectionLine(runDetails(deps.db, job, r));
  const prNumber = request.pullRequest.number;
  const prBranch = request.pullRequest.branch;
  const baseSha = run.summary.baseSha;
  const repoRef = { id: job.repoId, fullName: repoFullName };
  const log = deps.log.child({ runId, repo: repoFullName, pr: prNumber });

  const begun = beginRevision(deps.db, {
    runId,
    jobId: job.id,
    repoId: job.repoId,
    repoFullName,
    issueNumber: job.issueNumber,
    prNumber,
    reviewId: request.review.id,
    trigger: request.trigger,
    branch: prBranch,
    baseSha,
    leaseSeconds: PUBLISH_LEASE_SECONDS,
    now,
  });
  if (!begun.ok) {
    const r = begun.revision;
    if (begun.reason === 'in-progress') {
      return { status: 'busy', reason: `the revision of run ${runId} is being pushed by another process (lease until ${r.leaseExpiresAt})` };
    }
    return r.state === 'published' ? { status: 'published', revision: r, already: true } : { status: 'skipped', reason: r.error ?? 'nothing to push', revision: r };
  }
  let rev = begun.revision;
  // This attempt's fence, as in publication: every state write and every external write checks it
  // still owns the row, so an attempt that outlived its lease can't act after a newer one took over.
  const fence = { attempt: rev.attempts, leaseSeconds: PUBLISH_LEASE_SECONDS, now };
  const attemptStarted = now();
  /** Before each external write: still the owner (renewing the lease), within the deadline, not stopping. */
  const hold = (progress: RevisionProgress = {}) => {
    holdRevision(deps.db, runId, fence, progress);
    rev = getRevision(deps.db, runId)!;
    if (now() - attemptStarted > PUBLISH_ATTEMPT_SECONDS * 1000) {
      throw new TransientError(`revision attempt ${fence.attempt} ran past its ${PUBLISH_ATTEMPT_SECONDS / 60}-minute deadline`);
    }
  };

  let token: string | null = null;
  const runLog = async (lines: string[]) => {
    if (!run.logPath) return;
    try {
      await appendFile(run.logPath, `${lines.map((l) => redactSecret(`revision: ${l}`, token)).join('\n')}\n`, 'utf8');
    } catch (err) {
      log.warn('could not write to run.log', { error: message(err) });
    }
  };
  const finish = (r: Parameters<typeof finishRevision>[3]) => {
    if (!finishRevision(deps.db, runId, fence.attempt, { ...r, now })) throw new RevisionSupersededError(runId, fence.attempt);
    return getRevision(deps.db, runId)!;
  };
  // Quiet notifications: a CI fix is said on the issue's status comment, not on the pull request,
  // so it posts no claim and no reply (only a refusal to push, which a person has to look at).
  // A suggestion revision likewise, and not even that: whatever becomes of it, the head the
  // reviewer found ready is merged and its suggestions answered in their threads (suggestions.ts).
  const silent = (request.trigger === 'ci_failure' || request.trigger === 'suggestions') && quietFor(deps.config, job);
  const mute = silent && request.trigger === 'suggestions';
  const claiming = deps.claimReviews === true && !silent;
  // ...and claims its push where no one sees it instead: a ref of its own on the remote
  // (revisionClaimRef), read the same way as a comment claim. One revision per review, still.
  const refClaiming = deps.claimReviews === true && silent;
  /** Deletes this run's claim ref, once it pushed one and then stepped aside. Best effort. */
  let dropClaim: (() => Promise<void>) | null = null;
  /**
   * The PR comment of this run: recorded, found by its marker, or new.
   *
   * With claimReviews the run has one comment that changes: first the claim, then the reply (or
   * why nothing was pushed). `claim` names the commit the comment says the branch is moved to;
   * the marker for it is what other runs read (findRevisionClaims).
   */
  /**
   * Who writes the coding agent's comments (publisher-role.ts): the pull request's publisher once
   * step 1 has checked it, the worker until then (a refusal before that is Updraft's own notice).
   */
  let codingApi: GitHubApi = deps.api;
  const comment = async (body: () => string, claim?: { headSha: string }): Promise<void> => {
    if (claiming) {
      hold();
      const marker = revisionMarker(runId);
      const text = claim ? `${body()}\n${revisionClaimMarker(request.review.id, baseSha, claim.headSha)}` : body();
      const id = rev.commentId ?? (await codingApi.listIssueComments(repoRef, prNumber)).find((c) => c.body.includes(marker))?.id ?? null;
      hold(); // the lookup may have outlived the lease
      const written = id !== null ? await codingApi.updateIssueComment(repoRef, id, text) : await codingApi.createIssueComment(repoRef, prNumber, text);
      hold({ commentId: written.id, commentUrl: written.htmlUrl });
      await runLog([`${id !== null ? 'updated the comment' : 'commented'} on pull request #${prNumber}: ${written.htmlUrl}`]);
      return;
    }
    if (rev.commentId) return;
    hold();
    const marker = revisionMarker(runId);
    const found = (await codingApi.listIssueComments(repoRef, prNumber)).find((c) => c.body.includes(marker));
    let posted: GitHubIssueComment | undefined = found;
    if (!posted) {
      hold(); // the lookup may have outlived the lease
      posted = await codingApi.createIssueComment(repoRef, prNumber, body());
    }
    hold({ commentId: posted.id, commentUrl: posted.htmlUrl });
    await runLog([found ? `comment already on pull request #${prNumber}: ${posted.htmlUrl}` : `commented on pull request #${prNumber}: ${posted.htmlUrl}`]);
  };

  await runLog([`attempt ${rev.attempts} at ${new Date(now()).toISOString()}: pull request #${prNumber}, branch ${prBranch}, started from ${short(baseSha)}`]);
  const scratchDir = mkdtempSync(join(tmpdir(), 'updraft-revision-'));
  try {
    const run1 = deps.runGit ?? defaultRunGit;
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(NETWORK_TIMEOUT_MS)]) : AbortSignal.timeout(NETWORK_TIMEOUT_MS);
    const local: GitOptions = { cwd: checkoutPath, git: deps.git };

    // 1. Which branch. Decided from the worker's own records before anything reaches the network.
    const watched: RevisionPr | null = getRevisionPr(deps.db, job.repoId, prNumber);
    if (!watched) throw new PublishRefusal(`pull request #${prNumber} is not one this worker published; refusing to push to it`);
    if (watched.branch !== prBranch) {
      throw new PublishRefusal(`pull request #${prNumber} was published from ${watched.branch}, not ${prBranch}; refusing to push to ${prBranch}`);
    }
    if (!isJobBranchName(prBranch)) throw new PublishRefusal(`${prBranch} is not a job branch; a revision is only ever pushed to the job branch of its pull request`);
    const localBranch = run.summary.branch;
    const expected = jobBranchName(job, run.attempt);
    if (localBranch !== expected) throw new PublishRefusal(`run ${runId} recorded branch ${localBranch}, not its own branch ${expected}; refusing to push it`);
    if (watched.state !== 'open') {
      const reason = `pull request #${prNumber} was closed or merged before the revision could be pushed`;
      const done = finish({ state: 'skipped', error: reason });
      await runLog([`skipped: ${reason}`]);
      log.info('revision not pushed', { reason });
      return { status: 'skipped', reason, revision: done };
    }

    // 1b. Who pushes: the publisher the pull request was opened with, checked again now. Never
    // another identity in its place (publisher-role.ts).
    const source = getPublication(deps.db, watched.sourceRunId);
    const role = await codingRole(deps, { repo: repoRef, config: repo, recorded: source?.publisher ?? null, started: true });
    if (role.record?.kind === 'user') await runLog([`pushing as ${role.record.login} (github.publisher, account ${role.record.id}), the publisher of pull request #${prNumber}, checked just now`]);
    codingApi = role.api;
    const pushDeps = { ...deps, token: role.token, workerKind: role.workerKind, httpsPush: role.httpsPush };

    // 2. The clone's remote and the run's commit.
    const { remote, pushUrl, net, localSha, commitCount, descends } = await withCheckoutLock(checkoutPath, async () => {
      const target = await openPushTarget(pushDeps, { checkoutPath, repoFullName, remote: repo.remote, scratchDir, signal, onToken: (t) => (token = t) });
      await assertValidBranchName(prBranch, local);
      const sha = (await run1(['rev-parse', '--verify', '--quiet', `refs/heads/${localBranch}^{commit}`], local).catch(() => null))?.stdout.trim();
      if (!sha) throw new PublishRefusal(`the revision branch ${localBranch} no longer exists in ${checkoutPath}`);
      // As for a first publication: push the commit the run ended on, or nothing.
      const ended = run.summary?.headSha;
      if (ended && sha !== ended) {
        throw new PublishRefusal(
          `the revision branch ${localBranch} is at ${sha.slice(0, 12)}, not at ${ended.slice(0, 12)} where run ${runId} ended; ` +
            'the branch was changed after the run, so its result and verification do not describe this commit. Nothing was pushed',
        );
      }
      const count = Number((await run1(['rev-list', '--count', `${baseSha}..${sha}`], local)).stdout.trim()) || 0;
      // Exit 1: not an ancestor. Anything else is a real failure and is thrown.
      const isAncestor = await run1(['merge-base', '--is-ancestor', baseSha, sha], local).then(
        () => true,
        (err: unknown) => {
          if (err instanceof GitError && err.exitCode === 1) return false;
          throw err;
        },
      );
      return { ...target, localSha: sha, commitCount: count, descends: isAncestor };
    });
    const protectedBranches = new Set([watched.baseBranch, repo.baseBranch, await remoteDefaultBranch(pushUrl, net, run1)].filter((b): b is string => Boolean(b)));
    if (protectedBranches.has(prBranch)) throw new PublishRefusal(`${prBranch} is the base or default branch of ${repoFullName}; refusing to push to it`);

    /**
     * With claimReviews: the claim of another run for this review that has been made good on, as
     * far as this run can tell: its head is where the branch is (`remoteSha`), or is in the
     * history this run started from. A claim whose push never came is nobody's.
     */
    const answeredElsewhere = async (remoteSha: string | null): Promise<RevisionClaim | null> => {
      if (!claiming && !refClaiming) return null;
      hold();
      const claims = claiming
        ? await findRevisionClaims(codingApi, repoRef, prNumber, request.review.id)
        : await findRefClaims(run1, pushUrl, net, request.review.id, repoFullName, prNumber);
      for (const c of claims) {
        if (c.runId === runId) continue;
        if (c.headSha === remoteSha || c.headSha === baseSha) return c;
        // Exit 1: not an ancestor; 128: a commit this clone never fetched, so not in the run's history either.
        if (await run1(['merge-base', '--is-ancestor', c.headSha, baseSha], local).then(() => true, () => false)) return c;
      }
      return null;
    };

    if (localSha === baseSha) {
      // 3a. Nothing to push; the reviewer is still owed an answer (one, from whichever run gets there first).
      const first = await answeredElsewhere(null);
      if (first) throw new Superseded(first);
      if (!mute) await comment(() => renderNoChangeReply({ runId, agent: run.agent, review: request.review, summary: run.summary, selection: selectionOf(run), trigger: request.trigger }), { headSha: baseSha });
      const reason = `the agent made no commits on top of ${short(baseSha)}; nothing was pushed`;
      const done = finish({ state: 'skipped', error: reason });
      await runLog([`skipped: ${reason}`]);
      log.info('revision not pushed', { reason });
      return { status: 'skipped', reason, revision: done };
    }
    if (!descends) {
      throw new NotPushed(
        `the revision branch ${localBranch} (${short(localSha)}) does not descend from ${short(baseSha)}, the head of ${prBranch} the run started from; ` +
          'pushing it would rewrite the pull request branch, so it was not pushed',
        `the run's result does not build on ${short(baseSha)}, the commit this branch was at when the run started (history was rewritten), so pushing it would not be a fast-forward`,
        false,
      );
    }

    // 3b. Fast-forward the PR branch, unless it already has exactly this commit.
    const remoteRef = `refs/heads/${prBranch}`;
    const readRemoteSha = async (): Promise<string | null> => {
      const listed = (await run1(['ls-remote', pushUrl, remoteRef], net)).stdout;
      return (
        listed
          .split(/\r?\n/)
          .map((l) => l.trim().split(/\s+/))
          .find(([, ref]) => ref === remoteRef)?.[0] ?? null
      );
    };
    const movedTo = (sha: string | null) =>
      new NotPushed(
        `${remoteRef} on ${remote} ${sha ? `is at ${short(sha)}` : 'no longer exists'}, not at ${short(baseSha)} where the run started; ` +
          'the branch moved, so the revision was not pushed and will not be retried',
        sha
          ? `this branch moved from ${short(baseSha)} to ${short(sha)} while the run was in progress (someone else pushed to it)`
          : 'this branch was deleted while the run was in progress',
        true,
      );
    hold();
    const remoteSha = await readRemoteSha();
    const first = await answeredElsewhere(remoteSha);
    if (first) throw new Superseded(first);
    if (remoteSha === localSha) {
      await runLog([`${remoteRef} is already on ${remote} at ${short(localSha)}`]);
    } else if (remoteSha !== baseSha) {
      throw movedTo(remoteSha);
    } else {
      // Said on the pull request before it is done, so that no run can build on this push without being able to see whose it is.
      if (claiming) await comment(() => renderRevisionClaim({ runId, review: request.review, commitCount }), { headSha: localSha });
      if (refClaiming) {
        // The run's own claim ref, before the push: a run that loses the branch's lease finds it.
        // A remote that refuses refs outside branches and tags (a ruleset, a pre-receive hook)
        // costs only the claim: the push goes on, and a lost race reads as the branch moving.
        hold();
        const own = revisionClaimRef(request.review.id, runId);
        try {
          await run1(['push', '--no-verify', '--recurse-submodules=no', '--porcelain', pushUrl, `+${localSha}:${own}`], net);
          dropClaim = async () => {
            await run1(['push', '--no-verify', '--porcelain', pushUrl, `:${own}`], net).catch(() => {});
          };
        } catch (err) {
          if (!(err instanceof GitError)) throw err;
          log.warn('the remote refused the revision\'s claim ref; pushing without it', { ref: own, error: redactSecret(err.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? err.message, token) });
          await runLog([`the remote refused the claim ref ${own}; pushing without it`]);
        }
      }
      await runLog([`pushing ${short(baseSha)}..${short(localSha)} (${commitCount} commit(s)) to ${prBranch} on ${remote} (${redactRemoteUrl(pushUrl)})`]);
      hold();
      try {
        // To the validated URL, from the isolated repository. No "+": the refspec does not ask
        // for a forced update. The lease names the one value the branch may have for the remote
        // to accept the push, so a branch that moved after the check above is left alone.
        await run1(
          ['push', '--no-verify', '--recurse-submodules=no', '--porcelain', `--force-with-lease=${remoteRef}:${baseSha}`, pushUrl, `${localSha}:${remoteRef}`],
          net,
        );
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        // Rejected, or the outcome is unknown: look again.
        const after = await readRemoteSha().catch(() => undefined);
        if (after === localSha) {
          await runLog([`${remoteRef} is already on ${remote} at ${short(localSha)} (pushed concurrently)`]);
        } else if (after === undefined || after === baseSha) {
          throw classifyGit(err, 'push', remote, repoFullName);
        } else {
          // The branch moved under the lease. To the head another run claimed for this review: that is the answer.
          const won = await answeredElsewhere(after);
          throw won ? new Superseded(won) : movedTo(after);
        }
      }
    }
    if (rev.headSha !== localSha || !rev.pushedAt) hold({ headSha: localSha, pushedAt: rev.pushedAt ?? new Date(now()).toISOString() });

    // 3b. Structured findings: the coding agent's report on each, now that its push is confirmed,
    // in each finding's thread. Best effort: the reply below carries what could not be put there.
    let perFinding: string[] = [];
    if (request.findings?.length) {
      hold();
      const answered = await answerFindings(
        { db: deps.db, api: codingApi, now, guard: () => hold(), repoFullName, runId },
        {
          repo: repoRef,
          prNumber,
          runId,
          sha: localSha,
          prUrl: request.pullRequest.url,
          // The coding agent's replies are the publisher's: its own earlier ones are found by that login.
          login: role.record?.kind === 'user' ? role.record.login : await workerLogin(deps.api),
          findings: request.findings,
          resolutions: run.summary.resolutions ?? [],
        },
      );
      perFinding = answered.lines;
      if (answered.log.length) await runLog(answered.log);
    }

    // 4. The PR body's merge sentence, for the new head and its own verification.
    const merge = mergePolicy(deps.config, repo, { mode: 'pr', verifies: Boolean(ownEntry(deps.config.actions, job.action)?.verify?.length), summary: { verification: run.summary.verification, headSha: localSha } });
    await restateMerge(deps, repoRef, prNumber, merge, log);
    // 5. The reply: recorded, found by marker, or new.
    if (!silent) await comment(() => renderRevisionReply({ runId, agent: run.agent, review: request.review, summary: run.summary, commitCount, perFinding, selection: selectionOf(run), trigger: request.trigger, pushed: { sha: localSha, url: commitUrl(request.pullRequest.url, localSha) }, merge }), { headSha: localSha });

    const done = finish({ state: 'published' });
    log.info('revision pushed', { pr: prNumber, from: baseSha, to: localSha });
    return { status: 'published', revision: done, already: false };
  } catch (caught) {
    let err = caught;
    if (err instanceof Superseded) {
      // Not a failure and not news for the pull request: the review has its revision. What this
      // run announced, if it got that far, is taken back; a failure to do so is retried like any.
      const { claim } = err;
      // Its own claim is nobody's answer now.
      await dropClaim?.();
      const reason = `${SUPERSEDED_PREFIX}another run answered this review first (${claim.url}${claim.runId ? `, run ${claim.runId}` : ''}, ${short(claim.baseSha)}..${short(claim.headSha)}); nothing was pushed`;
      try {
        if (rev.commentId) await comment(() => renderSupersededNote({ runId, review: request.review, otherUrl: claim.url }));
        const done = finish({ state: 'skipped', error: reason });
        await runLog([`skipped: ${reason}`]);
        log.info('revision not pushed', { reason });
        return { status: 'skipped', reason, revision: done };
      } catch (noteErr) {
        err = noteErr;
      }
    }
    if (err instanceof NotPushed) {
      await dropClaim?.();
      // Say so on the PR. If that fails for now, the whole attempt is retried: the branch check
      // above refuses again, and the comment gets another try.
      const refusal = err;
      try {
        hold({ moved: refusal.moved });
        if (!mute) await comment(() => renderNotPushedNotice({ runId, review: request.review, reason: refusal.notice, localBranch: run.summary.branch, trigger: request.trigger }));
      } catch (commentErr) {
        if (commentErr instanceof RevisionSupersededError) err = commentErr;
        else {
          const c = classifyFailure(commentErr, { repoFullName, runId, aborted: Boolean(opts.signal?.aborted) });
          const text = `${refusal.message}; the comment saying so could not be posted (${c.error})`;
          err = c.retryable ? new TransientError(text, c.retryAfter) : new PublishRefusal(text);
        }
      }
    }
    if (err instanceof RevisionSupersededError) {
      log.warn('revision attempt superseded', { attempt: fence.attempt });
      await runLog([`attempt ${fence.attempt} stopped: a newer attempt took over`]);
      return { status: 'busy', reason: err.message };
    }
    const classified = classifyFailure(err, { repoFullName, runId, aborted: Boolean(opts.signal?.aborted) });
    const { retryable, retryAfter } = classified;
    const error = redactSecret(classified.error, token).replace(/^publication was stopped/, 'the revision push was stopped');
    const attempts = rev.attempts;
    let nextAttemptAt: string | null = null;
    if (retryable && attempts < REVISION_MAX_AUTO_ATTEMPTS) {
      const backoff = retryAfter ?? Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** (attempts - 1));
      nextAttemptAt = new Date(now() + backoff * 1000).toISOString();
    }
    if (!finishRevision(deps.db, runId, fence.attempt, { state: 'failed', error, retryable, nextAttemptAt, now })) {
      log.warn('revision attempt superseded', { attempt: fence.attempt, error });
      return { status: 'busy', reason: new RevisionSupersededError(runId, fence.attempt).message };
    }
    if (claiming && rev.commentId && nextAttemptAt === null && !(caught instanceof NotPushed)) {
      // The push was announced and is not going to happen: the announcement must not stand.
      try {
        const reason = 'the push did not go through, and the worker will not try it again by itself';
        await codingApi.updateIssueComment(repoRef, rev.commentId, renderNotPushedNotice({ runId, review: request.review, reason, localBranch: run.summary.branch, trigger: request.trigger }));
      } catch (noteErr) {
        log.warn('could not take back the announcement of a push that failed', { error: message(noteErr) });
      }
    }
    const moved = caught instanceof NotPushed && caught.moved;
    const hint = nextAttemptAt
      ? `the worker retries at ${nextAttemptAt}; "updraft publish ${runId}" retries now`
      : caught instanceof NotPushed
        ? 'not retried; a new review requesting changes starts a revision from the current head'
        : `fix the cause, then run "updraft publish ${runId}"`;
    await runLog([`failed: ${error}`, hint]);
    log.warn('revision not pushed', { error, retryable, attempts, moved });
    try {
      recordError(deps.db, { scope: 'revision', repoFullName, jobId: job.id, message: `run ${runId}: ${error} (${hint})`, at: new Date(now()).toISOString() });
    } catch {
      // the revisions row already holds the error
    }
    return { status: 'failed', error, retryable, moved, revision: getRevision(deps.db, runId)! };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The comment that says a PR reached maxRevisions
// ---------------------------------------------------------------------------

/**
 * Post the one limit comment on each PR that reached maxRevisions and has none yet. Only the
 * worker calls this (after a poll), and it looks for the marker before posting, so a PR gets one
 * comment however often this runs. Never throws.
 */
export async function postLimitNotices(deps: Pick<PublishDeps, 'db' | 'config' | 'api' | 'log' | 'now' | 'scope'>, signal?: AbortSignal): Promise<void> {
  let pending: RevisionPr[];
  try {
    pending = listPendingLimitNotices(deps.db, REVISION_MAX_AUTO_ATTEMPTS).filter((pr) => deps.scope?.pr(pr.repoId, pr.prNumber) ?? true);
  } catch (err) {
    deps.log.error('could not list pull requests that reached maxRevisions', { error: message(err) });
    return;
  }
  for (const pr of pending) {
    if (signal?.aborted) return;
    const found = findRepoConfig(deps.config, { repoId: pr.repoId, repoFullName: '' });
    if (!found || !reviseActive(deps.config, found.repo)) continue;
    const repoRef = { id: pr.repoId, fullName: found.fullName };
    try {
      const existing = (await deps.api.listIssueComments(repoRef, pr.prNumber)).find((c) => c.body.includes(REVISION_LIMIT_MARKER));
      const posted =
        existing ??
        (await deps.api.createIssueComment(repoRef, pr.prNumber, renderLimitNotice({ max: found.repo.maxRevisions ?? DEFAULT_MAX_REVISIONS, repoFullName: found.fullName })));
      recordLimitNotice(deps.db, pr.repoId, pr.prNumber, { commentId: posted.id, commentUrl: posted.htmlUrl }, deps.now);
      deps.log.info('commented that the pull request reached maxRevisions', { repo: found.fullName, pr: pr.prNumber, comment: posted.htmlUrl });
    } catch (err) {
      const detail = err instanceof GitHubError ? err.message : message(err);
      deps.log.warn('could not comment that the pull request reached maxRevisions', { repo: found.fullName, pr: pr.prNumber, error: detail });
      try {
        recordLimitNotice(deps.db, pr.repoId, pr.prNumber, { error: detail }, deps.now);
      } catch {
        // tried again after the next poll
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------

/**
 * The worker's publisher when the revision loop is on: a revision run goes to reviseRun, every
 * other run to `inner` (publication, when that is on). After each poll it also retries revision
 * pushes that are due and posts pending limit comments.
 */
export function createRevisionPublisher(deps: PublishDeps, inner?: Publisher): Publisher {
  const revise = async (runId: string, signal?: AbortSignal) => {
    try {
      const r = await reviseRun(deps, runId, { signal });
      if (r.status === 'not-eligible') deps.log.debug('revision run not pushed', { runId, reason: r.reason });
    } catch (err) {
      deps.log.error('revision push crashed', { runId, error: message(err) });
    }
  };
  const isRevisionRun = (runId: string): boolean => {
    try {
      const run = getRun(deps.db, runId);
      const job = run ? getJob(deps.db, run.jobId) : null;
      return job !== null && revisionOf(job) !== null;
    } catch {
      return false;
    }
  };
  return {
    // Not an async function: reviseRun must create its row before this returns to the worker.
    afterRun: (runId, signal) => (isRevisionRun(runId) ? revise(runId, signal) : (inner?.afterRun(runId, signal) ?? Promise.resolve())),
    // First publications only: a revision's push has its own record and its own retries.
    async sweepUnpublished(signal, opts) {
      await inner?.sweepUnpublished(signal, opts);
    },
    async retryDue(signal) {
      await inner?.retryDue(signal);
      let due: string[];
      try {
        due = listDueRevisions(deps.db, { now: deps.now }).filter((id) => deps.scope?.run(id) ?? true);
      } catch (err) {
        deps.log.error('could not list revisions to retry', { error: message(err) });
        return;
      }
      for (const runId of due) {
        if (signal?.aborted) return;
        await revise(runId, signal);
      }
      if (!signal?.aborted) await postLimitNotices(deps, signal);
    },
  };
}

/** True when the revision loop is on for any repository. */
export function revisionsEnabled(config: UpdraftConfig): boolean {
  return Object.values(config.repositories).some((r) => reviseActive(config, r));
}
