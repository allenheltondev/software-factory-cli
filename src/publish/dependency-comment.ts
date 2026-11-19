// The comments of a wait on another repository's pull request (docs/dependencies.md), on the issue
// the waiting run was for: one when the wait starts ("waiting on OWNER/REPO#N") and, when the wait
// ends without a follow-up (closed unmerged, unreadable, expired), the failure comment rendered by
// failure-comment.ts. A merge needs no comment of its own: the follow-up run's assignment comment
// says the issue is being worked on again.
//
// Same rules as the other comments: only what the worker itself knows (no agent output, no pull
// request title), idempotent by a hidden marker carrying the run id that is searched for before
// every write, and what was posted is recorded on the wait's row. Never changes a run or a wait.
import { dependencyRef, recordWaitComment, WAIT_COMMENT_MAX_ATTEMPTS, type DependencyWait } from '../db/dependency-waits.js';
import { recordError, type Db } from '../db/database.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { GitHubAppError } from '../github/app-auth.js';
import type { Logger } from '../util/log.js';
import { code, COMMENT_SCOPES_HINT, dependencyEndedMarker, renderDependencyEndedComment } from './failure-comment.js';

/** Hidden marker on the "waiting" comment; finds it again on a retry. */
export function dependencyWaitMarker(runId: string): string {
  return `<!-- updraft-waiting: ${runId} -->`;
}

/** "every <this>": minute, 5 minutes, hour, 2 hours. */
function interval(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m === 1) return 'minute';
  if (m % 60 === 0) return m === 60 ? 'hour' : `${m / 60} hours`;
  return `${m} minutes`;
}

function days(ms: number): string {
  const d = Math.round((ms / 86_400_000) * 10) / 10;
  return d === 1 ? '1 day' : `${d} days`;
}

export function renderWaitComment(o: {
  runId: string;
  jobId: string;
  agent: string;
  /** OWNER/REPO#N, validated against the config. */
  dependency: string;
  url: string;
  checkIntervalMs: number;
  maxWaitMs: number;
  triggerLabel: string;
}): string {
  return [
    `Updraft is waiting on ${o.dependency} before it continues with this issue.`,
    '',
    `Run ${code(o.runId)} (agent ${code(o.agent)}) found that this issue needs that pull request first: ${o.url}. ` +
      'Nothing from that run was published.',
    '',
    `The worker checks the pull request every ${interval(o.checkIntervalMs)} and runs this issue again once it is merged. ` +
      `If it is closed without being merged, or is still open after ${days(o.maxWaitMs)}, the worker stops waiting and says so here.`,
    '',
    `To stop waiting, remove the ${code(o.triggerLabel)} label from this issue, or run ${code(`updraft cancel ${o.jobId}`)} on the machine running the worker.`,
    '',
    dependencyWaitMarker(o.runId),
  ].join('\n');
}

export interface WaitCommentDeps {
  db: Db;
  api: GitHubApi;
  log: Logger;
  now: () => number;
}

/** Whether an error is worth trying again later, and what to record. */
function classify(err: unknown, where: string): { error: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GitHubAppError) return { error: message, retryable: false };
  if (err instanceof GitHubError) {
    if (err.status === 0 || err.status >= 500 || err.isRateLimit) return { error: `GitHub is unavailable for now: ${message}`, retryable: true };
    if ([401, 403, 404, 410].includes(err.status)) {
      return { error: `the worker's GitHub account cannot comment on ${where} (${message}). ${COMMENT_SCOPES_HINT}`, retryable: false };
    }
    return { error: message, retryable: false };
  }
  return { error: message, retryable: err instanceof Error && err.name === 'AbortError' };
}

/**
 * Post one of a wait's comments, or find it already there. Never throws: what happened is recorded
 * on the wait's row, and a failure in the errors table too.
 */
export async function postWaitComment(
  deps: WaitCommentDeps,
  w: DependencyWait,
  which: 'wait' | 'end',
  o: { repoFullName: string; agent: string; triggerLabel: string; checkIntervalMs: number; maxWaitMs: number; signal?: AbortSignal },
): Promise<void> {
  const state = which === 'wait' ? w.waitComment : w.endComment;
  if (state.id !== null || state.attempts >= WAIT_COMMENT_MAX_ATTEMPTS) return;
  if (which === 'end' && w.state !== 'closed' && w.state !== 'expired') return;
  const repo = { id: w.repoId, fullName: o.repoFullName };
  const where = `${o.repoFullName}#${w.issueNumber}`;
  const marker = which === 'wait' ? dependencyWaitMarker(w.runId) : dependencyEndedMarker(w.runId);
  const log = deps.log.child({ runId: w.runId, repo: o.repoFullName, issue: w.issueNumber, comment: which });
  try {
    if (o.signal?.aborted) throw Object.assign(new Error('the worker stopped before the comment was posted'), { name: 'AbortError' });
    let comment = (await deps.api.listIssueComments(repo, w.issueNumber)).find((c) => c.body.includes(marker));
    const found = Boolean(comment);
    if (!comment) {
      const body =
        which === 'wait'
          ? renderWaitComment({
              runId: w.runId,
              jobId: w.jobId,
              agent: o.agent,
              dependency: dependencyRef(w),
              url: w.depUrl,
              checkIntervalMs: o.checkIntervalMs,
              maxWaitMs: o.maxWaitMs,
              triggerLabel: o.triggerLabel,
            })
          : renderDependencyEndedComment({
              runId: w.runId,
              jobId: w.jobId,
              dependency: dependencyRef(w),
              url: w.depUrl,
              state: w.state as 'closed' | 'expired',
              reason: w.reason ?? 'the wait ended',
              waitingSince: w.createdAt,
              triggerLabel: o.triggerLabel,
            });
      comment = await deps.api.createIssueComment(repo, w.issueNumber, body);
    }
    recordWaitComment(deps.db, w.runId, which, { posted: { id: comment.id, url: comment.htmlUrl } }, deps.now);
    log.info(found ? 'wait comment already there' : 'wait comment posted', { comment: comment.htmlUrl });
  } catch (err) {
    const { error, retryable } = classify(err, where);
    const giveUp = !retryable || state.attempts + 1 >= WAIT_COMMENT_MAX_ATTEMPTS;
    try {
      recordWaitComment(deps.db, w.runId, which, { error, giveUp }, deps.now);
      recordError(deps.db, {
        scope: 'dependency',
        repoFullName: o.repoFullName,
        jobId: w.jobId,
        message: `run ${w.runId}: could not comment on ${where} about ${dependencyRef(w)}: ${error}${giveUp ? ' (not retried)' : ' (retried after the next poll)'}`,
        at: new Date(deps.now()).toISOString(),
      });
    } catch (dbErr) {
      log.error('could not record the comment failure', { error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
    }
    log.warn('wait comment not posted', { error, retryable, giveUp });
  }
}
