import { Link, Navigate } from 'react-router';
import { Alert, Card, CardBody, EmptyState, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { useInstallations } from '../layout/AppLayout';
import { tenantStatusLabel } from './GitHubSettingsPage';

export function InstallationsPage({ home = false }: { home?: boolean }) {
  const { installations, preferredId } = useInstallations();
  if (installations.state === 'loading') return <Skeleton className="h-24" aria-label="Loading installations" />;
  if (installations.state !== 'ready') return <Alert variant="error">Could not load installations. Reload the page to try again.</Alert>;

  const { tenants } = installations.github;
  if (home) {
    const selected = tenants.find((tenant) => String(tenant.installationId) === preferredId)
      ?? (tenants.length === 1 ? tenants[0] : undefined);
    if (selected) return <Navigate to={`/installations/${selected.installationId}`} replace />;
    if (tenants.length === 0) return <Navigate to="/settings/github" replace />;
    return <Navigate to="/installations" replace />;
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Installations</h1>
        {tenants.length > 0 && <p className="text-muted-foreground">Choose a GitHub account to view its Updraft activity.</p>}
      </header>
      {tenants.length === 0 ? (
        <EmptyState
          title="No installations yet"
          description="Connect Updraft to a GitHub account or organization to get started."
          action={<Link className="auth-link" to="/settings/github">GitHub settings</Link>}
        />
      ) : (
        <Card>
          <CardBody>
            <ul className="divide-y divide-border">
              {tenants.map((tenant) => {
                const status = tenantStatusLabel(tenant);
                return (
                  <li key={tenant.installationId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <Link className="auth-link font-medium" to={`/installations/${tenant.installationId}`}>{tenant.accountLogin}</Link>
                    <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      {tenant.accountType === 'Organization' ? 'Organization' : 'Personal account'}
                      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
