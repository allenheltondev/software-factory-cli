import type { WorkflowEvent, WorkflowPause, WorkflowView } from '../api/client';

export const LIFECYCLE_STAGES = [
  'Triage / routing', 'Implementation', 'Verification / publication', 'Review', 'Revision / remediation', 'Delivery',
] as const;
export type LifecycleStatus = 'Completed' | 'Running' | 'Waiting' | 'Paused' | 'Failed' | 'Canceled' | 'Skipped' | 'Not observed' | 'Unknown';
export interface LifecycleAttempt {
  id: string;
  event: WorkflowEvent;
  label: string;
  status: LifecycleStatus;
  agent?: string;
  adapter?: string;
  model?: string;
  modelSource?: string;
  tier?: string;
  durationMs?: number;
  waitSeconds?: number;
  waitFor?: string;
}
const result = (outcome?: string): LifecycleStatus => outcome === 'succeeded' || outcome === 'published' ? 'Completed'
  : outcome === 'canceled' ? 'Canceled' : outcome === 'skipped' || outcome === 'superseded' ? 'Skipped'
    : ['failed', 'verify_failure', 'timeout', 'error', 'publish-failed'].includes(outcome ?? '') ? 'Failed' : 'Unknown';
export const lifecycleStage = (stage?: string): number | undefined => {
  if (stage === 'implementing') return 1;
  if (['awaiting-review', 'reviewing', 'reviewing-loop', 'changes-requested'].includes(stage ?? '')) return 3;
  if (['revising', 'fixing-ci', 'needs-human'].includes(stage ?? '')) return 4;
  if (['waiting-for-ci', 'publish-failed'].includes(stage ?? '')) return 2;
  if (['ready-to-merge', 'merging', 'merged', 'closed', 'done'].includes(stage ?? '')) return 5;
  if (stage === 'awaiting-sign-in' || stage === 'queued') return 0;
};

/** Input is one authorized workflow response. Never join jobs by issue number or timestamp.
 * Only the runner's ordered steps establish loop edges; event time orders the history, not causality.
 */
export function workflowLifecycle(workflow: WorkflowView, input: readonly WorkflowEvent[], run: number, pause?: WorkflowPause, now = Date.now()) {
  const scoped = input.filter((e) => e.generation === run);
  const versioned = scoped.every((e) => typeof e.seq === 'number');
  const events = [...scoped]
    .sort((a, b) => versioned ? a.seq! - b.seq! || a.id.localeCompare(b.id) : a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))
    .filter((e, i, all) => all.findIndex((other) => other.id === e.id) === i);
  const stages = LIFECYCLE_STAGES.map((label) => ({ label, status: 'Not observed' as LifecycleStatus, attempts: [] as LifecycleAttempt[] }));
  const edges = new Map<string, number>();
  const edge = (from: number, to: number) => { const key = `${from}-${to}`; edges.set(key, (edges.get(key) ?? 0) + 1); };
  const add = (stage: number, e: WorkflowEvent, id: string, label: string, status: LifecycleStatus, extra: Partial<LifecycleAttempt> = {}) => {
    stages[stage]!.attempts.push({ id, event: e, label, status, ...(e.waited ? { waitSeconds: e.waited.seconds, waitFor: e.waited.for } : {}), ...extra });
    stages[stage]!.status = status;
  };
  const finishedJobs = new Set<string>();
  for (const e of events) {
    if (e.kind === 'job_started') add(0, e, `${e.id}:trigger`, `${e.retry ? 'Retry' : 'Trigger'}: ${e.eventName ?? 'unknown'}`, 'Completed');
    if (e.kind === 'job_finished' || e.kind === 'finish_recovered') {
      // Recovery and the original finish describe the same job, not two attempts.
      if (e.jobId && finishedJobs.has(e.jobId)) continue;
      if (e.jobId) finishedJobs.add(e.jobId);
      if (e.routing) add(0, e, `${e.id}:routing`, `Routing: ${e.routing.source}${e.routing.hops ? ` · ${e.routing.hops} routing hops` : ''}`, 'Completed', { tier: e.routing.tier });
      let previous: number | undefined;
      for (const [i, s] of (e.steps ?? []).entries()) {
        const stage = s.kind === 'implement' ? 1 : s.kind === 'review' ? 3 : s.kind === 'revision' ? 4 : undefined;
        if (stage === undefined) continue;
        if (previous === 4 && stage === 3) edge(4, 3);
        add(stage, e, `${e.id}:${i}`, `${s.kind}${e.eventName === 'check_suite' && stage === 4 ? ' (CI repair)' : ''}`, result(s.outcome), {
          agent: s.agent, adapter: s.adapter, model: s.model, modelSource: s.modelSource, tier: e.routing?.tier, durationMs: s.usage?.durationMs,
        });
        if (s.verificationPassed !== undefined || s.publication !== undefined) {
          add(2, e, `${e.id}:${i}:verify`, `Verification: ${s.verificationPassed === undefined ? 'unknown' : s.verificationPassed ? 'passed' : 'failed'}; publication: ${s.publication ?? 'unknown'}`,
            s.verificationPassed === false || s.publication === 'failed' ? 'Failed' : s.publication ? result(s.publication) : 'Completed');
          if (stage === 4) edge(4, 2);
        }
        previous = stage;
      }
      if (e.verificationPassed !== undefined || e.publication) add(2, e, `${e.id}:verification`, `Job verification: ${e.verificationPassed === undefined ? 'unknown' : e.verificationPassed ? 'passed' : 'failed'}; publication: ${e.publication ?? 'unknown'}`, e.verificationPassed === false || e.publication === 'failed' ? 'Failed' : 'Completed');
      if (['merged', 'closed', 'ready-to-merge', 'merging', 'done'].includes(e.stage ?? '')) {
        add(5, e, `${e.id}:delivery`, e.stage!, e.stage === 'ready-to-merge' || e.stage === 'merging' ? 'Waiting' : 'Completed');
        if (previous === 3) edge(3, 5);
      }
      if (e.outcome && e.outcome !== 'succeeded' && e.outcome !== 'superseded') {
        const start = events.find((s) => s.jobId === e.jobId && s.kind === 'job_started');
        add(previous ?? lifecycleStage(start?.stage) ?? 0, e, `${e.id}:outcome`, `Job: ${e.outcome}`, result(e.outcome));
      }
    } else if (e.kind !== 'job_started') {
      const stage = lifecycleStage(e.stage) ?? 0;
      const control = e.control?.action;
      const status: LifecycleStatus = control === 'paused' || control === 'stop_requested' ? 'Paused' : control === 'canceled' ? 'Canceled' : control === 'resumed' ? 'Completed'
        : e.kind === 'blocked' || e.kind === 'label_missed' ? 'Failed' : e.kind === 'waiting' ? 'Waiting' : e.kind === 'finished' || e.kind === 'admitted' ? 'Completed' : 'Unknown';
      add(stage, e, e.id, e.control ? `${control}: ${e.control.by}${e.control.reason ? ` · ${e.control.reason}` : ''}` : e.message ?? e.stage ?? e.kind, status);
    }
  }
  const current = run === workflow.generation;
  if (current && workflow.status === 'active') {
    for (const e of events.filter((e) => e.kind === 'job_started' && e.jobId && !finishedJobs.has(e.jobId))) {
      const stage = lifecycleStage(e.stage);
      if (stage !== undefined) stages[stage]!.status = 'Running';
    }
  }
  let activeStage = lifecycleStage(workflow.stage);
  if (activeStage === undefined && current) {
    const lastStart = events.findLast((e) => e.kind === 'job_started');
    activeStage = lifecycleStage(lastStart?.stage) ?? 0;
  }
  if (current && workflow.status !== 'finished' && activeStage !== undefined) {
    stages[activeStage]!.status = pause || workflow.paused ? 'Paused' : workflow.reason === 'job_canceled' ? 'Canceled' : workflow.status === 'active' ? 'Running' : workflow.status === 'waiting' ? 'Waiting' : 'Failed';
  }
  const attempts = stages.flatMap((s) => s.attempts);
  // Loop counters are cumulative snapshots, never summed across jobs.
  const reviews = Math.max(stages[3]!.attempts.filter((a) => a.label === 'review').length, ...events.map((e) => e.loop?.reviews ?? 0));
  const revisions = Math.max(stages[4]!.attempts.filter((a) => a.label.startsWith('revision')).length, ...events.map((e) => e.loop?.rounds ?? 0));
  const lastLoop = events.findLast((e) => e.loop !== undefined)?.loop;
  if (revisions === 0 && lastLoop?.rounds === 0 && stages[5]!.attempts.length > 0) stages[4]!.status = 'Skipped';
  const times = events.map((e) => Date.parse(e.occurredAt ?? e.at)).filter(Number.isFinite);
  const elapsedSeconds = times.length ? Math.round(Math.max(0, ((current && workflow.status !== 'finished' ? now : Math.max(...times)) - Math.min(...times)) / 1000)) : undefined;
  return { stages, events, attempts, reviews, revisions, edges: [...edges].map(([key, count]) => ({ from: Number(key[0]), to: Number(key[2]), count })), elapsedSeconds,
    outcome: current ? pause || workflow.paused ? 'Paused' : workflow.stage === 'ready-to-merge' ? 'Awaiting manual merge' : workflow.reason === 'job_canceled' ? 'Canceled' : `${workflow.status}: ${workflow.stage}` : events.findLast((e) => ['merged', 'closed', 'done'].includes(e.stage ?? ''))?.stage ?? events.findLast((e) => e.stage)?.stage ?? 'Unknown historical outcome' };
}
