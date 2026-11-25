import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHero, PageHeroChip, PageHeroChips, PageHeroSubtitle, PageHeroTitle, SegmentedControl, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { ApiError, api as defaultApi, type ApiClient, type Delivery, type JobLog, type JobTimelineEntry, type JobTotals, type JobView } from '../api/client';
import { DISPOSITION, JOB_RESULT, deliveryReason, formatBytes, formatDuration } from '../lib/diagnostics';
import { relativeTime } from '../lib/time';
import { Lifecycle } from '../components/lifecycle';
import { JobActions, JobStopStatus } from '../components/job-actions';

type JobApi = Pick<ApiClient, 'job' | 'jobLog'> & Partial<Pick<ApiClient, 'retryJob' | 'stopJob' | 'resumeJob' | 'jobWorkflow'>>;
type Load = { state: 'loading' } | { state: 'ok'; job: JobView; deliveries: Delivery[]; conversation?: JobView[] } | { state: 'error'; message: string };
type LogLoad = { state: 'loading' } | { state: 'ok'; log: JobLog } | { state: 'expired' } | { state: 'error'; message: string };

const JOB_ID = /^job_[A-Za-z0-9_-]{8,64}$/;
const exact = (iso: string) => new Date(iso).toLocaleString();
export const JOB_REFRESH_MS = 10_000;

/**
 * One job (#71): how it ended and what to do about it, the facts (issue, pull request, config
 * version, duration), the deliveries that led to it, and its logs, read through the API.
 */
export function JobPage({ api = defaultApi, refreshMs = JOB_REFRESH_MS }: { api?: JobApi; refreshMs?: number }) {
  const { id, jobId = '' } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0 && JOB_ID.test(jobId);
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no job at this address.' };
  const live = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const out = await api.job(installationId, jobId);
      if (live.current) setLoad({ state: 'ok', ...out });
    } catch (err) {
      if (live.current) setLoad((prev) => (prev.state === 'ok' ? prev : { state: 'error', message: err instanceof Error ? err.message : 'Could not load the job.' }));
    }
  }, [api, installationId, jobId]);

  useEffect(() => {
    live.current = true;
    if (valid) void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh, valid]);

  // The workflow the job belongs to (#139), once: a link up to the issue's whole story.
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  useEffect(() => {
    if (!valid || !api.jobWorkflow) return;
    let on = true;
    api.jobWorkflow(installationId, jobId).then((r) => on && setWorkflowId(r.workflowId), () => {});
    return () => {
      on = false;
    };
  }, [api, installationId, jobId, valid]);

  const running = load.state === 'ok' && load.job.result === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [running, refresh, refreshMs]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-4">
        <Link className="auth-link" to={`/installations/${id}`}>
          ← Installation
        </Link>
        {workflowId && (
          <Link className="auth-link" to={`/installations/${id}/workflows/${workflowId}`} data-testid="job-workflow">
            Workflow
          </Link>
        )}
      </div>
      {load.state === 'loading' && <Skeleton className="h-40" data-testid="job-loading" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="job-error">
          {load.message}
        </Alert>
      )}
      {load.state === 'ok' && <Loaded key={load.job.jobId} job={load.job} deliveries={load.deliveries} conversation={load.conversation ?? []} api={api} installationId={installationId} onRefresh={() => void refresh()} />}
    </div>
  );
}

/** Run a job that did not finish its work again; the new job's page opens when it has started. */
function Retry({ job, api, installationId }: { job: JobView; api: JobApi; installationId: number }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (job.status === 'finished' && (job.benchmark || job.label?.toLowerCase() === 'updraft:benchmark')) {
    return <p className="mt-4 text-sm">To rerun this benchmark, submit a fresh arm through the benchmark harness.</p>;
  }
  if (job.retriedAs) {
    return (
      <p className="mt-4 text-sm" data-testid="job-retried">
        Retried as{' '}
        <Link className="auth-link" to={`/installations/${installationId}/jobs/${job.retriedAs}`}>
          {job.retriedAs}
        </Link>
      </p>
    );
  }
  if (!job.retryable || !api.retryJob) return null;
  const retry = api.retryJob;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await retry(installationId, job.jobId);
      void navigate(`/installations/${installationId}/jobs/${out.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not retry the job.');
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-2" data-testid="job-retry">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? 'Retrying…' : 'Retry job'}
        </Button>
        <span className="text-sm">Uses the current workflow configuration and this job’s original execution mode.</span>
      </div>
      {job.executionMode !== 'subscription' && (
        <p className="text-sm">To test Claude subscription routing, use a new labeled issue.{' '}
          <Link className="auth-link" to={`/installations/${installationId}/claude`}>Claude subscription settings</Link>
        </p>
      )}
      {error && (
        <Alert variant="error" data-testid="job-retry-error">
          {error}
        </Alert>
      )}
    </div>
  );
}

function Loaded({ job, deliveries, conversation, api, installationId, onRefresh }: { job: JobView; deliveries: Delivery[]; conversation: JobView[]; api: JobApi; installationId: number; onRefresh: () => void }) {
  const names = [...job.logs].sort((a, b) => (a === 'run.log' ? -1 : b === 'run.log' ? 1 : a.localeCompare(b)));
  const [selectedLog, setSelectedLog] = useState<string>();
  const logName = selectedLog && names.includes(selectedLog) ? selectedLog : (names[0] ?? '');
  return (
    <>
      <JobSummary job={job} installationId={installationId} api={api} onRefresh={onRefresh} onViewLogs={() => setSelectedLog(names[0])} />

      {job.logs.length > 0 && <Logs job={job} api={api} installationId={installationId} names={names} name={logName} onSelect={setSelectedLog} />}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card data-testid="job-lifecycle-card">
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
          </CardHeader>
          <CardBody>
            <Lifecycle detail={job.detail} running={job.result === 'running'} />
          </CardBody>
        </Card>
        <Traces job={job} installationId={installationId} onRetry={onRefresh} />
      </div>

      <AgentWork job={job} />

      <Conversation job={job} others={conversation} installationId={installationId} />

      {deliveries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Deliveries</CardTitle>
          </CardHeader>
          <CardBody>
            <ol className="flex flex-col gap-2" data-testid="job-deliveries">
              {deliveries.map((d) => (
                <li key={`${d.at}-${d.disposition}`} className="flex flex-wrap items-center gap-3 text-sm">
                  <span title={exact(d.at)}>{relativeTime(d.at)}</span>
                  <strong>{DISPOSITION[d.disposition].label}</strong>
                  <span>{deliveryReason(d)}</span>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      )}

      {job.logs.length === 0 && <Logs job={job} api={api} installationId={installationId} names={names} name={logName} onSelect={setSelectedLog} />}
    </>
  );
}

/** Seconds since `iso`, ticking each second while `live`. Null for a time that does not parse. */
function useElapsed(iso: string, live: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const start = Date.parse(iso);
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : null;
}

/** A value to copy, with its own label: technical identifiers stay reachable but quiet. */
function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an insecure context): the value is on screen.
    }
  };
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2">
      <span>{label}</span>
      <code className="break-all">{value}</code>
      <button type="button" className="auth-link font-semibold" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

/** One metric: a small label over a large value. Unknown facts show a dash, never a zero. */
function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold leading-tight">{children}</dd>
    </div>
  );
}

/**
 * The top of the page: what the job is, how it stands and why, the facts that matter at a
 * glance, and what to do next. The technical identifiers are below, quieter.
 */
function JobSummary({ job, installationId, api, onViewLogs, onRefresh }: { job: JobView; installationId: number; api: JobApi; onViewLogs: () => void; onRefresh: () => void }) {
  const r = JOB_RESULT[job.result];
  const running = job.result === 'running';
  const elapsed = useElapsed(job.createdAt, running);
  const loop = job.detail?.loop;
  const t = job.telemetry;
  const hasLogs = job.logs.length > 0;
  const models = [...new Set((job.detail?.steps ?? []).map((st) => st.model).filter((m): m is string => !!m))];
  const conversationLink = t && !t.local ? (t.timelineUrl ?? t.conversationUrl) : undefined;
  const conversationLabel = t?.timelineUrl ? (t.timelineLabel ?? 'Open conversation') : 'Open conversation';
  return (
    <PageHero data-testid="job">
      <PageHeroTitle className="break-words">
        {job.repository}
        {job.issue !== undefined ? `#${job.issue}` : job.pullRequest !== undefined ? `#${job.pullRequest}` : ''}
      </PageHeroTitle>
      <PageHeroSubtitle data-testid="job-help">
        <span className="sr-only">Status: {job.stop && job.stop.confirmedAt === undefined ? 'Stopping' : r.label}. </span>
        {job.stop && job.stop.confirmedAt === undefined ? 'Stopping execution. Automatic continuation is paused.' : r.help}
      </PageHeroSubtitle>
      <PageHeroChips>
        <PageHeroChip tone={r.tone} data-testid="job-result">
          {job.stop && job.stop.confirmedAt === undefined ? 'Stopping…' : r.label}
        </PageHeroChip>
        {job.executionMode && <PageHeroChip>{job.executionMode === 'subscription' ? 'Claude subscription' : 'Standard worker'}</PageHeroChip>}
        {job.label && <PageHeroChip>Label {job.label}</PageHeroChip>}
        {job.pullRequest !== undefined && <PageHeroChip>Pull request event</PageHeroChip>}
        {job.sender && <PageHeroChip>By @{job.sender}</PageHeroChip>}
      </PageHeroChips>
      <JobStopStatus job={job} />
      <div className="mt-3 flex justify-end"><JobActions job={job} installationId={installationId} api={api} onRefresh={onRefresh} /></div>

      <dl className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-3" data-testid="job-facts">
        <Metric label={running ? 'Elapsed (live)' : 'Duration'}>{running ? `Running… ${elapsed !== null ? clock(elapsed * 1000) : ''}`.trim() : formatDuration(job.durationSeconds)}</Metric>
        <Metric label="Started">
          <span title={exact(job.createdAt)}>{relativeTime(job.createdAt)}</span>
        </Metric>
        <Metric label="Configuration">
          {job.configVersion !== undefined ? (
            <Link className="auth-link" to={`/installations/${installationId}/config/history`}>
              v{job.configVersion}
            </Link>
          ) : (
            '—'
          )}
        </Metric>
        <Metric label="Review">
          {loop ? (
            <>
              {loop.reviews} {loop.reviews === 1 ? 'review' : 'reviews'}
              <span className="block text-sm font-normal text-muted-foreground">
                {loop.rounds} {loop.rounds === 1 ? 'revision round' : 'revision rounds'}
                {loop.maxRevisions !== undefined ? ` of ${loop.maxRevisions}` : ''}
              </span>
            </>
          ) : (
            '—'
          )}
        </Metric>
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" data-testid="job-actions">
        {hasLogs && (
          <a className="auth-link inline-flex min-h-11 items-center font-semibold" href="#job-logs" onClick={onViewLogs}>
            {job.logs.includes('run.log') ? 'View run log' : 'View logs'}
          </a>
        )}
        {job.issueUrl && (
          <a className="auth-link inline-flex min-h-11 items-center font-semibold" href={job.issueUrl} target="_blank" rel="noreferrer">
            Issue ↗
          </a>
        )}
        {job.prUrl && (
          <a className="auth-link inline-flex min-h-11 items-center font-semibold" href={job.prUrl} target="_blank" rel="noreferrer" data-testid="job-pr">
            Pull request ↗
          </a>
        )}
        {conversationLink && (
          <a className="auth-link inline-flex min-h-11 items-center font-semibold" href={conversationLink} target="_blank" rel="noreferrer" data-testid="job-hero-conversation">
            {conversationLabel} ↗
          </a>
        )}
      </div>
      <Retry key={job.jobId} job={job} api={api} installationId={installationId} />

      <div className="mt-5 flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted-foreground" data-testid="job-identifiers">
        <CopyValue label="Job" value={job.jobId} />
        {t?.traceId && <CopyValue label="Trace" value={t.traceId} />}
        {t?.conversationId && <CopyValue label="Conversation" value={t.conversationId} />}
        {models.length > 0 && (
          <span data-testid="job-models">
            {models.length === 1 ? 'Model' : 'Models'} (observed) <code>{models.join(', ')}</code>
          </span>
        )}
        <span>
          Outcome <code>{job.outcome ?? 'running'}</code>
        </span>
      </div>
    </PageHero>
  );
}

const RUN_LABEL: Record<string, string> = { implement: 'Implementation', review: 'Review', revision: 'Revision' };
const runLabel = (run?: string) => (run ? (RUN_LABEL[run] ?? run) : 'Run');

/** What a span link is, in words: "Review · claude-opus", "First failing test run (Revision)", ... */
export function timelineLabel(l: JobTimelineEntry): { title: string; notes: string[] } {
  const inRun = l.run ? ` (${runLabel(l.run).toLowerCase()})` : '';
  switch (l.kind) {
    case 'agent': {
      const notes: string[] = [];
      if (l.verdict) notes.push(l.verdict === 'none' ? 'no verdict' : l.verdict.replace(/-/g, ' '));
      if (l.failed) notes.push('did not succeed');
      if (l.thrashing) notes.push('went in circles');
      return { title: `${runLabel(l.run)}${l.agent ? ` · ${l.agent}` : ''}`, notes };
    }
    case 'test_failed':
      return { title: `First failing test run${inRun}`, notes: [] };
    case 'test_green':
      return { title: `First passing test run after it${inRun}`, notes: [] };
    case 'verify_failed':
      return { title: `Failed verify command${inRun}`, notes: [] };
    case 'step_failed':
      return { title: `Failed step: ${(l.step ?? 'unknown').replace(/_/g, ' ')}`, notes: [] };
  }
}

const isProblem = (l: JobTimelineEntry) => l.kind === 'test_failed' || l.kind === 'verify_failed' || l.kind === 'step_failed' || Boolean(l.failed) || Boolean(l.thrashing);
const seconds = (ms: number) => formatDuration(Math.round(ms / 1000));
/** A time in the job, compactly: 0:08, 4:10, 1:02:30. */
export const clock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());

/**
 * What the agents did, read by the runner from their transcripts: totals and the job's moments
 * in order, on a bar the length of the job. Needs no destination; a moment links to its span when
 * the trace was sent somewhere that has links.
 */
function AgentWork({ job }: { job: JobView }) {
  const t = job.telemetry;
  const entries = t?.timeline ?? [];
  if (!t || (!entries.length && !t.totals)) return null;
  const total = Math.max(1, t.totals?.durationMs ?? Math.max(...entries.map((e) => (e.offsetMs ?? 0) + (e.durationMs ?? 0)), 1));
  return (
    <Card data-testid="job-work">
      <CardHeader>
        <CardTitle>What the agents did</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-5 text-sm">
        {t.totals && <Totals totals={t.totals} />}
        {entries.length > 0 && (
          <ol className="flex flex-col gap-2" data-testid="job-timeline">
            {entries.map((l, i) => {
              const { title, notes } = timelineLabel(l);
              const problem = isProblem(l);
              const bar = problem ? 'bg-warning-500' : l.kind === 'test_green' ? 'bg-success-500' : 'bg-primary-500';
              const left = Math.min(((l.offsetMs ?? 0) / total) * 100, 99.25);
              const width = Math.min(Math.max(0.75, ((l.durationMs ?? 0) / total) * 100), 100 - left);
              return (
                <li key={`${l.kind}-${i}`} className="grid grid-cols-[3.5rem_1fr] items-baseline gap-x-2 gap-y-1" data-testid={`job-timeline-${l.kind}`}>
                  <span className="whitespace-nowrap font-mono text-xs text-muted-foreground" title={l.offsetMs !== undefined ? `${seconds(l.offsetMs)} into the job` : undefined}>
                    {l.offsetMs !== undefined ? `+${clock(l.offsetMs)}` : ''}
                  </span>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {l.url ? (
                      <a className="auth-link" href={l.url} target="_blank" rel="noreferrer">
                        {title} ↗
                      </a>
                    ) : (
                      <span className="font-medium">{title}</span>
                    )}
                    {l.durationMs !== undefined && l.kind === 'agent' && <span className="text-muted-foreground">{seconds(l.durationMs)}</span>}
                    {notes.map((n) => (
                      <StatusBadge key={n} tone={problem ? 'warning' : 'neutral'}>
                        {n}
                      </StatusBadge>
                    ))}
                  </div>
                  {l.offsetMs !== undefined && (
                    <div className="relative col-start-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <div className={`absolute inset-y-0 rounded-full ${bar}`} style={{ left: `${left}%`, width: `${width}%` }} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function Totals({ totals }: { totals: JobTotals }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="job-totals">
      <Fact label="Agent runs">{totals.runs}</Fact>
      <Fact label="Tokens in / out">
        {tokens(totals.inputTokens)} / {tokens(totals.outputTokens)}
      </Fact>
      <Fact label="Reported cost">{totals.costUsd !== undefined ? `$${totals.costUsd.toFixed(2)}` : '—'}</Fact>
      <Fact label="Tool calls">
        {totals.toolCalls}
        {totals.toolErrors ? ` (${totals.toolErrors} failed)` : ''}
      </Fact>
      <Fact label="Went in circles">{totals.thrashing ? 'Yes' : 'No'}</Fact>
    </dl>
  );
}

/** Where the job's trace went: its links in the destination, the conversation, and how the export went. */
function Traces({ job, installationId, onRetry }: { job: JobView; installationId: number; onRetry?: () => void }) {
  const t = job.telemetry;
  const [copied, setCopied] = useState(false);
  if (!t || t.local) {
    const status = job.telemetryStatus;
    const finished = job.result !== 'running';
    const settings = (
      <Link className="auth-link font-semibold" to={`/installations/${installationId}/telemetry`}>
        {status === 'paused' ? 'Manage telemetry settings' : status === 'unknown' ? 'Check telemetry settings' : 'Set up agent telemetry'}
      </Link>
    );
    let message: string | null;
    if (t?.local) message = 'Local telemetry: this job did not export its traces. What it recorded locally is shown below.';
    else if (status === 'unknown') message = 'Unable to check telemetry settings.';
    else if (status === 'paused') message = 'Telemetry paused. This job has no telemetry report.';
    else if (status === 'enabled') message = finished ? 'No telemetry report available for this job. The console cannot tell whether it never started, ran with telemetry off, or lost its report.' : 'Telemetry enabled · trace details pending';
    else message = null;
    // Only an installation confirmed not configured is asked to set telemetry up.
    const showSettings = status === undefined || status === 'not_configured' || status === 'paused' || status === 'unknown';
    return (
      <Card data-testid="job-telemetry">
        <CardHeader>
          <CardTitle>Traces</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-2 text-sm">
          {message && <p data-testid="job-telemetry-status">{message}</p>}
          {status === 'unknown' && onRetry && (
            <button type="button" className="auth-link self-start font-semibold" onClick={onRetry}>
              Retry
            </button>
          )}
          {showSettings && settings}
        </CardBody>
      </Card>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t.conversationId ?? t.traceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard: the id is on screen.
    }
  };
  return (
    <Card data-testid="job-telemetry">
      <CardHeader>
        <CardTitle>Traces{t.destination ? ` in ${t.destination}` : ''}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {t.timelineUrl && (
            <a className="auth-link font-semibold" href={t.timelineUrl} target="_blank" rel="noreferrer" data-testid="job-timeline-link">
              {t.timelineLabel ?? 'Open conversation'} ↗
            </a>
          )}
          {!t.timelineUrl && t.conversationUrl && (
            <a className="auth-link font-semibold" href={t.conversationUrl} target="_blank" rel="noreferrer" data-testid="job-conversation-link" title={t.conversationHint ?? 'Every span of the conversation, by agent'}>
              Open conversation ↗
            </a>
          )}
          {t.traceUrl && (
            <a className={`auth-link ${t.timelineUrl || t.conversationUrl ? '' : 'font-semibold'}`} href={t.traceUrl} target="_blank" rel="noreferrer" data-testid="job-trace-link">
              View trace ↗
            </a>
          )}
          {t.conversationId && (
            <span className="flex items-center gap-2">
              Conversation <code data-testid="job-conversation">{t.conversationId}</code>
              <Button variant="ghost" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </span>
          )}
        </div>
        <p className={t.failed > 0 ? 'text-warning-700 dark:text-warning-300' : 'text-muted-foreground'} data-testid="job-telemetry-count">
          {t.exported} of {t.spans} span{t.spans === 1 ? '' : 's'} sent{t.lastError ? ` (last error: ${t.lastError})` : ''} · trace <code>{t.traceId}</code>
        </p>
      </CardBody>
    </Card>
  );
}

/** The other recent jobs of this job's conversation: the issue's implement run, its reviews and revisions. */
function Conversation({ job, others, installationId }: { job: JobView; others: JobView[]; installationId: number }) {
  if (!others.length) return null;
  // Oldest first, with this job in its place.
  const all = [...others, job].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <Card data-testid="job-conversation-card">
      <CardHeader>
        <CardTitle>This conversation</CardTitle>
      </CardHeader>
      <CardBody>
        <ol className="flex flex-col gap-2" data-testid="job-conversation-jobs">
          {all.map((j) => {
            const r = JOB_RESULT[j.result];
            const self = j.jobId === job.jobId;
            return (
              <li key={j.jobId} className="flex flex-wrap items-center gap-3 text-sm" data-testid={`job-conversation-${j.jobId}`}>
                <StatusBadge tone={r.tone}>{r.label}</StatusBadge>
                {self ? (
                  <strong>This job</strong>
                ) : (
                  <Link className="auth-link" to={`/installations/${installationId}/jobs/${j.jobId}`}>
                    {runLabel(j.detail?.steps?.[0]?.kind)}
                  </Link>
                )}
                <span title={exact(j.createdAt)}>{relativeTime(j.createdAt)}</span>
                {j.telemetry?.traceUrl && (
                  <a className="auth-link" href={j.telemetry.traceUrl} target="_blank" rel="noreferrer">
                    Trace ↗
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      </CardBody>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

const LOG_LABEL: Record<string, string> = { 'run.log': 'Agent transcript', 'updraft.log': 'Updraft log' };

function Logs({ job, api, installationId, names, name, onSelect }: {
  job: JobView;
  api: JobApi;
  installationId: number;
  names: string[];
  name: string;
  onSelect: (name: string) => void;
}) {
  // Which log the loaded state is for: another one selected is loading until its answer arrives.
  const [loaded, setLoaded] = useState<{ name: string; load: LogLoad } | null>(null);
  const log: LogLoad = loaded && loaded.name === name ? loaded.load : { state: 'loading' };
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!name) return;
    let live = true;
    api.jobLog(installationId, job.jobId, name).then(
      (out) => live && setLoaded({ name, load: { state: 'ok', log: out } }),
      (err: unknown) =>
        live &&
        setLoaded({
          name,
          load: err instanceof ApiError && err.code === 'log_expired' ? { state: 'expired' } : { state: 'error', message: err instanceof Error ? err.message : 'Could not load the log.' },
        }),
    );
    return () => {
      live = false;
    };
  }, [api, installationId, job.jobId, name]);

  // Open at the end, where a failure shows.
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [loaded]);

  if (!names.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardBody>
          <EmptyState
            title={job.result === 'running' ? 'Logs appear when the job ends' : 'No logs for this job'}
            description={job.result === 'running' ? 'The job uploads its logs as it finishes. This page refreshes on its own.' : 'The job ended before it wrote any, or it ran before logs were kept.'}
          />
        </CardBody>
      </Card>
    );
  }

  const text = log.state === 'ok' ? log.log.text : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an insecure context): nothing to do.
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${job.jobId}-${name}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card id="job-logs" tabIndex={-1} className="scroll-mt-20" data-testid="job-logs">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Logs</CardTitle>
        {names.length > 1 && <SegmentedControl aria-label="Log" value={name} onChange={onSelect} options={names.map((n) => ({ value: n, label: LOG_LABEL[n] ?? n }))} />}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {log.state === 'loading' && <Skeleton className="h-64" data-testid="log-loading" />}
        {log.state === 'expired' && (
          <EmptyState title="This log has expired" description="Logs are kept for the deployment's retention period, then deleted. The job's outcome above stays for 30 days." />
        )}
        {log.state === 'error' && (
          <Alert variant="error" data-testid="log-error">
            {log.message}
          </Alert>
        )}
        {log.state === 'ok' && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span data-testid="log-size">
                {log.log.truncated ? `The last ${formatBytes(new Blob([text]).size)} of ${formatBytes(log.log.size)}` : formatBytes(log.log.size)}
              </span>
              <span className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
                <Button variant="ghost" onClick={() => setWrap((w) => !w)} aria-pressed={wrap}>
                  {wrap ? 'No wrap' : 'Wrap lines'}
                </Button>
                <Button variant="ghost" onClick={() => void copy()} disabled={!text}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button variant="ghost" onClick={download} disabled={!text}>
                  Download
                </Button>
              </span>
            </div>
            {text ? (
              <pre
                ref={pre}
                tabIndex={0}
                aria-label={`${LOG_LABEL[name] ?? name}`}
                data-testid="log-text"
                className={`max-h-[32rem] overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
              >
                {text}
              </pre>
            ) : (
              <p className="text-sm">The log is empty.</p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
