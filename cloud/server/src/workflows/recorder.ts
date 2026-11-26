/**
 * Records what happens to a job on its workflow (workflow.ts): where the launcher, the broker and
 * the quota reconciler call in. Best effort for them: a failure here is logged and never fails a
 * launch or a finish (the job's own record is what decides), and the next event of the workflow
 * repairs its state, since each change is computed from the record as it then is.
 */
import type { Job, JobFinishDetail, Store, WorkflowPause } from '../store/store.js';
import type { WorkflowStore } from './store.js';
import { actorOf, endedWait, keepPaused, overlayOf, pauseControlOf, pausedWorkflow, pauseNoticedMessage, resumedWorkflow, stillPausedMessage, waitFrom, type PauseRef } from './timeline.js';
import { newWorkflow, onJobFinished, onJobQueued, onJobStarted, onJobWaiting, onQueueCovered, onQueueEnded, workflowIdFor, type Workflow, type WorkflowEvent } from './workflow.js';

type JobRef = Pick<Job, 'jobId' | 'installationId' | 'repository' | 'repositoryId' | 'issue' | 'pullRequest' | 'eventName' | 'deliveryId'> & Partial<Pick<Job, 'expiresAt' | 'native'>>;

const ATTEMPTS = 4;

/**
 * Read, change and save a workflow, again if another writer saved it meanwhile. `change` gets
 * the record as stored (or null) and returns the new one and its event, or null to do nothing.
 */
export async function updateWorkflow(
  store: WorkflowStore,
  installationId: number,
  workflowId: string,
  change: (w: Workflow | null) => { workflow: Workflow; event?: WorkflowEvent } | null,
): Promise<Workflow | null> {
  return (await saveChange(store, installationId, workflowId, change)).workflow;
}

/**
 * The same, saying whether this call made the change (`saved`), or left the record as it found
 * it because `change` declined (another writer's change may be what it returns then).
 */
export async function saveChange(
  store: WorkflowStore,
  installationId: number,
  workflowId: string,
  change: (w: Workflow | null) => { workflow: Workflow; event?: WorkflowEvent } | null,
): Promise<{ workflow: Workflow | null; saved: boolean; replay?: true }> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const previous = await store.getWorkflow(installationId, workflowId);
    const out = change(previous);
    if (!out) return { workflow: previous, saved: false };
    const next = { ...out.workflow, version: (previous?.version ?? 0) + 1 };
    // A change that ends a wait says how long it waited, from the workflow's own record (timeline.ts).
    const waited = out.event && !out.event.waited ? endedWait(previous, next, Date.parse(out.event.at)) : undefined;
    // The change and its event together: a save that loses the race leaves no event behind, and
    // a replay (its event is recorded already) changes nothing.
    const result = await store.saveWorkflow(next, previous, out.event ? { ...out.event, ...(waited ? { waited } : {}), seq: next.version } : undefined);
    if (result === 'saved') return { workflow: next, saved: true };
    if (result === 'replay') return { workflow: previous, saved: false, replay: true };
  }
  throw new Error(`workflow ${workflowId}: too many concurrent changes`);
}

/** The workflow a job belongs to: its issue's, or the one its pull request was mapped to, or the pull request's own. */
export async function workflowOfJob(store: WorkflowStore, job: JobRef): Promise<string | null> {
  if (job.issue !== undefined && job.pullRequest === undefined) return workflowIdFor(job.repositoryId, { issue: job.issue });
  if (job.pullRequest !== undefined) {
    const mapped = await store.workflowOfPullRequest(job.installationId, job.repositoryId, job.pullRequest);
    if (mapped) return mapped;
    return workflowIdFor(job.repositoryId, job.issue !== undefined ? { issue: job.issue } : { pullRequest: job.pullRequest });
  }
  return null;
}

const withControl = (raw: unknown) => {
  const control = pauseControlOf(raw);
  return control ? { control } : {};
};

/** A change's event, with more said about it (a reason code, a wait the change ended). */
const withEvent = (out: { workflow: Workflow; event: WorkflowEvent } | null, more: Partial<WorkflowEvent>) => (out ? { ...out, event: { ...out.event, ...more } } : null);

/** A wait for capacity, measured from the queue entry's own enqueue time. */
const capacityWait = (queue: { enqueuedAt: number } | undefined, at: number): Partial<WorkflowEvent> => {
  const waited = queue ? waitFrom('capacity', queue.enqueuedAt, at) : undefined;
  return waited ? { waited } : {};
};

export function createWorkflowRecorder(o: {
  store: WorkflowStore;
  /** The durable pauses (jobs/stop.ts): a resume keeps a workflow paused while another pause still holds one of its subjects. */
  pauses?: Pick<Store, 'getWorkflowPause'>;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((entry) => console.log(JSON.stringify(entry)));
  /**
   * A pause other than `resumed` holding one of the workflow's subjects now (its issue, its pull
   * request), or `unknown` when a pause could not be read: then nothing may be taken as unpaused.
   */
  const otherPause = async (w: Workflow, resumed: { jobId: string; at: number }): Promise<WorkflowPause | null | 'unknown'> => {
    if (!o.pauses) return null;
    for (const subject of new Set([w.issue, w.pullRequest])) {
      if (subject === undefined) continue;
      let p: WorkflowPause | null;
      try {
        p = await o.pauses.getWorkflowPause(w.installationId, w.repositoryId, subject);
      } catch {
        return 'unknown';
      }
      if (p && !(p.jobId === resumed.jobId && p.at === resumed.at)) return p;
    }
    return null;
  };
  const safely = async (what: string, job: JobRef, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      log({ jobId: job.jobId, warning: `could not record the workflow ${what}: ${(err as Error)?.name ?? 'error'}` });
    }
  };
  return {
    async issueOfPullRequest(installationId: number, repositoryId: number, pullRequest: number) {
      const id = await o.store.workflowOfPullRequest(installationId, repositoryId, pullRequest);
      return id ? (await o.store.getWorkflow(installationId, id))?.issue : undefined;
    },
    /** A job was launched (jobs/launch.ts). */
    started: (job: JobRef) =>
      safely('start', job, async () => {
        const id = await workflowOfJob(o.store, job);
        if (!id) return;
        const at = now();
        await o.store.linkJob(job.installationId, job.jobId, id);
        await updateWorkflow(o.store, job.installationId, id, (w) => onJobStarted(w ?? newWorkflow(job, id, at), job, at));
      }),
    /**
     * A delivery that starts no job yet because it waits for a person (a Claude sign-in): the
     * workflow waits, with why and what to do, and is blocked if no one acts (SIGN_IN_LIMIT_MS).
     */
    waiting: (job: Omit<JobRef, 'jobId'> & { jobId?: string }, why: { reason: string; message: string; nextAction: string }) =>
      safely('wait', { ...job, jobId: job.jobId ?? 'pending' }, async () => {
        const id = await workflowOfJob(o.store, { ...job, jobId: job.jobId ?? 'pending' });
        if (!id) return;
        const at = now();
        if (job.jobId) await o.store.linkJob(job.installationId, job.jobId, id);
        await updateWorkflow(o.store, job.installationId, id, (w) => onJobWaiting(w ?? newWorkflow(job, id, at), job, why, at));
      }),
    /** A delivery waits in the admission queue for capacity (jobs/queue.ts), under its job's stable id. */
    queued: (job: JobRef, why: { reason: string; message: string; code?: string }) =>
      safely('queue', job, async () => {
        const id = await workflowOfJob(o.store, job);
        if (!id) return;
        const at = now();
        await o.store.linkJob(job.installationId, job.jobId, id);
        await updateWorkflow(o.store, job.installationId, id, (w) => withEvent(onJobQueued(w ?? newWorkflow(job, id, at), job, why, at), { reason: why.code ?? why.reason }));
      }),
    /**
     * A queued job was admitted and started (its start is recorded by the launcher): how long it
     * waited, measured by the queue's own entry. History only: the start decided the state.
     */
    queueAdmitted: (job: JobRef, queue: { enqueuedAt: number; reason?: string }) =>
      safely('queue admission', job, async () => {
        const id = await workflowOfJob(o.store, job);
        if (!id) return;
        const at = now();
        await updateWorkflow(o.store, job.installationId, id, (w) => {
          if (!w) return null;
          const generation = w.jobRuns?.find((r) => r.jobId === job.jobId)?.generation ?? w.generation;
          const waited = waitFrom('capacity', queue.enqueuedAt, at);
          return {
            workflow: { ...w, updatedAt: new Date(at).toISOString() },
            event: { id: `${job.jobId}:admitted`, at: new Date(at).toISOString(), kind: 'admitted', generation, jobId: job.jobId, eventName: job.eventName, ...(queue.reason ? { reason: queue.reason } : {}), ...(waited ? { waited } : {}), message: 'Admitted from the queue: capacity became available and the job started.' },
          };
        });
      }),
    /** A queued job will never start, and why. Only a workflow still waiting on it changes. */
    queueEnded: (job: JobRef, why: { reason: string; message: string; nextAction?: string }, queue?: { enqueuedAt: number }) =>
      safely('queue end', job, async () => {
        const id = await workflowOfJob(o.store, job);
        if (!id) return;
        const at = now();
        await updateWorkflow(o.store, job.installationId, id, (w) => (w ? withEvent(onQueueEnded(w, job, why, at), { reason: why.reason, ...capacityWait(queue, at) }) : null));
      }),
    /** A queued job was folded into `holderJobId`, another job of its pull request: the workflow follows that one. */
    queueCovered: (job: JobRef, holderJobId: string | undefined, queue?: { enqueuedAt: number }) =>
      safely('queue cover', job, async () => {
        const id = await workflowOfJob(o.store, job);
        if (!id) return;
        const at = now();
        await updateWorkflow(o.store, job.installationId, id, (w) => (w ? withEvent(onQueueCovered(w, job, holderJobId, at), { reason: 'coalesced', ...capacityWait(queue, at) }) : null));
      }),
    /** A job finished: its runner's finish (broker), or the reconciler found its microVM gone. */
    finished: (job: JobRef, outcome: string, detail?: JobFinishDetail) =>
      safely('finish', job, async () => {
        const id = await workflowOfJob(o.store, job);
        if (!id) return;
        const at = now();
        // The pull request the job opened belongs to its issue's workflow from now on.
        if (detail?.prNumber !== undefined && job.issue !== undefined) await o.store.linkPullRequest(job.installationId, job.repositoryId, detail.prNumber, id);
        await updateWorkflow(o.store, job.installationId, id, (w) => {
          const out = onJobFinished(w ?? newWorkflow(job, id, at), job, outcome, detail, at);
          // A stop's pause outlasts the stopped job's finish: the workflow stays paused (timeline.ts).
          return { ...out, workflow: keepPaused(w, out.workflow, at) };
        });
      }),
    /**
     * An owner asked to stop a job (jobs/stop.ts): its stop paused the workflow's subjects, so the
     * workflow says so now, rather than at the reconciler's next look, and the timeline shows who.
     */
    stopRequested: (job: JobRef, stop: { requestedAt: number; by: string; reason?: string }) =>
      safely('stop', job, async () => {
        const id = (await o.store.workflowOfJob(job.installationId, job.jobId)) ?? (await workflowOfJob(o.store, job));
        if (!id) return;
        const at = now();
        const pause: PauseRef = { jobId: job.jobId, at: stop.requestedAt, by: stop.by };
        await updateWorkflow(o.store, job.installationId, id, (w) => {
          if (!w) return null;
          const generation = w.jobRuns?.find((r) => r.jobId === job.jobId)?.generation ?? w.generation;
          return {
            workflow: pausedWorkflow(w, pause, at),
            event: {
              id: `control:stop:${job.jobId}:${stop.requestedAt}`, at: new Date(at).toISOString(), kind: 'control', generation, jobId: job.jobId,
              control: { action: 'stop_requested', by: actorOf(stop.by) ?? 'an owner', ...(stop.reason ? { reason: stop.reason.slice(0, 200) } : {}) },
              message: 'Stop requested. Automation on this workflow is paused until an owner resumes it; the job\'s commits and pull request are kept.',
            },
          };
        });
      }),
    /**
     * A command (a GitHub mention, control/mentions.ts) paused or canceled the workflow: its PAUSE
     * record, as written (after any takeover), overlays the workflow now, worded as the command,
     * and the timeline shows who. Its synthetic job id (`control-<comment>`) names no job.
     */
    commanded: (where: { installationId: number; workflowId: string }, pause: { jobId: string; at: number; by: string; control?: unknown; reason?: string }) =>
      safely('command', { jobId: pause.jobId, installationId: where.installationId } as JobRef, async () => {
        const control = pauseControlOf(pause.control);
        if (!control) return;
        const at = now();
        const ref: PauseRef = { jobId: pause.jobId, at: pause.at, by: pause.by, control };
        const action = control.kind === 'cancel' ? 'canceled' : 'paused';
        await updateWorkflow(o.store, where.installationId, where.workflowId, (w) => {
          if (!w) return null;
          return {
            workflow: pausedWorkflow(w, ref, at),
            event: {
              id: `control:${action}:${pause.jobId}:${pause.at}`, at: new Date(at).toISOString(), kind: 'control', generation: w.generation, jobId: pause.jobId,
              control: { action, by: actorOf(pause.by) ?? 'an owner', ...(pause.reason ? { reason: pause.reason.slice(0, 200) } : {}) },
              message: pauseNoticedMessage(ref),
            },
          };
        });
      }),
    /**
     * An owner resumed a pause (from the workflow or from the stopped job): the workflow says
     * what it said before, now, and the timeline shows who resumed it and how long it was paused.
     * `workflowId` when the resume named it; otherwise the stopped job's.
     */
    resumed: (where: { installationId: number; workflowId?: string; job?: JobRef }, pause: { jobId: string; at: number }, by: string) =>
      safely('resume', where.job ?? { jobId: pause.jobId, installationId: where.installationId } as JobRef, async () => {
        const id = where.workflowId ?? (where.job ? ((await o.store.workflowOfJob(where.installationId, where.job.jobId)) ?? (await workflowOfJob(o.store, where.job))) : null);
        if (!id) return;
        const at = now();
        // Another stop's pause that still holds one of the workflow's subjects: it stays paused, by that one.
        const current = await o.store.getWorkflow(where.installationId, id);
        const found = current ? await otherPause(current, pause) : null;
        const other: PauseRef | null = found && found !== 'unknown' ? { jobId: found.jobId, at: found.at, by: found.by, ...withControl((found as { control?: unknown }).control) } : null;
        await updateWorkflow(o.store, where.installationId, id, (w) => {
          if (!w) return null;
          const ours = overlayOf(w, pause);
          const waited = waitFrom('pause', w.controlPause && ours ? Math.min(w.controlPause.at, pause.at) : pause.at, at);
          // An overlay of another pause (a stop's, recorded before a command took the pause over) is
          // lifted too, but only once the pauses were read and none holds the workflow any more.
          const free = !ours && !!o.pauses && found === null && !!w.controlPause;
          const next = free
            ? resumedWorkflow(w, at)
            : !ours
            ? { ...w, updatedAt: new Date(at).toISOString() }
            : found === 'unknown'
              // Not known to be unpaused: it stays paused, and the reconciler settles it at its next run.
              ? { ...w, nextCheckAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() }
              : other
                ? pausedWorkflow(w, other, at)
                : resumedWorkflow(w, at);
          return {
            workflow: next,
            event: {
              id: `control:resume:${pause.jobId}:${pause.at}`, at: new Date(at).toISOString(), kind: 'control', generation: w.generation, jobId: pause.jobId,
              control: { action: 'resumed', by: actorOf(by) ?? 'an owner' }, ...(waited ? { waited } : {}),
              message: other
                ? stillPausedMessage(other)
                : found === 'unknown' && ours
                  ? 'Automation resumed. This workflow shows as paused until Updraft confirms no other stop holds it (within minutes).'
                  : 'Automation resumed. Future GitHub events continue the workflow; nothing is run again.',
            },
          };
        });
      }),
  };
}

export type WorkflowRecorder = ReturnType<typeof createWorkflowRecorder>;
