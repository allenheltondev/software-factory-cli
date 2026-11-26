import { z } from 'zod';

export const CONFIG_VERSION = 1;

/**
 * Agent adapters the CLI knows about. Whether an adapter can run agents in live mode is a separate
 * question: see src/agents/adapters/registry.ts (all three are implemented).
 */
export const KNOWN_ADAPTERS = ['codex', 'claude', 'kiro', 'vibe'] as const;
export type AdapterName = (typeof KNOWN_ADAPTERS)[number];

export const EXECUTION_MODES = ['log-only', 'prepare-only', 'live'] as const;

/**
 * What the worker does with a live run's job branch (repositories.<repo>.publish):
 * none: leave the local branch; draft-pr: push it and open a draft PR; pr: push it and open a
 * ready-for-review PR (for repos where GitHub refuses drafts).
 */
export const PUBLISH_MODES = ['none', 'draft-pr', 'pr'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];
/** repositories.<repo>.notifications: quiet (the default) or verbose. */
export const NOTIFICATION_MODES = ['quiet', 'verbose'] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];
/**
 * repositories.<repo>.review.suggestions: what happens to the reviewer's non-blocking suggestions
 * on a head it found ready (docs/review-loop.md, "Suggestions"). address (the default): one
 * revision applies the ones the coding agent agrees with, budget allowing; follow-up: they go into
 * one follow-up issue; ignore: their threads are left as they are.
 */
export const SUGGESTION_MODES = ['address', 'follow-up', 'ignore'] as const;
export type SuggestionMode = (typeof SUGGESTION_MODES)[number];
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
  /**
   * Live mode: model for the agent CLI, passed as the adapter's own option (--model). Optional
   * shorthand for putting it in `args`; setting it in both is rejected. Not checked against a list.
   */
  model: z.string().optional(),
  /** Live mode: reasoning effort, mapped to the adapter's own option (see docs/agents/profiles.md). */
  effort: z.string().optional(),
  /** Opt in to CLI-managed subscription auth; checked at the start of every Claude run (not continuously). */
  authentication: z.enum(['default', 'native-claude']).optional(),
  /** Live mode: environment variables set for the agent process, on top of the worker's environment. */
  env: z.record(envName, z.string()).optional(),
  /** Live mode: run this agent in a container. `env` above is then set inside the container. */
  container: containerSchema.optional(),
  /**
   * Opt-in: the name of a `capacity.groups` entry. Profiles that run under the same signed-in CLI
   * account name the same group and then share its concurrency budget and its cooldown after a
   * usage limit (docs/capacity-and-escalation.md). Updraft never infers this from credentials.
   */
  capacityGroup: name.optional(),
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

/**
 * Opt-in triage by an installed, signed-in coding CLI (docs/triage.md). It never calls a model
 * API: it launches the named agent (agents.<name>, any adapter that can run read-only) once for
 * an ambiguous issue, which uses that agent's own subscription.
 */
export const triageSchema = z.strictObject({
  /** The agent profile that classifies (agents.<name>): pick a cheap model, e.g. a `claude-triage` entry with `model`. */
  agent: name,
  /** Per-workflow opt-out without deleting the block. Default true (the block itself is the opt-in). */
  enabled: z.boolean().default(true),
  /** Triage when the local heuristics are below tiers.minConfidence. Default true. Set false for label-requested triage only. */
  onLowConfidence: z.boolean().default(true),
  /** An issue label that asks for triage explicitly. Default `triage:requested`. */
  requestLabel: z.string().min(1).default('triage:requested'),
  /** Kill the triage CLI after this many seconds. Default 120. */
  timeoutSeconds: z.number().int().min(5).max(900).default(120),
  /** Treat more output than this as malformed. Default 65536 bytes. */
  maxOutputBytes: z.number().int().min(1024).max(1048576).default(65536),
  /** Extra launches after an unreadable reply (not after a timeout or a CLI failure). Default 1, at most 2. */
  maxRetries: z.number().int().min(0).max(2).default(1),
  /** Triage launches allowed per hour across all repositories. Default 20. */
  maxPerHour: z.number().int().min(1).max(1000).default(20),
  /** After a failed triage of an issue revision, wait this long before launching again. Default 60. */
  failureCooldownMinutes: z.number().int().min(1).max(1440).default(60),
});
/**
 * Opt-in escalation of a job to a more capable tier pool. A run can only *request* it (reason,
 * tier, evidence); this policy decides, and the ceiling, hop cap and pools here are never
 * overridable by model output.
 */
export const escalationSchema = z.strictObject({
  /** Per-workflow opt-out without deleting the block. Default true (the block itself is the opt-in). */
  enabled: z.boolean().default(true),
  /** Escalations one job may get in total. Default 1, at most 3. */
  maxHops: z.number().int().min(1).max(3).default(1),
  /** The most capable tier escalation may reach. high-risk needs tiers.highRisk. Default complex. */
  ceiling: z.enum(['standard', 'complex', 'high-risk']).default('complex'),
  /** Escalate one tier after a failed verification, without the agent asking. Default true. */
  onVerificationFailure: z.boolean().default(true),
  /** Honor an agent's `updraft-escalation:` request line. Default true. */
  allowAgentRequests: z.boolean().default(true),
});

/**
 * Opt-in tier routing (docs/tier-routing.md). Absent: routing is exactly `pool` as before.
 * `pool` is still required and is used for non-tiered paths such as legacy `rules`.
 */
export const tierSchema = z.strictObject({
  pools: z.strictObject({ routine: name, standard: name, complex: name }),
  /** Pool for high-risk work. Absent: high-risk work is held for a human, never run on a weaker pool. */
  highRisk: z.strictObject({ pool: name }).optional(),
  /** Labels people with triage access apply to force a tier. Defaults: tier:routine, tier:standard, tier:complex, tier:high-risk. */
  overrideLabels: z
    .strictObject({
      routine: z.string().min(1).optional(),
      standard: z.string().min(1).optional(),
      complex: z.string().min(1).optional(),
      highRisk: z.string().min(1).optional(),
    })
    .optional(),
  /** Below this confidence the heuristic choice becomes standard. Default 0.6. */
  minConfidence: z.number().min(0).max(1).optional(),
  /** Opt-in CLI triage of ambiguous issues (docs/triage.md). Absent: no triage, ever. */
  triage: triageSchema.optional(),
  /** Opt-in bounded escalation to a more capable tier (docs/capacity-and-escalation.md). Absent: never escalates. */
  escalation: escalationSchema.optional(),
});

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
  /** Opt-in local complexity/risk routing to capability-tier pools. */
  tiers: tierSchema.optional(),
  /** Overrides dispatch.allowedActors for this workflow. */
  allowedActors: z.array(z.string().min(1)).optional(),
  /**
   * With repositories.<repo>.review: the pool reviewer runs are routed to. Default:
   * repositories.<repo>.review.pool, else the pool the job itself was routed to.
   */
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
   * What Updraft says on GitHub about its own progress (docs/assignment-comments.md). quiet (the
   * default): one live status comment on the issue, edited in place as the run moves on, plus a
   * comment only when a person has to act. verbose: the separate status comments of earlier
   * versions (the assignment table, the "PR has the changes" comment, the queue acknowledgement
   * on a pull request and every CI step comment).
   */
  notifications: z.enum(NOTIFICATION_MODES).optional(),
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
        /**
         * The pool reviewer runs are routed to, for every workflow of this repository that sets no
         * reviewPool of its own. One agent in it fixes the reviewer; several are taken in turn.
         * Default: the pool the job itself was routed to.
         */
        pool: name.optional(),
        /** Let the agent that wrote the code also review it when the review pool has no other enabled agent. Default false. */
        allowSameAgent: z.boolean().default(false),
        /**
         * The issue's acceptance criteria (docs/acceptance.md). enforce (the default): the reviewer
         * assesses each one, and a head with a mandatory criterion not verified is never ready.
         * report: assessed and shown, never holding a head back (a waiver, set by whoever writes
         * the config). off: not given to the agents at all.
         */
        acceptance: z.enum(['enforce', 'report', 'off']).optional(),
        /**
         * The reviewer's non-blocking suggestions on a head it found ready. address (the default):
         * one revision of the pull request (counted against maxRevisions) applies those the coding
         * agent agrees with before the merge; what is left goes into one follow-up issue.
         * follow-up: no revision, every open suggestion goes into the follow-up issue. ignore:
         * their threads stay open, as before.
         */
        suggestions: z.enum(SUGGESTION_MODES).optional(),
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
  /**
   * With autoMerge: names of the commit statuses or check runs that must each report success on
   * the commit before it is merged. Not set: any one successful check is enough.
   */
  autoMergeRequiredChecks: z.array(z.string().min(1)).min(1).optional(),
  /**
   * With review: GitHub's checks on a PR's head are part of the loop (docs/ci-fix.md). A
   * ready-to-merge verdict does not end the loop while the applicable checks are pending or
   * failing: pending checks are waited for, and with revise a failure on the current head queues
   * a revision with the failed checks' diagnostics, counted against maxRevisions. Only once the
   * checks pass is a draft marked ready for review, or auto-merge considered. `true`, or an object
   * for options. Default false.
   */
  ciFix: z
    .union([
      z.boolean(),
      z.strictObject({
        /**
         * Names of the check runs or commit statuses that decide. Only these are waited for, and
         * each must report success. Default: autoMergeRequiredChecks when set, else every check
         * on the commit except those in `ignore`.
         */
        checks: z.array(z.string().min(1)).min(1).optional(),
        /** Names of check runs or commit statuses that never count, e.g. a preview deployment that is not about the code. */
        ignore: z.array(z.string().min(1)).optional(),
        /** How long to wait for pending checks on one head before giving up, in minutes. Default 60. */
        waitMinutes: z.number().positive().max(24 * 60).optional(),
      }),
    ])
    .optional(),
  /**
   * Live mode: let a run wait on a pull request in another repository (docs/dependencies.md). The
   * agent names it with an UPDRAFT-WAITING-ON line; the worker publishes nothing for that run,
   * watches the pull request, and runs the issue again once it is merged.
   */
  dependencies: z
    .strictObject({
      /** OWNER/REPO of every repository whose pull requests may be waited on. Nothing else counts. */
      repositories: z.array(repoFullName).min(1),
      /** How often a waited-on pull request is checked, in minutes. Default 5. */
      checkIntervalMinutes: z.number().min(1).max(24 * 60).optional(),
      /** How long the worker waits before it gives up, in days. Default 30. */
      maxWaitDays: z.number().positive().max(365).optional(),
    })
    .optional(),
  workflows: z.array(workflowSchema).min(1),
});

/**
 * Act on GitHub as a GitHub App installation (`<app-slug>[bot]`) instead of the person's `gh`
 * account: polling, lookups, pushes, pull requests and comments (docs/github-app.md,
 * src/github/app-auth.ts). The private key is never in the config, only the path of its file.
 */
export const githubAppSchema = z.strictObject({
  /** The App's numeric ID, or its client ID (a string such as Iv23li...). */
  appId: z.union([z.number().int().positive(), z.string().regex(/^[A-Za-z0-9._-]+$/, "the App's ID or client ID")]),
  /**
   * The PEM private key downloaded from the App's settings, relative to the config file's
   * directory. UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH in the worker's environment names another file.
   * Exactly one of privateKeyPath and tokenFile.
   */
  privateKeyPath: z.string().min(1).optional(),
  /**
   * Instead of the key: a JSON file holding an installation token that somebody else mints and
   * replaces before it expires (docs/github-app.md, "A token file instead of the key"), relative
   * to the config file's directory. The worker never holds the key and reaches only what the
   * token reaches. UPDRAFT_GITHUB_APP_TOKEN_FILE in the worker's environment names another file.
   */
  tokenFile: z.string().min(1).optional(),
  /** Use this installation for every repository. Default: look the installation up per repository. */
  installationId: z.number().int().positive().optional(),
  /**
   * Live mode: have agents commit as the App's bot (GIT_AUTHOR_* and GIT_COMMITTER_* in the
   * agent's environment). Default false: commits carry the local git identity.
   */
  commitAsApp: z.boolean().optional(),
}).superRefine((app, ctx) => {
  const both = app.privateKeyPath !== undefined && app.tokenFile !== undefined;
  const neither = app.privateKeyPath === undefined && app.tokenFile === undefined;
  if (both || neither) {
    ctx.addIssue({
      code: 'custom',
      path: [both ? 'tokenFile' : 'privateKeyPath'],
      message: both
        ? 'set privateKeyPath or tokenFile, not both'
        : 'set privateKeyPath (the App private key) or tokenFile (a file of installation tokens)',
    });
  }
});

/**
 * Subscription capacity groups (docs/capacity-and-escalation.md). A group is a user-declared set
 * of agent profiles that share one authenticated CLI account (`agents.<name>.capacityGroup`).
 */
export const capacityGroupSchema = z.strictObject({
  /** Runs allowed at once across all profiles in the group. Default 1. */
  maxConcurrent: z.number().int().min(1).max(32).default(1),
  /** Cooldown after a recognized usage-limit exit when the CLI gave no reliable retry-after. Default 60. */
  defaultCooldownMinutes: z.number().int().min(1).max(10080).default(60),
  /** A stated retry-after is honored up to this long. Default 360 (6 hours). */
  maxCooldownMinutes: z.number().int().min(1).max(10080).default(360),
});

export const capacitySchema = z.strictObject({
  groups: z.record(name, capacityGroupSchema).default({}),
  /** Cooldown applied to a profile with no capacityGroup after a usage limit. Default 60. */
  defaultCooldownMinutes: z.number().int().min(1).max(10080).default(60),
  maxCooldownMinutes: z.number().int().min(1).max(10080).default(360),
  /** Times one job may be put back in the queue by usage limits before it fails. Default 5. */
  maxDeferrals: z.number().int().min(1).max(50).default(5),
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
  /** How the worker authenticates to GitHub. Absent: as the person's `gh` account. */
  github: z.strictObject({ app: githubAppSchema.optional() }).optional(),
  dispatch: z
    .strictObject({
      /** GitHub logins allowed to dispatch work by applying a trigger label. */
      allowedActors: z.array(z.string().min(1)).default([]),
    })
    .default({ allowedActors: [] }),
  review: z
    .strictObject({
      /**
       * GitHub logins whose PR reviews carry a trusted updraft-review-result block (see
       * docs/review-result.md). Compared case-insensitively. Empty trusts no review result.
       * Not to be confused with repositories.<repo>.review, which turns on Updraft's own reviewer.
       */
      reviewers: z.array(z.string().min(1)).default([]),
    })
    .default({ reviewers: [] }),
  /** Opt-in usage-limit handling and shared subscription capacity. Absent: nothing changes. */
  capacity: capacitySchema.optional(),
  /**
   * Human steering by mention (docs/controls.md): `@<handle> pause`, `resume`, `stop`, ... in a
   * managed issue or pull request. Off unless enabled: reading comments costs requests.
   * `handle`: the login people mention; default: the worker's own (its App's slug).
   */
  controls: z.strictObject({ enabled: z.boolean().default(false), handle: z.string().min(1).max(100).optional() }).optional(),
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
export type TierConfig = z.output<typeof tierSchema>;
export type EscalationConfig = z.output<typeof escalationSchema>;
export type CapacityConfig = z.output<typeof capacitySchema>;
export type TriageConfig = z.output<typeof triageSchema>;
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
/** repositories.<repo>.notifications, with its default. */
export function notificationMode(repo: Pick<RepositoryConfig, 'notifications'> | undefined | null): NotificationMode {
  return repo?.notifications ?? 'quiet';
}

export function publishMode(repo: Pick<RepositoryConfig, 'publish'>): PublishMode {
  return repo.publish ?? 'none';
}

/** Revision jobs one PR gets when repositories.<repo>.maxRevisions is not set. */
export const DEFAULT_MAX_REVISIONS = 3;

/** How often a waited-on pull request is checked when dependencies.checkIntervalMinutes is not set. */
export const DEFAULT_DEPENDENCY_CHECK_MINUTES = 5;
/** How long a wait lasts when dependencies.maxWaitDays is not set. */
export const DEFAULT_DEPENDENCY_MAX_WAIT_DAYS = 30;

/**
 * repositories.<repo>.dependencies as settings, or null when waits are off for the repository
 * (not set, or not live mode). `allows` matches OWNER/REPO case-insensitively.
 */
export function dependencySettings(
  config: Pick<UpdraftConfig, 'execution'>,
  repo: Pick<RepositoryConfig, 'dependencies'>,
): { repositories: string[]; checkIntervalMs: number; maxWaitMs: number; allows(fullName: string): string | null } | null {
  const d = repo.dependencies;
  if (config.execution.mode !== 'live' || !d) return null;
  return {
    repositories: [...d.repositories],
    checkIntervalMs: (d.checkIntervalMinutes ?? DEFAULT_DEPENDENCY_CHECK_MINUTES) * 60_000,
    maxWaitMs: (d.maxWaitDays ?? DEFAULT_DEPENDENCY_MAX_WAIT_DAYS) * 24 * 60 * 60_000,
    allows: (fullName) => d.repositories.find((r) => r.toLowerCase() === fullName.toLowerCase()) ?? null,
  };
}

/** True when any repository lets runs wait on another repository's pull request, in live mode. */
export function dependenciesEnabled(config: Pick<UpdraftConfig, 'execution' | 'repositories'>): boolean {
  return Object.values(config.repositories).some((r) => dependencySettings(config, r) !== null);
}

/** True when the revision loop runs for this repository: live mode, publication on, revise on. */
export function reviseActive(config: Pick<UpdraftConfig, 'execution'>, repo: Pick<RepositoryConfig, 'publish' | 'revise'>): boolean {
  return config.execution.mode === 'live' && repo.revise === true && publishMode(repo) !== 'none';
}

/**
 * repositories.<repo>.review.acceptance as a policy: null when review is off or acceptance is
 * off, else enforce (the default) or report.
 */
export function acceptancePolicy(repo: Pick<RepositoryConfig, 'review'>): 'enforce' | 'report' | null {
  if (repo.review === undefined || repo.review === false) return null;
  const set = repo.review === true ? undefined : repo.review.acceptance;
  return set === 'off' ? null : (set ?? 'enforce');
}

/**
 * repositories.<repo>.review.suggestions with its default (address), or null when the review loop
 * is not active for the repository.
 */
export function suggestionMode(config: Pick<UpdraftConfig, 'execution'>, repo: Pick<RepositoryConfig, 'publish' | 'review'>): SuggestionMode | null {
  if (!reviewActive(config, repo)) return null;
  return repo.review === true || repo.review === undefined || repo.review === false ? 'address' : (repo.review.suggestions ?? 'address');
}

/**
 * The suggestion step is on (address or follow-up): a head found ready waits for its suggestions
 * to be settled before its checks are read and before a merge.
 */
export function suggestionsActive(config: Pick<UpdraftConfig, 'execution'>, repo: Pick<RepositoryConfig, 'publish' | 'review'>): boolean {
  const mode = suggestionMode(config, repo);
  return mode === 'address' || mode === 'follow-up';
}

/** repositories.<repo>.review as settings: off unless set to true or to an options object. */
export function reviewSettings(repo: Pick<RepositoryConfig, 'review'>): { enabled: boolean; allowSameAgent: boolean; pool: string | null } {
  if (repo.review === undefined || repo.review === false) return { enabled: false, allowSameAgent: false, pool: null };
  if (repo.review === true) return { enabled: true, allowSameAgent: false, pool: null };
  return { enabled: true, allowSameAgent: repo.review.allowSameAgent, pool: repo.review.pool ?? null };
}

/**
 * The pool a reviewer job is routed to: the workflow's reviewPool, else the repository's
 * review.pool, else `codePool`, the pool the job that wrote the code was routed to.
 */
export function reviewPoolFor(repo: Pick<RepositoryConfig, 'review'>, wf: Pick<WorkflowConfig, 'reviewPool'> | undefined, codePool: string): string {
  return wf?.reviewPool ?? reviewSettings(repo).pool ?? codePool;
}

/** True when reviewer runs happen for this repository: live mode, publication on, review on. */
export function reviewActive(config: Pick<UpdraftConfig, 'execution'>, repo: Pick<RepositoryConfig, 'publish' | 'review'>): boolean {
  return config.execution.mode === 'live' && reviewSettings(repo).enabled && publishMode(repo) !== 'none';
}

/** Minutes the CI step waits for pending checks on one head when repositories.<repo>.ciFix.waitMinutes is not set. */
export const DEFAULT_CI_WAIT_MINUTES = 60;

export interface CiSettings {
  /** A failure on the current head queues a revision (revise is on); otherwise it is left for a person. */
  fix: boolean;
  /** The checks that decide, or null for every check except `ignore`. */
  checks: string[] | null;
  ignore: string[];
  waitMs: number;
}

/**
 * repositories.<repo>.ciFix as settings, or null when the CI step is off for the repository: not
 * set, or the review loop is not active (live mode, publish and review).
 */
export function ciSettings(
  config: Pick<UpdraftConfig, 'execution'>,
  repo: Pick<RepositoryConfig, 'publish' | 'review' | 'revise' | 'ciFix' | 'autoMergeRequiredChecks'>,
): CiSettings | null {
  const c = repo.ciFix;
  if (c === undefined || c === false || !reviewActive(config, repo)) return null;
  const o = c === true ? {} : c;
  return {
    fix: reviseActive(config, repo),
    checks: o.checks ? [...o.checks] : repo.autoMergeRequiredChecks ? [...repo.autoMergeRequiredChecks] : null,
    ignore: [...(o.ignore ?? [])],
    waitMs: (o.waitMinutes ?? DEFAULT_CI_WAIT_MINUTES) * 60_000,
  };
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
