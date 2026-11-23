import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Input, Skeleton } from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type RoutineRule, type Repository } from '../api/client';

type Api = Pick<ApiClient, 'routines' | 'repositories' | 'setRoutine' | 'removeRoutine'>;
type Load = { state: 'loading' } | { state: 'ok'; rules: RoutineRule[]; repos: Repository[] } | { state: 'error'; message: string };

/** A label routes to an Anthropic-hosted scheduled task, with no Claude.ai session login. */
export function RoutinesPage({ api = defaultApi }: { api?: Api }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [repositoryId, setRepositoryId] = useState('');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!valid) { setLoad({ state: 'error', message: 'Invalid installation' }); return; }
    let live = true;
    void Promise.all([api.routines(installationId), api.repositories(installationId)]).then(
      ([routines, repos]) => {
        if (!live) return;
        setLoad({ state: 'ok', rules: routines.rules, repos: repos.repositories });
      },
      (err: unknown) => live && setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Could not load routines' }),
    );
    return () => { live = false; };
  }, [api, installationId, valid]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (load.state !== 'ok' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.setRoutine(installationId, { repositoryId: Number(repositoryId), label, url: url.trim(), token: token.trim() });
      setLoad({ ...load, rules: result.rules });
      setToken('');
      setLabel('');
      setUrl('');
      setRepositoryId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save routine route');
    } finally { setBusy(false); }
  }

  async function remove(ruleId: string) {
    if (load.state !== 'ok' || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.removeRoutine(installationId, ruleId);
      setLoad({ ...load, rules: result.rules });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not remove routine route'); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link to={`/installations/${id}`} className="auth-link">← Installation</Link>
      <h1 className="text-2xl font-semibold">Claude Code scheduled tasks</h1>
      <p>
        Route a GitHub issue label to an Anthropic-hosted scheduled task (formerly a routine).
        This uses the task's dedicated API trigger token, not your Claude login or an Anthropic API key.
        Matching labels run on Anthropic rather than an Updraft microVM; other labels keep their Updraft configuration.
      </p>
      <p className="text-sm">
        First create a task with a repository, prompt, and API trigger at{' '}
        <a className="auth-link" href="https://claude.ai/code/routines" target="_blank" rel="noreferrer">Claude Code</a>.
        Copy the full trigger URL and its one-time token.{' '}
        <a className="auth-link" href="https://code.claude.com/docs/en/routines#add-an-api-trigger" target="_blank" rel="noreferrer">Setup instructions</a>.
      </p>
      {load.state === 'loading' && <Skeleton className="h-32" />}
      {load.state === 'error' && <Alert variant="error">{load.message}</Alert>}
      {load.state === 'ok' && (
        <>
          <Card>
            <CardHeader><CardTitle>Configured routes ({load.rules.length})</CardTitle></CardHeader>
            <CardBody>
              {load.rules.length === 0 ? <p>No routine routes yet.</p> : (
                <ul className="flex flex-col gap-3">
                  {load.rules.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                      <div className="min-w-0">
                        <div className="font-medium">{r.repository} · {r.label}</div>
                        <div className="break-all text-xs text-muted-foreground">{r.url}</div>
                      </div>
                      <Button variant="outline" disabled={busy} onClick={() => void remove(r.id)}>Remove</Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader><CardTitle>Add or replace a route</CardTitle></CardHeader>
            <CardBody>
              <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm">
                  GitHub repository
                  <select className="rounded-md border border-border bg-background p-2" value={repositoryId}
                    onChange={(e) => setRepositoryId(e.target.value)} required>
                    <option value="">Choose a repository</option>
                    {load.repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                  </select>
                </label>
                <Input label="Issue label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="agent" required />
                <Input label="API trigger URL" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_.../fire" required />
                <Input label="Routine API trigger token" type="password" value={token} onChange={(e) => setToken(e.target.value)}
                  autoComplete="off" placeholder="sk-ant-oat01-..." required />
                {error && <Alert variant="error">{error}</Alert>}
                <p className="text-sm text-muted-foreground">
                  The token is saved write-only in Secrets Manager. An API trigger can start only its configured task;
                  it cannot read your Claude account. A GitHub issue labeled with this label starts a new task run.
                </p>
                <div><Button type="submit" loading={busy} disabled={!repositoryId || !label.trim() || !url.trim() || !token.trim()}>Save route</Button></div>
              </form>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
