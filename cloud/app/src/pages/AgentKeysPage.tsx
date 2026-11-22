import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, PasswordInput, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, type AgentKeysView, type AgentKeyView, type ApiClient } from '../api/client';
import { relativeTime } from '../lib/time';

type Load = { state: 'loading' } | { state: 'ok'; view: AgentKeysView } | { state: 'error'; message: string };
type Api = Pick<ApiClient, 'agentKeys' | 'setAgentKey'>;

export interface Provider {
  agent: string;
  company: string;
  placeholder: string;
  getKeyUrl: string;
  /** How to get a key, step by step; the last step is always pasting it here. */
  steps: ReactNode[];
  /** The provider can be asked whether a key works before it is saved. Kiro cannot: its first job tells. */
  checkedOnSave: boolean;
  /** Says what is wrong with what was typed, before anything is sent; null when it looks right. The server decides for real. */
  problem: (value: string) => string | null;
}

const external = (href: string, text: string) => (
  <a className="auth-link" href={href} target="_blank" rel="noreferrer">
    {text} ↗
  </a>
);

export const PROVIDERS: Record<string, Provider> = {
  ANTHROPIC_API_KEY: {
    agent: 'Claude',
    company: 'Anthropic',
    placeholder: 'sk-ant-…',
    getKeyUrl: 'https://console.anthropic.com/settings/keys',
    steps: [
      <>Open {external('https://console.anthropic.com/settings/keys', 'API keys in the Anthropic Console')}.</>,
      <>
        Choose <strong>Create key</strong>, name it <strong>Updraft</strong>, and copy it.
      </>,
    ],
    checkedOnSave: true,
    problem: (v) => (v.startsWith('sk-ant-') ? null : v.startsWith('sk-') ? 'That looks like an OpenAI key. Anthropic keys start with sk-ant-.' : 'Anthropic keys start with sk-ant-.'),
  },
  CODEX_API_KEY: {
    agent: 'Codex',
    company: 'OpenAI',
    placeholder: 'sk-…',
    getKeyUrl: 'https://platform.openai.com/api-keys',
    steps: [
      <>Open {external('https://platform.openai.com/api-keys', 'API keys on the OpenAI platform')}.</>,
      <>
        Choose <strong>Create new secret key</strong>, name it <strong>Updraft</strong>, and copy it.
      </>,
    ],
    checkedOnSave: true,
    problem: (v) => (v.startsWith('sk-ant-') ? 'That looks like an Anthropic key. Paste it under Claude instead.' : v.startsWith('sk-') ? null : 'OpenAI keys start with sk-.'),
  },
  KIRO_API_KEY: {
    agent: 'Kiro',
    company: 'Kiro',
    placeholder: 'Your Kiro API key',
    getKeyUrl: 'https://kiro.dev/docs/cli/headless/',
    steps: [
      <>
        Sign in to Kiro, open <strong>Account</strong>, then <strong>API keys</strong> ({external('https://kiro.dev/docs/cli/headless/', 'how')}). API keys need a Kiro Pro plan or
        above.
      </>,
      <>
        Your organization signs in to Kiro through IAM Identity Center? An administrator turns on API keys first, in the AWS console under <strong>Kiro</strong>, then{' '}
        <strong>Settings</strong>.
      </>,
      <>
        Choose <strong>Create</strong>, name it <strong>Updraft</strong>, and copy it.
      </>,
    ],
    checkedOnSave: false,
    problem: (v) =>
      v.startsWith('sk-ant-') ? 'That looks like an Anthropic key. Paste it under Claude instead.' : v.startsWith('sk-') ? 'That looks like an OpenAI key. Paste it under Codex instead.' : /\s/.test(v) ? 'A Kiro key has no spaces.' : v.length < 20 ? 'That is too short to be a Kiro key.' : null,
  },
};

const exact = (iso: string) => new Date(iso).toLocaleString();
const providerOf = (k: AgentKeyView): Provider => PROVIDERS[k.name] ?? { agent: k.name, company: k.name, placeholder: '', getKeyUrl: '', steps: [], checkedOnSave: true, problem: () => null };

/**
 * A tenant's agent keys: bring your own (#64).
 *
 * Built for getting set up in a minute: the agents the configuration runs come first, each with
 * the steps to get its key and a field to paste it into, checked as it is typed and again with
 * the provider. Agents the configuration does not use wait under "Other agents". Once a key is
 * set, its card says whether it works (when it was rotated, how the last job that used it went).
 * A value is typed in, sent once and never shown again: no request returns one.
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

  const keys = load.state === 'ok' ? load.view.keys : [];
  const missingRequired = keys.filter((k) => k.required && !k.configured);
  // What to do first: the keys the configuration needs, then any key already set; the rest is optional.
  const primary = keys.filter((k) => k.required || k.configured).sort((a, b) => Number(b.required) - Number(a.required));
  const others = keys.filter((k) => !k.required && !k.configured);
  const onSaved = (view: AgentKeysView) => setLoad({ state: 'ok', view });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link className="auth-link" to={`/installations/${id}`}>
        ← Installation
      </Link>
      <h1 className="text-2xl font-semibold">Agent keys</h1>

      {load.state === 'loading' && <Skeleton className="h-40" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="keys-error">
          {load.message}
        </Alert>
      )}

      {load.state === 'ok' && (
        <>
          {missingRequired.length > 0 ? (
            <Alert variant="info" data-testid="keys-needed">
              Add your {missingRequired.map((k) => providerOf(k).company).join(' and ')} {missingRequired.length > 1 ? 'keys' : 'key'} to start running jobs: your configuration uses{' '}
              {missingRequired.length > 1 ? 'those agents' : 'that agent'}.
            </Alert>
          ) : (
            primary.length > 0 &&
            primary.every((k) => k.configured) && (
              <p role="status" className="font-medium" data-testid="keys-ready">
                ✓ Every agent your configuration runs has its key.
              </p>
            )
          )}
          {primary.length === 0 && (
            <p data-testid="keys-start">
              Your jobs run on <strong>your own API keys</strong>, so the usage is on your account. Add the key of each agent you will use.
            </p>
          )}
          <div className="flex flex-col gap-4" data-testid="agent-keys">
            {primary.map((k) => (
              <KeyCard key={k.name} keyView={k} installationId={installationId} api={api} onSaved={onSaved} />
            ))}
            {others.length > 0 &&
              (primary.length === 0 ? (
                others.map((k) => <KeyCard key={k.name} keyView={k} installationId={installationId} api={api} onSaved={onSaved} />)
              ) : (
                <details className="rounded-lg border border-border p-4" data-testid="other-agents">
                  <summary className="cursor-pointer font-medium">Other agents ({others.map((k) => providerOf(k).agent).join(', ')})</summary>
                  <div className="mt-4 flex flex-col gap-4">
                    {others.map((k) => (
                      <KeyCard key={k.name} keyView={k} installationId={installationId} api={api} onSaved={onSaved} />
                    ))}
                  </div>
                </details>
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
  const provider = providerOf(k);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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
      setSaved(true);
      onSaved(view);
    } catch (err) {
      // The typed value stays, so a typo or a transient failure is fixed in place, not retyped.
      setError(err instanceof Error ? err.message : 'Could not save the key. Try again.');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const state = k.configured
    ? k.lastUsed && !k.lastUsed.ok
      ? { label: 'Last job failed', tone: 'warning' as const }
      : { label: k.lastUsed ? 'Working' : 'Saved', tone: 'success' as const }
    : { label: 'Not set', tone: k.required ? ('warning' as const) : ('neutral' as const) };

  return (
    <Card data-testid={`key-${k.name}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {provider.agent}
          <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
          {k.required && <StatusBadge tone="neutral">Used by your configuration</StatusBadge>}
        </CardTitle>
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
                <p>
                  Last used <span title={exact(k.lastUsed.at)}>{relativeTime(k.lastUsed.at)}</span>.
                </p>
              ) : (
                <p>{provider.checkedOnSave ? 'No job has used it yet.' : `No job has used it yet. ${provider.company} has no way to check a key ahead of time, so the first job is the check.`}</p>
              )}
              {k.lastUsed && !k.lastUsed.ok && (
                <p data-testid={`key-failed-${k.name}`}>
                  The last job that used this key failed. That is often not the key, but if you revoked it or it ran out of credit, rotate it below.
                </p>
              )}
            </div>
          )}

          {saved && !showForm && (
            <p role="status" className="text-sm font-medium" data-testid={`key-saved-${k.name}`}>
              {provider.checkedOnSave ? `✓ ${provider.company} accepted the key. Your next job will use it.` : `✓ Saved. Your next ${provider.agent} job will use it, and this card will say how it went.`}
            </p>
          )}

          {showForm ? (
            <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} noValidate>
              {!k.configured && provider.steps.length > 0 && (
                <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm" data-testid={`key-steps-${k.name}`}>
                  {provider.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                  <li>Paste it here.</li>
                </ol>
              )}
              <PasswordInput
                ref={input}
                label={k.configured ? 'New key' : `${provider.company} API key`}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={provider.placeholder}
                value={value}
                disabled={busy}
                {...(problem ? { error: problem } : { hint: provider.checkedOnSave ? `Checked with ${provider.company}, then never shown again.` : 'Saved, then never shown again.' })}
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
                {busy ? (provider.checkedOnSave ? `Checking the key with ${provider.company}…` : 'Saving…') : ''}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={busy} disabled={!typed || !!problem}>
                  {provider.checkedOnSave ? (k.configured ? 'Check and replace' : 'Check and save') : k.configured ? 'Replace' : 'Save'}
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
                {k.configured && provider.getKeyUrl && (
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
                  setSaved(false);
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
