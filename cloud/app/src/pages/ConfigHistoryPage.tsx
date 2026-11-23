import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, EmptyState, Modal, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, ApiError, ConfigInvalidError, type ApiClient, type VersionSummary } from '../api/client';
import { hasChanges, lineDiff, type DiffLine } from '../lib/diff';

type HistoryApi = Pick<ApiClient, 'configVersions' | 'configVersion' | 'reactivateConfig'>;
type Load = { state: 'loading' } | { state: 'ok'; activeVersion: number | null; versions: VersionSummary[] } | { state: 'error'; message: string };
type FileDiff = { path: string; lines: DiffLine[]; status: 'added' | 'removed' | 'changed' | 'same' };
type Diff = { state: 'loading'; version: number } | { state: 'ok'; version: number; against: number | null; files: FileDiff[] } | { state: 'error'; version: number; message: string };

const when = (iso: string) => new Date(iso).toLocaleString();
const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong; try again.');

/** config.yaml first, then the prompts by name. */
const fileOrder = (a: string, b: string) => (a === 'config.yaml' ? -1 : b === 'config.yaml' ? 1 : a.localeCompare(b));

export function diffFiles(before: Record<string, string>, after: Record<string, string>): FileDiff[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(fileOrder);
  return paths.map((path) => {
    const lines = lineDiff(before[path] ?? '', after[path] ?? '');
    const status = !(path in before) ? 'added' : !(path in after) ? 'removed' : hasChanges(lines) ? 'changed' : 'same';
    return { path, lines, status };
  });
}

/** Every published version of a tenant's config: who published it and when, what changed, and re-activating it. */
export function ConfigHistoryPage({ api = defaultApi }: { api?: HistoryApi }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };
  const [diff, setDiff] = useState<Diff | null>(null);
  const [reactivating, setReactivating] = useState<{ version: number; confirmAutoMerge: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchList = useCallback(
    () =>
      api.configVersions(installationId).then(
        (out) => setLoad({ state: 'ok', ...out }),
        (err: unknown) => setLoad({ state: 'error', message: message(err) }),
      ),
    [api, installationId],
  );

  useEffect(() => {
    let live = true;
    if (!valid) return;
    api.configVersions(installationId).then(
      (out) => live && setLoad({ state: 'ok', ...out }),
      (err: unknown) => live && setLoad({ state: 'error', message: message(err) }),
    );
    return () => {
      live = false;
    };
  }, [api, installationId, valid]);

  async function showDiff(v: VersionSummary, versions: VersionSummary[]) {
    // The version before it, among the ones fully published.
    const previous = versions.filter((x) => x.version < v.version && x.status === 'ready').sort((a, b) => b.version - a.version)[0];
    setDiff({ state: 'loading', version: v.version });
    try {
      const [after, before] = await Promise.all([api.configVersion(installationId, v.version), previous ? api.configVersion(installationId, previous.version) : null]);
      setDiff({ state: 'ok', version: v.version, against: previous?.version ?? null, files: diffFiles(before?.files ?? {}, after.files) });
    } catch (err) {
      setDiff({ state: 'error', version: v.version, message: message(err) });
    }
  }

  async function reactivate(version: number, confirmAutoMerge: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      const out = await api.reactivateConfig(installationId, version, confirmAutoMerge ? { confirmAutoMerge: true } : {});
      setReactivating(null);
      setNotice(`Published a copy of version ${version} as version ${out.version}, now active.`);
      await fetchList();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'auto_merge_unconfirmed' && !confirmAutoMerge) {
        setReactivating({ version, confirmAutoMerge: err.message });
      } else {
        setReactivating(null);
        setActionError(err instanceof ConfigInvalidError ? `${err.message}: ${err.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}` : message(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link className="auth-link" to={`/installations/${installationId}/config`}>
        ← Configuration
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Version history</h1>
        <p className="text-muted-foreground">Re-activating a version publishes a copy. Running jobs keep the version they started with.</p>
      </header>
      {load.state === 'loading' && <Skeleton className="h-24" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="history-error">
          {load.message}
        </Alert>
      )}
      {notice && (
        <Alert variant="success" data-testid="history-notice">
          {notice}
        </Alert>
      )}
      {actionError && (
        <Alert variant="error" data-testid="history-action-error">
          {actionError}
        </Alert>
      )}

      {load.state === 'ok' && (
        <Card>
          <CardBody>
            {load.versions.length === 0 ? (
              <EmptyState title="Nothing published yet" description="Versions appear here once you publish the configuration." />
            ) : (
              <ul className="flex flex-col divide-y divide-border" data-testid="versions">
                {load.versions.map((v) => (
                  <li key={v.version} className="flex flex-col gap-3 py-3" data-testid={`version-${v.version}`}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="flex flex-col gap-1 text-sm">
                        <span className="flex flex-wrap items-center gap-2 font-medium">
                          Version {v.version}
                          {v.active && <StatusBadge tone="success">Active</StatusBadge>}
                          {v.status === 'pending' && <StatusBadge tone="warning">Not fully published</StatusBadge>}
                          {v.copiedFrom !== undefined && <StatusBadge tone="neutral">Copy of v{v.copiedFrom}</StatusBadge>}
                        </span>
                        <span className="text-muted-foreground">
                          {v.publishedBy} · {when(v.publishedAt)}
                        </span>
                      </span>
                      <span className="flex gap-2">
                        {v.status === 'ready' && (
                          <Button variant="ghost" size="sm" type="button" aria-label={`Changes in version ${v.version}`} onClick={() => void showDiff(v, load.versions)}>
                            Changes
                          </Button>
                        )}
                        {v.status === 'ready' && !v.active && (
                          <Button variant="secondary" size="sm" type="button" disabled={busy} aria-label={`Re-activate version ${v.version}`} onClick={() => setReactivating({ version: v.version, confirmAutoMerge: null })}>
                            Re-activate
                          </Button>
                        )}
                      </span>
                    </div>
                    {diff?.version === v.version && <DiffView diff={diff} />}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <Modal open={reactivating !== null} onClose={() => setReactivating(null)} aria-label="Re-activate a version">
        <div className="flex flex-col gap-4 p-6">
          <h2 className="text-lg font-semibold">Re-activate version {reactivating?.version}?</h2>
          <p className="text-sm text-muted-foreground">
            This publishes a copy of version {reactivating?.version} as a new version, checked against today&apos;s rules, and makes it active. New jobs
            start with it.
          </p>
          {reactivating?.confirmAutoMerge && (
            <Alert variant="info" data-testid="reactivate-auto-merge">
              {reactivating.confirmAutoMerge}
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setReactivating(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={reactivating?.confirmAutoMerge ? 'warning' : 'primary'}
              loading={busy}
              onClick={() => reactivating && void reactivate(reactivating.version, reactivating.confirmAutoMerge !== null)}
            >
              {reactivating?.confirmAutoMerge ? 'I understand, re-activate with auto-merge' : 'Re-activate'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function DiffView({ diff }: { diff: Diff }) {
  if (diff.state === 'loading') return <Skeleton className="h-16" />;
  if (diff.state === 'error') return <Alert variant="error">{diff.message}</Alert>;
  const changed = diff.files.filter((f) => f.status !== 'same');
  return (
    <div className="flex flex-col gap-3" data-testid="version-diff">
      <p className="text-sm text-muted-foreground">{diff.against === null ? 'The first version: everything in it is new.' : `Compared with version ${diff.against}.`}</p>
      {changed.length === 0 && <p className="text-sm">No changes in what jobs run.</p>}
      {changed.map((f) => (
        <div key={f.path} className="overflow-hidden rounded-lg border border-border">
          <p className="border-b border-border px-3 py-1 font-mono text-xs font-medium">
            {f.path} <span className="text-muted-foreground">({f.status})</span>
          </p>
          <pre className="max-h-96 overflow-auto p-3 font-mono text-xs" aria-label={`Changes to ${f.path}`}>
            {f.lines.map((l, i) => (
              <div key={i} className={l.kind === 'add' ? 'bg-success/10 text-success' : l.kind === 'del' ? 'bg-error/10 text-error' : 'text-muted-foreground'}>
                {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
                {l.text}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
