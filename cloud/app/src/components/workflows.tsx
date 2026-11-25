import { Link } from 'react-router';
import { EmptyState, StatusBadge } from '@readysetcloud/ui';
import type { WorkflowEvent, WorkflowStatus, WorkflowView } from '../api/client';
import { relativeTime } from '../lib/time';

type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'primary';

export const WORKFLOW_STATUS: Record<WorkflowStatus, { label: string; tone: Tone }> = {
  active: { label: 'Working', tone: 'primary' },
  waiting: { label: 'Waiting', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'error' },
  finished: { label: 'Finished', tone: 'success' },
};

const STAGE: Record<string, string> = {
  implementing: 'Implementing',
  'reviewing-loop': 'Review loop',
  'awaiting-review': 'Awaiting review',
  reviewing: 'Reviewing',
  'changes-requested': 'Changes requested',
  revising: 'Revising',
  'waiting-for-ci': 'Waiting for CI',
  'fixing-ci': 'Fixing CI',
  'ready-to-merge': 'Ready to merge',
  merging: 'Merging',
  merged: 'Merged',
  'needs-human': 'Needs a person',
  closed: 'Closed',
  done: 'Done',
  failed: 'Failed',
};

export const stageLabel = (stage: string | undefined) => (stage ? (STAGE[stage] ?? stage) : '');

/** The role each step of a job played: the coding agent writes and revises, the review agent reviews. */
const ROLE: Record<string, string> = { implement: 'Coding agent', revision: 'Coding agent', review: 'Review agent' };

const EVENT_NAME: Record<string, string> = {
  issues: 'issue labeled',
  pull_request_review: 'review submitted',
  pull_request: 'pull request changed',
  check_suite: 'checks finished',
};

export function workflowTitle(w: Pick<WorkflowView, 'repository' | 'issue' | 'pullRequest'>): string {
  return `${w.repository}${w.issue !== undefined ? `#${w.issue}` : w.pullRequest !== undefined ? ` PR #${w.pullRequest}` : ''}`;
}

/** A tenant's workflows, most recently changed first. */
export function WorkflowsList({ workflows, base }: { workflows: WorkflowView[]; base: string }) {
  if (!workflows.length) {
    return <EmptyState title="No workflows yet" description="Each labeled issue becomes a workflow: its jobs, reviews and CI fixes as one timeline." />;
  }
  return (
    <ul className="flex flex-col divide-y divide-border" aria-label="Workflows">
      {workflows.map((w) => {
        const s = WORKFLOW_STATUS[w.status];
        return (
          <li key={w.workflowId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-4" data-testid={`workflow-${w.workflowId}`}>
            <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
            <Link className="auth-link min-w-0 basis-full break-words font-medium sm:basis-auto" to={`${base}/workflows/${w.workflowId}`}>
              {workflowTitle(w)}
            </Link>
            <StatusBadge tone="neutral">{stageLabel(w.stage)}</StatusBadge>
            {w.generation > 1 && <span className="text-sm text-muted-foreground">Run {w.generation}</span>}
            {w.status === 'blocked' && w.message && <span className="basis-full text-sm text-muted-foreground">{w.message}</span>}
            <span className="flex w-full flex-wrap items-center gap-3 text-sm text-muted-foreground sm:ml-auto sm:w-auto">
              <span title={new Date(w.updatedAt).toLocaleString()}>{relativeTime(w.updatedAt)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function eventTitle(e: WorkflowEvent): string {
  switch (e.kind) {
    case 'job_started':
      return `${e.retry ? 'Retry started' : 'Job started'}${e.eventName ? `: ${EVENT_NAME[e.eventName] ?? e.eventName}` : ''}`;
    case 'job_finished':
      return `Job finished${e.outcome ? `: ${e.outcome.replace(/_/g, ' ')}` : ''}`;
    case 'ci_recovered':
      return 'Missed check event recovered';
    case 'ci_checked':
      return 'Checks looked at';
    case 'blocked':
      return 'Blocked';
    case 'finished':
      return 'Finished';
  }
}

const eventTone = (e: WorkflowEvent): Tone =>
  e.kind === 'blocked' ? 'error' : e.kind === 'ci_recovered' ? 'warning' : e.kind === 'finished' ? 'success' : e.kind === 'job_finished' ? (e.outcome === 'succeeded' ? 'success' : 'warning') : 'neutral';

/**
 * A workflow's timeline, oldest first, by run (a new label after it ended is a new run; a retry
 * is not). Events are what happened at an instant; how long something took is on the job.
 */
export function WorkflowTimeline({ events, base }: { events: WorkflowEvent[]; base: string }) {
  if (!events.length) return <EmptyState title="Nothing recorded yet" description="The workflow's events appear here as its jobs start and finish." />;
  const runs = [...new Set(events.map((e) => e.generation))].sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-6" data-testid="workflow-timeline">
      {runs.map((run) => (
        <section key={run} className="flex flex-col gap-2" aria-label={`Run ${run}`}>
          {runs.length > 1 && <h3 className="text-sm font-medium text-muted-foreground">Run {run}</h3>}
          <ol className="flex flex-col divide-y divide-border">
            {events
              .filter((e) => e.generation === run)
              .map((e) => (
                <li key={e.id} className="flex min-w-0 flex-col gap-1 py-3" data-testid={`event-${e.id}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusBadge tone={eventTone(e)}>{eventTitle(e)}</StatusBadge>
                    {e.stage && <span className="text-sm">{stageLabel(e.stage)}</span>}
                    {e.jobId && (
                      <Link className="auth-link text-sm" to={`${base}/jobs/${e.jobId}`}>
                        Job
                      </Link>
                    )}
                    {e.prUrl && (
                      <a className="auth-link text-sm" href={e.prUrl} target="_blank" rel="noreferrer">
                        Pull request #{e.prNumber} ↗
                      </a>
                    )}
                    <span className="text-sm text-muted-foreground sm:ml-auto" title={new Date(e.at).toLocaleString()}>
                      {relativeTime(e.at)}
                    </span>
                  </div>
                  {e.steps && e.steps.length > 0 && (
                    <ul className="flex flex-wrap gap-2 text-sm text-muted-foreground" aria-label="Steps">
                      {e.steps.map((st, i) => (
                        <li key={i}>
                          {ROLE[st.kind] ?? st.kind}
                          {st.agent ? ` (${st.agent})` : ''}
                          {st.outcome ? `: ${st.outcome}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                  {e.loop && (
                    <p className="text-sm text-muted-foreground">
                      {e.loop.reviews} review(s), {e.loop.rounds}
                      {e.loop.maxRevisions !== undefined ? ` of ${e.loop.maxRevisions}` : ''} revision round(s)
                      {e.loop.verdict ? `, last verdict ${e.loop.verdict.replace(/-/g, ' ')}` : ''}
                    </p>
                  )}
                  {e.message && <p className="text-sm">{e.message}</p>}
                </li>
              ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
