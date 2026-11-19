import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Loading } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type CallbackInput, type CallbackResult, type ConnectableInstallation } from '../api/client';

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

type Row = { state: 'idle' | 'busy' | 'connected' } | { state: 'error'; message: string };

/**
 * The installations of the App this GitHub account has authority over, as of the link just made.
 * Connecting one makes it a tenant with you as owner; the offer lasts ten minutes.
 */
function ConnectList({ api, installations }: { api: Pick<ApiClient, 'connect'>; installations: ConnectableInstallation[] }) {
  const [rows, setRows] = useState<Record<number, Row>>(() =>
    Object.fromEntries(installations.map((i) => [i.installationId, { state: i.connected ? 'connected' : 'idle' } as Row])),
  );
  const set = (id: number, row: Row) => setRows((r) => ({ ...r, [id]: row }));

  async function connect(id: number) {
    set(id, { state: 'busy' });
    try {
      await api.connect(id);
      set(id, { state: 'connected' });
    } catch (err) {
      set(id, { state: 'error', message: err instanceof Error ? err.message : 'Could not connect it.' });
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="connect-list">
      <p className="text-sm text-muted-foreground">The Updraft App is already installed on these accounts you own. Connect the ones Updraft should manage:</p>
      <ul className="flex flex-col divide-y divide-border">
        {installations.map((i) => {
          const row = rows[i.installationId] ?? { state: 'idle' };
          return (
            <li key={i.installationId} className="flex flex-col gap-1 py-2">
              <div className="flex items-center justify-between gap-3">
                <span>
                  {i.accountLogin} <span className="text-sm text-muted-foreground">· {i.accountType === 'Organization' ? 'Organization' : 'Personal account'}</span>
                </span>
                {row.state === 'connected' ? (
                  <Link className="auth-link" to={`/installations/${i.installationId}`}>
                    Connected
                  </Link>
                ) : (
                  <Button size="sm" loading={row.state === 'busy'} onClick={() => void connect(i.installationId)}>
                    Connect
                  </Button>
                )}
              </div>
              {row.state === 'error' && <Alert variant="error">{row.message}</Alert>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * GitHub sends the browser here after linking (code, state) or installing the App (code, state,
 * installation_id, setup_action). The page forwards that to the API exactly once: the state is
 * single use, so a second post (React's dev double effect, a reload) would fail. The query string
 * is dropped from the address bar and history straight away, so the code does not linger there.
 */
export function GitHubCallbackPage({ api = defaultApi }: { api?: Pick<ApiClient, 'completeCallback' | 'connect'> }) {
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
          <>
            <Alert variant="success" data-testid="callback-linked">
              Linked to GitHub as @{view.result.githubLogin}.
              {view.result.installations.length === 0 ? ' Next, install the Updraft App.' : ''}
            </Alert>
            {view.result.installations.length > 0 && <ConnectList api={api} installations={view.result.installations} />}
          </>
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
