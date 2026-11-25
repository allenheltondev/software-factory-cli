import { useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, SegmentedControl, StatusBadge } from '@readysetcloud/ui';
import type { WorkflowEvent, WorkflowStatus, WorkflowTotals, WorkflowView } from '../api/client';
import { formatDuration } from '../lib/diagnostics';
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
  'awaiting-sign-in': 'Waiting for sign-in',
  queued: 'Queued for capacity',
  'publish-failed': 'Publication failed',
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

type StatusFilter = 'all' | WorkflowStatus;

/** A tenant's workflows, most recently changed first, narrowed by status and repository. */
export function WorkflowsList({ workflows, base }: { workflows: WorkflowView[]; base: string }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [repository, setRepository] = useState('');
  if (!workflows.length) {
    return <EmptyState title="No workflows yet" description="Each labeled issue becomes a workflow: its jobs, reviews and CI fixes as one timeline." />;
  }
  const repositories = [...new Set(workflows.map((w) => w.repository))].sort();
  const count = (s: WorkflowStatus) => workflows.filter((w) => w.status === s).length;
  const shown = workflows.filter((w) => (status === 'all' || w.status === status) && (!repository || w.repository === repository));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl<StatusFilter>
          aria-label="Show workflows"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: `All (${workflows.length})` },
            { value: 'blocked', label: `Blocked (${count('blocked')})` },
            { value: 'waiting', label: `Waiting (${count('waiting')})` },
            { value: 'active', label: `Working (${count('active')})` },
            { value: 'finished', label: `Finished (${count('finished')})` },
          ]}
        />
        {repositories.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            Repository
            <select className="input" value={repository} onChange={(e) => setRepository(e.target.value)} aria-label="Repository">
              <option value="">All</option>
              {repositories.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!shown.length ? (
        <EmptyState title="No workflows match" description="Choose another status or repository." />
      ) : (
        <ul className="flex flex-col divide-y divide-border" aria-label="Workflows">
          {shown.map((w) => {
            const s = WORKFLOW_STATUS[w.status];
            return (
              <li key={w.workflowId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-4" data-testid={`workflow-${w.workflowId}`}>
                <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                <Link className="auth-link min-w-0 basis-full break-words font-medium sm:basis-auto" to={`${base}/workflows/${w.workflowId}`}>
                  {workflowTitle(w)}
                </Link>
                <StatusBadge tone="neutral">{stageLabel(w.stage)}</StatusBadge>
                {w.generation > 1 && <span className="text-sm text-muted-foreground">Run {w.generation}</span>}
                {w.reconstructed && <span className="text-sm text-muted-foreground" title="Rebuilt from job records">Rebuilt</span>}
                {w.status === 'blocked' && w.message && <span className="basis-full text-sm text-muted-foreground">{w.message}</span>}
                <span className="flex w-full flex-wrap items-center gap-3 text-sm text-muted-foreground sm:ml-auto sm:w-auto">
                  <span title={new Date(w.updatedAt).toLocaleString()}>{relativeTime(w.updatedAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** What the workflow's jobs added up to, from what they reported; what is estimated or missing says so. */
export function WorkflowTotalsView({ totals }: { totals: WorkflowTotals }) {
  const items: [string, string, string?][] = [
    ['Jobs', `${totals.jobs}${totals.retries ? ` (${totals.retries} retr${totals.retries === 1 ? 'y' : 'ies'})` : ''}`],
    ['Reviews', String(totals.reviews)],
    ['Revisions', String(totals.revisions)],
    ['Tokens', totals.inputTokens || totals.outputTokens ? `${tokens(totals.inputTokens)} in, ${tokens(totals.outputTokens)} out` : '—'],
    [
      totals.subscription ? 'Cost (estimate)' : 'Cost (reported)',
      totals.costUsd ? `$${totals.costUsd.toFixed(2)}` : '—',
      [
        totals.subscription ? 'Some jobs ran on a Claude subscription: their cost is the agent\'s estimate, not what was billed.' : 'The agents\' own estimates.',
        totals.stepsWithoutCost ? `${totals.stepsWithoutCost} step(s) reported no cost and are not included.` : '',
      ].filter(Boolean).join(' '),
    ],
    ['Active', formatDuration(totals.activeSeconds), 'Time jobs were running, summed.'],
    ['Wall time', `${formatDuration(totals.wallSeconds)}${totals.running ? ' so far' : ''}`, 'From the first job\'s start to the latest event.'],
  ];
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3" data-testid="workflow-totals">
      {items.map(([label, value, title]) => (
        <div key={label} className="flex flex-col" title={title}>
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function eventTitle(e: WorkflowEvent): string {
  switch (e.kind) {
    case 'job_started':
      return `${e.retry ? 'Retry started' : 'Job started'}${e.eventName ? `: ${EVENT_NAME[e.eventName] ?? e.eventName}` : ''}`;
    case 'job_finished':
      return `Job finished${e.outcome ? `: ${e.outcome.replace(/_/g, ' ')}` : ''}`;
    case 'ci_checked':
      return 'Checks looked at';
    case 'blocked':
      return 'Blocked';
    case 'finished':
      return 'Finished';
    case 'waiting':
      return 'Waiting';
    case 'label_missed':
      return 'Label event missed';
    case 'finish_recovered':
      return `Job finished (recovered)${e.outcome ? `: ${e.outcome.replace(/_/g, ' ')}` : ''}`;
    case 'recovery':
      return 'Automatic recovery';
    default:
      // A kind this console does not know (recorded by a newer or older server): shown as it is.
      return String((e as { kind: string }).kind).replace(/_/g, ' ');
  }
}

const eventTone = (e: WorkflowEvent): Tone =>
  e.kind === 'blocked' || e.kind === 'label_missed'
    ? 'error'
    : e.kind === 'waiting' || e.kind === 'recovery'
      ? 'warning'
      : e.kind === 'finished'
        ? 'success'
        : e.kind === 'job_finished' || e.kind === 'finish_recovered'
          ? e.outcome === 'succeeded'
            ? 'success'
            : 'warning'
          : 'neutral';

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
