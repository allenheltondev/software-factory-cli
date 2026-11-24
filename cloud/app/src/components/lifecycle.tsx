import { StatusBadge } from '@readysetcloud/ui';
import type { JobDetail, JobView, LoopStage, StepKind } from '../api/client';
import type { Tone } from '../lib/diagnostics';

/**
 * A job's lifecycle as its runner reported it: the steps it took (write the code, review it,
 * revise it, review again, ...) and where the review loop left the pull request.
 */

export const STAGE: Record<LoopStage, { label: string; tone: Tone }> = {
  'awaiting-review': { label: 'Awaiting review', tone: 'neutral' },
  reviewing: { label: 'Reviewing', tone: 'primary' },
  'changes-requested': { label: 'Changes requested', tone: 'warning' },
  revising: { label: 'Revising', tone: 'primary' },
  'ready-to-merge': { label: 'Ready to merge', tone: 'success' },
  merging: { label: 'Merging', tone: 'primary' },
  merged: { label: 'Merged', tone: 'success' },
  'needs-human': { label: 'Needs a person', tone: 'warning' },
  closed: { label: 'Closed', tone: 'neutral' },
};

const KIND: Record<StepKind, { title: string; verb: string }> = {
  implement: { title: 'Wrote the change', verb: 'wrote the code' },
  review: { title: 'Reviewed', verb: 'reviewed it' },
  revision: { title: 'Revised', verb: 'addressed the review' },
};

const roundsText = (loop: NonNullable<JobDetail['loop']>) =>
  `${loop.rounds} ${loop.rounds === 1 ? 'round' : 'rounds'}${loop.maxRevisions !== undefined ? ` of ${loop.maxRevisions}` : ''}`;

/** The stage and the rounds, for the jobs list. */
export function LoopBadges({ job }: { job: Pick<JobView, 'detail'> }) {
  const loop = job.detail?.loop;
  if (!loop) return null;
  const stage = loop.stage ? STAGE[loop.stage] : null;
  return (
    <span className="flex items-center gap-2 text-sm" data-testid="loop-badges">
      {stage && <StatusBadge tone={stage.tone}>{stage.label}</StatusBadge>}
      <span title="Revision rounds">{roundsText(loop)}</span>
      {loop.reviews > 0 && <span title="Reviews">· {loop.reviews} {loop.reviews === 1 ? 'review' : 'reviews'}</span>}
    </span>
  );
}

type StepState = 'ok' | 'failed' | 'neutral';

function stepState(step: NonNullable<JobDetail['steps']>[number], index: number, steps: NonNullable<JobDetail['steps']>): { state: StepState; text: string } {
  if (step.outcome === 'failed' || step.outcome === 'publish-failed' || step.outcome === 'error') {
    return { state: 'failed', text: step.verificationPassed === false ? 'Verification failed' : step.outcome === 'publish-failed' ? 'Could not publish' : 'Failed' };
  }
  if (step.verificationPassed === false) return { state: 'failed', text: 'Verification failed' };
  if (step.outcome === 'canceled' || step.outcome === 'superseded' || step.outcome === 'not-started' || step.outcome === 'deferred') {
    return { state: 'neutral', text: step.outcome === 'not-started' ? 'Did not start' : step.outcome.charAt(0).toUpperCase() + step.outcome.slice(1) };
  }
  if (step.kind === 'review') {
    // A review followed by a revision asked for changes; the last review's verdict is the loop's.
    const next = steps[index + 1];
    return { state: 'ok', text: next?.kind === 'revision' ? 'Asked for changes' : 'Done' };
  }
  if (step.kind === 'implement') return { state: 'ok', text: step.publication === 'published' ? 'Pull request opened' : step.verificationPassed ? 'Verified' : 'Done' };
  return { state: 'ok', text: step.publication === 'published' ? 'Pushed' : 'Done' };
}

const DOT: Record<StepState, string> = {
  ok: 'bg-success-500 dark:bg-success-400',
  failed: 'bg-error-500 dark:bg-error-400',
  neutral: 'bg-secondary-400 dark:bg-secondary-500',
};

/** The steps in order, as a vertical timeline, ending with where the pull request stands. */
export function Lifecycle({ detail, running }: { detail?: JobDetail; running: boolean }) {
  const steps = detail?.steps ?? [];
  const loop = detail?.loop;
  if (!steps.length && !loop) {
    return <p className="text-sm text-muted-foreground">{running ? 'The steps show up here when the job ends.' : 'This job reported no steps (it ran before they were recorded, or ended before any agent started).'}</p>;
  }
  const lastVerdict = loop?.verdict;
  const stage = loop?.stage ? STAGE[loop.stage] : null;
  return (
    <ol className="relative flex flex-col gap-4 border-l border-border pl-6" data-testid="job-lifecycle">
      {steps.map((step, i) => {
        const { state, text } = stepState(step, i, steps);
        const isLastReview = step.kind === 'review' && !steps.slice(i + 1).some((s) => s.kind === 'review');
        const shown = isLastReview && lastVerdict && state === 'ok' ? (lastVerdict === 'ready-to-merge' ? 'Ready to merge' : 'Asked for changes') : text;
        const reviewRound = steps.slice(0, i + 1).filter((s) => s.kind === step.kind).length;
        return (
          <li key={i} className="relative" data-testid={`step-${i}`}>
            <span className={`absolute -left-[1.85rem] top-1 h-3 w-3 rounded-full ring-4 ring-surface ${DOT[state]}`} aria-hidden="true" />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">
                {KIND[step.kind].title}
                {step.kind !== 'implement' && reviewRound > 1 ? ` (${reviewRound})` : ''}
              </span>
              <span className={`text-sm ${state === 'failed' ? 'text-error-600 dark:text-error-400' : 'text-muted-foreground'}`}>{shown}</span>
            </div>
            {step.agent && (
              <span className="text-xs text-muted-foreground">
                <code>{step.agent}</code> {KIND[step.kind].verb}
                {step.model && <> · <code>{step.model}</code>{step.effort && ` (${step.effort})`}</>}
                {step.verificationPassed === true ? ' · verify passed' : ''}
              </span>
            )}
          </li>
        );
      })}
      {loop && (
        <li className="relative" data-testid="step-loop">
          <span className={`absolute -left-[1.85rem] top-1 h-3 w-3 rounded-full ring-4 ring-surface ${loop.merged ? DOT.ok : 'bg-primary-500 dark:bg-primary-400'}`} aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Pull request</span>
            {stage && <StatusBadge tone={stage.tone}>{stage.label}</StatusBadge>}
          </div>
          <span className="text-xs text-muted-foreground">
            {roundsText(loop)} · {loop.reviews} {loop.reviews === 1 ? 'review' : 'reviews'}
          </span>
        </li>
      )}
    </ol>
  );
}
