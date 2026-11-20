import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type Repository, type TenantSummary } from '../api/client';
import { tenantStatusLabel } from './DashboardPage';

type Load = { state: 'loading' } | { state: 'ok'; tenant: TenantSummary; repositories: Repository[] } | { state: 'error'; message: string };

/** One installation of the App: the repositories it can access, as GitHub reports them now. */
export function InstallationPage({ api = defaultApi }: { api?: Pick<ApiClient, 'repositories'> }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };

  useEffect(() => {
    let live = true;
    if (!valid) return;
    api.repositories(installationId).then(
      (out) => live && setLoad({ state: 'ok', ...out }),
      (err: unknown) => live && setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Could not load the installation.' }),
    );
    return () => {
      live = false;
    };
  }, [api, installationId, valid]);

  return (
    <div className="flex flex-col gap-6">
      <Link className="auth-link" to="/">
        ← Dashboard
      </Link>
      {load.state === 'loading' && <Skeleton className="h-24" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="installation-error">
          {load.message}
        </Alert>
      )}
      {load.state === 'ok' && (
        <Card data-testid="installation">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                {load.tenant.accountLogin}
                <StatusBadge tone={tenantStatusLabel(load.tenant).tone}>{tenantStatusLabel(load.tenant).label}</StatusBadge>
              </span>
              {load.tenant.status === 'active' && (
                <Link className="auth-link text-base font-normal" to={`/installations/${load.tenant.installationId}/config`} data-testid="configure-link">
                  Configure
                </Link>
              )}
            </CardTitle>
            <CardDescription>
              The repositories the Updraft App can access. Change which ones on GitHub, in the App&apos;s installation settings.
              Choose which of them Updraft works on, and how, under Configure.
            </CardDescription>
          </CardHeader>
          <CardBody>
            {load.tenant.status !== 'active' ? (
              load.tenant.disabledReason === 'admin' ? (
                <EmptyState
                  title="Updraft has disabled this account"
                  description="No jobs start here until Updraft enables it again."
                />
              ) : (
                <EmptyState
                  title={load.tenant.disabledReason === 'uninstalled' ? 'The App was uninstalled' : 'The installation is suspended'}
                  description="Updraft does nothing here until the App is installed and active again."
                />
              )
            ) : load.repositories.length === 0 ? (
              <EmptyState title="No repositories" description="The installation cannot access any repositories yet." />
            ) : (
              <ul className="flex flex-col divide-y divide-border" data-testid="repository-list">
                {load.repositories.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                    <a className="auth-link" href={r.htmlUrl} target="_blank" rel="noreferrer">
                      {r.fullName}
                    </a>
                    {r.private && <StatusBadge tone="neutral">Private</StatusBadge>}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
