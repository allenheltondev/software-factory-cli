import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import type { GitHubInstallation, GitHubRepository } from '../github/client.js';
import type { NativeReadiness } from '../jobs/launch.js';
import { DEFAULT_QUOTAS } from '../jobs/quotas.js';
import { createKillSwitch } from '../jobs/kill-switch.js';
import type { ConfigVersion, DispatchRules, HeldPause, JobSummary, TelemetrySettings, Tenant, Usage } from '../store/store.js';
import type { AgentKeyView } from './agent-key-service.js';
import {
  combineStatus, createReadinessService, executionCheck, subscriptionCheck,
  type NativeBinding, type ReadinessCheck, type ReadinessReport, type ReadinessServiceDeps,
} from './readiness-service.js';

const caller = { sub: 'member-1' } as Caller;
const ALL = { metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read' };
const EVENTS = ['issues', 'pull_request', 'pull_request_review', 'check_suite'];
const NOW = Date.parse('2026-11-25T12:00:00.000Z');

type Rule = DispatchRules['repositories'][string];
const rule = (over: Partial<Rule> = {}): Rule => ({ id: 9, actors: ['pat'], keys: ['ANTHROPIC_API_KEY'], review: true, revise: true, ci: true, triggers: [{ label: 'updraft' }], ...over });

interface World {
  tenant: Tenant;
  member: boolean;
  installation: GitHubInstallation | null | Error;
  repositories: GitHubRepository[] | Error;
  rules: DispatchRules | undefined;
  version: ConfigVersion | null | Error;
  keys: AgentKeyView[] | Error;
  usage: Usage | Error;
  jobs: JobSummary[] | Error;
  pauses: HeldPause[] | Error;
  telemetry: TelemetrySettings | null | Error;
  killSwitch: boolean | Error;
  imageVersion: string | null | Error;
  truncated?: boolean;
  native?: Partial<NativeBinding> & { readiness?: () => Promise<NativeReadiness> } | Error;
}

function world(over: Partial<World> = {}): World {
  const rules: DispatchRules = { loop: true, repositories: { 'acme/web': rule() } };
  return {
    tenant: { installationId: 55, accountId: 1, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '', createdBy: '', activeConfigVersion: 3 },
    member: true,
    installation: { id: 55, account: { id: 1, login: 'acme', type: 'Organization' }, suspendedAt: null, permissions: ALL, events: EVENTS },
    repositories: [{ id: 9, fullName: 'Acme/Web', private: true, htmlUrl: 'https://github.com/Acme/Web' }],
    rules,
    version: undefined as never,
    keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true, lastUsed: { at: '2026-11-24T00:00:00Z', ok: true } }],
    usage: { day: '2026-11-25', jobsToday: 1, month: '2026-11', jobsThisMonth: 4, microvmSecondsThisMonth: 600, throttledThisMonth: 0, failedThisMonth: 0 },
    jobs: [],
    pauses: [],
    telemetry: null,
    killSwitch: false,
    imageVersion: 'v42',
    ...over,
  };
}

const value = async <T,>(v: T | Error): Promise<T> => {
  if (v instanceof Error) throw v;
  return v;
};

function setup(w: World, extra: Partial<ReadinessServiceDeps> = {}) {
  const clock = { now: NOW };
  const calls: string[] = [];
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) => (...a: A) => {
    calls.push(name);
    return fn(...a);
  };
  const readiness = vi.fn(async () => {
    const n = w.native;
    if (!n || n instanceof Error || !n.readiness) return 'ready' as NativeReadiness;
    return n.readiness();
  });
  const member = async (_c: Caller, id: number) => {
    if (!w.member || id !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    return { tenant: w.tenant, summary: {} as never };
  };
  // Only reads: a write, a worker start or a model call would be a property these fakes do not have.
  const deps: ReadinessServiceDeps = {
    now: () => clock.now,
    log: () => {},
    quotas: DEFAULT_QUOTAS,
    store: {
      getConfigVersion: track('getConfigVersion', async (id: number, v: number) => {
        expect(id).toBe(55);
        if (w.version !== undefined) return value(w.version);
        return { installationId: id, version: v, status: 'ready', sha256: '', files: [], publishedBy: 'pat', publishedAt: '2026-11-20T00:00:00Z', ...(w.rules ? { dispatch: w.rules } : {}) } as ConfigVersion;
      }),
      getUsage: track('getUsage', async (id: number) => { expect(id).toBe(55); return value(w.usage); }),
      listRecentJobs: track('listRecentJobs', async (id: number) => { expect(id).toBe(55); return value(w.jobs); }),
      listWorkflowPauses: track('listWorkflowPauses', async (id: number) => { expect(id).toBe(55); return value(w.pauses); }),
      getTelemetry: track('getTelemetry', async (id: number) => { expect(id).toBe(55); return value(w.telemetry); }),
    },
    github: {
      member,
      installation: track('installation', async (c: Caller, id: number) => { await member(c, id); return value(w.installation); }),
      repositories: track('repositories', async (c: Caller, id: number) => { await member(c, id); return { tenant: {} as never, repositories: await value(w.repositories), ...(w.truncated ? { truncated: true as const } : {}) }; }),
    },
    agentKeys: { list: track('keys', async () => ({ keys: await value(w.keys), refusals: [] })) },
    killSwitch: { engaged: track('killSwitch', async () => value(w.killSwitch)) },
    imageVersion: track('imageVersion', async () => value(w.imageVersion)),
    native: track('native', async (id: number) => {
      expect(id).toBe(55);
      const n = w.native;
      if (n instanceof Error) throw n;
      if (!n) return undefined;
      return { enabled: n.enabled ?? true, explicitTriggers: n.explicitTriggers ?? false, triggers: n.triggers ?? [{ repositoryId: 9, repository: 'acme/web', label: 'updraft' }], readiness };
    }),
    ...extra,
  };
  return { service: createReadinessService(deps), clock, calls, readiness };
}

const repo = (r: ReadinessReport, name = 'acme/web') => r.repositories.find((x) => x.repository.toLowerCase() === name)!;
const get = (r: ReadinessReport, id: string): ReadinessCheck | undefined => r.installation.find((c) => c.id === id) ?? repo(r)?.checks.find((c) => c.id === id);

describe('repository readiness (#137)', () => {
  it('reports a fully set up repository ready, with the limits of what that means and without optional telemetry', async () => {
    const r = await setup(world()).service.readiness(caller, 55);
    expect(repo(r).status).toBe('ready');
    expect(r).toMatchObject({ checkedAt: new Date(NOW).toISOString(), cached: false, configVersion: 3 });
    for (const id of ['tenant', 'github-permissions', 'config-published', 'kill-switch', 'job-image', 'quota', 'repository-access', 'triggers', 'agent-keys', 'github-events', 'review', 'ci']) {
      expect(get(r, id), id).toMatchObject({ state: 'verified' });
    }
    // Telemetry is not set up: optional, so it holds nothing up.
    expect(get(r, 'telemetry')).toMatchObject({ state: 'off', required: false, fix: { target: 'telemetry' } });
    // What only a run can show is said, never shown as checked.
    expect(get(r, 'egress')).toMatchObject({ state: 'unverified', unverified: 'needs_run' });
    expect(get(r, 'execution')).toMatchObject({ state: 'unverified', unverified: 'needs_run', required: false });
    expect(r.limitations.join(' ')).toMatch(/does not run a job/);
  });

  const broken: [string, Partial<World> | ((w: World) => void), string, Partial<ReadinessCheck>, ReturnType<typeof combineStatus>][] = [
    ['a missing agent key', { keys: [{ name: 'ANTHROPIC_API_KEY', configured: false, required: true }] }, 'agent-keys', { problem: 'missing_credentials', fix: { text: 'Add the key', target: 'keys' } }, 'action_needed'],
    ['a missing GitHub permission', (w) => { (w.installation as GitHubInstallation).permissions = { ...ALL, pull_requests: 'read' }; }, 'github-permissions', { problem: 'permissions', fix: { text: expect.any(String), target: 'github' } }, 'action_needed'],
    ['a missing check_suite subscription with CI repair on', (w) => { (w.installation as GitHubInstallation).events = ['issues', 'pull_request', 'pull_request_review']; }, 'github-events', { problem: 'permissions', summary: expect.stringContaining('check_suite') }, 'action_needed'],
    ['a repository the App no longer reaches', { repositories: [] }, 'repository-access', { problem: 'permissions', fix: { text: expect.any(String), target: 'github' } }, 'action_needed'],
    ['a recreated repository', { repositories: [{ id: 10, fullName: 'Acme/Web', private: true, htmlUrl: '' }] }, 'repository-access', { problem: 'invalid_config', fix: { text: expect.any(String), target: 'config' } }, 'action_needed'],
    ['a repository paused in the configuration', { rules: { loop: true, repositories: { 'acme/web': rule({ paused: true }) } } }, 'repository-paused', { problem: 'paused' }, 'paused'],
    ['the platform kill switch', { killSwitch: true }, 'kill-switch', { problem: 'paused' }, 'paused'],
    ['an admin-disabled installation', (w) => { w.tenant = { ...w.tenant, status: 'disabled', disabledReason: 'admin', adminDisabled: { at: '', by: 'admin', reason: 'billing' } }; }, 'tenant', { problem: 'paused', summary: expect.stringContaining('billing') }, 'paused'],
    ["today's job limit", (w) => { (w.usage as Usage).jobsToday = DEFAULT_QUOTAS.jobsPerDay; }, 'quota-daily', { problem: 'transient' }, 'temporarily_unavailable'],
    ["the month's compute minutes", (w) => { (w.usage as Usage).microvmSecondsThisMonth = DEFAULT_QUOTAS.microvmMinutesPerMonth * 60; }, 'quota-minutes', { problem: 'transient' }, 'temporarily_unavailable'],
    ['no published job image', { imageVersion: null }, 'job-image', { problem: 'provider' }, 'temporarily_unavailable'],
    ['review published before the loop existed', { rules: { repositories: { 'acme/web': rule() } } }, 'review', { problem: 'invalid_config', fix: { text: expect.any(String), target: 'config' } }, 'action_needed'],
    ['a workflow of a retired agent', { rules: { loop: true, repositories: { 'acme/web': rule({ keys: ['RETIRED_API_KEY'] }) } } }, 'agent-retired', { problem: 'invalid_config' }, 'action_needed'],
    ['a repository without triggers', { rules: { loop: true, repositories: { 'acme/web': rule({ triggers: [] }) } } }, 'triggers', { problem: 'invalid_config' }, 'action_needed'],
  ];
  it.each(broken)('reports %s at its own stage, with the fix', async (_name, change, id, expected, status) => {
    const w = world();
    if (typeof change === 'function') change(w);
    else Object.assign(w, change);
    const r = await setup(w).service.readiness(caller, 55);
    expect(get(r, id)).toMatchObject({ state: 'failing', required: true, ...expected });
    expect(repo(r).status).toBe(status);
  });

  it('says when nothing is published, and lists reachable repositories as not configured', async () => {
    const w = world();
    w.tenant = { ...w.tenant, activeConfigVersion: undefined };
    const r = await setup(w).service.readiness(caller, 55);
    expect(get(r, 'config-published')).toMatchObject({ state: 'failing', problem: 'invalid_config', fix: { target: 'config' } });
    expect(r.repositories).toEqual([{ repository: 'Acme/Web', repositoryId: 9, status: 'not_configured', checks: [] }]);
  });

  it('never reports what it could not read as healthy or as missing', async () => {
    const r = await setup(world({ installation: new Error('GitHub 502'), keys: new Error('throttled'), pauses: new Error('x') })).service.readiness(caller, 55);
    expect(get(r, 'github-permissions')).toMatchObject({ state: 'unverified', unverified: 'read_failed' });
    expect(get(r, 'github-events')).toMatchObject({ state: 'unverified' });
    expect(get(r, 'agent-keys')).toMatchObject({ state: 'unverified' });
    expect(get(r, 'ci-logs')).toMatchObject({ state: 'unverified', required: false });
    expect(get(r, 'workflow-pauses')).toMatchObject({ state: 'unverified', required: false });
    expect(repo(r).status).toBe('unknown');
    const all = [...r.installation, ...repo(r).checks];
    expect(all.filter((c) => c.state === 'failing')).toEqual([]);

    // GitHub answered, but without saying which events: unknown, not missing.
    const w = world();
    delete (w.installation as GitHubInstallation).events;
    delete (w.installation as GitHubInstallation).permissions;
    const silent = await setup(w).service.readiness(caller, 55);
    expect(get(silent, 'github-events')).toMatchObject({ state: 'unverified' });
    expect(get(silent, 'github-permissions')).toMatchObject({ state: 'unverified' });
    expect(repo(silent).status).toBe('unknown');

    // A version published before agent keys were recorded: unknown until it is published again.
    const old = await setup(world({ rules: { loop: true, repositories: { 'acme/web': rule({ keys: undefined }) } } })).service.readiness(caller, 55);
    expect(get(old, 'agent-keys')).toMatchObject({ state: 'unverified', unverified: 'not_checked' });
    expect(repo(old).status).toBe('unknown');
  });

  it('never asks for an Anthropic key, or a job image, just because subscription routing could not be read', async () => {
    const r = await setup(world({ keys: [], native: new Error('DynamoDB throttled'), imageVersion: null })).service.readiness(caller, 55);
    expect(get(r, 'subscription')).toMatchObject({ state: 'unverified', unverified: 'read_failed' });
    expect(get(r, 'agent-keys')).toMatchObject({ state: 'unverified', unverified: 'read_failed', summary: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(get(r, 'job-image')).toMatchObject({ state: 'unverified', unverified: 'read_failed' });
    expect([...r.installation, ...repo(r).checks].filter((c) => c.required && c.state === 'failing')).toEqual([]);
    expect(repo(r).status).toBe('unknown');
    // With an image published it is still verified; any other missing key is still missing.
    const image = await setup(world({ keys: [], native: new Error('x') })).service.readiness(caller, 55);
    expect(get(image, 'job-image')).toMatchObject({ state: 'verified' });
    const codex = await setup(world({ keys: [], native: new Error('x'), rules: { loop: true, repositories: { 'acme/web': rule({ keys: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'] }) } } })).service.readiness(caller, 55);
    expect(get(codex, 'agent-keys')).toMatchObject({ state: 'failing', summary: expect.stringMatching(/^CODEX_API_KEY is needed/) });
  });

  it('tells an unreadable kill switch from an operator pause', async () => {
    const unreadable = createKillSwitch({ read: async () => { throw new Error('AccessDenied'); }, log: () => {} });
    expect(await unreadable.engaged()).toBe(true); // dispatch still fails closed
    const r = await setup(world(), { killSwitch: unreadable }).service.readiness(caller, 55);
    expect(get(r, 'kill-switch')).toMatchObject({ state: 'unverified', unverified: 'read_failed' });
    expect(get(r, 'kill-switch')!.summary).not.toMatch(/operator has paused/);
    expect(repo(r).status).toBe('unknown');
    const on = await setup(world(), { killSwitch: createKillSwitch({ read: async () => 'on' }) }).service.readiness(caller, 55);
    expect(get(on, 'kill-switch')).toMatchObject({ state: 'failing', problem: 'paused' });
  });

  it('does not call a repository unreachable when GitHub listed only part of them', async () => {
    const r = await setup(world({ repositories: [], truncated: true })).service.readiness(caller, 55);
    expect(get(r, 'repository-access')).toMatchObject({ state: 'unverified', unverified: 'read_failed' });
    expect(repo(r).status).toBe('unknown');
  });

  it('runs one assessment for concurrent misses of one installation', async () => {
    const { service, calls } = setup(world());
    const [a, b, c] = await Promise.all([service.readiness(caller, 55), service.readiness(caller, 55), service.readiness(caller, 55, { refresh: true })]);
    expect(calls.filter((n) => n === 'installation')).toHaveLength(1);
    expect(a.checkedAt).toBe(b.checkedAt);
    expect(c.checkedAt).toBe(a.checkedAt);
  });

  it('leaves a read that takes too long unverified instead of holding the page', async () => {
    const { service } = setup(world(), { readTimeoutMs: 20, killSwitch: { engaged: () => new Promise(() => {}) } });
    const r = await service.readiness(caller, 55);
    expect(get(r, 'kill-switch')).toMatchObject({ state: 'unverified', unverified: 'read_failed' });
    expect(repo(r).status).toBe('unknown');
  });

  it('marks deployment checks it cannot make as not checked, never as passing', async () => {
    const { service } = setup(world(), { killSwitch: undefined, imageVersion: undefined, quotas: undefined });
    const r = await service.readiness(caller, 55);
    for (const id of ['kill-switch', 'job-image', 'quota']) expect(get(r, id), id).toMatchObject({ state: 'unverified', unverified: 'not_checked' });
    expect(repo(r).status).toBe('unknown');
  });

  it('shows unconfigured CI repair and missing Actions log access without blocking the repository', async () => {
    const r = await setup(world({ rules: { loop: true, repositories: { 'acme/web': rule({ ci: undefined }) } } })).service.readiness(caller, 55);
    expect(get(r, 'ci')).toMatchObject({ state: 'off', required: false, summary: expect.stringContaining('not configured'), fix: { target: 'config' } });
    // Without CI repair, check_suite is not needed.
    const w = world({ rules: { loop: true, repositories: { 'acme/web': rule({ ci: undefined }) } } });
    (w.installation as GitHubInstallation).events = ['issues', 'pull_request', 'pull_request_review'];
    (w.installation as GitHubInstallation).permissions = { ...ALL, actions: undefined as never };
    const r2 = await setup(w).service.readiness(caller, 55);
    expect(get(r2, 'github-events')).toMatchObject({ state: 'verified' });
    expect(repo(r2).status).toBe('ready');

    const logs = world();
    const { actions: _drop, ...noActions } = ALL;
    (logs.installation as GitHubInstallation).permissions = noActions;
    const r3 = await setup(logs).service.readiness(caller, 55);
    expect(get(r3, 'ci-logs')).toMatchObject({ state: 'failing', required: false, problem: 'permissions' });
    expect(repo(r3).status).toBe('ready');
  });

  it('shows review off as optional, and owner-paused workflows without blocking new issues', async () => {
    const r = await setup(world({
      rules: { loop: true, repositories: { 'acme/web': rule({ review: undefined, revise: undefined, ci: undefined }) } },
      pauses: [{ jobId: 'job_a', at: 1, by: 'pat', repositoryId: 9, subject: 12, issue: 12 }, { jobId: 'job_a', at: 1, by: 'pat', repositoryId: 9, subject: 13, issue: 12, pullRequest: 13 },
        { jobId: 'job_b', at: 1, by: 'pat', repositoryId: 77, subject: 5, issue: 5 }],
    })).service.readiness(caller, 55);
    expect(get(r, 'review')).toMatchObject({ state: 'off', required: false });
    expect(get(r, 'workflow-pauses')).toMatchObject({ state: 'failing', required: false, problem: 'paused', summary: expect.stringContaining('#12'), fix: { target: 'workflows' } });
    expect(get(r, 'workflow-pauses')!.summary).not.toContain('#5');
    expect(repo(r).status).toBe('ready');
  });

  describe('a workflow on the Claude subscription', () => {
    it('needs no Anthropic key, and reports an expired sign-in before dispatch', async () => {
      const r = await setup(world({ keys: [], native: { readiness: async () => 'expired' } })).service.readiness(caller, 55);
      expect(get(r, 'agent-keys')).toBeUndefined();
      expect(get(r, 'subscription')).toMatchObject({ state: 'failing', problem: 'missing_credentials', summary: expect.stringContaining('expired'), fix: { target: 'claude' } });
      expect(repo(r).status).toBe('action_needed');
      // A job routed to the subscription runs on its own environment: no job image is needed.
      expect(get(r, 'job-image')).toBeUndefined();
    });

    it.each([
      ['ready', 'verified', undefined, 'ready'],
      ['image-revoked', 'failing', 'reconnect', 'action_needed'],
      ['protocol-incompatible', 'failing', 'reconnect', 'action_needed'],
      ['not-connected', 'failing', 'missing_credentials', 'action_needed'],
      ['worker-starting', 'failing', 'transient', 'temporarily_unavailable'],
      ['heartbeat-stale', 'failing', 'transient', 'temporarily_unavailable'],
    ] as const)('maps %s to what dispatch would do', async (readiness, state, problem, status) => {
      const r = await setup(world({ native: { readiness: async () => readiness } })).service.readiness(caller, 55);
      expect(get(r, 'subscription')).toMatchObject({ state, ...(problem ? { problem } : {}) });
      expect(repo(r).status).toBe(status);
    });

    it('is unknown when the worker cannot be read, never ready', async () => {
      const r = await setup(world({ native: { readiness: async () => { throw new Error('DynamoDB'); } } })).service.readiness(caller, 55);
      expect(get(r, 'subscription')).toMatchObject({ state: 'unverified', unverified: 'read_failed' });
      expect(repo(r).status).toBe('unknown');
      const binding = await setup(world({ native: new Error('x') })).service.readiness(caller, 55);
      expect(get(binding, 'subscription')).toMatchObject({ state: 'unverified' });
    });

    it('reads the worker only when a trigger is routed to it, exactly as dispatch routes', async () => {
      // Owner-chosen triggers route only workflows that run Claude (need the Anthropic key).
      const codex = setup(world({ rules: { loop: true, repositories: { 'acme/web': rule({ keys: ['CODEX_API_KEY'] }) } }, keys: [{ name: 'CODEX_API_KEY', configured: true, required: true }],
        native: { explicitTriggers: true, readiness: async () => 'expired' } }));
      const r = await codex.service.readiness(caller, 55);
      expect(get(r, 'subscription')).toBeUndefined();
      expect(codex.readiness).not.toHaveBeenCalled();
      expect(repo(r).status).toBe('ready');
      // Subscription mode off: the Anthropic key is what the job needs.
      const off = setup(world({ keys: [], native: { enabled: false, readiness: async () => 'ready' } }));
      const r2 = await off.service.readiness(caller, 55);
      expect(get(r2, 'agent-keys')).toMatchObject({ state: 'failing', problem: 'missing_credentials' });
      expect(off.readiness).not.toHaveBeenCalled();
    });
  });

  it('caches for a minute, re-reads when the published configuration or status changes, and bounds refreshes', async () => {
    const w = world();
    const { service, clock, calls } = setup(w);
    const first = await service.readiness(caller, 55);
    const reads = calls.length;
    w.keys = [{ name: 'ANTHROPIC_API_KEY', configured: false, required: true }];
    clock.now += 30_000;
    const cached = await service.readiness(caller, 55);
    // Stale, and says so: the time it was checked, and that it is a cached answer.
    expect(cached).toMatchObject({ cached: true, checkedAt: first.checkedAt });
    expect(repo(cached).status).toBe('ready');
    expect(calls.length).toBe(reads);
    // A refresh reads again (once the last check is more than seconds old).
    const fresh = await service.readiness(caller, 55, { refresh: true });
    expect(fresh.cached).toBe(false);
    expect(repo(fresh).status).toBe('action_needed');
    clock.now += 1_000;
    expect((await service.readiness(caller, 55, { refresh: true })).cached).toBe(true);
    // A new published version is read at once, whatever the cache holds.
    w.tenant = { ...w.tenant, activeConfigVersion: 4 };
    expect(await service.readiness(caller, 55)).toMatchObject({ cached: false, configVersion: 4 });
    clock.now += 61_000;
    expect((await service.readiness(caller, 55)).cached).toBe(false);
  });

  it('checks membership on every call, cached or not, and reads only the caller\'s installation', async () => {
    const w = world();
    const { service } = setup(w);
    await service.readiness(caller, 55);
    w.member = false;
    await expect(service.readiness(caller, 55)).rejects.toThrow('not a member');
    await expect(service.readiness(caller, 56)).rejects.toThrow('not a member');
  });

  it('carries no secret, and makes no write, worker start or model call', async () => {
    const w = world({
      telemetry: { provider: 'honeycomb', enabled: true, region: 'us', serviceName: 'updraft', captureContent: false, updatedAt: '', updatedBy: '', key: { updatedAt: '', updatedBy: '', secretVersion: 'secret-version-xyz' } },
      native: { readiness: async () => 'ready' },
    });
    const { service, calls, readiness } = setup(w);
    const r = await service.readiness(caller, 55);
    expect(JSON.stringify(r)).not.toContain('secret-version-xyz');
    expect(get(r, 'telemetry')).toMatchObject({ state: 'verified', required: false });
    expect(new Set(calls)).toEqual(new Set(['getConfigVersion', 'getUsage', 'listRecentJobs', 'listWorkflowPauses', 'getTelemetry', 'installation', 'repositories', 'keys', 'killSwitch', 'imageVersion', 'native']));
    expect(readiness).toHaveBeenCalledTimes(1);
  });

  it('takes evidence from the latest finished job, and only under the current configuration', async () => {
    const summary = (over: Partial<JobSummary>): JobSummary => ({ jobId: 'job_x0000001', installationId: 55, repository: 'acme/web', status: 'finished', outcome: 'succeeded', createdAt: '2026-11-24T00:00:00Z', finishedAt: '2026-11-24T00:10:00Z', configVersion: 3, ...over } as JobSummary);
    const ok = await setup(world({ jobs: [summary({ status: 'launched', outcome: undefined, jobId: 'job_running01' }), summary({})] })).service.readiness(caller, 55);
    expect(get(ok, 'execution')).toMatchObject({ state: 'verified', required: false, summary: expect.stringContaining('not a promise') });
    expect(repo(ok).lastJob).toEqual({ jobId: 'job_x0000001', result: 'success', at: '2026-11-24T00:10:00Z', configVersion: 3 });
    expect(executionCheck({ jobId: 'j', result: 'success', at: 't', configVersion: 2 }, 3, true)).toMatchObject({ state: 'unverified', unverified: 'needs_run' });
    expect(executionCheck({ jobId: 'j', result: 'verify_failure', at: 't', configVersion: 3 }, 3, true)).toMatchObject({ state: 'failing', required: false, fix: { target: 'job' } });
    expect(executionCheck(undefined, 3, false)).toMatchObject({ state: 'unverified', unverified: 'read_failed' });
  });

  it('decides a repository from its most pressing required check', () => {
    const c = (state: ReadinessCheck['state'], extra: Partial<ReadinessCheck> = {}): ReadinessCheck => ({ id: 'x', stage: 'config', required: true, state, summary: '', ...extra });
    expect(combineStatus([c('verified'), c('unverified', { unverified: 'needs_run' })])).toBe('ready');
    expect(combineStatus([c('verified'), c('failing', { required: false, problem: 'invalid_config' })])).toBe('ready');
    expect(combineStatus([c('unverified', { unverified: 'read_failed' })])).toBe('unknown');
    expect(combineStatus([c('failing', { problem: 'transient' }), c('unverified', { unverified: 'read_failed' })])).toBe('temporarily_unavailable');
    expect(combineStatus([c('failing', { problem: 'transient' }), c('failing', { problem: 'paused' })])).toBe('paused');
    expect(combineStatus([c('failing', { problem: 'paused' }), c('failing', { problem: 'missing_credentials' })])).toBe('action_needed');
    expect(subscriptionCheck('auth-unavailable')).toMatchObject({ state: 'failing', problem: 'transient' });
  });

  it('is served at /readiness, never cached on the way, with refresh passed through', async () => {
    const readiness = vi.fn(async () => ({ checkedAt: 'now', cached: false, configVersion: 1, installation: [], repositories: [], limitations: [] }));
    const app = createApp({ resolveCaller: () => caller, readiness: { readiness } });
    const res = await app.request('/api/v1/installations/55/readiness?refresh=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(readiness).toHaveBeenCalledWith(caller, 55, { refresh: true });
    expect((await app.request('/api/v1/installations/abc/readiness')).status).toBe(404);
    readiness.mockRejectedValueOnce(new FlowError('not_authorized', 403, 'no'));
    expect((await app.request('/api/v1/installations/56/readiness')).status).toBe(403);
  });
});
