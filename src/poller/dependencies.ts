// Waits on a pull request in another repository (repositories.<repo>.dependencies,
// docs/dependencies.md). A run that ends with an UPDRAFT-WAITING-ON line has its wait recorded with
// it (finishRun); this module checks the waits that are due after each poll:
//
// - the issue still wants the work: open, still carrying the workflow's trigger label, its
//   repository and workflow still configured with dependencies, the pull request's repository still
//   allowed. Otherwise the wait is canceled (no comment: a person or the config said so).
// - the pull request: merged -> a follow-up job of the same workflow on the same issue is queued
//   and the wait ends as resumed; closed without merging, or no longer readable -> the wait ends as
//   closed and the issue gets a failure comment; still open -> checked again after
//   checkIntervalMinutes, or ends as expired once maxWaitDays have passed.
//
// GitHub errors that may pass (network, 5xx, rate limits) leave the wait as it is and back its
// next check off. The follow-up job is an ordinary queued job: the claim, concurrency limits,
// capacity cooldowns, escalation hops and the pre-start check all apply to it as to any other.
import { dependencySettings, workflowId, type UpdraftConfig } from '../config/schema.js';
import { recordError, type Db } from '../db/database.js';
import {
  dependencyRef,
  endDependencyWait,
  getDependencyWait,
  listDueWaits,
  listPendingWaitComments,
  recordWaitCheckFailed,
  recordWaitChecked,
  recordWaitComment,
  resumeDependencyWait,
  type DependencyWait,
} from '../db/dependency-waits.js';
import { getRun } from '../db/queue.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { GitHubAppError } from '../github/app-auth.js';
import { postWaitComment } from '../publish/dependency-comment.js';
import { labelEquals } from '../routing.js';
import type { Logger } from '../util/log.js';
import { findRepo, isGone } from './poller.js';

/** Waits checked at most per pass; the rest are due on the next one. */
export const MAX_CHECKS_PER_PASS = 20;
/** The longest a check is put off after GitHub errors. */
export const MAX_CHECK_BACKOFF_MS = 6 * 60 * 60_000;

export interface DependencyWatcherDeps {
  db: Db;
  config: UpdraftConfig;
  api: GitHubApi;
  log: Logger;
  now?: () => number;
}

export interface DependencyWatcher {
  /** After a run's wait was recorded: post the "waiting" comment. Never throws. */
  afterRun(runId: string, signal?: AbortSignal): Promise<void>;
  /** Check the waits that are due, then post comments still to post. Never throws. */
  checkDue(signal?: AbortSignal): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A GitHub problem that may pass by itself. */
function transient(err: unknown): boolean {
  if (err instanceof GitHubAppError) return false;
  return err instanceof GitHubError && (err.status === 0 || err.status >= 500 || err.isRateLimit);
}

export type CheckOutcome =
  | { kind: 'waiting'; nextCheckAt: string }
  | { kind: 'resumed'; jobId: string | null }
  | { kind: 'ended'; state: 'closed' | 'canceled' | 'expired'; reason: string }
  | { kind: 'error'; error: string; nextCheckAt: string };

/** What the config says about a wait now: its repository's settings, workflow and trigger label, or why it should end. */
function configFor(config: UpdraftConfig, w: DependencyWait) {
  const found = findRepo(config, w.repoId);
  if (!found) return { problem: `repository ${w.repoFullName} is no longer configured` } as const;
  const settings = dependencySettings(config, found.cfg);
  if (!settings) return { problem: `repositories.${found.fullName}.dependencies is no longer set (or the worker is not in live mode)` } as const;
  if (!settings.allows(w.depRepo)) return { problem: `${w.depRepo} is no longer in repositories.${found.fullName}.dependencies.repositories` } as const;
  const wf = found.cfg.workflows.find((x) => workflowId(x) === w.workflowId);
  if (!wf) return { problem: `workflow "${w.workflowId}" no longer exists in config for ${found.fullName}` } as const;
  return { fullName: found.fullName, settings, label: wf.trigger.label } as const;
}

/** Check one wait and act on what was found. Never throws for GitHub problems. */
export async function checkWait(deps: DependencyWatcherDeps, w: DependencyWait): Promise<CheckOutcome> {
  const now = deps.now ?? Date.now;
  const ref = dependencyRef(w);
  const log = deps.log.child({ runId: w.runId, repo: w.repoFullName, issue: w.issueNumber, waitingOn: ref });
  const end = (state: 'closed' | 'canceled' | 'expired', reason: string, depTitle?: string): CheckOutcome => {
    if (endDependencyWait(deps.db, w.runId, { state, reason, ...(depTitle !== undefined ? { depTitle } : {}), now })) {
      log.info(`wait ${state}`, { reason });
    }
    return { kind: 'ended', state, reason };
  };

  const cfg = configFor(deps.config, w);
  if ('problem' in cfg) return end('canceled', cfg.problem!);
  const { settings } = cfg;
  const repo = { id: w.repoId, fullName: cfg.fullName };
  const deadline = Date.parse(w.createdAt) + settings.maxWaitMs;
  const expire = (detail: string, title?: string) => end('expired', `${ref} ${detail} (dependencies.maxWaitDays)`, title);
  let mergedInTime = false;

  try {
    // 1. Does the issue still want the work? A follow-up for it would be canceled before it started.
    let issue;
    try {
      issue = await deps.api.getIssue(repo, w.issueNumber);
    } catch (err) {
      if (isGone(err)) return end('canceled', `issue #${w.issueNumber} was deleted, transferred or is no longer accessible`);
      throw err;
    }
    if (issue.state !== 'open') return end('canceled', `issue #${w.issueNumber} was closed`);
    if (!issue.labels.some((l) => labelEquals(l, cfg.label))) return end('canceled', `issue #${w.issueNumber} no longer carries the trigger label "${cfg.label}"`);

    // 2. The pull request, in a repository addressed by its stable id once it is known.
    let depRepoId = w.depRepoId;
    if (depRepoId === null) {
      try {
        depRepoId = (await deps.api.getRepo(w.depRepo)).id;
      } catch (err) {
        if (isGone(err) || (err instanceof GitHubError && err.status === 403 && !err.isRateLimit)) {
          return end('closed', `${w.depRepo} does not exist, or the worker's GitHub account cannot read it, so ${ref} cannot be watched`);
        }
        throw err;
      }
    }
    let pr;
    try {
      pr = await deps.api.getPullRequest({ id: depRepoId, fullName: w.depRepo }, w.depNumber);
    } catch (err) {
      if (isGone(err)) return end('closed', `${ref} does not exist as a pull request, or the worker's GitHub account cannot read it`);
      throw err;
    }
    const title = pr.title ?? '';
    if (pr.merged) {
      // A delayed check can still discover a merge that happened by the deadline.
      const mergedAt = Date.parse(pr.mergedAt ?? '');
      if (Number.isFinite(mergedAt) ? mergedAt > deadline : now() >= deadline) {
        return expire('did not have a confirmed merge by the wait deadline', title);
      }
      mergedInTime = true;
      const r = resumeDependencyWait(deps.db, w.runId, {
        pullRequest: { repo: w.depRepo, number: w.depNumber, url: pr.htmlUrl || w.depUrl, title, mergedAt: pr.mergedAt ?? null, mergeCommitSha: pr.mergeCommitSha ?? null },
        now,
      });
      if (r.status === 'queued') {
        log.info('pull request merged; follow-up job queued', { job: r.job.id, pool: r.job.pool });
        return { kind: 'resumed', jobId: r.job.id };
      }
      if (r.status === 'gone') return { kind: 'ended', state: 'canceled', reason: r.reason };
      return { kind: 'resumed', jobId: r.jobId };
    }
    if (pr.state === 'closed') return end('closed', `${ref} was closed without being merged`, title);
    const checkedAt = now();
    if (checkedAt >= deadline) return expire('was still open at the wait deadline', title);
    const nextCheckAt = new Date(Math.min(checkedAt + settings.checkIntervalMs, deadline)).toISOString();
    recordWaitChecked(deps.db, w.runId, { nextCheckAt, depRepoId, depUrl: pr.htmlUrl || undefined, depTitle: title || undefined, now });
    log.debug('still waiting', { nextCheckAt });
    return { kind: 'waiting', nextCheckAt };
  } catch (err) {
    // An on-time merge can be retried if recording its follow-up job failed.
    const checkedAt = now();
    const error = message(err);
    if (!mergedInTime && checkedAt >= deadline) {
      log.warn('could not verify the merge by the wait deadline', { error });
      return expire('could not be confirmed merged by the wait deadline');
    }
    const backoff = transient(err) ? Math.min(MAX_CHECK_BACKOFF_MS, settings.checkIntervalMs * 2 ** w.failures) : settings.checkIntervalMs;
    const retryAfter = err instanceof GitHubError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;
    const backedOffUntil = checkedAt + backoff;
    const nextCheckAt = new Date(Math.max(checkedAt + retryAfter, mergedInTime ? backedOffUntil : Math.min(backedOffUntil, deadline))).toISOString();
    recordWaitCheckFailed(deps.db, w.runId, { error, nextCheckAt, now });
    try {
      recordError(deps.db, {
        scope: 'dependency',
        repoFullName: w.repoFullName,
        jobId: w.jobId,
        message: `run ${w.runId}: could not check ${ref}: ${error}; checked again at ${nextCheckAt}`,
        at: new Date(now()).toISOString(),
      });
    } catch {
      // the wait's row already holds the error
    }
    log.warn('could not check the pull request waited on', { error, nextCheckAt });
    return { kind: 'error', error, nextCheckAt };
  }
}

export function createDependencyWatcher(deps: DependencyWatcherDeps): DependencyWatcher {
  const now = deps.now ?? Date.now;
  const commenting = new Set<string>();
  const comment = async (runId: string, signal?: AbortSignal) => {
    // The run-completion task and the polling loop can both find the same comment pending.
    if (commenting.has(runId)) return;
    commenting.add(runId);
    try {
      const w = getDependencyWait(deps.db, runId);
      if (!w || w.state === 'canceled' || w.state === 'resumed') return;
      const which = w.state === 'waiting' ? 'wait' : 'end';
      const cfg = configFor(deps.config, w);
      if ('problem' in cfg) {
        recordWaitComment(deps.db, runId, which, { error: `not posted: ${cfg.problem}`, giveUp: true }, now);
        return;
      }
      const agent = getRun(deps.db, runId)?.agent ?? 'unknown';
      await postWaitComment({ db: deps.db, api: deps.api, log: deps.log, now }, w, which, {
        repoFullName: cfg.fullName,
        agent,
        triggerLabel: cfg.label,
        checkIntervalMs: cfg.settings.checkIntervalMs,
        maxWaitMs: cfg.settings.maxWaitMs,
        signal,
      });
    } finally {
      commenting.delete(runId);
    }
  };
  return {
    async afterRun(runId, signal) {
      try {
        await comment(runId, signal);
      } catch (err) {
        deps.log.error('wait comment crashed', { runId, error: message(err) });
      }
    },
    async checkDue(signal) {
      let due: DependencyWait[];
      try {
        due = listDueWaits(deps.db, { now, limit: MAX_CHECKS_PER_PASS });
      } catch (err) {
        deps.log.error('could not list waits to check', { error: message(err) });
        return;
      }
      for (const w of due) {
        if (signal?.aborted) return;
        try {
          await checkWait(deps, w);
        } catch (err) {
          deps.log.error('wait check crashed', { runId: w.runId, error: message(err) });
        }
      }
      let pending: DependencyWait[];
      try {
        pending = listPendingWaitComments(deps.db);
      } catch (err) {
        deps.log.error('could not list wait comments to post', { error: message(err) });
        return;
      }
      for (const w of pending) {
        if (signal?.aborted) return;
        try {
          await comment(w.runId, signal);
        } catch (err) {
          deps.log.error('wait comment crashed', { runId: w.runId, error: message(err) });
        }
      }
    },
  };
}
