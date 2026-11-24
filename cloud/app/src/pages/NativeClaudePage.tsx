import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type ClaudeWaitingRequest, type NativeClaudeTrigger, type NativeClaudeView } from '../api/client';

import { claudeLoginFrame } from './claudeLoginFrame';

type Api = Pick<ApiClient, 'nativeClaude' | 'setNativeClaudeMode' | 'nativeClaudeLogin' | 'nativeClaudeWaiting' | 'nativeClaudeStart'>;
type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; view: NativeClaudeView };

const triggerKey = (trigger: NativeClaudeTrigger) => JSON.stringify([trigger.repositoryId, trigger.repository.toLowerCase(), trigger.label.toLowerCase()]);

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
  const [params] = useSearchParams();
  const requestId = params.get('request');
  const navigate = useNavigate();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };
  const frame = useRef<HTMLIFrameElement>(null);
  const [loginPage, setLoginPage] = useState<string | null>(null);
  const [workerExpiresAt, setWorkerExpiresAt] = useState<string>();
  const [request, setRequest] = useState<ClaudeWaitingRequest>();
  const [startingWorker, setStartingWorker] = useState(false);
  const [openingLogin, setOpeningLogin] = useState(false);
  const [waitingForWorker, setWaitingForWorker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<NativeClaudeTrigger[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!valid) return;
    let live = true;
    void api.nativeClaude(installationId).then(
      (view) => { if (live) setLoad({ state: 'ok', view }); },
      (err: unknown) => { if (live) setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Could not load Claude settings.' }); },
    );
    return () => { live = false; };
  }, [api, installationId, valid]);

  useEffect(() => {
    if (!valid || !requestId) return;
    let live = true;
    let finished = false;
    const check = async () => {
      try {
        const state = await api.nativeClaudeWaiting(installationId, requestId);
        if (!live) return;
        setRequest(state);
        finished = state.status !== 'waiting';
        if (state.status === 'started' && state.jobId) void navigate(`/installations/${installationId}/jobs/${state.jobId}`, { replace: true });
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'Could not load the waiting job.');
      }
    };
    void check();
    const interval = setInterval(() => { if (finished) clearInterval(interval); else void check(); }, 4000);
    return () => { live = false; clearInterval(interval); };
  }, [api, installationId, navigate, requestId, valid]);

  useEffect(() => {
    if (!startingWorker) return;
    let live = true;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void api.nativeClaude(installationId).then(async (view) => {
        if (!live || !view.worker?.online) return;
        setLoad({ state: 'ok', view });
        try {
          if (['auth-required', 'expired'].includes(view.worker.status)) {
            const grant = await api.nativeClaudeLogin(installationId);
            if (!live) return;
            setLoginPage(claudeLoginFrame(grant));
            setWorkerExpiresAt(grant.expiresAt);
          }
        } catch (err) {
          if (live) setError(err instanceof Error ? err.message : 'Could not open worker sign-in.');
        } finally {
          if (live) setStartingWorker(false);
        }
      }, () => {}).finally(() => { checking = false; });
    }, 2500);
    const timeout = setTimeout(() => {
      setStartingWorker(false);
      setError('The worker has not checked in yet. Try again to check the same session.');
    }, 120_000);
    return () => { live = false; clearInterval(timer); clearTimeout(timeout); };
  }, [api, installationId, startingWorker]);

  async function startWorker() {
    if (!requestId || startingWorker) return;
    setStartingWorker(true);
    setError(null);
    try {
      const view = await api.nativeClaudeStart(installationId, requestId);
      setLoad({ state: 'ok', view });
      if (view.worker?.online) {
        if (['auth-required', 'expired'].includes(view.worker.status)) await openLogin();
        setStartingWorker(false);
      }
    } catch (err) {
      setStartingWorker(false);
      setError(err instanceof Error ? err.message : 'Could not start the subscription worker.');
    }
  }

  async function openLogin() {
    setError(null);
    setOpeningLogin(true);
    try {
      const grant = await api.nativeClaudeLogin(installationId);
      setLoginPage(claudeLoginFrame(grant));
      setWorkerExpiresAt(grant.expiresAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open worker sign-in.');
    } finally {
      setOpeningLogin(false);
    }
  }

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' ||
          event.data?.kind !== 'updraft-claude-login' || event.data?.result !== 'connected') return;
      setLoginPage(null);
      setWaitingForWorker(true);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!waitingForWorker) return;
    let live = true;
    const interval = setInterval(() => {
      void api.nativeClaude(installationId).then((view) => {
        if (!live || !view.worker?.online || view.worker.status !== 'connected') return;
        setLoad({ state: 'ok', view });
        setWaitingForWorker(false);
      }, () => {});
    }, 2000);
    const timeout = setTimeout(() => {
      setWaitingForWorker(false);
      setError('The worker has not reported its sign-in yet. Refresh worker status to check again.');
    }, 30_000);
    return () => {
      live = false;
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [api, installationId, waitingForWorker]);

  async function refresh() {
    try {
      setLoad({ state: 'ok', view: await api.nativeClaude(installationId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh worker status.');
    }
  }

  async function choose(enabled: boolean, triggers?: NativeClaudeTrigger[]) {
    if (load.state !== 'ok' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = triggers === undefined
        ? await api.setNativeClaudeMode(installationId, enabled)
        : await api.setNativeClaudeMode(installationId, enabled, triggers);
      setLoad({ state: 'ok', view: updated });
      if (triggers !== undefined) setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change authentication mode.');
    } finally {
      setBusy(false);
    }
  }

  const view = load.state === 'ok' ? load.view : null;
  const selection = draft ?? view?.triggers ?? [];
  const available = new Map((view?.availableTriggers ?? []).map((trigger) => [triggerKey(trigger), trigger]));
  const options = new Map([...(view?.triggers ?? []).map((trigger) => [triggerKey(trigger), trigger] as const), ...available]);
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
      {request && (
        <Alert variant={request.status === 'waiting' ? 'info' : 'error'}>
          {request.status === 'waiting'
            ? ready ? 'Claude is connected. The waiting GitHub job will start automatically.' : 'This GitHub job is waiting for Claude subscription sign-in.'
            : request.reason ?? (request.status === 'expired' ? 'This sign-in request expired.' : 'This job is no longer waiting for sign-in.')}
        </Alert>
      )}
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
                    Choose published workflow triggers below. Other workflows keep their existing execution mode.
                  </p>
                  <Button type="button" disabled={busy || view.enabled || !view.configured || (!view.managed && !ready) || (view.triggers !== undefined && selection.length === 0) || Boolean(view.worker?.busy)} onClick={() => void choose(true, draft ?? undefined)}>
                    Use subscription
                  </Button>
                </section>
                {workerExpiresAt && <p className="text-sm text-muted-foreground">Worker session expires {new Date(workerExpiresAt).toLocaleString()}.</p>}
                {error && <Alert variant="error">{error}</Alert>}
                <div>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => void refresh()}>Refresh worker status</Button>
                </div>
              </div>
            </CardBody>
          </Card>
          {view.configured && view.availableTriggers !== undefined && (
            <Card>
              <CardHeader><CardTitle>Workflow triggers</CardTitle></CardHeader>
              <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">Select the repository and label combinations that use this worker. Existing subscription pull requests keep their execution mode.</p>
                {options.size === 0 && <p className="text-sm">Publish a workflow that uses Claude in <Link className="auth-link" to={`/installations/${installationId}/config`}>Configuration</Link> to add a trigger here.</p>}
                {[...options].map(([key, trigger]) => {
                  const checked = selection.some((item) => triggerKey(item) === key);
                  return (
                    <label key={key} className="flex items-baseline gap-2 text-sm">
                      <input type="checkbox" checked={checked} disabled={busy || Boolean(view.worker?.busy) || (!available.has(key) && !checked)} onChange={(event) => {
                        setDraft(event.target.checked ? [...selection, trigger] : selection.filter((item) => triggerKey(item) !== key));
                      }} />
                      <span>{trigger.repository} · {trigger.label}{!available.has(key) && ' (no longer published)'}</span>
                    </label>
                  );
                })}
                <div>
                  <Button type="button" variant="secondary" disabled={busy || !draft || Boolean(view.worker?.busy) || (view.enabled && ((!view.managed && !ready) || selection.length === 0))} onClick={() => void choose(view.enabled, selection)}>
                    Save workflow triggers
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}
          {!view.configured && (
            <Alert variant="info">
              Claude subscription is unavailable in this deployment. An Updraft operator needs to enable the worker image before you can select triggers.
              <a className="auth-link ml-1" href="https://github.com/allenheltondev/software-factory-cli/blob/main/deploy/aws-microvm/native-worker/CLOUD.md" target="_blank" rel="noreferrer">Worker setup guide ↗</a>
            </Alert>
          )}
          {view.configured && !ready && !view.browserLogin && (
            <Alert variant="info">
              The worker is offline or Claude is not signed in. Connect through the AWS-managed shell and sign in with the official CLI.
              Your API key is still saved.
            </Alert>
          )}
          {view.browserLogin && !ready && (
            <Card>
              <CardHeader><CardTitle>Sign in to Claude</CardTitle></CardHeader>
              <CardBody className="flex flex-col gap-3">
                {waitingForWorker ? <p role="status">Waiting for the worker to report its sign-in…</p> : loginPage ? (
                  <>
                    <iframe ref={frame} title="Private Claude sign-in" className="h-56 w-full rounded-md border border-border"
                      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcDoc={loginPage} />
                    <div><Button variant="ghost" onClick={() => setLoginPage(null)}>Close sign-in</Button></div>
                  </>
                ) : (
                  <>
                    <p className="text-sm">Sign in with Claude in your browser, then return here to finish.</p>
                    {view.managed && request?.status === 'waiting' && !view.worker?.online && (
                      <div><Button onClick={() => void startWorker()} loading={startingWorker} disabled={startingWorker}>Start worker and sign in</Button></div>
                    )}
                    <div><Button onClick={() => void openLogin()} loading={openingLogin}
                      disabled={openingLogin || !view.worker?.online || !['auth-required', 'expired'].includes(view.worker.status)}>
                      Sign in to Claude
                    </Button></div>
                  </>
                )}
              </CardBody>
            </Card>
          )}
          {view.configured && !view.browserLogin && (
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
            Mode changes affect new GitHub jobs. Retrying an earlier job keeps its original execution mode. To test subscription routing, apply a selected start label to a new issue after enabling the subscription.
            The AWS subscription worker has not yet passed its complete live acceptance test.
          </p>
        </>
      )}
    </div>
  );
}
