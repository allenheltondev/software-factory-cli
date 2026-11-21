import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardDescription, CardHeader, CardTitle, PasswordInput, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, type AgentKeysView, type AgentKeyView, type ApiClient } from '../api/client';
import { relativeTime } from '../lib/time';

type Load = { state: 'loading' } | { state: 'ok'; view: AgentKeysView } | { state: 'error'; message: string };
type Api = Pick<ApiClient, 'agentKeys' | 'setAgentKey'>;

interface Provider {
  agent: string;
  company: string;
  placeholder: string;
  getKeyUrl: string;
  /** Says what is wrong with what was typed, before anything is sent; null when it looks right. The server decides for real. */
  problem: (value: string) => string | null;
}

const PROVIDERS: Record<string, Provider> = {
  ANTHROPIC_API_KEY: {
    agent: 'Claude',
    company: 'Anthropic',
    placeholder: 'sk-ant-…',
    getKeyUrl: 'https://console.anthropic.com/settings/keys',
    problem: (v) => (v.startsWith('sk-ant-') ? null : v.startsWith('sk-') ? 'That looks like an OpenAI key. Anthropic keys start with sk-ant-.' : 'Anthropic keys start with sk-ant-.'),
  },
  CODEX_API_KEY: {
    agent: 'Codex',
    company: 'OpenAI',
    placeholder: 'sk-…',
    getKeyUrl: 'https://platform.openai.com/api-keys',
    problem: (v) => (v.startsWith('sk-ant-') ? 'That looks like an Anthropic key. Paste it under Claude instead.' : v.startsWith('sk-') ? null : 'OpenAI keys start with sk-.'),
  },
};

const exact = (iso: string) => new Date(iso).toLocaleString();

/**
 * A tenant's agent keys: bring your own (#64).
 *
 * The page is built around three questions: do I need this key (a Required badge, from the active
 * config), is it working (when it was rotated, whether the last job that used it worked), and what
 * do I do about it (paste, rotate, or follow the link to get one). A value is typed in, sent once
 * and never shown again: no request returns one. Whatever is wrong is said next to the field.
 */
export function AgentKeysPage({ api = defaultApi }: { api?: Api }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };

  useEffect(() => {
    let live = true;
    if (!valid) return;
    api.agentKeys(installationId).then(
      (view) => live && setLoad({ state: 'ok', view }),
      (err: unknown) => live && setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Could not load the keys.' }),
    );
    return () => {
      live = false;
    };
  }, [api, installationId, valid]);

  const missingRequired = load.state === 'ok' ? load.view.keys.filter((k) => k.required && !k.configured) : [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link className="auth-link" to={`/installations/${id}`}>
        ← Installation
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Agent keys</h1>
        <p>
          Updraft runs its coding agents with <strong>your own API keys</strong>, so the usage is on your account. Add the key for each agent you use; a job that needs a key
          you have not added will not start.
        </p>
      </header>

      {load.state === 'loading' && <Skeleton className="h-40" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="keys-error">
          {load.message}
        </Alert>
      )}

      {load.state === 'ok' && (
        <>
          {missingRequired.length > 0 && (
            <Alert variant="info" data-testid="keys-needed">
              Add your {missingRequired.map((k) => PROVIDERS[k.name]?.company ?? k.name).join(' and ')} key to start running jobs: your configuration uses{' '}
              {missingRequired.length > 1 ? 'those agents' : 'that agent'}.
            </Alert>
          )}
          <div className="flex flex-col gap-4" data-testid="agent-keys">
            {load.view.keys.map((k) => (
              <KeyCard key={k.name} keyView={k} installationId={installationId} api={api} onSaved={(view) => setLoad({ state: 'ok', view })} />
            ))}
          </div>
          <p className="text-sm" data-testid="keys-privacy">
            🔒 Keys are write-only. Once saved, a key is never shown again, not even to you; it is stored encrypted and read only by your own jobs, and is removed when you
            uninstall the App.
          </p>
          {load.view.refusals.length > 0 && (
            <details className="rounded-lg border border-border p-4" data-testid="refusals" open={missingRequired.length > 0}>
              <summary className="cursor-pointer font-medium">Recently not started ({load.view.refusals.length})</summary>
              <ul className="mt-3 flex flex-col gap-2 text-sm">
                {load.view.refusals.map((r) => (
                  <li key={`${r.at}-${r.deliveryId}`}>
                    <span title={exact(r.at)}>{relativeTime(r.at)}</span> · {r.repository}#{r.issue}: {r.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm">After you add the key, apply the label to the issue again to start it.</p>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function KeyCard({ keyView: k, installationId, api, onSaved }: { keyView: AgentKeyView; installationId: number; api: Api; onSaved: (view: AgentKeysView) => void }) {
  const provider = PROVIDERS[k.name] ?? { agent: k.name, company: k.name, placeholder: '', getKeyUrl: '', problem: () => null };
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const typed = value.trim();
  const problem = typed ? provider.problem(typed) : null;
  const showForm = !k.configured || editing;

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!typed || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.setAgentKey(installationId, k.name, typed);
      // Gone from the page the moment it is saved.
      setValue('');
      setEditing(false);
      setSavedAt(Date.now());
      onSaved(view);
    } catch (err) {
      // The typed value stays, so a typo or a transient failure is fixed in place, not retyped.
      setError(err instanceof Error ? err.message : 'Could not save the key. Try again.');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid={`key-${k.name}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {provider.agent}
          <StatusBadge tone={k.configured ? 'success' : k.required ? 'warning' : 'neutral'}>{k.configured ? 'Configured' : 'Not set'}</StatusBadge>
          <StatusBadge tone="neutral">{k.required ? 'Required by your configuration' : 'Optional'}</StatusBadge>
        </CardTitle>
        <CardDescription>
          {provider.company} API key · <code>{k.name}</code>
        </CardDescription>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-4">
          {k.configured && (
            <div className="flex flex-col gap-1 text-sm">
              <p>
                Last rotated <span title={exact(k.lastRotatedAt!)}>{relativeTime(k.lastRotatedAt!)}</span>
                {k.lastRotatedBy ? ` by ${k.lastRotatedBy}` : ''}.
              </p>
              {k.lastUsed ? (
                <p className="flex flex-wrap items-center gap-2">
                  Last used <span title={exact(k.lastUsed.at)}>{relativeTime(k.lastUsed.at)}</span>
                  <StatusBadge tone={k.lastUsed.ok ? 'success' : 'error'}>{k.lastUsed.ok ? 'Worked' : 'Failed'}</StatusBadge>
                </p>
              ) : (
                <p>No job has used it yet.</p>
              )}
              {k.lastUsed && !k.lastUsed.ok && (
                <p data-testid={`key-failed-${k.name}`}>
                  The last job that used this key failed. That is often not the key, but if you revoked it or it ran out of credit, rotate it below.
                </p>
              )}
            </div>
          )}

          {savedAt !== null && !showForm && (
            <p role="status" className="text-sm font-medium" data-testid={`key-saved-${k.name}`}>
              ✓ {provider.company} accepted the key. Your next job will use it.
            </p>
          )}

          {showForm ? (
            <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} noValidate>
              <PasswordInput
                ref={input}
                label={k.configured ? 'New key' : `${provider.company} API key`}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={provider.placeholder}
                value={value}
                disabled={busy}
                {...(problem ? { error: problem } : { hint: 'Pasted, checked with the provider, then never shown again.' })}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
              />
              {error && (
                <Alert variant="error" data-testid="keys-save-error">
                  {error}
                </Alert>
              )}
              <p role="status" className="text-sm" aria-live="polite">
                {busy ? `Checking the key with ${provider.company}…` : ''}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={busy} disabled={!typed || !!problem}>
                  {k.configured ? 'Check and replace' : 'Check and save'}
                </Button>
                {k.configured && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setValue('');
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                )}
                {provider.getKeyUrl && (
                  <a className="auth-link text-sm" href={provider.getKeyUrl} target="_blank" rel="noreferrer">
                    Get a {provider.company} key ↗
                  </a>
                )}
              </div>
            </form>
          ) : (
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  setSavedAt(null);
                  setEditing(true);
                }}
              >
                Rotate key
              </Button>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
