import { useId, useState } from 'react';
import { Button, Card, CardBody, CardDescription, CardHeader, CardTitle, EmptyState, Input, Select } from '@readysetcloud/ui';
import type { AgentAdapter, ConfigIssue, ConfigView, ConsoleConfig, ConsoleRepository, ConsoleWorkflow } from '../../api/client';
import { KiroNotEnabled } from '../../components/kiro';
import { AGENT_GUIDES } from '../../lib/agentGuides';
import { installationSettingsUrl } from '../../lib/diagnostics';
import { AutoMerge, CiRepair } from './Editor';
import { Check, FieldError, ParsedText, PromptField } from './fields';
import { InlineKey, type KeyApi } from './InlineKey';
import { AGENT_LABEL, DEFAULT_OFFERED, issuesAt, KEY_FOR, newRepository, numberOrUndefined, parseLogins, withoutUnreviewedCi } from './model';

export const CODING = 'builders';
export const REVIEW = 'reviewers';

/**
 * Whether the simple page can show this configuration exactly: one workflow, which every
 * configured repository runs, coding agents in `builders` and review agents in `reviewers`, one
 * agent per provider. Anything else is shown in the full editor.
 */
export function isSimple(config: ConsoleConfig): boolean {
  const names = Object.keys(config.workflows);
  if (names.length !== 1) return false;
  const w = config.workflows[names[0]!]!;
  if (w.pool !== CODING || (w.review.enabled && w.review.pool !== REVIEW)) return false;
  if (Object.keys(config.pools).some((p) => p !== CODING && p !== REVIEW)) return false;
  if (Object.entries(config.agents).some(([name, a]) => name !== a.adapter)) return false;
  return Object.values(config.repositories).every((r) => r.workflows.length === 1 && r.workflows[0] === names[0]);
}

export interface SimpleProps {
  config: ConsoleConfig;
  onChange: (next: ConsoleConfig) => void;
  view: ConfigView;
  errors: ConfigIssue[];
  installationId: number;
  keyApi: KeyApi;
  onKeys: (keys: Record<string, boolean>) => void;
  onAskAutoMerge: (repo: string) => void;
  /** Leave for the full editor: more labels, pools, models per pool. */
  onOpenFull: () => void;
  generation: number;
}

/** What stops a publish, in words, before the server is asked: empty when the page is ready. */
export function simpleBlockers(config: ConsoleConfig, view: ConfigView): string[] {
  const w = Object.values(config.workflows)[0];
  const out: string[] = [];
  if (!w?.label.trim()) out.push('Choose the label that starts work.');
  if (config.allowedActors.length === 0) out.push('Name at least one person who can add it.');
  if (Object.keys(config.repositories).length === 0) out.push('Turn on at least one repository.');
  const on = (pool: string) => (config.pools[pool]?.agents ?? []).filter((a) => config.agents[a]?.enabled);
  if (on(CODING).length === 0) out.push('Choose at least one coding agent.');
  // An agent the configuration still runs whose key was removed: the person puts the key back or
  // unticks it. The page never changes that for them (a review policy would change unseen).
  const keyless = [...new Set([...on(CODING), ...(w?.review.enabled ? on(REVIEW) : [])])].filter((a) => !view.agentKeys[KEY_FOR[config.agents[a]!.adapter]]);
  if (keyless.length) out.push(`Add the key for ${keyless.map((a) => AGENT_LABEL[config.agents[a]!.adapter]).join(' and ')}, or untick it.`);
  return out;
}

/**
 * The configuration as one short page: the label and who may add it, the repositories, the
 * coding agents and the review agents. It writes the same settings as the full editor.
 */
export function SimpleConfig({ config, onChange, view, errors, installationId, keyApi, onKeys, onAskAutoMerge, onOpenFull, generation }: SimpleProps) {
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState<string | null>(null);
  const wfName = Object.keys(config.workflows)[0]!;
  const w = config.workflows[wfName]!;
  const prompts = view.defaults.prompts;
  const ceilings = view.limits.ceilings;
  const adapters = [...new Set<AgentAdapter>([...(view.agents ?? DEFAULT_OFFERED), ...Object.values(config.agents).map((a) => a.adapter)])];
  const [keyOpen, setKeyOpen] = useState<string | null>(null);
  const keySet = (a: AgentAdapter) => view.agentKeys[KEY_FOR[a]] === true;
  const offered = (a: AgentAdapter) => (view.agents ?? DEFAULT_OFFERED).includes(a);
  /** An agent can be ticked only once its key is set (and Updraft Cloud still runs it). */
  const usable = (a: string) => offered(a as AgentAdapter) && keySet(a as AgentAdapter);
  const ticked = (pool: string) => (config.pools[pool]?.agents ?? []).filter((a) => config.agents[a]?.enabled);
  // As saved, whether or not the key is set: a ticked agent without its key stays ticked (and can
  // be unticked), so a missing key never changes what is published without the person seeing it.
  const coding = ticked(CODING);
  const review = w.review.enabled ? ticked(REVIEW) : [];

  const setWorkflow = (p: Partial<ConsoleWorkflow>) => onChange({ ...config, workflows: { [wfName]: { ...w, ...p } } });

  /** The coding and review agents as ticked: pools, which agents are on, and whether review runs. */
  function setTeam(nextCoding: string[], nextReview: string[]) {
    const agents = { ...config.agents };
    for (const a of adapters) {
      const on = nextCoding.includes(a) || nextReview.includes(a);
      if (on) agents[a] = { ...(agents[a] ?? { adapter: a }), enabled: true };
      else if (agents[a]) agents[a] = { ...agents[a]!, enabled: false };
    }
    const order = (list: string[]) => adapters.filter((a) => list.includes(a));
    const pools: ConsoleConfig['pools'] = { [CODING]: { agents: order(nextCoding) } };
    if (nextReview.length) pools[REVIEW] = { agents: order(nextReview) };
    // With one review agent, it reviews whatever it wrote itself: there is no one else.
    const reviewSettings = { ...w.review, enabled: nextReview.length > 0, pool: REVIEW, allowSameAgent: nextReview.length < 2 };
    onChange(withoutUnreviewedCi({ ...config, agents, pools, workflows: { [wfName]: { ...w, review: reviewSettings } } }));
  }

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

  /** A key was saved from a row: an agent that was in neither list now codes and reviews, as the defaults have it. */
  const keySaved = (a: AgentAdapter) => (keys: Record<string, boolean>) => {
    onKeys(keys);
    setKeyOpen(null);
    if (keys[KEY_FOR[a]] && !coding.includes(a) && !review.includes(a)) setTeam([...coding, a], [...review, a]);
  };

  /** The agent's label, and for one that cannot be ticked, why, and where its key goes. */
  const agentLine = (a: AgentAdapter, list: 'coding' | 'review', on: boolean, onToggle: (v: boolean) => void) => {
    const id = `${list}:${a}`;
    return (
      <div className="flex items-center gap-2">
        <Check checked={on} disabled={!usable(a) && !on} onChange={onToggle}>
          <span className="font-medium">{AGENT_LABEL[a]}</span>
        </Check>
        {!usable(a) && (
          <InfoTip
            label={`Why ${AGENT_LABEL[a]} cannot be used`}
            text={
              !offered(a)
                ? `Updraft Cloud no longer runs ${AGENT_LABEL[a]}.${on ? ' Untick it.' : ''}`
                : on
                  ? `${AGENT_LABEL[a]}'s ${AGENT_GUIDES[a].credential} was removed. Add it again, or untick ${AGENT_LABEL[a]}. Click to add it.`
                  : `Add your ${AGENT_GUIDES[a].credential} to use ${AGENT_LABEL[a]}. Click to add it.`
            }
            hidden={keyOpen === id}
            onClick={offered(a) ? () => setKeyOpen(keyOpen === id ? null : id) : undefined}
          />
        )}
      </div>
    );
  };
  const keyForm = (a: AgentAdapter, list: 'coding' | 'review') =>
    keyOpen === `${list}:${a}` && !keySet(a) ? <InlineKey adapter={a} installationId={installationId} api={keyApi} onSaved={keySaved(a)} /> : null;

  const reachable = new Set(view.repositories.map((r) => r.fullName.toLowerCase()));
  const rows = [...view.repositories.map((r) => r.fullName), ...Object.keys(config.repositories).filter((n) => !reachable.has(n.toLowerCase()))];
  const selfReview = review.length === 1 && coding.includes(review[0]!);

  return (
    <div className="flex flex-col gap-6" data-testid="simple-config">
      <Card>
        <CardHeader>
          <CardTitle>Starting work</CardTitle>
          <CardDescription>When one of these people adds the label to an issue, a coding agent picks it up and opens a pull request.</CardDescription>
        </CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input label="Label" value={w.label} error={issuesAt(errors, `workflows.${wfName}.label`)} onChange={(e) => setWorkflow({ label: e.target.value })} />
          <ParsedText
            key={`actors-${generation}`}
            label="Who can add it"
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
            Checks run after the agent; if they fail, nothing is published.{' '}
            <a className="auth-link" href={installationSettingsUrl(view.tenant)} target="_blank" rel="noreferrer">
              Give the App more repositories ↗
            </a>
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col divide-y divide-border">
          {rows.length === 0 && <EmptyState title="No repositories yet" description="The Updraft App cannot reach any repository. Choose some on GitHub, in the installation settings." />}
          {rows.map((name) => {
            const repo = config.repositories[name];
            const path = `repositories.${name}`;
            const open = settingsOpen === name;
            return (
              <section key={`${name}-${generation}`} className="flex flex-col gap-3 py-3" data-testid={`repo-${name}`} aria-label={name}>
                <div className={repo ? 'grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end' : 'flex'}>
                  <label className="flex items-center gap-2 font-medium sm:pb-2">
                    <input type="checkbox" className="h-4 w-4 shrink-0" aria-label={`Work in ${name}`} checked={!!repo} onChange={(e) => setRepo(name, e.target.checked ? newRepository([wfName], w.review.enabled) : null)} />
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
                    <CiRepair name={name} repo={repo} reviewed={w.review.enabled} revised={w.revise.enabled} maxRevisions={w.revise.maxRevisions} errors={errors} ceiling={ceilings.ciWaitMinutes ?? ceilings.autoMergeWaitMinutes} patch={(p) => patchRepo(name, p)} />
                    <AutoMerge name={name} repo={repo} reviewed={w.review.enabled} errors={errors} ceiling={ceilings.autoMergeWaitMinutes} patch={(p) => patchRepo(name, p)} onAsk={() => onAskAutoMerge(name)} />
                  </div>
                )}
              </section>
            );
          })}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Coding agents</CardTitle>
          <CardDescription>They take turns picking up issues and writing the code. Each runs with your own API key.</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col divide-y divide-border" data-testid="coding-agents">
          {adapters.map((a) => {
            const on = coding.includes(a);
            const agent = config.agents[a];
            return (
              <div key={a} className="flex flex-col gap-3 py-3" data-testid={`coding-${a}`}>
                <div className="flex flex-wrap items-center gap-3">
                  {agentLine(a, 'coding', on, (v) => setTeam(v ? [...coding, a] : coding.filter((x) => x !== a), review))}
                  {agent?.model && <span className="font-mono text-sm text-muted-foreground">{agent.model}</span>}
                  {agent && usable(a) && (
                    <button type="button" className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setModelOpen(modelOpen === a ? null : a)}>
                      {modelOpen === a ? 'Done' : 'Change model'}
                    </button>
                  )}
                </div>
                {agent && modelOpen === a && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input label="Model" hint={agent.adapter === 'vibe' ? 'Mistral API model ID. Default: mistral-medium-latest' : "For coding and reviewing. Empty: the agent's default"} value={agent.model ?? ''} error={issuesAt(errors, `agents.${a}.model`)} onChange={(e) => onChange({ ...config, agents: { ...config.agents, [a]: { ...agent, model: e.target.value || undefined } } })} />
                    {agent.adapter !== 'vibe' && <Input label="Reasoning effort" hint="For example low, medium or high" list="effort-levels" value={agent.effort ?? ''} error={issuesAt(errors, `agents.${a}.effort`)} onChange={(e) => onChange({ ...config, agents: { ...config.agents, [a]: { ...agent, effort: e.target.value || undefined } } })} />}
                  </div>
                )}
                {keyForm(a, 'coding')}
                <FieldError message={issuesAt(errors.filter((e) => e.path === `agents.${a}` || e.path === `agents.${a}.adapter`), `agents.${a}`)} />
              </div>
            );
          })}
          {!offered('kiro') && (
            <div className="py-3">
              <KiroNotEnabled />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review agents</CardTitle>
          <CardDescription>Each pull request gets one of them, never the agent that wrote it. Tick none to skip review.</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col divide-y divide-border" data-testid="review-agents">
          {adapters.map((a) => {
            const on = review.includes(a);
            return (
              <div key={a} className="flex flex-col gap-3 py-3" data-testid={`review-${a}`}>
                {agentLine(a, 'review', on, (v) => setTeam(coding, v ? [...review, a] : review.filter((x) => x !== a)))}
                {keyForm(a, 'review')}
              </div>
            );
          })}
        </CardBody>
        <CardBody className="flex flex-col gap-2 border-t border-border bg-muted/30">
          {selfReview && <p className="text-sm text-muted-foreground">{AGENT_LABEL[config.agents[review[0]!]!.adapter]} reviews its own work when it wrote the code. Tick a second review agent for a second opinion.</p>}
          {!w.review.enabled && <p className="text-sm text-muted-foreground">No review: pull requests wait for a person.</p>}
          <Check checked={w.revise.enabled} onChange={(enabled) => setWorkflow({ revise: { ...w.revise, enabled } })}>
            Coding agents make the changes {w.review.enabled ? 'a review asks for' : 'your people ask for in a review'}
          </Check>
        </CardBody>
      </Card>

      <details className="rounded-lg border border-border p-4" open={errors.some((e) => /\.(prompt|timeoutMinutes|maxRevisions)/.test(e.path)) || undefined}>
        <summary className="cursor-pointer text-sm font-medium">
          Advanced <span className="font-normal text-muted-foreground">· prompts, revision rounds, time limit, more labels</span>
        </summary>
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Agent time limit (minutes)"
              type="number"
              min={1}
              max={ceilings.timeoutMinutes}
              placeholder="60"
              hint={`Up to ${ceilings.timeoutMinutes}`}
              value={w.timeoutMinutes?.toString() ?? ''}
              error={issuesAt(errors, `workflows.${wfName}.timeoutMinutes`)}
              onChange={(e) => {
                const timeoutMinutes = numberOrUndefined(e.target.value);
                const next = { ...w, timeoutMinutes };
                if (timeoutMinutes === undefined) delete next.timeoutMinutes;
                onChange({ ...config, workflows: { [wfName]: next } });
              }}
            />
            <Input
              label="Revision rounds per pull request"
              type="number"
              min={1}
              max={ceilings.maxRevisions}
              placeholder="3"
              hint={`Up to ${ceilings.maxRevisions}`}
              disabled={!w.revise.enabled}
              value={w.revise.maxRevisions?.toString() ?? ''}
              error={issuesAt(errors, `workflows.${wfName}.revise.maxRevisions`)}
              onChange={(e) => {
                const revise = { ...w.revise, maxRevisions: numberOrUndefined(e.target.value) };
                if (revise.maxRevisions === undefined) delete revise.maxRevisions;
                setWorkflow({ revise });
              }}
            />
          </div>
          <PromptField label="Coding prompt" value={w.prompt} packaged={w.prompt === prompts.implement} error={issuesAt(errors, `workflows.${wfName}.prompt`)} onChange={(prompt) => setWorkflow({ prompt })} onReset={() => setWorkflow({ prompt: prompts.implement })} />
          <PromptField label="Review prompt" value={w.review.prompt} packaged={w.review.prompt === prompts.review} error={issuesAt(errors, `workflows.${wfName}.review.prompt`)} onChange={(prompt) => setWorkflow({ review: { ...w.review, prompt } })} onReset={() => setWorkflow({ review: { ...w.review, prompt: prompts.review } })} />
          <PromptField label="Revision prompt" value={w.revise.prompt} packaged={w.revise.prompt === prompts.revise} error={issuesAt(errors, `workflows.${wfName}.revise.prompt`)} onChange={(prompt) => setWorkflow({ revise: { ...w.revise, prompt } })} onReset={() => setWorkflow({ revise: { ...w.revise, prompt: prompts.revise } })} />
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button variant="secondary" type="button" onClick={onOpenFull}>
              Open the full editor
            </Button>
            <span className="text-sm text-muted-foreground">For more than one label, named agent pools, or different agents per repository.</span>
          </div>
        </div>
      </details>
    </div>
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
