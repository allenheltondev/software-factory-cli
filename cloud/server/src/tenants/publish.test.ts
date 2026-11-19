import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, type Tenant } from '../store/store.js';
import { agentEnvSecretName, setAgentKey, type SecretsPort } from './agent-keys.js';
import type { TenantSubmission } from './config.js';
import { configPrefix, publishTenantConfig } from './publish.js';

const NOW = Date.UTC(2026, 10, 19);
const tenant: Tenant = {
  installationId: 55,
  accountId: 900,
  accountLogin: 'acme',
  accountType: 'Organization',
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 'sub-pat',
};

const submission = (label = 'ready'): TenantSubmission => ({
  config: {
    dispatch: { allowedActors: ['pat'] },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement-issue.md' } },
    repositories: { 'acme/web': { workflows: [{ trigger: { event: 'issue.labeled', label }, action: 'implement-issue', pool: 'general' }] } },
  },
  prompts: { 'implement-issue.md': '# Implement' },
});

async function setup() {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant, { installationId: 55, sub: 'sub-pat', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: tenant.createdAt });
  const objects = new Map<string, string>();
  const putObject = vi.fn(async (key: string, body: string) => {
    objects.set(key, body);
  });
  const publish = (s = submission()) =>
    publishTenantConfig(
      { installationId: 55, submission: s, platform: { appId: 4242 }, repositoryIds: new Map([['acme/web', 99]]), publishedBy: 'admin' },
      { store, putObject, now: () => NOW },
    );
  return { store, objects, putObject, publish };
}

describe('publishTenantConfig', () => {
  it('stores the bundle under a new version and activates it', async () => {
    const { store, objects, publish } = await setup();
    const r = await publish();
    expect(r).toMatchObject({ ok: true, version: 1 });
    expect([...objects.keys()].sort()).toEqual([`${configPrefix(55, 1)}config.yaml`, `${configPrefix(55, 1)}prompts/implement-issue.md`]);
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
    expect(await store.listConfigVersions(55)).toEqual([
      expect.objectContaining({ version: 1, status: 'ready', files: ['config.yaml', 'prompts/implement-issue.md'], publishedBy: 'admin', publishedAt: '2026-11-19T00:00:00.000Z' }),
    ]);
  });

  it('never rewrites a version: each publish is the next one', async () => {
    const { store, objects, publish } = await setup();
    await publish(submission('ready'));
    const r = await publish(submission('go'));
    expect(r).toMatchObject({ ok: true, version: 2 });
    expect(objects.get(`${configPrefix(55, 1)}config.yaml`)).toContain('label: ready');
    expect(objects.get(`${configPrefix(55, 2)}config.yaml`)).toContain('label: go');
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(2);
  });

  it('keeps the active version when the new config is invalid, storing nothing', async () => {
    const { store, objects, publish } = await setup();
    await publish();
    objects.clear();
    const bad = submission();
    (bad.config as Record<string, unknown>).github = { app: { appId: 1 } };
    expect(await publish(bad)).toMatchObject({ ok: false, reason: 'invalid', errors: [expect.objectContaining({ path: 'github' })] });
    expect(objects.size).toBe(0);
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
  });

  it('keeps the active version when the upload fails; the half-stored version is never activated', async () => {
    const { store, putObject, publish } = await setup();
    await publish();
    putObject.mockRejectedValueOnce(new Error('S3 is down'));
    await expect(publish(submission('go'))).rejects.toThrow('S3 is down');
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
    expect((await store.listConfigVersions(55)).map((v) => [v.version, v.status])).toEqual([
      [1, 'ready'],
      [2, 'pending'],
    ]);
    expect(await store.activateConfig(55, 2)).toBe('not_ready');
  });

  it('refuses an unknown or uninstalled tenant', async () => {
    const { store, publish } = await setup();
    await store.markUninstalled(55, NOW + 1000);
    expect(await publish()).toMatchObject({ ok: false, reason: 'uninstalled' });
    const other = await publishTenantConfig(
      { installationId: 66, submission: submission(), platform: { appId: 4242 }, repositoryIds: new Map([['acme/web', 99]]), publishedBy: 'admin' },
      { store, putObject: async () => {} },
    );
    expect(other).toMatchObject({ ok: false, reason: 'no_tenant' });
  });
});

describe('setAgentKey', () => {
  function secrets() {
    const values = new Map<string, string>();
    const tags = new Map<string, Record<string, string>>();
    const port: SecretsPort = {
      get: async (name) => values.get(name),
      put: async (name, value, t) => {
        values.set(name, value);
        if (!tags.has(name)) tags.set(name, t);
      },
    };
    return { port, values, tags };
  }
  const ANTHROPIC = `sk-ant-api03-${'a'.repeat(40)}`;
  const OPENAI = `sk-proj-${'b'.repeat(40)}`;

  it('writes the key into the tenant\'s own secret, keeping the other key, and records only that it is set', async () => {
    const { store } = await setup();
    const s = secrets();
    expect(await setAgentKey({ installationId: 55, name: 'ANTHROPIC_API_KEY', value: ANTHROPIC, updatedBy: 'admin' }, { secrets: s.port, store, now: () => NOW })).toMatchObject({ ok: true });
    await setAgentKey({ installationId: 55, name: 'CODEX_API_KEY', value: OPENAI, updatedBy: 'admin' }, { secrets: s.port, store, now: () => NOW });
    expect(JSON.parse(s.values.get(agentEnvSecretName(55))!)).toEqual({ ANTHROPIC_API_KEY: ANTHROPIC, CODEX_API_KEY: OPENAI });
    expect(s.tags.get(agentEnvSecretName(55))).toEqual({ installationId: '55', app: 'updraft-cloud' });
    const meta = await store.listAgentKeyMeta(55);
    expect(meta.map((m) => m.name)).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
    expect(JSON.stringify(meta)).not.toContain('sk-');
  });

  it('refuses an unknown name, a value of the wrong shape (without repeating it), and a missing tenant', async () => {
    const { store } = await setup();
    const s = secrets();
    const set = (installationId: number, name: string, value: string) => setAgentKey({ installationId, name, value, updatedBy: 'admin' }, { secrets: s.port, store });
    expect(await set(55, 'AWS_SECRET_ACCESS_KEY', ANTHROPIC)).toMatchObject({ ok: false, message: expect.stringMatching(/not an agent key/) });
    const wrong = await set(55, 'ANTHROPIC_API_KEY', OPENAI);
    expect(wrong).toMatchObject({ ok: false, message: expect.stringMatching(/does not look like/) });
    expect(JSON.stringify(wrong)).not.toContain('bbbb');
    expect(await set(66, 'ANTHROPIC_API_KEY', ANTHROPIC)).toMatchObject({ ok: false, message: expect.stringMatching(/no tenant/) });
    expect(s.values.size).toBe(0);
  });
});
