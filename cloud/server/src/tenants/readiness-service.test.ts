import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import type { GitHubInstallation, GitHubRepository } from '../github/client.js';
import { createLauncher, type LaunchDeps, type NativeLaunch, type NativeReadiness } from '../jobs/launch.js';
import { parseManagedWorkerId } from '../native/provider.js';
import { createMemoryStore } from '../store/store.js';
import { dispatchRules } from './dispatch.js';
import { DEFAULT_QUOTAS } from '../jobs/quotas.js';
import { createKillSwitch } from '../jobs/kill-switch.js';
import type { ConfigVersion, DispatchRules, HeldPause, JobSummary, TelemetrySettings, Tenant, Usage } from '../store/store.js';
import type { AgentKeyView } from './agent-key-service.js';
import {
  codexUnsupportedCheck, combineStatus, createReadinessService, executionCheck, nativeBindingOf, routedToSubscription, subscriptionCheck,
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
  /** Codex's session (ChatGPT plan); absent: no Codex deployed (no `codex` dependency). */
  codex?: Partial<NativeBinding> & { readiness?: () => Promise<NativeReadiness> } | Error | null;
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
  const codexReadiness = vi.fn(async () => {
    const n = w.codex;
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
    ...(w.codex !== undefined ? {
      codex: track('codex', async (id: number) => {
        expect(id).toBe(55);
        const n = w.codex;
        if (n instanceof Error) throw n;
        if (!n) return undefined;
        return { enabled: n.enabled ?? true, explicitTriggers: true, triggers: n.triggers ?? [{ repositoryId: 9, repository: 'acme/web', label: 'updraft' }], readiness: codexReadiness,
          ...(n.unavailable ? { unavailable: n.unavailable, ...(n.image ? { image: n.image } : {}) } : {}) };
      }),
    } : {}),
    ...extra,
  };
  return { service: createReadinessService(deps), clock, calls, readiness, codexReadiness };
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

  it('reports what waits in the admission queue, for information only', async () => {
    const entry = (over: Record<string, unknown>) => ({ jobId: 'job_q', installationId: 55, repository: 'acme/web', repositoryId: 9, deliveryId: 'd', eventName: 'issues', eventKey: 'k', route: 'standard',
      configVersion: 3, reason: 'concurrent_jobs', state: 'queued', enqueuedAt: NOW - 12 * 60_000, expiresAt: NOW + 1, attempts: 0, ...over }) as never;
    const listed = [entry({}), entry({ jobId: 'job_r', enqueuedAt: NOW - 60_000 }), entry({ state: 'admitted' }), entry({ repositoryId: 77 })];
    const list = vi.fn(async (id: number) => { expect(id).toBe(55); return listed; });
    // depth == found: exact.
    const r = await setup(world(), { queue: { list, depth: async () => 3 } }).service.readiness(caller, 55);
    expect(get(r, 'queue')).toMatchObject({ state: 'failing', required: false, problem: 'transient', summary: expect.stringMatching(/^2 jobs wait/) });
    expect(get(r, 'queue')!.summary).toContain('12 min');
    expect(repo(r).status).toBe('ready');
    // depth 0: verified without listing.
    const none = vi.fn(async () => listed);
    const empty = await setup(world(), { queue: { list: none, depth: async () => 0 } }).service.readiness(caller, 55);
    expect(get(empty, 'queue')).toMatchObject({ state: 'verified', required: false });
    expect(none).not.toHaveBeenCalled();
    // depth > found: a lower bound where some were found, unverified where none were.
    const partial = await setup(world(), { queue: { list, depth: async () => 9 } }).service.readiness(caller, 55);
    expect(get(partial, 'queue')).toMatchObject({ state: 'failing', required: false, summary: expect.stringMatching(/^At least 2 jobs wait/) });
    const other = await setup(world(), { queue: { list: async () => [entry({ repositoryId: 77 })], depth: async () => 5 } }).service.readiness(caller, 55);
    expect(get(other, 'queue')).toMatchObject({ state: 'unverified', unverified: 'read_failed', required: false });
    expect(repo(other).status).toBe('ready');
    const unread = await setup(world(), { queue: { list, depth: async () => { throw new Error('x'); } } }).service.readiness(caller, 55);
    expect(get(unread, 'queue')).toMatchObject({ state: 'unverified', required: false });
    expect(repo(unread).status).toBe('ready');
    expect(get(await setup(world()).service.readiness(caller, 55), 'queue')).toBeUndefined();
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

  describe('a workflow on the Codex subscription (ChatGPT plan, #200)', () => {
    const codexRule = (keys: string[], over: Partial<Rule> = {}): DispatchRules => ({ loop: true, repositories: { 'acme/web': rule({ keys, ...over }) } });

    it('needs no CODEX_API_KEY when routed to Codex, and still needs a Claude reviewer\'s key', async () => {
      const r = await setup(world({ rules: codexRule(['CODEX_API_KEY']), keys: [], codex: { readiness: async () => 'ready' } })).service.readiness(caller, 55);
      expect(get(r, 'agent-keys')).toBeUndefined();
      expect(get(r, 'codex-subscription')).toMatchObject({ state: 'verified', provider: 'codex' });
      expect(repo(r).status).toBe('ready');
      // A job routed to the Codex subscription runs on its own environment: no job image is needed.
      expect(get(r, 'job-image')).toBeUndefined();
      // Codex codes, Claude reviews on its API key (no Claude subscription here): that key is still required.
      const reviewer = await setup(world({ rules: codexRule(['CODEX_API_KEY', 'ANTHROPIC_API_KEY']), keys: [], codex: {} })).service.readiness(caller, 55);
      expect(get(reviewer, 'agent-keys')).toMatchObject({ state: 'failing', problem: 'missing_credentials', summary: expect.stringContaining('ANTHROPIC_API_KEY') });
      expect(get(reviewer, 'agent-keys')!.summary).not.toContain('CODEX_API_KEY');
      expect(get(reviewer, 'codex-subscription')).toMatchObject({ state: 'verified' });
    });

    it('still reports a missing CODEX_API_KEY for a trigger not routed to Codex, and reads no Codex worker', async () => {
      for (const codex of [{ triggers: [{ repositoryId: 9, repository: 'acme/web', label: 'other' }] }, { enabled: false }, null]) {
        const s = setup(world({ rules: codexRule(['CODEX_API_KEY']), keys: [], codex }));
        const r = await s.service.readiness(caller, 55);
        expect(get(r, 'agent-keys')).toMatchObject({ state: 'failing', problem: 'missing_credentials', summary: expect.stringContaining('CODEX_API_KEY') });
        expect(get(r, 'codex-subscription')).toBeUndefined();
        expect(s.codexReadiness).not.toHaveBeenCalled();
      }
    });

    it('shows a Codex check only when a trigger is routed to Codex', async () => {
      // A Claude workflow on Claude's subscription, with Codex deployed: Codex is never asked.
      const claude = setup(world({ native: { readiness: async () => 'ready' }, codex: { readiness: async () => 'expired' } }));
      const r = await claude.service.readiness(caller, 55);
      expect(get(r, 'codex-subscription')).toBeUndefined();
      expect(get(r, 'subscription')).toMatchObject({ state: 'verified' });
      expect(claude.codexReadiness).not.toHaveBeenCalled();
    });

    it.each([
      ['ready', 'verified', undefined, 'ready'],
      ['auth-required', 'failing', 'missing_credentials', 'action_needed'],
      ['not-connected', 'failing', 'missing_credentials', 'action_needed'],
      ['expired', 'failing', 'missing_credentials', 'action_needed'],
      ['environment-ended', 'failing', 'reconnect', 'action_needed'],
      ['worker-starting', 'failing', 'transient', 'temporarily_unavailable'],
    ] as const)('maps the Codex worker\'s %s to what dispatch would do', async (readiness, state, problem, status) => {
      const r = await setup(world({ rules: codexRule(['CODEX_API_KEY']), keys: [], codex: { readiness: async () => readiness } })).service.readiness(caller, 55);
      const c = get(r, 'codex-subscription')!;
      expect(c).toMatchObject({ stage: 'subscription', provider: 'codex', state, ...(problem ? { problem } : {}) });
      expect(c.summary).toContain('Codex');
      expect(c.summary).not.toContain('Claude');
      if (problem === 'missing_credentials' || problem === 'reconnect') expect(c.fix).toMatchObject({ target: 'codex', text: expect.stringContaining('ChatGPT') });
      expect(repo(r).status).toBe(status);
    });

    it('fails, naming the image, when the worker image cannot run Codex, and never asks the worker', async () => {
      const s = setup(world({ rules: codexRule(['CODEX_API_KEY']), keys: [], codex: { unavailable: 'no Codex capability', image: 'v7', readiness: async () => 'ready' } }));
      const r = await s.service.readiness(caller, 55);
      expect(get(r, 'codex-subscription')).toMatchObject({ state: 'failing', problem: 'provider', provider: 'codex', fix: { target: 'codex' }, summary: expect.stringContaining('image (v7) does not support Codex') });
      expect(s.codexReadiness).not.toHaveBeenCalled();
      // The job is refused, never moved to the API key: the key is still not needed.
      expect(get(r, 'agent-keys')).toBeUndefined();
      expect(repo(r).status).toBe('temporarily_unavailable');
      expect(codexUnsupportedCheck(undefined).summary).toContain("subscription worker image does not support Codex");
    });

    it('is unverified when the Codex binding or worker cannot be read, and never says the key is missing', async () => {
      const r = await setup(world({ rules: codexRule(['CODEX_API_KEY']), keys: [], codex: new Error('DynamoDB') })).service.readiness(caller, 55);
      expect(get(r, 'codex-subscription')).toMatchObject({ state: 'unverified', unverified: 'read_failed', provider: 'codex', summary: expect.stringContaining('Codex subscription routing') });
      expect(get(r, 'agent-keys')).toMatchObject({ state: 'unverified', summary: expect.stringContaining('CODEX_API_KEY is not set') });
      expect(get(r, 'agent-keys')!.summary).toContain('Codex subscription');
      expect(repo(r).status).toBe('unknown');
      // A workflow that cannot be Codex's is not held up by Codex's routing.
      const claudeOnly = await setup(world({ codex: new Error('DynamoDB') })).service.readiness(caller, 55);
      expect(get(claudeOnly, 'codex-subscription')).toBeUndefined();
      expect(repo(claudeOnly).status).toBe('ready');
      // The worker itself unreadable.
      const worker = await setup(world({ rules: codexRule(['CODEX_API_KEY']), keys: [], codex: { readiness: async () => { throw new Error('VM'); } } })).service.readiness(caller, 55);
      expect(get(worker, 'codex-subscription')).toMatchObject({ state: 'unverified', unverified: 'read_failed', summary: expect.stringContaining('Codex subscription worker could not be read') });
    });

    it('names each provider whose routing is unread when no job image is published', async () => {
      const both = rule({ keys: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'] });
      const unread = await setup(world({ rules: { loop: true, repositories: { 'acme/web': both } }, keys: [], imageVersion: null, native: new Error('x'), codex: new Error('y') })).service.readiness(caller, 55);
      expect(get(unread, 'job-image')).toMatchObject({ state: 'unverified', summary: expect.stringContaining('rather than the Claude or Codex subscription') });
      const claude = await setup(world({ keys: [], imageVersion: null, native: new Error('x') })).service.readiness(caller, 55);
      expect(get(claude, 'job-image')!.summary).toContain('rather than the Claude subscription');
      const codex = await setup(world({ rules: codexRule(['CODEX_API_KEY']), keys: [], imageVersion: null, codex: new Error('y') })).service.readiness(caller, 55);
      expect(get(codex, 'job-image')!.summary).toContain('rather than the Codex subscription');
    });

    it('leaves Claude\'s check as it was', () => {
      expect(subscriptionCheck('expired')).toEqual(subscriptionCheck('expired', 'claude'));
      expect(subscriptionCheck('expired')).not.toHaveProperty('provider');
      expect(subscriptionCheck('not-connected', 'codex')).toMatchObject({ id: 'codex-subscription', provider: 'codex', fix: { text: 'Sign in with ChatGPT', target: 'codex' } });
    });
  });

  describe('readiness and dispatch route a trigger the same way (#200)', () => {
    const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/root';
    const trigger = { repositoryId: 9, repository: 'acme/web', label: 'updraft' };
    const launchBinding = (provider: 'claude' | 'codex', enabled = true): NativeLaunch => ({
      route: { installationId: 55, workerId: provider === 'codex' ? 'managed-codex-55' : 'managed-55', microvmId: `mvm-${provider}`, imageVersion: '7', generation: `${provider}-gen`, controlSecretArn: SECRET_ARN },
      ...(provider === 'codex' ? { provider } : {}),
      secret: async () => `${provider}-scoped-worker-secret-0123456789`,
      mode: async () => ({ enabled, revision: 1, routingVersion: 4, triggers: [trigger] }),
      readiness: async () => 'ready',
    });

    it.each([
      ['a Claude-routed trigger', ['ANTHROPIC_API_KEY'], true, true, 'claude'],
      ['a Codex-routed trigger', ['CODEX_API_KEY'], true, true, 'codex'],
      ['a trigger both could take (Claude first)', ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'], true, true, 'claude'],
      ['a trigger both could take, with Claude routing off', ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'], false, true, 'codex'],
      ['a trigger with Codex routing off', ['CODEX_API_KEY'], true, false, undefined],
      ['a workflow that does not need CODEX_API_KEY', ['KIRO_API_KEY'], true, true, undefined],
    ] as const)('%s', async (_name, keys, claudeOn, codexOn, expected) => {
      const store = createMemoryStore();
      await store.putTenantWithMember({ installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '', createdBy: 's' },
        { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
      const version = await store.createConfigVersion(55, { sha256: keys.join(), files: [], publishedBy: 's', publishedAt: '', dispatch: dispatchRules({
        dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
      }, { keysFor: () => [...keys] }) });
      await store.markConfigReady(55, version as number);
      await store.activateConfig(55, version as number);
      // Every key set: a trigger left to the API-key path launches there rather than being refused.
      for (const name of keys) await store.putAgentKeyMeta(55, { name, updatedAt: 't', updatedBy: 'pat' });
      const claude = launchBinding('claude', claudeOn);
      const codex = launchBinding('codex', codexOn);
      const deps: LaunchDeps = {
        store,
        settings: { region: 'us-east-1', bucket: 'b', imageArn: 'arn:image', executionRoleArn: 'arn:role', ingressConnectorArn: 'in', egressConnectorArn: 'out',
          logGroup: 'lg', brokerFunctionName: 'broker', maximumDurationSeconds: 10800, watchdogReserveSeconds: 600 },
        imageVersion: async () => '3',
        putEvent: async () => {},
        runMicrovm: async () => ({ microvmId: 'mvm-api' }),
        quotas: { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 },
        now: () => NOW,
        log: () => {},
        retryDelayMs: 1,
        resolveNative: async () => claude,
        resolveCodex: async () => codex,
      };
      const payload = { action: 'labeled', issue: { number: 12 }, label: { name: 'updraft' }, sender: { login: 'pat' }, repository: { id: 9, full_name: 'acme/web' } };
      const result = await createLauncher(deps)({ installationId: 55, deliveryId: 'delivery-1', body: JSON.stringify(payload), payload });
      expect(result).toMatchObject({ disposition: 'launched' });
      const job = (await store.getJob(result.jobId!))!;
      const dispatched = job.native ? parseManagedWorkerId(job.native.workerId)?.provider : undefined;

      // The same published rules and the same bindings, read as readiness reads them.
      const rules = (await store.getConfigVersion(55, version as number))!.dispatch!;
      const r = rules.repositories['acme/web']!;
      const bindings = { claude: await nativeBindingOf(claude), codex: await nativeBindingOf(codex, 'codex') };
      const assessed = routedToSubscription(bindings, 'acme/web', r, r.triggers[0]!);
      expect(dispatched).toBe(expected);
      expect(assessed).toBe(dispatched);
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
