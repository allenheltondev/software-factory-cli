import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  StatusBadge,
} from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type GitHubStatus, type Me, type TenantSummary } from '../api/client';

type DashboardApi = Pick<ApiClient, 'me' | 'githubStatus' | 'startLink' | 'unlink' | 'startInstall'>;

type Load = { state: 'loading' } | { state: 'ok'; me: Me; github: GitHubStatus } | { state: 'error' };

/** Sends the browser to github.com. A prop so tests can watch instead. */
export type Go = (url: string) => void;
const leave: Go = (url) => window.location.assign(url);

export function tenantStatusLabel(t: Pick<TenantSummary, 'status' | 'disabledReason'>): { tone: 'success' | 'warning' | 'error'; label: string } {
  if (t.status === 'active') return { tone: 'success', label: 'Active' };
  if (t.disabledReason === 'uninstalled') return { tone: 'error', label: 'Uninstalled' };
  return { tone: 'warning', label: 'Suspended' };
}

/**
 * The first page after sign-in: who you are, your linked GitHub identity, and the installations
 * of the Updraft App you manage. Linking and installing leave for github.com and come back to
 * /github/callback.
 */
export function DashboardPage({ api = defaultApi, go = leave }: { api?: DashboardApi; go?: Go }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState<'link' | 'install' | 'unlink' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let live = true;
    Promise.all([api.me(), api.githubStatus()]).then(
      ([me, github]) => live && setLoad({ state: 'ok', me, github }),
      () => live && setLoad({ state: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => refresh(), [refresh]);

  async function start(kind: 'link' | 'install') {
    setBusy(kind);
    setActionError(null);
    try {
      const { url } = kind === 'link' ? await api.startLink() : await api.startInstall();
      go(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Something went wrong; try again.');
      setBusy(null);
    }
  }

  async function unlink() {
    setBusy('unlink');
    setActionError(null);
    try {
      await api.unlink();
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Something went wrong; try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">
          {load.state === 'ok' && load.me.name ? `Welcome, ${load.me.name}` : 'Welcome to Updraft'}
        </h1>
        <p className="text-muted-foreground">
          Label a GitHub issue and Updraft hands it to a coding agent that opens a draft pull request.
        </p>
      </header>

      {load.state === 'loading' && <Skeleton className="h-24" data-testid="dashboard-loading" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="dashboard-error">
          Updraft could not load your account. Reload the page to try again.
        </Alert>
      )}
      {actionError && (
        <Alert variant="error" data-testid="dashboard-action-error">
          {actionError}
        </Alert>
      )}

      {load.state === 'ok' && !load.github.configured && (
        <Alert variant="info" data-testid="github-not-configured">
          The Updraft GitHub App is not set up for this deployment yet, so GitHub cannot be connected.
        </Alert>
      )}

      {load.state === 'ok' && load.github.configured && (
        <Card data-testid="dashboard-ready">
          <CardHeader>
            <CardTitle>GitHub</CardTitle>
            <CardDescription>
              Signed in as {load.me.email ?? load.me.sub}.{' '}
              {load.github.linked ? (
                <>
                  Linked to GitHub as <strong>@{load.github.linked.githubLogin}</strong>.
                </>
              ) : (
                'Link your GitHub account, then install the Updraft App on the repositories it should work on.'
              )}
            </CardDescription>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {load.github.linked ? (
                <>
                  <Button loading={busy === 'install'} disabled={busy !== null} onClick={() => void start('install')}>
                    Install the App on GitHub
                  </Button>
                  <Button variant="secondary" loading={busy === 'link'} disabled={busy !== null} onClick={() => void start('link')}>
                    Connect an existing installation
                  </Button>
                  <Button variant="ghost" loading={busy === 'unlink'} disabled={busy !== null} onClick={() => void unlink()}>
                    Unlink @{load.github.linked.githubLogin}
                  </Button>
                </>
              ) : (
                <Button loading={busy === 'link'} disabled={busy !== null} onClick={() => void start('link')}>
                  Connect GitHub
                </Button>
              )}
            </div>

            {load.github.tenants.length === 0 ? (
              <EmptyState
                title="No installations yet"
                description={
                  load.github.linked
                    ? 'Install the Updraft App on a GitHub account or organization you own. It shows up here once it is connected.'
                    : 'Connect GitHub first.'
                }
              />
            ) : (
              <ul className="flex flex-col divide-y divide-border" data-testid="tenant-list">
                {load.github.tenants.map((t) => {
                  const s = tenantStatusLabel(t);
                  return (
                    <li key={t.installationId} className="flex items-center justify-between gap-3 py-3">
                      <Link className="auth-link" to={`/installations/${t.installationId}`}>
                        {t.accountLogin}
                      </Link>
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        {t.accountType === 'Organization' ? 'Organization' : 'Personal account'} · {t.role}
                        <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
