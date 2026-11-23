import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle, EmptyState, Input, ProgressIndicator, Select, StatusBadge } from '@readysetcloud/ui';
import type { ConfigIssue, ConfigView, ConsoleConfig, ConsoleRepository } from '../../api/client';
import { installationSettingsUrl } from '../../lib/diagnostics';
import { Check, ParsedText } from './fields';
import { InlineKey, type KeyApi } from './InlineKey';
import { AGENT_LABEL, DEFAULT_OFFERED, enabledAgents, KEY_FOR, newRepository, parseLogins } from './model';

type Step = 'repositories' | 'agents' | 'pulls' | 'trigger' | 'publish';
const STEPS: { id: Step; label: string }[] = [
  { id: 'repositories', label: 'Repositories' },
  { id: 'agents', label: 'Agents' },
  { id: 'pulls', label: 'Pull requests' },
  { id: 'trigger', label: 'Label' },
  { id: 'publish', label: 'Publish' },
];

export interface WizardProps {
  config: ConsoleConfig;
  onChange: (next: ConsoleConfig) => void;
  view: ConfigView;
  installationId: number;
  keyApi: KeyApi;
  onKeys: (keys: Record<string, boolean>) => void;
  /** Publishes the draft; the version it became, or null when it was refused (errors are shown). */
  onPublish: () => Promise<number | null>;
  publishing: boolean;
  errors: ConfigIssue[];
  /** Leave the guide for the full editor, keeping the draft. */
  onSkip: () => void;
}

/** Every agent that is on joins both default pools; with fewer than two, one reviews its own work. */
function withSelfReview(config: ConsoleConfig): ConsoleConfig {
  const workflows = Object.fromEntries(
    Object.entries(config.workflows).map(([n, w]) => [n, { ...w, review: { ...w.review, allowSameAgent: enabledAgents(config, w.review.pool).length < 2 } }]),
  );
  return { ...config, workflows };
}

/**
 * The guided first run: from an installation with nothing published to a label that starts
 * work, in five steps. It edits the same draft as the full editor, which it can hand over to at
 * any point.
 */
export function SetupWizard({ config, onChange, view, installationId, keyApi, onKeys, onPublish, publishing, errors, onSkip }: WizardProps) {
  const [step, setStep] = useState<Step>('repositories');
  const [published, setPublished] = useState<number | null>(null);
  const index = STEPS.findIndex((s) => s.id === step);
  const offered = view.agents ?? DEFAULT_OFFERED;
  const workflowName = Object.keys(config.workflows)[0] ?? 'implement';
  const workflow = config.workflows[workflowName]!;
  const selected = Object.keys(config.repositories);
  const agents = Object.entries(config.agents).filter(([, a]) => offered.includes(a.adapter));
  const on = agents.filter(([, a]) => a.enabled);
  const missing = on.filter(([, a]) => !view.agentKeys[KEY_FOR[a.adapter]]);
  const anyRepo = Object.values(config.repositories)[0];

  const setRepos = (names: string[]) => {
    const repositories: Record<string, ConsoleRepository> = {};
    for (const n of names) repositories[n] = config.repositories[n] ?? newRepository([workflowName]);
    onChange({ ...config, repositories });
  };
  const setWorkflow = (p: Partial<typeof workflow>) => onChange({ ...config, workflows: { ...config.workflows, [workflowName]: { ...workflow, ...p } } });
  const setPublish = (publish: ConsoleRepository['publish']) =>
    onChange({ ...config, repositories: Object.fromEntries(Object.entries(config.repositories).map(([n, r]) => [n, { ...r, publish }])) });

  const canContinue: Record<Step, boolean> = {
    repositories: selected.length > 0,
    agents: on.length > 0 && missing.length === 0,
    pulls: true,
    trigger: workflow.label.trim() !== '' && config.allowedActors.length > 0,
    publish: true,
  };
  const go = (to: number) => setStep(STEPS[Math.max(0, Math.min(STEPS.length - 1, to))]!.id);

  if (published !== null) {
    return (
      <Card data-testid="wizard-done">
        <CardHeader>
          <CardTitle>You are set up</CardTitle>
          <CardDescription>Version {published} is active. Add the label to an issue and a builder picks it up within a minute.</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <ol className="list-decimal pl-5 text-sm">
            <li>
              Open an issue in {selected.length === 1 ? selected[0] : 'one of your repositories'} and describe the change.
            </li>
            <li>
              Add the label <code>{workflow.label}</code>.
            </li>
            <li>Updraft opens a pull request{workflow.review.enabled ? ', the reviewers review it' : ''}{workflow.revise.enabled ? ', and the builders make the changes they ask for' : ''}.</li>
          </ol>
          <div className="flex flex-wrap gap-3">
            {selected.map((r) => (
              <a key={r} className="auth-link font-semibold" href={`https://github.com/${r}/issues`} target="_blank" rel="noreferrer">
                {r} issues ↗
              </a>
            ))}
          </div>
        </CardBody>
        <CardFooter className="flex flex-wrap gap-2">
          <Link className="auth-link" to={`/installations/${installationId}`}>
            Back to the installation
          </Link>
          <Button variant="secondary" type="button" onClick={onSkip}>
            Open the full editor
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="wizard">
      <ProgressIndicator steps={STEPS.map((s, i) => ({ id: s.id, label: s.label, status: i < index ? 'completed' : i === index ? 'in-progress' : 'pending' }))} />

      <Card>
        {step === 'repositories' && (
          <>
            <CardHeader>
              <CardTitle>Where should Updraft work?</CardTitle>
              <CardDescription>Choose the repositories whose issues agents may pick up. You can add more later.</CardDescription>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              {view.repositories.length === 0 ? (
                <EmptyState title="The App cannot reach any repository" description="Choose repositories for the Updraft App on GitHub, then come back." />
              ) : (
                view.repositories.map((r) => (
                  <Check key={r.id} checked={selected.includes(r.fullName)} onChange={(v) => setRepos(v ? [...selected, r.fullName] : selected.filter((n) => n !== r.fullName))}>
                    <span className="font-medium">{r.fullName}</span> {r.private && <StatusBadge tone="neutral">Private</StatusBadge>}
                  </Check>
                ))
              )}
              <a className="auth-link text-sm" href={installationSettingsUrl(view.tenant)} target="_blank" rel="noreferrer">
                Not listed? Give the App access on GitHub ↗
              </a>
            </CardBody>
          </>
        )}

        {step === 'agents' && (
          <>
            <CardHeader>
              <CardTitle>Which agents should do the work?</CardTitle>
              <CardDescription>
                Every agent you keep on joins two pools: <strong>builders</strong> take turns writing the code, and <strong>reviewers</strong> take turns reviewing it, never their own work. Jobs run with your own API keys.
              </CardDescription>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              {agents.map(([name, a]) => {
                const keySet = view.agentKeys[KEY_FOR[a.adapter]] === true;
                return (
                  <section key={name} className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid={`wizard-agent-${name}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-semibold">
                        {AGENT_LABEL[a.adapter]}
                        <StatusBadge tone={keySet ? 'success' : a.enabled ? 'warning' : 'neutral'}>{keySet ? 'Key set' : 'No key'}</StatusBadge>
                      </span>
                      <Check checked={a.enabled} onChange={(enabled) => onChange(withSelfReview({ ...config, agents: { ...config.agents, [name]: { ...a, enabled } } }))}>
                        Use {AGENT_LABEL[a.adapter]}
                      </Check>
                    </div>
                    {a.enabled && !keySet && <InlineKey adapter={a.adapter} installationId={installationId} api={keyApi} onSaved={onKeys} />}
                  </section>
                );
              })}
              {on.length === 1 && <Alert variant="info">With one agent, it reviews its own work. Add a second agent's key for a real second opinion.</Alert>}
              {on.length === 0 && <Alert variant="info">Keep at least one agent on.</Alert>}
              {missing.length > 0 && on.length > 0 && <p className="text-sm text-muted-foreground">Add a key for each agent you keep on, or turn it off.</p>}
            </CardBody>
          </>
        )}

        {step === 'pulls' && (
          <>
            <CardHeader>
              <CardTitle>How should pull requests be handled?</CardTitle>
              <CardDescription>Updraft opens a pull request for every issue it works on.</CardDescription>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <Check checked={workflow.review.enabled} onChange={(enabled) => setWorkflow({ review: { ...workflow.review, enabled } })}>
                <strong>Review</strong>: an agent from the reviewers pool reads every pull request and approves it or asks for changes
              </Check>
              <Check checked={workflow.revise.enabled} onChange={(enabled) => setWorkflow({ revise: { ...workflow.revise, enabled } })}>
                <strong>Revise</strong>: the builders make the changes a review, or one of your allowed people, asks for
              </Check>
              <div className="sm:w-1/2">
                <Select label="Open pull requests as" value={anyRepo?.publish ?? 'draft-pr'} onChange={(e) => setPublish(e.target.value as ConsoleRepository['publish'])}>
                  <option value="draft-pr">Drafts (marked ready once the reviewer approves)</option>
                  <option value="pr">Ready for review</option>
                </Select>
              </div>
              <p className="text-sm text-muted-foreground">Verify commands, auto-merge and custom prompts are in the full editor once you are set up.</p>
            </CardBody>
          </>
        )}

        {step === 'trigger' && (
          <>
            <CardHeader>
              <CardTitle>How is work started?</CardTitle>
              <CardDescription>An allowed person adds a label to an issue. Labels from anyone else are ignored.</CardDescription>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <Input label="Label" hint="Updraft creates nothing on GitHub: use a label that exists, or create it there" value={workflow.label} onChange={(e) => setWorkflow({ label: e.target.value })} />
              <ParsedText label="Who can start work" hint="GitHub logins, separated by commas or spaces" value={config.allowedActors} parse={parseLogins} format={(v) => v.join(', ')} error={config.allowedActors.length ? undefined : 'Name at least one GitHub login'} onChange={(allowedActors) => onChange({ ...config, allowedActors })} />
            </CardBody>
          </>
        )}

        {step === 'publish' && (
          <>
            <CardHeader>
              <CardTitle>Ready to go</CardTitle>
              <CardDescription>Publishing makes this the active configuration. Nothing runs until someone labels an issue.</CardDescription>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]" data-testid="wizard-summary">
                <dt className="font-medium">Repositories</dt>
                <dd>{selected.join(', ')}</dd>
                <dt className="font-medium">Builders</dt>
                <dd>{enabledAgents(config, workflow.pool).map((a) => AGENT_LABEL[config.agents[a]!.adapter]).join(', ')}</dd>
                <dt className="font-medium">Reviewers</dt>
                <dd>{workflow.review.enabled ? enabledAgents(config, workflow.review.pool).map((a) => AGENT_LABEL[config.agents[a]!.adapter]).join(', ') : 'No review'}</dd>
                <dt className="font-medium">Revisions</dt>
                <dd>{workflow.revise.enabled ? 'On' : 'Off'}</dd>
                <dt className="font-medium">Label</dt>
                <dd>
                  <code>{workflow.label}</code>, from {config.allowedActors.join(', ')}
                </dd>
              </dl>
              {errors.length > 0 && (
                <Alert variant="error" data-testid="wizard-errors">
                  <p className="font-medium">Nothing was published:</p>
                  <ul className="mt-2 list-disc pl-5">
                    {errors.map((e, i) => (
                      <li key={i}>{e.message}</li>
                    ))}
                  </ul>
                  <Button className="mt-2" variant="secondary" size="sm" type="button" onClick={onSkip}>
                    Fix it in the full editor
                  </Button>
                </Alert>
              )}
            </CardBody>
          </>
        )}

        <CardFooter className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" type="button" onClick={onSkip}>
            Skip to the full editor
          </Button>
          <div className="flex gap-2">
            {index > 0 && (
              <Button variant="secondary" type="button" onClick={() => go(index - 1)}>
                Back
              </Button>
            )}
            {step === 'publish' ? (
              <Button
                type="button"
                loading={publishing}
                onClick={async () => {
                  const version = await onPublish();
                  if (version !== null) setPublished(version);
                }}
              >
                Publish
              </Button>
            ) : (
              <Button type="button" disabled={!canContinue[step]} onClick={() => go(index + 1)}>
                Continue
              </Button>
            )}
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
