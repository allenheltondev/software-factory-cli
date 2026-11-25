/**
 * Records what happens to a job on its workflow (workflow.ts): where the launcher, the broker and
 * the quota reconciler call in. Best effort for them: a failure here is logged and never fails a
 * launch or a finish (the job's own record is what decides), and the next event of the workflow
 * repairs its state, since each change is computed from the record as it then is.
 */
import type { Job, JobFinishDetail } from '../store/store.js';
import type { WorkflowStore } from './store.js';
import { newWorkflow, onJobFinished, onJobStarted, onJobWaiting, workflowIdFor, type Workflow, type WorkflowEvent } from './workflow.js';

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
    // The change and its event together: a save that loses the race leaves no event behind, and
    // a replay (its event is recorded already) changes nothing.
    const result = await store.saveWorkflow(next, previous, out.event ? { ...out.event, seq: next.version } : undefined);
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

export function createWorkflowRecorder(o: { store: WorkflowStore; now?: () => number; log?: (entry: Record<string, unknown>) => void }) {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const safely = async (what: string, job: JobRef, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      log({ jobId: job.jobId, warning: `could not record the workflow ${what}: ${(err as Error)?.name ?? 'error'}` });
    }
  };
  return {
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
    /** A job finished: its runner's finish (broker), or the reconciler found its microVM gone. */
    finished: (job: JobRef, outcome: string, detail?: JobFinishDetail) =>
      safely('finish', job, async () => {
        const id = await workflowOfJob(o.store, job);
        if (!id) return;
        const at = now();
        // The pull request the job opened belongs to its issue's workflow from now on.
        if (detail?.prNumber !== undefined && job.issue !== undefined) await o.store.linkPullRequest(job.installationId, job.repositoryId, detail.prNumber, id);
        await updateWorkflow(o.store, job.installationId, id, (w) => onJobFinished(w ?? newWorkflow(job, id, at), job, outcome, detail, at));
      }),
  };
}

export type WorkflowRecorder = ReturnType<typeof createWorkflowRecorder>;
