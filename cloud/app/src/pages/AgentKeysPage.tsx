import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardDescription, CardHeader, CardTitle, Input, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, type AgentKeysView, type ApiClient } from '../api/client';

type Load = { state: 'loading' } | { state: 'ok'; view: AgentKeysView } | { state: 'error'; message: string };

const LABELS: Record<string, string> = { ANTHROPIC_API_KEY: 'Anthropic (Claude)', CODEX_API_KEY: 'OpenAI (Codex)' };
const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * A tenant's agent keys: bring your own (#64). Each shows whether it is set, when it was last
 * rotated and whether the last job that used it worked. A value is typed in, sent once and never
 * shown again: no request returns one.
 */
export function AgentKeysPage({ api = defaultApi }: { api?: Pick<ApiClient, 'agentKeys' | 'setAgentKey'> }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

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

  async function save(e: FormEvent, name: string) {
    e.preventDefault();
    setBusy(name);
    setError(null);
    setSaved(null);
    try {
      const view = await api.setAgentKey(installationId, name, values[name]!.trim());
      setLoad({ state: 'ok', view });
      setSaved(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key.');
    } finally {
      // Whatever happened, the typed value does not stay in the page.
      setValues((prev) => ({ ...prev, [name]: '' }));
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link className="auth-link" to={`/installations/${id}`}>
        ← Installation
      </Link>
      {load.state === 'loading' && <Skeleton className="h-24" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="keys-error">
          {load.message}
        </Alert>
      )}
      {load.state === 'ok' && (
        <>
          <Card data-testid="agent-keys">
            <CardHeader>
              <CardTitle>Agent keys</CardTitle>
              <CardDescription>
                Jobs run the agents with your own API keys. A key is checked with the provider when you save it, then stored where only your jobs can read it. It is never shown again; to change it, enter a new one.
              </CardDescription>
            </CardHeader>
            <CardBody>
              {error && (
                <Alert variant="error" data-testid="keys-save-error">
                  {error}
                </Alert>
              )}
              <ul className="flex flex-col divide-y divide-border">
                {load.view.keys.map((k) => (
                  <li key={k.name} className="flex flex-col gap-3 py-4" data-testid={`key-${k.name}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{LABELS[k.name] ?? k.name}</span>
                      <code className="text-sm">{k.name}</code>
                      <StatusBadge tone={k.configured ? 'success' : 'neutral'}>{k.configured ? 'Configured' : 'Not set'}</StatusBadge>
                      {saved === k.name && <span className="text-sm">Saved.</span>}
                    </div>
                    {k.configured && (
                      <p className="text-sm">
                        Last rotated {when(k.lastRotatedAt!)}
                        {k.lastRotatedBy ? ` by ${k.lastRotatedBy}` : ''}.{' '}
                        {k.lastUsed ? (
                          <>
                            Last used {when(k.lastUsed.at)}: <StatusBadge tone={k.lastUsed.ok ? 'success' : 'error'}>{k.lastUsed.ok ? 'OK' : 'Failed'}</StatusBadge>
                          </>
                        ) : (
                          'Not used by a job yet.'
                        )}
                      </p>
                    )}
                    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => void save(e, k.name)}>
                      <Input
                        label={k.configured ? 'Replace the key' : 'Key'}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={values[k.name] ?? ''}
                        onChange={(e) => setValues((prev) => ({ ...prev, [k.name]: e.target.value }))}
                      />
                      <Button type="submit" loading={busy === k.name} disabled={busy !== null || !(values[k.name] ?? '').trim()}>
                        {k.configured ? 'Rotate' : 'Save'}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          {load.view.refusals.length > 0 && (
            <Card data-testid="refusals">
              <CardHeader>
                <CardTitle>Recently refused</CardTitle>
                <CardDescription>Labeled issues Updraft did not start, and why.</CardDescription>
              </CardHeader>
              <CardBody>
                <ul className="flex flex-col gap-2 text-sm">
                  {load.view.refusals.map((r) => (
                    <li key={`${r.at}-${r.deliveryId}`}>
                      {when(r.at)} · {r.repository}#{r.issue}: {r.reason}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
