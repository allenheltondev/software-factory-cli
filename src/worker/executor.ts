// OWNER: queue/worker workstream. Execution seam: the daemon hands each claim to an
// Executor: log-only (here), prepare-only (prepare-only.ts) or live (live.ts), chosen by
// execution.mode in createExecutor.
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { agentAdapter, type UpdraftConfig, type RepositoryConfig } from '../config/schema.js';
import { CANCELED_BY_USER, ownEntry, type Claim, type RunProcessInfo } from '../db/queue.js';
import type { UpdraftPaths } from '../paths.js';
import type { IssueSnapshot, Job, RunOutcome, RunSummary } from '../types.js';
import type { Logger } from '../util/log.js';

export interface ExecutionContext {
  config: UpdraftConfig;
  paths: UpdraftPaths;
  log: Logger;
  /**
   * Aborted when the worker is shutting down and the run did not finish in time, or when the
   * user canceled the run (`updraft cancel`; see canceledByUser). Either way a live adapter
   * should stop its agent and resolve with outcome 'interrupted'; the daemon records a user
   * cancel as canceled.
   */
  signal: AbortSignal;
  /**
   * Aborted as soon as the worker is asked to stop (SIGINT/SIGTERM), before `signal`. An executor
   * whose work can't finish quickly (a live agent) stops on this instead of waiting for `signal`.
   */
  workerStopping?: AbortSignal;
  now: () => number;
  /** The issue as fetched by the pre-start check, when available. Untrusted text. */
  issue?: IssueSnapshot;
  /**
   * Persist the agent subprocess pid (then its OS start time) and/or the job's checkout path
   * as soon as they exist, so a later worker can reap the process and keep the checkout after
   * a crash.
   */
  recordProcess(info: RunProcessInfo): void;
}

/**
 * True if the run was stopped by `updraft cancel` rather than by the worker shutting down: the
 * daemon aborts `signal` with CANCELED_BY_USER as the reason.
 */
export function canceledByUser(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === CANCELED_BY_USER;
}

export interface ExecutionResult {
  outcome: RunOutcome;
  error?: string | null;
  /** What a live agent run left behind; stored for `updraft status`. */
  summary?: RunSummary | null;
  /**
   * Live executor: the agent CLI's own output when the CLI itself exited unsuccessfully (not
   * verification, not a timeout). Only used to recognize a usage limit (src/capacity/usage-limit.ts).
   */
  cliOutput?: string;
  /**
   * Live executor: the agent's output, set only when it contains an `updraft-escalation:` line.
   * Unvalidated; the daemon's policy validates and decides (src/escalation/escalation.ts).
   */
  escalationRequest?: string;
}

/**
 * Throw (or return outcome 'start_failed') when the agent could not be started at
 * all, e.g. missing binary or auth. The daemon then releases the slot and requeues
 * the job for another eligible agent. Any other rejection is recorded as 'failed'
 * so a partially-run checkout is never silently re-run.
 */
export class StartFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StartFailedError';
  }
}

export interface Executor {
  readonly name: string;
  execute(claim: Claim, ctx: ExecutionContext): Promise<ExecutionResult>;
}

/** The repo's config entry, matched by stable ID first, then by name. */
export function findRepoConfig(
  config: UpdraftConfig,
  job: Pick<Job, 'repoId' | 'repoFullName'>,
): { fullName: string; repo: RepositoryConfig } | null {
  for (const [fullName, repo] of Object.entries(config.repositories)) {
    if (repo.id === job.repoId) return { fullName, repo };
  }
  const repo = ownEntry(config.repositories, job.repoFullName);
  return repo ? { fullName: job.repoFullName, repo } : null;
}

/**
 * Resolve an action's prompt file against the config file's directory: its `prompt`, for a
 * revision run its `revisePrompt`, for a reviewer run its `reviewPrompt`.
 */
export function resolvePromptPath(
  config: UpdraftConfig,
  paths: UpdraftPaths,
  action: string,
  which: 'prompt' | 'revisePrompt' | 'reviewPrompt' = 'prompt',
): string | null {
  const prompt = ownEntry(config.actions, action)?.[which];
  return prompt ? resolve(paths.configDir, prompt) : null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Step-1 executor: does not start any agent. Creates the run directory and writes
 * run.log describing what would have run.
 */
export class LogOnlyExecutor implements Executor {
  readonly name = 'log-only';

  async execute(claim: Claim, ctx: ExecutionContext): Promise<ExecutionResult> {
    const { job, run } = claim;
    const logPath = run.logPath ?? join(ctx.paths.runsDir, run.id, 'run.log');
    await mkdir(dirname(logPath), { recursive: true });

    const action = ownEntry(ctx.config.actions, job.action);
    const promptPath = resolvePromptPath(ctx.config, ctx.paths, job.action);
    const agentCfg = ownEntry(ctx.config.agents, run.agent);
    const env = job.envelope;

    const lines = [
      `updraft run ${run.id}`,
      `written: ${new Date(ctx.now()).toISOString()}`,
      `mode: log-only. No agent process was started and no checkout was created.`,
      '',
      `job: ${job.id} (attempt ${run.attempt})`,
      `repository: ${job.repoFullName} (id ${job.repoId})`,
      `issue: #${env.issue.number} ${env.issue.title}`,
      `issue url: ${env.issue.url}`,
      `workflow: ${job.workflowId}`,
      `trigger: ${env.type} label "${env.label}" by ${env.actor ?? '(unknown actor)'} at ${env.createdAt}`,
      `labels at enqueue: ${env.labelsAtEnqueue.length ? env.labelsAtEnqueue.join(', ') : '(none)'}`,
      '',
      `pool: ${run.pool}`,
      `agent: ${run.agent}${agentCfg ? ` (adapter ${agentAdapter(run.agent, agentCfg)})` : ' (no longer configured)'}`,
      `action: ${job.action}${action ? ` (output ${action.output})` : ' (no longer configured)'}`,
      promptPath
        ? `prompt: ${promptPath}${(await fileExists(promptPath)) ? '' : ' (file not found)'}`
        : 'prompt: (none configured)',
      `run log: ${logPath}`,
      '',
      'envelope:',
      JSON.stringify(env, null, 2),
      '',
    ];
    await writeFile(logPath, lines.join('\n'), 'utf8');
    ctx.log.info('log-only run recorded', { logPath });
    return { outcome: 'succeeded' };
  }
}
