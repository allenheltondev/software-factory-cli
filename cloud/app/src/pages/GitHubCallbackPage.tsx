import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Alert, Card, CardBody, CardHeader, CardTitle, Loading } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type CallbackInput, type CallbackResult } from '../api/client';

/** What GitHub put in the callback's query string. */
export function callbackInput(search: string): CallbackInput {
  const q = new URLSearchParams(search);
  const input: CallbackInput = {};
  const code = q.get('code');
  const state = q.get('state');
  const installationId = q.get('installation_id');
  const setupAction = q.get('setup_action');
  if (code) input.code = code;
  if (state) input.state = state;
  if (installationId) input.installationId = installationId;
  if (setupAction) input.setupAction = setupAction;
  return input;
}

type View = { state: 'working' } | { state: 'done'; result: CallbackResult } | { state: 'error'; message: string };

/**
 * GitHub sends the browser here after linking (code, state) or installing the App (code, state,
 * installation_id, setup_action). The page forwards that to the API exactly once: the state is
 * single use, so a second post (React's dev double effect, a reload) would fail. The query string
 * is dropped from the address bar and history straight away, so the code does not linger there.
 */
export function GitHubCallbackPage({ api = defaultApi }: { api?: Pick<ApiClient, 'completeCallback'> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [input] = useState(() => callbackInput(location.search));
  const sent = useRef(false);
  const [view, setView] = useState<View>(() =>
    input.state ? { state: 'working' } : { state: 'error', message: 'This link did not come from Updraft. Start again from the dashboard.' },
  );

  useEffect(() => {
    if (location.search) void navigate('/github/callback', { replace: true });
  }, [location.search, navigate]);

  useEffect(() => {
    if (sent.current || !input.state) return;
    sent.current = true;
    api.completeCallback(input).then(
      (result) => setView({ state: 'done', result }),
      (err: unknown) => setView({ state: 'error', message: err instanceof Error ? err.message : 'GitHub could not be connected.' }),
    );
  }, [api, input]);

  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardHeader>
        <CardTitle>GitHub</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {view.state === 'working' && <Loading text="Connecting GitHub…" data-testid="callback-working" />}
        {view.state === 'error' && (
          <Alert variant="error" data-testid="callback-error">
            {view.message}
          </Alert>
        )}
        {view.state === 'done' && view.result.kind === 'linked' && (
          <Alert variant="success" data-testid="callback-linked">
            Linked to GitHub as @{view.result.githubLogin}. Next, install the Updraft App.
          </Alert>
        )}
        {view.state === 'done' && view.result.kind === 'installed' && (
          <Alert variant="success" data-testid="callback-installed">
            Connected {view.result.accountLogin}.{' '}
            <Link className="auth-link" to={`/installations/${view.result.installationId}`}>
              See its repositories
            </Link>
          </Alert>
        )}
        {view.state === 'done' && view.result.kind === 'requested' && (
          <Alert variant="info" data-testid="callback-requested">
            GitHub asked an organization owner to approve the installation. Once they approve it, they can connect it to Updraft.
          </Alert>
        )}
        {view.state !== 'working' && (
          <Link className="auth-link" to="/">
            Back to the dashboard
          </Link>
        )}
      </CardBody>
    </Card>
  );
}
