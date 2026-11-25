import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Skeleton, StatusBadge } from '@readysetcloud/ui';
import type { ApiClient, ReadinessCheck, ReadinessReport, RepositoryReadiness, RepositoryReadinessStatus, TenantSummary } from '../api/client';
import { installationSettingsUrl, type Tone } from '../lib/diagnostics';
import { relativeTime } from '../lib/time';

/**
 * Repository readiness (#137): per configured repository, whether its published workflow has what
 * it needs, check by check, as of a time. Ready only ever means every prerequisite that can be
 * read was read and is in place; what only a run can show is listed as not verified.
 */

export const READINESS: Record<Exclude<RepositoryReadinessStatus, 'not_configured'>, { label: string; tone: Tone; help: string }> = {
  ready: { label: 'Ready', tone: 'success', help: 'Every prerequisite that can be checked without running a job is in place.' },
  action_needed: { label: 'Action needed', tone: 'error', help: 'Something a person must fix stops jobs here.' },
  temporarily_unavailable: { label: 'Temporarily unavailable', tone: 'warning', help: 'A limit or a short gap stops jobs right now; it clears by itself.' },
  paused: { label: 'Paused', tone: 'warning', help: 'Jobs here are paused on purpose.' },
  unknown: { label: 'Unknown', tone: 'neutral', help: 'Something could not be checked just now, so readiness is not known.' },
};

const STATE: Record<ReadinessCheck['state'], { label: string; tone: Tone }> = {
  verified: { label: 'Verified', tone: 'success' },
  failing: { label: 'Failing', tone: 'error' },
  unverified: { label: 'Not verified', tone: 'neutral' },
  off: { label: 'Off', tone: 'neutral' },
};

const STAGE: Record<ReadinessCheck['stage'], string> = {
  installation: 'Installation', config: 'Configuration', github: 'GitHub', credentials: 'Agent keys', subscription: 'Claude subscription',
  review: 'Review', ci: 'CI repair', capacity: 'Capacity', pauses: 'Pauses', telemetry: 'Telemetry', egress: 'Network', execution: 'Last run',
};

function stateOf(c: ReadinessCheck): { label: string; tone: Tone } {
  if (c.state === 'failing' && (c.problem === 'transient' || c.problem === 'paused' || c.problem === 'provider')) return { label: c.problem === 'paused' ? 'Paused' : 'Waiting', tone: 'warning' };
  if (c.state === 'failing' && !c.required) return { label: 'Optional', tone: 'warning' };
  if (c.state === 'unverified' && c.unverified === 'needs_run') return { label: 'Needs a run', tone: 'neutral' };
  return STATE[c.state];
}

function FixLink({ check, base, tenant, lastJob }: { check: ReadinessCheck; base: string; tenant: TenantSummary; lastJob?: RepositoryReadiness['lastJob'] }) {
  const fix = check.fix;
  if (!fix) return null;
  if (fix.target === 'github') {
    return (
      <a className="auth-link text-sm" href={installationSettingsUrl(tenant)} target="_blank" rel="noreferrer">
        {fix.text} ↗
      </a>
    );
  }
  const to = fix.target === 'job' ? (lastJob ? `${base}/jobs/${lastJob.jobId}` : null) : fix.target === 'workflows' ? `${base}?tab=workflows` : `${base}/${fix.target}`;
  return to ? <Link className="auth-link text-sm" to={to}>{fix.text}</Link> : null;
}

function CheckList({ checks, base, tenant, lastJob, label }: { checks: ReadinessCheck[]; base: string; tenant: TenantSummary; lastJob?: RepositoryReadiness['lastJob']; label: string }) {
  return (
    <ul className="flex flex-col divide-y divide-border" aria-label={label}>
      {checks.map((c) => {
        const s = stateOf(c);
        return (
          <li key={c.id} className="flex min-w-0 flex-col gap-1 py-2" data-testid={`check-${c.id}`}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
              <span className="text-sm font-medium">{STAGE[c.stage]}</span>
              {!c.required && <span className="text-sm text-muted-foreground">optional</span>}
            </div>
            <p className="min-w-0 break-words text-sm">{c.summary}</p>
            <FixLink check={c} base={base} tenant={tenant} {...(lastJob ? { lastJob } : {})} />
          </li>
        );
      })}
    </ul>
  );
}

/** Required checks first, then the optional ones; what is wrong before what is fine. */
const ORDER: Record<ReadinessCheck['state'], number> = { failing: 0, unverified: 1, verified: 2, off: 3 };
const sorted = (checks: ReadinessCheck[]) => [...checks].sort((a, b) => Number(b.required) - Number(a.required) || ORDER[a.state] - ORDER[b.state]);

type ReadinessApi = Pick<ApiClient, 'readiness'>;

export function ReadinessPanel({ api, tenant, base }: { api: ReadinessApi; tenant: TenantSummary; base: string }) {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const live = useRef(true);
  const settle = useCallback((pending: Promise<ReadinessReport>) => pending.then(
    (r) => {
      if (!live.current) return;
      setReport(r);
      setError(null);
      setChecking(false);
    },
    // A failed check is said as such: never an empty, healthy-looking list.
    (err: unknown) => {
      if (!live.current) return;
      setError(err instanceof Error ? err.message : 'Readiness could not be checked.');
      setChecking(false);
    },
  ), []);
  useEffect(() => {
    live.current = true;
    // Keys, the Claude session and pauses change on other pages: opening this one checks again
    // (the server serves its last check when that is only seconds old).
    void settle(api.readiness(tenant.installationId, true));
    return () => {
      live.current = false;
    };
  }, [api, tenant.installationId, settle]);
  const load = (refresh: boolean) => settle(api.readiness(tenant.installationId, refresh));

  const configured = report?.repositories.filter((r) => r.status !== 'not_configured') ?? [];
  const unconfigured = report?.repositories.filter((r) => r.status === 'not_configured') ?? [];
  const installationProblems = report?.installation.filter((c) => c.required && c.state !== 'verified') ?? [];
  let header: ReactNode = null;
  if (report) {
    header = (
      <span className="text-sm text-muted-foreground" aria-live="polite" title={new Date(report.checkedAt).toLocaleString()} data-testid="readiness-checked">
        Checked {relativeTime(report.checkedAt)}
        {report.cached ? ' (saved result)' : ''}
        {report.configVersion !== null ? ` · configuration v${report.configVersion}` : ''}
      </span>
    );
  }

  return (
    <Card data-testid="readiness">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Readiness</CardTitle>
        <span className="flex flex-wrap items-center gap-3">
          {header}
          <Button variant="ghost" onClick={() => {
            setChecking(true);
            void load(true);
          }} loading={checking} aria-label="Check readiness again">
            Check again
          </Button>
        </span>
      </CardHeader>
      <CardBody>
        {!report && !error && <Skeleton className="h-24" />}
        {error && (
          <Alert variant="error" data-testid="readiness-error">
            Readiness could not be checked: {error}
            {report ? ` The result below is from ${relativeTime(report.checkedAt)} and may be out of date.` : ''}
          </Alert>
        )}
        {report && (
          <div className={`flex min-w-0 flex-col gap-4${error ? ' opacity-60' : ''}`} {...(error ? { 'data-stale': 'true', 'aria-label': 'Outdated readiness result' } : {})} data-testid="readiness-report">
            {configured.length === 0 && (
              <p className="text-sm">
                No repository is configured yet.{' '}
                <Link className="auth-link" to={`${base}/config`}>
                  Configure repositories
                </Link>
              </p>
            )}
            {installationProblems.length > 0 && (
              <div data-testid="readiness-installation">
                <p className="text-sm font-medium">For every repository</p>
                <CheckList checks={sorted(installationProblems)} base={base} tenant={tenant} label="Installation checks" />
              </div>
            )}
            <ul className="flex flex-col gap-2" aria-label="Repository readiness">
              {configured.map((r) => {
                const s = READINESS[r.status as Exclude<RepositoryReadinessStatus, 'not_configured'>];
                const checks = sorted([...report.installation, ...r.checks]);
                const failing = checks.filter((c) => c.required && c.state === 'failing').length;
                return (
                  <li key={r.repository} data-testid={`readiness-${r.repository}`}>
                    <details className="rounded-md border border-border p-3" open={r.status === 'action_needed' || undefined}>
                      <summary className="flex min-w-0 cursor-pointer flex-wrap items-center gap-2">
                        <span className="min-w-0 break-words font-medium">{r.repository}</span>
                        <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                        <span className="text-sm text-muted-foreground">{failing ? `${failing} to resolve` : s.help}</span>
                      </summary>
                      <div className="mt-2">
                        <CheckList checks={checks} base={base} tenant={tenant} label={`Checks for ${r.repository}`} {...(r.lastJob ? { lastJob: r.lastJob } : {})} />
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
            {unconfigured.length > 0 && (
              <p className="text-sm">
                {unconfigured.length === 1 ? `${unconfigured[0]!.repository} is` : `${unconfigured.length} repositories are`} reachable but not configured, so labels there start nothing.{' '}
                <Link className="auth-link" to={`${base}/config`}>
                  Configure
                </Link>
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-sm">What readiness does not check</summary>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm" data-testid="readiness-limitations">
                {report.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
