import type { z } from 'zod';
import { getAdapter } from '../agents/adapters/registry.js';
import {
  KNOWN_ADAPTERS,
  agentAdapter,
  allowedActorsFor,
  configSchema,
  modeNeedsCheckout,
  publishMode,
  repoNeedsCheckout,
  workflowId,
  type FactoryConfig,
} from './schema.js';

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; config: FactoryConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

function zodIssues(err: z.ZodError): ConfigIssue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message }));
}

/**
 * Parse and cross-check a config object: referenced actions, pools, agents,
 * limits and actor allowlists. Pure; does not touch the filesystem or network.
 */
export function validateConfig(raw: unknown): ValidationResult {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error), warnings: [] };
  const config = parsed.data;
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];

  for (const [agentName, agent] of Object.entries(config.agents)) {
    const adapter = agentAdapter(agentName, agent);
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
          `live execution is not implemented for adapter "${adapter}" in this release, so live mode cannot run this agent yet; ` +
          'use execution.mode prepare-only, or disable the agent',
      });
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

    const wfIds = new Set<string>();
    repo.workflows.forEach((wf, i) => {
      const base = `repositories.${repoName}.workflows.${i}`;
      const id = workflowId(wf);
      if (wfIds.has(id)) errors.push({ path: `${base}.id`, message: `duplicate workflow id "${id}"; set a unique id` });
      wfIds.add(id);

      if (!config.actions[wf.action]) errors.push({ path: `${base}.action`, message: `unknown action "${wf.action}"` });

      const pools = typeof wf.pool === 'string' ? [wf.pool] : [...wf.pool.rules.map((r) => r.use), wf.pool.default];
      for (const p of pools) {
        if (!config.pools[p]) errors.push({ path: `${base}.pool`, message: `unknown pool "${p}"` });
      }

      if (allowedActorsFor(config, wf).length === 0) {
        errors.push({
          path: `${base}`,
          message: 'no allowed actors; set dispatch.allowedActors or workflow.allowedActors',
        });
      }
    });
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
