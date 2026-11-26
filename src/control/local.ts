// The local state machine behind human steering (#135, docs/controls.md): what each command does
// to the state database of `updraft start` (or a shared one under `updraft run-event`).
//
// It only ever uses the primitives the CLI already has, so every guarantee they give still holds:
//   - stopping: `requestJobCancel` (the worker aborts the agent and marks the job canceled; nothing
//     is published, the worktree and branch are kept);
//   - holding queued work: `cancelQueuedJob`, with the job remembered on the pause;
//   - resuming: `retryJob` on exactly the jobs the pause held, which then meet every pre-start
//     check again (a reviewer job for a head that moved is dropped; the poller queues the new head);
//   - reviewing again: `enqueueReviewJob`, under a key of its own per command;
//   - steering: a revision request (`enqueueRevision`), with the revision budget (maxRevisions),
//     the allowlist re-check before start and the prompt's untrusted-input fencing of any review.
// A pause is a gate (pauseProblem): while it holds, nothing of the workflow starts.
//
// Authorization is the caller's (controlPolicy): this assumes the command is allowed.
import { allowedActorsFor, DEFAULT_MAX_REVISIONS, reviewActive, reviewPoolFor, reviseActive, workflowId, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import { activeControlPause, holdUnderPause, pauseWorkflow, resumeWorkflow, type PauseKind } from '../db/control.js';
import { cancelQueuedJob } from '../db/ingest.js';
import { enqueueReviewJob, getLoopPr, listOpenLoopPrs, observeHead, type LoopPr } from '../db/pr-reviews.js';
import { getJob, requestJobCancel, RETRYABLE, retryJob } from '../db/queue.js';
import { enqueueRevision, revisionJob } from '../db/revisions.js';
import type { Job, RepoRef, RevisionRequest } from '../types.js';
import { nowIso } from '../util/ids.js';
import type { ControlCommand } from './commands.js';

export interface LocalControlRequest {
  command: ControlCommand;
  repo: RepoRef;
  cfg: RepositoryConfig;
  /** The workflow: the issue, also for a command given on one of its pull requests. */
  issue: number;
  /** The pull request the command was given on, or the workflow's open Updraft PR; null for none. */
  pullRequest: number | null;
  /** The pull request's head on GitHub now; null when there is no pull request or it is unknown. */
  headSha: string | null;
  /** The issue or pull request as GitHub has it now. */
  subjectState: 'open' | 'closed' | 'merged';
  actor: string;
  /** The command's identity: the comment id, or `cli-…` for `updraft control`. */
  source: string;
  /** Where the command was given (the comment), for a revision's link. */
  url: string;
  text: string;
  target: string | null;
  /**
   * What the person may do, as the caller confirmed it: `maintain` lifts a stop's or a cancel's
   * pause, `write` only a `pause`. Checked here, in the same transaction as the resume, against the
   * pause that is lifted (a cancel that lands after the caller's check still wins).
   */
  authority: 'write' | 'maintain';
}

export interface LocalControlResult {
  outcome: 'applied' | 'noop' | 'refused' | 'ambiguous' | 'unsupported';
  message: string;
}

/** Commands this path does not carry out yet; help marks them. */
export const LOCAL_UNSUPPORTED: readonly ControlCommand[] = ['escalate'];

/** The jobs of a workflow (its issue job, and reviewer and revision jobs of its pull requests). */
function workflowJobs(db: Db, repoId: number, issue: number, status?: Job['status']): Job[] {
  const rows = db
    .prepare(`SELECT id FROM jobs WHERE repo_id = ? AND issue_number = ?${status ? ' AND status = ?' : ''} ORDER BY created_at, rowid`)
    .all(...([repoId, issue, ...(status ? [status] : [])] as [number, number, ...string[]])) as Array<{ id: string }>;
  return rows.flatMap((r) => getJob(db, r.id) ?? []);
}

const pausedReason = (by: string, source: string) => `paused by ${by} (${source}); resume continues it`;

/**
 * Why the pause gate holds `job` now, or null. The poller cancels a held queued job with this
 * reason and remembers it on the pause, so resume puts it back.
 */
export function pauseProblem(db: Db, job: Pick<Job, 'id' | 'repoId' | 'issueNumber'>): string | null {
  const pause = activeControlPause(db, job.repoId, job.issueNumber);
  return pause ? pausedReason(pause.by, pause.source) : null;
}

/** The gate's cancel, with the job held for resume. */
export function holdPausedJob(db: Db, job: Pick<Job, 'id' | 'repoId' | 'issueNumber'>, reason: string, now?: () => number): boolean {
  if (!cancelQueuedJob(db, job.id, reason, now)) return false;
  holdUnderPause(db, job.repoId, job.issueNumber, job.id);
  return true;
}

/** Whether resuming this workflow needs maintain (it lifts a stop or a cancel). */
export function resumeIsElevated(db: Db, repoId: number, issue: number): boolean {
  const pause = activeControlPause(db, repoId, issue);
  return pause !== null && pause.kind !== 'pause';
}

/** The open Updraft pull request of a workflow: the one named, else the newest open one for the issue. */
export function workflowPullRequest(db: Db, repoId: number, issue: number, named: number | null): LoopPr | null {
  if (named !== null) {
    const pr = getLoopPr(db, repoId, named);
    return pr && pr.issueNumber === issue ? pr : null;
  }
  return listOpenLoopPrs(db, repoId).filter((p) => p.issueNumber === issue).sort((a, b) => b.prNumber - a.prNumber)[0] ?? null;
}

export function applyLocalControl(db: Db, config: UpdraftConfig, r: LocalControlRequest, now: () => number = Date.now): LocalControlResult {
  const ref = `#${r.issue}${r.pullRequest !== null && r.pullRequest !== r.issue ? ` (pull request #${r.pullRequest})` : ''}`;
  const closed = r.subjectState !== 'open';
  const pause = (kind: PauseKind, held: string[]) =>
    pauseWorkflow(db, r.repo.id, r.issue, { kind, by: r.actor, reason: r.text.slice(0, 500), source: r.source, held }, now);
  const holdQueued = (reason: string) => workflowJobs(db, r.repo.id, r.issue, 'queued').filter((j) => cancelQueuedJob(db, j.id, reason, now)).map((j) => j.id);
  const running = () => workflowJobs(db, r.repo.id, r.issue, 'running');

  switch (r.command) {
    case 'help':
      return { outcome: 'noop', message: '' };
    case 'escalate':
      return { outcome: 'unsupported', message: 'Escalation by comment is not available yet. The configured routing policy (tiers and escalation) still applies to every run; a maintainer can add a tier override label.' };

    case 'pause': {
      const held = holdQueued(pausedReason(r.actor, r.source));
      const { created } = pause('pause', held);
      const active = running();
      const still = active.length ? ` Still running: ${active.map((j) => `job ${j.id}`).join(', ')}. It finishes its current step and may still publish it; nothing new starts after it. Use \`stop\` to stop it now.` : '';
      return {
        outcome: created || held.length ? 'applied' : 'noop',
        message: `${created ? `Paused ${ref}` : `${ref} was already paused`}: nothing new starts until it is resumed.${held.length ? ` Held ${held.length} queued job(s).` : ''}${still}`,
      };
    }

    case 'stop': {
      const active = running();
      const target = r.target ? active.find((j) => j.id === r.target) : active.length === 1 ? active[0] : undefined;
      if (r.target && !target) return { outcome: 'refused', message: `Job ${r.target} is not running for ${ref}, so nothing was stopped.` };
      if (!target && active.length === 0) return { outcome: 'noop', message: `No job is running for ${ref}, so nothing was stopped. \`pause\` or \`cancel\` holds queued work.` };
      if (!target) {
        return { outcome: 'ambiguous', message: `${active.length} jobs are running for ${ref} (${active.map((j) => j.id).join(', ')}). Nothing was stopped: name one, e.g. \`stop ${active[0]!.id}\`.` };
      }
      const held = holdQueued(pausedReason(r.actor, r.source));
      const request = requestJobCancel(db, target.id, now);
      if (request.kind === 'stale') {
        pause('stop', held);
        return { outcome: 'refused', message: `Job ${target.id} is marked running, but no worker is running to stop it. ${ref} is paused; the next \`updraft start\` marks the job interrupted.` };
      }
      pause('stop', request.kind === 'requested' || request.kind === 'canceled' ? [target.id, ...held] : held);
      if (request.kind === 'requested') {
        return { outcome: 'applied', message: `Stopping job ${target.id}${request.alreadyRequested ? ' (already requested)' : ''}: the worker stops its agent within seconds and publishes nothing from it. Its branch and any pull request are kept. ${ref} is paused until resumed.` };
      }
      return { outcome: 'applied', message: `Job ${target.id} had not started; it was canceled. ${ref} is paused until resumed.` };
    }

    case 'cancel': {
      const held = holdQueued(pausedReason(r.actor, r.source));
      const stopping: string[] = [];
      for (const j of running()) {
        const request = requestJobCancel(db, j.id, now);
        if (request.kind === 'requested') stopping.push(j.id);
      }
      const { created } = pause('cancel', [...held, ...stopping]);
      return {
        outcome: created || held.length || stopping.length ? 'applied' : 'noop',
        message: `Canceled work on ${ref}: ${held.length} queued job(s) held${stopping.length ? `, stopping ${stopping.join(', ')} (not confirmed yet)` : ''}. Commits, branches and pull requests are kept. Nothing starts until it is resumed.`,
      };
    }

    case 'resume': {
      if (closed) return { outcome: 'refused', message: `${ref} is ${r.subjectState}, so there is nothing to resume. Reopen it and apply the trigger label to start new work.` };
      const current = activeControlPause(db, r.repo.id, r.issue);
      if (!current) return { outcome: 'noop', message: `${ref} is not paused. ${r.pullRequest !== null ? '`review` reviews the current head again.' : ''}`.trim() };
      if (current.kind !== 'pause' && r.authority !== 'maintain') {
        return { outcome: 'refused', message: `${ref} was ${current.kind === 'stop' ? 'stopped' : 'canceled'}; resuming it needs maintain or admin access, so nothing was done.` };
      }
      const stillRunning = current.held.filter((id) => getJob(db, id)?.status === 'running');
      if (stillRunning.length) return { outcome: 'refused', message: `Job ${stillRunning.join(', ')} is still stopping. Resume once it has ended.` };
      if (!resumeWorkflow(db, r.repo.id, r.issue, current, r.actor, now)) return { outcome: 'refused', message: `${ref} was paused again in the meantime; nothing was resumed.` };
      const back: string[] = [];
      const notBack: string[] = [];
      for (const id of current.held) {
        const job = getJob(db, id);
        if (!job || !RETRYABLE.includes(job.status)) continue;
        try {
          retryJob(db, id, now);
          back.push(id);
        } catch (err) {
          notBack.push(`${id} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      // A head someone pushed while paused: the reviewer job of that head, unless it has one.
      let reviewed = '';
      const pr = workflowPullRequest(db, r.repo.id, r.issue, r.pullRequest);
      if (pr && r.headSha && reviewActive(config, r.cfg)) {
        observeHead(db, r.repo.id, pr.prNumber, r.headSha, nowIso(now));
        const fresh = getLoopPr(db, r.repo.id, pr.prNumber)!;
        const wf = r.cfg.workflows.find((w) => workflowId(w) === fresh.workflowId);
        const job = enqueueReviewJob(db, { repo: r.repo, pr: fresh, pool: reviewPoolFor(r.cfg, wf, fresh.pool), allowedActors: wf ? allowedActorsFor(config, wf) : [], now });
        if (job) reviewed = ` Queued a review of the current head ${r.headSha.slice(0, 12)} of pull request #${pr.prNumber} (job ${job.id}).`;
      }
      return {
        outcome: 'applied',
        message: `Resumed ${ref}.${back.length ? ` Requeued ${back.join(', ')}; each is checked again before it starts (a review of an outdated head is dropped).` : ''}${reviewed}${notBack.length ? ` Not requeued: ${notBack.join('; ')}.` : ''}${!back.length && !reviewed ? ' Nothing was waiting; the next event continues the workflow.' : ''}`,
      };
    }

    case 'review': {
      if (closed) return { outcome: 'refused', message: `${ref} is ${r.subjectState}; there is nothing to review.` };
      if (activeControlPause(db, r.repo.id, r.issue)) return { outcome: 'refused', message: `${ref} is paused. \`resume\` first; it reviews the current head.` };
      if (!reviewActive(config, r.cfg)) return { outcome: 'refused', message: `Review is off for ${r.repo.fullName}, so nothing was queued.` };
      const pr = workflowPullRequest(db, r.repo.id, r.issue, r.pullRequest);
      if (!pr || pr.state !== 'open') return { outcome: 'refused', message: `${ref} has no open Updraft pull request to review.` };
      if (!r.headSha) return { outcome: 'refused', message: `The head of pull request #${pr.prNumber} could not be read just now; try again shortly.` };
      observeHead(db, r.repo.id, pr.prNumber, r.headSha, nowIso(now));
      const fresh = getLoopPr(db, r.repo.id, pr.prNumber)!;
      if (fresh.headSha !== r.headSha) return { outcome: 'refused', message: `Pull request #${pr.prNumber} moved while this was read; try again.` };
      const wf = r.cfg.workflows.find((w) => workflowId(w) === fresh.workflowId);
      const job = enqueueReviewJob(db, { repo: r.repo, pr: fresh, pool: reviewPoolFor(r.cfg, wf, fresh.pool), allowedActors: wf ? allowedActorsFor(config, wf) : [], now, rerunOf: r.source });
      return job
        ? { outcome: 'applied', message: `Queued a review of ${r.headSha.slice(0, 12)}, the current head of pull request #${pr.prNumber} (job ${job.id}). Earlier reviews and threads are kept.` }
        : { outcome: 'noop', message: `A review of ${r.headSha.slice(0, 12)} for this command exists already.` };
    }

    case 'steer': {
      if (closed) return { outcome: 'refused', message: `${ref} is ${r.subjectState}, so the instructions were not used.` };
      if (!r.text.trim()) return { outcome: 'refused', message: 'Nothing to pass on: write the instructions after `steer`.' };
      const pr = workflowPullRequest(db, r.repo.id, r.issue, r.pullRequest);
      if (!pr || pr.state !== 'open') return { outcome: 'refused', message: `${ref} has no open Updraft pull request yet. Steering is applied to a pull request's next coding run: comment again on the pull request once it is open, or edit the issue.` };
      if (!reviseActive(config, r.cfg)) return { outcome: 'refused', message: `Revisions are off for ${r.repo.fullName}, so the instructions cannot start a coding run.` };
      const reviewId = `steer:${r.source}`;
      const revision: RevisionRequest = {
        trigger: 'changes_requested',
        pullRequest: { number: pr.prNumber, url: pr.prUrl, branch: pr.branch },
        sourceRunId: pr.sourceRunId,
        originalEventId: pr.originalEventId,
        review: { id: reviewId, url: r.url, author: r.actor, submittedAt: nowIso(now), body: r.text, comments: [], omittedComments: 0, ...(r.headSha ? { headSha: r.headSha } : {}) },
      };
      const res = enqueueRevision(
        db,
        { repoId: r.repo.id, reviewId, prNumber: pr.prNumber, reviewer: r.actor, trigger: 'changes_requested', reviewUrl: r.url, submittedAt: revision.review.submittedAt, job: revisionJob(r.repo, pr, revision), max: r.cfg.maxRevisions ?? DEFAULT_MAX_REVISIONS },
        now,
      );
      if (res.status === 'over-limit') return { outcome: 'refused', message: `Pull request #${pr.prNumber} reached its revision limit (${res.count}); the instructions were recorded but start no run.` };
      if (res.status === 'duplicate') return { outcome: 'noop', message: 'These instructions were already queued.' };
      const paused = activeControlPause(db, r.repo.id, r.issue);
      if (paused) holdPausedJob(db, res.job, pausedReason(paused.by, paused.source), now);
      return {
        outcome: 'applied',
        message: `${paused ? 'Recorded for the next coding run once resumed' : `Queued a coding run (job ${res.job.id})`} on pull request #${pr.prNumber} with these instructions, treated as a change request: the next review checks them too. A run already in progress does not see them.`,
      };
    }
  }
}
