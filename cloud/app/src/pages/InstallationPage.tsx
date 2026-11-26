import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHero,
  PageHeroChip,
  PageHeroChips,
  PageHeroSubtitle,
  PageHeroTitle,
  SegmentedControl,
  Skeleton,
  StatTile,
  StatusBadge,
} from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type Delivery, type DeliveryDisposition, type JobView, type Overview, type WorkflowView } from '../api/client';
import { WorkflowsList } from '../components/workflows';
import { DISPOSITION, INSTALLATION, JOB_RESULT, deliveryReason, formatDuration, installationSettingsUrl } from '../lib/diagnostics';
import { relativeTime } from '../lib/time';
import { LoopBadges } from '../components/lifecycle';
import { JobActions, JobStopStatus } from '../components/job-actions';
import { SetupChecklist, setupComplete, setupSteps } from '../components/setup';
import { ReadinessPanel } from '../components/readiness';

type InstallationApi = Pick<ApiClient, 'overview' | 'jobs' | 'deliveries'> & Partial<Pick<ApiClient, 'workflows' | 'stopJob' | 'resumeJob' | 'cancelQueuedJob' | 'readiness'>>;
type Tab = 'jobs' | 'workflows' | 'deliveries' | 'repositories';
type Load = { state: 'loading' } | { state: 'ok'; overview: Overview; jobs: JobView[]; deliveries: Delivery[]; workflows: WorkflowView[] } | { state: 'error'; message: string };

/** While a job runs, the page looks again this often. */
export const REFRESH_MS = 15_000;
const exact = (iso: string) => new Date(iso).toLocaleString();
const TABS: Tab[] = ['jobs', 'workflows', 'deliveries', 'repositories'];

/**
 * One installation of the App (#71): is it working, and if not, why. A hero with its status,
 * the things that need attention (with where to fix each), its numbers at a glance, and three
 * lists: jobs, webhook deliveries, repositories. Refreshes itself while a job runs.
 */
export function InstallationPage({ api = defaultApi, refreshMs = REFRESH_MS }: { api?: InstallationApi; refreshMs?: number }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'jobs';
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };
  const live = useRef(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [overview, jobs, deliveries, workflows] = await Promise.all([
        api.overview(installationId),
        api.jobs(installationId),
        api.deliveries(installationId),
        // Workflows are an addition: an API without them (or a failure to read them) leaves the rest of the page as it is.
        api.workflows ? api.workflows(installationId).catch(() => ({ workflows: [] as WorkflowView[] })) : Promise.resolve({ workflows: [] as WorkflowView[] }),
      ]);
      if (live.current) {
        setLoad({ state: 'ok', overview, jobs: jobs.jobs, deliveries: deliveries.deliveries, workflows: workflows.workflows });
        setCheckedAt(Date.now());
      }
    } catch (err) {
      // A failed refresh keeps what is on screen; only a first load shows the error.
      if (live.current) setLoad((prev) => (prev.state === 'ok' ? prev : { state: 'error', message: err instanceof Error ? err.message : 'Could not load the installation.' }));
    } finally {
      if (live.current) setRefreshing(false);
    }
  }, [api, installationId]);

  useEffect(() => {
    live.current = true;
    if (valid) void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh, valid]);

  const running = tab !== 'repositories' && load.state === 'ok' ? load.overview.activity.running + Number(load.jobs.some((job) => !!job.stop?.error)) : 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [running, refresh, refreshMs]);

  return (
    <div className="dashboard flex min-w-0 flex-col gap-4 sm:gap-6">
      {load.state === 'loading' && (
        <div className="flex flex-col gap-4" data-testid="installation-loading">
          <Skeleton className="h-32" />
          <div className="grid min-w-0 grid-cols-1 gap-3 min-[380px]:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        </div>
      )}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="installation-error">
          {load.message}
        </Alert>
      )}
      {load.state === 'ok' && (
        tab === 'repositories' ? (
          <RepositoryView api={api} overview={load.overview} onRefresh={() => void refresh()} refreshing={refreshing} />
        ) : (
          <ActivityView
            api={api}
            overview={load.overview}
            jobs={load.jobs}
            deliveries={load.deliveries}
            workflows={load.workflows}
            tab={tab}
            onTab={(t) => setParams(t === 'jobs' ? {} : { tab: t }, { replace: true })}
            onRefresh={() => void refresh()}
            refreshing={refreshing}
            checkedAt={checkedAt}
          />
        )
      )}
    </div>
  );
}

function RepositoryView({ api, overview, onRefresh, refreshing }: { api: InstallationApi; overview: Overview; onRefresh: () => void; refreshing: boolean }) {
  const base = `/installations/${overview.tenant.installationId}`;
  const readiness = api.readiness;
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <p className="text-muted-foreground">{overview.tenant.accountLogin}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a className="auth-link text-sm" href={installationSettingsUrl(overview.tenant)} target="_blank" rel="noreferrer">
            Manage GitHub access ↗
          </a>
          <Button variant="ghost" onClick={onRefresh} loading={refreshing} aria-label="Refresh repositories">
            Refresh
          </Button>
        </div>
      </header>
      {readiness && <ReadinessPanel api={{ readiness }} tenant={overview.tenant} base={base} />}
      <Card>
        <CardBody>
          <RepositoriesList repositories={overview.repositories} base={base} />
        </CardBody>
      </Card>
    </>
  );
}

function ActivityView({
  overview, jobs, deliveries, workflows, tab, onTab, onRefresh, refreshing, checkedAt, api,
}: Omit<Extract<Load, { state: 'ok' }>, 'state'> & {
  api: InstallationApi;
  tab: Exclude<Tab, 'repositories'>;
  onTab: (tab: Exclude<Tab, 'repositories'>) => void;
  onRefresh: () => void;
  refreshing: boolean;
  checkedAt: number | null;
}) {
  const t = overview.tenant;
  const status = INSTALLATION[overview.installation.status];
  const base = `/installations/${t.installationId}`;
  const configured = overview.repositories.filter((r) => r.configured);
  const keysSet = overview.keys.filter((k) => k.configured).length;
  const finished = Object.entries(overview.activity.jobs).reduce((n, [, v]) => n + (v ?? 0), 0);
  const succeeded = (overview.activity.jobs.success ?? 0) + (overview.activity.jobs.nothing_to_do ?? 0);
  const deliveryTotal = Object.values(overview.activity.deliveries).reduce((n, v) => n + (v ?? 0), 0);
  const steps = setupSteps(overview, base);
  const inSetup = !setupComplete(steps);
  const queuedJobs = jobs.filter((job) => job.result === 'queued');
  const runningJobs = jobs.filter((job) => job.result === 'running');
  const recentJobs = jobs.filter((job) => job.result !== 'running' && job.result !== 'queued');

  return (
    <>
      <PageHero data-testid="installation">
        <PageHeroTitle>{t.accountLogin}</PageHeroTitle>
        <PageHeroSubtitle>{status.help}</PageHeroSubtitle>
        <PageHeroChips>
          <PageHeroChip tone={status.tone} data-testid="installation-status">
            {status.label}
          </PageHeroChip>
          <PageHeroChip>{t.accountType === 'Organization' ? 'Organization' : 'Personal account'}</PageHeroChip>
          {overview.activity.running > 0 && <PageHeroChip tone="primary">{overview.activity.running === 1 ? '1 job running' : `${overview.activity.running} jobs running`}</PageHeroChip>}
        </PageHeroChips>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <a className="auth-link" href={installationSettingsUrl(t)} target="_blank" rel="noreferrer">
            Installation on GitHub ↗
          </a>
          {api.readiness && (
            <Link className="auth-link" to={`${base}?tab=repositories`} data-testid="readiness-link">
              Repository readiness
            </Link>
          )}
          <span className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
            {checkedAt !== null && <span aria-live="polite">Updated {relativeTime(new Date(checkedAt).toISOString())}</span>}
            <Button variant="ghost" onClick={onRefresh} loading={refreshing} aria-label="Refresh">
              Refresh
            </Button>
          </span>
        </div>
      </PageHero>

      <Attention overview={overview} base={base} skip={inSetup ? SETUP_COVERS : NONE} />

      <SetupChecklist steps={steps} />

      {runningJobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Running jobs</CardTitle>
          </CardHeader>
          <CardBody>
            <JobsList jobs={runningJobs} base={base} api={api} installationId={t.installationId} onRefresh={onRefresh} />
          </CardBody>
        </Card>
      )}

      {queuedJobs.length > 0 && (
        <Card data-testid="queued-jobs">
          <CardHeader>
            <CardTitle>Queued jobs</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="mb-2 text-sm text-muted-foreground">These start automatically, in this order, when execution capacity is available. Nothing is counted against quotas while they wait.</p>
            <JobsList jobs={queuedJobs} base={base} api={api} installationId={t.installationId} onRefresh={onRefresh} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Recent activity</CardTitle>
          <SegmentedControl<Exclude<Tab, 'repositories'>>
            aria-label="Show"
            value={tab}
            onChange={onTab}
            options={[
              { value: 'jobs', label: `Jobs (${recentJobs.length})` },
              { value: 'workflows', label: `Workflows (${workflows.length})` },
              { value: 'deliveries', label: `Deliveries (${deliveries.length})` },
            ]}
          />
        </CardHeader>
        <CardBody>
          {tab === 'jobs' && (recentJobs.length === 0 && runningJobs.length > 0
            ? <EmptyState title="No finished jobs yet" description="Running jobs appear above until they finish." />
            : <JobsList jobs={recentJobs} base={base} api={api} installationId={t.installationId} onRefresh={onRefresh} />)}
          {tab === 'workflows' && <WorkflowsList workflows={workflows} base={base} />}
          {tab === 'deliveries' && <DeliveriesList deliveries={deliveries} base={base} />}
        </CardBody>
      </Card>

      <div className="grid min-w-0 grid-cols-1 gap-3 min-[380px]:grid-cols-2 xl:grid-cols-4" data-testid="stats">
        <StatTile
          label="Configuration"
          value={overview.config.activeVersion === null ? 'None' : `v${overview.config.activeVersion}`}
          meta={
            overview.config.publishedAt ? (
              <span title={exact(overview.config.publishedAt)}>
                Published {relativeTime(overview.config.publishedAt)}
                {overview.config.publishedBy ? ` by ${overview.config.publishedBy}` : ''}
              </span>
            ) : (
              'Nothing published yet'
            )
          }
        />
        <StatTile label="Repositories" value={`${configured.length} of ${overview.repositories.filter((r) => r.reachable).length}`} meta="configured, of those the App reaches" />
        <StatTile label="Agent keys" value={`${keysSet} of ${overview.keys.length}`} meta={overview.keys.some((k) => k.required && !k.configured) ? 'A required key is missing' : 'set'} />
        <StatTile
          label={overview.activity.window.jobsComplete ? 'Jobs, 30 days' : `Latest ${overview.activity.window.jobs} jobs`}
          value={finished === 0 ? '0' : `${Math.round((succeeded / finished) * 100)}%`}
          meta={finished === 0 ? `${deliveryTotal} deliveries, no jobs finished yet` : `succeeded, of ${finished} finished`}
        />
      </div>
    </>
  );
}

/** While the setup checklist is shown, what it already says (the App, the config, the keys). */
const SETUP_COVERS = new Set(['permissions', 'suspended', 'config', 'keys']);
const NONE = new Set<string>();

/** What needs doing before jobs can run, each with where to do it; `skip`: what the setup checklist already says. */
function Attention({ overview, base, skip }: { overview: Overview; base: string; skip: Set<string> }) {
  const t = overview.tenant;
  const items: { id: string; text: ReactNode; action?: ReactNode }[] = [];
  const github = (label: string) => (
    <a className="auth-link" href={installationSettingsUrl(t)} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  );
  const { status, missingPermissions, checked } = overview.installation;
  if (status === 'missing_permissions') {
    items.push({
      id: 'permissions',
      text: (
        <>
          The App is missing {missingPermissions.length === 1 ? 'a permission' : 'permissions'} jobs need:{' '}
          {missingPermissions.map((p, i) => (
            <span key={p.name}>
              {i > 0 && ', '}
              <code>{p.name}</code> ({p.granted ? `${p.granted}, needs ${p.needs}` : `needs ${p.needs}`})
            </span>
          ))}
          .
        </>
      ),
      action: github('Review permissions on GitHub'),
    });
  }
  if (status === 'suspended') items.push({ id: 'suspended', text: 'The App is suspended on GitHub, so no jobs start.', action: github('Unsuspend on GitHub') });
  if (!checked) items.push({ id: 'unchecked', text: 'GitHub could not be asked just now, so this is the last known status.' });
  if (overview.config.activeVersion === null && status !== 'uninstalled') {
    items.push({ id: 'config', text: 'No configuration is published, so labeled issues start nothing.', action: <Link className="auth-link" to={`${base}/config`}>Configure repositories</Link> });
  }
  const missingKeys = overview.keys.filter((k) => k.required && !k.configured);
  if (missingKeys.length) {
    items.push({
      id: 'keys',
      text: `${missingKeys.map((k) => k.name).join(' and ')} ${missingKeys.length > 1 ? 'are' : 'is'} required by your configuration and not set.`,
      action: <Link className="auth-link" to={`${base}/keys`}>Add {missingKeys.length > 1 ? 'keys' : 'the key'}</Link>,
    });
  }
  const unreachable = overview.repositories.filter((r) => r.configured && !r.reachable);
  if (unreachable.length && status !== 'uninstalled' && status !== 'suspended') {
    items.push({
      id: 'unreachable',
      text: (
        <>
          The App no longer reaches {unreachable.map((r) => r.fullName).join(', ')}, which {unreachable.length > 1 ? 'are' : 'is'} configured. Jobs for {unreachable.length > 1 ? 'them' : 'it'} cannot run.
        </>
      ),
      action: github('Choose repositories on GitHub'),
    });
  }
  const shown = items.filter((i) => !skip.has(i.id));
  if (!shown.length) return null;
  return (
    <Card data-testid="attention">
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
      </CardHeader>
      <CardBody>
        <ul className="flex flex-col gap-3">
          {shown.map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-2" data-testid={`attention-${i.id}`}>
              <span>{i.text}</span>
              {i.action}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function JobsList({ jobs, base, api, installationId, onRefresh }: { jobs: JobView[]; base: string; api?: InstallationApi; installationId?: number; onRefresh?: () => void }) {
  if (!jobs.length) {
    return <EmptyState title="No jobs yet" description="Label an issue in a configured repository with one of its trigger labels, and the job shows up here." />;
  }
  return (
    <ul className="flex flex-col divide-y divide-border" aria-label="Jobs">
      {jobs.map((j) => {
        const r = JOB_RESULT[j.result];
        return (
          <li key={j.jobId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-4" data-testid={`job-${j.jobId}`}>
            <StatusBadge tone={r.tone}>{j.stop && j.stop.confirmedAt === undefined ? 'Stopping…' : r.label}</StatusBadge>
            {api && installationId && onRefresh && <div className="ml-auto"><JobActions job={j} installationId={installationId} api={api} onRefresh={onRefresh} /></div>}
            <Link className="auth-link min-w-0 basis-full break-words font-medium sm:basis-auto" to={`${base}/jobs/${j.jobId}`}>
              {j.repository}
              {j.issue !== undefined ? `#${j.issue}` : j.pullRequest !== undefined ? `#${j.pullRequest}` : ''}
            </Link>
            {j.pullRequest !== undefined && <StatusBadge tone="neutral">Review loop</StatusBadge>}
            {j.issueUrl && (
              <a className="auth-link text-sm" href={j.issueUrl} target="_blank" rel="noreferrer">
                Issue ↗
              </a>
            )}
            {j.prUrl && (
              <a className="auth-link text-sm" href={j.prUrl} target="_blank" rel="noreferrer">
                Pull request ↗
              </a>
            )}
            <LoopBadges job={j} />
            {j.stop && <div className="basis-full"><JobStopStatus job={j} /></div>}
            {j.telemetry?.traceUrl && (
              <a className="auth-link text-sm" href={j.telemetry.traceUrl} target="_blank" rel="noreferrer">
                Trace ↗
              </a>
            )}
            {(j.telemetry?.timelineUrl ?? j.telemetry?.conversationUrl) && (
              <a
                className="auth-link text-sm"
                href={j.telemetry.timelineUrl ?? j.telemetry.conversationUrl}
                target="_blank"
                rel="noreferrer"
                title="Every job of this issue: its implementation, reviews and revisions"
                data-testid={`job-conversation-${j.jobId}`}
              >
                Conversation ↗
              </a>
            )}
            <span className="flex w-full flex-wrap items-center gap-3 text-sm text-muted-foreground sm:ml-auto sm:w-auto">
              {j.configVersion !== undefined && <span title="Configuration version">v{j.configVersion}</span>}
              {j.result === 'queued' && j.queue ? (
                <>
                  {j.queue.position !== undefined && <span title="Its place in this installation's queue (the order it starts in)" data-testid={`job-position-${j.jobId}`}>#{j.queue.position} in line</span>}
                  <span title={j.queue.waitMessage}>Waiting {formatDuration(j.queue.waitedSeconds)}</span>
                </>
              ) : (
                j.result !== 'running' && <span title="Duration">{formatDuration(j.durationSeconds)}</span>
              )}
              <span title={exact(j.createdAt)}>{relativeTime(j.createdAt)}</span>
            </span>
            {j.result === 'queued' && j.queue && <p className="basis-full text-sm text-muted-foreground">{j.queue.waitMessage} It starts automatically; no action is needed.</p>}
          </li>
        );
      })}
    </ul>
  );
}

type DeliveryFilter = 'all' | 'launched' | 'problems' | 'filtered';
const PROBLEMS: DeliveryDisposition[] = ['throttled', 'launch_failed'];

function DeliveriesList({ deliveries, base }: { deliveries: Delivery[]; base: string }) {
  const [filter, setFilter] = useState<DeliveryFilter>('all');
  if (!deliveries.length) {
    return <EmptyState title="No deliveries yet" description="Webhook deliveries from GitHub for this installation show up here, with what Updraft did with each." />;
  }
  const shown = deliveries.filter((d) =>
    filter === 'all' ? true : filter === 'launched' ? d.disposition === 'launched' : filter === 'problems' ? PROBLEMS.includes(d.disposition) : d.disposition === 'filtered' || d.disposition === 'deduped' || d.disposition === 'coalesced',
  );
  const problems = deliveries.filter((d) => PROBLEMS.includes(d.disposition)).length;
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl<DeliveryFilter>
        aria-label="Filter deliveries"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'launched', label: 'Launched' },
          { value: 'problems', label: `Problems${problems ? ` (${problems})` : ''}` },
          { value: 'filtered', label: 'Skipped' },
        ]}
      />
      {shown.length === 0 ? (
        <p className="text-sm">No deliveries match.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border" data-testid="delivery-list">
          {shown.map((d) => {
            const disp = DISPOSITION[d.disposition];
            return (
              <li key={`${d.at}-${d.deliveryId}`} className="flex flex-col gap-1 py-3" data-testid={`delivery-${d.deliveryId}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StatusBadge tone={disp.tone}>{disp.label}</StatusBadge>
                  <span className="font-medium">
                    {d.event}
                    {d.action ? `.${d.action}` : ''}
                  </span>
                  {d.repository && (
                    <span>
                      {d.repository}
                      {d.issue !== undefined ? `#${d.issue}` : d.pullRequest !== undefined ? `#${d.pullRequest}` : ''}
                    </span>
                  )}
                  {d.label && <code className="text-sm">{d.label}</code>}
                  {d.sender && <span className="text-sm">by @{d.sender}</span>}
                  <span className="ml-auto text-sm" title={exact(d.at)}>
                    {relativeTime(d.at)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span>{deliveryReason(d)}</span>
                  {d.disposition === 'routine_triggered' && d.message?.startsWith('https://claude.ai/code/session_') && (
                    <a className="auth-link" href={d.message} target="_blank" rel="noreferrer">View Claude session</a>
                  )}
                  {d.jobId && d.reason === 'native_waiting_for_sign_in' && (
                    // A Codex wait is recorded as one (server jobs/deliveries.ts); every other is Claude's.
                    d.provider === 'codex'
                      ? <Link className="auth-link" to={`${base}/codex?request=${encodeURIComponent(d.jobId)}`}>Open ChatGPT sign-in request</Link>
                      : <Link className="auth-link" to={`${base}/claude?request=${encodeURIComponent(d.jobId)}`}>Open Claude sign-in request</Link>
                  )}
                  {d.jobId && d.disposition === 'launched' && (
                    <Link className="auth-link" to={`${base}/jobs/${d.jobId}`}>
                      View job
                    </Link>
                  )}
                  {d.reason === 'missing_key' && (
                    <Link className="auth-link" to={`${base}/keys`}>
                      Agent keys
                    </Link>
                  )}
                  {(d.reason === 'unknown_repo' || d.reason === 'not_trigger' || d.reason === 'actor_not_allowed' || d.reason === 'paused') && (
                    <Link className="auth-link" to={`${base}/config`}>
                      Configuration
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RepositoriesList({ repositories, base }: { repositories: Overview['repositories']; base: string }) {
  if (!repositories.length) {
    return <EmptyState title="No repositories" description="The installation cannot access any repositories yet. Choose them in the App's installation settings on GitHub." />;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border" data-testid="repository-list">
        {repositories.map((r) => (
          <li key={r.fullName} className="flex flex-wrap items-center justify-between gap-3 py-2">
            {r.htmlUrl ? (
              <a className="auth-link" href={r.htmlUrl} target="_blank" rel="noreferrer">
                {r.fullName}
              </a>
            ) : (
              <span>{r.fullName}</span>
            )}
            <span className="flex flex-wrap items-center gap-2">
              {r.private && <StatusBadge tone="neutral">Private</StatusBadge>}
              {!r.reachable ? (
                <StatusBadge tone="error">Not reachable</StatusBadge>
              ) : r.paused ? (
                <StatusBadge tone="warning">Paused</StatusBadge>
              ) : r.configured ? (
                <StatusBadge tone="success">Configured</StatusBadge>
              ) : (
                <StatusBadge tone="neutral">Not configured</StatusBadge>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm">
        Choose which repositories the App reaches on GitHub; choose which of them Updraft works on, and how, under{' '}
        <Link className="auth-link" to={`${base}/config`}>
          Configure
        </Link>
        .
      </p>
    </div>
  );
}
