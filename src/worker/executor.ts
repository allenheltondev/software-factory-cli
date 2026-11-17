// OWNER: queue/worker workstream. Execution seam: the daemon hands each claim to
// an Executor. This release ships only the log-only executor; real adapters
// (codex/claude/kiro subprocesses in per-job worktrees) implement the same interface.
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { agentAdapter, type FactoryConfig } from '../config/schema.js';
import { ownEntry, type Claim } from '../db/queue.js';
import type { FactoryPaths } from '../paths.js';
import type { RunOutcome } from '../types.js';
import type { Logger } from '../util/log.js';

export interface ExecutionContext {
  config: FactoryConfig;
  paths: FactoryPaths;
  log: Logger;
  /**
   * Aborted when the worker is shutting down and the run did not finish in time.
   * A live adapter should stop its agent and resolve with outcome 'interrupted'.
   */
  signal: AbortSignal;
  now: () => number;
  /**
   * Persist the agent subprocess pid and/or the job's checkout path as soon as they
   * exist, so a later worker can reap the process and keep the checkout after a crash.
   */
  recordProcess(info: { pid?: number | null; checkoutPath?: string | null }): void;
}

export interface ExecutionResult {
  outcome: RunOutcome;
  error?: string | null;
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

/** Resolve an action's prompt file against the config file's directory. */
export function resolvePromptPath(config: FactoryConfig, paths: FactoryPaths, action: string): string | null {
  const prompt = ownEntry(config.actions, action)?.prompt;
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
      `software-factory run ${run.id}`,
      `written: ${new Date(ctx.now()).toISOString()}`,
      `mode: log-only. Live execution is disabled in this release; no agent process was started and no checkout was created.`,
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
