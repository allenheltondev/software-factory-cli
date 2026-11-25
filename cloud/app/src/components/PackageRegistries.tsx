import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Skeleton } from '@readysetcloud/ui';
import { ApiError, type ApiClient, type PackageRegistriesView } from '../api/client';

export type PackageRegistriesApi = Pick<ApiClient, 'packageRegistries' | 'setPackageRegistries'>;

const message = (error: unknown) =>
  error instanceof ApiError ? error.message : 'The package registries could not be loaded. Try again.';

/** One host per line; blank lines and surrounding spaces are ignored. */
const linesOf = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/**
 * Extra package registries for Claude subscription jobs (#157). The server checks every host and
 * owns the rules; this only edits the list. Members see it; owners change it.
 */
export function PackageRegistries({ api, installationId }: { api: PackageRegistriesApi; installationId: number }) {
  const [view, setView] = useState<PackageRegistriesView>();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.packageRegistries(installationId).then(
      (loaded) => { if (live) { setView(loaded); setText(loaded.hosts.join('\n')); } },
      (failure: unknown) => { if (live) setError(message(failure)); },
    );
    return () => { live = false; };
  }, [api, installationId]);

  async function save() {
    if (!view) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await api.setPackageRegistries(installationId, linesOf(text), view.version);
      setView(next);
      setText(next.hosts.join('\n'));
      setSaved(true);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  const changed = view !== undefined && linesOf(text).join('\n') !== view.hosts.join('\n');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Package registries</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm">
          Commands in subscription jobs reach the public package registries below through the worker&apos;s egress
          proxy, and nothing else. Add a private registry or mirror your repositories install from: one host per line,
          such as <code>npm.pkg.github.com</code>, or <code>*.artifacts.example.com</code> for the names below it.
          Changes apply from the next job.
        </p>
        <p className="text-sm">
          A listed host is reachable for uploads as well as downloads, so list only hosts you trust with repository
          content. Hosts that resolve to private or internal addresses stay unreachable. Registry credentials are not
          supported yet.
        </p>
        {error && <Alert variant="error">{error}</Alert>}
        {view?.problem && <Alert variant="error">{view.problem}</Alert>}
        {saved && !error && <Alert variant="success">Saved. The next subscription job uses this list.</Alert>}
        {!view && !error && <Skeleton className="h-24" />}
        {view && (
          <>
            <label className="block text-sm">
              <span className="block font-medium">Extra registry hosts (at most {view.max})</span>
              <textarea
                className="mt-1 w-full rounded border p-2 font-mono text-sm"
                rows={4}
                value={text}
                readOnly={!view.canEdit}
                disabled={busy}
                spellCheck={false}
                aria-describedby="registry-defaults"
                onChange={(event) => { setText(event.target.value); setSaved(false); }}
              />
            </label>
            {!view.canEdit && <p className="text-sm">Only an installation owner can change this list.</p>}
            <details id="registry-defaults" className="text-sm">
              <summary>Always allowed ({view.defaults.length} public registries)</summary>
              <p className="mt-1 font-mono">{view.defaults.join(', ')}</p>
            </details>
            {view.canEdit && (
              <div>
                <Button type="button" variant="secondary" disabled={busy || (!changed && !view.problem)} onClick={() => void save()}>
                  Save registries
                </Button>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
