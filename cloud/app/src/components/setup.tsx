import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, CardBody, CardHeader, CardTitle, StatusBadge } from '@readysetcloud/ui';
import type { Overview } from '../api/client';
import { installationSettingsUrl } from '../lib/diagnostics';
import { PROVIDERS } from '../pages/AgentKeysPage';

export interface SetupStep {
  id: 'app' | 'repositories' | 'config' | 'keys' | 'telemetry' | 'first-job';
  title: string;
  done: boolean;
  /** Not needed for jobs to run. */
  optional?: boolean;
  /** What is left to do, when it is not done. */
  detail?: ReactNode;
  /** Where to do it. */
  action?: ReactNode;
}

const linkClass = 'auth-link font-semibold';
/** An adapter's key name, to name the agent as the keys page does. */
const KEY_OF: Record<string, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY', kiro: 'KIRO_API_KEY', vibe: 'MISTRAL_API_KEY' };

/**
 * The steps from an installed App to a first job, each with whether it is done and where to do
 * it, in the order they can be done: the App and its permissions, its repositories, the
 * configuration, the agents' keys, telemetry (optional), and a first labeled issue.
 */
export function setupSteps(overview: Overview, base: string): SetupStep[] {
  const { status, missingPermissions } = overview.installation;
  const github = (label: string) => (
    <a className={linkClass} href={installationSettingsUrl(overview.tenant)} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  );
  const reachable = overview.repositories.filter((r) => r.reachable);
  const configured = overview.repositories.filter((r) => r.configured && !r.paused);
  const hasConfig = overview.config.activeVersion !== null && configured.length > 0;
  const missingKeys = overview.keys.filter((k) => k.required && !k.configured);
  const agents = (names: string[]) => names.map((n) => PROVIDERS[n]?.agent ?? n).join(' and ');
  const jobs = Object.values(overview.activity.jobs).reduce((n, v) => n + (v ?? 0), 0) + overview.activity.running;
  const trigger = overview.config.triggers?.[0];

  return [
    {
      id: 'app',
      title: 'Install the App on GitHub',
      done: status === 'active',
      ...(status === 'missing_permissions'
        ? { detail: `It needs ${missingPermissions.map((p) => `${p.name} (${p.needs})`).join(', ')}.`, action: github('Review permissions') }
        : status === 'suspended'
          ? { detail: 'It is suspended, so nothing runs.', action: github('Unsuspend') }
          : {}),
    },
    {
      id: 'repositories',
      title: 'Give it the repositories to work in',
      done: reachable.length > 0,
      action: github('Choose repositories'),
    },
    {
      id: 'config',
      title: 'Choose what runs, and where',
      done: hasConfig,
      detail: reachable.length > 0 ? `Pick the repositories, the agents that build and review, and the label that starts a job.` : undefined,
      action: (
        <Link className={linkClass} to={`${base}/config`}>
          Configure
        </Link>
      ),
    },
    {
      id: 'keys',
      title: 'Add your agent keys',
      done: hasConfig && missingKeys.length === 0,
      ...(hasConfig && missingKeys.length ? { detail: `Your configuration runs ${agents(missingKeys.map((k) => k.name))}: add ${missingKeys.length > 1 ? 'their keys' : 'its key'}.` } : {}),
      action: (
        <Link className={linkClass} to={`${base}/keys`}>
          Add keys
        </Link>
      ),
    },
    {
      id: 'telemetry',
      title: 'See every model and tool call in your tracing tool',
      done: overview.telemetry?.configured === true,
      optional: true,
      action: (
        <Link className={linkClass} to={`${base}/telemetry`}>
          Set up traces
        </Link>
      ),
    },
    {
      id: 'first-job',
      title: 'Start your first job',
      done: jobs > 0 || Boolean(overview.activity.firstJobAt),
      ...(trigger
        ? {
            detail: (
              <>
                Add the label <code>{trigger.label}</code> to an issue in {trigger.repository}.
              </>
            ),
            action: (
              <a className={linkClass} href={`https://github.com/${trigger.repository}/issues`} target="_blank" rel="noreferrer">
                Open its issues ↗
              </a>
            ),
          }
        : hasConfig
          ? {
              detail: overview.config.replaced?.length
                ? `${overview.config.replaced.join(', ')} ${overview.config.replaced.length > 1 ? 'were' : 'was'} recreated on GitHub since the configuration was published: publish it again.`
                : overview.config.retiredAgents?.length
                  ? `Your workflows run ${agents(overview.config.retiredAgents.map((a) => KEY_OF[a] ?? a))}, which Updraft Cloud no longer runs here: choose another agent and publish again.`
                  : 'No label you can apply starts a job: add your GitHub login to the allowed actors, for a repository the App reaches.',
              action: (
                <Link className={linkClass} to={`${base}/config`}>
                  Edit configuration
                </Link>
              ),
            }
          : {}),
    },
  ];
}

/** Whether the steps jobs need are all done: then the card is not shown. */
export const setupComplete = (steps: SetupStep[]) => steps.every((s) => s.done || s.optional);

/**
 * The setup checklist: every step, done or not, the next one open with what is left and where to
 * do it. Shown until every step jobs need is done; the optional one never holds it up.
 */
export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  if (setupComplete(steps)) return null;
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  // The next step: the first not done, in order, that is not optional.
  const next = steps.find((s) => !s.done && !s.optional);
  return (
    <Card data-testid="setup">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Get set up</CardTitle>
        <span className="text-sm font-medium" data-testid="setup-progress">
          {done} of {required.length} done
        </span>
      </CardHeader>
      <CardBody>
        <ol className="flex flex-col gap-3">
          {steps.map((s, i) => {
            const isNext = s === next;
            return (
              <li
                key={s.id}
                className={`flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg p-3 ${isNext ? 'border border-primary-500 bg-primary-500/5' : ''}`}
                data-testid={`setup-${s.id}`}
                aria-current={isNext ? 'step' : undefined}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? 'bg-success-500 text-white' : isNext ? 'bg-primary-500 text-white' : 'bg-muted'}`}
                >
                  {s.done ? '✓' : i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={`flex flex-wrap items-center gap-2 ${s.done ? 'text-muted-foreground line-through decoration-1' : 'font-medium'}`}>
                    {s.title}
                    <span className="sr-only">{s.done ? '(done)' : '(to do)'}</span>
                    {s.optional && !s.done && <StatusBadge tone="neutral">Optional</StatusBadge>}
                  </span>
                  {!s.done && isNext && s.detail && <span className="text-sm">{s.detail}</span>}
                </div>
                {!s.done && s.action && <span className="text-sm">{s.action}</span>}
              </li>
            );
          })}
        </ol>
      </CardBody>
    </Card>
  );
}
