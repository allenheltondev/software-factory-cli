import type { z } from 'zod';
import { agentProfile, effectiveArgs } from '../agents/profile.js';
import { getAdapter } from '../agents/adapters/registry.js';
import {
  KNOWN_ADAPTERS,
  agentAdapter,
  allowedActorsFor,
  configSchema,
  modeNeedsCheckout,
  publishMode,
  reviseActive,
  reviewActive,
  reviewPoolFor,
  reviewSettings,
  repoNeedsCheckout,
  workflowId,
  type UpdraftConfig,
} from './schema.js';

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; config: UpdraftConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

function zodIssues(err: z.ZodError): ConfigIssue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message }));
}

/** The worker's own GitHub credentials, which a live run never passes on (WITHHELD_ENV in src/worker/live.ts). */
const WITHHELD_FROM_AGENTS = ['GH_TOKEN', 'GITHUB_TOKEN', 'UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH'];

/**
 * Parse and cross-check a config object: referenced actions, pools, agents,
 * limits and actor allowlists. Pure; does not touch the filesystem or network.
 * `platform` is the one the worker runs on (injectable for tests).
 */
export function validateConfig(raw: unknown, opts: { platform?: NodeJS.Platform } = {}): ValidationResult {
  const platform = opts.platform ?? process.platform;
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error), warnings: [] };
  const config = parsed.data;
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];

  for (const [agentName, agent] of Object.entries(config.agents)) {
    const adapter = agentAdapter(agentName, agent);
    if (agent.capacityGroup !== undefined && !Object.hasOwn(config.capacity?.groups ?? {}, agent.capacityGroup)) {
      errors.push({
        path: `agents.${agentName}.capacityGroup`,
        message: `unknown capacity group "${agent.capacityGroup}"; declare it under capacity.groups`,
      });
    }
    if (!(KNOWN_ADAPTERS as readonly string[]).includes(adapter)) {
      errors.push({
        path: `agents.${agentName}`,
        message: `unknown adapter "${adapter}"; set adapter to one of ${KNOWN_ADAPTERS.join(', ')}`,
      });
    }
    if (config.execution.mode === 'live' && agent.enabled && (KNOWN_ADAPTERS as readonly string[]).includes(adapter) && !getAdapter(adapter)) {
      errors.push({
        path: `agents.${agentName}`,
        message:
          `live execution is not implemented for adapter "${adapter}", so live mode cannot run this agent; ` +
          'use execution.mode prepare-only, or disable the agent',
      });
    }
    for (const problem of agentProfile(adapter, agent).problems) {
      errors.push({ path: `agents.${agentName}`, message: problem });
    }
    if (agent.container) {
      const base = `agents.${agentName}.container`;
      if (platform === 'win32') {
        // The container sees the worktree and the git directory at their host paths, and a
        // Windows path can't exist inside a Linux container. Refuse rather than half-isolate.
        errors.push({
          path: base,
          message:
            'containerized agents are not supported on native Windows yet; run the worker inside WSL2 with the clone on the WSL filesystem, or remove container',
        });
      }
      for (const v of agent.container.env.filter((n) => WITHHELD_FROM_AGENTS.includes(n.toUpperCase()))) {
        warnings.push({
          path: `${base}.env`,
          message: `${v} is withheld from every agent, so it will not reach the container; to hand the agent a GitHub token on purpose, set agents.${agentName}.env.${v}`,
        });
      }
      if (config.execution.mode !== 'live') {
        warnings.push({ path: base, message: `only applies in live mode; in ${config.execution.mode} mode no agent is started` });
      }
    }
    if (agent.maxConcurrent > config.maxConcurrent) {
      warnings.push({
        path: `agents.${agentName}.maxConcurrent`,
        message: `exceeds global maxConcurrent (${config.maxConcurrent}); the global limit applies`,
      });
    }
  }

  if (config.execution.mode === 'live' && !Object.values(config.agents).some((a) => a.enabled)) {
    errors.push({ path: 'agents', message: 'live mode needs at least one enabled agent' });
  }

  for (const [poolName, pool] of Object.entries(config.pools)) {
    const seen = new Set<string>();
    pool.agents.forEach((a, i) => {
      if (!config.agents[a]) errors.push({ path: `pools.${poolName}.agents.${i}`, message: `unknown agent "${a}"` });
      if (seen.has(a)) errors.push({ path: `pools.${poolName}.agents.${i}`, message: `duplicate agent "${a}"` });
      seen.add(a);
    });
    if (pool.agents.every((a) => config.agents[a] && !config.agents[a].enabled)) {
      warnings.push({ path: `pools.${poolName}`, message: 'every agent in this pool is disabled; jobs routed here will wait' });
    }
  }

  const repoIds = new Map<number, string>();
  for (const [repoName, repo] of Object.entries(config.repositories)) {
    const dup = repoIds.get(repo.id);
    if (dup) errors.push({ path: `repositories.${repoName}.id`, message: `same repository ID as ${dup}` });
    repoIds.set(repo.id, repoName);

    if (modeNeedsCheckout(config.execution.mode) && !repo.checkoutPath && repoNeedsCheckout(config, repo)) {
      errors.push({
        path: `repositories.${repoName}.checkoutPath`,
        message: `required in ${config.execution.mode} mode because a workflow runs an action with output local-branch; set it to a local clone of the repo`,
      });
    }

    if (publishMode(repo) !== 'none') {
      if (config.execution.mode !== 'live') {
        warnings.push({
          path: `repositories.${repoName}.publish`,
          message: `only applies in live mode; in ${config.execution.mode} mode nothing is pushed and no PR is opened`,
        });
      } else if (!repoNeedsCheckout(config, repo)) {
        warnings.push({
          path: `repositories.${repoName}.publish`,
          message: 'only applies to actions with output local-branch, and no workflow of this repo runs one',
        });
      }
    }

    if (repo.commentOnFailure && config.execution.mode !== 'live') {
      warnings.push({
        path: `repositories.${repoName}.commentOnFailure`,
        message: `only applies in live mode; in ${config.execution.mode} mode no comment is posted when a run fails`,
      });
    }

    if (repo.revise) {
      if (config.execution.mode !== 'live') {
        warnings.push({
          path: `repositories.${repoName}.revise`,
          message: `only applies in live mode; in ${config.execution.mode} mode no review is read and no revision is run`,
        });
      } else if (publishMode(repo) === 'none') {
        warnings.push({
          path: `repositories.${repoName}.revise`,
          message: 'only applies together with publish: revisions are made to pull requests the worker opened, and it opens none here',
        });
      }
    } else if (repo.maxRevisions !== undefined) {
      warnings.push({ path: `repositories.${repoName}.maxRevisions`, message: 'has no effect without revise' });
    }

    const review = reviewSettings(repo);
    if (review.enabled) {
      if (config.execution.mode !== 'live') {
        warnings.push({
          path: `repositories.${repoName}.review`,
          message: `only applies in live mode; in ${config.execution.mode} mode no reviewer run is started`,
        });
      } else if (publishMode(repo) === 'none') {
        warnings.push({
          path: `repositories.${repoName}.review`,
          message: 'only applies together with publish: the reviewer reviews pull requests the worker opened, and it opens none here',
        });
      } else if (!repo.revise) {
        warnings.push({
          path: `repositories.${repoName}.review`,
          message: 'revise is off, so nothing acts on a "changes requested" verdict: the review is posted and the pull request waits for a person',
        });
      }
      if (repo.autoMergeWaitMinutes !== undefined && repo.autoMerge === undefined) {
        warnings.push({ path: `repositories.${repoName}.autoMergeWaitMinutes`, message: 'has no effect without autoMerge' });
      }
      if (repo.autoMergeRequiredChecks !== undefined && repo.autoMerge === undefined) {
        warnings.push({ path: `repositories.${repoName}.autoMergeRequiredChecks`, message: 'has no effect without autoMerge' });
      }
    } else {
      if (repo.autoMerge !== undefined) {
        warnings.push({
          path: `repositories.${repoName}.autoMerge`,
          message: 'has no effect without review: Updraft only merges a pull request its own reviewer found ready to merge',
        });
      }
      if (repo.autoMergeWaitMinutes !== undefined) {
        warnings.push({ path: `repositories.${repoName}.autoMergeWaitMinutes`, message: 'has no effect without review and autoMerge' });
      }
    }

    if (review.pool !== null) {
      if (!Object.hasOwn(config.pools, review.pool)) errors.push({ path: `repositories.${repoName}.review.pool`, message: `unknown pool "${review.pool}"` });
      else if (repo.workflows.every((wf) => wf.reviewPool !== undefined)) {
        warnings.push({ path: `repositories.${repoName}.review.pool`, message: 'has no effect: every workflow of this repository sets its own reviewPool' });
      }
    }

    const wfIds = new Set<string>();
    repo.workflows.forEach((wf, i) => {
      const base = `repositories.${repoName}.workflows.${i}`;
      const id = workflowId(wf);
      if (wfIds.has(id)) errors.push({ path: `${base}.id`, message: `duplicate workflow id "${id}"; set a unique id` });
      wfIds.add(id);

      if (!Object.hasOwn(config.actions, wf.action)) errors.push({ path: `${base}.action`, message: `unknown action "${wf.action}"` });

      const pools = typeof wf.pool === 'string' ? [wf.pool] : [...wf.pool.rules.map((r) => r.use), wf.pool.default];
      for (const p of pools) {
        if (!Object.hasOwn(config.pools, p)) errors.push({ path: `${base}.pool`, message: `unknown pool "${p}"` });
      }
      if (wf.tiers) {
        const t = wf.tiers;
        const tierPools: [string, string][] = [
          ['pools.routine', t.pools.routine],
          ['pools.standard', t.pools.standard],
          ['pools.complex', t.pools.complex],
          ...(t.highRisk ? [['highRisk.pool', t.highRisk.pool] as [string, string]] : []),
        ];
        for (const [k, p] of tierPools) {
          if (!Object.hasOwn(config.pools, p)) errors.push({ path: `${base}.tiers.${k}`, message: `unknown pool "${p}"` });
        }
        if (t.highRisk && !review.enabled) {
          errors.push({
            path: `${base}.tiers.highRisk`,
            message: `high-risk work requires independent review: enable repositories.${repoName}.review (with allowSameAgent false)`,
          });
        } else if (t.highRisk && review.allowSameAgent) {
          errors.push({ path: `${base}.tiers.highRisk`, message: 'high-risk work requires independent review: review.allowSameAgent must be false' });
        }
        if (t.escalation?.enabled && t.escalation.ceiling === 'high-risk' && !t.highRisk) {
          errors.push({ path: `${base}.tiers.escalation.ceiling`, message: 'a high-risk ceiling needs tiers.highRisk (with independent review)' });
        }
        if (!t.highRisk) warnings.push({ path: `${base}.tiers.highRisk`, message: 'no high-risk pool: high-risk issues will be held for a human' });
        if (t.triage?.enabled) {
          const tp = `${base}.tiers.triage.agent`;
          const triageAgent = config.agents[t.triage.agent];
          if (!triageAgent) errors.push({ path: tp, message: `unknown agent "${t.triage.agent}"` });
          else {
            const adapterName = agentAdapter(t.triage.agent, triageAgent);
            const adapter = getAdapter(adapterName);
            if (!triageAgent.enabled) errors.push({ path: tp, message: `agent "${t.triage.agent}" is disabled` });
            if (triageAgent.container) errors.push({ path: tp, message: 'triage runs the agent CLI on the host; an agent with a container cannot be used' });
            if (!adapter?.buildTriageInvocation) errors.push({ path: tp, message: `the ${adapterName} adapter cannot run triage` });
            else {
              try {
                adapter.buildTriageInvocation({ launch: { file: 'agent', args: [] }, extraArgs: effectiveArgs(adapterName, triageAgent), platform: 'linux' });
              } catch (err) {
                errors.push({ path: tp, message: (err as Error).message });
              }
              if (adapter.triageIsolation === 'best-effort') {
                warnings.push({ path: tp, message: `the ${adapterName} adapter cannot guarantee a read-only, no-tools triage run (see docs/triage.md)` });
              }
            }
          }
        }
      }
      if (wf.reviewPool !== undefined) {
        if (!Object.hasOwn(config.pools, wf.reviewPool)) errors.push({ path: `${base}.reviewPool`, message: `unknown pool "${wf.reviewPool}"` });
        if (!review.enabled) warnings.push({ path: `${base}.reviewPool`, message: `has no effect without repositories.${repoName}.review` });
      }
      // The reviewer must be able to be a different agent than the one that wrote the code. For
      // each pool the job can be routed to: is there a coding agent that would leave the review
      // pool (reviewPool, else review.pool, else that same pool) with nobody else enabled?
      if (reviewActive(config, repo) && !review.allowSameAgent) {
        const enabledIn = (pool: string) => (config.pools[pool]?.agents ?? []).filter((a) => config.agents[a]?.enabled);
        for (const p of new Set(pools)) {
          const reviewPool = reviewPoolFor(repo, wf, p);
          const reviewers = enabledIn(reviewPool);
          const alone = enabledIn(p).find((author) => reviewers.every((r) => r === author));
          if (alone !== undefined && reviewers.length > 0) {
            errors.push({
              path: wf.reviewPool !== undefined ? `${base}.reviewPool` : review.pool !== null ? `repositories.${repoName}.review.pool` : `${base}.pool`,
              message:
                `review needs a reviewer other than the agent that wrote the code, but "${alone}" is the only enabled agent in pool "${reviewPool}" ` +
                `and also writes code in pool "${p}"; add another agent, set reviewPool to a pool with a different agent, or set ` +
                `repositories.${repoName}.review: { allowSameAgent: true } to let an agent review its own work`,
            });
          }
        }
      }

      if (allowedActorsFor(config, wf).length === 0) {
        errors.push({
          path: `${base}`,
          message: 'no allowed actors; set dispatch.allowedActors or workflow.allowedActors',
        });
      }
    });
  }

  for (const [name, action] of Object.entries(config.actions)) {
    if (action.verify) {
      if (config.execution.mode !== 'live') {
        warnings.push({
          path: `actions.${name}.verify`,
          message: `only applies in live mode; in ${config.execution.mode} mode no agent runs and no verify command is run`,
        });
      } else if (action.output !== 'local-branch') {
        warnings.push({
          path: `actions.${name}.verify`,
          message: `only applies to actions with output local-branch; this action's output is ${action.output}, so no verify command is run`,
        });
      }
    } else if (action.verifyTimeoutMinutes !== undefined) {
      warnings.push({ path: `actions.${name}.verifyTimeoutMinutes`, message: 'has no effect without verify' });
    }
  }

  if (config.execution.mode === 'live') {
    const used = new Set(Object.values(config.repositories).flatMap((r) => r.workflows.map((wf) => wf.action)));
    for (const name of used) {
      const action = Object.hasOwn(config.actions, name) ? config.actions[name] : undefined;
      if (!action) continue; // reported above
      if (action.output === 'local-branch' && !action.prompt) {
        errors.push({
          path: `actions.${name}.prompt`,
          message: 'required in live mode: the prompt file tells the agent what to do with the issue',
        });
      }
      const revising = Object.entries(config.repositories).find(
        ([, r]) => reviseActive(config, r) && r.workflows.some((wf) => wf.action === name),
      );
      if (action.output === 'local-branch' && revising && !action.revisePrompt) {
        errors.push({
          path: `actions.${name}.revisePrompt`,
          message: `required because repositories.${revising[0]}.revise is on: the prompt file tells the agent what to do with a review that requested changes`,
        });
      }
      const reviewing = Object.entries(config.repositories).find(
        ([, r]) => reviewActive(config, r) && r.workflows.some((wf) => wf.action === name),
      );
      if (action.output === 'local-branch' && reviewing && !action.reviewPrompt) {
        errors.push({
          path: `actions.${name}.reviewPrompt`,
          message: `required because repositories.${reviewing[0]}.review is on: the prompt file tells the reviewing agent how to review a pull request`,
        });
      }
      if (action.output === 'log') {
        warnings.push({
          path: `actions.${name}.output`,
          message: 'live mode only starts agents for actions with output local-branch; runs of this action are only logged',
        });
      }
    }
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, config, warnings };
}

export function formatIssues(issues: ConfigIssue[]): string {
  return issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
}
