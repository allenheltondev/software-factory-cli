/**
 * The console's view of workflows (workflows/workflow.ts, #139): a tenant's workflows, newest
 * change first, and one workflow with its timeline. Members only, like the job views. Everything
 * shown is what Updraft recorded: job ids, outcomes, stages, codes and its own words.
 */
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { WorkflowStore } from '../workflows/store.js';
import { WORKFLOW_ID, type Workflow, type WorkflowEvent } from '../workflows/workflow.js';

const LIST_LIMIT = 200;
const EVENT_LIMIT = 500;
const JOB_ID = /^job_[A-Za-z0-9_-]{8,64}$/;

export type WorkflowView = Omit<Workflow, 'version' | 'installationId'>;

const view = (w: Workflow): WorkflowView => {
  const { version: _v, installationId: _i, ...rest } = w;
  return rest;
};

export function createWorkflowService({ store, github }: { store: WorkflowStore; github: Pick<GitHubFlows, 'member'> }) {
  return {
    async list(caller: Caller, installationId: number, limit?: unknown): Promise<{ workflows: WorkflowView[] }> {
      await github.member(caller, installationId);
      const n = Number(limit);
      const workflows = await store.listWorkflows(installationId, Number.isSafeInteger(n) && n > 0 ? Math.min(n, LIST_LIMIT) : 50);
      return { workflows: workflows.map(view) };
    },
    async get(caller: Caller, installationId: number, workflowId: string): Promise<{ workflow: WorkflowView; events: WorkflowEvent[] }> {
      await github.member(caller, installationId);
      const w = WORKFLOW_ID.test(workflowId) ? await store.getWorkflow(installationId, workflowId) : null;
      if (!w) throw new FlowError('not_found', 404, 'There is no such workflow in this installation (workflows are kept 90 days after their last change)');
      return { workflow: view(w), events: await store.listWorkflowEvents(installationId, workflowId, EVENT_LIMIT) };
    },
    /** The workflow a job belongs to, if it was recorded. */
    async ofJob(caller: Caller, installationId: number, jobId: string): Promise<{ workflowId: string | null }> {
      await github.member(caller, installationId);
      return { workflowId: JOB_ID.test(jobId) ? await store.workflowOfJob(installationId, jobId) : null };
    },
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
