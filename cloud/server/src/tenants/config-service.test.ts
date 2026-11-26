import { generateKeyPairSync } from 'node:crypto';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { createGitHubFlows } from '../flows/github.js';
import type { GitHubApi } from '../github/client.js';
import type { AppSettings } from '../github/settings.js';
import { createMemoryStore, type Store, type Tenant } from '../store/store.js';
import { createAgentKeyService } from './agent-key-service.js';
import type { SecretsPort } from './agent-keys.js';
import { createConfigService, type ObjectStore } from './config-service.js';
import { defaultConsoleConfig, type ConsoleConfig } from './console.js';
import { decideDispatch } from './dispatch.js';
import { configPrefix, SOURCE_FILE } from './paths.js';
import { publishTenantConfig } from './publish.js';
import fixture from './fixtures/console-samples.json' with { type: 'json' };

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SETTINGS: AppSettings = {
  appId: '4242',
  clientId: 'Iv1.client',
  slug: 'updraft-test',
  appUrl: 'https://updraft.example',
  privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  clientSecret: 'client-secret',
  webhookSecret: 'hook-secret',
};

const PAT: Caller = { sub: 'sub-pat' };
const EVE: Caller = { sub: 'sub-eve' };
const NOW = Date.UTC(2026, 10, 20);

const tenant = (installationId: number, accountLogin: string): Tenant => ({
  installationId,
  accountId: installationId * 10,
  accountLogin,
  accountType: 'Organization',
  status: 'active',
  createdAt: '2026-11-20T00:00:00.000Z',
  createdBy: 'sub',
});

const github: GitHubApi = {
  exchangeCode: async () => 'x',
  getUser: async () => ({ id: 1, login: 'pat' }),
  listUserInstallationIds: async () => [],
  getOrgMembership: async () => null,
  getInstallation: async () => null,
  createInstallationToken: async (_jwt, id) => ({ token: `token-${id}`, expiresAt: NOW + 60 * 60 * 1000 }),
  getBotUser: async () => ({ id: 777, login: 'updraft-test[bot]' }),
  // Installation 55 reaches acme/web and acme/api; installation 66 (another tenant) reaches globex/app.
  listInstallationRepositories: async (token) =>
    token === 'token-55'
      ? [
          { id: 99, fullName: 'acme/web', private: true, htmlUrl: 'https://github.com/acme/web' },
          { id: 100, fullName: 'acme/api', private: false, htmlUrl: 'https://github.com/acme/api' },
        ]
      : [{ id: 300, fullName: 'globex/app', private: true, htmlUrl: 'https://github.com/globex/app' }],
  createIssueComment: async () => {},
};

const repo = (over: Record<string, unknown> = {}) => ({ enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: [], ...over });
/** The defaults a new installation starts from (builders and reviewers hold Claude and Codex), with these repositories. */
const settings = (repos: Record<string, unknown> = { 'acme/web': repo() }, workflow: Record<string, unknown> = {}) => {
  const d = defaultConsoleConfig({ offered: ['claude', 'codex'], login: 'pat' });
  return { ...d, workflows: { implement: { ...d.workflows.implement!, ...workflow } }, repositories: repos };
};

let store: Store;
let objects: Map<string, string>;
let failPuts: boolean;
/** Holds uploads into config/<version>/ until released: two publishes interleaved, as in the #83 review. */
let gates: Map<number, Promise<void>>;
let app: ReturnType<typeof createApp>;
/** Agent key values as Secrets Manager would hold them (write-only to the console). */
let secrets: Map<string, string>;

/** A response, as far as the assertions read it. */
interface Body {
  [key: string]: unknown;
  ok?: boolean;
  yaml?: string;
  errors?: unknown[];
  repositories?: { fullName: string }[];
  files?: Record<string, string>;
}

async function call(caller: Caller | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(caller ? { 'x-test-sub': caller.sub } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Body };
}
const publish = (config: unknown, extra: Record<string, unknown> = {}, caller: Caller = PAT, id = 55) =>
  call(caller, 'POST', `/installations/${id}/config/publish`, { config, ...extra });

beforeEach(async () => {
  store = createMemoryStore();
  objects = new Map();
  failPuts = false;
  gates = new Map();
  for (const [t, sub, login, uid] of [
    [tenant(55, 'acme'), PAT.sub, 'pat', 1],
    [tenant(66, 'globex'), EVE.sub, 'eve', 2],
  ] as const) {
    await store.link(sub, { githubUserId: uid, githubLogin: login, linkedAt: t.createdAt });
    await store.putTenantWithMember(t, { installationId: t.installationId, sub, role: 'owner', githubUserId: uid, githubLogin: login, addedAt: t.createdAt });
    for (const name of ['ANTHROPIC_API_KEY', 'CODEX_API_KEY']) await store.putAgentKeyMeta(t.installationId, { name, updatedAt: t.createdAt, updatedBy: login });
  }
  const port: ObjectStore = {
    get: async (key) => objects.get(key) ?? null,
    put: async (key, body) => {
      if (failPuts) throw new Error('S3 is down');
      const version = Number(/\/config\/(\d+)\//.exec(key)?.[1]);
      await gates.get(version);
      objects.set(key, body);
    },
  };
  const flows = createGitHubFlows({ store, github, loadSettings: async () => SETTINGS, now: () => NOW });
  secrets = new Map();
  const secretsPort: SecretsPort = { put: async (n, v) => void secrets.set(n, v), remove: async (n) => void secrets.delete(n) };
  app = createApp({
    resolveCaller: (c) => {
      const sub = c.req.header('x-test-sub');
      return sub ? { sub } : null;
    },
    github: flows,
    config: createConfigService({ store, github: flows, objects: port, now: () => NOW }),
    // The key routes as deployed (membership through the config context); every key the provider accepts.
    agentKeys: createAgentKeyService({ store, github: flows, secrets: secretsPort, check: async () => 'valid', now: () => NOW }),
    logError: () => {},
  });
});

describe('loading the editor', () => {
  it('starts from the packaged defaults, with the linked login, the reachable repositories and which keys are set', async () => {
    const { status, body } = await call(PAT, 'GET', '/installations/55/config');
    expect(status).toBe(200);
    expect(body).toMatchObject({ githubLogin: 'pat', activeVersion: null, source: 'none', agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true } });
    expect(body.repositories?.map((r) => r.fullName)).toEqual(['acme/api', 'acme/web']);
    const defaults = body.defaults as { prompts: { implement: string } };
    expect(body).toMatchObject({
      config: {
        version: 2,
        // Every agent the deployment offers (this one runs all three); those with a key in both pools.
        agents: { claude: { adapter: 'claude', enabled: true }, codex: { adapter: 'codex', enabled: true }, kiro: { adapter: 'kiro', enabled: false } },
        pools: { builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['claude', 'codex'] } },
        allowedActors: ['pat'],
        workflows: { implement: { label: 'updraft', pool: 'builders', prompt: defaults.prompts.implement, review: { enabled: true, pool: 'reviewers', allowSameAgent: false }, revise: { enabled: true } } },
        repositories: {},
      },
    });
  });

  it('says when the active version cannot be opened in the editor, instead of quietly showing defaults', async () => {
    const n = (await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml', SOURCE_FILE], publishedBy: 'pat', publishedAt: '2026-11-19T00:00:00.000Z' })) as number;
    objects.set(`${configPrefix(55, n)}${SOURCE_FILE}`, JSON.stringify({ format: 'console', config: { version: 2, agents: {}, pools: {}, workflows: {}, repositories: {} } }));
    await store.markConfigReady(55, n);
    await store.activateConfig(55, n);
    const { body } = await call(PAT, 'GET', '/installations/55/config');
    expect(body).toMatchObject({ source: 'console', activeVersion: 1 });
    expect(body.notices).toEqual([expect.stringMatching(/^Version 1 could not be opened in this editor \(agents: add at least one agent.*The editor starts from the defaults/)]);
  });

  it('loads a version published with the first console settings, upgraded to pools', async () => {
    const v1 = {
      version: 1,
      workflows: {
        implement: {
          agent: { adapter: 'claude', model: 'opus' },
          prompt: '# Build',
          reviewer: { adapter: 'codex', prompt: '# Review' },
          revisePrompt: '# Revise',
          verify: ['npm test'],
        },
      },
      repositories: {
        'acme/web': { enabled: true, triggers: [{ label: 'go', workflow: 'implement' }], allowedActors: ['pat'], publish: 'pr', commentOnFailure: true, review: true, revise: false },
      },
    };
    // Stored as the first console stored its settings.
    const n = (await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml', SOURCE_FILE], publishedBy: 'pat', publishedAt: '2026-11-19T00:00:00.000Z' })) as number;
    objects.set(`${configPrefix(55, n)}${SOURCE_FILE}`, JSON.stringify({ format: 'console', config: v1 }));
    await store.markConfigReady(55, n);
    await store.activateConfig(55, n);
    const { body } = await call(PAT, 'GET', '/installations/55/config');
    expect(body).toMatchObject({
      source: 'console',
      config: {
        version: 2,
        agents: { claude: { adapter: 'claude', model: 'opus' }, codex: { adapter: 'codex' } },
        pools: { builders: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
        allowedActors: ['pat'],
        workflows: { implement: { label: 'go', pool: 'builders', prompt: '# Build', review: { enabled: true, pool: 'reviewers', prompt: '# Review' }, revise: { enabled: false } } },
        repositories: { 'acme/web': { workflows: ['implement'], publish: 'pr', verify: ['npm test'] } },
      },
    });
  });

  it('loads what was published last', async () => {
    await publish(settings({ 'acme/web': repo({ allowedActors: ['pat', 'sam'] }) }), { baseVersion: null });
    const { body } = await call(PAT, 'GET', '/installations/55/config');
    expect(body).toMatchObject({ activeVersion: 1, source: 'console' });
    expect(body).toMatchObject({ config: { repositories: { 'acme/web': { allowedActors: ['pat', 'sam'] } } } });
  });
});

describe('isolation', () => {
  it('a non-member reads and changes nothing, with the same answer as for no tenant at all', async () => {
    for (const [method, path, body] of [
      ['GET', '/installations/55/config', undefined],
      ['POST', '/installations/55/config/preview', { config: settings() }],
      ['POST', '/installations/55/config/publish', { config: settings() }],
      ['GET', '/installations/55/config/versions', undefined],
      ['GET', '/installations/55/config/versions/1', undefined],
      ['POST', '/installations/55/config/versions/1/reactivate', {}],
      ['GET', '/installations/999/config', undefined],
    ] as const) {
      const res = await call(EVE, method, path, body);
      expect(res, `${method} ${path}`).toMatchObject({ status: 403, body: { error: 'not_authorized' } });
    }
    expect([...objects.keys()].some((k) => k.startsWith('tenants/55/'))).toBe(false);
  });

  it('changing the installation id in the request gives 403, not the other tenant', async () => {
    expect((await publish(settings(), {}, PAT, 66)).status).toBe(403);
    expect((await call(PAT, 'GET', '/installations/66/config')).status).toBe(403);
  });

  it('a repository another installation reaches is refused', async () => {
    const res = await publish(settings({ 'globex/app': repo() }));
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([expect.objectContaining({ path: 'repositories.globex/app', message: expect.stringMatching(/cannot access/) })]);
  });

  it('needs a session', async () => {
    expect((await call(null, 'GET', '/installations/55/config')).status).toBe(401);
  });
});

describe('preview', () => {
  it('returns the generated YAML, with the platform-enforced settings, and stores nothing', async () => {
    const { status, body } = await call(PAT, 'POST', '/installations/55/config/preview', { config: settings() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(parse(body.yaml ?? '')).toMatchObject({
      version: 1,
      execution: { mode: 'live' },
      github: { app: { appId: 4242, tokenFile: './app-token.json' } },
      repositories: { 'acme/web': { id: 99, publish: 'draft-pr' } },
    });
    expect(objects.size).toBe(0);
    expect(await store.listConfigVersions(55)).toEqual([]);
  });

  it('reports every problem, on the field the person edited', async () => {
    const { body } = await call(PAT, 'POST', '/installations/55/config/preview', {
      config: settings({ 'acme/web': repo({ allowedActors: [], execution: { mode: 'log-only' } }) }),
    });
    expect(body.ok).toBe(false);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'repositories.acme/web.allowedActors' }),
        expect.objectContaining({ path: 'repositories.acme/web.execution' }),
      ]),
    );
  });

  it('refuses an agent whose key is not set', async () => {
    // A tenant with only the Codex key: a Claude workflow cannot run.
    const t = tenant(77, 'initech');
    await store.link('sub-ivy', { githubUserId: 3, githubLogin: 'ivy', linkedAt: t.createdAt });
    await store.putTenantWithMember(t, { installationId: 77, sub: 'sub-ivy', role: 'owner', githubUserId: 3, githubLogin: 'ivy', addedAt: t.createdAt });
    await store.putAgentKeyMeta(77, { name: 'CODEX_API_KEY', updatedAt: t.createdAt, updatedBy: 'ivy' });
    const { body } = await call({ sub: 'sub-ivy' }, 'POST', '/installations/77/config/preview', { config: settings({ 'globex/app': repo() }) });
    // Claude is in both pools; Codex's key is set. Turning Claude off is the other way out.
    expect(body.errors).toEqual([expect.objectContaining({ path: 'agents.claude', message: expect.stringMatching(/ANTHROPIC_API_KEY, or turn this agent off/) })]);
    const off = settings({ 'globex/app': repo() }, { review: { ...settings().workflows.implement.review, allowSameAgent: true } });
    const claudeOff = { ...off, allowedActors: ['ivy'], agents: { ...off.agents, claude: { adapter: 'claude', enabled: false } } };
    expect((await call({ sub: 'sub-ivy' }, 'POST', '/installations/77/config/preview', { config: claudeOff })).body).toMatchObject({ ok: true });
  });

  it('says which repositories would turn auto-merge on', async () => {
    const { body } = await call(PAT, 'POST', '/installations/55/config/preview', {
      config: settings({ 'acme/web': repo({ autoMerge: { method: 'squash' } }) }),
    });
    expect(body).toMatchObject({ ok: true, autoMergeTurnedOn: ['acme/web'] });
  });
});

describe('publishing', () => {
  it('uploads the bundle to config/<n+1>/ and then activates it, recording who published it', async () => {
    const res = await publish(settings(), { baseVersion: null });
    expect(res).toMatchObject({ status: 200, body: { ok: true, version: 1 } });
    expect([...objects.keys()].sort()).toEqual([
      `${configPrefix(55, 1)}config.yaml`,
      `${configPrefix(55, 1)}prompts/implement.md`,
      `${configPrefix(55, 1)}prompts/implement.review.md`,
      `${configPrefix(55, 1)}prompts/implement.revise.md`,
      `${configPrefix(55, 1)}${SOURCE_FILE}`,
    ]);
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
    expect(await store.getConfigVersion(55, 1)).toMatchObject({ status: 'ready', publishedBy: 'pat', publishedAt: new Date(NOW).toISOString() });
  });

  it('an invalid config is refused and the active version is kept', async () => {
    await publish(settings(), { baseVersion: null });
    const res = await publish(settings({ 'acme/web': repo({ workflows: [] }) }), { baseVersion: 1 });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_config', errors: [expect.objectContaining({ path: 'repositories.acme/web.workflows' })] } });
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
    expect(await store.listConfigVersions(55)).toHaveLength(1);
  });

  it('tenant input for platform-enforced fields is refused, never overridden', async () => {
    const base = settings();
    const config = { ...base, agents: { ...base.agents, claude: { adapter: 'claude', enabled: true, env: { X: '1' } } } };
    const res = await publish(config, { baseVersion: null });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([expect.objectContaining({ path: 'agents.claude.env' })]);
    expect((await store.getTenant(55))?.activeConfigVersion).toBeUndefined();
  });

  it('a failed upload leaves the active version as it was', async () => {
    await publish(settings(), { baseVersion: null });
    failPuts = true;
    const res = await publish(settings({ 'acme/web': repo({ enabled: false }) }), { baseVersion: 1 });
    expect(res.status).toBe(500);
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
  });

  it('refuses a publish edited from a version that is no longer active', async () => {
    await publish(settings(), { baseVersion: null });
    const res = await publish(settings({ 'acme/api': repo() }), { baseVersion: null });
    expect(res).toMatchObject({ status: 409, body: { error: 'config_changed' } });
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
  });

  it('two editors who both saw the same active version: the second to finish is refused, even with the higher number', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    gates.set(1, new Promise<void>((r) => (releaseFirst = r)));
    gates.set(2, new Promise<void>((r) => (releaseSecond = r)));
    // Both pass the baseVersion check against "nothing active"; A allocates 1, B allocates 2.
    const a = publish(settings({ 'acme/web': repo() }), { baseVersion: null });
    await new Promise((r) => setTimeout(r, 10));
    const b = publish(settings({ 'acme/api': repo() }), { baseVersion: null });
    await new Promise((r) => setTimeout(r, 10));
    releaseFirst();
    expect(await a).toMatchObject({ status: 200, body: { version: 1 } });
    releaseSecond();
    // Before the fix, 2 > 1 was enough and B silently replaced A's edit.
    expect(await b).toMatchObject({ status: 409, body: { error: 'config_changed' } });
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
  });

  it('turning auto-merge on takes an explicit confirmation; keeping it on does not', async () => {
    const on = settings({ 'acme/web': repo({ autoMerge: { method: 'squash' } }) });
    expect(await publish(on, { baseVersion: null })).toMatchObject({ status: 409, body: { error: 'auto_merge_unconfirmed' } });
    expect((await store.getTenant(55))?.activeConfigVersion).toBeUndefined();
    expect(await publish(on, { baseVersion: null, confirmAutoMerge: true })).toMatchObject({ status: 200, body: { version: 1 } });
    expect(await publish(on, { baseVersion: 1 })).toMatchObject({ status: 200, body: { version: 2 } });
  });

  it('pause, triggers and allowed actors take effect on the next webhook, from the stored rules', async () => {
    await publish(settings(), { baseVersion: null });
    const event = { repositoryFullName: 'acme/web', repositoryId: 99, label: 'updraft', sender: 'pat' };
    const rules = async () => (await store.getConfigVersion(55, (await store.getTenant(55))!.activeConfigVersion!))?.dispatch;
    expect(decideDispatch(await rules(), event)).toMatchObject({ start: true });

    await publish(settings({ 'acme/web': repo({ enabled: false }) }), { baseVersion: 1 });
    expect(decideDispatch(await rules(), event)).toMatchObject({ start: false, reason: 'the repository is paused' });

    await publish(settings({ 'acme/web': repo({ allowedActors: ['sam'] }) }, { label: 'go' }), { baseVersion: 2 });
    expect(decideDispatch(await rules(), event)).toMatchObject({ start: false, reason: 'the label is not a trigger' });
    expect(decideDispatch(await rules(), { ...event, label: 'go' })).toMatchObject({ start: false, reason: 'the sender may not dispatch work' });
    expect(decideDispatch(await rules(), { ...event, label: 'go', sender: 'Sam' })).toMatchObject({ start: true });
  });

  it('a job keeps its pinned version: publishing never rewrites a bundle', async () => {
    await publish(settings(), { baseVersion: null });
    const pinned = { ...Object.fromEntries([...objects].filter(([k]) => k.startsWith(configPrefix(55, 1)))) };
    await publish(settings({ 'acme/web': repo({ enabled: false }), 'acme/api': repo() }), { baseVersion: 1 });
    // A job dispatched on version 1 reads config/1/, which is exactly as it was.
    expect(Object.fromEntries([...objects].filter(([k]) => k.startsWith(configPrefix(55, 1))))).toEqual(pinned);
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(2);
  });

  it('a disabled tenant cannot publish', async () => {
    await store.setSuspended(55, true);
    expect(await publish(settings(), { baseVersion: null })).toMatchObject({ status: 409, body: { error: 'tenant_disabled' } });
  });
});

describe('history', () => {
  it('lists every version newest first, and serves a version\'s files without its source', async () => {
    await publish(settings(), { baseVersion: null });
    await publish(settings({ 'acme/web': repo({ enabled: false }) }), { baseVersion: 1 });
    const list = await call(PAT, 'GET', '/installations/55/config/versions');
    expect(list.body).toMatchObject({ activeVersion: 2, versions: [{ version: 2, active: true, publishedBy: 'pat' }, { version: 1, active: false }] });
    const one = await call(PAT, 'GET', '/installations/55/config/versions/1');
    expect(Object.keys(one.body.files ?? {}).sort()).toEqual(['config.yaml', 'prompts/implement.md', 'prompts/implement.review.md', 'prompts/implement.revise.md']);
    expect((await call(PAT, 'GET', '/installations/55/config/versions/9')).status).toBe(404);
    // A version whose upload never finished: listed as pending, with no files read.
    await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml'], publishedBy: 'pat', publishedAt: '2026-11-20T00:00:00.000Z' });
    expect((await call(PAT, 'GET', '/installations/55/config/versions/3')).body).toMatchObject({ version: { status: 'pending' }, files: {} });
  });

  it('re-activating publishes a copy as a new version', async () => {
    await publish(settings(), { baseVersion: null });
    await publish(settings({ 'acme/web': repo({ enabled: false }) }), { baseVersion: 1 });
    const res = await call(PAT, 'POST', '/installations/55/config/versions/1/reactivate', {});
    expect(res).toMatchObject({ status: 200, body: { ok: true, version: 3 } });
    expect(await store.getConfigVersion(55, 3)).toMatchObject({ copiedFrom: 1, publishedBy: 'pat' });
    expect(objects.get(`${configPrefix(55, 3)}config.yaml`)).toBe(objects.get(`${configPrefix(55, 1)}config.yaml`));
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(3);
    // The active version is not re-activated onto itself.
    expect(await call(PAT, 'POST', '/installations/55/config/versions/3/reactivate', {})).toMatchObject({ status: 409, body: { error: 'not_reactivatable' } });
  });

  it('re-activating a version that turns auto-merge on asks for the confirmation again', async () => {
    await publish(settings({ 'acme/web': repo({ autoMerge: { method: 'squash' } }) }), { baseVersion: null, confirmAutoMerge: true });
    await publish(settings(), { baseVersion: 1 });
    expect(await call(PAT, 'POST', '/installations/55/config/versions/1/reactivate', {})).toMatchObject({ status: 409, body: { error: 'auto_merge_unconfirmed' } });
    expect(await call(PAT, 'POST', '/installations/55/config/versions/1/reactivate', { confirmAutoMerge: true })).toMatchObject({ status: 200, body: { version: 3 } });
  });

  it('re-activates a version tenant-admin published, from its own document and prompts', async () => {
    await publishTenantConfig(
      {
        installationId: 55,
        submission: {
          config: {
            dispatch: { allowedActors: ['pat'] },
            agents: { claude: {} },
            pools: { general: { agents: ['claude'] } },
            actions: { go: { prompt: './prompts/go.md' } },
            repositories: { 'acme/web': { workflows: [{ trigger: { event: 'issue.labeled', label: 'go' }, action: 'go', pool: 'general' }] } },
          },
          prompts: { 'go.md': '# Go' },
        },
        platform: { appId: 4242 },
        repositoryIds: new Map([['acme/web', 99]]),
        publishedBy: 'admin:ops',
      },
      { store, putObject: async (k, b) => void objects.set(k, b), now: () => NOW },
    );
    await publish(settings(), { baseVersion: 1 });
    expect((await call(PAT, 'GET', '/installations/55/config/versions/1')).body.files?.['prompts/go.md']).toBe('# Go');
    const res = await call(PAT, 'POST', '/installations/55/config/versions/1/reactivate', {});
    expect(res).toMatchObject({ status: 200, body: { version: 3 } });
    expect(objects.get(`${configPrefix(55, 3)}prompts/go.md`)).toBe('# Go');
  });

  it('re-activating a tenant-admin version checks the keys its agents need today', async () => {
    // A tenant with only the Codex key, and a tenant-admin version that runs Claude.
    const t = tenant(77, 'initech');
    await store.link('sub-ivy', { githubUserId: 3, githubLogin: 'ivy', linkedAt: t.createdAt });
    await store.putTenantWithMember(t, { installationId: 77, sub: 'sub-ivy', role: 'owner', githubUserId: 3, githubLogin: 'ivy', addedAt: t.createdAt });
    await store.putAgentKeyMeta(77, { name: 'CODEX_API_KEY', updatedAt: t.createdAt, updatedBy: 'ivy' });
    const adminVersion = await publishTenantConfig(
      {
        installationId: 77,
        submission: {
          config: {
            dispatch: { allowedActors: ['ivy'] },
            agents: { claude: {}, spare: { adapter: 'claude', enabled: false } },
            pools: { general: { agents: ['claude', 'spare'] } },
            actions: { go: { prompt: './prompts/go.md' } },
            repositories: { 'globex/app': { workflows: [{ trigger: { event: 'issue.labeled', label: 'go' }, action: 'go', pool: 'general' }] } },
          },
          prompts: { 'go.md': '# Go' },
        },
        platform: { appId: 4242 },
        repositoryIds: new Map([['globex/app', 300]]),
        publishedBy: 'admin:ops',
      },
      { store, putObject: async (k, b) => void objects.set(k, b), now: () => NOW },
    );
    expect(adminVersion).toMatchObject({ ok: true, version: 1 });
    const defaults = defaultConsoleConfig({ offered: ['codex'], login: 'ivy' });
    // Codex alone codes and reviews: the person opts in to self-review, which the defaults never do.
    const implement = defaults.workflows.implement!;
    const codexOnly = { ...defaults, workflows: { implement: { ...implement, review: { ...implement.review, allowSameAgent: true } } }, repositories: { 'globex/app': repo() } };
    expect(await call({ sub: 'sub-ivy' }, 'POST', '/installations/77/config/publish', { config: codexOnly, baseVersion: 1 })).toMatchObject({ status: 200, body: { version: 2 } });

    const res = await call({ sub: 'sub-ivy' }, 'POST', '/installations/77/config/versions/1/reactivate', {});
    // Only the enabled agent its pool can start: the disabled spare needs nothing.
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_config', errors: [{ path: 'agents.claude', message: expect.stringMatching(/ANTHROPIC_API_KEY/) }] } });
    expect((await store.getTenant(77))?.activeConfigVersion).toBe(2);
  });

  it('re-activates a version the first console published exactly as it ran, and the editor says what its upgrade folds together', async () => {
    const v1 = {
      version: 1,
      workflows: {
        implement: { agent: { adapter: 'claude' }, prompt: '# Build', reviewer: { adapter: 'codex', prompt: '# Review' }, revisePrompt: '# Revise', verify: [] },
        docs: { agent: { adapter: 'codex' }, prompt: '# Docs', reviewer: { adapter: 'claude', prompt: '# R' }, revisePrompt: '# V', verify: ['npm test'] },
      },
      repositories: {
        'acme/web': { enabled: true, triggers: [{ label: 'go', workflow: 'implement' }, { label: 'docs', workflow: 'docs' }], allowedActors: ['pat'], publish: 'draft-pr', commentOnFailure: true, review: true, revise: false },
      },
    };
    const n = (await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml', SOURCE_FILE], publishedBy: 'pat', publishedAt: '2026-11-19T00:00:00.000Z' })) as number;
    objects.set(`${configPrefix(55, n)}${SOURCE_FILE}`, JSON.stringify({ format: 'console', config: v1 }));
    await store.markConfigReady(55, n);
    await store.activateConfig(55, n);

    const loaded = await call(PAT, 'GET', '/installations/55/config');
    expect(loaded.body.notices).toEqual([expect.stringMatching(/acme\/web ran implement and docs with different checks/)]);

    await publish(settings(), { baseVersion: 1 });
    const res = await call(PAT, 'POST', '/installations/55/config/versions/1/reactivate', {});
    expect(res).toMatchObject({ status: 200, body: { version: 3 } });
    const yaml = parse(objects.get(`${configPrefix(55, 3)}config.yaml`) ?? '') as { actions: Record<string, { verify?: string[] }>; pools: Record<string, unknown>; repositories: Record<string, { workflows: { action: string; pool: string }[] }> };
    // Each workflow keeps its own checks, pools and action, as version 1 compiled them.
    expect(yaml.actions.implement?.verify).toBeUndefined();
    expect(yaml.actions.docs?.verify).toEqual(['npm test']);
    expect(Object.keys(yaml.pools).sort()).toEqual(['docs', 'docs.review', 'implement', 'implement.review']);
    expect(yaml.repositories['acme/web']?.workflows.map((w) => [w.action, w.pool])).toEqual([['implement', 'implement'], ['docs', 'docs']]);
  });

  it('a version published before versions kept their source cannot be re-activated', async () => {
    await publish(settings(), { baseVersion: null });
    // As versions were stored before this: a bundle with no source.json among its files.
    const old = await store.createConfigVersion(55, { sha256: 'abc', files: ['config.yaml'], publishedBy: 'admin:ops', publishedAt: '2026-11-19T00:00:00.000Z' });
    expect(old).toBe(2);
    await store.markConfigReady(55, 2);
    await store.activateConfig(55, 2);
    await publish(settings({ 'acme/api': repo() }), { baseVersion: 2 });
    expect(await call(PAT, 'POST', '/installations/55/config/versions/2/reactivate', {})).toMatchObject({ status: 409, body: { error: 'not_reactivatable' } });
  });
});

/*
 * #193: what the role-oriented configuration page relies on, asserted on what the server compiles
 * and stores. The settings are those of fixtures/console-samples.json, which the page's own tests
 * (app/src/pages/config.test.tsx) load, preview and publish through the page.
 */
const SAMPLES = fixture.samples as unknown as Record<string, ConsoleConfig>;
const TWO_PROVIDERS = fixture.twoProviders as unknown as { start: ConsoleConfig; published: ConsoleConfig };
const SAM: Caller = { sub: 'sub-sam' };
const KEYS = { ANTHROPIC: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', KIRO: 'ksk_abcdefghijklmnopqrstuvwxyz0123456789' };

/** A version's files as jobs read them (config.yaml, prompts/), by name. */
const bundle = (version: number) =>
  Object.fromEntries(
    [...objects]
      .filter(([k]) => k.startsWith(configPrefix(55, version)) && !k.endsWith(SOURCE_FILE))
      .map(([k, v]) => [k.slice(configPrefix(55, version).length), v]),
  );
const loadConfig = async (caller: Caller = PAT) => (await call(caller, 'GET', '/installations/55/config')).body as unknown as { config: ConsoleConfig; agentKeys: Record<string, boolean>; source: string; activeVersion: number | null; notices: string[]; tenant: { role: string } };
const preview = async (config: unknown, caller: Caller = PAT) => (await call(caller, 'POST', '/installations/55/config/preview', { config })).body;
const putKey = (name: string, value: string, caller: Caller = PAT) => call(caller, 'PUT', `/installations/55/agent-keys/${name}`, { value });
const keyList = async () => (await call(PAT, 'GET', '/installations/55/agent-keys')).body.keys as { name: string; configured: boolean; lastUsed?: { ok: boolean } }[];
const rulesOf = async (version: number) => (await store.getConfigVersion(55, version))!.dispatch;
/** The agent keys a job started by this label in this repository is handed (jobs/launch.ts takes them from the decision). */
const jobKeys = async (version: number, repository: string, id: number, label: string) => {
  const d = decideDispatch(await rulesOf(version), { repositoryFullName: repository, repositoryId: id, label, sender: 'pat' });
  return d.start ? d.keys : d.reason;
};
interface CompiledYaml {
  agents: Record<string, { adapter?: string; model?: string; effort?: string }>;
  pools: Record<string, { agents: string[] }>;
  repositories: Record<string, { review?: unknown; workflows: { id?: string; trigger: { label: string }; action: string; pool: string; reviewPool?: string; tiers?: unknown }[] }>;
}
const yamlOf = (text: string | undefined) => parse(text ?? '') as CompiledYaml;

describe('no-op round trip of published settings (#193)', () => {
  // Workflow ids, profile and pool names jobs and pull requests in flight are resolved by.
  const ids: Record<string, Record<string, string[]>> = {
    simple: { 'acme/web': ['implement'] },
    labels: { 'acme/web': ['implement', 'art', 'docs'], 'acme/api': ['implement-api', 'art'] },
    // An upgraded workflow keeps the id its first-console version had (`<v1 workflow>:<label>`; acme/api's copy of the action has its own checks).
    advanced: { 'acme/web': ['implement:ready', 'docs', 'chore'], 'acme/api': ['implement.2:ready'] },
  };

  it.each(Object.keys(SAMPLES))('%s: loaded, previewed and published again with no edit compiles byte for byte the same, ids and names included', async (name) => {
    const sample = SAMPLES[name]!;
    const first = await preview(sample);
    expect(first).toMatchObject({ ok: true });
    expect(await publish(sample, { baseVersion: null, confirmAutoMerge: true })).toMatchObject({ status: 200, body: { ok: true, version: 1 } });

    const loaded = await loadConfig();
    expect(loaded).toMatchObject({ source: 'console', activeVersion: 1, notices: [] });
    // The settings come back exactly as saved: the same names, values and order.
    expect(JSON.stringify(loaded.config)).toBe(JSON.stringify(sample));
    expect((await preview(loaded.config)).yaml).toBe(first.yaml);
    expect(await publish(loaded.config, { baseVersion: 1 })).toMatchObject({ status: 200, body: { ok: true, version: 2 } });

    // Every file of the bundle jobs read is the same text, and so are the stored dispatch rules.
    expect(bundle(1)['config.yaml']).toBe(first.yaml);
    expect(bundle(2)).toEqual(bundle(1));
    expect(Object.keys(bundle(2)).length).toBeGreaterThan(1);
    expect((await store.getConfigVersion(55, 2))!.sha256).toBe((await store.getConfigVersion(55, 1))!.sha256);
    expect(await rulesOf(2)).toEqual(await rulesOf(1));

    const yaml = yamlOf(bundle(2)['config.yaml']);
    expect(Object.keys(yaml.agents)).toEqual(Object.keys(sample.agents));
    // Settings upgraded from the first console also keep their legacy pool names, for work in flight.
    expect(Object.keys(yaml.pools)).toEqual([...Object.keys(sample.pools), ...Object.keys(sample.legacy?.pools ?? {})]);
    for (const [repo, list] of Object.entries(ids[name]!)) expect(yaml.repositories[repo]!.workflows.map((w) => w.id ?? `${w.action}:${w.trigger.label}`)).toEqual(list);
  });

  it('keeps explicit models and efforts, the review requirement, auto-merge, actor restrictions and prompts as they were set', async () => {
    const sample = SAMPLES.labels!;
    await publish(sample, { baseVersion: null, confirmAutoMerge: true });
    await publish((await loadConfig()).config, { baseVersion: 1 });
    const yaml = yamlOf(bundle(2)['config.yaml']);
    expect(yaml.agents.claude).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(yaml.agents.codex).toMatchObject({ effort: 'medium' });
    expect(yaml.agents.codex!.model).toBeUndefined();
    expect(yaml.repositories['acme/web']).toMatchObject({ review: { acceptance: 'enforce' }, maxRevisions: 2, autoMerge: 'squash', autoMergeRequiredChecks: ['test'], ciFix: true });
    expect(yaml.repositories['acme/web']!.workflows.every((w) => JSON.stringify((w as { allowedActors?: string[] }).allowedActors) === '["sam"]')).toBe(true);
    expect(bundle(2)['prompts/implement.md']).toBe('# Implement the issue, our way');
    expect(bundle(2)['prompts/implement.review.md']).toBe('# Review against our style guide');
    expect(bundle(2)['prompts/art.md']).toBe('# Draw the assets the issue asks for');
  });

  it('a tenant-admin version with tiers is not converted by the editor, and re-activating it compiles its tiers unchanged', async () => {
    const tiers = { pools: { routine: 'general', standard: 'general', complex: 'deep' }, minConfidence: 0.7, escalation: { maxHops: 2 } };
    await publishTenantConfig(
      {
        installationId: 55,
        submission: {
          config: {
            dispatch: { allowedActors: ['pat'] },
            agents: { claude: {}, 'claude-deep': { adapter: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
            pools: { general: { agents: ['claude'] }, deep: { agents: ['claude-deep'] } },
            actions: { go: { prompt: './prompts/go.md' } },
            repositories: { 'acme/web': { workflows: [{ id: 'go', trigger: { event: 'issue.labeled', label: 'go' }, action: 'go', pool: 'general', tiers }] } },
          },
          prompts: { 'go.md': '# Go' },
        },
        platform: { appId: 4242 },
        repositoryIds: new Map([['acme/web', 99]]),
        publishedBy: 'admin:ops',
      },
      { store, putObject: async (k, b) => void objects.set(k, b), now: () => NOW },
    );
    expect(yamlOf(bundle(1)['config.yaml']).repositories['acme/web']!.workflows[0]).toMatchObject({ id: 'go', pool: 'general', tiers });
    // The editor cannot show tiers: it says so and starts from the defaults, and never rewrites the version.
    const loaded = await loadConfig();
    expect(loaded).toMatchObject({ source: 'tenant', activeVersion: 1 });
    expect(JSON.stringify(loaded.config)).not.toContain('tiers');

    await publish(settings(), { baseVersion: 1 });
    expect((await call(PAT, 'POST', '/installations/55/config/versions/1/reactivate', {})).body).toMatchObject({ ok: true, version: 3 });
    expect(bundle(3)).toEqual(bundle(1));
    expect(yamlOf(bundle(3)['config.yaml']).repositories['acme/web']!.workflows[0]!.tiers).toEqual(tiers);
  });
});

describe('manual models and efforts (#193)', () => {
  const withClaude = (agent: Record<string, unknown>) => {
    const s = settings();
    return { ...s, agents: { ...s.agents, claude: { adapter: 'claude', enabled: true, ...agent } } };
  };

  it('a model or effort that is not a valid value is refused at its field, in a preview and a publish, and nothing is published', async () => {
    expect(await preview(withClaude({ model: 'claude opus' }))).toEqual({
      ok: false,
      errors: [{ path: 'agents.claude.model', message: 'a model name: letters, digits, ".", "_", ":", "/" or "-"' }],
      warnings: [],
    });
    expect((await preview(withClaude({ effort: 'very high' }))).errors).toEqual([{ path: 'agents.claude.effort', message: 'an effort level, such as low, medium or high' }]);
    expect(await publish(withClaude({ model: 'claude opus', effort: 'very high' }), { baseVersion: null })).toMatchObject({
      status: 400,
      body: { errors: [{ path: 'agents.claude.model' }, { path: 'agents.claude.effort' }] },
    });
    expect((await store.getTenant(55))?.activeConfigVersion).toBeUndefined();
    expect(objects.size).toBe(0);
  });

  it('valid manual values are compiled as given; Automatic (none) leaves the provider default', async () => {
    expect(await publish(withClaude({ model: 'claude-sonnet-5-5', effort: 'high' }), { baseVersion: null })).toMatchObject({ status: 200, body: { version: 1 } });
    const yaml = yamlOf(bundle(1)['config.yaml']);
    expect(yaml.agents.claude).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(yaml.agents.codex!.model).toBeUndefined();
    expect(yaml.agents.codex!.effort).toBeUndefined();
  });
});

describe('connections and the team (#193)', () => {
  it('two providers code and a distinct review team reviews: the compiled config routes exactly that', async () => {
    await store.putAgentKeyMeta(55, { name: 'KIRO_API_KEY', updatedAt: '2026-11-20T00:00:00.000Z', updatedBy: 'pat' });
    // What the page starts from is the server's own default for an installation with only Kiro connected.
    const d = defaultConsoleConfig({ offered: ['claude', 'codex', 'kiro'], login: 'pat', keys: new Set(['KIRO_API_KEY']) });
    const prompts = TWO_PROVIDERS.start.workflows.implement!;
    expect(TWO_PROVIDERS.start).toEqual({
      ...d,
      workflows: { implement: { ...d.workflows.implement!, prompt: prompts.prompt, review: { ...d.workflows.implement!.review, prompt: prompts.review.prompt }, revise: { ...d.workflows.implement!.revise, prompt: prompts.revise.prompt } } },
    });

    // What the page publishes once Claude Code and Codex are connected and chosen (config.test.tsx).
    expect(await publish(TWO_PROVIDERS.published, { baseVersion: null })).toMatchObject({ status: 200, body: { ok: true, version: 1 } });
    const yaml = yamlOf(bundle(1)['config.yaml']);
    expect(Object.keys(yaml.agents)).toEqual(['claude', 'codex', 'kiro']);
    expect(yaml.pools).toEqual({ builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['kiro'] } });
    expect(yaml.repositories['acme/web']!.workflows).toEqual([expect.objectContaining({ id: 'implement', trigger: { event: 'issue.labeled', label: 'updraft' }, pool: 'builders', reviewPool: 'reviewers' })]);
    expect(await jobKeys(1, 'acme/web', 99, 'updraft')).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'KIRO_API_KEY']);
  });

  it('saving a key on its own changes neither the compiled config nor the keys a job receives', async () => {
    const sample = SAMPLES.simple!;
    await publish(sample, { baseVersion: null });
    const before = await loadConfig();
    expect(before.agentKeys.KIRO_API_KEY).toBe(false);
    expect(await jobKeys(1, 'acme/web', 99, 'updraft')).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);

    expect(await putKey('KIRO_API_KEY', KEYS.KIRO)).toMatchObject({ status: 200 });
    const after = await loadConfig();
    expect(after.agentKeys.KIRO_API_KEY).toBe(true);
    // The draft is the published settings, unchanged: Kiro is not put in any team.
    expect(JSON.stringify(after.config)).toBe(JSON.stringify(before.config));
    expect((await preview(after.config)).yaml).toBe(bundle(1)['config.yaml']);
    // The active version still hands jobs the same keys, and so does the same settings published again.
    expect(await jobKeys(1, 'acme/web', 99, 'updraft')).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
    await publish(after.config, { baseVersion: 1 });
    expect(bundle(2)).toEqual(bundle(1));
    expect(await jobKeys(2, 'acme/web', 99, 'updraft')).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
  });

  it('a key whose last use failed stays stale until it is saved again; reconnecting clears it and changes no setting', async () => {
    await publish(SAMPLES.simple!, { baseVersion: null });
    await store.recordAgentKeyUse(55, 'ANTHROPIC_API_KEY', { at: '2026-11-20T01:00:00.000Z', ok: false, jobStartedAt: '2026-11-20T00:30:00.000Z' });
    expect((await keyList()).find((k) => k.name === 'ANTHROPIC_API_KEY')).toMatchObject({ configured: true, lastUsed: { ok: false } });
    const before = await loadConfig();

    expect(await putKey('ANTHROPIC_API_KEY', KEYS.ANTHROPIC)).toMatchObject({ status: 200 });
    const reconnected = (await keyList()).find((k) => k.name === 'ANTHROPIC_API_KEY')!;
    expect(reconnected.configured).toBe(true);
    // The failure belonged to the old key: the new one has not been used yet, so nothing is failing.
    expect(reconnected.lastUsed).toBeUndefined();
    expect(JSON.stringify((await loadConfig()).config)).toBe(JSON.stringify(before.config));
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
  });
});

describe('owner and member permissions (#193)', () => {
  beforeEach(async () => {
    // Sam is an editor (a member who is not an owner) of acme's installation.
    await store.link(SAM.sub, { githubUserId: 4, githubLogin: 'sam', linkedAt: '2026-11-20T00:00:00.000Z' });
    await store.putTenantWithMember(tenant(55, 'acme'), { installationId: 55, sub: SAM.sub, role: 'editor', githubUserId: 4, githubLogin: 'sam', addedAt: '2026-11-20T00:00:00.000Z' });
  });

  it('the configuration and its keys are a member\'s, not only an owner\'s: both load, preview, publish and save keys', async () => {
    expect((await loadConfig(PAT)).tenant.role).toBe('owner');
    expect((await loadConfig(SAM)).tenant.role).toBe('editor');
    expect(await preview(settings(), SAM)).toMatchObject({ ok: true });

    expect(await publish(settings(), { baseVersion: null }, PAT)).toMatchObject({ status: 200, body: { version: 1 } });
    expect(await publish(settings({ 'acme/web': repo(), 'acme/api': repo() }), { baseVersion: 1 }, SAM)).toMatchObject({ status: 200, body: { version: 2 } });
    expect(await store.getConfigVersion(55, 2)).toMatchObject({ publishedBy: 'sam' });
    expect((await call(SAM, 'POST', '/installations/55/config/versions/1/reactivate', {})).body).toMatchObject({ ok: true, version: 3 });

    expect(await putKey('ANTHROPIC_API_KEY', KEYS.ANTHROPIC, PAT)).toMatchObject({ status: 200 });
    expect(await putKey('KIRO_API_KEY', KEYS.KIRO, SAM)).toMatchObject({ status: 200 });
    expect((await store.listAgentKeyMeta(55)).find((k) => k.name === 'KIRO_API_KEY')).toMatchObject({ updatedBy: 'sam' });
  });

  it('a non-member can neither publish nor save a key, and an installation that is not active takes a publish from no one', async () => {
    expect(await putKey('KIRO_API_KEY', KEYS.KIRO, EVE)).toMatchObject({ status: 403, body: { error: 'not_authorized' } });
    expect(await publish(settings(), { baseVersion: null }, EVE)).toMatchObject({ status: 403, body: { error: 'not_authorized' } });
    expect(secrets.size).toBe(0);

    await store.setSuspended(55, true);
    for (const who of [PAT, SAM]) expect(await publish(settings(), { baseVersion: null }, who)).toMatchObject({ status: 409, body: { error: 'tenant_disabled' } });
    expect(await store.listConfigVersions(55)).toEqual([]);
  });
});
