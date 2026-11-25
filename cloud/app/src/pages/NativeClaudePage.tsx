import { ClaudeNavigation } from '../components/ClaudeNavigation';
import { PackageRegistries, type PackageRegistriesApi } from '../components/PackageRegistries';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ProgressIndicator,
  Skeleton,
  StatusBadge,
} from '@readysetcloud/ui';
import {
  api as defaultApi,
  ApiError,
  type ApiClient,
  type ClaudeWaitingRequest,
  type NativeClaudeTrigger,
  type NativeClaudeView,
} from '../api/client';
import { claudeLoginFrame } from './claudeLoginFrame';
type Api = Pick<
  ApiClient,
  | 'nativeClaude'
  | 'setNativeClaudeMode'
  | 'nativeClaudeLogin'
  | 'nativeClaudeWaiting'
  | 'nativeClaudeStart'
  | 'nativeClaudeRestart'
>;
const triggerKey = (t: NativeClaudeTrigger) =>
  JSON.stringify([t.repositoryId, t.repository.toLowerCase(), t.label.toLowerCase()]);
export function NativeClaudePage({ api }: { api?: Api }) {
  const { id } = useParams();
  return <ClaudeConnectionPage key={id} api={api} />;
}

function ClaudeConnectionPage({ api = defaultApi }: { api?: Api }) {
  const { id } = useParams();
  // Shown when the client can load the list (the real one always can).
  const candidate = api as Partial<PackageRegistriesApi>;
  const registriesApi = candidate.packageRegistries && candidate.setPackageRegistries ? (candidate as PackageRegistriesApi) : undefined;
  const location = useLocation();
  const navigate = useNavigate();
  const connectRequested = (location.state as { connectClaude?: unknown } | null)?.connectClaude === true;
  const [params] = useSearchParams();
  const requestId = params.get('request');
  const installationId = Number(id);
  const [view, setView] = useState<NativeClaudeView>();
  const [error, setError] = useState<string>();
  const [pollError, setPollError] = useState<string>();
  const [request, setRequest] = useState<ClaudeWaitingRequest>();
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'signin' | 'verifying'>('idle');
  const [loginPage, setLoginPage] = useState<string>();
  const [frameHeight, setFrameHeight] = useState(416);
  const revision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<NativeClaudeTrigger[] | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  const flow = useRef(false);
  const mutationPending = useRef(false);
  const canceled = useRef(false);
  const recoveryRequested = useRef(false);
  const [generationChanged, setGenerationChanged] = useState(false);
  const grantRequested = useRef(false);
  const generation = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (phase === 'idle' && restoreFocus.current) {
      restoreFocus.current = false;
      title.current?.focus();
    } else if (phase !== 'idle') {
      restoreFocus.current = true;
    }
  }, [phase]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    let checking = false;
    let terminal = false;
    let requestMissing = false;
    let restored = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      if (!live || checking || terminal) return;
      checking = true;
      const version = revision.current;
      try {
        const next = await api.nativeClaude(installationId, controller.signal);
        if (!live || version !== revision.current) return;
        setView(next);
        if (!restored) {
          restored = true;
          if (
            next.owner &&
            !canceled.current &&
            ((next.managed && connectRequested) ||
              (!next.retired && (next.preparing || (next.upgrade ?? next.recovery)?.state === 'stopping')))
          ) {
            flow.current = true;
            recoveryRequested.current = Boolean(connectRequested && (next.startupFailed || next.retired));
            setPhase('preparing');
            try {
              const replacement = next.upgrade ?? next.recovery;
              if (connectRequested && replacement?.state === 'required') await api.nativeClaudeRestart(installationId);
              else if (next.preparing || (connectRequested && replacement?.state !== 'stopping'))
                await api.nativeClaudeStart(installationId);
            } catch (err) {
              flow.current = false;
              setPhase('idle');
              setError(err instanceof Error ? err.message : 'Could not connect. Try again.');
            }
            if (!live || version !== revision.current) return;
          }
        }

        // Consume entry intent before opening a grant: replacing router state cancels this effect.
        if (connectRequested) {
          void navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
          return;
        }
        if (requestId && !requestMissing) {
          try {
            const waiting = await api.nativeClaudeWaiting(installationId, requestId, controller.signal);
            if (!live || version !== revision.current) return;
            setRequest(waiting);
          } catch (err) {
            if (err instanceof ApiError && [401, 403].includes(err.status)) throw err;
            requestMissing = err instanceof ApiError && err.status === 404;
            if (live) setError('Could not load the waiting job. You can still connect your Claude account.');
          }
        }
        if (!next.startupFailed && !next.retired) recoveryRequested.current = false;
        if (flow.current && (next.startupFailed || next.retired) && !recoveryRequested.current) {
          flow.current = false;
          grantRequested.current = false;
          setLoginPage(undefined);
          setPhase('idle');
        } else if (
          flow.current &&
          !mutationPending.current &&
          generation.current &&
          next.worker?.generation &&
          next.worker.generation !== generation.current
        ) {
          flow.current = false;
          grantRequested.current = false;
          setLoginPage(undefined);
          setPhase('idle');
          setGenerationChanged(true);
          setError('Your Claude environment changed during sign-in. Reconnect Claude to continue.');
        } else if (flow.current && !mutationPending.current && (next.upgrade ?? next.recovery)?.state === 'stopped') {
          await api.nativeClaudeStart(installationId);
        } else if (flow.current && !mutationPending.current && !next.upgrade && !next.recovery && next.worker?.online) {
          if (
            next.worker.status === 'connected' &&
            (!generation.current || generation.current === next.worker.generation)
          ) {
            flow.current = false;
            setPhase('idle');
            setLoginPage(undefined);
          } else if (['auth-required', 'expired'].includes(next.worker.status) && !grantRequested.current) {
            grantRequested.current = true;
            generation.current = next.worker.generation;
            const grant = await api.nativeClaudeLogin(installationId, controller.signal).catch((err) => {
              if (live && version === revision.current) grantRequested.current = false;
              throw err;
            });
            if (!live || !flow.current || version !== revision.current) {
              if (!live && version === revision.current) grantRequested.current = false;
              return;
            }
            generation.current = grant.generation ?? generation.current;
            setLoginPage(
              claudeLoginFrame(
                grant,
                document.documentElement.dataset.theme === 'dark'
                  ? 'dark'
                  : document.documentElement.dataset.theme === 'light'
                    ? 'light'
                    : undefined,
              ),
            );
            setPhase('signin');
          }
        }
        failures = 0;
        setPollError(undefined);
      } catch (err) {
        if (live) {
          terminal = err instanceof ApiError && [401, 403, 404].includes(err.status);
          if (terminal) {
            flow.current = false;
            setPhase('idle');
            setLoginPage(undefined);
          }
          failures++;
          setPollError(
            (err instanceof Error ? err.message + ' ' : '') +
              (terminal ? 'Check your installation access.' : 'Retrying automatically.'),
          );
        }
      } finally {
        checking = false;
        if (live && !terminal)
          timer = setTimeout(() => void check(), Math.min(30000, 2500 * 2 ** Math.min(failures, 4)));
      }
    }
    const wake = () => {
      clearTimeout(timer);
      void check();
    };
    if (Number.isSafeInteger(installationId) && installationId > 0) void check();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [api, installationId, requestId, connectRequested, navigate, location.pathname, location.search]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== 'null' ||
        event.data?.kind !== 'updraft-claude-login'
      )
        return;
      if (
        event.data.result === 'resize' &&
        Number.isSafeInteger(event.data.height) &&
        event.data.height >= 100 &&
        event.data.height <= 1200
      ) {
        setFrameHeight(event.data.height);
        return;
      }
      if (event.data.result === 'connected') setPhase('verifying');
      else if (['expired', 'failed'].includes(event.data.result)) {
        grantRequested.current = false;
        flow.current = false;
        setPhase('idle');
        setLoginPage(undefined);
        setError('Sign-in expired or was interrupted. Connect again to retry.');
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  async function connect() {
    const version = ++revision.current;
    mutationPending.current = true;
    canceled.current = false;
    recoveryRequested.current = Boolean(view?.startupFailed || view?.retired);
    setGenerationChanged(false);
    setError(undefined);
    setPhase('preparing');
    setLoginPage(undefined);
    flow.current = true;
    grantRequested.current = false;
    generation.current = undefined;
    try {
      const replacement = view?.upgrade ?? view?.recovery;
      if (replacement?.state === 'stopping') return;
      const updated =
        replacement?.state === 'required'
          ? await api.nativeClaudeRestart(installationId)
          : await api.nativeClaudeStart(installationId);
      if (version === revision.current) setView(updated);
    } catch (err) {
      if (version === revision.current) {
        flow.current = false;
        setPhase('idle');
        setError(err instanceof Error ? err.message : 'Could not connect. Try again.');
      }
    } finally {
      if (version === revision.current) mutationPending.current = false;
    }
  }
  async function choose(enabled: boolean, triggers?: NativeClaudeTrigger[]) {
    revision.current++;
    setBusy(true);
    setError(undefined);
    try {
      setView(await api.setNativeClaudeMode(installationId, enabled, triggers));
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save routing.');
    } finally {
      setBusy(false);
    }
  }
  const ready =
    !generationChanged &&
    !view?.upgrade &&
    !view?.recovery &&
    view?.worker?.online === true &&
    view.worker.status === 'connected' &&
    phase === 'idle';
  const selection = draft ?? view?.triggers ?? [];
  const available = new Map((view?.availableTriggers ?? []).map((t) => [triggerKey(t), t]));
  const options = new Map([...(view?.triggers ?? []).map((t) => [triggerKey(t), t] as const), ...available]);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {phase === 'idle' && <ClaudeNavigation />}
      {phase === 'idle' && (
        <Link className="auth-link" to={`/installations/${id}/keys`}>
          ← Agent keys
        </Link>
      )}
      {phase === 'idle' && (
        <header>
          <h1 ref={title} tabIndex={-1} className="text-2xl font-semibold">
            Claude account
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Connect your subscription, then choose which workflows use it.
          </p>
        </header>
      )}
      {error && <Alert variant="error">{error}</Alert>}
      {pollError && <Alert variant="error">{pollError}</Alert>}
      {!Number.isSafeInteger(installationId) || installationId <= 0 ? (
        <Alert variant="error">There is no installation at this address.</Alert>
      ) : !view && !pollError ? (
        <Skeleton className="h-40" />
      ) : null}
      {view && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{phase === 'idle' ? 'Connection' : 'Connect Claude account'}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              {phase === 'idle' && (
                <>
                  <StatusBadge tone={ready ? 'success' : 'warning'}>
                    {view.retired ? 'Session ended' : ready ? 'Connected' : 'Connection required'}
                  </StatusBadge>
                  <p className="text-sm text-muted-foreground">
                    Your dedicated connection lasts up to {(view.connectionPolicy?.maxSessionSeconds ?? 28800) / 3600}{' '}
                    hours, including normal breaks. An environment with no work may close after{' '}
                    {(view.connectionPolicy?.idleSeconds ?? 28800) >= 3600
                      ? `${(view.connectionPolicy?.idleSeconds ?? 28800) / 3600} hours`
                      : `${(view.connectionPolicy?.idleSeconds ?? 28800) / 60} minutes`}{' '}
                    idle. Your API key stays saved. Enable subscription routing separately below.
                  </p>
                  {view.connectionPolicy && (
                    <p className="text-sm text-muted-foreground">
                      Up to {view.connectionPolicy.tenantLaunchesPerDay} new environments per UTC day, within a{' '}
                      {view.connectionPolicy.tenantDailySeconds / 3600}-hour runtime budget. Unused runtime is released
                      only after the environment has stopped.
                    </p>
                  )}
                  {view.sessionExpiresAt && !view.retired && (
                    <p className="text-sm text-muted-foreground">
                      Current connection expires{' '}
                      {new Date(view.sessionExpiresAt).toLocaleString(undefined, { timeZoneName: 'short' })}.
                    </p>
                  )}
                  {ready && (
                    <p>
                      {view.enabled
                        ? 'Subscription routing is enabled.'
                        : 'Your account is connected but no workflows use it yet.'}
                    </p>
                  )}
                  {!view.owner && <p>An installation owner can connect this account.</p>}
                  {view.owner && !view.managed && view.browserLogin && !ready && phase === 'idle' && (
                    <Button
                      onClick={() => {
                        flow.current = true;
                        grantRequested.current = false;
                        setPhase('preparing');
                      }}
                    >
                      Sign in to Claude
                    </Button>
                  )}
                  {view.configured && !view.browserLogin && !ready && (
                    <p>
                      The worker is offline or Claude is not signed in. An operator can sign in through the existing AWS
                      shell route.
                    </p>
                  )}
                  {view.owner && view.managed && !ready && phase === 'idle' && (
                    <div>
                      <Button disabled={Boolean(view.worker?.busy)} onClick={() => void connect()}>
                        {view.upgrade
                          ? 'Update and reconnect'
                          : view.worker || view.startupFailed || view.retired
                            ? 'Reconnect Claude'
                            : 'Connect Claude account'}
                      </Button>
                    </div>
                  )}
                  {view.retired && (
                    <p role="status">
                      This connection has ended. Reconnect Claude when you are ready; opening this page does not start
                      another environment.
                    </p>
                  )}
                  {view.startupFailed && (
                    <Alert variant="error">
                      Your Claude environment did not become ready. Reconnect Claude to replace it safely.
                    </Alert>
                  )}
                  {view.worker?.busy && !ready && (
                    <p role="status">Wait for the current job to finish before reconnecting.</p>
                  )}
                </>
              )}
              {phase !== 'idle' && (
                <section
                  tabIndex={-1}
                  ref={(node) => {
                    if (node && !node.contains(document.activeElement)) node.focus();
                  }}
                  aria-label="Connect Claude account"
                  className="flex flex-col gap-4"
                >
                  <ProgressIndicator
                    aria-label="Connection progress"
                    steps={['Preparing your environment', 'Sign in to Claude', 'Verifying connection', 'Connected'].map(
                      (label, i) => ({
                        id: String(i),
                        label,
                        status:
                          i < ['preparing', 'signin', 'verifying'].indexOf(phase)
                            ? 'completed'
                            : i === ['preparing', 'signin', 'verifying'].indexOf(phase)
                              ? 'in-progress'
                              : 'pending',
                      }),
                    )}
                  />
                  <p role="status">
                    {phase === 'preparing'
                      ? 'Preparing your environment…'
                      : phase === 'verifying'
                        ? 'Verifying your connection with your environment…'
                        : 'Continue below to sign in.'}
                  </p>
                  {loginPage && (
                    <iframe
                      ref={frame}
                      title="Private Claude sign-in"
                      style={{ height: frameHeight }}
                      className="w-full rounded-lg border border-border"
                      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                      srcDoc={loginPage}
                    />
                  )}
                  <div>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        revision.current++;
                        canceled.current = true;
                        mutationPending.current = false;
                        flow.current = false;
                        setLoginPage(undefined);
                        setPhase('idle');
                      }}
                    >
                      Cancel sign-in
                    </Button>
                  </div>
                </section>
              )}
              {request && (
                <p>
                  {request.status === 'waiting'
                    ? 'Your GitHub job will resume automatically when eligible.'
                    : request.reason}
                </p>
              )}
              {request?.status === 'started' && request.jobId && (
                <Link className="auth-link" to={`/installations/${installationId}/jobs/${request.jobId}`}>
                  View resumed job
                </Link>
              )}
            </CardBody>
          </Card>
          {phase === 'idle' && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Execution mode</CardTitle>
                </CardHeader>
                <CardBody>
                  <div className="flex flex-col gap-4">
                    <section className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>Anthropic API key</strong>
                        {!view.enabled && <StatusBadge tone="success">Selected</StatusBadge>}
                      </div>
                      <p className="my-2 text-sm text-muted-foreground">
                        Keep using the API key saved under Agent keys. Existing Cloud jobs work as before.
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={!view.owner || busy || !view.enabled || Boolean(view.worker?.busy)}
                        onClick={() => void choose(false)}
                      >
                        Use API key
                      </Button>
                    </section>
                    <section className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>Claude Code subscription</strong>
                        {view.enabled && <StatusBadge tone="success">Selected</StatusBadge>}
                      </div>
                      <p className="my-2 text-sm text-muted-foreground">
                        Run the official Claude CLI signed into your subscription on a dedicated worker. Choose
                        published workflow triggers below. Other workflows keep their existing execution mode.
                      </p>
                      <Button
                        type="button"
                        disabled={
                          !view.owner ||
                          busy ||
                          view.enabled ||
                          !view.configured ||
                          (!view.managed && !ready) ||
                          (view.triggers !== undefined && selection.length === 0) ||
                          Boolean(view.worker?.busy)
                        }
                        onClick={() => {
                          if (
                            window.confirm(
                              'Use your Claude subscription for the selected workflows? Other workflows keep their existing billing.',
                            )
                          )
                            void choose(true, draft ?? undefined);
                        }}
                      >
                        Use subscription
                      </Button>
                    </section>
                  </div>
                </CardBody>
              </Card>
              {view.configured && view.availableTriggers !== undefined && (
                <Card>
                  <CardHeader>
                    <CardTitle>Workflow triggers</CardTitle>
                  </CardHeader>
                  <CardBody className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                      Select the repository and label combinations that use this worker. Existing subscription pull
                      requests keep their execution mode.
                    </p>
                    {options.size === 0 && (
                      <p className="text-sm">
                        Publish a workflow that uses Claude in{' '}
                        <Link className="auth-link" to={`/installations/${installationId}/config`}>
                          Configuration
                        </Link>{' '}
                        to add a trigger here.
                      </p>
                    )}
                    {[...options].map(([key, trigger]) => {
                      const checked = selection.some((item) => triggerKey(item) === key);
                      return (
                        <label key={key} className="flex items-baseline gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={
                              !view.owner || busy || Boolean(view.worker?.busy) || (!available.has(key) && !checked)
                            }
                            onChange={(event) => {
                              setDraft(
                                event.target.checked
                                  ? [...selection, trigger]
                                  : selection.filter((item) => triggerKey(item) !== key),
                              );
                            }}
                          />
                          <span>
                            {trigger.repository} · {trigger.label}
                            {!available.has(key) && ' (no longer published)'}
                          </span>
                        </label>
                      );
                    })}
                    <div>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={
                          !view.owner ||
                          busy ||
                          !draft ||
                          Boolean(view.worker?.busy) ||
                          (view.enabled && ((!view.managed && !ready) || selection.length === 0))
                        }
                        onClick={() => void choose(view.enabled, selection)}
                      >
                        Save workflow triggers
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              )}
              {view.configured && registriesApi && (
                <PackageRegistries api={registriesApi} installationId={installationId} />
              )}
              {!view.configured && (
                <Alert variant="info">
                  Claude subscription is unavailable in this deployment. An Updraft operator needs to enable the worker
                  image before you can select triggers.
                  <a
                    className="auth-link ml-1"
                    href="https://github.com/allenheltondev/software-factory-cli/blob/main/deploy/aws-microvm/native-worker/CLOUD.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Worker setup guide ↗
                  </a>
                </Alert>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
