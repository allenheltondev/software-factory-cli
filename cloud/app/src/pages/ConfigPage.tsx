import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Modal, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, ApiError, ConfigInvalidError, type ApiClient, type ConfigIssue, type ConfigView, type ConsoleConfig } from '../api/client';
import { tenantStatusLabel } from './GitHubSettingsPage';
import { ConfigEditor } from './config/Editor';
import { AGENT_LABEL, KEY_FOR, keysNeeded, sectionOf, type Section } from './config/model';
import { isSimple, SimpleConfig, simpleBlockers } from './config/Simple';

export { issuesAt, parseLogins } from './config/model';

type ConfigApi = Pick<ApiClient, 'config' | 'previewConfig' | 'publishConfig' | 'setAgentKey'>;
type Load = { state: 'loading' } | { state: 'ok'; view: ConfigView } | { state: 'error'; message: string };
type Busy = 'preview' | 'publish' | null;

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong; try again.');
const SECTION_NAME: Record<Section, string> = { repositories: 'Repositories', workflows: 'Workflows', agents: 'Agents and pools' };

/**
 * A tenant's configuration: one short page (the label, the repositories, coding agents and
 * review agents) for the first setup and every change after, and the full editor (workflows,
 * named pools, agents) for configurations that need more. A publish bar says what is unsaved,
 * what still blocks a publish, and what the server refused, and where.
 */
export function ConfigPage({ api = defaultApi }: { api?: ConfigApi }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };
  const [config, setConfig] = useState<ConsoleConfig | null>(null);
  /** The draft as last loaded or published: what "unsaved changes" compares with. */
  const [saved, setSaved] = useState<string>('');
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [mode, setMode] = useState<'simple' | 'full'>('simple');
  /** Published from nothing here: the repositories and label to try first. */
  const [firstPublish, setFirstPublish] = useState<{ label: string; repositories: string[] } | null>(null);
  const [section, setSection] = useState<Section>('repositories');
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<ConfigIssue[]>([]);
  const [warnings, setWarnings] = useState<ConfigIssue[]>([]);
  const [yaml, setYaml] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Repositories whose auto-merge was turned on here, each after its confirmation. */
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The server asked for the confirmation (auto_merge_unconfirmed): its message. */
  const [serverConfirm, setServerConfirm] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const show = useCallback((view: ConfigView) => {
    setLoad({ state: 'ok', view });
    setConfig(view.config);
    setSaved(JSON.stringify(view.config));
    setActiveVersion(view.activeVersion);
    setMode(isSimple(view.config) ? 'simple' : 'full');
    setFirstPublish(null);
    setErrors([]);
    setWarnings([]);
    setYaml(null);
    setConfirmed(new Set());
    setGeneration((g) => g + 1);
  }, []);

  const setKeys = useCallback((agentKeys: Record<string, boolean>) => setLoad((prev) => (prev.state === 'ok' ? { state: 'ok', view: { ...prev.view, agentKeys: { ...prev.view.agentKeys, ...agentKeys } } } : prev)), []);

  // Back from adding a key on the Agent keys page in another tab: refresh which keys are set, and leave the draft alone.
  useEffect(() => {
    if (!valid) return;
    let live = true;
    let latest = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      // Only the newest request may write: a slower, older answer must not undo a newer one.
      const mine = ++latest;
      api.config(installationId).then(
        (fresh) => live && mine === latest && setKeys(fresh.agentKeys),
        () => undefined,
      );
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [api, installationId, valid, setKeys]);

  useEffect(() => {
    let live = true;
    if (!valid) return;
    api.config(installationId).then(
      (view) => live && show(view),
      (err: unknown) => live && setLoad({ state: 'error', message: message(err) }),
    );
    return () => {
      live = false;
    };
  }, [api, installationId, valid, show]);

  async function reload() {
    setConflict(null);
    setNotice(null);
    setActionError(null);
    try {
      show(await api.config(installationId));
    } catch (err) {
      setActionError(message(err));
    }
  }

  if (load.state !== 'ok' || !config) {
    return (
      <div className="flex flex-col gap-6">
        <Link className="auth-link" to={valid ? `/installations/${installationId}` : '/'}>
          ← Installation
        </Link>
        {load.state === 'loading' && <Skeleton className="h-24" />}
        {load.state === 'error' && (
          <Alert variant="error" data-testid="config-error">
            {load.message}
          </Alert>
        )}
      </div>
    );
  }

  const { view } = load;
  const readOnly = view.tenant.status !== 'active';
  const dirty = JSON.stringify(config) !== saved;
  const keys = keysNeeded(config, view.agentKeys);
  /** Agents that are on, in a pool an enabled repository runs, without their key. */
  const missingAgents = keys.agents.filter((a) => !view.agentKeys[KEY_FOR[config.agents[a]!.adapter]]);

  const edit = (next: ConsoleConfig) => {
    setConfig(next);
    setNotice(null);
  };
  const confirmAutoMerge = () => [...confirmed].some((r) => config.repositories[r]?.autoMerge !== undefined);

  async function preview() {
    setBusy('preview');
    setActionError(null);
    try {
      const out = await api.previewConfig(installationId, config!);
      setWarnings(out.warnings);
      if (out.ok) {
        setErrors([]);
        setYaml(out.yaml);
      } else {
        setErrors(out.errors);
        setYaml(null);
      }
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function publish(confirm = confirmAutoMerge()): Promise<number | null> {
    setBusy('publish');
    setActionError(null);
    setConflict(null);
    setNotice(null);
    try {
      const out = await api.publishConfig(installationId, { config: config!, baseVersion: activeVersion, ...(confirm ? { confirmAutoMerge: true } : {}) });
      if (activeVersion === null) {
        const w = Object.values(config!.workflows)[0];
        setFirstPublish({ label: w?.label ?? '', repositories: Object.keys(config!.repositories) });
      }
      setActiveVersion(out.version);
      setSaved(JSON.stringify(config));
      setErrors([]);
      setWarnings(out.warnings);
      if (yaml !== null) setYaml(out.yaml);
      setNotice(`Published version ${out.version}. New jobs start with it; running jobs keep the version they started with.`);
      return out.version;
    } catch (err) {
      if (err instanceof ConfigInvalidError) {
        setErrors(err.errors);
        setWarnings(err.warnings);
        setYaml(null);
        const first = err.errors[0];
        if (first) setSection(sectionOf(first.path));
      } else if (err instanceof ApiError && err.code === 'config_changed') setConflict(err.message);
      else if (err instanceof ApiError && err.code === 'auto_merge_unconfirmed') setServerConfirm(err.message);
      else setActionError(message(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const status = tenantStatusLabel(view.tenant);
  const shared = { config, onChange: edit, view, installationId, keyApi: api, onKeys: setKeys };
  const simple = mode === 'simple' && isSimple(config);
  const blockers = simple ? simpleBlockers(config, view) : [];

  return (
    <div className="flex flex-col gap-6" data-testid="config-page">
      <Link className="auth-link" to={`/installations/${installationId}`}>
        ← {view.tenant.accountLogin}
      </Link>
      <datalist id="effort-levels">
        <option value="low" />
        <option value="medium" />
        <option value="high" />
      </datalist>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
            {activeVersion === null ? 'Set up Updraft' : 'Configuration'}
            {view.tenant.status !== 'active' && <StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
          </h1>
          <p className="text-muted-foreground" data-testid="active-version">
            {view.tenant.accountLogin} · {activeVersion === null ? 'nothing published yet' : `version ${activeVersion} is active`}
          </p>
        </div>
        <span className="flex flex-wrap gap-4">
          <Link className="auth-link" to={`/installations/${installationId}/claude`}>Claude subscription routing</Link>
          {!simple && isSimple(config) && (
            <button type="button" className="auth-link" onClick={() => setMode('simple')}>
              Simple view
            </button>
          )}
          {activeVersion !== null && (
            <Link className="auth-link" to={`/installations/${installationId}/config/history`}>
              Version history
            </Link>
          )}
        </span>
      </header>

      {readOnly && (
        <Alert variant="info" data-testid="config-readonly">
          This installation is not active, so its configuration can be read but not published.
        </Alert>
      )}
      {view.source === 'tenant' && (
        <Alert variant="info" data-testid="config-tenant-source">
          Version {view.activeVersion} was published with tenant-admin. The editor starts from the defaults, and publishing from here replaces it.
        </Alert>
      )}
      {(view.notices ?? []).length > 0 && (
        <Alert variant="info" data-testid="config-notices">
          <p className="font-medium">These settings were made with an earlier version of this page. Check before you publish:</p>
          <ul className="mt-2 list-disc pl-5">
            {view.notices!.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Alert>
      )}
      {conflict && (
        <Alert variant="info" data-testid="config-conflict">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{conflict}</span>
            <Button variant="secondary" size="sm" type="button" onClick={() => void reload()}>
              Reload
            </Button>
          </div>
        </Alert>
      )}
      {actionError && (
        <Alert variant="error" data-testid="config-action-error">
          {actionError}
        </Alert>
      )}

      {simple ? (
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
          <SimpleConfig {...shared} errors={errors} generation={generation} onAskAutoMerge={setConfirming} onOpenFull={() => setMode('full')} />
        </fieldset>
      ) : (
        <>
          {missingAgents.length > 0 && (
            <Alert variant="info" data-testid="config-missing-keys">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {missingAgents.map((a) => `${a} (${AGENT_LABEL[config.agents[a]!.adapter]})`).join(', ')} {missingAgents.length > 1 ? 'need keys' : 'needs a key'} before you publish: add {missingAgents.length > 1 ? 'them' : 'it'}, or turn {missingAgents.length > 1 ? 'them' : 'it'} off.
                </span>
                <Button variant="secondary" size="sm" type="button" onClick={() => setSection('agents')}>
                  Go to agents
                </Button>
              </div>
            </Alert>
          )}
          <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
            <ConfigEditor {...shared} errors={errors} generation={generation} section={section} onSection={setSection} onAskAutoMerge={setConfirming} />
          </fieldset>
        </>
      )}

          {yaml !== null && (
            <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted p-4 font-mono text-xs" data-testid="config-yaml" aria-label="Generated config.yaml">
              {yaml}
            </pre>
          )}

          <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-border bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur" data-testid="publish-bar">
            {notice && (
              <Alert variant="success" data-testid="config-published">
                {notice}
                {firstPublish && (
                  <span className="mt-1 block" data-testid="first-publish">
                    Try it: add the label <code>{firstPublish.label}</code> to an issue in{' '}
                    {firstPublish.repositories.map((r, i) => (
                      <span key={r}>
                        {i > 0 && ', '}
                        <a className="auth-link font-semibold" href={`https://github.com/${r}/issues`} target="_blank" rel="noreferrer">
                          {r} ↗
                        </a>
                      </span>
                    ))}
                    .
                  </span>
                )}
              </Alert>
            )}

            {errors.length > 0 && (
              <Alert variant="error" data-testid="config-errors">
                <p className="font-medium">Nothing was published. Fix these first:</p>
                <ul className="mt-2 list-disc pl-5">
                  {errors.map((e, i) => (
                    <li key={i}>
                      {simple ? (
                        e.message
                      ) : (
                        <>
                          <button type="button" className="auth-link text-left" onClick={() => setSection(sectionOf(e.path))}>
                            {SECTION_NAME[sectionOf(e.path)]}
                          </button>
                          : <code>{e.path}</code>: {e.message}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {warnings.length > 0 && (
              <Alert variant="info" data-testid="config-warnings">
                <ul className="list-disc pl-5">
                  {warnings.map((w, i) => (
                    <li key={i}>
                      <code>{w.path}</code>: {w.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 text-sm">
                {/* What still blocks a publish says more than the state, so it takes its place. */}
                {blockers.length > 0 ? (
                  <span className="text-muted-foreground" data-testid="blockers">
                    To publish: {blockers.join(' ')}
                  </span>
                ) : (
                  <span data-testid="draft-state" className={dirty && activeVersion !== null ? 'font-medium' : 'text-muted-foreground'}>
                    {activeVersion === null ? 'Draft · no live version' : dirty ? `Unsaved changes · version ${activeVersion} is live` : `Version ${activeVersion} is active`}
                  </span>
                )}
              </span>
              <div className="flex shrink-0 justify-end gap-2">
                <Button variant="ghost" size="sm" type="button" loading={busy === 'preview'} disabled={busy !== null} onClick={() => (yaml !== null ? setYaml(null) : void preview())}>
                  {yaml !== null ? 'Hide config' : 'View config'}
                </Button>
                <Button type="button" loading={busy === 'publish'} disabled={busy !== null || readOnly || blockers.length > 0 || (!dirty && activeVersion !== null)} onClick={() => void publish()}>
                  Publish
                </Button>
              </div>
            </div>
          </div>

      <Modal open={confirming !== null} onClose={() => setConfirming(null)} aria-label="Turn on auto-merge">
        <div className="flex flex-col gap-4 p-6">
          <h2 className="text-lg font-semibold">Turn on auto-merge for {confirming}?</h2>
          <p className="text-sm text-muted-foreground">
            Updraft will merge a pull request it opened as soon as its own reviewer finds it ready and the checks pass, without a person approving the merge. It takes effect when you publish.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="warning"
              type="button"
              onClick={() => {
                const name = confirming;
                if (!name) return;
                edit({ ...config, repositories: { ...config.repositories, [name]: { ...config.repositories[name]!, autoMerge: { method: 'squash' } } } });
                setConfirmed((prev) => new Set(prev).add(name));
                setConfirming(null);
              }}
            >
              I understand, turn on auto-merge
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={serverConfirm !== null} onClose={() => setServerConfirm(null)} aria-label="Confirm auto-merge">
        <div className="flex flex-col gap-4 p-6">
          <h2 className="text-lg font-semibold">Confirm auto-merge</h2>
          <p className="text-sm text-muted-foreground">{serverConfirm}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setServerConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="warning"
              type="button"
              onClick={() => {
                setServerConfirm(null);
                void publish(true);
              }}
            >
              I understand, publish with auto-merge
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
