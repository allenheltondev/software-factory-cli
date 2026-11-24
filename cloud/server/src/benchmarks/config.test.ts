import { describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { configSchema } from '../../../../src/config/schema.js';
import { BENCHMARK_LABEL, benchmarkIdentityOf, pinBenchmarkConfig } from './config.js';
import { createBenchmarkDispatch } from './dispatch.js';
import type { Launcher } from '../jobs/launch.js';
import type { ConfigVersion, Job, Tenant } from '../store/store.js';
import { jobPaths, jobSessionPolicy } from '../broker/broker.js';

const published = () => configSchema.parse({
  version: 1,
  dispatch: { allowedActors: ['alice'] },
  agents: { fast: { adapter: 'claude', model: 'fast-1' }, deep: { adapter: 'codex', model: 'deep-2', effort: 'high' } },
  pools: { builders: { agents: ['fast', 'deep'] } },
  actions: { build: { prompt: 'prompts/build.md' } },
  repositories: {
    'owner/sandbox': {
      id: 1, publish: 'pr', review: true, revise: true, autoMerge: 'squash',
      workflows: [{ id: 'build', action: 'build', pool: 'builders', trigger: { event: 'issue.labeled', label: BENCHMARK_LABEL } }],
    },
  },
});

describe('benchmark dispatch preparation', () => {
  it('pins one builder and model from a round-robin pool without changing the published config', () => {
    const config = published();
    const isolated = pinBenchmarkConfig(config, { repository: 'owner/sandbox', workflowId: 'build', agent: 'deep' });
    expect(configSchema.parse(isolated)).toMatchObject({
      agents: { deep: { model: 'deep-2', effort: 'high' } },
      pools: { benchmark: { agents: ['deep'] } },
      repositories: { 'owner/sandbox': { publish: 'draft-pr', review: false, revise: false, workflows: [{ pool: 'benchmark' }] } },
    });
    expect(Object.keys(isolated.agents)).toEqual(['deep']);
    expect(isolated.repositories['owner/sandbox']).not.toHaveProperty('autoMerge');
    expect(config).toEqual(published());
  });

  it('rejects an agent without a pinned model and an unknown workflow', () => {
    const config = published();
    delete config.agents.deep!.model;
    expect(() => pinBenchmarkConfig(config, { repository: 'owner/sandbox', workflowId: 'build', agent: 'deep' })).toThrow('explicit model');
    expect(() => pinBenchmarkConfig(config, { repository: 'owner/sandbox', workflowId: 'other', agent: 'fast' })).toThrow('not published');
  });

  it('only keeps bounded run, case, and arm identifiers', () => {
    expect(benchmarkIdentityOf({ runId: 'run.1', caseId: 'case_2', arm: 'deep', extra: 'ignored' })).toEqual({ runId: 'run.1', caseId: 'case_2', arm: 'deep' });
    expect(benchmarkIdentityOf({ runId: 'run/1', caseId: 'case_2', arm: 'deep' })).toBeUndefined();
  });

  it('dispatches two independent arms from a published round-robin workflow', async () => {
    const jobs = new Map<string, Job>();
    const launch = vi.fn<Launcher>(async ({ jobId, deliveryId, benchmark, payload }) => {
      jobs.set(jobId!, {
        jobId, deliveryId, installationId: 42, repositoryId: 1, repository: 'owner/sandbox', issue: 17,
        sender: payload.sender?.login, configVersion: benchmark!.configVersion, benchmark: benchmark!.identity,
        benchmarkAgent: benchmark!.agent, benchmarkWorkflow: benchmark!.workflow, agentKeys: [benchmark!.agentKey],
      } as Job);
      return { status: 202, disposition: 'launched', jobId: jobId! };
    });
    const store = {
      getTenant: vi.fn(async () => ({ status: 'active', activeConfigVersion: 8 }) as Tenant),
      getConfigVersion: vi.fn(async () => ({ version: 7 }) as ConfigVersion),
      getJob: async (jobId: string) => jobs.get(jobId) ?? null,
    };
    const readConfig = vi.fn(async () => stringify(published()));
    const issueOpenWithMarker = vi.fn(async () => true);
    const dispatch = createBenchmarkDispatch({ installationId: 42, repositoryId: 1, store, readConfig, issueOpenWithMarker, launch });
    const fast = { repository: 'owner/sandbox', issue: 17, workflow: 'build', agent: 'fast', actor: 'alice', configVersion: 7,
      benchmark: { runId: 'pilot', caseId: 'issue-17', arm: 'fast' } };
    const deep = { ...fast, agent: 'deep', benchmark: { ...fast.benchmark, arm: 'deep' } };
    const results = await Promise.all([dispatch(fast), dispatch(deep)]);
    expect(readConfig.mock.calls).toEqual([[42, 7], [42, 7]]);
    expect(results).toMatchObject([{ status: 202 }, { status: 202 }]);
    expect(results[0]?.jobId).not.toBe(results[1]?.jobId);
    const [first, second] = launch.mock.calls.map(([request]) => parse(request.benchmark!.configYaml));
    expect(first.agents).toEqual({ fast: expect.objectContaining({ model: 'fast-1' }) });
    expect(second.agents).toEqual({ deep: expect.objectContaining({ model: 'deep-2' }) });
    expect(first.repositories['owner/sandbox'].workflows[0].id).not.toBe(second.repositories['owner/sandbox'].workflows[0].id);
    const [firstJob, secondJob] = [...jobs.values()];
    expect(jobPaths(firstJob!).stateKey).not.toBe(jobPaths(secondJob!).stateKey);
    expect(jobPaths(firstJob!).stateKey).toContain('/state/benchmark/');
    const policy = JSON.stringify(jobSessionPolicy(firstJob!, { bucket: 'jobs', partition: 'aws', region: 'us-east-1', accountId: '123' }));
    expect(policy).toContain(firstJob!.deliveryId);
    expect(policy).toContain('ANTHROPIC_API_KEY');
    expect(policy).not.toContain(secondJob!.deliveryId);
    expect(policy).not.toContain('CODEX_API_KEY');
    expect(await dispatch(fast)).toMatchObject({ disposition: 'duplicate', jobId: results[0]?.jobId });
    expect(await dispatch({ ...fast, agent: 'deep' })).toMatchObject({ status: 409, disposition: 'benchmark_identity_conflict' });
    expect(await dispatch({ ...fast, actor: 'mallory', benchmark: { ...fast.benchmark, arm: 'other' } })).toMatchObject({ status: 403 });
    issueOpenWithMarker.mockResolvedValueOnce(false);
    expect(await dispatch({ ...fast, benchmark: { ...fast.benchmark, arm: 'no-marker' } })).toMatchObject({ disposition: 'issue_needs_benchmark_label' });
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
