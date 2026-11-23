import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type NativeClaudeView } from '../api/client';

type Api = Pick<ApiClient, 'nativeClaude' | 'setNativeClaudeMode'>;
type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; view: NativeClaudeView };

const LOGIN = [
  'cd /',
  'setpriv --reuid 1001 --regid 1001 --clear-groups -- \\',
  '  env -i PATH=/usr/local/bin:/usr/bin:/bin \\',
  '  HOME=/var/lib/updraft-native-auth/home \\',
  '  CLAUDE_CONFIG_DIR=/var/lib/updraft-native-auth/home/.claude \\',
  "  claude --restricted --setting-sources '' auth login",
].join('\n');

/** Select execution mode for the operator-pinned worker; never a Claude OAuth/token proxy. */
export function NativeClaudePage({ api = defaultApi }: { api?: Api }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!valid) {
      setLoad({ state: 'error', message: 'There is no installation at this address.' });
      return;
    }
    let live = true;
    void api.nativeClaude(installationId).then(
      (view) => { if (live) setLoad({ state: 'ok', view }); },
      (err: unknown) => { if (live) setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Could not load Claude settings.' }); },
    );
    return () => { live = false; };
  }, [api, installationId, valid]);

  async function refresh() {
    try {
      setLoad({ state: 'ok', view: await api.nativeClaude(installationId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh worker status.');
    }
  }

  async function choose(enabled: boolean) {
    if (load.state !== 'ok' || enabled === load.view.enabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      setLoad({ state: 'ok', view: await api.setNativeClaudeMode(installationId, enabled) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change authentication mode.');
    } finally {
      setBusy(false);
    }
  }

  const view = load.state === 'ok' ? load.view : null;
  const ready = view?.worker?.online === true && view.worker.status === 'connected';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link className="auth-link" to={'/installations/' + id + '/keys'}>← Agent keys</Link>
      <header>
        <h1 className="text-2xl font-semibold">Claude authentication</h1>
        <p className="mt-2 text-sm text-muted-foreground">Choose how Claude Code runs for this installation. Switching modes never deletes your saved Anthropic API key.</p>
      </header>
      {load.state === 'loading' && <Skeleton className="h-40" />}
      {load.state === 'error' && <Alert variant="error">{load.message}</Alert>}
      {view && (
        <>
          <Card>
            <CardHeader><CardTitle>Execution mode</CardTitle></CardHeader>
            <CardBody>
              <div className="flex flex-col gap-4">
                <section className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>Anthropic API key</strong>
                    {!view.enabled && <StatusBadge tone="success">Selected</StatusBadge>}
                  </div>
                  <p className="my-2 text-sm text-muted-foreground">Keep using the API key saved under Agent keys. Existing Cloud jobs work as before.</p>
                  <Button type="button" variant="secondary" disabled={busy || !view.enabled || Boolean(view.worker?.busy)} onClick={() => void choose(false)}>
                    Use API key
                  </Button>
                </section>
                <section className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>Claude Code subscription</strong>
                    {view.enabled && <StatusBadge tone="success">Selected</StatusBadge>}
                    {view.worker && <StatusBadge tone={ready ? 'success' : 'warning'}>{view.worker.status}</StatusBadge>}
                  </div>
                  <p className="my-2 text-sm text-muted-foreground">
                    Run the official Claude CLI signed into your subscription on a dedicated worker.
                    Only the configured repository and label use this route; other workflows keep their existing API authentication.
                  </p>
                  <Button type="button" disabled={busy || view.enabled || !view.configured || !ready || Boolean(view.worker?.busy)} onClick={() => void choose(true)}>
                    Use subscription
                  </Button>
                  {view.configured && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Repository: {view.repository} · Label: {(view.labels ?? []).join(', ')}
                    </p>
                  )}
                </section>
                {error && <Alert variant="error">{error}</Alert>}
                <div>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => void refresh()}>Refresh worker status</Button>
                </div>
              </div>
            </CardBody>
          </Card>
          {!view.configured && (
            <Alert variant="info">
              The dedicated subscription worker needs to be provisioned once before it can be enabled here.
              <a className="auth-link ml-1" href="https://github.com/allenheltondev/software-factory-cli/blob/main/deploy/aws-microvm/native-worker/CLOUD.md" target="_blank" rel="noreferrer">Worker setup guide ↗</a>
            </Alert>
          )}
          {view.configured && !ready && (
            <Alert variant="info">
              The worker is offline or Claude is not signed in. Connect through the AWS-managed shell and sign in with the official CLI.
              Your API key is still saved.
            </Alert>
          )}
          {view.configured && (
            <Card>
              <CardHeader><CardTitle>One-time subscription sign-in</CardTitle></CardHeader>
              <CardBody>
                <p className="text-sm">Run this inside a direct AWS shell session on your native worker. Authentication stays in Claude's own private directory.</p>
                <pre className="mt-3 overflow-x-auto rounded-lg border border-border p-3 text-xs"><code>{LOGIN}</code></pre>
                <a className="auth-link mt-2 inline-block" href="https://github.com/allenheltondev/software-factory-cli/blob/main/deploy/aws-microvm/native-worker/README.md" target="_blank" rel="noreferrer">Full worker and shell instructions ↗</a>
              </CardBody>
            </Card>
          )}
          <p className="text-sm text-muted-foreground">
            Mode changes affect new GitHub jobs. Wait for any active subscription job to finish before switching.
            The AWS subscription worker has not yet passed its complete live acceptance test.
          </p>
        </>
      )}
    </div>
  );
}
