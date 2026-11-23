import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Input, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type ClaudeSignInView } from '../api/client';

type Api = Pick<ApiClient, 'claudeSignIn' | 'submitClaudeSignInCode'>;
type Load = { state: 'loading' } | { state: 'ok'; view: ClaudeSignInView } | { state: 'error'; message: string };

/** How often the page looks again while the job takes the code and saves the token. */
const POLL_MS = 3_000;

/**
 * A job's Claude subscription sign-in (the broker posts the link to it on the issue). The job is
 * waiting in its microVM, running Claude Code's own `claude setup-token`: a member opens the
 * claude.ai link here, signs in with a Claude Pro or Max subscription, and pastes the code
 * claude.ai shows. The job takes it once, finishes the sign-in, saves the token for this
 * installation's later jobs, and goes on.
 */
export function ClaudeSignInPage({ api = defaultApi, pollMs = POLL_MS }: { api?: Api; pollMs?: number }) {
  const { id, jobId = '' } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0 && jobId !== '';
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no sign-in at this address.' };
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const viewState = load.state === 'ok' ? load.view.state : undefined;
  useEffect(() => {
    if (!valid) return;
    let live = true;
    const fetchOnce = () =>
      api.claudeSignIn(installationId, jobId).then(
        (view) => live && setLoad({ state: 'ok', view }),
        (err: unknown) => live && setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Could not load the sign-in.' }),
      );
    // Once, then again while the job has something to do before the page can say how it went.
    if (viewState === undefined) void fetchOnce();
    if (viewState !== 'starting' && viewState !== 'code' && viewState !== 'exchanging') return () => void (live = false);
    const timer = setInterval(() => void fetchOnce(), pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, installationId, jobId, valid, viewState, pollMs]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const typed = code.trim();
    if (!typed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.submitClaudeSignInCode(installationId, jobId, typed);
      setCode('');
      setLoad({ state: 'ok', view });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code. Try again.');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const where = load.state === 'ok' ? `${load.view.repository}#${load.view.issue ?? load.view.pullRequest ?? ''}` : '';

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link className="auth-link" to={`/installations/${id}`}>
        ← Installation
      </Link>
      <h1 className="text-2xl font-semibold">Sign in to Claude</h1>

      {load.state === 'loading' && <Skeleton className="h-40" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="sign-in-error">
          {load.message}
        </Alert>
      )}

      {load.state === 'ok' && (
        <Card data-testid="sign-in">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Job for {where}
              <StatusBadge tone={STATE[load.view.state].tone}>{STATE[load.view.state].label}</StatusBadge>
            </CardTitle>
          </CardHeader>
          <CardBody>
            <div className="flex flex-col gap-4">
              {load.view.state === 'waiting' && load.view.url && (
                <>
                  <p>
                    This job runs Claude on a Claude subscription instead of API credits. Sign in once: the job goes on by itself, and this installation&apos;s later jobs use the
                    same sign-in for a year.
                  </p>
                  <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm" data-testid="sign-in-steps">
                    <li>
                      <a className="auth-link font-semibold" href={load.view.url} target="_blank" rel="noreferrer" data-testid="sign-in-link">
                        Sign in to Claude ↗
                      </a>{' '}
                      with the Claude Pro or Max account whose subscription jobs should use.
                    </li>
                    <li>Claude shows a code once you have signed in. Copy it.</li>
                    <li>Paste it here.</li>
                  </ol>
                  <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
                    <Input
                      ref={input}
                      label="Code from Claude"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={code}
                      disabled={busy}
                      onChange={(e) => {
                        setCode(e.target.value);
                        setError(null);
                      }}
                    />
                    {error && (
                      <Alert variant="error" data-testid="sign-in-submit-error">
                        {error}
                      </Alert>
                    )}
                    <div>
                      <Button type="submit" loading={busy} disabled={!code.trim()}>
                        Finish sign-in
                      </Button>
                    </div>
                  </form>
                  {load.view.waitsUntil && (
                    <p className="text-sm" data-testid="sign-in-deadline">
                      The job waits until {new Date(load.view.waitsUntil).toLocaleTimeString()}. After that, apply the label again for a new sign-in.
                    </p>
                  )}
                </>
              )}
              {load.view.state === 'starting' && <p role="status">The job is starting Claude&apos;s sign-in. The link appears here in a moment.</p>}
              {(load.view.state === 'code' || load.view.state === 'exchanging') && (
                <p role="status" data-testid="sign-in-finishing">
                  Code received{load.view.by ? ` from ${load.view.by}` : ''}. The job is finishing the sign-in…
                </p>
              )}
              {load.view.state === 'done' && (
                <p role="status" className="font-medium" data-testid="sign-in-done">
                  ✓ Signed in{load.view.by ? ` by ${load.view.by}` : ''}. The job is running, and later jobs use this sign-in. It is under{' '}
                  <Link className="auth-link" to={`/installations/${id}/keys`}>
                    Agent keys
                  </Link>{' '}
                  as Claude: subscription.
                </p>
              )}
              {load.view.state === 'failed' && (
                <Alert variant="error" data-testid="sign-in-failed">
                  The sign-in did not finish{load.view.reason ? `: ${load.view.reason}` : ''}. Nothing was run. Apply the label on the issue again to start a new sign-in.
                </Alert>
              )}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

const STATE: Record<ClaudeSignInView['state'], { label: string; tone: 'success' | 'warning' | 'neutral' | 'error' }> = {
  starting: { label: 'Starting', tone: 'neutral' },
  waiting: { label: 'Waiting for you', tone: 'warning' },
  code: { label: 'Finishing', tone: 'neutral' },
  exchanging: { label: 'Finishing', tone: 'neutral' },
  done: { label: 'Signed in', tone: 'success' },
  failed: { label: 'Did not finish', tone: 'error' },
};
