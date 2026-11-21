import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardDescription, CardHeader, CardTitle, EmptyState, PageHero, PageHeroChip, PageHeroChips, PageHeroSubtitle, PageHeroTitle, SegmentedControl, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { ApiError, api as defaultApi, type ApiClient, type Delivery, type JobLog, type JobTraceLink, type JobView } from '../api/client';
import { DISPOSITION, JOB_RESULT, deliveryReason, formatBytes, formatDuration } from '../lib/diagnostics';
import { relativeTime } from '../lib/time';
import { Lifecycle } from '../components/lifecycle';

type JobApi = Pick<ApiClient, 'job' | 'jobLog'>;
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

  const running = load.state === 'ok' && load.job.result === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [running, refresh, refreshMs]);

  return (
    <div className="flex flex-col gap-6">
      <Link className="auth-link" to={`/installations/${id}`}>
        ← Installation
      </Link>
      {load.state === 'loading' && <Skeleton className="h-40" data-testid="job-loading" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="job-error">
          {load.message}
        </Alert>
      )}
      {load.state === 'ok' && <Loaded job={load.job} deliveries={load.deliveries} conversation={load.conversation ?? []} api={api} installationId={installationId} />}
    </div>
  );
}

function Loaded({ job, deliveries, conversation, api, installationId }: { job: JobView; deliveries: Delivery[]; conversation: JobView[]; api: JobApi; installationId: number }) {
  const r = JOB_RESULT[job.result];
  return (
    <>
      <PageHero data-testid="job">
        <PageHeroTitle>
          {job.repository}
          {job.issue !== undefined ? `#${job.issue}` : ''}
        </PageHeroTitle>
        <PageHeroSubtitle data-testid="job-help">{r.help}</PageHeroSubtitle>
        <PageHeroChips>
          <PageHeroChip tone={r.tone} data-testid="job-result">
            {r.label}
          </PageHeroChip>
          {job.label && <PageHeroChip>Label {job.label}</PageHeroChip>}
          {job.sender && <PageHeroChip>By @{job.sender}</PageHeroChip>}
        </PageHeroChips>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          {job.issueUrl && (
            <a className="auth-link" href={job.issueUrl} target="_blank" rel="noreferrer">
              Issue ↗
            </a>
          )}
          {job.prUrl && (
            <a className="auth-link" href={job.prUrl} target="_blank" rel="noreferrer" data-testid="job-pr">
              Pull request ↗
            </a>
          )}
        </div>
      </PageHero>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="job-facts">
            <Fact label="Started">
              <span title={exact(job.createdAt)}>{relativeTime(job.createdAt)}</span>
            </Fact>
            <Fact label="Duration">{job.result === 'running' ? 'Running…' : formatDuration(job.durationSeconds)}</Fact>
            <Fact label="Configuration">
              {job.configVersion !== undefined ? (
                <Link className="auth-link" to={`/installations/${installationId}/config/history`}>
                  v{job.configVersion}
                </Link>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label="Outcome">
              <code className="text-sm">{job.outcome ?? 'running'}</code>
            </Fact>
          </dl>
          <p className="mt-4 text-sm">
            Job <code>{job.jobId}</code>
          </p>
        </CardBody>
      </Card>

      <Card data-testid="job-lifecycle-card">
        <CardHeader>
          <CardTitle>Lifecycle</CardTitle>
          <CardDescription>What the run did, in order: the change, each review and revision, and where the pull request ended up.</CardDescription>
        </CardHeader>
        <CardBody>
          <Lifecycle detail={job.detail} running={job.result === 'running'} />
        </CardBody>
      </Card>

      <AgentTimeline job={job} installationId={installationId} />

      <Conversation job={job} others={conversation} installationId={installationId} />

      {deliveries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Deliveries</CardTitle>
            <CardDescription>The webhook deliveries for this job's event, oldest first. A redelivery from GitHub shows up here too.</CardDescription>
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

      <Logs job={job} api={api} installationId={installationId} />
    </>
  );
}

const RUN_LABEL: Record<string, string> = { implement: 'Implementation', review: 'Review', revision: 'Revision' };
const runLabel = (run?: string) => (run ? (RUN_LABEL[run] ?? run) : 'Run');

/** What a span link is, in words: "Review · claude-opus", "First failing test run (Revision)", ... */
export function traceLinkLabel(l: JobTraceLink): { title: string; notes: string[] } {
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

/** Where to see this job's agents at work: its trace, the spans worth opening it at, and the issue's conversation in Agent Timeline. */
function AgentTimeline({ job, installationId }: { job: JobView; installationId: number }) {
  const t = job.telemetry;
  const [copied, setCopied] = useState(false);
  if (!t) {
    return (
      <Card data-testid="job-telemetry">
        <CardHeader>
          <CardTitle>Agent timeline</CardTitle>
          <CardDescription>
            Send what the agents did (every model call and tool call, in order) to Honeycomb and watch it in Agent Timeline.{' '}
            <Link className="auth-link" to={`/installations/${installationId}/telemetry`}>
              Set up agent telemetry
            </Link>
          </CardDescription>
        </CardHeader>
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
  const links = t.links ?? [];
  return (
    <Card data-testid="job-telemetry">
      <CardHeader>
        <CardTitle>Agent timeline</CardTitle>
        <CardDescription>This job's agents, as traced in Honeycomb. The issue's conversation holds this job and every review and revision after it.</CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {t.timelineUrl && (
            <a className="auth-link font-semibold" href={t.timelineUrl} target="_blank" rel="noreferrer" data-testid="job-timeline-link">
              Open in Agent Timeline ↗
            </a>
          )}
          {!t.timelineUrl && t.conversationUrl && (
            <a
              className="auth-link font-semibold"
              href={t.conversationUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="job-conversation-link"
              title="Every span of the conversation, by agent. Select the conversation id in the results to open it in Agent Timeline."
            >
              Open conversation ↗
            </a>
          )}
          {t.traceUrl && (
            <a className={`auth-link ${t.timelineUrl || t.conversationUrl ? '' : 'font-semibold'}`} href={t.traceUrl} target="_blank" rel="noreferrer" data-testid="job-trace-link">
              View trace in Honeycomb ↗
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
        {!t.timelineUrl && t.conversationUrl && <p className="text-muted-foreground">In the conversation's results, select its id to open it in Agent Timeline.</p>}
        {links.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="font-medium">Jump to</h3>
            <ul className="flex flex-col gap-1.5" data-testid="job-trace-links">
              {links.map((l, i) => {
                const { title, notes } = traceLinkLabel(l);
                const problem = l.kind === 'test_failed' || l.kind === 'verify_failed' || l.kind === 'step_failed' || l.failed || l.thrashing;
                return (
                  <li key={`${l.kind}-${i}`} className="flex flex-wrap items-center gap-2" data-testid={`job-trace-link-${l.kind}`}>
                    <a className="auth-link" href={l.url} target="_blank" rel="noreferrer">
                      {title} ↗
                    </a>
                    {notes.map((n) => (
                      <StatusBadge key={n} tone={problem ? 'warning' : 'neutral'}>
                        {n}
                      </StatusBadge>
                    ))}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
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
        <CardDescription>
          Every recent job of <code>{job.telemetry?.conversationId ?? `${job.repository}#${job.issue ?? ''}`}</code>, oldest first: the implementation, each review and revision.
        </CardDescription>
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

function Logs({ job, api, installationId }: { job: JobView; api: JobApi; installationId: number }) {
  // The agent's transcript first: that is where a failure usually shows.
  const names = [...job.logs].sort((a, b) => (a === 'run.log' ? -1 : b === 'run.log' ? 1 : a.localeCompare(b)));
  const [name, setName] = useState(names[0] ?? '');
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
    <Card data-testid="job-logs">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>Logs</CardTitle>
          <CardDescription>Secrets are redacted before logs leave the job, and again before they are shown.</CardDescription>
        </div>
        {names.length > 1 && <SegmentedControl aria-label="Log" value={name} onChange={setName} options={names.map((n) => ({ value: n, label: LOG_LABEL[n] ?? n }))} />}
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
              <span className="ml-auto flex flex-wrap gap-2">
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
