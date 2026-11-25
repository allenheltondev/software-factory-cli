/**
 * A workflow: one issue's whole story across the Cloud jobs that work on it (#136, #139). A
 * labeled issue's job, the review loop's jobs on its pull request (a review, a push, a CI fix)
 * and their retries all belong to one workflow, so the console can show them as one timeline and
 * the reconciler (workflows/reconcile.ts) can tell legitimate waits from work that stopped.
 *
 * Identity: `<repositoryId>-i<issue>`, by the repository's GitHub id (stable across renames). A
 * pull request is mapped to its issue's workflow once a job reports opening it; a pull request
 * event Updraft never saw opened (published before workflows existed) gets `<repositoryId>-p<n>`.
 * A label applied again after the workflow finished, or blocked, starts a new generation of the
 * same workflow; a retry does not.
 *
 * Everything here is derived from what Updraft itself recorded (the job, the runner's checked
 * finish detail, the reconciler's own reads of GitHub), never from text an agent wrote.
 */
import type { Job, JobFinishDetail } from '../store/store.js';
import { isFailure } from '../store/store.js';
import type { JobLoop, LoopStage } from '../jobs/lifecycle.js';

export type WorkflowStatus = 'active' | 'waiting' | 'blocked' | 'finished';

/** Where a workflow is: the review loop's stage, or the step before it has one. */
export type WorkflowStage = 'implementing' | 'reviewing-loop' | 'awaiting-sign-in' | 'publish-failed' | LoopStage | 'done' | 'failed';

export interface Workflow {
  workflowId: string;
  installationId: number;
  repository: string;
  repositoryId: number;
  issue?: number;
  pullRequest?: number;
  prUrl?: string;
  /** 1 for the first labeled run; +1 each time the issue is labeled again after it finished or blocked. */
  generation: number;
  status: WorkflowStatus;
  stage: WorkflowStage;
  /** A code for why it waits or is blocked (needs_human, job_failed, ci_pending, stalled, ...). */
  reason?: string;
  /** The same, in words, and what a person can do next. */
  message?: string;
  nextAction?: string;
  /** The job running now, or the last one. */
  lastJobId?: string;
  /** When the reconciler looks at it next (ISO); absent: nothing to check. */
  nextCheckAt?: string;
  /** Since when it has waited in its current stage (ISO). */
  waitingSince?: string;
  /** CI re-dispatches the reconciler made for the current head, and the head they were for. */
  recoveries?: number;
  recoveredSha?: string;
  createdAt: string;
  updatedAt: string;
  /** Optimistic concurrency: incremented on every save. */
  version: number;
}

export type WorkflowEventKind = 'job_started' | 'job_finished' | 'ci_recovered' | 'ci_checked' | 'blocked' | 'finished' | 'waiting' | 'label_recovered' | 'finish_recovered';

/** One entry of a workflow's timeline. `id` is immutable and unique: recording an event twice changes nothing. */
export interface WorkflowEvent {
  id: string;
  at: string;
  /** The workflow's version this event came with: orders events of the same instant. */
  seq?: number;
  kind: WorkflowEventKind;
  generation: number;
  jobId?: string;
  /** What started the job: issues, pull_request_review, check_suite, ... */
  eventName?: string;
  /** A retry of an earlier job, from the console or a redelivery. */
  retry?: boolean;
  outcome?: string;
  stage?: WorkflowStage;
  prNumber?: number;
  prUrl?: string;
  /** The steps the job reported: role (implement, review, revision), agent profile and outcome. */
  steps?: { kind: string; agent?: string; outcome?: string; usage?: StepUsage }[];
  /** The job ran on a Claude subscription worker: its cost is an estimate, not what was billed. */
  subscription?: boolean;
  loop?: Pick<JobLoop, 'rounds' | 'maxRevisions' | 'reviews' | 'verdict'>;
  headSha?: string;
  /** In Updraft's own words. */
  message?: string;
}

/** What one step reported it used: tokens, the agent's own cost estimate, its duration. */
export interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** A job that waits for a Claude sign-in is blocked once it has waited this long. */
export const SIGN_IN_LIMIT_MS = 24 * 60 * 60 * 1000;
/** After a job's maximum duration, how long its finish has to be recorded before the reconciler looks at the job itself. */
export const FINISH_GRACE_MS = 15 * 60 * 1000;

/** How long a CI wait goes before the reconciler first looks at GitHub itself. */
export const CI_FIRST_CHECK_MS = 15 * 60 * 1000;
/** Between its looks while checks are still pending. */
export const CI_RECHECK_MS = 15 * 60 * 1000;
/** A head whose checks have not finished after this is blocked: a person has to look. */
export const CI_WAIT_LIMIT_MS = 24 * 60 * 60 * 1000;
/** Missed check events the reconciler re-dispatches for one head, at most. */
export const MAX_CI_RECOVERIES = 2;
/** A loop stage that waits for an event (a review, a push) is looked at after this, and blocked after STALL_LIMIT_MS. */
export const STALL_CHECK_MS = 2 * 60 * 60 * 1000;
export const STALL_LIMIT_MS = 6 * 60 * 60 * 1000;

const ISSUE_EVENTS = new Set(['issues']);

export function workflowIdFor(repositoryId: number, o: { issue?: number; pullRequest?: number }): string | null {
  if (o.issue !== undefined) return `${repositoryId}-i${o.issue}`;
  if (o.pullRequest !== undefined) return `${repositoryId}-p${o.pullRequest}`;
  return null;
}

export const WORKFLOW_ID = /^[0-9]{1,20}-[ip][0-9]{1,10}$/;

/** A retry: a console retry or a GitHub redelivery a failed job gave its claim back for. */
export const isRetryDelivery = (job: Pick<Job, 'deliveryId'>) => job.deliveryId.startsWith('retry-');

const iso = (ms: number) => new Date(ms).toISOString();

function stageOfStart(job: Pick<Job, 'eventName'>): WorkflowStage {
  if (ISSUE_EVENTS.has(job.eventName)) return 'implementing';
  if (job.eventName === 'check_suite') return 'fixing-ci';
  return 'reviewing-loop';
}

/** A new workflow for a job's first event. */
export function newWorkflow(job: Pick<Job, 'installationId' | 'repository' | 'repositoryId' | 'issue' | 'pullRequest'>, workflowId: string, at: number): Workflow {
  return {
    workflowId,
    installationId: job.installationId,
    repository: job.repository,
    repositoryId: job.repositoryId,
    ...(job.issue !== undefined ? { issue: job.issue } : {}),
    ...(job.pullRequest !== undefined ? { pullRequest: job.pullRequest } : {}),
    generation: 1,
    status: 'active',
    stage: 'implementing',
    createdAt: iso(at),
    updatedAt: iso(at),
    version: 0,
  };
}

const clearWait = (w: Workflow): Workflow => {
  const { reason: _r, message: _m, nextAction: _n, nextCheckAt: _c, waitingSince: _w, ...rest } = w;
  return rest as Workflow;
};

/** A job of the workflow was launched. */
export function onJobStarted(w: Workflow, job: Pick<Job, 'jobId' | 'eventName' | 'deliveryId' | 'pullRequest'> & Partial<Pick<Job, 'expiresAt' | 'native'>>, at: number): { workflow: Workflow; event: WorkflowEvent } {
  const retry = isRetryDelivery(job);
  // Labeled again once it had ended: a new generation, not a retry.
  const again = ISSUE_EVENTS.has(job.eventName) && !retry && (w.status === 'finished' || w.status === 'blocked') && w.lastJobId !== undefined;
  const generation = again ? w.generation + 1 : w.generation;
  const workflow: Workflow = {
    ...clearWait(w),
    generation,
    status: 'active',
    stage: stageOfStart(job),
    lastJobId: job.jobId,
    ...(job.pullRequest !== undefined && w.pullRequest === undefined ? { pullRequest: job.pullRequest } : {}),
    // A new head is coming: what the reconciler did for the last one no longer counts.
    ...(job.eventName !== 'check_suite' ? { recoveries: 0 } : {}),
    // Looked at once the job could no longer be running: a finish that was never recorded is found then.
    ...(job.expiresAt !== undefined ? { nextCheckAt: iso(job.expiresAt + FINISH_GRACE_MS) } : {}),
    updatedAt: iso(at),
  };
  return {
    workflow,
    event: {
      id: `${job.jobId}:started`,
      at: iso(at),
      kind: 'job_started',
      generation,
      jobId: job.jobId,
      eventName: job.eventName,
      ...(retry ? { retry: true } : {}),
      ...(job.native ? { subscription: true } : {}),
      stage: workflow.stage,
    },
  };
}

/**
 * A job of the workflow finished, with the runner's checked detail (or none: it never reported,
 * its microVM is gone). What state the workflow is in now follows from where the review loop
 * left the pull request, and from the outcome.
 */
export function onJobFinished(
  w: Workflow,
  job: Pick<Job, 'jobId' | 'eventName'>,
  outcome: string,
  detail: JobFinishDetail | undefined,
  at: number,
): { workflow: Workflow; event: WorkflowEvent } {
  // A later job of the workflow has started since: this one's finish is history only.
  const superseded = w.lastJobId !== undefined && w.lastJobId !== job.jobId && w.status === 'active';
  const loop = detail?.loop;
  const prNumber = detail?.prNumber;
  const base: Workflow = {
    ...w,
    ...(prNumber !== undefined && w.pullRequest === undefined ? { pullRequest: prNumber } : {}),
    ...(detail?.prUrl && !w.prUrl ? { prUrl: detail.prUrl } : {}),
    updatedAt: iso(at),
  };
  const event: WorkflowEvent = {
    id: `${job.jobId}:finished`,
    at: iso(at),
    kind: 'job_finished',
    generation: w.generation,
    jobId: job.jobId,
    eventName: job.eventName,
    outcome,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(detail?.prUrl ? { prUrl: detail.prUrl } : {}),
    ...(detail?.steps?.length ? { steps: detail.steps.map((s) => ({ kind: s.kind, ...(s.agent ? { agent: s.agent } : {}), ...(s.outcome ? { outcome: s.outcome } : {}), ...(usageOf(s.usage) ? { usage: usageOf(s.usage)! } : {}) })) } : {}),
    ...(loop ? { loop: { rounds: loop.rounds, reviews: loop.reviews, ...(loop.maxRevisions !== undefined ? { maxRevisions: loop.maxRevisions } : {}), ...(loop.verdict ? { verdict: loop.verdict } : {}) } } : {}),
  };
  if (superseded) return { workflow: base, event: { ...event, message: 'A later job of this workflow had already started.' } };

  const next = detail?.updraftOutcome === 'publish-failed' && outcome === 'succeeded'
    ? { ...clearWait(base), status: 'blocked' as const, stage: 'publish-failed' as const, reason: 'publish_failed', message: 'The agent finished, but its work could not be published to GitHub.', nextAction: 'Open the job to see why, fix it, then apply the label again on GitHub: the run\'s work is kept, and publication is tried again.' }
    : settle(clearWait(base), outcome, loop?.stage, at);
  return { workflow: next, event: { ...event, stage: next.stage } };
}

function settle(w: Workflow, outcome: string, stage: LoopStage | undefined, at: number): Workflow {
  const waiting = (s: WorkflowStage, reason: string, message: string, checkIn: number | null, nextAction?: string): Workflow => ({
    ...w,
    status: 'waiting',
    stage: s,
    reason,
    message,
    ...(nextAction ? { nextAction } : {}),
    waitingSince: iso(at),
    ...(checkIn !== null ? { nextCheckAt: iso(at + checkIn) } : {}),
  });
  const blocked = (s: WorkflowStage, reason: string, message: string, nextAction: string): Workflow => ({ ...w, status: 'blocked', stage: s, reason, message, nextAction });
  const finished = (s: WorkflowStage): Workflow => ({ ...w, status: 'finished', stage: s });

  if (isFailure(outcome) && outcome !== 'superseded') {
    if (outcome === 'microvm_gone') {
      return blocked('failed', 'job_lost', 'The job stopped without reporting how it ended: its microVM is gone.', 'Retry the job from its page.');
    }
    return blocked('failed', 'job_failed', `The last job ended ${outcome}.`, 'Open the job to see why, then retry it from its page.');
  }
  switch (stage) {
    case 'merged':
      return finished('merged');
    case 'closed':
      return finished('closed');
    case 'ready-to-merge':
      return waiting('ready-to-merge', 'ready_for_person', 'Review and checks are done: the pull request is ready for a person to merge.', null, 'Merge the pull request.');
    case 'needs-human':
      return blocked('needs-human', 'needs_human', 'The review loop stopped for a person: its revision rounds ran out, or something only a person can decide.', 'Read the pull request\'s last comments and act on them.');
    case 'waiting-for-ci':
      return waiting('waiting-for-ci', 'ci_pending', "Waiting for the pull request's checks. No worker is held while they run.", CI_FIRST_CHECK_MS);
    case 'merging':
      return waiting('merging', 'merging', 'Merging once the merge conditions hold.', STALL_CHECK_MS);
    case undefined:
      // No review loop: an issue run that published, or found nothing to do.
      return finished('done');
    default:
      // awaiting-review, reviewing, changes-requested, revising, fixing-ci: the next job comes from a GitHub event.
      return waiting(stage, 'awaiting_event', 'Waiting for the next step of the review loop to start.', STALL_CHECK_MS);
  }
}

function usageOf(u: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number } | undefined): StepUsage | null {
  if (!u) return null;
  const out: StepUsage = {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const set = (k: keyof StepUsage, v: unknown) => {
    const n = num(v);
    if (n !== undefined) out[k] = n;
  };
  set('inputTokens', u.inputTokens);
  set('outputTokens', u.outputTokens);
  set('costUsd', u.costUsd);
  set('durationMs', u.durationMs);
  return Object.keys(out).length ? out : null;
}

/** A job is waiting for something only a person can give (a Claude sign-in): the workflow waits, and blocks after SIGN_IN_LIMIT_MS. */
export function onJobWaiting(
  w: Workflow,
  job: { jobId?: string; eventName: string },
  why: { reason: string; message: string; nextAction: string },
  at: number,
): { workflow: Workflow; event: WorkflowEvent } {
  const workflow: Workflow = {
    ...clearWait(w),
    status: 'waiting',
    stage: 'awaiting-sign-in',
    reason: why.reason,
    message: why.message,
    nextAction: why.nextAction,
    waitingSince: iso(at),
    nextCheckAt: iso(at + SIGN_IN_LIMIT_MS),
    ...(job.jobId ? { lastJobId: job.jobId } : {}),
    updatedAt: iso(at),
  };
  return {
    workflow,
    event: { id: `${job.jobId ?? 'pending'}:waiting:${why.reason}`, at: iso(at), kind: 'waiting', generation: w.generation, ...(job.jobId ? { jobId: job.jobId } : {}), eventName: job.eventName, stage: 'awaiting-sign-in', message: why.message },
  };
}
