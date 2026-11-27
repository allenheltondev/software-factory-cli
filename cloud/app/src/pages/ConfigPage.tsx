import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Modal, Skeleton, StatusBadge } from '@readysetcloud/ui';
import { api as defaultApi, ApiError, ConfigInvalidError, type ApiClient, type ConfigIssue, type ConfigView, type ConsoleConfig } from '../api/client';
import { tenantStatusLabel } from './GitHubSettingsPage';
import { ConfigEditor } from './config/Editor';
import { AGENT_LABEL, KEY_FOR, keysNeeded, sectionOf, type Section } from './config/model';
import { useCodexAccount } from '../lib/codexAccount';
import { EffectiveConfig, isSimple, SimpleConfig, simpleBlockers } from './config/Simple';
import { customSettings, describeChanges, labelGroups, type KeyStatus } from './config/team';

export { issuesAt, parseLogins } from './config/model';

type ConfigApi = Pick<ApiClient, 'config' | 'previewConfig' | 'publishConfig' | 'setAgentKey'> & Partial<Pick<ApiClient, 'agentKeys' | 'nativeClaude' | 'nativeCodex'>>;
type Load = { state: 'loading' } | { state: 'ok'; view: ConfigView } | { state: 'error'; message: string };
type Busy = 'preview' | 'publish' | null;

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong; try again.');
const SECTION_NAME: Record<Section, string> = { repositories: 'Repositories', workflows: 'Workflows', agents: 'Agents and pools' };

/**
 * A tenant's configuration: one page (connect agents, the default team, labels and repositories
 * with their exceptions) for the first setup and every change after, and the full editor
 * (workflows, named pools, agent profiles) for configurations with custom settings, which still
 * get a readable summary. A publish bar says what publishing changes, what still blocks it, and
 * what the server refused, and where.
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
  /** Each key's status as the server reports it (set, and its last use); absent until read. */
  const [keyStatus, setKeyStatus] = useState<Record<string, KeyStatus>>({});

  const readKeyStatus = useCallback(() => {
    if (!valid || !api.agentKeys) return;
    // Only status: a failure here leaves the page as it is (the config's own key flags still say which are set).
    Promise.resolve(api.agentKeys(installationId))
      .then((v) => v && setKeyStatus(Object.fromEntries(v.keys.map((k) => [k.name, { configured: k.configured, ...(k.lastUsed ? { lastUsed: k.lastUsed } : {}) }]))))
      .catch(() => undefined);
  }, [api, installationId, valid]);
  useEffect(readKeyStatus, [readKeyStatus]);
  const codex = useCodexAccount(api, installationId, valid);

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
        {load.state === 'loading' && <ConfigSkeleton />}
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
        setFirstPublish({ label: labelGroups(config!)[0]?.label ?? '', repositories: Object.keys(config!.repositories) });
      }
      setActiveVersion(out.version);
      setSaved(JSON.stringify(config));
      setErrors([]);
      setWarnings(out.warnings);
      if (yaml !== null) setYaml(out.yaml);
      setNotice(`Published version ${out.version}. New jobs use it; running jobs finish on the version they started with.`);
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
  const onKeys = (keys: Record<string, boolean>) => {
    setKeys(keys);
    readKeyStatus();
  };
  const shared = { config, onChange: edit, view, installationId, keyApi: api, onKeys, codex };
  const custom = customSettings(config);
  const simple = mode === 'simple' && custom.length === 0;
  const blockers = simple ? simpleBlockers(config, view) : [];
  const changes = dirty && saved ? describeChanges(JSON.parse(saved) as ConsoleConfig, config) : [];
  /** Published, and nothing changed since: the button says so instead of looking broken. */
  const unchanged = !dirty && activeVersion !== null;
  /** After a publish: the label that starts work, as the next thing to try. */
  const nextLabel = labelGroups(config)[0]?.label;

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
          {/* On the simple page the Claude card has this link, beside the key it replaces. */}
          {!simple && <Link className="auth-link" to={`/installations/${installationId}/claude`}>Claude subscription routing</Link>}
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
          Version {view.activeVersion} was published with tenant-admin. The editor starts from the defaults, not from that config. Publishing from here replaces that config, including its tiers and anything else the console can't show. To change it and keep those, publish a new document with tenant-admin.
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
          <SimpleConfig {...shared} keyStatus={keyStatus} firstRun={activeVersion === null} errors={errors} generation={generation} onAskAutoMerge={setConfirming} onOpenFull={() => setMode('full')} />
        </fieldset>
      ) : (
        <>
          {custom.length > 0 && (
            <Alert variant="info" data-testid="config-custom">
              <p className="font-medium">These settings need the full editor. Nothing is changed or converted; edit them here, or anything else as before:</p>
              <ul className="mt-2 list-disc pl-5">
                {custom.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Alert>
          )}
          <EffectiveConfig config={config} />
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

          <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-border bg-background/95 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur sm:py-3" data-testid="publish-bar">
            {notice && (
              <Alert variant="success" data-testid="config-published" className="animate-slide-up">
                <span className="flex items-start gap-3">
                  <span aria-hidden="true" className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-600 text-sm font-bold text-white">
                    ✓
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-semibold">{firstPublish ? 'You’re live. ' : ''}{notice}</span>
                    {firstPublish ? (
                      <span data-testid="first-publish">
                        Try it: add the label <code>{firstPublish.label}</code> to an issue in{' '}
                        {firstPublish.repositories.map((r, i) => (
                          <span key={r}>
                            {i > 0 && ', '}
                            <a className="auth-link font-semibold" href={`https://github.com/${r}/issues`} target="_blank" rel="noreferrer">
                              {r} ↗
                            </a>
                          </span>
                        ))}
                        . A coding agent picks it up and opens a pull request.
                      </span>
                    ) : (
                      nextLabel && (
                        <span data-testid="publish-next">
                          Next: label an issue <code>{nextLabel}</code> to start work.
                        </span>
                      )
                    )}
                  </span>
                </span>
              </Alert>
            )}

            {changes.length > 0 && (
              <div className="text-sm" data-testid="pending-changes">
                <p className="font-medium">Publishing changes:</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
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
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 basis-56 text-sm">
                {/* What still blocks a publish says more than the state, so it takes its place. */}
                {blockers.length > 0 ? (
                  <span className="flex items-start gap-2 text-muted-foreground" data-testid="blockers">
                    <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warning-500" />
                    <span>
                      <span className="font-medium text-foreground">To publish:</span> {blockers.join(' ')}
                    </span>
                  </span>
                ) : (
                  <span data-testid="draft-state" className="flex items-center gap-2">
                    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${activeVersion === null || dirty ? 'bg-primary-500' : 'bg-success-500'}`} />
                    <span className={dirty && activeVersion !== null ? 'font-medium' : 'text-muted-foreground'}>
                      {activeVersion === null ? 'Ready to publish your first version' : dirty ? `Unsaved changes · version ${activeVersion} is live` : `Version ${activeVersion} is active`}
                    </span>
                  </span>
                )}
              </span>
              <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
                {/* Looking at the YAML is a side trip, so it is a quiet text button beside the one real action. */}
                <Button variant="ghost" size="sm" type="button" className="border-transparent" loading={busy === 'preview'} disabled={busy !== null} onClick={() => (yaml !== null ? setYaml(null) : void preview())}>
                  {yaml !== null ? 'Hide config' : 'View config'}
                </Button>
                <Button type="button" variant={unchanged ? 'secondary' : 'primary'} loading={busy === 'publish'} disabled={busy !== null || readOnly || blockers.length > 0 || unchanged} onClick={() => void publish()}>
                  {unchanged ? 'No changes' : 'Publish'}
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

/**
 * The page's shape while it loads: the header and the three steps, so nothing jumps when the
 * configuration arrives.
 */
function ConfigSkeleton() {
  return (
    <div className="flex flex-col gap-4 sm:gap-6" data-testid="config-skeleton" role="status" aria-busy="true">
      <span className="sr-only">Loading the configuration…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      {[2, 4, 3].map((rows, i) => (
        <div key={i} className="card flex flex-col gap-4 p-4 sm:p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-md" />
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: rows }, (_, j) => (
              <Skeleton key={j} className="h-20" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
