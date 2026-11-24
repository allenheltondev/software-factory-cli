import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHero,
  PageHeroChip,
  PageHeroChips,
  PageHeroSubtitle,
  PageHeroTitle,
  SegmentedControl,
  Select,
  Skeleton,
  StatTile,
  StatusBadge,
} from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type CodingModelStats, type Insights, type InsightsWindow, type Overview, type ReviewModelStats, type StatsSection } from '../api/client';
import { Bars, DailyColumns, Legend, RateMeter } from '../components/charts';
import { avg, duration, fillDays, MERGE_BLOCK, modelName, pct, ratio, repoRows, WINDOWS, type RepoRow } from '../lib/insights';
import { relativeTime } from '../lib/time';

type InsightsApi = Pick<ApiClient, 'insights' | 'overview'>;
type Load = { state: 'loading' } | { state: 'ok'; insights: Insights; overview: Overview | null } | { state: 'error'; message: string };

/** While jobs are running, the page looks again this often (the runners checkpoint state every ~20 s). */
export const INSIGHTS_REFRESH_MS = 30_000;
const exact = (iso: string) => new Date(iso).toLocaleString();
const WINDOW_VALUES = WINDOWS.map((w) => w.value);

const SUCCESS = { fill: 'fill-success-500 dark:fill-success-400', swatch: 'bg-success-500 dark:bg-success-400' };
const FAILURE = { fill: 'fill-error-500 dark:fill-error-400', swatch: 'bg-error-500 dark:bg-error-400' };
const CAUGHT = { fill: 'fill-warning-500 dark:fill-warning-400', swatch: 'bg-warning-500 dark:bg-warning-400' };
const PRIMARY = { fill: 'fill-primary-500 dark:fill-primary-400', swatch: 'bg-primary-500 dark:bg-primary-400' };

/**
 * How the factory is doing, for one installation: issues worked and how they ended, what review
 * caught and how many rounds it took, per repository, and how each model does at writing code and
 * at reviewing it. Every number is `updraft stats` over the installation's shared state
 * (docs/stats.md), so it means the same here as on the command line.
 */
export function InsightsPage({ api = defaultApi, refreshMs = INSIGHTS_REFRESH_MS }: { api?: InsightsApi; refreshMs?: number }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [params, setParams] = useSearchParams();
  const window: InsightsWindow = WINDOW_VALUES.includes(params.get('window') as InsightsWindow) ? (params.get('window') as InsightsWindow) : '30d';
  const repo = params.get('repo') ?? '';
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };
  const live = useRef(true);
  const overviewRef = useRef<Overview | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [insights, overview] = await Promise.all([
        api.insights(installationId, { window, ...(repo ? { repo } : {}) }),
        // The account's name and its configured repositories; the page works without them.
        overviewRef.current ? Promise.resolve(overviewRef.current) : api.overview(installationId).catch(() => null),
      ]);
      overviewRef.current = overview;
      if (live.current) setLoad({ state: 'ok', insights, overview });
    } catch (err) {
      if (live.current) setLoad((prev) => (prev.state === 'ok' ? prev : { state: 'error', message: err instanceof Error ? err.message : 'Could not load the insights.' }));
    } finally {
      if (live.current) setRefreshing(false);
    }
  }, [api, installationId, window, repo]);

  useEffect(() => {
    live.current = true;
    if (valid) void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh, valid]);

  const active = load.state === 'ok' ? load.insights.report.overall.work.current.running.total + load.insights.report.overall.work.current.queued.total : 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [active, refresh, refreshMs]);

  const set = (next: { window?: InsightsWindow; repo?: string }) => {
    const w = next.window ?? window;
    const r = next.repo ?? repo;
    setParams({ ...(w !== '30d' ? { window: w } : {}), ...(r ? { repo: r } : {}) }, { replace: true });
  };

  return (
    <div className="flex flex-col gap-6">
      <Link className="auth-link" to={`/installations/${id}`}>
        ← Installation
      </Link>
      {load.state === 'loading' && (
        <div className="flex flex-col gap-4" data-testid="insights-loading">
          <Skeleton className="h-32" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-56" />
        </div>
      )}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="insights-error">
          {load.message}
        </Alert>
      )}
      {load.state === 'ok' && <Loaded load={load} installationId={installationId} window={window} repo={repo} onChange={set} onRefresh={() => void refresh()} refreshing={refreshing} />}
    </div>
  );
}

function Loaded({
  load,
  installationId,
  window,
  repo,
  onChange,
  onRefresh,
  refreshing,
}: {
  load: Extract<Load, { state: 'ok' }>;
  installationId: number;
  window: InsightsWindow;
  repo: string;
  onChange: (next: { window?: InsightsWindow; repo?: string }) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { insights, overview } = load;
  const report = insights.report;
  const s = report.overall;
  const base = `/installations/${installationId}`;
  const configured = (overview?.repositories ?? []).filter((r) => r.configured).map((r) => r.fullName);
  const repoChoices = [...new Set([...configured, ...report.byRepo.map((r) => r.repo)])].sort((a, b) => a.localeCompare(b));
  const windowLabel = WINDOWS.find((w) => w.value === window)!.label;
  const empty = !insights.hasState || report.facts.total === 0;

  return (
    <>
      <PageHero data-testid="insights">
        <PageHeroTitle>Insights{overview ? ` · ${overview.tenant.accountLogin}` : ''}</PageHeroTitle>
        <PageHeroSubtitle>How the factory is doing: issues worked, what review caught, how many rounds it took, and how each model does at coding and at reviewing.</PageHeroSubtitle>
        <PageHeroChips>
          <PageHeroChip tone="primary">{report.repo ?? 'All repositories'}</PageHeroChip>
          <PageHeroChip>{windowLabel}</PageHeroChip>
          {s.work.current.running.total > 0 && <PageHeroChip tone="primary">{s.work.current.running.total} running now</PageHeroChip>}
          {s.work.current.queued.total > 0 && <PageHeroChip>{s.work.current.queued.total} queued</PageHeroChip>}
        </PageHeroChips>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <SegmentedControl<InsightsWindow> aria-label="Window" value={window} onChange={(w) => onChange({ window: w })} options={WINDOWS.map((w) => ({ value: w.value, label: w.value === 'all' ? 'All' : w.value }))} />
          {repoChoices.length > 1 && (
            <div className="w-full sm:w-64">
              <Select label="Repository" value={repo} onChange={(e) => onChange({ repo: e.target.value })} data-testid="insights-repo">
                <option value="">All repositories</option>
                {repoChoices.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <span className="flex w-full items-center gap-2 text-sm sm:ml-auto sm:w-auto">
            {insights.stateUpdatedAt && (
              <span title={exact(insights.stateUpdatedAt)} aria-live="polite">
                Last recorded {relativeTime(insights.stateUpdatedAt)}
              </span>
            )}
            <Button variant="ghost" onClick={onRefresh} loading={refreshing} aria-label="Refresh">
              Refresh
            </Button>
          </span>
        </div>
      </PageHero>

      {empty ? (
        <Card>
          <CardBody>
            <EmptyState
              title={insights.hasState ? `Nothing recorded in the last ${windowLabel.toLowerCase()}` : 'No jobs have run yet'}
              description={
                insights.hasState
                  ? 'Pick a longer window, or label an issue in a configured repository to start a job.'
                  : 'Every job records what it did. Label an issue in a configured repository and the numbers start here.'
              }
              action={
                <Link className="auth-link" to={insights.hasState ? `${base}/insights?window=all` : `${base}/config`}>
                  {insights.hasState ? 'Show all time' : 'Configure repositories'}
                </Link>
              }
            />
          </CardBody>
        </Card>
      ) : (
        <>
          <Headline s={s} report={report} />
          <Friction s={s} />
          <Trends s={s} report={report} />
          <div className="grid gap-6 lg:grid-cols-2">
            <ReviewLoop s={s} />
            <Rounds s={s} />
          </div>
          {!repo && <Repositories rows={repoRows(report, configured)} onPick={(r) => onChange({ repo: r })} />}
          <CodingModels s={s} />
          <ReviewModels s={s} />
          <Timing s={s} />
          <p className="text-xs text-muted-foreground" data-testid="insights-footnote">
            {report.facts.total} recorded facts in this window{report.facts.backfilled ? `, ${report.facts.backfilled} of them reconstructed from older history` : ''}. Numbers are{' '}
            <code>updraft stats</code> over this installation's shared state, so they read the same as on the command line. Models are the ones configured for each agent, not
            ones the CLI reported.
          </p>
        </>
      )}
    </>
  );
}

function Headline({ s, report }: { s: StatsSection; report: Insights['report'] }) {
  const days = fillDays(s.daily, report.window, 30);
  const spark = (f: (d: (typeof days)[number]) => number) => (days.length > 1 ? days.map(f) : undefined);
  const f = s.work.finished;
  const issues = f.total.implement;
  const done = f.succeeded.implement;
  const failed = f.failed.implement;
  const success = ratio(done, done + failed);
  const caught = s.review.findings.total;
  const changes = s.review.changesRequestedRounds.reviewer;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="insights-headline">
      <StatTile
        label="Issues worked"
        value={issues}
        meta={`${done} succeeded · ${failed} failed${f.canceled.implement ? ` · ${f.canceled.implement} canceled` : ''}`}
        sparkline={spark((d) => d.jobsSucceeded + d.jobsFailed)}
        {...(success !== null && success < 0.5 ? { status: { tone: 'warning' as const, label: `${pct(success)} succeeded` } } : {})}
      />
      <StatTile
        label="Pull requests"
        value={s.outcomes.prsOpened}
        meta={`${s.outcomes.prsMerged} merged by Updraft${s.outcomes.mergeBlocked.prs ? ` · ${s.outcomes.mergeBlocked.prs} blocked` : ''}`}
        sparkline={spark((d) => d.prsOpened)}
      />
      <StatTile
        label="Issues caught in review"
        value={caught}
        meta={
          changes
            ? `in ${changes} change request${changes === 1 ? '' : 's'}${s.review.findings.average !== null ? ` · ${avg(s.review.findings.average)} per request` : ''}`
            : s.review.reviewerRuns.total
              ? 'Every review was ready to merge'
              : 'No reviews yet'
        }
        sparkline={spark((d) => d.findings)}
      />
      <StatTile
        label="Review rounds per PR"
        value={avg(s.backAndForth.revisionsPerPr.average)}
        meta={`first-pass ready ${pct(s.review.firstPass.rate)}${s.backAndForth.limitReached ? ` · ${s.backAndForth.limitReached} hit the limit` : ''}`}
        sparkline={spark((d) => d.revisions)}
      />
    </div>
  );
}

function Trends({ s, report }: { s: StatsSection; report: Insights['report'] }) {
  const days = fillDays(s.daily, report.window, report.window.since ? 90 : 120);
  const labels = days.map((d) => d.day);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Issues worked, by day</CardTitle>
          <CardDescription>Implement, revision and review jobs by the day they finished (UTC).</CardDescription>
        </CardHeader>
        <CardBody>
          <DailyColumns
            title="Jobs finished per day"
            days={labels}
            empty="Nothing finished in this window"
            series={[
              { key: 'ok', label: 'Succeeded', ...SUCCESS, values: days.map((d) => d.jobsSucceeded) },
              { key: 'failed', label: 'Failed', ...FAILURE, values: days.map((d) => d.jobsFailed) },
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What review caught, by day</CardTitle>
          <CardDescription>Findings the reviewer counted in its change requests, by day (UTC). Hover a day for its reviews and verdicts.</CardDescription>
        </CardHeader>
        <CardBody>
          <DailyColumns
            title="Review findings per day"
            days={labels}
            empty="No change requests in this window"
            series={[{ key: 'findings', label: 'Findings', ...CAUGHT, values: days.map((d) => d.findings) }]}
            details={days.map((d) => [
              ['Reviews', d.reviews],
              ['Changes requested', d.changesRequested],
              ['Revisions pushed', d.revisions],
            ])}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function ReviewLoop({ s }: { s: StatsSection }) {
  const r = s.review;
  const rows = [
    { key: 'runs', label: 'Reviewer runs', value: r.reviewerRuns.total },
    { key: 'changes', label: 'Changes requested', value: r.reviewerRuns.changesRequested, hint: 'Verdicts of the reviewer that asked for changes' },
    { key: 'ready', label: 'Ready to merge', value: r.reviewerRuns.readyToMerge },
    { key: 'failed', label: 'No verdict', value: r.reviewerRuns.failed + r.reviewerRuns.other, hint: 'The reviewer failed, gave no readable verdict, or was stopped' },
  ];
  const people = r.changesRequestedRounds.people;
  return (
    <Card data-testid="insights-review">
      <CardHeader>
        <CardTitle>The review loop</CardTitle>
        <CardDescription>Every pull request is reviewed by a different agent than the one that wrote it.</CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <Bars label="Reviewer verdicts" rows={rows} />
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Metric label="Findings" value={r.findings.total} hint={r.findings.withoutCount ? `${r.findings.withoutCount} change request(s) gave no count` : undefined} />
          <Metric label="Per change request" value={avg(r.findings.average)} />
          <Metric label="First-pass ready" value={pct(r.firstPass.rate)} hint={`${r.firstPass.readyToMerge} of ${r.firstPass.prs} pull requests were ready on their first review`} />
          <Metric label="Revisions queued" value={r.changesRequestedRounds.reviewerQueued + r.changesRequestedRounds.peopleQueued} />
          <Metric label="People's change requests" value={people} />
          <Metric label="Reviews per PR" value={avg(s.backAndForth.reviewsPerPr.average)} hint={s.backAndForth.reviewsPerPr.max !== null ? `at most ${s.backAndForth.reviewsPerPr.max}` : undefined} />
        </dl>
      </CardBody>
    </Card>
  );
}

function Rounds({ s }: { s: StatsSection }) {
  const b = s.backAndForth;
  const d = b.revisionsPerPr.distribution;
  const rows = [
    { key: '0', label: 'No revisions', value: d['0'] },
    { key: '1', label: '1 round', value: d['1'] },
    { key: '2', label: '2 rounds', value: d['2'] },
    { key: '3+', label: '3 or more', value: d['3+'] },
  ];
  return (
    <Card data-testid="insights-rounds">
      <CardHeader>
        <CardTitle>Rounds to get it right</CardTitle>
        <CardDescription>
          Revision rounds per pull request, over the {b.prs} opened in this window (their whole history{b.limitReached ? `; ${b.limitReached} reached the revision limit` : ''}).
        </CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {b.prs === 0 ? <p className="text-sm text-muted-foreground">No pull requests were opened in this window.</p> : <Bars label="Pull requests by revision rounds" rows={rows} />}
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <Metric label="Average" value={avg(b.revisionsPerPr.average)} />
          <Metric label="Most" value={b.revisionsPerPr.max ?? '—'} />
          <Metric label="Merged by Updraft" value={s.outcomes.prsMerged} />
        </dl>
      </CardBody>
    </Card>
  );
}

function Repositories({ rows, onPick }: { rows: RepoRow[]; onPick: (repo: string) => void }) {
  if (!rows.length) return null;
  return (
    <Card data-testid="insights-repos">
      <CardHeader>
        <CardTitle>By repository</CardTitle>
        <CardDescription>Issues worked in the window, what is running now, and how each repository's pull requests fared in review. Pick one to see only its numbers.</CardDescription>
      </CardHeader>
      <CardBody>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Repository</th>
                <Th>Issues</Th>
                <Th>Success</Th>
                <Th>Now</Th>
                <Th>PRs</Th>
                <Th>Merged</Th>
                <Th>Caught</Th>
                <Th>Rounds / PR</Th>
                <Th>First-pass</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.repo} data-testid={`repo-${r.repo}`}>
                  <td className="py-2 pr-3">
                    <button type="button" className="auth-link text-left font-medium" onClick={() => onPick(r.repo)}>
                      {r.repo}
                    </button>
                  </td>
                  <Td>{r.issues}</Td>
                  <Td>{pct(r.successRate)}</Td>
                  <Td>{r.active ? <StatusBadge tone="primary">{r.active}</StatusBadge> : '—'}</Td>
                  <Td>{r.prsOpened}</Td>
                  <Td>{r.prsMerged}</Td>
                  <Td>{r.findings}</Td>
                  <Td>{avg(r.avgRounds)}</Td>
                  <Td>{pct(r.firstPass)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

function CodingModels({ s }: { s: StatsSection }) {
  const entries = Object.entries(s.routing.byModel).sort(([, a], [, b]) => b.jobs - a.jobs);
  return (
    <Card data-testid="insights-coding-models">
      <CardHeader>
        <CardTitle>Models at writing code</CardTitle>
        <CardDescription>
          Implement jobs by the model of the run that ended them. Success counts succeeded against failed; the band is the 95% interval, wide while a sample is small. Review-ready is of the pull
          requests each model opened that the reviewer has looked at. Response models are available while job summaries are retained for 30 days. Older runs use the configured model.
        </CardDescription>
      </CardHeader>
      <CardBody>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No implement jobs finished in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Model</th>
                  <Th>Jobs</Th>
                  <Th>Success</Th>
                  <Th>PRs</Th>
                  <Th>Review-ready</Th>
                  <Th>Changes asked</Th>
                  <Th>Rounds / PR</Th>
                  <Th>Verify failed</Th>
                  <Th>To PR (median)</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map(([key, m]) => (
                  <ModelRow key={key} k={key} m={m} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ModelRow({ k, m }: { k: string; m: CodingModelStats }) {
  const n = modelName(k, m);
  return (
    <tr data-testid={`coding-${k}`}>
      <td className="py-2 pr-3">
        <ModelLabel name={n.name} via={n.via} small={m.smallSample} />
      </td>
      <Td>
        {m.jobs}
        {m.escalatedIn.jobs > 0 && <span className="ml-1 text-xs text-muted-foreground" title="Jobs that reached this model after an escalation">+{m.escalatedIn.jobs}↑</span>}
      </Td>
      <Td>
        <RateMeter label="Success" {...m.success} />
      </Td>
      <Td>{m.prsOpened}</Td>
      <Td>
        <RateMeter label="Review-ready" {...m.reviewReady} />
      </Td>
      <Td>{m.changesRequested}</Td>
      <Td>{avg(m.revisions.average)}</Td>
      <Td>{m.verificationFailures}</Td>
      <Td>{duration(m.labelToPr.medianMs)}</Td>
    </tr>
  );
}

function ReviewModels({ s }: { s: StatsSection }) {
  const entries = Object.entries(s.review.byModel ?? {}).sort(([, a], [, b]) => b.runs - a.runs);
  const maxFindings = Math.max(1, ...entries.map(([, m]) => m.findings.total));
  return (
    <Card data-testid="insights-review-models">
      <CardHeader>
        <CardTitle>Models at reviewing</CardTitle>
        <CardDescription>Reviewer runs by model: how often each sent work back, and how much it caught when it did.</CardDescription>
      </CardHeader>
      <CardBody>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reviews ran in this window.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <Legend
              series={[
                { key: 'ready', label: 'Ready to merge', swatch: PRIMARY.swatch },
                { key: 'changes', label: 'Changes requested', swatch: CAUGHT.swatch },
                { key: 'failed', label: 'No verdict', swatch: FAILURE.swatch },
              ]}
            />
            <ul className="flex flex-col divide-y divide-border">
              {entries.map(([key, m]) => (
                <ReviewModelRow key={key} k={key} m={m} maxFindings={maxFindings} />
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ReviewModelRow({ k, m, maxFindings }: { k: string; m: ReviewModelStats; maxFindings: number }) {
  const n = modelName(k, m);
  const total = Math.max(1, m.runs);
  const parts = [
    { key: 'ready', v: m.readyToMerge, c: PRIMARY.swatch, label: 'ready to merge' },
    { key: 'changes', v: m.changesRequested, c: CAUGHT.swatch, label: 'changes requested' },
    { key: 'failed', v: m.failed, c: FAILURE.swatch, label: 'no verdict' },
  ];
  return (
    <li className="grid gap-3 py-3 sm:grid-cols-[minmax(10rem,14rem)_1fr_auto] sm:items-center" data-testid={`review-${k}`}>
      <ModelLabel name={n.name} via={n.via} small={m.runs < 20} />
      <div className="flex flex-col gap-1">
        <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.map((p) => `${p.v} ${p.label}`).join(', ')}>
          {parts.map((p) => (p.v ? <span key={p.key} className={`h-full ${p.c}`} style={{ width: `${(p.v / total) * 100}%` }} /> : null))}
        </div>
        <span className="text-xs text-muted-foreground">
          {m.runs} review{m.runs === 1 ? '' : 's'} · sent back {pct(ratio(m.changesRequested, m.runs))}
        </span>
      </div>
      <div className="flex items-center gap-3 text-sm sm:justify-end">
        <span className="h-2 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span className={`block h-full rounded-full ${CAUGHT.swatch}`} style={{ width: `${(m.findings.total / maxFindings) * 100}%` }} />
        </span>
        <span className="tabular-nums">
          <strong>{m.findings.total}</strong> caught
          {m.findings.average !== null && <span className="text-muted-foreground"> · {avg(m.findings.average)}/request</span>}
        </span>
      </div>
    </li>
  );
}

function Timing({ s }: { s: StatsSection }) {
  const t = s.time;
  const rows: Array<[string, { medianMs: number | null; p90Ms: number | null; count: number }]> = [
    ['Writing code', t.agentRun.byKind.implement],
    ['Revising', t.agentRun.byKind.revision],
    ['Reviewing', t.agentRun.byKind.review],
    ['Waiting to start', t.queueWait.all],
    ['Label to pull request', t.labelToPr],
    ['Pull request to merge', t.prToMerge],
  ];
  return (
    <Card data-testid="insights-timing">
      <CardHeader>
        <CardTitle>How long things take</CardTitle>
        <CardDescription>Median, with the 90th percentile: the slow end most people notice.</CardDescription>
      </CardHeader>
      <CardBody>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Step</th>
              <Th>Median</Th>
              <Th>p90</Th>
              <Th>Of</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(([label, d]) => (
              <tr key={label}>
                <td className="py-2 pr-3">{label}</td>
                <Td>{duration(d.medianMs)}</Td>
                <Td>{duration(d.p90Ms)}</Td>
                <Td>{d.count}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}

function Friction({ s }: { s: StatsSection }) {
  const reasons = s.outcomes.mergeBlocked.reasons;
  const p = s.pressure;
  return (
    <Card data-testid="insights-friction">
      <CardHeader>
        <CardTitle>Where it gets stuck</CardTitle>
        <CardDescription>Why pull requests were not merged automatically, and what slowed agents down.</CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {reasons.length ? (
          <Bars label="Merge blocked, by reason" fill={CAUGHT.swatch} rows={reasons.map((r) => ({ key: r.code, label: MERGE_BLOCK[r.code] ?? r.code, value: r.count }))} />
        ) : (
          <p className="text-sm text-muted-foreground">No pull request was held back from auto-merge.</p>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Metric label="Verify failures" value={s.outcomes.failedRuns.verifyFailed} />
          <Metric label="Usage-limit cooldowns" value={p.cooldowns.count} hint={p.cooldowns.totalMs ? `${duration(p.cooldowns.totalMs)} in all` : undefined} />
          <Metric label="Deferred jobs" value={p.deferrals.count} />
          <Metric label="Agent would not start" value={p.unavailable.startFailedRuns} />
        </dl>
      </CardBody>
    </Card>
  );
}

function ModelLabel({ name, via, small }: { name: string; via: string; small: boolean }) {
  return (
    <span className="flex flex-col">
      <span className="flex items-center gap-2 font-medium">
        {name}
        {small && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground" title="Fewer than 20 jobs: too few to compare">
            small sample
          </span>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{via}</span>
    </span>
  );
}

function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

const Th = ({ children }: { children: ReactNode }) => <th className="px-2 py-2 text-right font-medium">{children}</th>;
const Td = ({ children }: { children: ReactNode }) => <td className="px-2 py-2 text-right tabular-nums">{children}</td>;
