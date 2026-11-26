// Auto-merge (repositories.<repo>.autoMerge; off unless set): the one place the worker merges a
// pull request. Read docs/review-loop.md before changing anything here: the issue text and the
// code under review are untrusted, the reviewer that found the PR ready is an agent that read
// both, and a merge cannot be taken back.
//
// After each poll, for every open PR whose newest verdict is ready-to-merge for its current head,
// every gate below is evaluated again until the merge settles one way or the other:
//   1. the code run that pushed that head passed the action's verify commands (or it has none);
//   2. on GitHub the PR is open, not a draft, still at that head, and its base is the branch it
//      was opened against;
//   3. GitHub does not report it unmergeable (conflicts);
//   4. no allowed actor has a "Request changes" review outstanding;
//   5. no commit status or check run of that head is failing, and none is pending. No checks at
//      all counts as passing. Pending ones (and mergeability GitHub is still computing) are
//      waited for, up to autoMergeWaitMinutes.
// Then one `PUT .../merge` with the head's SHA and the configured method: GitHub refuses it if
// anything was pushed since, and applies branch protection itself. A gate that fails, a wait
// that runs out or a refused merge is final for that head: the reason is recorded, one comment
// says so, and the PR stays ready for a person. Nothing is forced, bypassed or retried, and no
// branch is deleted.
import { allowedActorsFor, autoMergeMethod, ciSettings, DEFAULT_AUTO_MERGE_WAIT_MINUTES, workflowId, type MergeMethod, type RepositoryConfig } from '../config/schema.js';
import {
  codeRunForHead,
  getLoopPr,
  listMergeCandidates,
  listPendingMergeNotices,
  observeHead,
  recordMergeNotice,
  setMergeState,
  startMergeFor,
  type LoopPr,
} from '../db/pr-reviews.js';
import { getRun, ownEntry } from '../db/queue.js';
import type { MergeBlockCode } from '../db/metrics.js';
import { closeRevisionPr } from '../db/revisions.js';
import { GitHubError, type PullRequestReviewSummary } from '../github/api.js';
import { sameLogin, workerLogin } from '../github/identity.js';
import type { RepoRef } from '../types.js';
import { findRepoConfig } from '../worker/executor.js';
import { code } from './failure-comment.js';
import { cap, fenced, inline, type PublishDeps } from './publish.js';
import { consoleWorkflowUrl } from './console-link.js';
import { noteStatus, quietFor } from './status-comment.js';
import { STATUS_STAGE } from './status-marker.js';

type MergeDeps = Pick<PublishDeps, 'db' | 'config' | 'api' | 'log' | 'now' | 'scope' | 'console'>;

/** Merge requests sent for one head before an unknown result (network error, 5xx) is given up on. */
export const MAX_MERGE_ATTEMPTS = 3;
/** Attempts to post the comment that says why a PR was not merged. */
export const MAX_NOTICE_ATTEMPTS = 5;
const MAX_NAMES = 8;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string) => sha.slice(0, 12);
const isTransient = (err: unknown) => err instanceof GitHubError && (err.status === 0 || err.status >= 500 || err.isRateLimit);

function names(list: readonly string[]): string {
  const shown = list.slice(0, MAX_NAMES).join(', ');
  return list.length > MAX_NAMES ? `${shown} and ${list.length - MAX_NAMES} more` : shown;
}

/** Hidden marker on the one comment that says a head was not merged. */
export function mergeBlockedMarker(sha: string): string {
  return `<!-- updraft-merge-blocked: ${sha} -->`;
}

export function renderMergeBlockedNotice(o: { sha: string; method: MergeMethod; reason: string; repoFullName: string }): string {
  return [
    `Updraft's reviewer found commit ${code(short(o.sha))} ready to merge, but Updraft did not merge it (${code(`repositories.${o.repoFullName}.autoMerge: ${o.method}`)}).`,
    '',
    '**Reason**',
    '',
    fenced(cap(o.reason, 2_000)),
    '',
    'It will not try again for this commit. Merging is up to a person from here; a new commit on this branch gets a new review.',
    '',
    mergeBlockedMarker(o.sha),
  ].join('\n');
}

/**
 * Quiet notifications: the same notice as one or two plain sentences, with what to do and, when
 * hosted, the console link.
 */
export function renderQuietMergeBlockedNotice(o: { sha: string; prNumber: number; reason: string; link?: string | null }): string {
  return [
    `Updraft did not merge PR #${o.prNumber} at ${code(short(o.sha))}: ${inline(cap(o.reason, 500))}. ` +
      `Please merge it yourself once it is ready; a new commit on the branch gets a new review.${o.link ? ` [View this work in Updraft](${o.link})` : ''}`,
    '',
    mergeBlockedMarker(o.sha),
  ].join('\n');
}

/** "after CI fix N" for a status line, when the CI step fixed the pull request. */
const afterFixes = (n: number) => (n > 0 ? ` after CI fix ${n}` : '');

/**
 * Allowed actors whose newest decisive review is "Request changes". A later approval or a
 * dismissal by the same person clears it; a plain comment does not.
 */
export function outstandingChangeRequests(reviews: readonly PullRequestReviewSummary[], allowedActors: readonly string[]): string[] {
  const latest = new Map<string, { state: string; at: number; index: number }>();
  reviews.forEach((r, index) => {
    if (!r.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) return;
    const key = r.user.toLowerCase();
    const at = Date.parse(r.submittedAt ?? '') || 0;
    const seen = latest.get(key);
    if (!seen || at > seen.at || (at === seen.at && index > seen.index)) latest.set(key, { state: r.state, at, index });
  });
  return allowedActors.filter((a) => latest.get(a.toLowerCase())?.state === 'CHANGES_REQUESTED');
}

type Gate = { action: 'merge' } | { action: 'wait'; reason: string } | { action: 'block'; reason: string; code: MergeBlockCode } | { action: 'none' };

/**
 * Evaluate every gate for the merge of `pr` at `sha`. Makes up to four requests, cheapest
 * conclusions first. Throws GitHubError for a read that failed.
 */
async function gates(deps: MergeDeps, repo: RepoRef, cfg: RepositoryConfig, pr: LoopPr, sha: string): Promise<Gate> {
  const { db, config, api } = deps;
  const now = deps.now ?? Date.now;
  const block = (code: MergeBlockCode, reason: string): Gate => ({ action: 'block', reason, code });

  // 1. The worker's own check of the commit.
  const action = ownEntry(config.actions, pr.action);
  if (!action) return block('config', `action "${pr.action}" is no longer configured, so it is unknown which verify commands apply`);
  if (action.verify?.length) {
    const runId = codeRunForHead(db, pr.repoId, pr.prNumber, sha);
    if (!runId) return block('not-verified', `${short(sha)} was not pushed by an Updraft run, so the verify commands of action "${pr.action}" never ran on it`);
    const run = getRun(db, runId);
    if (run?.outcome !== 'succeeded' || run.summary?.verification?.passed !== true) {
      return block('not-verified', `there is no record that the verify commands passed in run ${runId}, which pushed ${short(sha)}`);
    }
    // A pass counts for this commit only if the commands tested exactly it.
    const v = run.summary.verification;
    if (v.sha !== sha) {
      return block('not-verified', `the verify commands of run ${runId} ran on ${v.sha ? short(v.sha) : 'an unrecorded commit'}, not on ${short(sha)}, the commit to merge`);
    }
    if (v.exact !== true) {
      return block(
        'not-verified',
        `the verify commands of run ${runId} passed, but not on exactly ${short(sha)}: the worktree held uncommitted files, or its commit changed, while they ran`,
      );
    }
  }
  const wf = cfg.workflows.find((w) => workflowId(w) === pr.workflowId);
  if (!wf) return block('config', `workflow "${pr.workflowId}" no longer exists in the config, so nobody's change requests could be honoured`);

  // 2. The pull request as it is on GitHub now.
  const readAt = new Date(now()).toISOString();
  const live = await api.getPullRequest(repo, pr.prNumber);
  if (live.merged) {
    if (pr.mergeState === 'merging') setMergeState(db, pr.repoId, pr.prNumber, sha, { state: 'merged', mergeCommitSha: null }, now);
    return { action: 'none' };
  }
  if (live.state !== 'open') return { action: 'none' };
  if (live.headSha !== sha) {
    // Stale: the verdict is for a commit that is no longer the head. Not a refusal worth a
    // comment; the new head gets its own review.
    observeHead(db, pr.repoId, pr.prNumber, live.headSha, readAt);
    deps.log.info('not merging: the pull request moved on from the reviewed commit', { repo: repo.fullName, pr: pr.prNumber, reviewed: sha, head: live.headSha });
    return { action: 'none' };
  }
  if (pr.mergeState === 'merging' && pr.mergeAttempts >= MAX_MERGE_ATTEMPTS) {
    return block('no-answer', `the merge was requested ${pr.mergeAttempts} times without an answer from GitHub, and the pull request is still open`);
  }
  if (!pr.baseBranch) return block('base-changed', 'the branch this pull request was opened against is not on record');
  if (live.baseRef !== pr.baseBranch) return block('base-changed', `its base branch is now ${live.baseRef}, not ${pr.baseBranch}, which it was opened against`);
  if (live.draft) return block('draft', 'it is still a draft');
  if (live.mergeable === false) return block('unmergeable', `GitHub reports that it cannot be merged as it is (${live.mergeableState}); it probably conflicts with ${live.baseRef}`);

  // 3. People.
  const outstanding = outstandingChangeRequests(await api.listPullRequestReviews(repo, pr.prNumber), allowedActorsFor(config, wf));
  if (outstanding.length) {
    return block('changes-requested', `a "Request changes" review by ${names(outstanding)} is outstanding; it has to be approved or dismissed by a person`);
  }

  // 4. Checks.
  const checks = await api.getCommitChecks(repo, sha);
  if (checks.failing.length) return block('checks-failed', `${checks.failing.length} check(s) of ${short(sha)} did not pass: ${names(checks.failing)}`);
  // Checked after failing (a failure seen is a failure) and before anything is read as green.
  if (!checks.complete) return block('checks-unreadable', `the checks of ${short(sha)} could not all be read (${checks.total} seen), so it is unknown whether they passed`);
  // The worker's own verify commands ran in the worktree the agent left, where ignored files
  // (build output from an earlier step) can make a test pass that would fail on the commit
  // alone. So a merge also needs a check GitHub ran itself, on a checkout of its own, to have
  // reported success: one that was skipped or ended neutral ran no tests and proves nothing.
  // With autoMergeRequiredChecks, each named check must be among the successes.
  if (checks.pending.length) return { action: 'wait', reason: `${checks.pending.length} check(s) of ${short(sha)} are pending: ${names(checks.pending)}` };
  const required = cfg.autoMergeRequiredChecks;
  const missing = required ? required.filter((name) => !checks.succeeded.includes(name)) : [];
  if (required ? missing.length > 0 : checks.succeeded.length === 0) {
    const what = required
      ? `required check(s) have not reported success on ${short(sha)}: ${names(missing)}`
      : `no check has reported success on ${short(sha)}; auto-merge needs at least one GitHub check (CI run independently of the worker) to pass on it`;
    // Waited for like a pending check, up to autoMergeWaitMinutes: CI often registers a moment
    // after the push, and the check that will pass may come from a workflow that starts later
    // than one whose job was skipped. Checks seen so far that were skipped or neutral say so.
    const seen = checks.total > 0 ? ` (${checks.total} check(s) finished, none of them failing; skipped and neutral results do not count as a pass)` : '';
    return { action: 'wait', reason: `${what}${seen}` };
  }
  if (live.mergeable === null) return { action: 'wait', reason: 'GitHub has not finished working out whether it can be merged' };
  return { action: 'merge' };
}

/** Take the auto-merge step for one PR. Never throws. */
export async function evaluateAutoMerge(deps: MergeDeps, repo: RepoRef, cfg: RepositoryConfig, candidate: LoopPr): Promise<void> {
  const { db, api } = deps;
  const now = deps.now ?? Date.now;
  const method = autoMergeMethod(deps.config, cfg);
  const sha = candidate.headSha;
  if (!method || !sha) return;
  const log = deps.log.child({ repo: repo.fullName, pr: candidate.prNumber, head: sha });
  try {
    startMergeFor(db, candidate.repoId, candidate.prNumber, sha, now);
    const pr = getLoopPr(db, candidate.repoId, candidate.prNumber);
    if (!pr || pr.state !== 'open' || pr.verdict !== 'ready-to-merge' || pr.verdictSha !== sha || pr.headSha !== sha) return;
    if (pr.mergeState === 'merged' || pr.mergeState === 'blocked') return;
    const blocked = (code: MergeBlockCode, reason: string) => {
      if (setMergeState(db, pr.repoId, pr.prNumber, sha, { state: 'blocked', reason, code }, now)) log.warn('not merged; left for a person', { reason });
    };

    let gate: Gate;
    try {
      gate = await gates(deps, repo, cfg, pr, sha);
    } catch (err) {
      if (isTransient(err)) {
        log.warn('could not evaluate the merge for now', { error: message(err) });
        return;
      }
      blocked('github-error', `GitHub could not be asked what the merge needs to know: ${message(err)}`);
      return;
    }
    if (gate.action === 'none') return;
    if (gate.action === 'block') return blocked(gate.code, gate.reason);
    if (gate.action === 'wait') {
      const waitMinutes = cfg.autoMergeWaitMinutes ?? DEFAULT_AUTO_MERGE_WAIT_MINUTES;
      const since = pr.mergeWaitStartedAt ? Date.parse(pr.mergeWaitStartedAt) : now();
      if (now() - since >= waitMinutes * 60_000) return blocked('wait-timeout', `gave up after waiting ${waitMinutes} minute(s): ${gate.reason}`);
      setMergeState(db, pr.repoId, pr.prNumber, sha, { state: 'waiting', reason: gate.reason }, now);
      log.info('waiting before merging', { reason: gate.reason });
      return;
    }

    // Recorded before the request: if the answer is lost, the next cycle finds out from GitHub
    // whether it merged instead of assuming either way.
    if (!setMergeState(db, pr.repoId, pr.prNumber, sha, { state: 'merging' }, now)) return;
    try {
      const res = await api.mergePullRequest(repo, pr.prNumber, { sha, method });
      if (!res.merged) return blocked('merge-refused', `GitHub did not merge it: ${res.message || 'no reason given'}`);
      setMergeState(db, pr.repoId, pr.prNumber, sha, { state: 'merged', mergeCommitSha: res.sha }, now);
      // Stop watching it now rather than at the next poll, so nothing more is queued for it.
      closeRevisionPr(db, pr.repoId, pr.prNumber, `pull request #${pr.prNumber} was merged by Updraft`, now);
      log.info('merged', { method, mergeCommit: res.sha });
      if (quietFor(deps.config, { repoId: pr.repoId, repoFullName: repo.fullName })) {
        await noteStatus(
          { api, log },
          { repo, issue: pr.issueNumber, target: { pr: pr.prNumber }, stage: STATUS_STAGE.final, title: 'Merged', text: `PR #${pr.prNumber} was merged${afterFixes(pr.ciFixes)}.` },
        );
      }
    } catch (err) {
      if (isTransient(err)) {
        log.warn('the merge request got no answer; checking again after the next poll', { error: message(err) });
        return;
      }
      const status = err instanceof GitHubError ? ` (${err.status})` : '';
      blocked('merge-refused', `GitHub refused the merge${status}: ${message(err)}`);
    }
  } catch (err) {
    log.error('auto-merge step crashed', { error: message(err) });
  }
}

/** The auto-merge step for every repository that has it on. Never throws. */
export async function evaluateAutoMerges(deps: MergeDeps, signal?: AbortSignal): Promise<void> {
  for (const [fullName, cfg] of Object.entries(deps.config.repositories)) {
    if (!autoMergeMethod(deps.config, cfg)) continue;
    let candidates: LoopPr[];
    try {
      candidates = listMergeCandidates(deps.db, cfg.id, { requireCi: ciSettings(deps.config, cfg) !== null }).filter((pr) => deps.scope?.pr(pr.repoId, pr.prNumber) ?? true);
    } catch (err) {
      deps.log.error('could not list pull requests to merge', { repo: fullName, error: message(err) });
      continue;
    }
    for (const pr of candidates) {
      if (signal?.aborted) return;
      await evaluateAutoMerge(deps, { id: cfg.id, fullName }, cfg, pr);
    }
  }
}

/**
 * Post the one comment on each PR whose merge was blocked and has none yet for that head. Only
 * the worker calls this (after a poll), and it looks for the marker among its own comments before
 * posting, so a head gets one comment however often this runs. Never throws.
 */
export async function postMergeNotices(deps: MergeDeps, signal?: AbortSignal): Promise<void> {
  let pending: LoopPr[];
  try {
    pending = listPendingMergeNotices(deps.db, MAX_NOTICE_ATTEMPTS).filter((pr) => deps.scope?.pr(pr.repoId, pr.prNumber) ?? true);
  } catch (err) {
    deps.log.error('could not list pull requests whose merge was blocked', { error: message(err) });
    return;
  }
  for (const pr of pending) {
    if (signal?.aborted) return;
    const found = findRepoConfig(deps.config, { repoId: pr.repoId, repoFullName: '' });
    const method = found ? autoMergeMethod(deps.config, found.repo) : null;
    const sha = pr.mergeSha;
    if (!found || !method || !sha) continue;
    const repoRef = { id: pr.repoId, fullName: found.fullName };
    try {
      const login = await workerLogin(deps.api);
      const marker = mergeBlockedMarker(sha);
      const existing = (await deps.api.listIssueComments(repoRef, pr.prNumber)).find((c) => c.body.includes(marker) && sameLogin(c.user, login));
      const quiet = quietFor(deps.config, { repoId: pr.repoId, repoFullName: found.fullName });
      const reason = pr.mergeReason ?? 'no reason was recorded';
      const posted =
        existing ??
        (await deps.api.createIssueComment(
          repoRef,
          pr.prNumber,
          quiet
            ? renderQuietMergeBlockedNotice({ sha, prNumber: pr.prNumber, reason, link: consoleWorkflowUrl(deps.console, pr.repoId, pr.issueNumber) })
            : renderMergeBlockedNotice({ sha, method, reason, repoFullName: found.fullName }),
        ));
      if (quiet) {
        await noteStatus(
          { api: deps.api, log: deps.log },
          { repo: repoRef, issue: pr.issueNumber, target: { pr: pr.prNumber }, stage: STATUS_STAGE.person, sha, latest: pr.headSha === sha, title: 'Waiting for a person', text: `PR #${pr.prNumber} is ready for a person to merge; Updraft did not merge it (see the PR).` },
        );
      }
      recordMergeNotice(deps.db, pr.repoId, pr.prNumber, sha, { commentId: posted.id, commentUrl: posted.htmlUrl }, deps.now);
      deps.log.info('commented that the pull request was not merged', { repo: found.fullName, pr: pr.prNumber, comment: posted.htmlUrl });
    } catch (err) {
      const detail = message(err);
      deps.log.warn('could not comment that the pull request was not merged', { repo: found.fullName, pr: pr.prNumber, error: detail });
      try {
        recordMergeNotice(deps.db, pr.repoId, pr.prNumber, sha, { error: detail }, deps.now);
      } catch {
        // tried again after the next poll
      }
    }
  }
}
