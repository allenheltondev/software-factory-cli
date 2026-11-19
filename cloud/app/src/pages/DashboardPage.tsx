import { useEffect, useState } from 'react';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type Me } from '../api/client';

type Load = { state: 'loading' } | { state: 'ok'; me: Me } | { state: 'error' };

/**
 * The first page after sign-in. For now it proves the whole path works (SPA → CloudFront →
 * API Gateway's Cognito authorizer → the API) by loading the caller from /api/v1/me, and says
 * what comes next. Linking GitHub and installing the App arrive with #67.
 */
export function DashboardPage({ api = defaultApi }: { api?: Pick<ApiClient, 'me'> }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    api.me().then(
      (me) => live && setLoad({ state: 'ok', me }),
      () => live && setLoad({ state: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [api]);

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

      {load.state === 'ok' && (
        <Card data-testid="dashboard-ready">
          <CardHeader>
            <CardTitle>Get started</CardTitle>
            <CardDescription>Signed in as {load.me.email ?? load.me.sub}.</CardDescription>
          </CardHeader>
          <CardBody>
            <EmptyState
              title="Connect GitHub"
              description="Linking your GitHub account and installing the Updraft GitHub App on your repositories is coming soon."
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
