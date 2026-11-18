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
import { GitHubError, type GitHubIssueComment } from '../github/api.js';
import { revisionOf, type Job, type Revision, type RevisionRequest, type Run, type RunSummary } from '../types.js';
import { findRepoConfig } from '../worker/executor.js';
import { code } from './failure-comment.js';
import { safeMarkdown } from './markdown.js';
import {
  cap,
  classifyFailure,
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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string) => sha.slice(0, 12);

// ---------------------------------------------------------------------------
// Comment text
// ---------------------------------------------------------------------------

function withMarker(lines: string[], marker: string): string {
  return `${cap(lines.join('\n'), MAX_BODY - marker.length - 2)}\n\n${marker}`;
}

/** The reply after a push: the new commits, the verification result and the agent's final message, all inert. */
export function renderRevisionReply(o: { runId: string; agent: string; review: RevisionRequest['review']; summary: RunSummary; commitCount: number }): string {
  return withMarker(
    [
      `Updraft pushed ${o.commitCount} commit(s) to this pull request for the changes requested by ${code(o.review.author)} in ${o.review.url}`,
      '',
      `From run ${code(o.runId)} (agent ${inline(o.agent)}). Review it before merging; merging is up to a person.`,
      '',
      ...renderRunResult(o.summary, o.commitCount),
    ],
    revisionMarker(o.runId),
  );
}

/** The reply when the run succeeded without committing anything. */
export function renderNoChangeReply(o: { runId: string; agent: string; review: RevisionRequest['review']; summary: RunSummary }): string {
  return withMarker(
    [
      `Updraft ran a revision for the changes requested by ${code(o.review.author)} in ${o.review.url}, but the agent made no commits, so nothing was pushed.`,
      '',
      `From run ${code(o.runId)} (agent ${inline(o.agent)}).`,
      '',
      "**The agent's final message**",
      '',
      safeMarkdown(o.summary.lastOutput.join('\n').trim() || '(no output)', MAX_FINAL_MESSAGE),
    ],
    revisionMarker(o.runId),
  );
}

/** The comment when the push was refused. Carries the worker's own words only: no agent output, no local paths. */
export function renderNotPushedNotice(o: { runId: string; review: RevisionRequest['review']; reason: string; localBranch: string }): string {
  return withMarker(
    [
      `Updraft ran a revision for the changes requested by ${code(o.review.author)} in ${o.review.url}, but did not push it.`,
      '',
      '**Reason**',
      '',
      fenced(o.reason),
      '',
      `Nothing on this pull request's branch was changed, and the worker will not retry or rebase on its own. The run's commits are on ` +
        `the worker's machine (branch ${code(o.localBranch)}, run ${code(o.runId)}).`,
      '',
      'To get a revision that builds on the current head, submit a new review that requests changes.',
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
  /** The PR comment of this run: recorded, found by its marker, or new. */
  const comment = async (body: () => string): Promise<void> => {
    if (rev.commentId) return;
    hold();
    const marker = revisionMarker(runId);
    const found = (await deps.api.listIssueComments(repoRef, prNumber)).find((c) => c.body.includes(marker));
    let posted: GitHubIssueComment | undefined = found;
    if (!posted) {
      hold(); // the lookup may have outlived the lease
      posted = await deps.api.createIssueComment(repoRef, prNumber, body());
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

    // 2. The clone's remote and the run's commit.
    const { remote, pushUrl, net, localSha, commitCount, descends } = await withCheckoutLock(checkoutPath, async () => {
      const target = await openPushTarget(deps, { checkoutPath, repoFullName, remote: repo.remote, scratchDir, signal, onToken: (t) => (token = t) });
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
    const protectedBranches = new Set([watched.baseBranch, repo.baseBranch, await remoteDefaultBranch(pushUrl, net)].filter((b): b is string => Boolean(b)));
    if (protectedBranches.has(prBranch)) throw new PublishRefusal(`${prBranch} is the base or default branch of ${repoFullName}; refusing to push to it`);

    if (localSha === baseSha) {
      // 3a. Nothing to push; the reviewer is still owed an answer.
      await comment(() => renderNoChangeReply({ runId, agent: run.agent, review: request.review, summary: run.summary }));
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
    if (remoteSha === localSha) {
      await runLog([`${remoteRef} is already on ${remote} at ${short(localSha)}`]);
    } else if (remoteSha !== baseSha) {
      throw movedTo(remoteSha);
    } else {
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
          throw movedTo(after);
        }
      }
    }
    if (rev.headSha !== localSha || !rev.pushedAt) hold({ headSha: localSha, pushedAt: rev.pushedAt ?? new Date(now()).toISOString() });

    // 4. The reply: recorded, found by marker, or new.
    await comment(() => renderRevisionReply({ runId, agent: run.agent, review: request.review, summary: run.summary, commitCount }));

    const done = finish({ state: 'published' });
    log.info('revision pushed', { pr: prNumber, from: baseSha, to: localSha });
    return { status: 'published', revision: done, already: false };
  } catch (caught) {
    let err = caught;
    if (err instanceof NotPushed) {
      // Say so on the PR. If that fails for now, the whole attempt is retried: the branch check
      // above refuses again, and the comment gets another try.
      const refusal = err;
      try {
        hold({ moved: refusal.moved });
        await comment(() => renderNotPushedNotice({ runId, review: request.review, reason: refusal.notice, localBranch: run.summary.branch }));
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
export async function postLimitNotices(deps: Pick<PublishDeps, 'db' | 'config' | 'api' | 'log' | 'now'>, signal?: AbortSignal): Promise<void> {
  let pending: RevisionPr[];
  try {
    pending = listPendingLimitNotices(deps.db, REVISION_MAX_AUTO_ATTEMPTS);
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
        due = listDueRevisions(deps.db, { now: deps.now });
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
