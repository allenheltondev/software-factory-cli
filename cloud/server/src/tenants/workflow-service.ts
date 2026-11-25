/**
 * The console's view of workflows (workflows/workflow.ts, #139): a tenant's workflows, newest
 * change first, and one workflow with its timeline. Members only, like the job views. Everything
 * shown is what Updraft recorded: job ids, outcomes, stages, codes and its own words.
 */
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { Store, WorkflowPause } from '../store/store.js';
import type { WorkflowStore } from '../workflows/store.js';
import { LEGACY_WORKFLOW_ID, reconstructWorkflows, totalsOf, type WorkflowTotals } from '../workflows/view.js';
import { WORKFLOW_ID, type Workflow, type WorkflowEvent, type WorkflowStatus } from '../workflows/workflow.js';

const LIST_LIMIT = 200;
const EVENT_LIMIT = 500;
const JOB_ID = /^job_[A-Za-z0-9_-]{8,64}$/;

export type WorkflowView = Omit<Workflow, 'version' | 'installationId'> & { reconstructed?: true; gaps?: string[] };

const view = (w: Workflow & { reconstructed?: true; gaps?: string[] }): WorkflowView => {
  const { version: _v, installationId: _i, ...rest } = w;
  return rest;
};

const STATUSES: readonly WorkflowStatus[] = ['active', 'waiting', 'blocked', 'finished'];
/** Job records read to rebuild workflows that were never recorded. */
const JOB_LIMIT = 500;

/** A stop's pause of the workflow, as the console shows it, and whether this caller may resume it. */
export type WorkflowPauseView = WorkflowPause & { canResume: boolean };

export function createWorkflowService({ store, jobs, pauses, github, now = Date.now }: { store: WorkflowStore; jobs?: Pick<Store, 'listRecentJobs'>; pauses?: Pick<Store, 'getWorkflowPause'>; github: Pick<GitHubFlows, 'member'>; now?: () => number }) {
  /** The pause holding the workflow's issue or pull request, if any. It outlives the stopped job's records. */
  const pauseOf = async (w: Workflow, role: string): Promise<WorkflowPauseView | null> => {
    if (!pauses) return null;
    for (const subject of [w.issue, w.pullRequest]) {
      if (subject === undefined) continue;
      const pause = await pauses.getWorkflowPause(w.installationId, w.repositoryId, subject).catch(() => null);
      if (pause) return { ...pause, canResume: role === 'owner' };
    }
    return null;
  };
  /** Workflows rebuilt from job records that no recorded workflow covers. */
  const rebuilt = async (installationId: number, recorded: Workflow[]) => {
    if (!jobs) return [];
    const has = new Set(recorded.flatMap((w) => [
      ...(w.issue !== undefined ? [`${w.repository.toLowerCase()}#i${w.issue}`] : []),
      ...(w.pullRequest !== undefined ? [`${w.repository.toLowerCase()}#p${w.pullRequest}`] : []),
    ]));
    const summaries = await jobs.listRecentJobs(installationId, JOB_LIMIT).catch(() => []);
    return reconstructWorkflows(installationId, summaries, (repo, o) => has.has(`${repo.toLowerCase()}#${o.issue !== undefined ? `i${o.issue}` : `p${o.pullRequest}`}`));
  };
  return {
    /** Most recently changed first; `status` and `repository` (OWNER/REPO) narrow the list. */
    async list(caller: Caller, installationId: number, limit?: unknown, filter: { status?: unknown; repository?: unknown } = {}): Promise<{ workflows: WorkflowView[] }> {
      await github.member(caller, installationId);
      const n = Number(limit);
      const max = Number.isSafeInteger(n) && n > 0 ? Math.min(n, LIST_LIMIT) : 50;
      const recorded = await store.listWorkflows(installationId, LIST_LIMIT);
      const all: WorkflowView[] = [...recorded.map(view), ...(await rebuilt(installationId, recorded)).map((r) => view(r.workflow))];
      const status = STATUSES.find((s) => s === filter.status);
      const repository = typeof filter.repository === 'string' && filter.repository ? filter.repository.toLowerCase() : null;
      return {
        workflows: all
          .filter((w) => (!status || w.status === status) && (!repository || w.repository.toLowerCase() === repository))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, max),
      };
    },
    async get(caller: Caller, installationId: number, workflowId: string): Promise<{ workflow: WorkflowView; events: WorkflowEvent[]; totals: WorkflowTotals; pause?: WorkflowPauseView }> {
      const member = await github.member(caller, installationId);
      const notFound = () => new FlowError('not_found', 404, 'There is no such workflow in this installation (workflows are kept 90 days after their last change)');
      if (LEGACY_WORKFLOW_ID.test(workflowId)) {
        const found = (await rebuilt(installationId, await store.listWorkflows(installationId, LIST_LIMIT))).find((r) => r.workflow.workflowId === workflowId);
        if (!found) throw notFound();
        return { workflow: view(found.workflow), events: found.events, totals: totalsOf(found.events, now()) };
      }
      const w = WORKFLOW_ID.test(workflowId) ? await store.getWorkflow(installationId, workflowId) : null;
      if (!w) throw notFound();
      const [events, pause] = await Promise.all([store.listWorkflowEvents(installationId, workflowId, EVENT_LIMIT), pauseOf(w, member?.summary?.role ?? 'member')]);
      return { workflow: view(w), events, totals: totalsOf(events, now()), ...(pause ? { pause } : {}) };
    },
    /** The workflow a job belongs to, if it was recorded. */
    async ofJob(caller: Caller, installationId: number, jobId: string): Promise<{ workflowId: string | null }> {
      await github.member(caller, installationId);
      return { workflowId: JOB_ID.test(jobId) ? await store.workflowOfJob(installationId, jobId) : null };
    },
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
