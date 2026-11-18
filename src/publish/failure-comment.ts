// The failure comment (repositories.<repo>.commentOnFailure): when a live run leaves its job
// failed, the worker (never the agent) comments once on the issue as the active gh account, so
// whoever applied the label learns that no PR is coming and how to retry.
//
// The issue may be public and the run's output is untrusted, so the comment carries only what the
// worker itself knows: run id, agent, duration, the worker's description of the failure, the job
// branch name and how to retry. No agent output, no agent message, no local paths.
//
// Idempotent the way publication's issue comment is: a hidden marker carries the run id, the
// issue's comments are searched for it before posting, and what was posted is recorded. Posting
// never changes the run's outcome.
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { UpdraftConfig } from '../config/schema.js';
import { recordError, type Db } from '../db/database.js';
import {
  beginFailureComment,
  FailureCommentSupersededError,
  finishFailureComment,
  getFailureComment,
  holdFailureComment,
  listDueFailureComments,
  type FailureComment,
} from '../db/failure-comments.js';
import { getJob, getRun, MAX_START_FAILURES } from '../db/queue.js';
import { jobBranchName } from '../git/worktree.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { GitHubAppError } from '../github/app-auth.js';
import type { UpdraftPaths } from '../paths.js';
import { revisionOf, type Job, type Run } from '../types.js';
import type { Logger } from '../util/log.js';
import { findRepoConfig } from '../worker/executor.js';
import { cap, fenced, MAX_AUTO_ATTEMPTS, PUBLISH_ATTEMPT_SECONDS, PUBLISH_LEASE_SECONDS } from './publish.js';

const BASE_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 60 * 60;
const MAX_REASON = 300;

/** What commenting needs, for permission errors and `updraft doctor`. */
export const COMMENT_SCOPES_HINT =
  'Commenting needs read access to the repository and a token with the classic "repo" scope ("public_repo" is enough ' +
  'for a public repository), or a fine-grained token with Issues set to read and write. With a GitHub App (github.app) ' +
  'instead, the App needs the Issues repository permission set to read and write (docs/github-app.md)';

export interface FailureCommentDeps {
  db: Db;
  config: UpdraftConfig;
  paths: UpdraftPaths;
  api: GitHubApi;
  log: Logger;
  now?: () => number;
}

export type FailureCommentResult =
  | { status: 'posted'; comment: FailureComment; already: boolean }
  /** No comment applies to this run (option off, not live, run did not leave its job failed...). */
  | { status: 'not-eligible'; reason: string }
  /** Another process is posting this run's comment right now. */
  | { status: 'busy'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean; comment: FailureComment };

/** Hidden marker on the failure comment; finds it again on a retry. Distinct from publication's. */
export function failureCommentMarker(runId: string): string {
  return `<!-- updraft-run-failed: ${runId} -->`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The attempt stopped for a reason a later attempt can get past. */
class TransientError extends Error {}

// ---------------------------------------------------------------------------
// Comment text
// ---------------------------------------------------------------------------

/** Inline code the text cannot close, so mentions, links and references in it stay inert. */
export function code(text: string): string {
  const flat = text.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim() || '?';
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return longest ? `${ticks} ${flat} ${ticks}` : `${ticks}${flat}${ticks}`;
}

const PATH_PLACEHOLDER = '<path>';
// The rest of a path once its start is found. A path may contain spaces: a following word is
// taken as part of it when it has a separator too.
const PATH_REST = String.raw`[^\s'"\`]*(?: [^\s'"\`\\/]+[\\/][^\s'"\`]*)*`;
const WINDOWS_PATH = new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]${PATH_REST}`, 'g');
const UNC_PATH = new RegExp(String.raw`\\\\(?=[^\s\\/])${PATH_REST}`, 'g');
// Not after a word character, so OWNER/REPO, URLs and "and/or" are left alone.
const POSIX_PATH = new RegExp(String.raw`(?<![\w.:/\\-])~?\/(?=[^\s/])${PATH_REST}`, 'g');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The part of a run's recorded error that is safe to post publicly. The recorded error is the
 * worker's description, optionally followed by ": " and detail that may quote the agent's output
 * (adapters append what the agent printed) or name local files (git and filesystem errors). Only
 * the description is kept, local paths in it are replaced, and it is capped. The full error stays
 * in `updraft status` and the run log.
 */
export function publicFailureReason(error: string | null, localPaths: ReadonlyArray<string | null | undefined> = []): string {
  const full = error ?? '';
  // A verification failure names the failing command from the user's own config and how it
  // ended ("verification failed: "npm test" exited 1"). That is the worker's text, not the
  // agent's, and it is the part worth reading, so the first segment after the prefix is kept too.
  const verification = /^verification failed:\s/.exec(full);
  const first = (t: string) => t.split(/:\s/, 1)[0] ?? '';
  let text = verification ? `${verification[0]}${first(full.slice(verification[0].length))}` : first(full);
  const known = [...new Set(localPaths.filter((p): p is string => typeof p === 'string' && p.length > 1))].sort((a, b) => b.length - a.length);
  for (const p of known) text = text.replace(new RegExp(escapeRegExp(p) + PATH_REST, 'g'), PATH_PLACEHOLDER);
  text = text.replace(WINDOWS_PATH, PATH_PLACEHOLDER).replace(UNC_PATH, PATH_PLACEHOLDER).replace(POSIX_PATH, PATH_PLACEHOLDER);
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cap(text || 'unknown error', MAX_REASON);
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function renderFailureComment(o: {
  runId: string;
  jobId: string;
  attempt: number;
  agent: string;
  /** False when the job failed because no agent could start. */
  agentStarted: boolean;
  /** Consecutive start failures, when that is why the job failed. */
  startFailures?: number;
  ranMs: number | null;
  /** Already reduced by {@link publicFailureReason}. */
  reason: string;
  branch: string | null;
  triggerLabel: string;
  /** Set for a revision run: the comment goes on the pull request and says how to ask again. */
  revision?: boolean;
}): string {
  const reason = o.agentStarted
    ? o.reason
    : `no agent could start after ${o.startFailures ?? MAX_START_FAILURES} consecutive attempts; the last one, on ${o.agent}: ${o.reason}`;
  return [
    o.revision
      ? 'An Updraft revision run for this pull request failed, so nothing was pushed to it.'
      : 'An Updraft run for this issue failed, so no pull request was opened for it.',
    '',
    `- Run: ${code(o.runId)} (attempt ${o.attempt} of job ${code(o.jobId)})`,
    `- Agent: ${code(o.agent)}${o.agentStarted ? '' : ' (the last one tried)'}`,
    `- Ran for: ${o.agentStarted && o.ranMs !== null ? duration(o.ranMs) : 'the agent did not start'}`,
    ...(o.branch ? [`- Branch: ${code(o.branch)} (on the worker's machine; not pushed)`] : []),
    '',
    '**Reason**',
    '',
    fenced(reason),
    '',
    "The agent's output is not posted here; the full error and the run log are on the machine running the worker (`updraft status`).",
    '',
    o.revision
      ? `To try again, run ${code(`updraft retry ${o.jobId}`)} on that machine, or submit a new review that requests changes.`
      : `To try again, run ${code(`updraft retry ${o.jobId}`)} on that machine, or remove the ${code(o.triggerLabel)} label from this issue and apply it again.`,
    '',
    failureCommentMarker(o.runId),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

interface Eligible {
  run: Run;
  job: Job;
  repoFullName: string;
  checkoutPath: string | null;
}

/**
 * A comment applies when, in live mode with the option on, the run is the one that left its job
 * failed: it ended `failed`, or it was the start failure that used up the job's start attempts.
 * Checked again on every retry, so a job the user has retried meanwhile gets no late comment.
 */
function eligibility(deps: FailureCommentDeps, runId: string): { ok: true; e: Eligible } | { ok: false; reason: string } {
  const run = getRun(deps.db, runId);
  if (!run) return { ok: false, reason: `run ${runId} not found` };
  const job = getJob(deps.db, run.jobId);
  if (!job) return { ok: false, reason: `job ${run.jobId} of run ${runId} not found` };
  if (deps.config.execution.mode !== 'live') {
    return { ok: false, reason: `failure comments apply only in live mode (execution.mode is ${deps.config.execution.mode})` };
  }
  const found = findRepoConfig(deps.config, job);
  if (!found) return { ok: false, reason: `${job.repoFullName} is no longer configured` };
  if (!found.repo.commentOnFailure) {
    return { ok: false, reason: `failure comments are off for ${found.fullName} (set repositories.${found.fullName}.commentOnFailure)` };
  }
  if (run.outcome !== 'failed' && run.outcome !== 'start_failed') {
    return { ok: false, reason: `run ${runId} ${run.outcome ? `ended ${run.outcome}` : 'has no outcome'}; only failed runs are commented on` };
  }
  if (job.status !== 'failed') {
    return {
      ok: false,
      reason:
        run.outcome === 'start_failed' && job.attempts === run.attempt
          ? `run ${runId} could not start and job ${job.id} was requeued for another agent`
          : `job ${job.id} is ${job.status} now, not failed`,
    };
  }
  if (job.attempts !== run.attempt) return { ok: false, reason: `job ${job.id} has a later attempt than run ${runId}` };
  return {
    ok: true,
    e: {
      run,
      job,
      repoFullName: found.fullName,
      checkoutPath: found.repo.checkoutPath ? resolve(deps.paths.configDir, found.repo.checkoutPath) : null,
    },
  };
}

function classify(err: unknown, repoFullName: string, issueNumber: number): { error: string; retryable: boolean; retryAfter: number | null } {
  if (err instanceof TransientError) return { error: err.message, retryable: true, retryAfter: null };
  if (!(err instanceof GitHubError)) return { error: message(err), retryable: false, retryAfter: null };
  // A GitHub App problem that waiting does not fix; its message already says what to change.
  if (err instanceof GitHubAppError) return { error: err.message, retryable: false, retryAfter: null };
  if (err.status === 0 || err.status >= 500 || err.isRateLimit) {
    return { error: `GitHub is unavailable for now: ${err.message}`, retryable: true, retryAfter: err.retryAfterSeconds };
  }
  if (err.status === 401) {
    return { error: `GitHub rejected the token (401). Run "gh auth login" or set GH_TOKEN. ${COMMENT_SCOPES_HINT}.`, retryable: false, retryAfter: null };
  }
  if (err.status === 403 || err.status === 404 || err.status === 410) {
    return {
      error:
        `the active GitHub account cannot comment on ${repoFullName}#${issueNumber} (${err.message}). The issue may be ` +
        `locked or deleted, or the repository archived. ${COMMENT_SCOPES_HINT}.`,
      retryable: false,
      retryAfter: null,
    };
  }
  return { error: err.message, retryable: false, retryAfter: null };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * Post the failure comment for one run, or resume posting it. Never throws for GitHub problems:
 * the result (and the failure_comments table) says what happened.
 */
export async function postFailureComment(deps: FailureCommentDeps, runId: string, opts: { signal?: AbortSignal } = {}): Promise<FailureCommentResult> {
  const now = deps.now ?? Date.now;
  const existing = getFailureComment(deps.db, runId);
  if (existing?.state === 'posted') return { status: 'posted', comment: existing, already: true };
  const check = eligibility(deps, runId);
  if (!check.ok && !existing) return { status: 'not-eligible', reason: check.reason };

  const run = getRun(deps.db, runId);
  const job = check.ok ? check.e.job : run ? getJob(deps.db, run.jobId) : null;
  if (!run || !job) return { status: 'not-eligible', reason: check.ok ? '' : check.reason };
  const repoFullName = check.ok ? check.e.repoFullName : (existing?.repoFullName ?? job.repoFullName);
  const repoRef = { id: job.repoId, fullName: repoFullName };
  // A revision run's comment goes on the pull request it was revising (a PR takes issue
  // comments under its own number), with the same text rules.
  const revision = revisionOf(job);
  const target = revision ? revision.pullRequest.number : job.issueNumber;
  const where = `${revision ? 'pull request' : 'issue'} #${target}`;
  const log = deps.log.child({ runId, repo: repoFullName, issue: job.issueNumber, ...(revision ? { pr: target } : {}) });

  const begun = beginFailureComment(deps.db, {
    runId,
    jobId: job.id,
    repoId: job.repoId,
    repoFullName,
    issueNumber: target,
    leaseSeconds: PUBLISH_LEASE_SECONDS,
    now,
  });
  if (!begun.ok) {
    if (begun.reason === 'posted') return { status: 'posted', comment: begun.comment, already: true };
    return { status: 'busy', reason: `the failure comment for run ${runId} is being posted by another process (lease until ${begun.comment.leaseExpiresAt})` };
  }
  // This attempt's fence, as in publication: every state write and every request checks it still
  // owns the row, so an attempt that outlived its lease can't post after a newer one took over.
  const fence = { attempt: begun.comment.attempts, leaseSeconds: PUBLISH_LEASE_SECONDS, now };
  const superseded = (): FailureCommentResult => {
    log.warn('failure comment attempt superseded', { attempt: fence.attempt });
    return { status: 'busy', reason: new FailureCommentSupersededError(runId, fence.attempt).message };
  };
  const runLog = async (line: string) => {
    if (!run.logPath) return;
    try {
      await appendFile(run.logPath, `failure comment: ${line}\n`, 'utf8');
    } catch (err) {
      log.warn('could not write to run.log', { error: message(err) });
    }
  };

  if (!check.ok) {
    // It applied when the row was written and no longer does (the job was retried, the option
    // was turned off...): close the row so the worker stops retrying it.
    if (!finishFailureComment(deps.db, runId, fence.attempt, { state: 'skipped', error: check.reason, now })) return superseded();
    await runLog(`not posted: ${check.reason}`);
    log.info('failure comment skipped', { reason: check.reason });
    return { status: 'not-eligible', reason: check.reason };
  }

  const attemptStarted = now();
  /** Before each request to GitHub: still the owner (renewing the lease), within the deadline, not stopping. */
  const hold = () => {
    holdFailureComment(deps.db, runId, fence);
    if (opts.signal?.aborted) throw new TransientError('the worker stopped before the comment was posted');
    if (now() - attemptStarted > PUBLISH_ATTEMPT_SECONDS * 1000) {
      throw new TransientError(`attempt ${fence.attempt} ran past its ${PUBLISH_ATTEMPT_SECONDS / 60}-minute deadline`);
    }
  };

  try {
    hold();
    const marker = failureCommentMarker(runId);
    const found = (await deps.api.listIssueComments(repoRef, target)).find((c) => c.body.includes(marker));
    let comment = found;
    if (!comment) {
      const agentStarted = run.outcome === 'failed';
      const started = run.executionStartedAt ?? run.startedAt;
      const body = renderFailureComment({
        runId,
        jobId: job.id,
        attempt: run.attempt,
        agent: run.agent,
        agentStarted,
        startFailures: job.startFailures,
        ranMs: run.endedAt ? Date.parse(run.endedAt) - Date.parse(started) : null,
        reason: publicFailureReason(run.error, [
          run.checkoutPath,
          run.summary?.worktree,
          run.logPath,
          check.e.checkoutPath,
          deps.paths.runsDir,
          deps.paths.logDir,
          deps.paths.dataDir,
          deps.paths.configFile,
          deps.paths.configDir,
          homedir(),
        ]),
        // A checkout is recorded once the worktree, and with it the job branch, exists.
        branch: run.summary?.branch ?? (run.checkoutPath ? jobBranchName(job, run.attempt) : null),
        triggerLabel: job.envelope.label,
        revision: revision !== null,
      });
      hold(); // the lookup may have outlived the lease
      comment = await deps.api.createIssueComment(repoRef, target, body);
    }
    if (!finishFailureComment(deps.db, runId, fence.attempt, { state: 'posted', commentId: comment.id, commentUrl: comment.htmlUrl, now })) {
      return superseded();
    }
    await runLog(found ? `already on ${where}: ${comment.htmlUrl}` : `commented on ${where}: ${comment.htmlUrl}`);
    log.info('failure comment posted', { comment: comment.htmlUrl, found: Boolean(found) });
    return { status: 'posted', comment: getFailureComment(deps.db, runId)!, already: false };
  } catch (err) {
    if (err instanceof FailureCommentSupersededError) return superseded();
    const { error, retryable, retryAfter } = classify(err, repoFullName, target);
    const attempts = fence.attempt;
    let nextAttemptAt: string | null = null;
    if (retryable && attempts < MAX_AUTO_ATTEMPTS) {
      const backoff = retryAfter ?? Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** (attempts - 1));
      nextAttemptAt = new Date(now() + backoff * 1000).toISOString();
    }
    if (!finishFailureComment(deps.db, runId, fence.attempt, { state: 'failed', error, retryable, nextAttemptAt, now })) return superseded();
    const hint = nextAttemptAt ? `the worker retries at ${nextAttemptAt}` : 'the worker will not retry it';
    await runLog(`not posted: ${error} (${hint})`);
    log.warn('failure comment not posted', { error, retryable, attempts });
    try {
      recordError(deps.db, {
        scope: 'failure-comment',
        repoFullName,
        jobId: job.id,
        message: `run ${runId}: could not comment on ${where}: ${error} (${hint})`,
        at: new Date(now()).toISOString(),
      });
    } catch {
      // the failure_comments row already holds the error
    }
    return { status: 'failed', error, retryable, comment: getFailureComment(deps.db, runId)! };
  }
}

// ---------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------

export interface FailureCommenter {
  /** After a failed or start_failed run is recorded; decides itself whether a comment applies. Never throws. */
  afterRun(runId: string, signal?: AbortSignal): Promise<void>;
  /** Retry transient failures whose time has come, and comments a stopped worker left. Never throws. */
  retryDue(signal?: AbortSignal): Promise<void>;
}

export function createFailureCommenter(deps: FailureCommentDeps): FailureCommenter {
  const run = async (runId: string, signal?: AbortSignal) => {
    try {
      const r = await postFailureComment(deps, runId, { signal });
      if (r.status === 'not-eligible') deps.log.debug('no failure comment for run', { runId, reason: r.reason });
    } catch (err) {
      deps.log.error('failure comment crashed', { runId, error: message(err) });
    }
  };
  return {
    afterRun: run,
    async retryDue(signal) {
      let due: string[];
      try {
        due = listDueFailureComments(deps.db, { maxAttempts: MAX_AUTO_ATTEMPTS, now: deps.now });
      } catch (err) {
        deps.log.error('could not list failure comments to retry', { error: message(err) });
        return;
      }
      for (const runId of due) {
        if (signal?.aborted) return;
        await run(runId, signal);
      }
    },
  };
}

/** True when any repository opts in to failure comments and the mode runs agents. */
export function failureCommentsEnabled(config: UpdraftConfig): boolean {
  return config.execution.mode === 'live' && Object.values(config.repositories).some((r) => r.commentOnFailure === true);
}
