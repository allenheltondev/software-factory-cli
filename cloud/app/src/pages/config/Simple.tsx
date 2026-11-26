import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Card, CardBody, CardDescription, CardHeader, CardTitle, EmptyState, Input, Select, StatusBadge } from '@readysetcloud/ui';
import type { AgentAdapter, ConfigIssue, ConfigView, ConsoleConfig, ConsoleRepository, ConsoleWorkflow } from '../../api/client';
import { AGENT_GUIDES } from '../../lib/agentGuides';
import { installationSettingsUrl } from '../../lib/diagnostics';
import { PROVIDERS } from '../AgentKeysPage';
import { AutoMerge, CiRepair, Suggestions } from './Editor';
import { Check, FieldError, ParsedText, PromptField } from './fields';
import { InlineKey, type KeyApi } from './InlineKey';
import { AGENT_LABEL, DEFAULT_OFFERED, issuesAt, KEY_FOR, newRepository, numberOrUndefined, parseLogins, workflowConflict } from './model';
import {
  addLabel,
  allLabels,
  connectionOf,
  customSettings,
  customize,
  customizeRepo,
  DEFAULT_CODING,
  DEFAULT_REVIEW,
  defaultTeam,
  effective,
  eligible,
  labelGroups,
  labelKey,
  patchLabel,
  removeLabel,
  renameLabel,
  resetRepo,
  resetToDefaults,
  reviewOn,
  runners,
  selfReviewing,
  setDefaultCoding,
  setDefaultReview,
  setMaxRevisions,
  setOverride,
  setRepoLabel,
  setRevise,
  setSelfReview,
  teamOf,
  ticked,
  workflowIn,
  type Connection,
  type KeyStatus,
  type LabelGroup,
  type Role,
} from './team';

export const CODING = DEFAULT_CODING;
export const REVIEW = DEFAULT_REVIEW;

/**
 * Whether the main page can show this configuration exactly: one profile per provider, the
 * default team in `builders` and `reviewers`, any number of labels and repositories, and
 * overrides that are each a workflow's own pool. Anything else (`customSettings`) is shown in the
 * full editor, unchanged.
 */
export const isSimple = (config: ConsoleConfig) => customSettings(config).length === 0;

export interface SimpleProps {
  config: ConsoleConfig;
  onChange: (next: ConsoleConfig) => void;
  view: ConfigView;
  errors: ConfigIssue[];
  installationId: number;
  keyApi: KeyApi;
  onKeys: (keys: Record<string, boolean>) => void;
  /** What the server knows of each key: set, and how its last use went. */
  keyStatus?: Record<string, KeyStatus>;
  onAskAutoMerge: (repo: string) => void;
  /** Leave for the full editor: named pools, several profiles of a provider. */
  onOpenFull: () => void;
  generation: number;
  /** Nothing published yet: number the three steps. */
  firstRun?: boolean;
}

const offeredOf = (view: ConfigView) => view.agents ?? DEFAULT_OFFERED;
const adaptersOf = (config: ConsoleConfig, view: ConfigView) => [...new Set<AgentAdapter>([...offeredOf(view), ...Object.values(config.agents).map((a) => a.adapter)])];
const label = (config: ConsoleConfig, a: string) => AGENT_LABEL[config.agents[a]?.adapter ?? (a as AgentAdapter)] ?? a;
const quote = (l: string) => `"${l}"`;

/** What stops a publish, in words, before the server is asked: empty when the page is ready. */
export function simpleBlockers(config: ConsoleConfig, view: ConfigView): string[] {
  const out: string[] = [];
  const groups = labelGroups(config);
  if (groups.some((g) => !g.label.trim())) out.push('Choose the label that starts work.');
  const needActors = Object.values(config.repositories).some((r) => r.allowedActors === undefined);
  if (config.allowedActors.length === 0 && (needActors || Object.keys(config.repositories).length === 0)) out.push('Name at least one person who can add it.');
  if (Object.keys(config.repositories).length === 0) out.push('Turn on at least one repository.');
  if (defaultTeam(config).coding.length === 0) out.push('Choose at least one coding agent.');
  const on = reviewOn(config);
  if (on && defaultTeam(config).review.length === 0) out.push('Choose at least one review agent, or choose no automated review.');
  for (const g of groups) {
    for (const wf of [g.primary, ...g.variants]) {
      const t = teamOf(config, wf);
      const where = wf === g.primary ? quote(g.label) : `${quote(g.label)} in ${runners(config, wf).join(', ')}`;
      if (!t.inherits.coding && t.coding.length === 0) out.push(`Choose a coding agent for ${where}, or use the defaults.`);
      if (on && !t.inherits.review && t.review.length === 0) out.push(`Choose a review agent for ${where}, or use the defaults.`);
    }
  }
  for (const [name, r] of Object.entries(config.repositories)) {
    if (r.workflows.length === 0) out.push(`Choose a label that starts work in ${name}.`);
    const clash = workflowConflict(config, r);
    if (clash) out.push(clash);
  }
  if (on && !Object.values(config.workflows).some((w) => w.review.allowSameAgent)) {
    for (const s of selfReviewing(config)) out.push(`${s.agents.map((a) => label(config, a)).join(' and ')} would review its own work on ${quote(s.label)}: choose another review agent, or allow self-review.`);
  }
  // An agent the configuration still runs whose key was removed: the person puts the key back or
  // unticks it. The page never changes that for them (a review policy would change unseen).
  const running = new Set<string>();
  for (const r of Object.values(config.repositories)) {
    if (!r.enabled) continue;
    for (const wf of r.workflows) {
      const w = config.workflows[wf];
      if (!w) continue;
      ticked(config, w.pool).forEach((a) => running.add(a));
      if (w.review.enabled) ticked(config, w.review.pool).forEach((a) => running.add(a));
    }
  }
  if (Object.keys(config.repositories).length === 0) [...defaultTeam(config).coding, ...(on ? defaultTeam(config).review : [])].forEach((a) => running.add(a));
  const keyless = [...running].filter((a) => !view.agentKeys[KEY_FOR[config.agents[a]!.adapter]]);
  if (keyless.length) out.push(`Add the key for ${keyless.map((a) => label(config, a)).join(' and ')}, or untick it.`);
  return [...new Set(out)];
}

const CONNECTION: Record<Connection, { tone: 'success' | 'warning' | 'error' | 'neutral' | 'primary'; text: string }> = {
  connected: { tone: 'success', text: 'Connected' },
  unverified: { tone: 'primary', text: 'Saved, checked on first use' },
  failing: { tone: 'error', text: 'Last use failed' },
  missing: { tone: 'neutral', text: 'Not connected' },
  unavailable: { tone: 'warning', text: 'Not available here' },
};

/**
 * The configuration as one page, in three steps: connect agents, choose who codes and who
 * reviews, and where work starts (labels, people, repositories), with exceptions per label or
 * repository in place. It writes the same settings as the full editor.
 */
export function SimpleConfig({ config, onChange, view, errors, installationId, keyApi, onKeys, keyStatus = {}, onAskAutoMerge, onOpenFull, generation, firstRun }: SimpleProps) {
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<AgentAdapter | null>(null);
  const [manual, setManual] = useState<Set<string>>(new Set());
  const [newLabel, setNewLabel] = useState('');
  const prompts = view.defaults.prompts;
  const ceilings = view.limits.ceilings;
  const offered = offeredOf(view);
  const adapters = adaptersOf(config, view);
  const groups = labelGroups(config);
  const first = Object.values(config.workflows)[0]!;
  const reviewing = reviewOn(config);
  const team = defaultTeam(config);
  const connection = (a: AgentAdapter) => connectionOf(a, view, offered, keyStatus[KEY_FOR[a]]);
  /** An agent can be newly ticked only once its provider is connected (and Updraft Cloud still runs it). */
  const usable = (a: string) => eligible(connection(a as AgentAdapter));
  const consent = Object.values(config.workflows).some((w) => w.review.enabled && w.review.allowSameAgent);
  const independent = adapters.filter(usable).length > 1;

  /** A key was saved: the provider is connected, and nothing else changes (it is not added to any team). */
  const keySaved = (keys: Record<string, boolean>) => {
    onKeys(keys);
    setConnecting(null);
  };

  /** One agent's tick box, with why it cannot be used and how to fix that. */
  const agentBox = (a: AgentAdapter, on: boolean, onToggle: (v: boolean) => void, name?: string) => {
    const c = connection(a);
    const ok = eligible(c);
    return (
      <div className="flex items-center gap-2">
        <Check checked={on} disabled={!ok && !on} onChange={onToggle}>
          <span className="font-medium">{name ?? AGENT_LABEL[a]}</span>
        </Check>
        {!ok && (
          <InfoTip
            label={`Why ${AGENT_LABEL[a]} cannot be used`}
            text={
              c === 'unavailable'
                ? `Updraft Cloud no longer runs ${AGENT_LABEL[a]}.${on ? ' Untick it.' : ''}`
                : on
                  ? `${AGENT_LABEL[a]}'s ${AGENT_GUIDES[a].credential} was removed. Connect it again, or untick ${AGENT_LABEL[a]}. Click to connect.`
                  : `Connect ${AGENT_LABEL[a]} with your ${AGENT_GUIDES[a].credential} to use it. Click to connect.`
            }
            hidden={connecting === a}
            onClick={c !== 'unavailable' ? () => setConnecting(connecting === a ? null : a) : undefined}
          />
        )}
        {c === 'failing' && on && <span className="text-xs text-error">its last run could not use the key: reconnect it</span>}
      </div>
    );
  };

  const toggle = (list: string[], a: string, v: boolean) => (v ? [...list, a] : list.filter((x) => x !== a));

  /** Coding and review agents for one workflow (an override), side by side. */
  const overrideLists = (wf: string, idPrefix: string) => {
    const t = teamOf(config, wf);
    const set = (role: Role, list: string[]) => onChange(setOverride(config, wf, role, list, adapters));
    const column = (role: Role, title: string, list: string[]) => (
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{title}</legend>
        {adapters.map((a) => (
          <div key={a} data-testid={`${idPrefix}-${role}-${a}`}>
            {agentBox(a, list.includes(a), (v) => set(role, toggle(list, a, v)))}
          </div>
        ))}
        <span className="text-xs text-muted-foreground">{(role === 'coding' ? t.inherits.coding : t.inherits.review) ? 'Same as the defaults' : 'Its own'}</span>
      </fieldset>
    );
    return (
      <div className="grid gap-4 rounded-lg bg-muted/40 p-3 sm:grid-cols-2">
        {column('coding', 'Coding agents', t.coding)}
        {reviewing ? column('review', 'Review agents', t.review) : <p className="text-sm text-muted-foreground">No automated review: pull requests wait for a person.</p>}
      </div>
    );
  };

  const setRepo = (name: string, next: ConsoleRepository | null) => {
    const repositories = { ...config.repositories };
    if (next) repositories[name] = next;
    else delete repositories[name];
    onChange({ ...config, repositories });
  };
  const patchRepo = (name: string, p: Partial<ConsoleRepository>) => {
    const next: ConsoleRepository = { ...config.repositories[name]!, ...p };
    for (const k of Object.keys(p) as (keyof ConsoleRepository)[]) if (p[k] === undefined) delete next[k];
    setRepo(name, next);
  };
  const removeRepo = (name: string) => {
    let next = config;
    for (const g of groups) next = setRepoLabel(next, name, g, false);
    const repositories = { ...next.repositories };
    delete repositories[name];
    onChange({ ...next, repositories });
  };

  const reachable = new Set(view.repositories.map((r) => r.fullName.toLowerCase()));
  const rows = [...view.repositories.map((r) => r.fullName), ...Object.keys(config.repositories).filter((n) => !reachable.has(n.toLowerCase()))];
  /** The workflows that inherit each default role: what changing it changes. */
  const rowsNow = effective(config);
  const inherits = (role: Role, workflow: string) => teamOf(config, workflow).inherits[role];
  const affected = (role: Role) => {
    const rs = rowsNow.filter((r) => inherits(role, r.workflow));
    const custom = rowsNow.filter((r) => !inherits(role, r.workflow));
    return (
      <p className="text-xs text-muted-foreground" data-testid={`affects-${role}`}>
        {rs.length ? `Used by ${rs.map((r) => `${quote(r.label)} in ${r.repository}`).join(', ')}.` : 'No repository uses these yet.'}
        {custom.length > 0 && ` Not changed: ${custom.map((r) => `${quote(r.label)} in ${r.repository}`).join(', ')} (own agents).`}
      </p>
    );
  };
  const step = (n: number, text: string) => (firstRun ? `${n} · ${text}` : text);
  const newLabelKey = labelKey(newLabel);
  const newLabelError = newLabel.trim() && groups.some((g) => g.key === newLabelKey) ? 'There is already a label with that name' : undefined;

  return (
    <div className="flex flex-col gap-6" data-testid="simple-config">
      <Card data-testid="connected-agents">
        <CardHeader>
          <CardTitle>{step(1, 'Connect agents')}</CardTitle>
          <CardDescription>Connect the coding agents you already pay for. Connecting one does not start using it: you choose who works in the next step.</CardDescription>
        </CardHeader>
        <CardBody className="grid gap-3 sm:grid-cols-2">
          {adapters.map((a) => {
            const c = connection(a);
            const guide = AGENT_GUIDES[a];
            const provider = PROVIDERS[KEY_FOR[a]];
            const badge = CONNECTION[c];
            const used = Object.values(config.pools).some((p) => p.agents.includes(a) && config.agents[a]?.enabled);
            return (
              <section key={a} className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid={`provider-${a}`} aria-label={AGENT_LABEL[a]}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{AGENT_LABEL[a]}</h3>
                  <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {c === 'unavailable'
                    ? 'Updraft Cloud does not run this agent. Settings that name it are kept.'
                    : `API key · runs bill your ${guide.billing}${provider?.checkedOnSave === false ? '; the key is checked when a job first uses it' : ''}.`}
                  {used ? ' In use.' : c !== 'unavailable' && c !== 'missing' ? ' Not in any team yet.' : ''}
                </p>
                {a === 'claude' && c !== 'unavailable' && (
                  <p className="text-xs text-muted-foreground">
                    Workflows here run with the API key. A Claude subscription runs only on the separate signed-in worker:{' '}
                    <Link className="auth-link" to={`/installations/${installationId}/claude`}>
                      Claude subscription routing
                    </Link>
                    .
                  </p>
                )}
                {c !== 'unavailable' && (
                  <div className="flex flex-wrap items-center gap-3">
                    {connecting !== a && (
                      <Button variant={c === 'missing' ? 'primary' : 'ghost'} size="sm" type="button" onClick={() => setConnecting(a)}>
                        {c === 'missing' ? `Connect ${AGENT_LABEL[a]}` : c === 'failing' ? `Reconnect ${AGENT_LABEL[a]}` : `Replace ${AGENT_LABEL[a]} key`}
                      </Button>
                    )}
                    {connecting === a && (
                      <Button variant="ghost" size="sm" type="button" onClick={() => setConnecting(null)}>
                        Cancel
                      </Button>
                    )}
                    {c !== 'missing' && (
                      <Link className="auth-link text-sm" to={`/installations/${installationId}/keys`}>
                        Manage
                      </Link>
                    )}
                  </div>
                )}
                {connecting === a && <InlineKey adapter={a} installationId={installationId} api={keyApi} onSaved={keySaved} />}
              </section>
            );
          })}
        </CardBody>
      </Card>

      <Card data-testid="default-team">
        <CardHeader>
          <CardTitle>{step(2, 'Choose your agent team')}</CardTitle>
          <CardDescription>Every label and repository uses this team unless you give it its own. Updraft picks the model and effort.</CardDescription>
        </CardHeader>
        <CardBody className="grid gap-6 sm:grid-cols-2">
          <fieldset className="flex min-w-0 flex-col gap-1" data-testid="coding-agents">
            <legend className="font-medium">Coding agents</legend>
            <p className="mb-2 text-sm text-muted-foreground">They take turns picking up issues and writing the code.</p>
            {adapters.map((a) => (
              <div key={a} className="py-1.5" data-testid={`coding-${a}`}>
                {agentBox(a, team.coding.includes(a), (v) => onChange(setDefaultCoding(config, toggle(team.coding, a, v), adapters)))}
              </div>
            ))}
            {affected('coding')}
          </fieldset>
          <fieldset className="flex min-w-0 flex-col gap-1" data-testid="review-agents">
            <legend className="font-medium">Review agents</legend>
            <p className="mb-2 text-sm text-muted-foreground">Each pull request gets one of them, never the agent that wrote it unless you allow it. Tick none for no automated review.</p>
            {adapters.map((a) => (
              <div key={a} className="py-1.5" data-testid={`review-${a}`}>
                {agentBox(a, team.review.includes(a), (v) => onChange(setDefaultReview(config, toggle(team.review, a, v), adapters)))}
              </div>
            ))}
            {reviewing && affected('review')}
          </fieldset>
        </CardBody>
        <CardBody className="flex flex-col gap-2 border-t border-border bg-muted/30" data-testid="review-policy">
          {!reviewing && <p className="text-sm text-muted-foreground">No automated review: pull requests wait for a person. Tick a review agent to turn review on.</p>}
          {reviewing && (
            <>
              <div>
                <Button variant="ghost" size="sm" type="button" onClick={() => onChange(setDefaultReview(config, [], adapters))}>
                  No automated review
                </Button>
              </div>
              <p className="text-sm text-muted-foreground" data-testid="review-summary">
                {selfReviewing(config).length === 0
                  ? 'Independent review: every pull request is reviewed by an agent other than the one that wrote it.'
                  : independent
                    ? 'An agent would review its own work. Choose another review agent for an independent review (recommended).'
                    : 'An agent would review its own work. Connect a second agent for an independent review (recommended).'}
              </p>
              <Check checked={consent} onChange={(v) => onChange(setSelfReview(config, v))} testId="allow-self-review">
                Allow an agent to review its own pull request when no other review agent is chosen
              </Check>
            </>
          )}
          <Check checked={first.revise.enabled} onChange={(v) => onChange(setRevise(config, v))}>
            Coding agents make the changes {reviewing ? 'a review asks for' : 'your people ask for in a review'}
          </Check>
          <p className="text-xs text-muted-foreground">Revisions and fixes for failing checks are made by the coding agents of the label that opened the pull request, and reviewed by the same rules.</p>
        </CardBody>
      </Card>

      <Card data-testid="labels">
        <CardHeader>
          <CardTitle>{step(3, 'Choose where work starts')}</CardTitle>
          <CardDescription>When one of these people adds a label to an issue, a coding agent picks it up and opens a pull request.</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <ParsedText
            key={`actors-${generation}`}
            label="Who can add a label"
            hint="GitHub logins, separated by commas or spaces"
            value={config.allowedActors}
            parse={parseLogins}
            format={(v) => v.join(', ')}
            error={issuesAt(errors, 'allowedActors')}
            onChange={(allowedActors) => onChange({ ...config, allowedActors })}
          />
          <div className="flex flex-col divide-y divide-border">
            {groups.map((g) => {
              const t = teamOf(config, g.primary);
              const custom = !t.inherits.coding || (reviewing && !t.inherits.review);
              return (
                <section key={`${g.primary}-${generation}`} className="flex flex-col gap-3 py-3" data-testid={`label-${g.primary}`} aria-label={`Label ${g.label}`}>
                  <div className="grid gap-3 sm:grid-cols-[1fr_16rem_auto] sm:items-end">
                    <LabelInput group={g} groups={groups} error={issuesAt(errors, `workflows.${g.primary}.label`)} onChange={(l) => onChange(renameLabel(config, g, l))} />
                    <Select
                      label={`Agents for ${quote(g.label)}`}
                      value={custom ? 'custom' : 'default'}
                      onChange={(e) => onChange(e.target.value === 'custom' ? customize(config, g.primary, adapters) : resetToDefaults(config, g.primary))}
                    >
                      <option value="default">Use installation defaults</option>
                      <option value="custom">Customize</option>
                    </Select>
                    <Button variant="ghost" size="sm" type="button" className="justify-self-start sm:mb-1" disabled={groups.length < 2} title={groups.length < 2 ? 'At least one label starts work' : undefined} onClick={() => onChange(removeLabel(config, g))}>
                      Remove label
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground" data-testid={`label-${g.primary}-team`}>
                    Coding: {t.coding.map((a) => label(config, a)).join(', ') || 'none'} · Review: {reviewing ? t.review.map((a) => label(config, a)).join(', ') || 'none' : 'none'}
                    {custom ? ' · its own agents' : ' · installation defaults'}
                  </p>
                  {custom && (
                    <>
                      {overrideLists(g.primary, `label-${g.primary}`)}
                      <div>
                        <Button variant="ghost" size="sm" type="button" onClick={() => onChange(resetToDefaults(config, g.primary))}>
                          Reset to defaults
                        </Button>
                      </div>
                    </>
                  )}
                </section>
              );
            })}
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newLabel.trim() || newLabelError) return;
              onChange(addLabel(config, newLabel, prompts));
              setNewLabel('');
            }}
          >
            <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
              <Input label="Add a label" placeholder="art" hint="It starts work in every repository below, with the installation defaults until you customize it" value={newLabel} error={newLabelError} onChange={(e) => setNewLabel(e.target.value)} />
            </div>
            <Button variant="secondary" type="submit" disabled={!newLabel.trim() || !!newLabelError}>
              Add label
            </Button>
          </form>
        </CardBody>

        <CardBody className="flex flex-col gap-1 border-t border-border">
          <h3 className="font-medium">Repositories</h3>
          <p className="text-sm text-muted-foreground">
            Checks run after the agent; if they fail, nothing is published.{' '}
            <a className="auth-link" href={installationSettingsUrl(view.tenant)} target="_blank" rel="noreferrer">
              Give the App more repositories ↗
            </a>
          </p>
          <div className="flex flex-col divide-y divide-border">
            {rows.length === 0 && <EmptyState title="No repositories yet" description="The Updraft App cannot reach any repository. Choose some on GitHub, in the installation settings." />}
            {rows.map((name) => {
              const repo = config.repositories[name];
              const path = `repositories.${name}`;
              const open = settingsOpen === name;
              const runsAny = repo && repo.workflows.length > 0;
              const repoReviewed = !!repo && repo.workflows.some((n) => config.workflows[n]?.review.enabled);
              const repoW: ConsoleWorkflow | undefined = repo ? config.workflows[repo.workflows[0] ?? ''] : undefined;
              return (
                <section key={`${name}-${generation}`} className="flex flex-col gap-3 py-3" data-testid={`repo-${name}`} aria-label={name}>
                  <div className={repo ? 'grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end' : 'flex'}>
                    <label className="flex items-center gap-2 font-medium sm:pb-2">
                      <input type="checkbox" className="h-4 w-4 shrink-0" aria-label={`Work in ${name}`} checked={!!repo} onChange={(e) => (e.target.checked ? setRepo(name, newRepository(allLabels(config), reviewing)) : removeRepo(name))} />
                      {name}
                      {repo && !repo.enabled && <span className="text-sm font-normal text-muted-foreground">paused</span>}
                      {!reachable.has(name.toLowerCase()) && <span className="text-sm font-normal text-error">the App can no longer reach it</span>}
                    </label>
                    {repo && (
                      <>
                        <div className="min-w-0">
                          <Input
                            label="Checks"
                            className="font-mono"
                            placeholder="npm ci && npm test"
                            value={repo.verify.join(' && ')}
                            error={issuesAt(errors, `${path}.verify`)}
                            onChange={(e) => patchRepo(name, { verify: e.target.value.trim() ? [e.target.value] : [] })}
                          />
                        </div>
                        <Button variant="ghost" size="sm" type="button" className="justify-self-start sm:mb-1" aria-expanded={open} aria-label={`Settings for ${name}`} onClick={() => setSettingsOpen(open ? null : name)}>
                          {open ? 'Close settings' : 'Settings'}
                        </Button>
                      </>
                    )}
                  </div>
                  {repo && (
                    <div className="flex flex-col gap-2" data-testid={`repo-labels-${name}`}>
                      {groups.map((g) => {
                        const wf = workflowIn(config, name, g);
                        const exception = wf !== undefined && wf !== g.primary;
                        const t = wf ? teamOf(config, wf) : null;
                        return (
                          <div key={g.primary} className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                              {groups.length > 1 ? (
                                <Check checked={!!wf} onChange={(v) => onChange(setRepoLabel(config, name, g, v))}>
                                  Starts on <code>{g.label}</code>
                                </Check>
                              ) : (
                                <span>
                                  Starts on <code>{g.label}</code>
                                </span>
                              )}
                              {t && (
                                <span className="text-muted-foreground" data-testid={`repo-team-${name}-${g.primary}`}>
                                  {t.coding.map((a) => label(config, a)).join(', ') || 'no coding agent'}
                                  {reviewing ? `, reviewed by ${t.review.map((a) => label(config, a)).join(', ') || 'no one'}` : ''}
                                  {exception ? ' (this repository only)' : ''}
                                </span>
                              )}
                              {wf && (
                                <button
                                  type="button"
                                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                                  aria-label={exception ? `Use the agents of ${quote(g.label)} in ${name}` : `Customize agents for ${quote(g.label)} in ${name}`}
                                  onClick={() => onChange(exception ? resetRepo(config, name, g) : customizeRepo(config, name, g, adapters))}
                                >
                                  {exception ? 'Reset to the label’s agents' : 'Customize here'}
                                </button>
                              )}
                            </div>
                            {exception && overrideLists(wf, `repo-${name}-${g.primary}`)}
                          </div>
                        );
                      })}
                      {!runsAny && <FieldError message="Choose a label that starts work here." />}
                    </div>
                  )}
                  {repo && <FieldError message={issuesAt(errors.filter((e) => !e.path.startsWith(`${path}.verify`)), path)} />}
                  {repo && open && (
                    <div className="flex flex-col gap-4 rounded-lg bg-muted/40 p-3" data-testid={`repo-settings-${name}`}>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <Select label="Open pull requests as" value={repo.publish} onChange={(e) => patchRepo(name, { publish: e.target.value as ConsoleRepository['publish'] })}>
                          <option value="draft-pr">Drafts</option>
                          <option value="pr">Ready for review</option>
                        </Select>
                        <Input label="Base branch" hint="Empty: the default branch" value={repo.baseBranch ?? ''} error={issuesAt(errors, `${path}.baseBranch`)} onChange={(e) => patchRepo(name, { baseBranch: e.target.value || undefined })} />
                        <Input
                          label="Checks time limit (minutes)"
                          type="number"
                          min={1}
                          max={ceilings.verifyTimeoutMinutes}
                          placeholder="15"
                          disabled={!repo.verify.length}
                          value={repo.verifyTimeoutMinutes?.toString() ?? ''}
                          error={issuesAt(errors, `${path}.verifyTimeoutMinutes`)}
                          onChange={(e) => patchRepo(name, { verifyTimeoutMinutes: numberOrUndefined(e.target.value) })}
                        />
                      </div>
                      <Check checked={!repo.enabled} onChange={(paused) => patchRepo(name, { enabled: !paused })}>
                        Pause: start no new work here, and keep the settings
                      </Check>
                      <Check checked={repo.commentOnFailure} onChange={(commentOnFailure) => patchRepo(name, { commentOnFailure })}>
                        Comment on the issue when a run fails
                      </Check>
                      <Check checked={repo.notifications === 'verbose'} onChange={(v) => patchRepo(name, { notifications: v ? 'verbose' : undefined })}>
                        Post a separate comment for each step (verbose); otherwise one status comment, and a comment only when you need to act
                      </Check>
                      <Check checked={repo.allowedActors !== undefined} onChange={(v) => patchRepo(name, { allowedActors: v ? [...config.allowedActors] : undefined })}>
                        Only some people can start work here
                      </Check>
                      {repo.allowedActors !== undefined && (
                        <ParsedText
                          label="Who can add the label here"
                          value={repo.allowedActors}
                          parse={parseLogins}
                          format={(v) => v.join(', ')}
                          error={repo.allowedActors.length === 0 ? 'Name at least one GitHub login' : issuesAt(errors, `${path}.allowedActors`)}
                          onChange={(allowedActors) => patchRepo(name, { allowedActors })}
                        />
                      )}
                      <Suggestions name={name} repo={repo} reviewed={repoReviewed} errors={errors} patch={(p) => patchRepo(name, p)} />
                      <CiRepair name={name} repo={repo} reviewed={repoReviewed} revised={!!repoW?.revise.enabled} maxRevisions={repoW?.revise.maxRevisions} errors={errors} ceiling={ceilings.ciWaitMinutes ?? ceilings.autoMergeWaitMinutes} patch={(p) => patchRepo(name, p)} />
                      <AutoMerge name={name} repo={repo} reviewed={repoReviewed} errors={errors} ceiling={ceilings.autoMergeWaitMinutes} patch={(p) => patchRepo(name, p)} onAsk={() => onAskAutoMerge(name)} />
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <EffectiveConfig config={config} />

      <details className="rounded-lg border border-border p-4" open={errors.some((e) => /\.(prompt|timeoutMinutes|maxRevisions|model|effort)/.test(e.path)) || undefined} data-testid="advanced">
        <summary className="cursor-pointer text-sm font-medium">
          Advanced <span className="font-normal text-muted-foreground">· models and effort, prompts, revision rounds, time limits, named pools</span>
        </summary>
        <div className="mt-4 flex flex-col gap-6">
          <section className="flex flex-col gap-3" aria-label="Models">
            <h3 className="font-medium">Models</h3>
            <p className="text-sm text-muted-foreground">
              Automatic (recommended) runs each agent with its provider’s default model and reasoning effort. Updraft Cloud does not yet pick a model by issue complexity from this page; the model
              and effort a job actually ran with are shown on the job.
            </p>
            {Object.entries(config.agents).map(([name, agent]) => {
              const isManual = !!agent.model || !!agent.effort || manual.has(name);
              const set = (p: Partial<typeof agent>) => {
                const next = { ...agent, ...p };
                if (!next.model) delete next.model;
                if (!next.effort) delete next.effort;
                onChange({ ...config, agents: { ...config.agents, [name]: next } });
              };
              return (
                <div key={name} className="flex flex-col gap-3 rounded-lg border border-border p-3" data-testid={`model-${name}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">{AGENT_LABEL[agent.adapter]}</span>
                    <span className="text-sm text-muted-foreground">{isManual ? `Manual${agent.model ? `: ${agent.model}` : ''}${agent.effort ? ` (${agent.effort})` : ''}` : 'Automatic'}</span>
                    <span className="ml-auto">
                      <Check
                        checked={isManual}
                        onChange={(v) => {
                          setManual((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(name);
                            else next.delete(name);
                            return next;
                          });
                          if (!v) set({ model: undefined, effort: undefined });
                        }}
                      >
                        Choose the model myself
                      </Check>
                    </span>
                  </div>
                  {isManual && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Input label="Model" hint={agent.adapter === 'vibe' ? 'Mistral API model ID. Default: mistral-medium-latest' : 'The provider’s model ID; your plan must include it. Empty: the default'} value={agent.model ?? ''} error={issuesAt(errors, `agents.${name}.model`)} onChange={(e) => set({ model: e.target.value || undefined })} />
                      {agent.adapter !== 'vibe' && <Input label="Reasoning effort" hint="For example low, medium or high" list="effort-levels" value={agent.effort ?? ''} error={issuesAt(errors, `agents.${name}.effort`)} onChange={(e) => set({ effort: e.target.value || undefined })} />}
                    </div>
                  )}
                  <FieldError message={issuesAt(errors.filter((e) => e.path === `agents.${name}` || e.path === `agents.${name}.adapter`), `agents.${name}`)} />
                </div>
              );
            })}
          </section>

          <Input
            label="Revision rounds per pull request"
            type="number"
            min={1}
            max={ceilings.maxRevisions}
            placeholder="3"
            hint={`Up to ${ceilings.maxRevisions}, for every label`}
            disabled={!first.revise.enabled}
            value={first.revise.maxRevisions?.toString() ?? ''}
            error={issuesAt(errors, `workflows.${groups[0]?.primary}.revise.maxRevisions`)}
            onChange={(e) => onChange(setMaxRevisions(config, numberOrUndefined(e.target.value)))}
          />

          {groups.map((g) => {
            const w = config.workflows[g.primary]!;
            const patch = (f: (w: ConsoleWorkflow) => ConsoleWorkflow) => onChange(patchLabel(config, g, f));
            return (
              <section key={g.primary} className="flex flex-col gap-4 border-t border-border pt-4" aria-label={`Prompts for ${g.label}`}>
                <h3 className="font-medium">
                  Label <code>{g.label}</code>
                </h3>
                <Input
                  label="Agent time limit (minutes)"
                  type="number"
                  min={1}
                  max={ceilings.timeoutMinutes}
                  placeholder="60"
                  hint={`Up to ${ceilings.timeoutMinutes}`}
                  value={w.timeoutMinutes?.toString() ?? ''}
                  error={issuesAt(errors, `workflows.${g.primary}.timeoutMinutes`)}
                  onChange={(e) =>
                    patch((x) => {
                      const timeoutMinutes = numberOrUndefined(e.target.value);
                      const next = { ...x, timeoutMinutes };
                      if (timeoutMinutes === undefined) delete next.timeoutMinutes;
                      return next;
                    })
                  }
                />
                <PromptField label="Coding prompt" value={w.prompt} packaged={w.prompt === prompts.implement} error={issuesAt(errors, `workflows.${g.primary}.prompt`)} onChange={(prompt) => patch((x) => ({ ...x, prompt }))} onReset={() => patch((x) => ({ ...x, prompt: prompts.implement }))} />
                <PromptField label="Review prompt" value={w.review.prompt} packaged={w.review.prompt === prompts.review} error={issuesAt(errors, `workflows.${g.primary}.review.prompt`)} onChange={(prompt) => patch((x) => ({ ...x, review: { ...x.review, prompt } }))} onReset={() => patch((x) => ({ ...x, review: { ...x.review, prompt: prompts.review } }))} />
                <PromptField label="Revision prompt" value={w.revise.prompt} packaged={w.revise.prompt === prompts.revise} error={issuesAt(errors, `workflows.${g.primary}.revise.prompt`)} onChange={(prompt) => patch((x) => ({ ...x, revise: { ...x.revise, prompt } }))} onReset={() => patch((x) => ({ ...x, revise: { ...x.revise, prompt: prompts.revise } }))} />
              </section>
            );
          })}
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button variant="secondary" type="button" onClick={onOpenFull}>
              Open the full editor
            </Button>
            <span className="text-sm text-muted-foreground">For named agent pools, several profiles of one provider, or other custom settings.</span>
          </div>
        </div>
      </details>
    </div>
  );
}

/** A label's text, kept as typed: a text that another label already has is not applied (the two would merge). */
function LabelInput({ group, groups, error, onChange }: { group: LabelGroup; groups: LabelGroup[]; error?: string; onChange: (label: string) => void }) {
  const [text, setText] = useState(group.label);
  const taken = groups.some((g) => g.primary !== group.primary && g.key === labelKey(text));
  return (
    <Input
      label="Label"
      value={text}
      error={taken ? 'Another label already has that name' : error}
      onChange={(e) => {
        setText(e.target.value);
        if (!groups.some((g) => g.primary !== group.primary && g.key === labelKey(e.target.value))) onChange(e.target.value);
      }}
    />
  );
}

/**
 * What runs where: for every repository and label, who codes and who reviews, and whether that
 * is the installation's team, the label's own or the repository's own. Shown for any
 * configuration, including those the main page cannot edit.
 */
export function EffectiveConfig({ config, children }: { config: ConsoleConfig; children?: ReactNode }) {
  const rows = effective(config);
  const source = { default: 'Installation defaults', label: 'The label’s own agents', repository: 'This repository only' } as const;
  return (
    <Card data-testid="effective-config">
      <CardHeader>
        <CardTitle>What will run</CardTitle>
        <CardDescription>The effective configuration of this draft: who codes and who reviews, for each repository and label.</CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet: turn on a repository.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-3">Repository</th>
                  <th scope="col" className="py-2 pr-3">Label</th>
                  <th scope="col" className="py-2 pr-3">Coding</th>
                  <th scope="col" className="py-2 pr-3">Review</th>
                  <th scope="col" className="py-2">From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={`${r.repository}:${r.workflow}`} data-testid={`effective-${r.repository}-${r.label}`}>
                    <td className="py-2 pr-3">
                      {r.repository}
                      {r.paused && <span className="text-muted-foreground"> (paused)</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <code>{r.label}</code>
                    </td>
                    <td className="py-2 pr-3">{r.coding.join(', ') || '—'}</td>
                    <td className="py-2 pr-3">{r.review.join(', ') || 'No automated review'}</td>
                    <td className="py-2 text-muted-foreground">{source[r.source]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {children}
      </CardBody>
    </Card>
  );
}

/** An info icon with a tooltip, shown on hover and on focus (so a tap shows it too); clicking it may act. */
function InfoTip({ label, text, onClick, hidden }: { label: string; text: string; onClick?: () => void; hidden?: boolean }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-label={label} aria-describedby={id} onClick={onClick} className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
          <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.25v3.25a.75.75 0 0 0 1.5 0V9.75A.75.75 0 0 0 10 9H9Z" clipRule="evenodd" />
        </svg>
      </button>
      <span
        role="tooltip"
        id={id}
        className={`pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-64 rounded-md ${hidden ? 'hidden' : ''} bg-foreground px-3 py-2 text-xs leading-snug text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100`}
      >
        {text}
      </span>
    </span>
  );
}
