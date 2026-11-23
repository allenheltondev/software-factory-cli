import { useState } from 'react';
import { Alert, Button, Card, CardBody, CardDescription, CardHeader, CardTitle, EmptyState, Input, SegmentedControl, Select, StatusBadge } from '@readysetcloud/ui';
import type { AgentAdapter, ConfigIssue, ConfigView, ConsoleAgent, ConsoleConfig, ConsoleRepository, ConsoleWorkflow, MergeMethod } from '../../api/client';
import { installationSettingsUrl } from '../../lib/diagnostics';
import { Check, FieldError, ParsedText, PromptField } from './fields';
import { InlineKey, type KeyApi } from './InlineKey';
import {
  AGENT_LABEL,
  DEFAULT_OFFERED,
  enabledAgents,
  freeName,
  issuesAt,
  KEY_FOR,
  NAME,
  NAME_RULE,
  newRepository,
  newWorkflow,
  numberOrUndefined,
  parseLines,
  parseLogins,
  poolsOf,
  reviews,
  sectionOf,
  workflowConflict,
  type Section,
} from './model';

const MERGE_METHODS: { value: MergeMethod; label: string }[] = [
  { value: 'squash', label: 'Squash and merge' },
  { value: 'merge', label: 'Merge commit' },
  { value: 'rebase', label: 'Rebase and merge' },
];

export interface EditorProps {
  config: ConsoleConfig;
  onChange: (next: ConsoleConfig) => void;
  view: ConfigView;
  errors: ConfigIssue[];
  installationId: number;
  keyApi: KeyApi;
  onKeys: (keys: Record<string, boolean>) => void;
  /** Ask before turning auto-merge on for this repository. */
  onAskAutoMerge: (repo: string) => void;
  /** Bumped when the draft is replaced (a reload), so typed text fields start over. */
  generation: number;
  section: Section;
  onSection: (s: Section) => void;
}

/** The full editor: repositories, workflows, and the agents and pools they run. */
export function ConfigEditor(props: EditorProps) {
  const { errors, section, onSection } = props;
  const count = (s: Section) => errors.filter((e) => sectionOf(e.path) === s).length;
  const label = (s: Section, text: string) => (count(s) ? `${text} (${count(s)})` : text);
  return (
    <div className="flex flex-col gap-6">
      <SegmentedControl<Section>
        aria-label="Section"
        value={section}
        onChange={onSection}
        options={[
          { value: 'repositories', label: label('repositories', 'Repositories') },
          { value: 'workflows', label: label('workflows', 'Workflows') },
          { value: 'agents', label: label('agents', 'Agents and pools') },
        ]}
      />
      {section === 'repositories' && <RepositoriesSection {...props} />}
      {section === 'workflows' && <WorkflowsSection {...props} />}
      {section === 'agents' && <AgentsSection {...props} />}
    </div>
  );
}

function RepositoriesSection({ config, onChange, view, errors, onAskAutoMerge, generation }: EditorProps) {
  const ceilings = view.limits.ceilings;
  const workflowNames = Object.keys(config.workflows);
  const reachable = new Set(view.repositories.map((r) => r.fullName.toLowerCase()));
  const configuredLower = new Set(Object.keys(config.repositories).map((n) => n.toLowerCase()));
  const unreachable = Object.keys(config.repositories).filter((n) => !reachable.has(n.toLowerCase()));
  const rows = [...view.repositories.map((r) => r.fullName), ...unreachable];

  const setRepo = (name: string, next: ConsoleRepository | null) => {
    const repositories = { ...config.repositories };
    if (next) repositories[name] = next;
    else delete repositories[name];
    onChange({ ...config, repositories });
  };
  const patch = (name: string, p: Partial<ConsoleRepository>) => {
    const next: ConsoleRepository = { ...config.repositories[name]!, ...p };
    for (const k of Object.keys(p) as (keyof ConsoleRepository)[]) if (p[k] === undefined) delete next[k];
    setRepo(name, next);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Who can start work</CardTitle>
          <CardDescription>Only these GitHub logins start a job by labeling an issue, and only their change requests are acted on. A repository can name its own list.</CardDescription>
        </CardHeader>
        <CardBody>
          <ParsedText
            key={`actors-${generation}`}
            label="Allowed actors"
            hint="GitHub logins, separated by commas or spaces"
            value={config.allowedActors}
            parse={parseLogins}
            format={(v) => v.join(', ')}
            error={issuesAt(errors, 'allowedActors')}
            onChange={(allowedActors) => onChange({ ...config, allowedActors })}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <CardDescription>
            Turn on the repositories Updraft works in, and choose which workflows' labels start work there.{' '}
            <a className="auth-link" href={installationSettingsUrl(view.tenant)} target="_blank" rel="noreferrer">
              Give the App more repositories ↗
            </a>
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <FieldError message={issuesAt(errors, 'repositories') && !errors.some((e) => e.path.startsWith('repositories.')) ? issuesAt(errors, 'repositories') : undefined} />
          {rows.length === 0 && <EmptyState title="No repositories yet" description="The Updraft App cannot reach any repository. Choose some on GitHub, in the installation settings." />}
          {rows.map((name) => {
            const repo = config.repositories[name];
            const path = `repositories.${name}`;
            const on = !!repo || configuredLower.has(name.toLowerCase());
            return (
              <section key={`${name}-${generation}`} className="flex flex-col gap-4 rounded-lg border border-border p-4" data-testid={`repo-${name}`} aria-label={name}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 font-semibold">
                    <input type="checkbox" aria-label={`Work in ${name}`} checked={on} onChange={(e) => setRepo(name, e.target.checked ? newRepository(workflowNames.slice(0, 1)) : null)} />
                    {name}
                    {repo && <StatusBadge tone={repo.enabled ? 'success' : 'warning'}>{repo.enabled ? 'On' : 'Paused'}</StatusBadge>}
                    {!reachable.has(name.toLowerCase()) && <StatusBadge tone="error">No access</StatusBadge>}
                  </label>
                  {repo && (
                    <Button variant="secondary" size="sm" type="button" onClick={() => patch(name, { enabled: !repo.enabled })}>
                      {repo.enabled ? 'Pause' : 'Resume'}
                    </Button>
                  )}
                </div>
                {repo && (
                  <>
                    <FieldError message={issuesAt(errors, path) && !errors.some((e) => e.path.startsWith(`${path}.`)) ? issuesAt(errors, path) : undefined} />
                    <div className="flex flex-col gap-2">
                      <h4 className="text-sm font-medium">Labels that start work here</h4>
                      <div className="flex flex-wrap gap-x-6 gap-y-2">
                        {workflowNames.map((w) => (
                          <Check
                            key={w}
                            checked={repo.workflows.includes(w)}
                            onChange={(v) => patch(name, { workflows: v ? [...repo.workflows, w] : repo.workflows.filter((x) => x !== w), ...(v || reviews(config, { ...repo, workflows: repo.workflows.filter((x) => x !== w) }) ? {} : { autoMerge: undefined }) })}
                          >
                            <code>{config.workflows[w]!.label || '(no label)'}</code> runs <strong>{w}</strong>
                          </Check>
                        ))}
                      </div>
                      <FieldError message={workflowConflict(config, repo) ?? issuesAt(errors, `${path}.workflows`)} />
                    </div>

                    <ParsedText
                      multiline
                      label="Verify commands"
                      hint="One per line, run in this repository after the agent; the first that fails fails the run, so nothing is published"
                      placeholder={'npm ci\nnpm test'}
                      value={repo.verify}
                      parse={parseLines}
                      format={(v) => v.join('\n')}
                      error={issuesAt(errors, `${path}.verify`)}
                      onChange={(verify) => patch(name, { verify, ...(verify.length ? {} : { verifyTimeoutMinutes: undefined }) })}
                    />

                    <details className="flex flex-col gap-4">
                      <summary className="cursor-pointer text-sm font-medium">More settings</summary>
                      <div className="mt-4 flex flex-col gap-4">
                        <div className="grid gap-4 sm:grid-cols-3">
                          <Select label="Publish as" value={repo.publish} error={issuesAt(errors, `${path}.publish`)} onChange={(e) => patch(name, { publish: e.target.value as ConsoleRepository['publish'] })}>
                            <option value="draft-pr">Draft pull request</option>
                            <option value="pr">Pull request, ready for review</option>
                          </Select>
                          <Input label="Base branch" hint="Empty: the default branch" value={repo.baseBranch ?? ''} error={issuesAt(errors, `${path}.baseBranch`)} onChange={(e) => patch(name, { baseBranch: e.target.value || undefined })} />
                          <Input
                            label="Verify time limit (minutes)"
                            type="number"
                            min={1}
                            max={ceilings.verifyTimeoutMinutes}
                            placeholder="15"
                            hint={`All commands together, up to ${ceilings.verifyTimeoutMinutes}`}
                            disabled={!repo.verify.length}
                            value={repo.verifyTimeoutMinutes?.toString() ?? ''}
                            error={issuesAt(errors, `${path}.verifyTimeoutMinutes`)}
                            onChange={(e) => patch(name, { verifyTimeoutMinutes: numberOrUndefined(e.target.value) })}
                          />
                        </div>
                        <Check checked={repo.commentOnFailure} onChange={(commentOnFailure) => patch(name, { commentOnFailure })}>
                          Comment on the issue when a run fails
                        </Check>
                        <Check checked={repo.allowedActors !== undefined} onChange={(v) => patch(name, { allowedActors: v ? [...config.allowedActors] : undefined })}>
                          Use a different list of people who can start work here
                        </Check>
                        {repo.allowedActors !== undefined && (
                          <ParsedText
                            label="Allowed actors in this repository"
                            hint="GitHub logins, separated by commas or spaces"
                            value={repo.allowedActors}
                            parse={parseLogins}
                            format={(v) => v.join(', ')}
                            error={repo.allowedActors.length === 0 ? 'Name at least one GitHub login' : issuesAt(errors, `${path}.allowedActors`)}
                            onChange={(allowedActors) => patch(name, { allowedActors })}
                          />
                        )}
                        <AutoMerge name={name} repo={repo} reviewed={reviews(config, repo)} errors={errors} ceiling={ceilings.autoMergeWaitMinutes} patch={(p) => patch(name, p)} onAsk={() => onAskAutoMerge(name)} />
                      </div>
                    </details>
                  </>
                )}
              </section>
            );
          })}
        </CardBody>
      </Card>
    </>
  );
}

export function AutoMerge({ name, repo, reviewed, errors, ceiling, patch, onAsk }: { name: string; repo: ConsoleRepository; reviewed: boolean; errors: ConfigIssue[]; ceiling: number; patch: (p: Partial<ConsoleRepository>) => void; onAsk: () => void }) {
  const path = `repositories.${name}.autoMerge`;
  return (
    <div className="flex flex-col gap-2">
      <Check checked={repo.autoMerge !== undefined} disabled={!reviewed} onChange={(v) => (v ? onAsk() : patch({ autoMerge: undefined }))}>
        Auto-merge pull requests the reviewer finds ready
      </Check>
      {!reviewed && <p className="text-sm text-muted-foreground">Needs a workflow here that reviews: Updraft only merges what its own reviewer approved.</p>}
      <FieldError message={issuesAt(errors, path)} />
      {repo.autoMerge && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Select label="Merge method" value={repo.autoMerge.method} onChange={(e) => patch({ autoMerge: { ...repo.autoMerge!, method: e.target.value as MergeMethod } })}>
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
            max={ceiling}
            placeholder="60"
            hint={`Up to ${ceiling}`}
            value={repo.autoMerge.waitMinutes?.toString() ?? ''}
            onChange={(e) => {
              const next = { ...repo.autoMerge!, waitMinutes: numberOrUndefined(e.target.value) };
              if (next.waitMinutes === undefined) delete next.waitMinutes;
              patch({ autoMerge: next });
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
              patch({ autoMerge: next });
            }}
          />
        </div>
      )}
    </div>
  );
}

function WorkflowsSection({ config, onChange, view, errors, generation }: EditorProps) {
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const prompts = view.defaults.prompts;
  const ceilings = view.limits.ceilings;
  const poolNames = Object.keys(config.pools);

  const patch = (name: string, p: Partial<ConsoleWorkflow>) => {
    const next: ConsoleWorkflow = { ...config.workflows[name]!, ...p };
    for (const k of Object.keys(p) as (keyof ConsoleWorkflow)[]) if (p[k] === undefined) delete next[k];
    onChange({ ...config, workflows: { ...config.workflows, [name]: next } });
  };

  function add() {
    const name = newName.trim();
    if (!NAME.test(name)) return setNameError(NAME_RULE);
    if (Object.hasOwn(config.workflows, name)) return setNameError('There is already a workflow with that name');
    setNameError(undefined);
    setNewName('');
    onChange({ ...config, workflows: { ...config.workflows, [name]: newWorkflow(config, prompts, `updraft:${name}`) } });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workflows</CardTitle>
        <CardDescription>A workflow is what a label starts: which pool does the work, with which prompt, and how its pull requests are reviewed and revised.</CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <FieldError message={issuesAt(errors, 'workflows') && !errors.some((e) => e.path.startsWith('workflows.')) ? issuesAt(errors, 'workflows') : undefined} />
        {Object.entries(config.workflows).map(([name, w]) => {
          const path = `workflows.${name}`;
          const usedBy = Object.entries(config.repositories).filter(([, r]) => r.workflows.includes(name)).map(([n]) => n);
          const reviewers = enabledAgents(config, w.review.pool);
          const selfReviewNeeded = w.review.enabled && enabledAgents(config, w.pool).some((b) => reviewers.length > 0 && reviewers.every((r) => r === b));
          return (
            <section key={`${name}-${generation}`} className="flex flex-col gap-4 rounded-lg border border-border p-4" data-testid={`workflow-${name}`} aria-label={`Workflow ${name}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col">
                  <h3 className="font-mono font-semibold">{name}</h3>
                  <span className="text-sm text-muted-foreground">{usedBy.length ? `Runs in ${usedBy.join(', ')}` : 'No repository runs it yet'}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={usedBy.length > 0 || Object.keys(config.workflows).length === 1}
                  title={usedBy.length ? 'A repository runs it' : undefined}
                  onClick={() => {
                    const rest = { ...config.workflows };
                    delete rest[name];
                    onChange({ ...config, workflows: rest });
                  }}
                >
                  Remove
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Input label="Label" hint="Applied to an issue, it starts this workflow" value={w.label} error={issuesAt(errors, `${path}.label`)} onChange={(e) => patch(name, { label: e.target.value })} />
                <Select label="Built by" value={w.pool} error={issuesAt(errors, `${path}.pool`)} onChange={(e) => patch(name, { pool: e.target.value })}>
                  {poolNames.map((p) => (
                    <option key={p} value={p}>
                      {p} ({enabledAgents(config, p).join(', ') || 'no agent on'})
                    </option>
                  ))}
                </Select>
                <Input
                  label="Agent time limit (minutes)"
                  type="number"
                  min={1}
                  max={ceilings.timeoutMinutes}
                  placeholder="60"
                  hint={`Up to ${ceilings.timeoutMinutes}`}
                  value={w.timeoutMinutes?.toString() ?? ''}
                  error={issuesAt(errors, `${path}.timeoutMinutes`)}
                  onChange={(e) => patch(name, { timeoutMinutes: numberOrUndefined(e.target.value) })}
                />
              </div>

              <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3">
                <h4 className="text-sm font-medium">Pull requests</h4>
                <Check testId={`review-${name}`} checked={w.review.enabled} onChange={(enabled) => patch(name, { review: { ...w.review, enabled } })}>
                  Review every pull request: an agent other than the one that wrote it approves it or asks for changes
                </Check>
                {w.review.enabled && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Select label="Reviewed by" value={w.review.pool} error={issuesAt(errors, `${path}.review.pool`)} onChange={(e) => patch(name, { review: { ...w.review, pool: e.target.value } })}>
                      {poolNames.map((p) => (
                        <option key={p} value={p}>
                          {p} ({enabledAgents(config, p).join(', ') || 'no agent on'})
                        </option>
                      ))}
                    </Select>
                    <div className="flex flex-col justify-end gap-1">
                      <Check checked={w.review.allowSameAgent} onChange={(allowSameAgent) => patch(name, { review: { ...w.review, allowSameAgent } })}>
                        Let an agent review its own work when no other reviewer is available
                      </Check>
                      {selfReviewNeeded && !w.review.allowSameAgent && <p className="text-sm text-error">An agent would only ever review its own work: add another agent to {w.review.pool}, or allow this.</p>}
                    </div>
                  </div>
                )}
                <Check checked={w.revise.enabled} onChange={(enabled) => patch(name, { revise: { ...w.revise, enabled } })}>
                  Revise: the builder makes the changes a review or an allowed actor asks for
                </Check>
                {w.revise.enabled && (
                  <div className="sm:w-1/3">
                    <Input
                      label="Revision rounds per pull request"
                      type="number"
                      min={1}
                      max={ceilings.maxRevisions}
                      placeholder="3"
                      hint={`Up to ${ceilings.maxRevisions}`}
                      value={w.revise.maxRevisions?.toString() ?? ''}
                      error={issuesAt(errors, `${path}.revise.maxRevisions`)}
                      onChange={(e) => {
                        const revise = { ...w.revise, maxRevisions: numberOrUndefined(e.target.value) };
                        if (revise.maxRevisions === undefined) delete revise.maxRevisions;
                        patch(name, { revise });
                      }}
                    />
                  </div>
                )}
              </div>

              <details open={!!issuesAt(errors, `${path}.prompt`) || !!issuesAt(errors, `${path}.review.prompt`) || !!issuesAt(errors, `${path}.revise.prompt`) || undefined}>
                <summary className="cursor-pointer text-sm font-medium">
                  Customize prompts{' '}
                  <span className="font-normal text-muted-foreground">
                    ({[w.prompt === prompts.implement, w.review.prompt === prompts.review, w.revise.prompt === prompts.revise].every(Boolean) ? 'all packaged' : 'edited'})
                  </span>
                </summary>
                <div className="mt-4 flex flex-col gap-4">
                  <PromptField label="Build prompt" value={w.prompt} packaged={w.prompt === prompts.implement} error={issuesAt(errors, `${path}.prompt`)} onChange={(prompt) => patch(name, { prompt })} onReset={() => patch(name, { prompt: prompts.implement })} />
                  <PromptField
                    label="Review prompt"
                    value={w.review.prompt}
                    packaged={w.review.prompt === prompts.review}
                    error={issuesAt(errors, `${path}.review.prompt`)}
                    onChange={(prompt) => patch(name, { review: { ...w.review, prompt } })}
                    onReset={() => patch(name, { review: { ...w.review, prompt: prompts.review } })}
                  />
                  <PromptField
                    label="Revision prompt"
                    value={w.revise.prompt}
                    packaged={w.revise.prompt === prompts.revise}
                    error={issuesAt(errors, `${path}.revise.prompt`)}
                    onChange={(prompt) => patch(name, { revise: { ...w.revise, prompt } })}
                    onReset={() => patch(name, { revise: { ...w.revise, prompt: prompts.revise } })}
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
            add();
          }}
        >
          <div className="min-w-0 flex-1">
            <Input label="New workflow name" placeholder="docs" value={newName} error={nameError} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <Button variant="secondary" type="submit">
            Add workflow
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function AgentsSection({ config, onChange, view, errors, installationId, keyApi, onKeys, generation }: EditorProps) {
  const offered = view.agents ?? DEFAULT_OFFERED;
  const [adding, setAdding] = useState<AgentAdapter>(offered[0] ?? 'claude');
  const [poolName, setPoolName] = useState('');
  const [poolError, setPoolError] = useState<string | undefined>();
  const usage = (pool: string) =>
    Object.entries(config.workflows).flatMap(([n, w]) => [...(w.pool === pool ? [`${n} builds`] : []), ...(w.review.enabled && w.review.pool === pool ? [`${n} reviews`] : [])]);
  const inPools = (agent: string) => Object.entries(config.pools).filter(([, p]) => p.agents.includes(agent)).map(([n]) => n);
  const running = new Set(Object.values(config.workflows).flatMap(poolsOf));

  const patchAgent = (name: string, p: Partial<ConsoleAgent>) => {
    const next: ConsoleAgent = { ...config.agents[name]!, ...p };
    for (const k of Object.keys(p) as (keyof ConsoleAgent)[]) if (p[k] === undefined) delete next[k];
    onChange({ ...config, agents: { ...config.agents, [name]: next } });
  };
  const setMember = (pool: string, agent: string, member: boolean) => {
    const agents = config.pools[pool]!.agents;
    onChange({ ...config, pools: { ...config.pools, [pool]: { agents: member ? [...agents, agent] : agents.filter((a) => a !== agent) } } });
  };

  function addAgent() {
    const name = freeName(adding, config.agents);
    // A new agent joins every pool, as the defaults do: it takes its turn building and reviewing.
    const pools = Object.fromEntries(Object.entries(config.pools).map(([n, p]) => [n, { agents: [...p.agents, name] }]));
    onChange({ ...config, agents: { ...config.agents, [name]: { adapter: adding, enabled: true } }, pools });
  }
  function addPool() {
    const name = poolName.trim();
    if (!NAME.test(name)) return setPoolError(NAME_RULE);
    if (Object.hasOwn(config.pools, name)) return setPoolError('There is already a pool with that name');
    setPoolError(undefined);
    setPoolName('');
    onChange({ ...config, pools: { ...config.pools, [name]: { agents: Object.keys(config.agents).filter((a) => config.agents[a]!.enabled) } } });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Agents</CardTitle>
          <CardDescription>The coding agents jobs run, each with your own API key. An agent that is off is never chosen and needs no key.</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {Object.entries(config.agents).map(([name, a]) => {
            const path = `agents.${name}`;
            const isOffered = offered.includes(a.adapter);
            const keySet = view.agentKeys[KEY_FOR[a.adapter]] === true;
            const pools = inPools(name);
            return (
              <section key={`${name}-${generation}`} className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid={`agent-${name}`} aria-label={`Agent ${name}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono font-semibold">{name}</h3>
                    <span className="text-sm text-muted-foreground">{AGENT_LABEL[a.adapter]}</span>
                    {!isOffered ? (
                      <StatusBadge tone="error">Not offered here</StatusBadge>
                    ) : keySet ? (
                      <StatusBadge tone="success">Key set</StatusBadge>
                    ) : (
                      <StatusBadge tone={a.enabled ? 'warning' : 'neutral'}>No key</StatusBadge>
                    )}
                    <span className="text-sm text-muted-foreground">{pools.length ? `In ${pools.join(', ')}` : 'In no pool'}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Check checked={a.enabled} onChange={(enabled) => patchAgent(name, { enabled })}>
                      On
                    </Check>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={pools.length > 0}
                      title={pools.length ? 'Take it out of every pool first' : undefined}
                      onClick={() => {
                        const rest = { ...config.agents };
                        delete rest[name];
                        onChange({ ...config, agents: rest });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <FieldError message={issuesAt(errors.filter((e) => e.path === path || e.path === `${path}.adapter` || e.path === `${path}.enabled`), path)} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Model" hint="Empty: the agent's default" value={a.model ?? ''} error={issuesAt(errors, `${path}.model`)} onChange={(e) => patchAgent(name, { model: e.target.value || undefined })} />
                  <Input label="Reasoning effort" hint="For example low, medium or high" list="effort-levels" value={a.effort ?? ''} error={issuesAt(errors, `${path}.effort`)} onChange={(e) => patchAgent(name, { effort: e.target.value || undefined })} />
                </div>
                {isOffered && a.enabled && !keySet && <InlineKey adapter={a.adapter} installationId={installationId} api={keyApi} onSaved={onKeys} />}
              </section>
            );
          })}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <Select label="Add an agent" value={adding} onChange={(e) => setAdding(e.target.value as AgentAdapter)} hint="For example a second Claude on another model; it joins every pool">
                {offered.map((o) => (
                  <option key={o} value={o}>
                    {AGENT_LABEL[o]}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="secondary" type="button" onClick={addAgent}>
              Add agent
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pools</CardTitle>
          <CardDescription>Agents in a pool take turns. A reviewer is never the agent that wrote the code, so a pool of several agents reviews each one's work with another.</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {Object.entries(config.pools).map(([name, p]) => {
            const used = usage(name);
            return (
              <section key={name} className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid={`pool-${name}`} aria-label={`Pool ${name}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono font-semibold">{name}</h3>
                    <span className="text-sm text-muted-foreground">{used.length ? used.join(', ') : 'No workflow uses it'}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={running.has(name)}
                    title={running.has(name) ? 'A workflow uses it' : undefined}
                    onClick={() => {
                      const rest = { ...config.pools };
                      delete rest[name];
                      onChange({ ...config, pools: rest });
                    }}
                  >
                    Remove
                  </Button>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {Object.entries(config.agents).map(([agent, a]) => (
                    <Check key={agent} checked={p.agents.includes(agent)} onChange={(v) => setMember(name, agent, v)}>
                      <span className={a.enabled ? '' : 'line-through'}>{agent}</span>
                    </Check>
                  ))}
                </div>
                <FieldError message={issuesAt(errors, `pools.${name}`)} />
              </section>
            );
          })}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addPool();
            }}
          >
            <div className="min-w-0 flex-1">
              <Input label="New pool name" placeholder="fast" value={poolName} error={poolError} onChange={(e) => setPoolName(e.target.value)} />
            </div>
            <Button variant="secondary" type="submit">
              Add pool
            </Button>
          </form>
        </CardBody>
      </Card>
      {Object.values(config.agents).some((a) => !offered.includes(a.adapter)) && (
        <Alert variant="info">An agent marked "Not offered here" is one Updraft Cloud no longer runs: take it out of the pools your workflows use, then remove it.</Alert>
      )}
    </>
  );
}
