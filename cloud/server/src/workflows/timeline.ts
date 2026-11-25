/**
 * The workflow timeline's cross-cutting rules (#139), kept apart from the state machine in
 * workflow.ts so that every writer (the recorder, the reconciler, recovery, the queue, stop and
 * resume) gets them the same way:
 *
 *   ordering    events are ordered by the workflow version they were saved with (`seq`), which is
 *               the order the changes were actually made in, whatever the writers' clocks said;
 *               the recorded time only orders events that have no version (rebuilt history)
 *   waits       a change that ends a wait (sign-in, CI, a person, the loop's next event) carries
 *               how long it waited, measured from the workflow's own `waitingSince`; a wait for
 *               capacity is measured by the admission queue's own entry, and a pause by its record
 *   control     a stop's pause and a resume, as state and as timeline events, the same whether the
 *               console, the reconciler or a later steering command records them
 *   retention   how long each record is kept, so the console can say what is gone and why
 */
import { CI_RECHECK_MS, type PauseControl, type Workflow, type WorkflowEvent, type WorkflowWait } from './workflow.js';

/** Workflow records are kept this long after their last change; each event this long after it was recorded. */
export const WORKFLOW_RETENTION_DAYS = 90;
export const EVENT_RETENTION_DAYS = 90;
/** Job summaries (what a timeline's job links open) are kept this long (store TTL). */
export const JOB_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A workflow's events in the order they happened. Every event saved with its workflow change has
 * that change's version (`seq`): versions are strictly increasing per workflow, so they order
 * events exactly even when two writers' clocks disagree or a late writer records an earlier
 * instant. Events without one (rebuilt from job records) are ordered by time, then id.
 */
export function orderEvents<E extends Pick<WorkflowEvent, 'at' | 'seq' | 'id'>>(events: readonly E[]): E[] {
  const byTime = (a: E, b: E) => a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id);
  if (events.every((e) => typeof e.seq === 'number')) return [...events].sort((a, b) => a.seq! - b.seq! || a.id.localeCompare(b.id));
  return [...events].sort(byTime);
}

/** What a waiting workflow waits for, as a code the console names. */
export function waitKindOf(w: Pick<Workflow, 'stage' | 'reason'>): WorkflowWait['for'] {
  switch (w.stage) {
    case 'queued':
      return 'capacity';
    case 'awaiting-sign-in':
      return 'sign_in';
    case 'waiting-for-ci':
      return 'ci';
    case 'ready-to-merge':
      return 'person';
    case 'merging':
      return 'merge';
    default:
      return w.reason === 'ready_for_person' ? 'person' : 'review_event';
  }
}

const seconds = (since: number, until: number) => Math.max(0, Math.round((until - since) / 1000));

/** A wait of `kind` from `since` (epoch ms or ISO) until `at`. */
export function waitFrom(kind: WorkflowWait['for'], since: number | string, at: number): WorkflowWait | undefined {
  const from = typeof since === 'number' ? since : Date.parse(since);
  if (!Number.isFinite(from)) return undefined;
  return { for: kind, since: iso(from), seconds: seconds(from, at) };
}

/**
 * The wait a change ends, if it ends one: the workflow waited (since `waitingSince`) and now it
 * does not, or waits again from a new instant. A wait for capacity is left to the queue, which
 * measures it from its own entry (it may have started before the workflow knew of it).
 */
export function endedWait(previous: Workflow | null, next: Workflow, at: number): WorkflowWait | undefined {
  if (!previous || previous.status !== 'waiting' || !previous.waitingSince || previous.stage === 'queued') return undefined;
  if (next.status === 'waiting' && next.waitingSince === previous.waitingSince) return undefined;
  return waitFrom(waitKindOf(previous), previous.waitingSince, at);
}

/** The workflow's own state, without what is absent (a record never holds an undefined value). */
export function pauseStateOf(cur: Workflow): NonNullable<Workflow['controlPause']>['previous'] {
  return {
    status: cur.status,
    ...(cur.reason !== undefined ? { reason: cur.reason } : {}),
    ...(cur.message !== undefined ? { message: cur.message } : {}),
    ...(cur.nextAction !== undefined ? { nextAction: cur.nextAction } : {}),
    ...(cur.nextCheckAt !== undefined ? { nextCheckAt: cur.nextCheckAt } : {}),
  };
}

/** A pause as the workflow records it: the stop that made it (its job and request time) and who asked. */
export interface PauseRef {
  jobId: string;
  at: number;
  by: string;
  /** A pause made other than by a console stop (a command): what it was, for its wording. */
  control?: PauseControl;
}

const CODE = /^[a-z][a-z0-9_-]{0,39}$/;

/** A PAUSE record's `control` descriptor, if it is a well-formed one (anything else is ignored). */
export function pauseControlOf(raw: unknown): PauseControl | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if ((c.kind !== 'pause' && c.kind !== 'cancel') || typeof c.source !== 'string' || !CODE.test(c.source)) return undefined;
  return { kind: c.kind, source: c.source, ...(typeof c.by === 'string' && c.by ? { by: c.by.slice(0, 100) } : {}) };
}

/** The words of a pause: a console stop's, or a command's (pause or cancel, and from where). */
function pauseWords(pause: PauseRef): { message: string; nextAction: string } {
  const c = pause.control;
  if (!c) {
    return {
      message: `Automation was paused by ${pause.by}. The stopped job and existing pull request are preserved.`,
      nextAction: `Resume automation from this workflow's page (nothing is run again), or retry job ${pause.jobId} from its page while it is still kept.`,
    };
  }
  const who = c.by ?? pause.by;
  const from = c.source.replace(/[_-]/g, ' ');
  return {
    message: c.kind === 'cancel'
      ? `Automation was canceled by ${who} (${from}). Existing commits and the pull request are preserved.`
      : `Automation was paused by ${who} (${from}). Existing commits and the pull request are preserved.`,
    nextAction: "Resume automation from this workflow's page (nothing is run again).",
  };
}

/**
 * Paused by an authorized stop: blocked, saying so, and looked at again later (the reconciler
 * notices a resume made anywhere). What it said before is kept, and comes back on resume. Paused
 * again by the same stop keeps the state from before the first time.
 */
export function pausedWorkflow(cur: Workflow, pause: PauseRef, at: number): Workflow {
  // The pause ends any wait (the event it comes with says how long that wait was): a resume starts
  // a new one, so paused time is never counted as waiting.
  const { waitingSince: _w, ...rest } = cur;
  return {
    ...rest,
    status: 'blocked',
    reason: 'workflow_paused',
    ...pauseWords(pause),
    nextCheckAt: iso(at + CI_RECHECK_MS),
    updatedAt: iso(at),
    controlPause: { jobId: pause.jobId, at: pause.at, by: pause.by, ...(pause.control ? { control: pause.control } : {}), previous: cur.controlPause?.previous ?? pauseStateOf(cur) },
  };
}

const without = (w: Workflow, ...keys: (keyof Workflow)[]): Workflow => {
  const out = { ...w };
  for (const k of keys) delete out[k];
  return out;
};

/**
 * Resumed: back to what it said before the pause, except what a resume must not carry on. A lost
 * job's retry is never carried on after a resume ("nothing is run again"), and a stopped job's
 * block says it was resumed since, rather than to resume it.
 */
export function resumedWorkflow(cur: Workflow, at: number): Workflow {
  let previous = cur.controlPause?.previous ?? pauseStateOf(cur);
  if (previous.reason === 'job_lost' || (previous.reason === 'recovering' && cur.recovery?.kind === 'lost_job')) {
    previous = { status: 'blocked', reason: 'job_lost', message: 'The job stopped without reporting how it ended; automation was paused and resumed since, so it is not retried automatically.', nextAction: 'Retry the job from its page.' };
  } else if (previous.reason === 'job_canceled') {
    previous = { status: 'blocked', reason: 'job_canceled', message: 'The job was stopped; automation has been resumed since. Its pull request and commits are preserved.', nextAction: 'The next GitHub event (a review, a push, a finished check) continues the workflow; or retry the stopped job from its page.' };
  }
  const restored: Workflow = { ...without(cur, 'controlPause', 'reason', 'message', 'nextAction', 'nextCheckAt', 'waitingSince'), ...previous, updatedAt: iso(at) };
  // Waiting again from now: the wait before the pause was already reported when the pause ended it.
  return restored.status === 'waiting' ? { ...restored, waitingSince: iso(at) } : restored;
}

/**
 * A job of a paused workflow finished (the stopped job, confirmed ended): the pause still holds,
 * so the workflow stays paused, and what the finish settled is what a resume restores.
 */
export function keepPaused(before: Workflow | null, next: Workflow, at: number): Workflow {
  if (!before?.controlPause || next.controlPause) return next;
  const { previous: _p, ...pause } = before.controlPause;
  return pausedWorkflow(next, pause, at);
}

/** What the console says about how much of a workflow's history is kept. */
export interface WorkflowHistory {
  /** Events returned, and older ones left out of this page (or unknown: the read stopped early). */
  shown: number;
  omitted: number;
  complete: boolean;
  workflowRetentionDays: number;
  eventRetentionDays: number;
  jobRetentionDays: number;
  /** The workflow began longer ago than events are kept: its earliest events may have expired. */
  expiredEarlier: boolean;
}

export function historyOf(w: Pick<Workflow, 'createdAt'>, page: { shown: number; omitted: number; complete: boolean }, now: number): WorkflowHistory {
  const created = Date.parse(w.createdAt);
  return {
    ...page,
    workflowRetentionDays: WORKFLOW_RETENTION_DAYS,
    eventRetentionDays: EVENT_RETENTION_DAYS,
    jobRetentionDays: JOB_RETENTION_DAYS,
    expiredEarlier: Number.isFinite(created) && now - created > EVENT_RETENTION_DAYS * DAY_MS,
  };
}
