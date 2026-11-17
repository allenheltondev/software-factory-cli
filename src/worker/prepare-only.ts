// Step-2 executor: prepares the job's branch and worktree, writes run.log, and stops
// there. No agent runs. A live adapter (#8) can reuse prepareJobWorktree the same way.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { agentAdapter, type FactoryConfig, type RepositoryConfig } from '../config/schema.js';
import { ownEntry, type Claim } from '../db/queue.js';
import { jobBranchName, jobWorktreePath, prepareJobWorktree, type PreparedWorktree } from '../git/worktree.js';
import type { Job } from '../types.js';
import { LogOnlyExecutor, resolvePromptPath, type ExecutionContext, type ExecutionResult, type Executor } from './executor.js';

/** The repo's config entry, matched by stable ID first, then by name. */
export function findRepoConfig(
  config: FactoryConfig,
  job: Pick<Job, 'repoId' | 'repoFullName'>,
): { fullName: string; repo: RepositoryConfig } | null {
  for (const [fullName, repo] of Object.entries(config.repositories)) {
    if (repo.id === job.repoId) return { fullName, repo };
  }
  const repo = ownEntry(config.repositories, job.repoFullName);
  return repo ? { fullName: job.repoFullName, repo } : null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class PrepareOnlyExecutor implements Executor {
  readonly name = 'prepare-only';

  constructor(private readonly opts: { git?: string } = {}) {}

  async execute(claim: Claim, ctx: ExecutionContext): Promise<ExecutionResult> {
    const { job, run } = claim;
    const logPath = run.logPath ?? join(ctx.paths.runsDir, run.id, 'run.log');
    await mkdir(dirname(logPath), { recursive: true });

    const action = ownEntry(ctx.config.actions, job.action);
    const found = findRepoConfig(ctx.config, job);
    const checkoutSource = found?.repo.checkoutPath ? resolve(ctx.paths.configDir, found.repo.checkoutPath) : null;
    const branch = jobBranchName(job, run.attempt);
    const worktreePath = jobWorktreePath(ctx.paths, job, run.attempt);

    let prepared: PreparedWorktree | null = null;
    let checkout: string | null = null;
    let error: string | null = null;
    let note: string;
    if (!action) {
      error = `action "${job.action}" is no longer configured`;
      note = 'checkout: none (action not configured)';
    } else if (action.output !== 'local-branch') {
      note = `checkout: none (action output is ${action.output})`;
    } else if (!found || !checkoutSource) {
      error = `repositories.${found?.fullName ?? job.repoFullName}.checkoutPath is not set; prepare-only needs a local clone`;
      note = 'checkout: none (no checkoutPath)';
    } else if (ctx.signal.aborted) {
      error = 'worker stopped before the checkout was prepared';
      note = 'checkout: none (interrupted)';
    } else {
      try {
        prepared = await prepareJobWorktree({
          checkoutPath: checkoutSource,
          repoFullName: found.fullName,
          remote: found.repo.remote,
          baseBranch: found.repo.baseBranch,
          branch,
          worktreePath,
          git: this.opts.git,
          signal: ctx.signal,
          onCheckout: (path) => {
            checkout = path;
            ctx.recordProcess({ checkoutPath: path });
          },
        });
        note = `checkout: ${prepared.worktreePath}`;
      } catch (err) {
        error = `could not prepare the worktree: ${message(err)}`;
        note = checkout
          ? `checkout: ${checkout} (left by the failed preparation; kept for inspection)`
          : 'checkout: none (preparation failed)';
      }
    }

    const agentCfg = ownEntry(ctx.config.agents, run.agent);
    const promptPath = resolvePromptPath(ctx.config, ctx.paths, job.action);
    const env = job.envelope;
    const lines = [
      `software-factory run ${run.id}`,
      `written: ${new Date(ctx.now()).toISOString()}`,
      'mode: prepare-only. A branch and worktree are prepared for the job; no agent process was started.',
      '',
      `job: ${job.id} (attempt ${run.attempt})`,
      `repository: ${job.repoFullName} (id ${job.repoId})`,
      `issue: #${env.issue.number} ${env.issue.title}`,
      `issue url: ${env.issue.url}`,
      `workflow: ${job.workflowId}`,
      `trigger: ${env.type} label "${env.label}" by ${env.actor ?? '(unknown actor)'} at ${env.createdAt}`,
      '',
      `pool: ${run.pool}`,
      `agent: ${run.agent}${agentCfg ? ` (adapter ${agentAdapter(run.agent, agentCfg)})` : ' (no longer configured)'}`,
      `action: ${job.action}${action ? ` (output ${action.output})` : ' (no longer configured)'}`,
      `prompt: ${promptPath ?? '(none configured)'}`,
      '',
      ...(checkoutSource ? [`source clone: ${checkoutSource}`] : []),
      ...(prepared
        ? [
            `remote: ${prepared.remote} (${prepared.remoteUrl})`,
            `base: ${prepared.baseBranch} at ${prepared.baseSha}`,
            `branch: ${prepared.branch}`,
          ]
        : []),
      note,
      ...(error ? [`error: ${error}`] : []),
      `run log: ${logPath}`,
      '',
      'envelope:',
      JSON.stringify(env, null, 2),
      '',
    ];
    await writeFile(logPath, lines.join('\n'), 'utf8');

    if (error) {
      ctx.log.warn('prepare-only run failed', { error, logPath });
      return { outcome: ctx.signal.aborted ? 'interrupted' : 'failed', error };
    }
    ctx.log.info('prepare-only run recorded', { logPath, ...(prepared ? { worktree: prepared.worktreePath, branch } : {}) });
    return { outcome: 'succeeded' };
  }
}

/** The executor for config.execution.mode. */
export function createExecutor(config: Pick<FactoryConfig, 'execution'>): Executor {
  switch (config.execution.mode) {
    case 'prepare-only':
      return new PrepareOnlyExecutor();
    case 'log-only':
      return new LogOnlyExecutor();
    case 'live':
      // Unreachable through validation until an adapter is implemented; the executor comes next.
      throw new Error('live execution is not available yet');
  }
}
