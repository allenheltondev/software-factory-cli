/**
 * The console's view of workflows (workflows/workflow.ts, #139): a tenant's workflows, newest
 * change first, and one workflow with its timeline. Members only, like the job views. Everything
 * shown is what Updraft recorded: job ids, outcomes, stages, codes and its own words.
 */
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { HeldPause, Store, WorkflowPause } from '../store/store.js';
import type { WorkflowStore } from '../workflows/store.js';
import { historyOf, type WorkflowHistory } from '../workflows/timeline.js';
import { LEGACY_WORKFLOW_ID, reconstructWorkflows, totalsOf, type WorkflowTotals } from '../workflows/view.js';
import { WORKFLOW_ID, type Workflow, type WorkflowEvent, type WorkflowStatus } from '../workflows/workflow.js';

const LIST_LIMIT = 200;
const EVENT_LIMIT = 500;
const JOB_ID = /^job_[A-Za-z0-9_-]{8,64}$/;

/** `paused`: a stop's pause holds it now (the durable PAUSE record, which never expires), whatever its record says. */
export type WorkflowView = Omit<Workflow, 'version' | 'installationId'> & { reconstructed?: true; gaps?: string[]; paused?: true };

const view = (w: Workflow & { reconstructed?: true; gaps?: string[]; paused?: true }): WorkflowView => {
  const { version: _v, installationId: _i, ...rest } = w;
  return rest;
};

const STATUSES: readonly WorkflowStatus[] = ['active', 'waiting', 'blocked', 'finished'];
/** Job records read to rebuild workflows that were never recorded. */
const JOB_LIMIT = 500;

/**
 * A stop's pause of the workflow, as the console shows it: the subject (issue or pull request
 * number) it was found on, which is what resuming it names, and whether this caller may.
 */
export type WorkflowPauseView = WorkflowPause & { subject: number; canResume: boolean };

/** Pauses looked at for the list, at most: far more than a tenant has stopped at once. */
const PAUSE_LIMIT = 500;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The workflow a pause is of, when its own record is gone (kept 90 days after its last change):
 * built from the pause alone, which never expires, so it can still be found and resumed.
 */
function pausedWorkflow(installationId: number, p: HeldPause): Workflow & { gaps: string[] } {
  const issue = p.issue ?? (p.pullRequest === undefined ? p.subject : undefined);
  const workflowId = `${p.repositoryId}-${issue !== undefined ? `i${issue}` : `p${p.pullRequest}`}`;
  const message = `Automation was paused by ${p.by}${p.reason ? ` (${p.reason})` : ''}. The stopped job and existing pull request are preserved.`;
  return {
    workflowId,
    installationId,
    repository: p.repository ?? `repository ${p.repositoryId}`,
    repositoryId: p.repositoryId,
    ...(issue !== undefined ? { issue } : {}),
    ...(p.pullRequest !== undefined ? { pullRequest: p.pullRequest } : {}),
    generation: 1,
    status: 'blocked',
    stage: 'failed',
    reason: 'workflow_paused',
    message,
    nextAction: 'Resume automation from this page: future GitHub events then continue it. Nothing is run again.',
    lastJobId: p.jobId,
    createdAt: iso(p.at),
    updatedAt: iso(p.confirmedAt ?? p.at),
    version: 0,
    gaps: ["This workflow's own record has expired. Only its pause is kept, and it lasts until it is resumed."],
  };
}

export function createWorkflowService({ store, jobs, pauses, github, now = Date.now }: { store: WorkflowStore; jobs?: Pick<Store, 'listRecentJobs'>; pauses?: Pick<Store, 'getWorkflowPause' | 'listWorkflowPauses'>; github: Pick<GitHubFlows, 'member'>; now?: () => number }) {
  /** The pause holding one of these subjects, if any, and the subject it was found on. */
  const pauseOn = async (installationId: number, repositoryId: number, subjects: (number | undefined)[], role: string): Promise<WorkflowPauseView | null> => {
    if (!pauses) return null;
    for (const subject of new Set(subjects)) {
      if (subject === undefined) continue;
      const pause = await pauses.getWorkflowPause(installationId, repositoryId, subject).catch(() => null);
      if (pause) return { ...pause, subject, canResume: role === 'owner' };
    }
    return null;
  };
  /** The pauses held now (best effort: none when they cannot be read). */
  const heldPauses = async (installationId: number): Promise<HeldPause[]> => (pauses ? pauses.listWorkflowPauses(installationId, PAUSE_LIMIT).catch(() => []) : []);
  const subjectKeys = (w: Pick<Workflow, 'repositoryId' | 'issue' | 'pullRequest' | 'pastPullRequests'>) =>
    [w.issue, w.pullRequest, ...(w.pastPullRequests ?? []).map((p) => p.number)].filter((n) => n !== undefined).map((n) => `${w.repositoryId}#${n}`);
  /**
   * Paused workflows not among the recorded ones listed: one per pause. Its own record when it is
   * still kept (an older workflow past the list's limit); else built from the pause alone, so paused
   * work can always be found, and resumed, however old.
   */
  const pausedOnly = async (installationId: number, recorded: Workflow[], held: HeldPause[]): Promise<(Workflow & { gaps?: string[]; paused: true })[]> => {
    const has = new Set(recorded.flatMap(subjectKeys));
    const seen = new Set<string>();
    const out: (Workflow & { gaps?: string[]; paused: true })[] = [];
    for (const p of held) {
      const id = `${p.repositoryId}#${p.jobId}#${p.at}`;
      if (seen.has(id) || has.has(`${p.repositoryId}#${p.subject}`)) continue;
      seen.add(id);
      const built = pausedWorkflow(installationId, p);
      if (out.some((o) => o.workflowId === built.workflowId)) continue;
      const kept = await store.getWorkflow(installationId, built.workflowId).catch(() => null);
      out.push({ ...(kept ?? built), paused: true });
    }
    // A pause held on several subjects, or several pauses of one issue, is one workflow.
    return out;
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
    /** Most recently changed first; `status` (or `paused`) and `repository` (OWNER/REPO) narrow the list. */
    async list(caller: Caller, installationId: number, limit?: unknown, filter: { status?: unknown; repository?: unknown } = {}): Promise<{ workflows: WorkflowView[] }> {
      await github.member(caller, installationId);
      const n = Number(limit);
      const max = Number.isSafeInteger(n) && n > 0 ? Math.min(n, LIST_LIMIT) : 50;
      const recorded = await store.listWorkflows(installationId, LIST_LIMIT);
      const held = await heldPauses(installationId);
      const pausedKeys = new Set(held.map((p) => `${p.repositoryId}#${p.subject}`));
      const all: WorkflowView[] = [
        ...recorded.map((w) => view(subjectKeys(w).some((k) => pausedKeys.has(k)) ? { ...w, paused: true } : w)),
        ...(await rebuilt(installationId, recorded)).map((r) => view(r.workflow)),
        ...(await pausedOnly(installationId, recorded, held)).map(view),
      ];
      const paused = filter.status === 'paused';
      const status = STATUSES.find((s) => s === filter.status);
      const repository = typeof filter.repository === 'string' && filter.repository ? filter.repository.toLowerCase() : null;
      return {
        workflows: all
          .filter((w) => (!status || w.status === status) && (!paused || w.paused) && (!repository || w.repository.toLowerCase() === repository))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, max),
      };
    },
    async get(caller: Caller, installationId: number, workflowId: string): Promise<{ workflow: WorkflowView; events: WorkflowEvent[]; totals: WorkflowTotals; history: WorkflowHistory; pause?: WorkflowPauseView }> {
      const member = await github.member(caller, installationId);
      const notFound = () => new FlowError('not_found', 404, 'There is no such workflow in this installation (workflows are kept 90 days after their last change)');
      if (LEGACY_WORKFLOW_ID.test(workflowId)) {
        const found = (await rebuilt(installationId, await store.listWorkflows(installationId, LIST_LIMIT))).find((r) => r.workflow.workflowId === workflowId);
        if (!found) throw notFound();
        return { workflow: view(found.workflow), events: found.events, totals: totalsOf(found.events, now()), history: historyOf(found.workflow, { shown: found.events.length, omitted: 0, complete: false }, now()) };
      }
      if (!WORKFLOW_ID.test(workflowId)) throw notFound();
      const role = member?.summary?.role ?? 'member';
      const w = await store.getWorkflow(installationId, workflowId);
      if (!w) {
        // Gone, but still paused: the pause is shown, and can be resumed, on its own. It is found
        // the way the list found it, so whatever subject it holds (the issue or a pull request).
        const held = pauses ? await pauses.listWorkflowPauses(installationId, PAUSE_LIMIT).catch(() => []) : [];
        const p = held.find((h) => pausedWorkflow(installationId, h).workflowId === workflowId);
        if (!p) throw notFound();
        const { repositoryId: _r, ...pause } = p;
        const gone = pausedWorkflow(installationId, p);
        return { workflow: view({ ...gone, paused: true }), events: [], totals: totalsOf([], now()), history: { ...historyOf(gone, { shown: 0, omitted: 0, complete: true }, now()), expiredEarlier: true }, pause: { ...pause, canResume: role === 'owner' } };
      }
      const [page, pause] = await Promise.all([store.listWorkflowHistory(installationId, workflowId, EVENT_LIMIT), pauseOn(installationId, w.repositoryId, [w.issue, w.pullRequest], role)]);
      // Totals are of the events shown: with older ones left out, the history says so.
      return {
        workflow: view(pause ? { ...w, paused: true } : w), events: page.events, totals: totalsOf(page.events, now()),
        history: historyOf(w, { shown: page.events.length, omitted: page.omitted, complete: page.complete }, now()), ...(pause ? { pause } : {}),
      };
    },
    /** The workflow a job belongs to, if it was recorded. */
    async ofJob(caller: Caller, installationId: number, jobId: string): Promise<{ workflowId: string | null }> {
      await github.member(caller, installationId);
      return { workflowId: JOB_ID.test(jobId) ? await store.workflowOfJob(installationId, jobId) : null };
    },
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
