import { workflowId, type UpdraftConfig, type WorkflowConfig } from '../../../../src/config/schema.js';
import { createHash } from 'node:crypto';

export const BENCHMARK_LABEL = 'updraft:benchmark';

export function isBenchmarkLabel(label: unknown): boolean {
  return typeof label === 'string' && label.toLowerCase() === BENCHMARK_LABEL;
}

export interface BenchmarkIdentity {
  runId: string;
  caseId: string;
  arm: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function benchmarkIdentityOf(raw: unknown): BenchmarkIdentity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { runId, caseId, arm } = raw as Record<string, unknown>;
  if (typeof runId !== 'string' || !ID.test(runId) || typeof caseId !== 'string' || !ID.test(caseId) ||
      typeof arm !== 'string' || !ID.test(arm)) return undefined;
  return { runId, caseId, arm };
}

export function benchmarkJobIds(installationId: number, benchmark: BenchmarkIdentity) {
  const hash = createHash('sha256').update(JSON.stringify([installationId, benchmark.runId, benchmark.caseId, benchmark.arm])).digest();
  return { jobId: `job_${hash.subarray(0, 12).toString('base64url')}`, deliveryId: `bench-${hash.toString('hex').slice(0, 40)}` };
}

function builderPools(workflow: WorkflowConfig): string[] {
  const normal = typeof workflow.pool === 'string' ? [workflow.pool] :
    [workflow.pool.default, ...workflow.pool.rules.map((rule) => rule.use)];
  const tiers = workflow.tiers;
  return [...normal, ...(tiers ? Object.values(tiers.pools) : []), ...(tiers?.highRisk ? [tiers.highRisk.pool] : [])];
}

/**
 * Build a private execution copy from a validated, immutable tenant config. The caller must
 * authorize the benchmark repository and use separate state and branch identities per arm.
 */
export function pinBenchmarkConfig(
  published: UpdraftConfig,
  request: { repository: string; workflowId: string; agent: string; executionId?: string },
): UpdraftConfig {
  const config = structuredClone(published);
  const repository = Object.hasOwn(config.repositories, request.repository) ? config.repositories[request.repository] : undefined;
  const workflow = repository?.workflows.find((candidate) => workflowId(candidate) === request.workflowId);
  if (!repository || !workflow) throw new Error('Benchmark workflow is not published for this repository');
  const agent = Object.hasOwn(config.agents, request.agent) ? config.agents[request.agent] : undefined;
  if (!agent?.enabled || !agent.model || !builderPools(workflow).some((pool) => config.pools[pool]?.agents.includes(request.agent))) {
    throw new Error('Benchmark agent must be an enabled builder with an explicit model');
  }

  delete workflow.tiers;
  delete workflow.reviewPool;
  if (request.executionId) workflow.id = request.executionId;
  workflow.pool = 'benchmark';
  delete repository.autoMerge;
  delete repository.autoMergeRequiredChecks;
  delete repository.autoMergeWaitMinutes;
  delete repository.dependencies;
  delete repository.maxRevisions;
  repository.review = false;
  repository.revise = false;
  repository.commentOnFailure = false;
  repository.publish = 'draft-pr';
  repository.workflows = [workflow];
  return {
    ...config,
    maxConcurrent: 1,
    agents: { [request.agent]: agent },
    pools: { benchmark: { agents: [request.agent], strategy: 'round-robin' } },
    repositories: { [request.repository]: repository },
  };
}
