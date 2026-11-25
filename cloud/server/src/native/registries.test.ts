import { beforeEach, describe, expect, it } from 'vitest';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import { createMemoryStore, type MemberRole, type Tenant } from '../store/store.js';
import {
  DEFAULT_REGISTRY_HOSTS, MAX_REGISTRY_HOSTS, createRegistryPolicyService, effectiveRegistryHosts, parseRegistryHost, parseRegistryHosts,
} from './registries.js';

const VALID = ['npm.pkg.github.com', 'acme.jfrog.io', 'acme-123456789012.d.codeartifact.us-east-1.amazonaws.com', '*.artifacts.acme.dev', 'NEXUS.Acme.com.'];
const INVALID = [
  '10.0.0.1', '169.254.169.254', '[fd00:ec2::254]', '::1', '0177.0.0.1', 'https://npm.pkg.github.com', 'npm.pkg.github.com/path', 'npm.pkg.github.com:443',
  '*', '*.com', '**.acme.dev', 'a.*.acme.dev', 'localhost', 'registry', 'registry.localhost', 'nexus.corp', 'mirror.internal', 'npm.svc.cluster.local',
  'router.home.arpa', '1.0.0.127.in-addr.arpa', 'bad_host.acme.dev', '-x.acme.dev', '*.amazonaws.com', '*.s3.amazonaws.com', '*.jfrog.io', '*.github.io', '*.co.uk', '',
];

describe('package registry hosts (#157)', () => {
  it.each(VALID)('accepts %j', (entry) => {
    expect(parseRegistryHost(entry)).toHaveProperty('host');
  });
  it.each(INVALID)('refuses %j with a reason', (entry) => {
    const out = parseRegistryHost(entry);
    expect(out).toHaveProperty('problem');
    expect((out as { problem: string }).problem.length).toBeGreaterThan(10);
  });
  it('normalizes, removes duplicates and bounds the list', () => {
    expect(parseRegistryHosts(['NPM.pkg.github.com', 'npm.pkg.github.com.', ' *.Artifacts.acme.dev '])).toEqual({ hosts: ['npm.pkg.github.com', '*.artifacts.acme.dev'] });
    expect(parseRegistryHosts(Array.from({ length: MAX_REGISTRY_HOSTS }, (_, i) => `r${i}.acme.dev`))).toHaveProperty('hosts');
    expect(parseRegistryHosts(Array.from({ length: MAX_REGISTRY_HOSTS + 1 }, (_, i) => `r${i}.acme.dev`))).toEqual({ problem: `At most ${MAX_REGISTRY_HOSTS} registry hosts` });
    expect(parseRegistryHosts('npm.pkg.github.com')).toHaveProperty('problem');
    expect(parseRegistryHosts(['npm.pkg.github.com', 42])).toHaveProperty('problem');
    expect(parseRegistryHosts(['npm.pkg.github.com', '10.0.0.1'])).toHaveProperty('problem');
  });
  it('applies none of a stored list that no longer validates', () => {
    const stored = (hosts: unknown[]) => ({ hosts, updatedAt: '', updatedBy: '' });
    expect(effectiveRegistryHosts(null)).toEqual({ hosts: [] });
    expect(effectiveRegistryHosts(stored(['npm.pkg.github.com']))).toEqual({ hosts: ['npm.pkg.github.com'] });
    expect(effectiveRegistryHosts(stored(['npm.pkg.github.com', '169.254.169.254']))).toEqual({ hosts: [], problem: 'invalid-stored-policy' });
    expect(effectiveRegistryHosts(stored([{ host: 'npm.pkg.github.com' }]))).toEqual({ hosts: [], problem: 'invalid-stored-policy' });
    // Not normalized as saved (a hand edit): refused rather than reinterpreted.
    expect(effectiveRegistryHosts(stored(['NPM.pkg.github.com', 'npm.pkg.github.com']))).toEqual({ hosts: [], problem: 'invalid-stored-policy' });
    expect(effectiveRegistryHosts(stored(Array.from({ length: MAX_REGISTRY_HOSTS + 1 }, (_, i) => `r${i}.acme.dev`)))).toEqual({ hosts: [], problem: 'invalid-stored-policy' });
  });

  it("agrees with the worker's own check, entry by entry", async () => {
    // The worker validates every host again (parseTenantHost); a host Cloud saves must never be one
    // the worker refuses, or the reverse.
    const file = new URL('../../../../deploy/aws-microvm/image/sandbox/egress-proxy.mjs', import.meta.url).href;
    const proxy = (await import(/* @vite-ignore */ file)) as {
      parseTenantHost(text: unknown): { problem?: string; host?: string; wildcard?: boolean };
      DEFAULT_REGISTRY_HOSTS: readonly string[];
      MAX_TENANT_HOSTS: number;
    };
    for (const entry of [...VALID, ...INVALID, '*.example.com', 'example.com', 'registry.acme.dev']) {
      const cloud = parseRegistryHost(entry);
      const worker = proxy.parseTenantHost(entry);
      expect({ entry, ok: 'host' in cloud }).toEqual({ entry, ok: !worker.problem });
      if ('host' in cloud) expect(cloud.host).toBe(`${worker.wildcard ? '*.' : ''}${worker.host}`);
    }
    expect([...DEFAULT_REGISTRY_HOSTS]).toEqual([...proxy.DEFAULT_REGISTRY_HOSTS]);
    expect(MAX_REGISTRY_HOSTS).toBe(proxy.MAX_TENANT_HOSTS);
  });
});

describe('package registry settings in the console', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let role: MemberRole;
  let status: Tenant['status'];
  const caller = { sub: 'pat-sub' } as Caller;
  const github = {
    async member(_: Caller, installationId: number) {
      if (installationId !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
      return { tenant: { installationId, status } as Tenant, summary: { installationId, role } as never, githubLogin: 'pat' };
    },
  } as Pick<GitHubFlows, 'member'>;
  const service = () => createRegistryPolicyService({ store, github, now: () => Date.parse('2026-11-25T12:00:00Z') });
  beforeEach(async () => {
    role = 'owner';
    status = 'active';
    store = createMemoryStore();
    await store.putTenantWithMember({ installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '', createdBy: 's' },
      { installationId: 55, sub: 'pat-sub', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
  });

  it('shows the defaults and an empty list, editable by an owner', async () => {
    expect(await service().view(caller, 55)).toEqual({ hosts: [], defaults: DEFAULT_REGISTRY_HOSTS, max: MAX_REGISTRY_HOSTS, canEdit: true, version: 0 });
  });
  it('saves a valid list over the version it was loaded at, and refuses a stale one', async () => {
    const saved = await service().update(caller, 55, { hosts: ['npm.pkg.github.com', 'NPM.pkg.github.com'], version: 0 });
    expect(saved).toMatchObject({ hosts: ['npm.pkg.github.com'], version: 1, updatedBy: 'pat', updatedAt: '2026-11-25T12:00:00.000Z' });
    expect(await store.getRegistryPolicy(55)).toMatchObject({ hosts: ['npm.pkg.github.com'], version: 1 });
    await expect(service().update(caller, 55, { hosts: ['acme.jfrog.io'], version: 0 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/reload/) });
    expect((await service().update(caller, 55, { hosts: [], version: 1 })).hosts).toEqual([]);
  });
  it.each([
    [{ hosts: ['10.0.0.1'], version: 0 }, /not a host name/],
    [{ hosts: ['*.amazonaws.com'], version: 0 }, /shared domain/],
    [{ hosts: ['nexus.corp'], version: 0 }, /internal name/],
    [{ hosts: 'npm.pkg.github.com', version: 0 }, /list of host names/],
    [{ hosts: ['npm.pkg.github.com'] }, /version/],
  ])('refuses %j at save time with a clear message, saving nothing', async (input, message) => {
    await expect(service().update(caller, 55, input)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
    expect(await store.getRegistryPolicy(55)).toBeNull();
  });
  it('lets only an owner of an active installation change the list; members see it', async () => {
    await service().update(caller, 55, { hosts: ['npm.pkg.github.com'], version: 0 });
    role = 'editor';
    expect(await service().view(caller, 55)).toMatchObject({ hosts: ['npm.pkg.github.com'], canEdit: false });
    await expect(service().update(caller, 55, { hosts: ['evil.example.dev'], version: 1 })).rejects.toMatchObject({ status: 403 });
    role = 'owner';
    status = 'disabled';
    expect((await service().view(caller, 55)).canEdit).toBe(false);
    await expect(service().update(caller, 55, { hosts: ['evil.example.dev'], version: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await store.getRegistryPolicy(55))?.hosts).toEqual(['npm.pkg.github.com']);
  });
  it("never reads or writes another installation's list", async () => {
    await expect(service().view(caller, 56)).rejects.toMatchObject({ status: 403 });
    await expect(service().update(caller, 56, { hosts: ['npm.pkg.github.com'], version: 0 })).rejects.toMatchObject({ status: 403 });
    expect(await store.getRegistryPolicy(56)).toBeNull();
  });
  it('shows a stored list that no longer validates, and that jobs get the defaults only', async () => {
    expect(await store.putRegistryPolicy(55, { hosts: ['npm.pkg.github.com', '169.254.169.254'], updatedAt: '', updatedBy: '' }, 0)).toBe('stored');
    const view = await service().view(caller, 55);
    expect(view.hosts).toEqual(['npm.pkg.github.com', '169.254.169.254']);
    expect(view.problem).toMatch(/default registries only/);
  });
  it('refuses to save for an uninstalled installation', async () => {
    await store.markUninstalled(55, Date.now() + 86_400_000);
    await expect(service().update(caller, 55, { hosts: ['npm.pkg.github.com'], version: 0 })).rejects.toMatchObject({ status: 409, code: 'uninstalled' });
  });
});
