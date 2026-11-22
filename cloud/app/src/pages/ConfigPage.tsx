import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { AGENT_GUIDES, type AgentGuide } from '../lib/agentGuides';
import { Alert, Button, Card, CardBody, CardDescription, CardHeader, CardTitle, EmptyState, Input, Modal, Select, Skeleton, StatusBadge, TextArea } from '@readysetcloud/ui';
import {
  api as defaultApi,
  ApiError,
  ConfigInvalidError,
  type AgentAdapter,
  type ApiClient,
  type ConfigIssue,
  type ConfigView,
  type ConsoleAgent,
  type ConsoleConfig,
  type ConsoleRepository,
  type ConsoleWorkflow,
  type MergeMethod,
} from '../api/client';
import { tenantStatusLabel } from './DashboardPage';

type ConfigApi = Pick<ApiClient, 'config' | 'previewConfig' | 'publishConfig'>;
type Load = { state: 'loading' } | { state: 'ok'; view: ConfigView } | { state: 'error'; message: string };
type Busy = 'preview' | 'publish' | null;

export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const AGENTS: { value: AgentAdapter; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'kiro', label: 'Kiro' },
];
const KEY_FOR: Record<AgentAdapter, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY', kiro: 'KIRO_API_KEY' };
/** What an API from before the deployment named its agents offers. */
const DEFAULT_OFFERED: AgentAdapter[] = ['claude', 'codex'];
const MERGE_METHODS: { value: MergeMethod; label: string }[] = [
  { value: 'squash', label: 'Squash and merge' },
  { value: 'merge', label: 'Merge commit' },
  { value: 'rebase', label: 'Rebase and merge' },
];

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong; try again.');
/** Logins from free text: commas or spaces between them, an @ in front allowed. */
export const parseLogins = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.replace(/^@/, '')).filter(Boolean))];
const parseLines = (text: string) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const numberOrUndefined = (v: string) => (v.trim() === '' ? undefined : Number(v));

/** The issues about a field or anything inside it (paths as the server reports them). */
export function issuesAt(issues: ConfigIssue[], path: string): string | undefined {
  const found = issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
  return found.length ? found.map((i) => i.message).join('; ') : undefined;
}

export function newRepository(workflow: string, login: string): ConsoleRepository {
  return {
    enabled: true,
    triggers: [{ label: 'updraft', workflow }],
    allowedActors: login ? [login] : [],
    publish: 'draft-pr',
    commentOnFailure: true,
    review: false,
    revise: false,
  };
}

/** A new workflow's agents, from those the deployment runs: Claude writes when it can, another agent reviews when there is one. */
export function newWorkflow(prompts: ConfigView['defaults']['prompts'], offered: readonly AgentAdapter[] = DEFAULT_OFFERED): ConsoleWorkflow {
  const agent: AgentAdapter = offered.includes('claude') ? 'claude' : (offered[0] ?? 'claude');
  const reviewer: AgentAdapter = offered.includes('codex') && agent !== 'codex' ? 'codex' : (offered.find((x) => x !== agent) ?? agent);
  return {
    agent: { adapter: agent },
    prompt: prompts.implement,
    reviewer: { adapter: reviewer, prompt: prompts.review },
    revisePrompt: prompts.revise,
    verify: [],
  };
}

/** Text the person types, kept as typed, with the parsed value handed up. */
function ParsedText({
  value,
  parse,
  format,
  onChange,
  multiline,
  ...props
}: {
  value: string[];
  parse: (text: string) => string[];
  format: (v: string[]) => string;
  onChange: (v: string[]) => void;
  multiline?: boolean;
  label: string;
  hint?: string;
  error?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => format(value));
  const change = (t: string) => {
    setText(t);
    onChange(parse(t));
  };
  return multiline ? (
    <TextArea {...props} className="font-mono" rows={Math.max(3, text.split('\n').length + 1)} value={text} onChange={(e) => change(e.target.value)} />
  ) : (
    <Input {...props} value={text} onChange={(e) => change(e.target.value)} />
  );
}

function AgentFields({
  agent,
  onChange,
  issues,
  path,
  title,
  offered,
  installationId,
  reviewer,
}: {
  agent: ConsoleAgent;
  onChange: (a: ConsoleAgent) => void;
  issues: ConfigIssue[];
  path: string;
  title: string;
  offered: AgentAdapter[];
  installationId: number;
  reviewer?: { differs: boolean };
}) {
  const guide: AgentGuide | undefined = AGENT_GUIDES[agent.adapter];
  // The deployment's agents, and the one already chosen if it is not among them (published before).
  const choices = AGENTS.filter((a) => offered.includes(a.value) || a.value === agent.adapter);
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Select label={title} value={agent.adapter} error={issuesAt(issues, `${path}.adapter`)} onChange={(e) => onChange({ ...agent, adapter: e.target.value as AgentAdapter })}>
        {choices.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </Select>
      <Input
        label="Model"
        hint="Empty: the agent's default"
        value={agent.model ?? ''}
        error={issuesAt(issues, `${path}.model`)}
        onChange={(e) => onChange({ ...agent, model: e.target.value || undefined })}
      />
      <Input
        label="Reasoning effort"
        hint="For example low, medium or high"
        list="effort-levels"
        value={agent.effort ?? ''}
        error={issuesAt(issues, `${path}.effort`)}
        onChange={(e) => onChange({ ...agent, effort: e.target.value || undefined })}
      />
      {guide && (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm sm:col-span-3" data-testid={`agent-help-${path}`}>
          <span>
            {guide.credential} · {guide.billing}
          </span>
          <a className="auth-link" href={`/installations/${installationId}/keys`} target="_blank" rel="noreferrer">
            Agent keys ↗
          </a>
          <a className="auth-link" href={guide.getKeyUrl} target="_blank" rel="noreferrer">
            Get API key ↗
          </a>
          {guide.guides.map((g) => (
            <a key={g.href} className="auth-link" href={g.href} target="_blank" rel="noreferrer">
              {g.label} ↗
            </a>
          ))}
          {reviewer?.differs && <span className="w-full text-muted-foreground">Different provider than the agent: needs its own key when review is on.</span>}
          {guide.note && <span className="w-full text-muted-foreground">{guide.note}</span>}
        </p>
      )}
    </div>
  );
}

function PromptField({ label, value, onChange, onReset, error, packaged }: { label: string; value: string; onChange: (v: string) => void; onReset: () => void; error?: string; packaged: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <TextArea label={label} className="min-h-64 font-mono text-sm" rows={14} value={value} error={error} onChange={(e) => onChange(e.target.value)} />
      <div>
        <Button variant="ghost" size="sm" type="button" disabled={packaged} onClick={onReset}>
          Reset to the packaged prompt
        </Button>
      </div>
    </div>
  );
}

/** A tenant's repositories and workflows, a preview of the generated config, and publishing it. */
export function ConfigPage({ api = defaultApi }: { api?: ConfigApi }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };
  const [config, setConfig] = useState<ConsoleConfig | null>(null);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
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
  const [addRepo, setAddRepo] = useState('');
  const [workflowName, setWorkflowName] = useState('');
  const [workflowError, setWorkflowError] = useState<string | undefined>();
  const [generation, setGeneration] = useState(0);

  const show = useCallback((view: ConfigView) => {
    setLoad({ state: 'ok', view });
    setConfig(view.config);
    setActiveVersion(view.activeVersion);
    setErrors([]);
    setWarnings([]);
    setYaml(null);
    setConfirmed(new Set());
    setGeneration((g) => g + 1);
  }, []);

  // Back from adding a key in another tab: refresh which keys are set, and leave the draft alone.
  useEffect(() => {
    if (!valid) return;
    let live = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      api.config(installationId).then(
        (fresh) => live && setLoad((prev) => (prev.state === 'ok' ? { state: 'ok', view: { ...prev.view, agentKeys: fresh.agentKeys } } : prev)),
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
  }, [api, installationId, valid]);

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
  const workflowNames = Object.keys(config.workflows);
  const reachable = new Set(view.repositories.map((r) => r.fullName.toLowerCase()));
  const unconfigured = view.repositories.filter((r) => !Object.keys(config.repositories).some((n) => n.toLowerCase() === r.fullName.toLowerCase()));
  const emptyActors = Object.entries(config.repositories).filter(([, r]) => r.allowedActors.length === 0).map(([n]) => n);
  const missingKeys = [...new Set(Object.values(config.repositories).filter((r) => r.enabled).flatMap((r) => r.triggers.flatMap((t) => {
    const w = config.workflows[t.workflow];
    if (!w) return [];
    return r.review ? [KEY_FOR[w.agent.adapter], KEY_FOR[w.reviewer.adapter]] : [KEY_FOR[w.agent.adapter]];
  })))].filter((k) => !view.agentKeys[k]);
  const ceilings = view.limits.ceilings;
  const prompts = view.defaults.prompts;

  const edit = (next: ConsoleConfig) => {
    setConfig(next);
    setNotice(null);
  };
  const updateRepo = (name: string, patch: Partial<ConsoleRepository>) => {
    const repo = config.repositories[name]!;
    const next: ConsoleRepository = { ...repo, ...patch };
    for (const k of Object.keys(patch) as (keyof ConsoleRepository)[]) if (patch[k] === undefined) delete next[k];
    edit({ ...config, repositories: { ...config.repositories, [name]: next } });
  };
  const updateWorkflow = (name: string, patch: Partial<ConsoleWorkflow>) => {
    const next: ConsoleWorkflow = { ...config.workflows[name]!, ...patch };
    for (const k of Object.keys(patch) as (keyof ConsoleWorkflow)[]) if (patch[k] === undefined) delete next[k];
    edit({ ...config, workflows: { ...config.workflows, [name]: next } });
  };

  function addWorkflow() {
    const name = workflowName.trim();
    if (!WORKFLOW_NAME.test(name)) return setWorkflowError('Lower-case letters, digits and "-", at most 40');
    if (config && Object.hasOwn(config.workflows, name)) return setWorkflowError('There is already a workflow with that name');
    setWorkflowError(undefined);
    setWorkflowName('');
    edit({ ...config!, workflows: { ...config!.workflows, [name]: newWorkflow(prompts, view.agents ?? DEFAULT_OFFERED) } });
  }

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

  async function publish(confirm = confirmAutoMerge()) {
    setBusy('publish');
    setActionError(null);
    setConflict(null);
    setNotice(null);
    try {
      const out = await api.publishConfig(installationId, { config: config!, baseVersion: activeVersion, ...(confirm ? { confirmAutoMerge: true } : {}) });
      setActiveVersion(out.version);
      setErrors([]);
      setWarnings(out.warnings);
      setYaml(out.yaml);
      setNotice(`Published version ${out.version}. New jobs start with it; running jobs keep the version they started with.`);
    } catch (err) {
      if (err instanceof ConfigInvalidError) {
        setErrors(err.errors);
        setWarnings(err.warnings);
        setYaml(null);
      } else if (err instanceof ApiError && err.code === 'config_changed') setConflict(err.message);
      else if (err instanceof ApiError && err.code === 'auto_merge_unconfirmed') setServerConfirm(err.message);
      else setActionError(message(err));
    } finally {
      setBusy(null);
    }
  }

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
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            Configuration
            <StatusBadge tone={tenantStatusLabel(view.tenant).tone}>{tenantStatusLabel(view.tenant).label}</StatusBadge>
          </h1>
          <p className="text-muted-foreground" data-testid="active-version">
            {view.tenant.accountLogin} · {activeVersion === null ? 'nothing published yet' : `version ${activeVersion} is active`}
          </p>
        </div>
        <Link className="auth-link" to={`/installations/${installationId}/config/history`}>
          Version history
        </Link>
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
      {missingKeys.length > 0 && (
        <Alert variant="info" data-testid="config-missing-keys">
          Set {missingKeys.join(' and ')} before publishing: jobs run their agents with your own keys.
        </Alert>
      )}

      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Repositories</CardTitle>
            <CardDescription>Which repositories Updraft works on, which labels start which workflow, and who may apply them.</CardDescription>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            {unconfigured.length > 0 && workflowNames.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Select label="Add a repository" value={addRepo} onChange={(e) => setAddRepo(e.target.value)}>
                    <option value="">Choose a repository</option>
                    {unconfigured.map((r) => (
                      <option key={r.id} value={r.fullName}>
                        {r.fullName}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  type="button"
                  disabled={!addRepo}
                  onClick={() => {
                    edit({ ...config, repositories: { ...config.repositories, [addRepo]: newRepository(workflowNames[0]!, view.githubLogin) } });
                    setAddRepo('');
                  }}
                >
                  Add
                </Button>
              </div>
            ) : (
              Object.keys(config.repositories).length === 0 && (
                <EmptyState
                  title="No repositories to add"
                  description={workflowNames.length === 0 ? 'Add a workflow first.' : 'The Updraft App cannot access any more repositories. Choose more on GitHub, in the installation settings.'}
                />
              )
            )}
            {issuesAt(errors, 'repositories') && Object.keys(config.repositories).length === 0 && (
              <p className="text-sm text-error">{issuesAt(errors, 'repositories')}</p>
            )}

            {Object.entries(config.repositories).map(([name, repo]) => {
              const path = `repositories.${name}`;
              return (
                <section key={`${name}-${generation}`} className="flex flex-col gap-4 rounded-lg border border-border p-4" data-testid={`repo-${name}`} aria-label={name}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-2 font-semibold">
                      {name}
                      <StatusBadge tone={repo.enabled ? 'success' : 'warning'}>{repo.enabled ? 'Enabled' : 'Paused'}</StatusBadge>
                      {!reachable.has(name.toLowerCase()) && <StatusBadge tone="error">No access</StatusBadge>}
                    </h3>
                    <div className="flex gap-2">
                      <Button variant="secondary" size="sm" type="button" onClick={() => updateRepo(name, { enabled: !repo.enabled })}>
                        {repo.enabled ? 'Pause' : 'Enable'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => {
                          const rest = { ...config.repositories };
                          delete rest[name];
                          edit({ ...config, repositories: rest });
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  {issuesAt(errors, path) && !issuesAt(errors, `${path}.`) && <p className="text-sm text-error">{issuesAt(errors, path)}</p>}

                  <div className="flex flex-col gap-2">
                    <h4 className="text-sm font-medium">Trigger labels</h4>
                    {repo.triggers.map((t, i) => (
                      <div key={i} className="flex flex-wrap items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <Input
                            label={`Label ${i + 1}`}
                            value={t.label}
                            error={issuesAt(errors, `${path}.triggers.${i}.label`)}
                            onChange={(e) => updateRepo(name, { triggers: repo.triggers.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Select
                            label={`Workflow for label ${i + 1}`}
                            value={t.workflow}
                            error={issuesAt(errors, `${path}.triggers.${i}.workflow`)}
                            onChange={(e) => updateRepo(name, { triggers: repo.triggers.map((x, j) => (j === i ? { ...x, workflow: e.target.value } : x)) })}
                          >
                            {workflowNames.map((w) => (
                              <option key={w} value={w}>
                                {w}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <Button variant="ghost" size="sm" type="button" aria-label={`Remove label ${i + 1}`} onClick={() => updateRepo(name, { triggers: repo.triggers.filter((_, j) => j !== i) })}>
                          Remove
                        </Button>
                      </div>
                    ))}
                    {issuesAt(errors, `${path}.triggers`) && repo.triggers.length === 0 && <p className="text-sm text-error">{issuesAt(errors, `${path}.triggers`)}</p>}
                    <div>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        disabled={workflowNames.length === 0}
                        onClick={() => updateRepo(name, { triggers: [...repo.triggers, { label: '', workflow: workflowNames[0]! }] })}
                      >
                        Add a label
                      </Button>
                    </div>
                  </div>

                  <ParsedText
                    label="Allowed actors"
                    hint="GitHub logins, separated by commas or spaces. Only their labels start work."
                    value={repo.allowedActors}
                    parse={parseLogins}
                    format={(v) => v.join(', ')}
                    error={repo.allowedActors.length === 0 ? 'Name at least one GitHub login' : issuesAt(errors, `${path}.allowedActors`)}
                    onChange={(allowedActors) => updateRepo(name, { allowedActors })}
                  />

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Select
                      label="Publish as"
                      value={repo.publish}
                      error={issuesAt(errors, `${path}.publish`)}
                      onChange={(e) => updateRepo(name, { publish: e.target.value as ConsoleRepository['publish'] })}
                    >
                      <option value="draft-pr">Draft pull request</option>
                      <option value="pr">Pull request, ready for review</option>
                    </Select>
                    <Input
                      label="Base branch"
                      hint="Empty: the repository's default branch"
                      value={repo.baseBranch ?? ''}
                      error={issuesAt(errors, `${path}.baseBranch`)}
                      onChange={(e) => updateRepo(name, { baseBranch: e.target.value || undefined })}
                    />
                  </div>

                  <div className="flex flex-col gap-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={repo.commentOnFailure} onChange={(e) => updateRepo(name, { commentOnFailure: e.target.checked })} />
                      Comment on the issue when a run fails
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={repo.review}
                        onChange={(e) => updateRepo(name, e.target.checked ? { review: true } : { review: false, autoMerge: undefined })}
                      />
                      Review: a second agent reviews every pull request Updraft opens
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={repo.revise} onChange={(e) => updateRepo(name, e.target.checked ? { revise: true } : { revise: false, maxRevisions: undefined })} />
                      Revise: the agent makes the changes an allowed actor requests
                    </label>
                  </div>
                  {repo.revise && (
                    <Input
                      label="Revisions per pull request"
                      type="number"
                      min={1}
                      max={ceilings.maxRevisions}
                      inputMode="numeric"
                      placeholder="3"
                      hint={`Up to ${ceilings.maxRevisions}`}
                      value={repo.maxRevisions?.toString() ?? ''}
                      error={issuesAt(errors, `${path}.maxRevisions`)}
                      onChange={(e) => updateRepo(name, { maxRevisions: numberOrUndefined(e.target.value) })}
                    />
                  )}

                  <div className="flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={repo.autoMerge !== undefined}
                        disabled={!repo.review}
                        onChange={(e) => (e.target.checked ? setConfirming(name) : updateRepo(name, { autoMerge: undefined }))}
                      />
                      Auto-merge pull requests the reviewer finds ready
                    </label>
                    {!repo.review && <p className="text-sm text-muted-foreground">Needs review on: Updraft only merges what its own reviewer approved.</p>}
                    {issuesAt(errors, `${path}.autoMerge`) && <p className="text-sm text-error">{issuesAt(errors, `${path}.autoMerge`)}</p>}
                    {repo.autoMerge && (
                      <div className="grid gap-4 sm:grid-cols-3">
                        <Select
                          label="Merge method"
                          value={repo.autoMerge.method}
                          onChange={(e) => updateRepo(name, { autoMerge: { ...repo.autoMerge!, method: e.target.value as MergeMethod } })}
                        >
                          {MERGE_METHODS.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </Select>
                        <Input
                          label="Wait for checks (minutes)"
                          type="number"
                          min={1}
                          max={ceilings.autoMergeWaitMinutes}
                          placeholder="60"
                          hint={`Up to ${ceilings.autoMergeWaitMinutes}`}
                          value={repo.autoMerge.waitMinutes?.toString() ?? ''}
                          onChange={(e) => {
                            const next = { ...repo.autoMerge!, waitMinutes: numberOrUndefined(e.target.value) };
                            if (next.waitMinutes === undefined) delete next.waitMinutes;
                            updateRepo(name, { autoMerge: next });
                          }}
                        />
                        <ParsedText
                          label="Required checks"
                          hint="Comma separated. Empty: any one passing check"
                          value={repo.autoMerge.requiredChecks ?? []}
                          parse={(t) => t.split(',').map((s) => s.trim()).filter(Boolean)}
                          format={(v) => v.join(', ')}
                          onChange={(checks) => {
                            const next: NonNullable<ConsoleRepository['autoMerge']> = { ...repo.autoMerge!, requiredChecks: checks };
                            if (!checks.length) delete next.requiredChecks;
                            updateRepo(name, { autoMerge: next });
                          }}
                        />
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workflows</CardTitle>
            <CardDescription>What a trigger label starts: the agent, its prompt, and the commands that check its work. Every command runs in the sandbox.</CardDescription>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            {Object.entries(config.workflows).map(([name, w]) => {
              const path = `workflows.${name}`;
              const used = Object.values(config.repositories).some((r) => r.triggers.some((t) => t.workflow === name));
              return (
                <section key={`${name}-${generation}`} className="flex flex-col gap-4 rounded-lg border border-border p-4" data-testid={`workflow-${name}`} aria-label={`Workflow ${name}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-mono font-semibold">{name}</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={used}
                      title={used ? 'A trigger label uses it' : undefined}
                      onClick={() => {
                        const rest = { ...config.workflows };
                        delete rest[name];
                        edit({ ...config, workflows: rest });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                  <AgentFields title="Agent" installationId={installationId} agent={w.agent} path={`${path}.agent`} issues={errors} offered={view.agents ?? DEFAULT_OFFERED} onChange={(agent) => updateWorkflow(name, { agent })} />
                  <PromptField
                    label="Prompt"
                    value={w.prompt}
                    packaged={w.prompt === prompts.implement}
                    error={issuesAt(errors, `${path}.prompt`)}
                    onChange={(prompt) => updateWorkflow(name, { prompt })}
                    onReset={() => updateWorkflow(name, { prompt: prompts.implement })}
                  />
                  <ParsedText
                    multiline
                    label="Verify commands"
                    hint="One per line, run in order after the agent; the first that fails fails the run"
                    placeholder="npm ci&#10;npm test"
                    value={w.verify}
                    parse={parseLines}
                    format={(v) => v.join('\n')}
                    error={issuesAt(errors, `${path}.verify`)}
                    onChange={(verify) => updateWorkflow(name, { verify })}
                  />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label="Agent time limit (minutes)"
                      type="number"
                      min={1}
                      max={ceilings.timeoutMinutes}
                      placeholder="60"
                      hint={`Up to ${ceilings.timeoutMinutes}`}
                      value={w.timeoutMinutes?.toString() ?? ''}
                      error={issuesAt(errors, `${path}.timeoutMinutes`)}
                      onChange={(e) => updateWorkflow(name, { timeoutMinutes: numberOrUndefined(e.target.value) })}
                    />
                    <Input
                      label="Verify time limit (minutes)"
                      type="number"
                      min={1}
                      max={ceilings.verifyTimeoutMinutes}
                      placeholder="15"
                      hint={`All commands together, up to ${ceilings.verifyTimeoutMinutes}`}
                      value={w.verifyTimeoutMinutes?.toString() ?? ''}
                      error={issuesAt(errors, `${path}.verifyTimeoutMinutes`)}
                      onChange={(e) => updateWorkflow(name, { verifyTimeoutMinutes: numberOrUndefined(e.target.value) })}
                    />
                  </div>
                  <details className="flex flex-col gap-4">
                    <summary className="cursor-pointer text-sm font-medium">Review and revision</summary>
                    <div className="mt-4 flex flex-col gap-4">
                      <AgentFields
                        title="Reviewer"
                        installationId={installationId}
                        reviewer={{ differs: w.reviewer.adapter !== w.agent.adapter }}
                        agent={w.reviewer}
                        offered={view.agents ?? DEFAULT_OFFERED}
                        path={`${path}.reviewer`}
                        issues={errors}
                        onChange={(a) => updateWorkflow(name, { reviewer: { ...a, prompt: w.reviewer.prompt } })}
                      />
                      <PromptField
                        label="Review prompt"
                        value={w.reviewer.prompt}
                        packaged={w.reviewer.prompt === prompts.review}
                        error={issuesAt(errors, `${path}.reviewer.prompt`)}
                        onChange={(prompt) => updateWorkflow(name, { reviewer: { ...w.reviewer, prompt } })}
                        onReset={() => updateWorkflow(name, { reviewer: { ...w.reviewer, prompt: prompts.review } })}
                      />
                      <PromptField
                        label="Revision prompt"
                        value={w.revisePrompt}
                        packaged={w.revisePrompt === prompts.revise}
                        error={issuesAt(errors, `${path}.revisePrompt`)}
                        onChange={(revisePrompt) => updateWorkflow(name, { revisePrompt })}
                        onReset={() => updateWorkflow(name, { revisePrompt: prompts.revise })}
                      />
                    </div>
                  </details>
                </section>
              );
            })}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addWorkflow();
              }}
            >
              <div className="min-w-0 flex-1">
                <Input label="New workflow name" placeholder="docs" value={workflowName} error={workflowError} onChange={(e) => setWorkflowName(e.target.value)} />
              </div>
              <Button variant="secondary" type="submit">
                Add workflow
              </Button>
            </form>
          </CardBody>
        </Card>
      </fieldset>

      <Card>
        <CardHeader>
          <CardTitle>Preview and publish</CardTitle>
          <CardDescription>
            The config jobs run with, generated from these settings. Publishing stores it as a new version and only then makes it active; if anything
            fails, the active version stays.
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {notice && (
            <Alert variant="success" data-testid="config-published">
              {notice}
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
          {emptyActors.length > 0 && (
            <Alert variant="error" data-testid="config-empty-actors">
              Name at least one allowed actor for {emptyActors.join(', ')}.
            </Alert>
          )}
          {errors.length > 0 && (
            <Alert variant="error" data-testid="config-errors">
              <p className="font-medium">Nothing was published. Fix these first:</p>
              <ul className="mt-2 list-disc pl-5">
                {errors.map((e, i) => (
                  <li key={i}>
                    <code>{e.path}</code>: {e.message}
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
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" type="button" loading={busy === 'preview'} disabled={busy !== null} onClick={() => void preview()}>
              Preview
            </Button>
            <Button type="button" loading={busy === 'publish'} disabled={busy !== null || readOnly || emptyActors.length > 0} onClick={() => void publish()}>
              Publish
            </Button>
          </div>
          {yaml !== null && (
            <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted p-4 font-mono text-xs" data-testid="config-yaml" aria-label="Generated config.yaml">
              {yaml}
            </pre>
          )}
        </CardBody>
      </Card>

      <Modal open={confirming !== null} onClose={() => setConfirming(null)} aria-label="Turn on auto-merge">
        <div className="flex flex-col gap-4 p-6">
          <h2 className="text-lg font-semibold">Turn on auto-merge for {confirming}?</h2>
          <p className="text-sm text-muted-foreground">
            Updraft will merge a pull request it opened as soon as its own reviewer finds it ready and the checks pass, without a person approving the
            merge. It takes effect when you publish.
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
                updateRepo(name, { autoMerge: { method: 'squash' } });
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
