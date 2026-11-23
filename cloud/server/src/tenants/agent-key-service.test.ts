import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import { createMemoryStore } from '../store/store.js';
import { agentKeySecretName, type SecretsPort } from './agent-keys.js';
import { createAgentKeyService } from './agent-key-service.js';
import { createBundleKeys } from './key-needs.js';
import { configPrefix } from './paths.js';
import type { KeyCheck } from './key-check.js';
import { redact, REDACTED, safeMessage } from './redact.js';

const ANTHROPIC = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
const OPENAI = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
const caller: Caller = { sub: 'u1', email: 'pat@example.com' } as Caller;

async function setup(verdict: KeyCheck = 'valid') {
  const store = createMemoryStore();
  await store.putTenantWithMember(
    { installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '', createdBy: 's' },
    { installationId: 55, sub: 'u1', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' },
  );
  const values = new Map<string, string>();
  const secrets: SecretsPort = { put: async (n, v) => void values.set(n, v), remove: async (n) => void values.delete(n) };
  const check = vi.fn(async () => verdict);
  // Membership: only installation 55's member gets a context.
  const github = {
    configContext: async (_c: Caller, id: number) => {
      if (id !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
      return { githubLogin: 'pat' } as never;
    },
    member: async (_c: Caller, id: number) => {
      if (id !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
      return {} as never;
    },
  };
  const service = createAgentKeyService({ store, github, secrets, check, now: () => Date.parse('2026-11-21T00:00:00Z') });
  const app = createApp({ resolveCaller: () => caller, agentKeys: service, logError: () => {} });
  const put = (name: string, value: unknown, id = 55) =>
    app.request(`/api/v1/installations/${id}/agent-keys/${name}`, { method: 'PUT', body: JSON.stringify({ value }), headers: { 'content-type': 'application/json' } });
  return { store, values, check, service, app, put };
}

describe('agent keys in the console (#70)', () => {
  const SUBSCRIPTION = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';

  it('saves a Claude subscription token on its shape, and sends each Claude credential to its own field', async () => {
    const { put, check, values } = await setup('unchecked');
    // The other field's value: refused, with where it goes, never repeated.
    const swapped = await put('ANTHROPIC_API_KEY', SUBSCRIPTION);
    expect(swapped.status).toBe(400);
    const text = await swapped.text();
    expect(text).toMatch(/subscription token.*CLAUDE_CODE_OAUTH_TOKEN/);
    expect(text).not.toContain(SUBSCRIPTION);
    expect(await (await put('CLAUDE_CODE_OAUTH_TOKEN', ANTHROPIC)).text()).toMatch(/Anthropic API key: set it as ANTHROPIC_API_KEY/);
    expect(check).not.toHaveBeenCalled();
    expect((await put('CLAUDE_CODE_OAUTH_TOKEN', SUBSCRIPTION)).status).toBe(200);
    expect([...values.values()]).toContain(SUBSCRIPTION);
  });

  it("does not ask for Claude's API key while a subscription token stands in for it", async () => {
    const { app, store, put } = await setup('unchecked');
    const v = await store.createConfigVersion(55, {
      sha256: 'x',
      files: ['config.yaml'],
      publishedBy: 's',
      publishedAt: '',
      dispatch: { repositories: { 'acme/web': { id: 9, actors: ['pat'], triggers: [{ label: 'updraft', keys: ['ANTHROPIC_API_KEY'] }] } } },
    });
    await store.markConfigReady(55, v as number);
    await store.activateConfig(55, v as number);
    const list = async () => ((await (await app.request('/api/v1/installations/55/agent-keys')).json()) as { keys: { name: string; required: boolean; configured: boolean; alternativeTo?: string }[] }).keys;
    expect((await list()).slice(0, 2)).toEqual([
      { name: 'ANTHROPIC_API_KEY', configured: false, required: true },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', configured: false, required: false, alternativeTo: 'ANTHROPIC_API_KEY' },
    ]);
    await put('CLAUDE_CODE_OAUTH_TOKEN', SUBSCRIPTION);
    expect((await list()).slice(0, 2)).toMatchObject([
      { name: 'ANTHROPIC_API_KEY', configured: false, required: false },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', configured: true, required: false, alternativeTo: 'ANTHROPIC_API_KEY' },
    ]);
  });

  it('saves a Kiro key on its shape alone, since Kiro offers no call to check one, and refuses another provider\'s key there', async () => {
    const { put, check, values } = await setup('unchecked');
    const KIRO = 'ksk_abcdefghijklmnopqrstuvwxyz0123456789';
    expect((await put('KIRO_API_KEY', ANTHROPIC)).status).toBe(400);
    expect((await put('KIRO_API_KEY', OPENAI)).status).toBe(400);
    expect((await put('KIRO_API_KEY', 'short')).status).toBe(400);
    expect(check).not.toHaveBeenCalled();
    const res = await put('KIRO_API_KEY', KIRO);
    expect(res.status).toBe(200);
    expect([...values.values()]).toContain(KIRO);
    expect(await res.text()).not.toContain(KIRO);
  });

  it('shows only configured, last rotated and last used, and never a value', async () => {
    const { app, put, store } = await setup();
    const res = await put('ANTHROPIC_API_KEY', ANTHROPIC);
    expect(res.status).toBe(200);
    await store.recordAgentKeyUse(55, 'ANTHROPIC_API_KEY', { at: '2026-11-21T01:00:00.000Z', ok: true, jobStartedAt: '2026-11-21T00:30:00.000Z' });
    const list = await app.request('/api/v1/installations/55/agent-keys');
    const text = await list.text();
    expect(JSON.parse(text).keys).toEqual([
      { name: 'ANTHROPIC_API_KEY', configured: true, required: false, lastRotatedAt: '2026-11-21T00:00:00.000Z', lastRotatedBy: 'pat', lastUsed: { at: '2026-11-21T01:00:00.000Z', ok: true } },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', configured: false, required: false, alternativeTo: 'ANTHROPIC_API_KEY' },
      { name: 'CODEX_API_KEY', configured: false, required: false },
      { name: 'KIRO_API_KEY', configured: false, required: false },
    ]);
    expect(text).not.toContain(ANTHROPIC);
    expect(await (await put('CODEX_API_KEY', OPENAI)).text()).not.toContain(OPENAI);
  });

  it('marks the keys the active config runs agents with as required', async () => {
    const { app, store } = await setup();
    const v = await store.createConfigVersion(55, {
      sha256: 'x',
      files: ['config.yaml'],
      publishedBy: 's',
      publishedAt: '',
      dispatch: { repositories: { 'acme/web': { id: 9, actors: ['pat'], triggers: [{ label: 'updraft', keys: ['ANTHROPIC_API_KEY'] }] }, 'acme/old': { id: 8, paused: true, actors: ['pat'], triggers: [{ label: 'codex', keys: ['CODEX_API_KEY'] }] } } },
    });
    await store.markConfigReady(55, v as number);
    await store.activateConfig(55, v as number);
    const keys = ((await (await app.request('/api/v1/installations/55/agent-keys')).json()) as { keys: { name: string; required: boolean }[] }).keys;
    expect(keys.map((k) => [k.name, k.required])).toEqual([
      ['ANTHROPIC_API_KEY', true],
      ['CLAUDE_CODE_OAUTH_TOKEN', false],
      ['CODEX_API_KEY', false],
      ['KIRO_API_KEY', false],
    ]);
  });

  it('reads what a version from before key needs were recorded requires from its bundle, and shows every key required when it cannot tell', async () => {
    for (const [bundle, expected] of [
      ['dispatch: { allowedActors: [pat] }\nagents:\n  codex: { adapter: codex }\npools:\n  p: { agents: [codex] }\nrepositories:\n  acme/web:\n    id: 9\n    workflows:\n      - { trigger: { label: updraft }, pool: p }\n', [false, false, true, false]],
      [null, [true, false, true, true]],
    ] as const) {
      const { store, service } = await setup();
      const v = await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: { repositories: { 'acme/web': { id: 9, actors: ['pat'], triggers: [{ label: 'updraft' }] } } } });
      await store.markConfigReady(55, v as number);
      await store.activateConfig(55, v as number);
      const withBundle = createAgentKeyService({
        store,
        github: { configContext: async () => ({ githubLogin: 'pat' }) as never, member: async () => ({}) as never },
        secrets: { put: async () => {}, remove: async () => {} },
        check: async () => 'valid',
        bundleKeys: createBundleKeys(async () => bundle, configPrefix),
      });
      expect((await withBundle.list(caller, 55)).keys.map((k) => k.required)).toEqual(expected);
      // Without a bundle reader: unknown, so every key.
      expect((await service.list(caller, 55)).keys.map((k) => k.required)).toEqual([true, false, true, true]);
    }
  });

  it('validates with the provider before saving: a rejected key, or an unreachable provider, saves nothing', async () => {
    for (const verdict of ['invalid', 'unavailable'] as const) {
      const { put, values, store, check } = await setup(verdict);
      const res = await put('ANTHROPIC_API_KEY', ANTHROPIC);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(JSON.parse(body).error).toBe('invalid_key');
      expect(body).not.toContain(ANTHROPIC);
      expect(check).toHaveBeenCalledTimes(1);
      expect(values.size).toBe(0);
      expect(await store.listAgentKeyMeta(55)).toEqual([]);
    }
  });

  it('rotation replaces the value, and the next job reads the new one (the secret name is the same)', async () => {
    const { put, values, store } = await setup();
    await put('ANTHROPIC_API_KEY', ANTHROPIC);
    await store.recordAgentKeyUse(55, 'ANTHROPIC_API_KEY', { at: 'x', ok: true, jobStartedAt: '2026-11-21T00:30:00.000Z' });
    const rotated = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect((await put('ANTHROPIC_API_KEY', rotated)).status).toBe(200);
    expect(values.get(agentKeySecretName(55, 'ANTHROPIC_API_KEY'))).toBe(rotated);
    // The use belonged to the old key.
    expect((await store.listAgentKeyMeta(55))[0]).not.toHaveProperty('lastUsedAt');
  });

  it('refuses a non-member, an unknown key name and a value that is not a string', async () => {
    const { put, values } = await setup();
    expect((await put('ANTHROPIC_API_KEY', ANTHROPIC, 56)).status).toBe(403);
    expect((await put('NOT_A_KEY', ANTHROPIC)).status).toBe(400);
    expect((await put('ANTHROPIC_API_KEY', 42)).status).toBe(400);
    expect(values.size).toBe(0);
  });
});

describe('redaction (#70)', () => {
  it('removes stored key values wherever they appear, and anything shaped like a key', () => {
    const log = `calling with ${ANTHROPIC}\nx-api-key: abcdef1234567890 and Authorization: Bearer abcdefghijklmnopqrstuvwxyz\nother ${OPENAI}`;
    const out = redact(log, ['custom-secret-value']);
    expect(out).not.toMatch(/sk-ant|sk-proj|abcdef1234567890|abcdefghijklmnopqrstuvwxyz/);
    expect(out).toContain(REDACTED);
    expect(redact('token custom-secret-value here', ['custom-secret-value'])).toBe(`token ${REDACTED} here`);
    expect(redact('plain text, sk-8 and short')).toBe('plain text, sk-8 and short');
  });

  it('redacts the message of an error', () => {
    expect(safeMessage(new Error(`401 for ${ANTHROPIC}`))).toBe(`401 for ${REDACTED}`);
  });
});
