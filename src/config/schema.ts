import { z } from 'zod';

export const CONFIG_VERSION = 1;

/**
 * Agent adapters the CLI knows about. Whether an adapter can run agents in live mode is a separate
 * question: see src/agents/adapters/registry.ts (only claude is implemented so far).
 */
export const KNOWN_ADAPTERS = ['codex', 'claude', 'kiro'] as const;
export type AdapterName = (typeof KNOWN_ADAPTERS)[number];

export const EXECUTION_MODES = ['log-only', 'prepare-only', 'live'] as const;

/**
 * What the worker does with a live run's job branch (repositories.<repo>.publish):
 * none: leave the local branch; draft-pr: push it and open a draft PR; pr: push it and open a
 * ready-for-review PR (for repos where GitHub refuses drafts).
 */
export const PUBLISH_MODES = ['none', 'draft-pr', 'pr'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Modes that create a per-job branch and worktree (and so need repositories.*.checkoutPath). */
export function modeNeedsCheckout(mode: ExecutionMode): boolean {
  return mode === 'prepare-only' || mode === 'live';
}

const name = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'use letters, digits, ".", "_" or "-"');

const repoFullName = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO');

export const agentSchema = z.strictObject({
  /** Which adapter runs this agent; defaults to the agent's key. */
  adapter: z.enum(KNOWN_ADAPTERS).optional(),
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(32).default(1),
  /**
   * Live mode: the agent CLI to run instead of the one discovery finds (an absolute path, or a
   * name looked up on PATH). Windows npm `.cmd` shims are resolved to their target.
   */
  command: z.string().min(1).optional(),
  /** Live mode: extra arguments for the agent CLI; the adapter places them where its CLI accepts options. */
  args: z.array(z.string()).optional(),
  /** Live mode: environment variables set for the agent process, on top of the worker's environment. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name'), z.string()).optional(),
});

export const poolSchema = z.strictObject({
  agents: z.array(name).min(1),
  strategy: z.enum(['round-robin']).default('round-robin'),
});

export const actionSchema = z.strictObject({
  /** Prompt file, relative to the config file's directory. */
  prompt: z.string().min(1).optional(),
  output: z.enum(['local-branch', 'log']).default('local-branch'),
  /** Live mode: stop the agent (and fail the run) after this many minutes. Default 60. */
  timeoutMinutes: z.number().positive().max(24 * 60).optional(),
});

/** Agent run time limit when an action sets no timeoutMinutes. */
export const DEFAULT_TIMEOUT_MINUTES = 60;

export const poolRuleSchema = z.strictObject({
  hasLabel: z.string().min(1),
  use: name,
});

export const poolSelectorSchema = z.union([
  name,
  z.strictObject({
    rules: z.array(poolRuleSchema).default([]),
    default: name,
  }),
]);

export const triggerSchema = z.strictObject({
  event: z.literal('issue.labeled'),
  label: z.string().min(1),
});

export const workflowSchema = z.strictObject({
  /**
   * Stable workflow ID used for event deduplication. Defaults to
   * `${action}:${trigger.label}`; set it explicitly to keep dedupe stable across renames.
   */
  id: name.optional(),
  trigger: triggerSchema,
  action: name,
  pool: poolSelectorSchema,
  /** Overrides dispatch.allowedActors for this workflow. */
  allowedActors: z.array(z.string().min(1)).optional(),
});

export const repositorySchema = z.strictObject({
  /** Stable GitHub repository ID, captured when the repo is added. */
  id: z.number().int().positive(),
  /** Base branch for per-job worktrees; defaults to the repo's default branch at run time. */
  baseBranch: z.string().min(1).optional(),
  /**
   * Local clone used as the source for per-job branches and worktrees, relative to the
   * config file's directory. Required in prepare-only mode for workflows whose action
   * has output local-branch.
   */
  checkoutPath: z.string().min(1).optional(),
  /**
   * Remote of checkoutPath to fetch from. By default only a github.com remote whose path is
   * OWNER/REPO qualifies (origin preferred). Naming a remote here allows any host, e.g. an SSH
   * host alias (github-work:OWNER/REPO); its OWNER/REPO must still match.
   */
  remote: z
    .string()
    .regex(/^[^-\s][^\s]*$/, 'a git remote name, e.g. origin')
    .optional(),
  /**
   * New subscriptions start at the current event stream position. Set an ISO timestamp
   * to enqueue matching events created at or after it on the first poll instead.
   */
  backfillSince: z.iso.datetime({ offset: true }).optional(),
  /**
   * Live mode, local-branch actions only: after a succeeded run that left commits, push the job
   * branch and open a PR as the active gh account. Default none (the branch stays local).
   */
  publish: z.enum(PUBLISH_MODES).optional(),
  workflows: z.array(workflowSchema).min(1),
});

export const configSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  /** Global cap on simultaneous runs across all agents and repos. */
  maxConcurrent: z.number().int().min(1).max(64).default(2),
  execution: z
    .strictObject({
      /**
       * log-only: record each run in run.log; no checkout, no agent.
       * prepare-only: also create the job's branch and worktree; still no agent.
       * live: also run the routed agent in the worktree. Requires an implemented adapter for
       * every enabled agent.
       */
      mode: z.enum(EXECUTION_MODES).default('log-only'),
    })
    .default({ mode: 'log-only' }),
  dispatch: z
    .strictObject({
      /** GitHub logins allowed to dispatch work by applying a trigger label. */
      allowedActors: z.array(z.string().min(1)).default([]),
    })
    .default({ allowedActors: [] }),
  agents: z.record(name, agentSchema),
  pools: z.record(name, poolSchema),
  actions: z.record(name, actionSchema),
  repositories: z.record(repoFullName, repositorySchema).default({}),
});

export type FactoryConfig = z.output<typeof configSchema>;
export type FactoryConfigInput = z.input<typeof configSchema>;
export type AgentConfig = z.output<typeof agentSchema>;
export type PoolConfig = z.output<typeof poolSchema>;
export type ActionConfig = z.output<typeof actionSchema>;
export type WorkflowConfig = z.output<typeof workflowSchema>;
export type RepositoryConfig = z.output<typeof repositorySchema>;
export type PoolSelector = z.output<typeof poolSelectorSchema>;

export function workflowId(wf: Pick<WorkflowConfig, 'id' | 'action' | 'trigger'>): string {
  return wf.id ?? `${wf.action}:${wf.trigger.label}`;
}

export function agentAdapter(agentName: string, agent: AgentConfig): string {
  return agent.adapter ?? agentName;
}

/** True if any of the repo's workflows runs an action whose output is a local branch (needs a checkout). */
export function repoNeedsCheckout(config: Pick<FactoryConfig, 'actions'>, repo: Pick<RepositoryConfig, 'workflows'>): boolean {
  return repo.workflows.some(
    (wf) => Object.hasOwn(config.actions, wf.action) && config.actions[wf.action]!.output === 'local-branch',
  );
}

/** The repo's publication mode; none unless the config opts in. */
export function publishMode(repo: Pick<RepositoryConfig, 'publish'>): PublishMode {
  return repo.publish ?? 'none';
}

export function allowedActorsFor(config: FactoryConfig, wf: WorkflowConfig): string[] {
  return wf.allowedActors ?? config.dispatch.allowedActors;
}
