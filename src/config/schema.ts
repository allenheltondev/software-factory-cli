import { z } from 'zod';

export const CONFIG_VERSION = 1;

/**
 * Agent adapters the CLI knows about. Whether an adapter can run agents in live mode is a separate
 * question: see src/agents/adapters/registry.ts (all three are implemented).
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
/** repositories.<repo>.autoMerge: how Updraft merges a PR its reviewer found ready. */
export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
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

/** An environment variable name (agents.<name>.env keys, agents.<name>.container.env entries). */
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name');

/**
 * Live mode: run the agent in a container instead of on the host (docs/isolation.md,
 * src/worker/container.ts). Only the job worktree and the parts of the clone's git directory a
 * commit needs are mounted.
 */
export const containerSchema = z.strictObject({
  /** Image to run. It must contain the agent CLI, git and the repository's toolchain. The worker never pulls it explicitly. */
  image: z.string().regex(/^[^-\s][^\s]*$/, 'an image reference, e.g. my-org/claude-runner:latest'),
  /** Runtime client: "docker" (default) or "podman", looked up on PATH; or a path (relative to the config file's directory). */
  runtime: z.string().regex(/^[^-\s]/, 'docker, podman, or a path to the runtime client').default('docker'),
  /**
   * Names of variables to pass from the worker's environment into the container (for example the
   * agent's API key). Passed by name, never as a value on the command line. Nothing else of the
   * worker's environment reaches the container.
   */
  env: z.array(envName).default([]),
  /** Passed as --network (for example "none", "bridge" or a user-defined network). Default: the runtime's default network. */
  network: z.string().regex(/^[^-\s][^\s]*$/, 'a network name or mode').optional(),
  /** Extra arguments for `<runtime> run`, placed before the image. They can widen what the container reaches. */
  args: z.array(z.string()).optional(),
});

export const agentSchema = z.strictObject({
  /** Which adapter runs this agent; defaults to the agent's key. */
  adapter: z.enum(KNOWN_ADAPTERS).optional(),
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(32).default(1),
  /**
   * Live mode: the agent CLI to run instead of the one discovery finds (an absolute path, or a
   * name looked up on PATH). Windows npm `.cmd` shims are resolved to their target. With
   * `container`, it is a name or path inside the image and is used as written.
   */
  command: z.string().min(1).optional(),
  /** Live mode: extra arguments for the agent CLI; the adapter places them where its CLI accepts options. */
  args: z.array(z.string()).optional(),
  /** Live mode: environment variables set for the agent process, on top of the worker's environment. */
  env: z.record(envName, z.string()).optional(),
  /** Live mode: run this agent in a container. `env` above is then set inside the container. */
  container: containerSchema.optional(),
});

export const poolSchema = z.strictObject({
  agents: z.array(name).min(1),
  strategy: z.enum(['round-robin']).default('round-robin'),
});

// A line break ends the command for cmd.exe and starts a second one for sh, so one entry would
// mean different things per OS; NUL can't be passed to a process at all.
const verifyShellCommand = z
  .string()
  .refine((c) => c.trim() !== '', 'a verify command must not be empty')
  .refine((c) => !/[\r\n\0]/.test(c), 'a verify command must be a single line; use one list entry per command');
const verifyArgvCommand = z
  .array(z.string().refine((a) => !a.includes('\0'), 'an argument must not contain a NUL character'))
  .min(1, 'an argv verify command needs at least the executable')
  .refine((argv) => (argv[0] ?? '').trim() !== '', 'the executable (first element) must not be empty');

export const actionSchema = z.strictObject({
  /** Prompt file, relative to the config file's directory. */
  prompt: z.string().min(1).optional(),
  output: z.enum(['local-branch', 'log']).default('local-branch'),
  /** Live mode: stop the agent (and fail the run) after this many minutes. Default 60. */
  timeoutMinutes: z.number().positive().max(24 * 60).optional(),
  /**
   * Live mode, local-branch actions only: commands the worker runs in the job worktree after the
   * agent succeeded, in order; the first that fails fails the run. A string runs through the
   * platform shell, an array is an executable and its arguments, run without one.
   */
  verify: z.array(z.union([verifyShellCommand, verifyArgvCommand])).min(1).optional(),
  /** Time limit for all verify commands together, in minutes. Default 15. */
  verifyTimeoutMinutes: z.number().positive().max(24 * 60).optional(),
  /**
   * Prompt file for revision runs (repositories.<repo>.revise), relative to the config file's
   * directory: what the agent should do with a review that requested changes. Required in live
   * mode when a repository with revise on runs this action.
   */
  revisePrompt: z.string().min(1).optional(),
  /**
   * Prompt file for reviewer runs (repositories.<repo>.review), relative to the config file's
   * directory: how to review a pull request Updraft opened. Required in live mode when a
   * repository with review on runs this action.
   */
  reviewPrompt: z.string().min(1).optional(),
});

/** Agent run time limit when an action sets no timeoutMinutes. */
export const DEFAULT_TIMEOUT_MINUTES = 60;
/** Time limit for an action's verify commands when it sets no verifyTimeoutMinutes. */
export const DEFAULT_VERIFY_TIMEOUT_MINUTES = 15;

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
  /** With repositories.<repo>.review: the pool reviewer runs are routed to. Default: the pool the job itself was routed to. */
  reviewPool: name.optional(),
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
  /**
   * Live mode: when a run leaves its job failed, comment on the issue as the active gh account
   * (run id, agent, duration, reason, how to retry; never agent output). Default false.
   */
  commentOnFailure: z.boolean().optional(),
  /**
   * Live mode, together with publish: when an allowed actor requests changes on a PR Updraft
   * opened, run the agent on that PR's branch with the review and push the result. Default false.
   */
  revise: z.boolean().optional(),
  /** With revise: how many revision jobs one PR gets before further change requests are only recorded. Default 3. */
  maxRevisions: z.number().int().min(1).max(20).optional(),
  /**
   * Live mode, together with publish: run a second agent as reviewer on every head commit of a PR
   * Updraft opened, and post its verdict as a comment review. `true`, or an object for options.
   * Default false.
   */
  review: z
    .union([
      z.boolean(),
      z.strictObject({
        /** Let the agent that wrote the code also review it when the review pool has no other enabled agent. Default false. */
        allowSameAgent: z.boolean().default(false),
      }),
    ])
    .optional(),
  /**
   * With review: merge a PR whose current head the reviewer found ready to merge, once the checks
   * in docs/review-loop.md hold, with this merge method. Absent: never merge; a person does.
   */
  autoMerge: z.enum(MERGE_METHODS).optional(),
  /** With autoMerge: how long to wait for pending checks before giving up, in minutes. Default 60. */
  autoMergeWaitMinutes: z.number().positive().max(24 * 60).optional(),
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

export type UpdraftConfig = z.output<typeof configSchema>;
export type UpdraftConfigInput = z.input<typeof configSchema>;
export type AgentConfig = z.output<typeof agentSchema>;
export type ContainerConfig = z.output<typeof containerSchema>;
export type PoolConfig = z.output<typeof poolSchema>;
export type ActionConfig = z.output<typeof actionSchema>;
/** One actions.<name>.verify entry: a shell command line, or an argv array run without a shell. */
export type VerifyCommand = NonNullable<ActionConfig['verify']>[number];
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
export function repoNeedsCheckout(config: Pick<UpdraftConfig, 'actions'>, repo: Pick<RepositoryConfig, 'workflows'>): boolean {
  return repo.workflows.some(
    (wf) => Object.hasOwn(config.actions, wf.action) && config.actions[wf.action]!.output === 'local-branch',
  );
}

/** The repo's publication mode; none unless the config opts in. */
export function publishMode(repo: Pick<RepositoryConfig, 'publish'>): PublishMode {
  return repo.publish ?? 'none';
}

/** Revision jobs one PR gets when repositories.<repo>.maxRevisions is not set. */
export const DEFAULT_MAX_REVISIONS = 3;

/** True when the revision loop runs for this repository: live mode, publication on, revise on. */
export function reviseActive(config: Pick<UpdraftConfig, 'execution'>, repo: Pick<RepositoryConfig, 'publish' | 'revise'>): boolean {
  return config.execution.mode === 'live' && repo.revise === true && publishMode(repo) !== 'none';
}

/** repositories.<repo>.review as settings: off unless set to true or to an options object. */
export function reviewSettings(repo: Pick<RepositoryConfig, 'review'>): { enabled: boolean; allowSameAgent: boolean } {
  if (repo.review === undefined || repo.review === false) return { enabled: false, allowSameAgent: false };
  if (repo.review === true) return { enabled: true, allowSameAgent: false };
  return { enabled: true, allowSameAgent: repo.review.allowSameAgent };
}

/** True when reviewer runs happen for this repository: live mode, publication on, review on. */
export function reviewActive(config: Pick<UpdraftConfig, 'execution'>, repo: Pick<RepositoryConfig, 'publish' | 'review'>): boolean {
  return config.execution.mode === 'live' && reviewSettings(repo).enabled && publishMode(repo) !== 'none';
}

/** Minutes auto-merge waits for pending checks when repositories.<repo>.autoMergeWaitMinutes is not set. */
export const DEFAULT_AUTO_MERGE_WAIT_MINUTES = 60;

/** The merge method when Updraft may merge this repository's reviewed PRs itself, else null. */
export function autoMergeMethod(config: Pick<UpdraftConfig, 'execution'>, repo: Pick<RepositoryConfig, 'publish' | 'review' | 'autoMerge'>): MergeMethod | null {
  return reviewActive(config, repo) ? (repo.autoMerge ?? null) : null;
}

export function allowedActorsFor(config: UpdraftConfig, wf: WorkflowConfig): string[] {
  return wf.allowedActors ?? config.dispatch.allowedActors;
}
