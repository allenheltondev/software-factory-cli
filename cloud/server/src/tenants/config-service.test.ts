import { generateKeyPairSync } from 'node:crypto';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { createGitHubFlows } from '../flows/github.js';
import type { GitHubApi } from '../github/client.js';
import type { AppSettings } from '../github/settings.js';
import { createMemoryStore, type Store, type Tenant } from '../store/store.js';
import { createConfigService, type ObjectStore } from './config-service.js';
import { defaultConsoleConfig } from './console.js';
import { decideDispatch } from './dispatch.js';
import { configPrefix, SOURCE_FILE } from './paths.js';
import { publishTenantConfig } from './publish.js';

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

const repo = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  triggers: [{ label: 'updraft', workflow: 'implement' }],
  allowedActors: ['pat'],
  publish: 'draft-pr',
  commentOnFailure: true,
  review: false,
  revise: false,
  ...over,
});
const settings = (repos: Record<string, unknown> = { 'acme/web': repo() }) => ({ ...defaultConsoleConfig(), repositories: repos });

let store: Store;
let objects: Map<string, string>;
let failPuts: boolean;
/** Holds uploads into config/<version>/ until released: two publishes interleaved, as in the #83 review. */
let gates: Map<number, Promise<void>>;
let app: ReturnType<typeof createApp>;

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
  app = createApp({
    resolveCaller: (c) => {
      const sub = c.req.header('x-test-sub');
      return sub ? { sub } : null;
    },
    github: flows,
    config: createConfigService({ store, github: flows, objects: port, now: () => NOW }),
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
    expect(body).toMatchObject({ config: { workflows: { implement: { prompt: defaults.prompts.implement } } } });
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
    expect(body.errors).toEqual([expect.objectContaining({ path: 'workflows.implement.agent.adapter', message: expect.stringMatching(/ANTHROPIC_API_KEY/) })]);
  });

  it('says which repositories would turn auto-merge on', async () => {
    const { body } = await call(PAT, 'POST', '/installations/55/config/preview', {
      config: settings({ 'acme/web': repo({ review: true, autoMerge: { method: 'squash' } }) }),
    });
    expect(body).toMatchObject({ ok: true, autoMergeTurnedOn: ['acme/web'] });
  });
});

describe('publishing', () => {
  it('uploads the bundle to config/<n+1>/ and then activates it, recording who published it', async () => {
    const res = await publish(settings(), { baseVersion: null });
    expect(res).toMatchObject({ status: 200, body: { ok: true, version: 1 } });
    expect([...objects.keys()].sort()).toEqual([`${configPrefix(55, 1)}config.yaml`, `${configPrefix(55, 1)}prompts/implement.md`, `${configPrefix(55, 1)}${SOURCE_FILE}`]);
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
    expect(await store.getConfigVersion(55, 1)).toMatchObject({ status: 'ready', publishedBy: 'pat', publishedAt: new Date(NOW).toISOString() });
  });

  it('an invalid config is refused and the active version is kept', async () => {
    await publish(settings(), { baseVersion: null });
    const res = await publish(settings({ 'acme/web': repo({ triggers: [] }) }), { baseVersion: 1 });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_config', errors: [expect.objectContaining({ path: 'repositories.acme/web.triggers' })] } });
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(1);
    expect(await store.listConfigVersions(55)).toHaveLength(1);
  });

  it('tenant input for platform-enforced fields is refused, never overridden', async () => {
    const config = { ...settings(), workflows: { implement: { ...defaultConsoleConfig().workflows.implement, agent: { adapter: 'claude', env: { X: '1' } } } } };
    const res = await publish(config, { baseVersion: null });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([expect.objectContaining({ path: 'workflows.implement.agent.env' })]);
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
    const on = settings({ 'acme/web': repo({ review: true, autoMerge: { method: 'squash' } }) });
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
    expect(decideDispatch(await rules(), event)).toEqual({ start: false, reason: 'the repository is paused' });

    await publish(settings({ 'acme/web': repo({ triggers: [{ label: 'go', workflow: 'implement' }], allowedActors: ['sam'] }) }), { baseVersion: 2 });
    expect(decideDispatch(await rules(), event)).toEqual({ start: false, reason: 'the label is not a trigger' });
    expect(decideDispatch(await rules(), { ...event, label: 'go' })).toEqual({ start: false, reason: 'the sender may not dispatch work' });
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
    expect(Object.keys(one.body.files ?? {}).sort()).toEqual(['config.yaml', 'prompts/implement.md']);
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
    await publish(settings({ 'acme/web': repo({ review: true, autoMerge: { method: 'squash' } }) }), { baseVersion: null, confirmAutoMerge: true });
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
    const defaults = defaultConsoleConfig();
    const codexOnly = {
      ...defaults,
      workflows: { implement: { ...defaults.workflows.implement!, agent: { adapter: 'codex' } } },
      repositories: { 'globex/app': repo({ allowedActors: ['ivy'] }) },
    };
    expect(await call({ sub: 'sub-ivy' }, 'POST', '/installations/77/config/publish', { config: codexOnly, baseVersion: 1 })).toMatchObject({ status: 200, body: { version: 2 } });

    const res = await call({ sub: 'sub-ivy' }, 'POST', '/installations/77/config/versions/1/reactivate', {});
    // Only the enabled agent its pool can start: the disabled spare needs nothing.
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_config', errors: [{ path: 'agents.claude', message: expect.stringMatching(/ANTHROPIC_API_KEY/) }] } });
    expect((await store.getTenant(77))?.activeConfigVersion).toBe(2);
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
