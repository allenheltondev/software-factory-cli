import { parse, stringify } from 'yaml';
import { allowedActorsFor, configSchema, workflowId } from '../../../../src/config/schema.js';
import { isAllowedActor } from '../../../../src/poller/review-trigger.js';
import type { Launcher, LaunchResult } from '../jobs/launch.js';
import type { Store } from '../store/store.js';
import { AGENT_KEY_ENV, type CloudAgent } from '../tenants/agents.js';
import { BENCHMARK_LABEL, benchmarkIdentityOf, benchmarkJobIds, pinBenchmarkConfig } from './config.js';

export interface BenchmarkDispatchDeps {
  installationId: number;
  repositoryId: number;
  store: Pick<Store, 'getTenant' | 'getJob' | 'getConfigVersion'>;
  readConfig: (installationId: number, version: number) => Promise<string | null>;
  issueOpenWithMarker: (installationId: number, repository: string, repositoryId: number, issue: number) => Promise<boolean>;
  launch: Launcher;
}

export function createBenchmarkDispatch(deps: BenchmarkDispatchDeps) {
  const deny = (status: number, disposition: string): LaunchResult => ({ status, disposition });
  return async (raw: unknown): Promise<LaunchResult> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return deny(400, 'invalid_benchmark');
    const { repository, issue, workflow, agent, actor, configVersion, benchmark: identity } = raw as Record<string, unknown>;
    const benchmark = benchmarkIdentityOf(identity);
    if (!benchmark || typeof repository !== 'string' || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(repository) ||
      typeof issue !== 'number' || !Number.isSafeInteger(issue) || issue < 1 ||
      typeof workflow !== 'string' || workflow.length < 1 || workflow.length > 160 ||
      typeof agent !== 'string' || !/^[\w.-]{1,64}$/.test(agent) ||
      typeof actor !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor) ||
      (configVersion !== undefined && (typeof configVersion !== 'number' || !Number.isSafeInteger(configVersion) || configVersion < 1))) {
      return deny(400, 'invalid_benchmark');
    }
    const ids = benchmarkJobIds(deps.installationId, benchmark);
    const tenant = await deps.store.getTenant(deps.installationId, { consistent: true });
    if (tenant?.status !== 'active') return deny(404, 'benchmark_unavailable');
    const existingResult = async (): Promise<LaunchResult | undefined> => {
      const existing = await deps.store.getJob(ids.jobId);
      if (!existing) return undefined;
      if (existing.installationId !== deps.installationId || existing.repositoryId !== deps.repositoryId ||
        existing.repository.toLowerCase() !== repository.toLowerCase() || existing.issue !== issue ||
        existing.sender?.toLowerCase() !== actor.toLowerCase() || existing.benchmark?.runId !== benchmark.runId ||
        existing.benchmark.caseId !== benchmark.caseId || existing.benchmark.arm !== benchmark.arm ||
        existing.benchmarkAgent !== agent || existing.benchmarkWorkflow !== workflow ||
        (configVersion !== undefined && existing.configVersion !== configVersion)) return deny(409, 'benchmark_identity_conflict');
      return { status: 200, disposition: 'duplicate', jobId: ids.jobId };
    };
    const existing = await existingResult();
    if (existing) return existing;
    const version = configVersion ?? tenant.activeConfigVersion;
    if (!version || !(await deps.store.getConfigVersion(deps.installationId, version, { consistent: true }))) return deny(404, 'no_config');
    const yaml = await deps.readConfig(deps.installationId, version);
    if (!yaml) return deny(404, 'no_config');
    const config = configSchema.parse(parse(yaml));
    const name = Object.keys(config.repositories).find((entry) => entry.toLowerCase() === repository.toLowerCase());
    const repo = name ? config.repositories[name] : undefined;
    const picked = repo?.workflows.find((entry) => workflowId(entry) === workflow);
    if (!name || repo?.id !== deps.repositoryId || picked?.trigger.label !== BENCHMARK_LABEL) return deny(404, 'benchmark_workflow_not_found');
    if (!isAllowedActor(allowedActorsFor(config, picked), actor)) return deny(403, 'actor_not_allowed');
    let pinned;
    try {
      pinned = pinBenchmarkConfig(config, { repository: name, workflowId: workflow, agent, executionId: ids.deliveryId });
    } catch {
      return deny(400, 'invalid_benchmark_agent');
    }
    const adapter = pinned.agents[agent]?.adapter ?? agent;
    const agentKey = Object.hasOwn(AGENT_KEY_ENV, adapter) ? AGENT_KEY_ENV[adapter as CloudAgent] : undefined;
    if (!agentKey) return deny(400, 'invalid_benchmark_agent');
    if (!(await deps.issueOpenWithMarker(deps.installationId, name, repo.id, issue))) return deny(409, 'issue_needs_benchmark_label');
    const payload = { action: 'labeled', repository: { id: repo.id, full_name: name }, issue: { number: issue },
      label: { name: BENCHMARK_LABEL }, sender: { login: actor } };
    const result = await deps.launch({
      ...ids, installationId: deps.installationId, body: JSON.stringify(payload), payload,
      benchmark: { identity: benchmark, configVersion: version, configYaml: stringify(pinned), agentKey, agent, workflow },
    });
    if (result.disposition === 'duplicate') return (await existingResult()) ?? deny(409, 'benchmark_dispatch_in_progress');
    if (result.disposition === 'throttled') return { ...result, status: 429 };
    if (result.status === 200 && !result.jobId) return { ...result, status: 409 };
    return result;
  };
}
