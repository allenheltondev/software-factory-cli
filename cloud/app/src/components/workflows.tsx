import { useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, SegmentedControl, StatusBadge } from '@readysetcloud/ui';
import type { WorkflowEvent, WorkflowHistory, WorkflowStatus, WorkflowTotals, WorkflowView } from '../api/client';
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

type StatusFilter = 'all' | WorkflowStatus | 'paused';

/** A tenant's workflows, most recently changed first, narrowed by status and repository. */
export function WorkflowsList({ workflows, base }: { workflows: WorkflowView[]; base: string }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [repository, setRepository] = useState('');
  if (!workflows.length) {
    return <EmptyState title="No workflows yet" description="Each labeled issue becomes a workflow: its jobs, reviews and CI fixes as one timeline." />;
  }
  const repositories = [...new Set(workflows.map((w) => w.repository))].sort();
  const count = (s: WorkflowStatus) => workflows.filter((w) => w.status === s).length;
  const paused = workflows.filter((w) => w.paused).length;
  const shown = workflows.filter((w) => (status === 'all' || (status === 'paused' ? w.paused : w.status === status)) && (!repository || w.repository === repository));
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
            // Paused work stays findable however old: its pause never expires.
            ...(paused ? [{ value: 'paused' as const, label: `Paused (${paused})` }] : []),
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
                {w.paused && <StatusBadge tone="warning">Paused</StatusBadge>}
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

/** A person's control action, as the timeline names it: a console stop, or a command given on GitHub. */
const CONTROL_TITLE: Record<string, string> = {
  stop_requested: 'Stop requested',
  paused: 'Paused from GitHub',
  canceled: 'Canceled from GitHub',
  resumed: 'Automation resumed',
};

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
    case 'admitted':
      return 'Started from the queue';
    case 'control':
      return CONTROL_TITLE[e.control?.action ?? ''] ?? 'Control';
    default:
      // A kind this console does not know (recorded by a newer or older server): shown as it is.
      return String((e as { kind: string }).kind).replace(/_/g, ' ');
  }
}

const eventTone = (e: WorkflowEvent): Tone =>
  e.kind === 'blocked' || e.kind === 'label_missed'
    ? 'error'
    : e.kind === 'waiting' || e.kind === 'recovery' || (e.kind === 'control' && e.control?.action !== 'resumed')
      ? 'warning'
      : e.kind === 'finished' || e.kind === 'control'
        ? 'success'
        : e.kind === 'job_finished' || e.kind === 'finish_recovered'
          ? e.outcome === 'succeeded'
            ? 'success'
            : 'warning'
          : 'neutral';

/** What a wait was for, in words. */
const WAIT: Record<string, string> = {
  capacity: 'capacity',
  sign_in: 'a Claude sign-in',
  ci: "the pull request's checks",
  person: 'a person',
  merge: 'the merge conditions',
  review_event: "the review loop's next event",
};

/** "After waiting 12 min for the pull request's checks", from the server's own measurement. */
export function waitedLabel(w: NonNullable<WorkflowEvent['waited']>): string {
  if (w.for === 'pause') return `Paused for ${formatDuration(w.seconds)}`;
  return `After waiting ${formatDuration(w.seconds)} for ${WAIT[w.for] ?? w.for.replace(/_/g, ' ')}`;
}

/** Why a Claude session was retired (`claude_session_<reason>`, #176). */
const CLAUDE_SESSION: Record<string, string> = {
  reconnect: 'an owner reconnected it',
  idle: 'it was idle for its whole idle limit',
  lifetime: 'it reached its maximum lifetime',
  vm_ended: 'its VM stopped running before its lifetime ended',
  expired: 'its VM ended or it reached its maximum lifetime',
  suspended: 'its VM was suspended',
  worker_lost: 'its worker stopped answering',
  disabled: 'an operator paused Claude connections',
  startup_failed: 'it never became ready',
  image_revoked: 'its image was revoked',
  image_blocked: 'its image was no longer approved',
  retired: 'it was retired',
};
/** Why the Claude environment cannot run the job (`claude_<readiness>`). */
const CLAUDE_READINESS: Record<string, string> = {
  not_connected: 'Claude is not connected yet',
  auth_required: 'Claude needs a sign-in',
  expired: 'the Claude sign-in expired',
  environment_suspended: 'the Claude session ended: its VM was suspended',
  environment_ended: 'the Claude session ended: its VM stopped running',
  fenced: 'the Claude session was stopped',
  worker_lost: 'the Claude session ended: its worker stopped answering',
  startup_failed: 'the Claude session never became ready',
  image_draining: "the Claude session's image is being retired",
  image_revoked: "the Claude session's image was revoked",
  image_unapproved: "the Claude session's image is no longer approved",
  protocol_incompatible: "the Claude session's image is no longer compatible",
};

/** A subscription wait's reason code in words (`claude_…`, or Codex's `codex_…`, #125), or undefined for any other code. */
export function reasonLabel(code: string): string | undefined {
  // `_uncommented`: the sign-in notice could never be posted on the issue (GitHub refused it for good).
  const uncommented = code.endsWith('_uncommented');
  const base = uncommented ? code.slice(0, -'_uncommented'.length) : code;
  const suffix = uncommented ? '; GitHub would not take the comment asking for it, so sign in from Updraft' : '';
  const provider = /^(claude|codex)_/.exec(base)?.[1];
  if (!provider) return undefined;
  // Codex's words are Claude's with its own name; its sign-in is with ChatGPT.
  const name = provider === 'codex' ? 'Codex' : 'Claude';
  const named = (words: string) => (provider === 'codex' ? words.replace(/Claude/g, 'Codex') : words);
  if (base === `${provider}_sign_in`) return uncommented ? `${name} needs a ${provider === 'codex' ? 'ChatGPT ' : ''}sign-in${suffix}` : undefined;
  const session = new RegExp(`^${provider}_session_([a-z_]+)$`).exec(base)?.[1];
  if (session) return `The ${name} session ended because ${named(CLAUDE_SESSION[session] ?? session.replace(/_/g, ' '))}; a new one needs a sign-in${suffix}`;
  const readiness = new RegExp(`^${provider}_([a-z_]+)$`).exec(base)?.[1];
  const words = readiness ? CLAUDE_READINESS[readiness] : undefined;
  return words ? named(words.charAt(0).toUpperCase() + words.slice(1)) + suffix : undefined;
}

/** The route a job ran on: its tier (and the tier first chosen, after an escalation), pool and why. */
export function routingLabel(r: NonNullable<WorkflowEvent['routing']>): string {
  const parts = [
    r.tier ? `Tier ${r.tier}${r.requestedTier && r.requestedTier !== r.tier ? ` (first chosen: ${r.requestedTier})` : ''}` : '',
    r.pool ? `pool ${r.pool}` : '',
    r.reason ? `routing reason: ${r.reason.replace(/-/g, ' ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : `Routed by ${r.source}`;
}

/** One step: its role, the profile, adapter, model and effort it ran with, and how it ended. */
function stepLabel(st: NonNullable<WorkflowEvent['steps']>[number]): string {
  const ran = [st.agent, st.adapter, st.model, st.effort ? `effort ${st.effort}` : undefined].filter(Boolean).join(' · ');
  return `${ROLE[st.kind] ?? st.kind}${ran ? ` (${ran})` : ''}${st.outcome ? `: ${st.outcome}` : ''}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A job record's id: only these have a job page (an id made up for a command or a recovery does not). */
const JOB_ID = /^job_[A-Za-z0-9_-]{8,64}$/;
/** How long ago an instant was (from `now`, or the clock). */
const ageMs = (at: string, now?: number) => (now ?? Date.now()) - Date.parse(at);

/**
 * A workflow's timeline, oldest first, by run (a new label after it ended is a new run; a retry
 * is not), in the order the server saved its events. Events are what happened at an instant; a
 * wait that ended says how long it lasted; how long a job ran is on the job. The newest event of
 * the newest run is marked as where the workflow is now. A job link whose record is past its
 * retention says so instead of leading to a page that is gone.
 */
export function WorkflowTimeline({ events, base, repository, jobRetentionDays, now }: { events: WorkflowEvent[]; base: string; repository?: string; jobRetentionDays?: number; now?: number }) {
  if (!events.length) return <EmptyState title="Nothing recorded yet" description="The workflow's events appear here as its jobs start and finish." />;
  const runs = [...new Set(events.map((e) => e.generation))].sort((a, b) => a - b);
  const latest = events.filter((e) => e.generation === runs.at(-1)).at(-1)?.id;
  const expired = (e: WorkflowEvent) => jobRetentionDays !== undefined && ageMs(e.occurredAt ?? e.at, now) > jobRetentionDays * DAY_MS;
  return (
    <div className="flex flex-col gap-6" data-testid="workflow-timeline">
      {runs.map((run) => (
        <section key={run} className="flex flex-col gap-2" aria-label={`Run ${run}`}>
          {runs.length > 1 && <h3 className="text-sm font-medium text-muted-foreground">Run {run}</h3>}
          <ol className="flex flex-col divide-y divide-border">
            {events
              .filter((e) => e.generation === run)
              .map((e) => {
                const prUrl = e.prUrl ?? (repository && e.prNumber !== undefined ? `https://github.com/${repository}/pull/${e.prNumber}` : undefined);
                return (
                  <li key={e.id} className="flex min-w-0 flex-col gap-1 py-3" data-testid={`event-${e.id}`} {...(e.id === latest ? { 'aria-current': 'step' as const } : {})}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <StatusBadge tone={eventTone(e)}>{eventTitle(e)}</StatusBadge>
                      {e.id === latest && <StatusBadge tone="primary">Latest</StatusBadge>}
                      {e.stage && <span className="text-sm">{stageLabel(e.stage)}</span>}
                      {e.jobId && JOB_ID.test(e.jobId) &&
                        (expired(e) ? (
                          <span className="text-sm text-muted-foreground" title={`Job records are kept ${jobRetentionDays} days`}>
                            Job record expired
                          </span>
                        ) : (
                          <Link className="auth-link text-sm" to={`${base}/jobs/${e.jobId}`}>
                            Job
                          </Link>
                        ))}
                      {prUrl && (
                        <a className="auth-link text-sm" href={prUrl} target="_blank" rel="noreferrer">
                          Pull request #{e.prNumber} ↗
                        </a>
                      )}
                      {e.headSha && repository && (
                        <a className="auth-link text-sm" href={`https://github.com/${repository}/commit/${e.headSha}`} target="_blank" rel="noreferrer">
                          Commit {e.headSha.slice(0, 7)} ↗
                        </a>
                      )}
                      <span className="text-sm text-muted-foreground sm:ml-auto" title={new Date(e.at).toLocaleString()}>
                        {relativeTime(e.at)}
                      </span>
                    </div>
                    {e.occurredAt && (
                      <p className="text-sm text-muted-foreground" data-testid="event-occurred">
                        Happened {relativeTime(e.occurredAt)}, recorded later.
                      </p>
                    )}
                    {e.waited && (
                      <p className="text-sm text-muted-foreground" data-testid="event-waited">
                        {waitedLabel(e.waited)}
                      </p>
                    )}
                    {e.control && (
                      <p className="text-sm" data-testid="event-control">
                        By {e.control.by}
                        {e.control.reason ? `: ${e.control.reason}` : ''}
                      </p>
                    )}
                    {e.routing && (
                      <p className="text-sm text-muted-foreground" data-testid="event-routing">
                        {routingLabel(e.routing)}
                      </p>
                    )}
                    {e.steps && e.steps.length > 0 && (
                      <ul className="flex flex-wrap gap-2 text-sm text-muted-foreground" aria-label="Steps">
                        {e.steps.map((st, i) => (
                          <li key={i}>{stepLabel(st)}</li>
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
                    {e.reason && (e.kind === 'blocked' || e.kind === 'waiting' || e.kind === 'admitted') && (
                      <p className="text-xs text-muted-foreground">
                        {reasonLabel(e.reason) ? `${reasonLabel(e.reason)}. ` : ''}Reason code: <code>{e.reason}</code>
                      </p>
                    )}
                  </li>
                );
              })}
          </ol>
        </section>
      ))}
    </div>
  );
}

/**
 * What of a workflow's history is kept, and what is not shown: older events left out of the page,
 * events past their retention, a read that could not see every event. Always says how long each
 * record is kept, so a missing early step is never mistaken for one that did not happen.
 */
export function WorkflowHistoryNote({ history, reconstructed }: { history: WorkflowHistory; reconstructed?: boolean }) {
  const notes = [
    history.omitted > 0 ? `Showing the latest ${history.shown} events; ${history.omitted} older event${history.omitted === 1 ? ' is' : 's are'} not shown.` : '',
    !history.complete && !reconstructed ? 'This workflow has more events than one read takes: some may not be shown.' : '',
    history.expiredEarlier ? `This workflow began more than ${history.eventRetentionDays} days ago. Events are kept ${history.eventRetentionDays} days after they happen, so its earliest are gone.` : '',
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="workflow-history">
      {notes.map((n) => (
        <p key={n} className="font-medium">
          {n}
        </p>
      ))}
      <p className="text-muted-foreground">
        Kept: events {history.eventRetentionDays} days after they happen, the workflow {history.workflowRetentionDays} days after its last change, job records {history.jobRetentionDays} days, and a stop&apos;s pause until it is resumed.
      </p>
    </div>
  );
}
