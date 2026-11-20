import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, StatTile, StatusBadge } from '@readysetcloud/ui';
import { ApiError, api as defaultApi, type AdminOverview, type ApiClient } from '../api/client';
import { tenantStatusLabel } from './DashboardPage';

type Load = { state: 'loading' } | { state: 'ok'; overview: AdminOverview } | { state: 'forbidden' } | { state: 'error'; message: string };

/** MicroVM seconds as whole minutes, rounded up: what a quota in minutes is checked against. */
export const minutes = (seconds: number) => Math.ceil(seconds / 60);

/** Load an admin page's data: the server decides who is an admin, so a 403 is its own state. */
export function adminLoadError(err: unknown): { state: 'forbidden' } | { state: 'error'; message: string } {
  if (err instanceof ApiError && err.status === 403) return { state: 'forbidden' };
  return { state: 'error', message: err instanceof Error ? err.message : 'Could not load the admin view.' };
}

export function Forbidden() {
  return (
    <Alert variant="error" data-testid="admin-forbidden">
      The admin view is for Updraft admins. Your account is not on the allow-list.
    </Alert>
  );
}

/** The admin view (#68): every tenant, with its quotas, usage and failures this month. */
export function AdminPage({ api = defaultApi }: { api?: Pick<ApiClient, 'adminTenants'> }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    api.adminTenants().then(
      (overview) => live && setLoad({ state: 'ok', overview }),
      (err: unknown) => live && setLoad(adminLoadError(err)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-muted-foreground">Every tenant, with its quotas and what it used this month (UTC).</p>
      </header>

      {load.state === 'loading' && <Skeleton className="h-24" />}
      {load.state === 'forbidden' && <Forbidden />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="admin-error">
          {load.message}
        </Alert>
      )}

      {load.state === 'ok' && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Tenants" value={load.overview.tenants.length} />
            <StatTile
              label="Jobs holding capacity"
              value={`${load.overview.platform.activeJobs} / ${load.overview.platform.platformConcurrentJobs}`}
              meta="Across every tenant, against the platform's ceiling"
              data-testid="platform-capacity"
            />
            <StatTile label="Failed jobs this month" value={load.overview.tenants.reduce((n, t) => n + t.usage.failedThisMonth, 0)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Tenants</CardTitle>
              <CardDescription>Open one to see its jobs, change its quotas, or disable it.</CardDescription>
            </CardHeader>
            <CardBody>
              {load.overview.tenants.length === 0 ? (
                <EmptyState title="No tenants yet" description="A tenant appears here once someone connects an installation of the App." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm" data-testid="admin-tenants">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-4 font-medium">Account</th>
                        <th className="py-2 pr-4 font-medium">Status</th>
                        <th className="py-2 pr-4 font-medium">Jobs today</th>
                        <th className="py-2 pr-4 font-medium">MicroVM minutes</th>
                        <th className="py-2 pr-4 font-medium">Failed</th>
                        <th className="py-2 font-medium">Throttled</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {load.overview.tenants.map((t) => {
                        const s = tenantStatusLabel(t);
                        return (
                          <tr key={t.installationId}>
                            <td className="py-2 pr-4">
                              <Link className="auth-link" to={`/admin/tenants/${t.installationId}`}>
                                {t.accountLogin}
                              </Link>
                              <span className="ml-2 text-muted-foreground">#{t.installationId}</span>
                            </td>
                            <td className="py-2 pr-4">
                              <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                            </td>
                            <td className="py-2 pr-4">
                              {t.usage.jobsToday} / {t.quotas.jobsPerDay}
                            </td>
                            <td className="py-2 pr-4">
                              {minutes(t.usage.microvmSecondsThisMonth)} / {t.quotas.microvmMinutesPerMonth}
                            </td>
                            <td className="py-2 pr-4">{t.usage.failedThisMonth}</td>
                            <td className="py-2">{t.usage.throttledThisMonth}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
