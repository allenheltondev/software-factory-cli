import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Modal,
  Skeleton,
  StatTile,
  StatusBadge,
  TextArea,
} from '@readysetcloud/ui';
import { api as defaultApi, type AdminActiveJob, type AdminTenantDetail, type ApiClient, type TenantLimits } from '../api/client';
import { adminLoadError, Forbidden, minutes } from './AdminPage';
import { tenantStatusLabel } from './GitHubSettingsPage';

type AdminTenantApi = Pick<ApiClient, 'adminTenant' | 'adminDisable' | 'adminEnable' | 'adminSetLimits' | 'adminReleaseJob'>;
type Load = { state: 'loading' } | { state: 'ok'; tenant: AdminTenantDetail } | { state: 'forbidden' } | { state: 'error'; message: string };
type Busy = 'disable' | 'enable' | 'limits' | 'release' | null;

const LIMIT_FIELDS: { name: keyof TenantLimits; label: string; unit: string }[] = [
  { name: 'concurrentJobs', label: 'Concurrent jobs', unit: 'at once' },
  { name: 'jobsPerDay', label: 'Jobs per day', unit: 'per UTC day' },
  { name: 'microvmMinutesPerMonth', label: 'MicroVM minutes per month', unit: 'per UTC month' },
];

const when = (iso: string) => new Date(iso).toLocaleString();
const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong; try again.');

/** The limits form's values: an override as text, or empty for the stack's default. */
function limitInputs(t: AdminTenantDetail): Record<keyof TenantLimits, string> {
  return {
    concurrentJobs: t.limits?.concurrentJobs?.toString() ?? '',
    jobsPerDay: t.limits?.jobsPerDay?.toString() ?? '',
    microvmMinutesPerMonth: t.limits?.microvmMinutesPerMonth?.toString() ?? '',
  };
}

/** One tenant in the admin view: its usage and jobs, and disabling it, its quotas, releasing a job. */
export function AdminTenantPage({ api = defaultApi }: { api?: AdminTenantApi }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no tenant at this address.' };
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [reason, setReason] = useState('');
  const [releasing, setReleasing] = useState<AdminActiveJob | null>(null);
  const [inputs, setInputs] = useState<Record<keyof TenantLimits, string>>({ concurrentJobs: '', jobsPerDay: '', microvmMinutesPerMonth: '' });

  const show = (tenant: AdminTenantDetail) => {
    setLoad({ state: 'ok', tenant });
    setInputs(limitInputs(tenant));
  };

  useEffect(() => {
    let live = true;
    if (!valid) return;
    api.adminTenant(installationId).then(
      (tenant) => {
        if (!live) return;
        setLoad({ state: 'ok', tenant });
        setInputs(limitInputs(tenant));
      },
      (err: unknown) => live && setLoad(adminLoadError(err)),
    );
    return () => {
      live = false;
    };
  }, [api, installationId, valid]);

  async function act(kind: Exclude<Busy, null>, run: () => Promise<AdminTenantDetail>) {
    setBusy(kind);
    setActionError(null);
    try {
      show(await run());
      return true;
    } catch (err) {
      setActionError(message(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saveLimits(e: FormEvent) {
    e.preventDefault();
    const limits: TenantLimits = {};
    for (const { name } of LIMIT_FIELDS) if (inputs[name].trim() !== '') limits[name] = Number(inputs[name]);
    await act('limits', () => api.adminSetLimits(installationId, Object.keys(limits).length > 0 ? limits : null));
  }

  return (
    <div className="flex flex-col gap-6">
      <Link className="auth-link" to="/admin">
        ← Admin
      </Link>
      {load.state === 'loading' && <Skeleton className="h-24" />}
      {load.state === 'forbidden' && <Forbidden />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="admin-tenant-error">
          {load.message}
        </Alert>
      )}
      {actionError && (
        <Alert variant="error" data-testid="admin-action-error">
          {actionError}
        </Alert>
      )}

      {load.state === 'ok' && (
        <>
          <header className="flex flex-wrap items-center justify-between gap-3" data-testid="admin-tenant">
            <div className="flex flex-col gap-1">
              <h1 className="flex items-center gap-2 text-2xl font-semibold">
                {load.tenant.accountLogin}
                <StatusBadge tone={tenantStatusLabel(load.tenant).tone}>{tenantStatusLabel(load.tenant).label}</StatusBadge>
              </h1>
              <p className="text-muted-foreground">
                Installation {load.tenant.installationId} · {load.tenant.accountType === 'Organization' ? 'Organization' : 'Personal account'} ·
                {load.tenant.activeConfigVersion !== undefined ? ` config version ${load.tenant.activeConfigVersion}` : ' no config published'}
              </p>
              {load.tenant.adminDisabled && (
                <p className="text-sm text-muted-foreground" data-testid="admin-disabled">
                  Disabled by {load.tenant.adminDisabled.by} on {when(load.tenant.adminDisabled.at)}
                  {load.tenant.adminDisabled.reason ? `: ${load.tenant.adminDisabled.reason}` : ''}
                </p>
              )}
            </div>
            {load.tenant.disabledReason !== 'uninstalled' &&
              (load.tenant.adminDisabled ? (
                <Button loading={busy === 'enable'} disabled={busy !== null} onClick={() => void act('enable', () => api.adminEnable(installationId))}>
                  Enable
                </Button>
              ) : (
                <Button variant="error" disabled={busy !== null} onClick={() => setDisabling(true)}>
                  Disable
                </Button>
              ))}
          </header>

          <div className="grid gap-4 sm:grid-cols-4">
            <StatTile label="Jobs today" value={`${load.tenant.usage.jobsToday} / ${load.tenant.quotas.jobsPerDay}`} />
            <StatTile
              label="MicroVM minutes this month"
              value={`${minutes(load.tenant.usage.microvmSecondsThisMonth)} / ${load.tenant.quotas.microvmMinutesPerMonth}`}
            />
            <StatTile label="Failed this month" value={load.tenant.usage.failedThisMonth} />
            <StatTile label="Throttled this month" value={load.tenant.usage.throttledThisMonth} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Quotas</CardTitle>
              <CardDescription>Leave a field empty for the stack&apos;s default. Changes apply to the next delivery.</CardDescription>
            </CardHeader>
            <CardBody>
              <form className="flex flex-col gap-4" onSubmit={(e) => void saveLimits(e)} data-testid="limits-form">
                <div className="grid gap-4 sm:grid-cols-3">
                  {LIMIT_FIELDS.map((f) => (
                    <Input
                      key={f.name}
                      label={f.label}
                      type="number"
                      min={1}
                      inputMode="numeric"
                      placeholder={String(load.tenant.defaults[f.name])}
                      hint={`Default ${load.tenant.defaults[f.name]} ${f.unit}`}
                      value={inputs[f.name]}
                      onChange={(e) => setInputs((prev) => ({ ...prev, [f.name]: e.target.value }))}
                    />
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button type="submit" loading={busy === 'limits'} disabled={busy !== null}>
                    Save quotas
                  </Button>
                  {load.tenant.limits && (
                    <Button variant="ghost" type="button" disabled={busy !== null} onClick={() => void act('limits', () => api.adminSetLimits(installationId, null))}>
                      Use the defaults
                    </Button>
                  )}
                </div>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Jobs holding capacity</CardTitle>
              <CardDescription>
                Launched or reserved jobs whose quota slots are taken until Lambda shows their microVM terminated.
              </CardDescription>
            </CardHeader>
            <CardBody>
              {load.tenant.activeJobs.length === 0 ? (
                <EmptyState title="None" description="No job of this tenant holds capacity right now." />
              ) : (
                <ul className="flex flex-col divide-y divide-border" data-testid="active-jobs">
                  {load.tenant.activeJobs.map((j) => (
                    <li key={j.jobId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <span className="flex flex-col gap-1 text-sm">
                        <span className="font-mono">{j.jobId}</span>
                        <span className="text-muted-foreground">
                          {j.repository ?? 'no job record'}
                          {j.issue !== undefined ? ` #${j.issue}` : ''} · {j.phase === 'reserved' ? 'reserved, not launched' : j.microvmId ? `microVM ${j.microvmId}` : 'launched, no microVM recorded'}
                          {j.outcome ? ` · ${j.outcome}` : ''} · held until {when(j.expiresAt)}
                        </span>
                      </span>
                      <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setReleasing(j)}>
                        Release
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent jobs</CardTitle>
              <CardDescription>The last 30 days, newest first.</CardDescription>
            </CardHeader>
            <CardBody>
              {load.tenant.recentJobs.length === 0 ? (
                <EmptyState title="No jobs yet" description="Jobs appear here once a labeled issue starts one." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm" data-testid="recent-jobs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-4 font-medium">Started</th>
                        <th className="py-2 pr-4 font-medium">Repository</th>
                        <th className="py-2 pr-4 font-medium">Label, by</th>
                        <th className="py-2 font-medium">Outcome</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {load.tenant.recentJobs.map((j) => (
                        <tr key={j.jobId}>
                          <td className="py-2 pr-4">{when(j.createdAt)}</td>
                          <td className="py-2 pr-4">
                            {j.repository}
                            {j.issue !== undefined ? ` #${j.issue}` : ''}
                          </td>
                          <td className="py-2 pr-4">
                            {j.label ?? ''}
                            {j.sender ? `, @${j.sender}` : ''}
                          </td>
                          <td className="py-2">
                            {j.status === 'finished' ? (
                              <StatusBadge tone={j.outcome === 'succeeded' ? 'success' : j.outcome === 'unconfirmed' ? 'warning' : 'error'}>{j.outcome}</StatusBadge>
                            ) : (
                              <StatusBadge tone="primary">running</StatusBadge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          <Modal open={disabling} onClose={() => setDisabling(false)} aria-label={`Disable ${load.tenant.accountLogin}`}>
            <form
              className="flex flex-col gap-4 p-6"
              onSubmit={(e) => {
                e.preventDefault();
                void act('disable', () => api.adminDisable(installationId, reason.trim() || undefined)).then((ok) => {
                  if (ok) {
                    setDisabling(false);
                    setReason('');
                  }
                });
              }}
            >
              <h2 className="text-lg font-semibold">Disable {load.tenant.accountLogin}?</h2>
              <p className="text-sm text-muted-foreground">
                No new job starts, and running jobs are served nothing more, so they end within the hour. GitHub suspending or
                unsuspending the App does not undo this; only enabling it here does.
              </p>
              <TextArea label="Reason (shown to admins)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" type="button" onClick={() => setDisabling(false)}>
                  Cancel
                </Button>
                <Button variant="error" type="submit" loading={busy === 'disable'}>
                  Disable
                </Button>
              </div>
            </form>
          </Modal>

          <Modal open={releasing !== null} onClose={() => setReleasing(null)} aria-label="Release the job">
            <div className="flex flex-col gap-4 p-6">
              <h2 className="text-lg font-semibold">Release {releasing?.jobId}?</h2>
              <p className="text-sm text-muted-foreground">
                The job is retired and its quota slots and unused microVM time given back. Only release a job whose microVM you have
                checked is not running: one that is would keep running outside the quota.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" type="button" onClick={() => setReleasing(null)}>
                  Cancel
                </Button>
                <Button
                  variant="error"
                  loading={busy === 'release'}
                  onClick={() => {
                    const job = releasing;
                    if (!job) return;
                    void act('release', () => api.adminReleaseJob(job.jobId)).then((ok) => ok && setReleasing(null));
                  }}
                >
                  Release
                </Button>
              </div>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}
