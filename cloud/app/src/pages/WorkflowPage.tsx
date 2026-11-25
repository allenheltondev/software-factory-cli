import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, PageHero, PageHeroChip, PageHeroChips, PageHeroSubtitle, PageHeroTitle, Skeleton } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type WorkflowEvent, type WorkflowPause, type WorkflowTotals, type WorkflowView } from '../api/client';
import { WORKFLOW_STATUS, WorkflowTimeline, WorkflowTotalsView, stageLabel, workflowTitle } from '../components/workflows';
import { relativeTime } from '../lib/time';

type WorkflowApi = Pick<ApiClient, 'workflow'> & Partial<Pick<ApiClient, 'resumeWorkflow'>>;
type Load = { state: 'loading' } | { state: 'ok'; workflow: WorkflowView; events: WorkflowEvent[]; totals?: WorkflowTotals; pause?: WorkflowPause } | { state: 'error'; message: string };

const WORKFLOW_ID = /^(?:[0-9]{1,20}|legacy-[0-9a-f]{12})-[ip][0-9]{1,10}$/;
export const WORKFLOW_REFRESH_MS = 15_000;

/**
 * One workflow (#139): an issue's whole story across its jobs. Where it is and, when it waits or
 * is blocked, why and what to do next; then every job, review loop result and recovery, in order.
 */
export function WorkflowPage({ api = defaultApi, refreshMs = WORKFLOW_REFRESH_MS }: { api?: WorkflowApi; refreshMs?: number }) {
  const { id, workflowId = '' } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0 && WORKFLOW_ID.test(workflowId);
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no workflow at this address.' };
  const live = useRef(true);
  const base = `/installations/${id}`;

  const refresh = useCallback(async () => {
    try {
      const out = await api.workflow(installationId, workflowId);
      if (live.current) setLoad({ state: 'ok', ...out });
    } catch (err) {
      if (live.current) setLoad((prev) => (prev.state === 'ok' ? prev : { state: 'error', message: err instanceof Error ? err.message : 'Could not load the workflow.' }));
    }
  }, [api, installationId, workflowId]);

  useEffect(() => {
    live.current = true;
    if (valid) void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh, valid]);

  const active = load.state === 'ok' && load.workflow.status === 'active';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [active, refresh, refreshMs]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link className="auth-link" to={`${base}?tab=workflows`}>
        ← Workflows
      </Link>
      {load.state === 'loading' && <Skeleton className="h-40" data-testid="workflow-loading" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="workflow-error">
          {load.message}
        </Alert>
      )}
      {load.state === 'ok' && (
        <>
          <PageHero data-testid="workflow">
            <PageHeroTitle className="break-words">{workflowTitle(load.workflow)}</PageHeroTitle>
            <PageHeroSubtitle data-testid="workflow-state">
              {load.workflow.message ?? (load.workflow.status === 'active' ? 'A job is working on it now.' : stageLabel(load.workflow.stage))}
            </PageHeroSubtitle>
            <PageHeroChips>
              <PageHeroChip tone={WORKFLOW_STATUS[load.workflow.status].tone} data-testid="workflow-status">
                {WORKFLOW_STATUS[load.workflow.status].label}
              </PageHeroChip>
              <PageHeroChip>{stageLabel(load.workflow.stage)}</PageHeroChip>
              {load.workflow.generation > 1 && <PageHeroChip>Run {load.workflow.generation}</PageHeroChip>}
              {load.workflow.waitingSince && load.workflow.status === 'waiting' && <PageHeroChip>Waiting since {relativeTime(load.workflow.waitingSince)}</PageHeroChip>}
            </PageHeroChips>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              {load.workflow.issue !== undefined && (
                <a className="auth-link" href={`https://github.com/${load.workflow.repository}/issues/${load.workflow.issue}`} target="_blank" rel="noreferrer">
                  Issue #{load.workflow.issue} ↗
                </a>
              )}
              {load.workflow.prUrl && (
                <a className="auth-link" href={load.workflow.prUrl} target="_blank" rel="noreferrer">
                  Pull request #{load.workflow.pullRequest} ↗
                </a>
              )}
              {load.workflow.lastJobId && (
                <Link className="auth-link" to={`${base}/jobs/${load.workflow.lastJobId}`}>
                  Latest job
                </Link>
              )}
            </div>
          </PageHero>
          {load.workflow.reconstructed && (
            <Alert variant="info" data-testid="workflow-rebuilt">
              {(load.workflow.gaps ?? ['Rebuilt from job records.']).join(' ')}
            </Alert>
          )}
          {load.totals && (
            <Card>
              <CardHeader>
                <CardTitle>Totals</CardTitle>
              </CardHeader>
              <CardBody>
                <WorkflowTotalsView totals={load.totals} />
              </CardBody>
            </Card>
          )}
          {load.pause && <PausePanel pause={load.pause} base={base} resume={api.resumeWorkflow ? () => api.resumeWorkflow!(installationId, workflowId, load.pause!) : undefined} onResumed={() => void refresh()} />}
          {load.workflow.nextAction && (load.workflow.status === 'blocked' || load.workflow.status === 'waiting') && (
            <Alert variant={load.workflow.status === 'blocked' ? 'error' : 'info'} data-testid="workflow-next">
              <strong>Next:</strong> {load.workflow.nextAction}
            </Alert>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardBody>
              <WorkflowTimeline events={load.events} base={base} />
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * A stop paused this workflow: no GitHub event continues it until an owner resumes it. The pause
 * outlives the stopped job's records, so this is where it is resumed once they are gone.
 */
function PausePanel({ pause, base, resume, onResumed }: { pause: WorkflowPause; base: string; resume?: () => Promise<unknown>; onResumed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await resume!();
      onResumed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resume automation.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert variant="info" data-testid="workflow-pause">
      <div className="flex flex-col gap-2">
        <p>
          <strong>Automation is paused.</strong> {pause.by} stopped{' '}
          <Link className="auth-link" to={`${base}/jobs/${pause.jobId}`}>
            job {pause.jobId}
          </Link>{' '}
          {relativeTime(new Date(pause.at).toISOString())}
          {pause.reason ? `: ${pause.reason}` : ''}. GitHub events on this workflow start nothing until it is resumed.
        </p>
        {pause.canResume && resume && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void run()} disabled={busy}>
              Resume automation
            </Button>
            <span className="text-sm">Future GitHub events continue the workflow. Nothing is run again.</span>
          </div>
        )}
        {error && <p className="font-medium" data-testid="workflow-pause-error">{error}</p>}
      </div>
    </Alert>
  );
}
