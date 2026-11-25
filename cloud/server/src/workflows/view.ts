/**
 * What the console shows of workflows beyond their record (#139): totals computed from a
 * workflow's events, and workflows rebuilt from job records for jobs that ran before workflows
 * were recorded (or whose recording failed). Both are derived on read, never stored, and say
 * what they could not know.
 */
import { createHash } from 'node:crypto';
import type { JobSummary } from '../store/store.js';
import { newWorkflow, onJobFinished, onJobStarted, type Workflow, type WorkflowEvent } from './workflow.js';

export interface WorkflowTotals {
  /** Distinct jobs, and how many of them were retries. */
  jobs: number;
  retries: number;
  /** Steps of the jobs, by role. */
  reviews: number;
  revisions: number;
  inputTokens: number;
  outputTokens: number;
  /** The agents' own cost estimates, summed over the steps that reported one. */
  costUsd: number;
  /** Steps that reported no cost: costUsd leaves them out. */
  stepsWithoutCost: number;
  /** Some job ran on a Claude subscription: its cost is an estimate, not what was billed. */
  subscription: boolean;
  /** Jobs' running time (start to finish, summed) and the workflow's from its first start to its last event (or now, while a job runs). */
  activeSeconds: number;
  wallSeconds: number;
  /** A job has started without a recorded finish: the totals are still growing. */
  running: boolean;
}

/** Totals of a workflow's events: each job counted once, however often its events were recorded. */
export function totalsOf(events: readonly WorkflowEvent[], now: number): WorkflowTotals {
  const t: WorkflowTotals = { jobs: 0, retries: 0, reviews: 0, revisions: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, stepsWithoutCost: 0, subscription: false, activeSeconds: 0, wallSeconds: 0, running: false };
  const started = new Map<string, WorkflowEvent>();
  const finished = new Map<string, WorkflowEvent>();
  for (const e of events) {
    if (!e.jobId) continue;
    if (e.kind === 'job_started' && !started.has(e.jobId)) started.set(e.jobId, e);
    if ((e.kind === 'job_finished' || e.kind === 'finish_recovered') && !finished.has(e.jobId)) finished.set(e.jobId, e);
  }
  const jobs = new Set([...started.keys(), ...finished.keys()]);
  t.jobs = jobs.size;
  for (const id of jobs) {
    const s = started.get(id);
    const f = finished.get(id);
    if (s?.retry) t.retries++;
    if (s?.subscription) t.subscription = true;
    if (s && f) t.activeSeconds += Math.max(0, (Date.parse(f.at) - Date.parse(s.at)) / 1000);
    if (s && !f) t.running = true;
    for (const step of f?.steps ?? []) {
      if (step.kind === 'review') t.reviews++;
      if (step.kind === 'revision') t.revisions++;
      t.inputTokens += step.usage?.inputTokens ?? 0;
      t.outputTokens += step.usage?.outputTokens ?? 0;
      if (step.usage?.costUsd !== undefined) t.costUsd += step.usage.costUsd;
      else t.stepsWithoutCost++;
    }
  }
  const times = events.map((e) => Date.parse(e.at)).filter((n) => Number.isFinite(n));
  if (times.length) t.wallSeconds = Math.max(0, ((t.running ? now : Math.max(...times)) - Math.min(...times)) / 1000);
  t.activeSeconds = Math.round(t.activeSeconds);
  t.wallSeconds = Math.round(t.wallSeconds);
  t.costUsd = Math.round(t.costUsd * 10_000) / 10_000;
  return t;
}

/** A workflow rebuilt from job records: its id names the repository by a digest of its name (job records carry no repository id). */
export const LEGACY_WORKFLOW_ID = /^legacy-[0-9a-f]{12}-[ip][0-9]{1,10}$/;

export interface Reconstructed {
  workflow: Workflow & { reconstructed: true; gaps: string[] };
  events: WorkflowEvent[];
}

const GAPS = [
  'Rebuilt from job records, which are kept 30 days: jobs before that, and what happened between jobs (recoveries, blocks), are not shown.',
  'Review loop jobs are matched to the issue by the pull request its first job reported; ones that cannot be matched appear as a workflow of their own.',
];

const legacyId = (repository: string, o: { issue?: number; pullRequest?: number }) =>
  `legacy-${createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 12)}-${o.issue !== undefined ? `i${o.issue}` : `p${o.pullRequest}`}`;

/**
 * Workflows for job records that no recorded workflow covers, built with the same rules as a
 * recorded one (onJobStarted, onJobFinished) from each job's start and finish. `covered` says
 * whether a recorded workflow has the repository's issue or pull request.
 */
export function reconstructWorkflows(
  installationId: number,
  summaries: readonly JobSummary[],
  covered: (repository: string, o: { issue?: number; pullRequest?: number }) => boolean,
): Reconstructed[] {
  const sorted = [...summaries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A pull request belongs to the issue whose job reported it.
  const owner = new Map<string, number>();
  for (const s of sorted) {
    if (s.issue !== undefined && s.pullRequest === undefined && s.detail?.prNumber !== undefined) owner.set(`${s.repository.toLowerCase()}#${s.detail.prNumber}`, s.issue);
  }
  const groups = new Map<string, { repository: string; issue?: number; pullRequest?: number; jobs: JobSummary[] }>();
  for (const s of sorted) {
    const issue = s.pullRequest !== undefined ? owner.get(`${s.repository.toLowerCase()}#${s.pullRequest}`) : s.issue;
    const key = issue !== undefined ? { issue } : s.pullRequest !== undefined ? { pullRequest: s.pullRequest } : null;
    if (!key || covered(s.repository, key)) continue;
    const id = legacyId(s.repository, key);
    const g = groups.get(id) ?? { repository: s.repository, ...key, jobs: [] };
    g.jobs.push(s);
    groups.set(id, g);
  }
  const out: Reconstructed[] = [];
  for (const [id, g] of groups) {
    const first = g.jobs[0]!;
    let w: Workflow = newWorkflow({ installationId, repository: g.repository, repositoryId: 0, ...(g.issue !== undefined ? { issue: g.issue } : {}), ...(g.pullRequest !== undefined ? { pullRequest: g.pullRequest } : {}) }, id, Date.parse(first.createdAt));
    const events: WorkflowEvent[] = [];
    for (const s of g.jobs) {
      const ref = {
        jobId: s.jobId,
        eventName: s.pullRequest === undefined ? 'issues' : 'pull_request',
        deliveryId: s.deliveryId ?? '',
        ...(s.pullRequest !== undefined ? { pullRequest: s.pullRequest } : {}),
        ...(s.executionMode === 'subscription' ? { native: { workerId: 'subscription' } } : {}),
      };
      const st = onJobStarted(w, ref, Date.parse(s.createdAt));
      w = st.workflow;
      events.push(st.event);
      if (s.status === 'finished') {
        const at = s.finishedAt ? Date.parse(s.finishedAt) : Date.parse(s.createdAt) + (s.durationSeconds ?? 0) * 1000;
        const fin = onJobFinished(w, ref, s.outcome ?? 'unknown', s.detail, at);
        w = fin.workflow;
        events.push(fin.event);
      }
    }
    // Nothing looks at a rebuilt workflow later: it is history.
    const { nextCheckAt: _n, ...rest } = w;
    out.push({ workflow: { ...rest, updatedAt: events.at(-1)?.at ?? rest.updatedAt, reconstructed: true, gaps: GAPS } as Reconstructed['workflow'], events });
  }
  return out;
}
