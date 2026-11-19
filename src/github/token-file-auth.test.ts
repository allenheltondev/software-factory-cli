import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../config/validate.js';
import { APP_KEY_PATH_ENV, APP_TOKEN_FILE_ENV, GitHubAppError } from './app-auth.js';
import { appTokenFilePath, createWorkerCredentials } from './credentials.js';
import { createTokenFileAuth, loadTokenFile } from './token-file-auth.js';

const root = mkdtempSync(join(tmpdir(), 'updraft-token-file-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-19T12:00:00.000Z');
const HOUR = 3_600_000;

let n = 0;
function tokenFile(body: unknown): string {
  const dir = join(root, `t${++n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'app-token.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
  return path;
}

const good = (over: Record<string, unknown> = {}) => ({
  app: { id: 4242, slug: 'updraft', name: 'Updraft' },
  installationId: 55,
  token: 'ghs_aaaaaaaaaaaaaaaaaaaa',
  expiresAt: new Date(T0 + HOUR).toISOString(),
  permissions: { contents: 'write', issues: 'write' },
  repositories: ['Acme/Web'],
  ...over,
});

const problem = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    return err instanceof GitHubAppError ? `${err.problem}: ${err.message}` : String(err);
  }
  return 'no error';
};

describe('loadTokenFile', () => {
  it('reads a token file, lower-casing the repositories', () => {
    const file = loadTokenFile(tokenFile(good()));
    expect(file).toMatchObject({ app: { id: 4242, slug: 'updraft' }, installationId: 55, expiresAt: T0 + HOUR, repositories: ['acme/web'] });
  });

  it.each([
    ['a missing file', null, /does not exist/],
    ['not JSON', 'nope', /is not JSON/],
    ['no app id', good({ app: { slug: 'updraft' } }), /has no app\.id/],
    ['no token', good({ token: ' ' }), /has no token/],
    ['no expiry', good({ expiresAt: 'soon' }), /has no expiresAt/],
    ['bad repositories', good({ repositories: ['not a repo'] }), /repositories that are not/],
    ['a bad bot', good({ bot: { login: 'x' } }), /bot that is not/],
    ['a token with a line break', good({ token: 'ghs_aaaaaaaa\nX-Injected: ghs_bbbbbbbb' }), /token that is not a GitHub token/],
    ['a token with a space', good({ token: 'ghs_aaaa bbbb' }), /token that is not a GitHub token/],
    ['a bad client id', good({ app: { id: 1, slug: 'u', clientId: 'not a client id' } }), /app\.clientId that is not/],
  ])('refuses %s, without repeating the token', async (_what, body, pattern) => {
    const path = body === null ? join(root, 'missing.json') : tokenFile(body);
    const p = await problem(() => loadTokenFile(path));
    expect(p).toMatch(/^token-file: /);
    expect(p).toMatch(pattern);
    expect(p).not.toContain('ghs_');
  });
});

describe('createTokenFileAuth', () => {
  function setup(body: Record<string, unknown> = good(), over: { appId?: number | string; now?: () => number } = {}) {
    const path = tokenFile(body);
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const auth = createTokenFileAuth({ path, appId: over.appId ?? 4242, now: over.now ?? (() => T0), log: log as never });
    return { path, auth, log, write: (b: unknown) => writeFileSync(path, JSON.stringify(b)) };
  }

  it('hands out the token for a covered repository, any case', async () => {
    const { auth } = setup();
    await expect(auth.installationToken('acme/WEB')).resolves.toMatchObject({ token: 'ghs_aaaaaaaaaaaaaaaaaaaa', installationId: 55, repositorySelection: 'selected' });
    await expect(auth.app()).resolves.toEqual({ id: 4242, slug: 'updraft', name: 'Updraft', permissions: { contents: 'write', issues: 'write' } });
    await expect(auth.installation('acme/web')).resolves.toMatchObject({ id: 55, suspendedAt: null });
    expect(auth.tokenFile).toBeDefined();
    expect(auth.privateKeyPath).toBeUndefined();
  });

  it('reads the file again, so a replaced token is used at once', async () => {
    const { auth, write } = setup();
    await auth.installationToken('acme/web');
    write(good({ token: 'ghs_bbbbbbbbbbbbbbbbbbbb' }));
    await expect(auth.installationToken('acme/web')).resolves.toMatchObject({ token: 'ghs_bbbbbbbbbbbbbbbbbbbb' });
  });

  it('refuses a repository the token does not cover', async () => {
    const { auth } = setup();
    expect(await problem(auth.installationToken('acme/other'))).toMatch(/^not-installed: .*does not cover acme\/other/);
  });

  it('covers any repository when the file names none', async () => {
    const { auth } = setup(good({ repositories: undefined }));
    await expect(auth.installationToken('anyone/anything')).resolves.toMatchObject({ repositorySelection: null });
  });

  it('refuses an expired token and warns once about one about to expire', async () => {
    let now = T0 + HOUR - 5 * 60_000; // five minutes left
    const { auth, log } = setup(good(), { now: () => now });
    await auth.installationToken('acme/web');
    await auth.installationToken('acme/web');
    expect(log.warn).toHaveBeenCalledOnce();
    now = T0 + HOUR + 1;
    expect(await problem(auth.installationToken('acme/web'))).toMatch(/^token-file: .*expired.*was not replaced/);
  });

  it('does not hand out a rejected token again until the file holds another', async () => {
    const { auth, write } = setup();
    const { token } = await auth.installationToken('acme/web');
    auth.reject(token);
    expect(await problem(auth.installationToken('acme/web'))).toMatch(/^token-rejected: /);
    write(good({ token: 'ghs_cccccccccccccccccccc' }));
    await expect(auth.installationToken('acme/web')).resolves.toMatchObject({ token: 'ghs_cccccccccccccccccccc' });
  });

  it('refuses a file for another App, whether the config names the App by number or quoted number', async () => {
    expect(await problem(setup(good(), { appId: 1 }).auth.installationToken('acme/web'))).toMatch(/^token-file: .*for App 4242, but github\.app\.appId is 1/);
    expect(await problem(setup(good(), { appId: '1' }).auth.installationToken('acme/web'))).toMatch(/^token-file: .*for App 4242, but github\.app\.appId is 1/);
    await expect(setup(good(), { appId: '4242' }).auth.installationToken('acme/web')).resolves.toBeTruthy();
  });

  it('checks a client ID against the file\'s app.clientId, which the file must then state', async () => {
    expect(await problem(setup(good(), { appId: 'Iv23liabc' }).auth.installationToken('acme/web'))).toMatch(/^token-file: .*client ID Iv23liabc.*has no app\.clientId/);
    const other = good({ app: { id: 4242, slug: 'updraft', clientId: 'Iv23lizzz' } });
    expect(await problem(setup(other, { appId: 'Iv23liabc' }).auth.installationToken('acme/web'))).toMatch(/^token-file: .*client ID Iv23lizzz, but github\.app\.appId is Iv23liabc/);
    const same = good({ app: { id: 4242, slug: 'updraft', clientId: 'Iv23liabc' } });
    await expect(setup(same, { appId: 'Iv23liabc' }).auth.installationToken('acme/web')).resolves.toBeTruthy();
  });

  it('enforces a pinned installation on every read, so a misrouted refresh cannot switch it', async () => {
    const path = tokenFile(good());
    const auth = createTokenFileAuth({ path, appId: 4242, installationId: 55, now: () => T0 });
    await expect(auth.installationToken('acme/web')).resolves.toMatchObject({ installationId: 55 });
    writeFileSync(path, JSON.stringify(good({ installationId: 99, token: 'ghs_dddddddddddddddddddd' })));
    expect(await problem(auth.installationToken('acme/web'))).toMatch(/^token-file: .*for installation 99, but github\.app\.installationId is 55/);
    expect(await problem(auth.app())).toMatch(/installation 99/);
  });

  it('marks permissions the file does not state as unknown, not as none', async () => {
    await expect(setup(good({ permissions: undefined })).auth.installationToken('acme/web')).resolves.toMatchObject({ permissions: {}, permissionsUnknown: true });
    const stated = await setup(good()).auth.installationToken('acme/web');
    expect(stated.permissionsUnknown).toBeUndefined();
  });

  it('takes the bot user from the file, or looks it up once with the token', async () => {
    await expect(setup(good({ bot: { id: 99, login: 'updraft[bot]' } })).auth.botUser('acme/web')).resolves.toEqual({ id: 99, login: 'updraft[bot]' });

    const path = tokenFile(good());
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.github.com/users/updraft%5Bbot%5D');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghs_aaaaaaaaaaaaaaaaaaaa');
      return new Response(JSON.stringify({ id: 77, login: 'updraft[bot]' }), { status: 200 });
    });
    const auth = createTokenFileAuth({ path, appId: 4242, now: () => T0, fetch: fetchFn as unknown as typeof fetch });
    await expect(auth.botUser('acme/web')).resolves.toEqual({ id: 77, login: 'updraft[bot]' });
    await auth.botUser('acme/web');
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe('github.app.tokenFile in the config', () => {
  const base = (app: Record<string, unknown>) => ({
    version: 1,
    github: { app: { appId: 4242, ...app } },
    agents: { claude: { adapter: 'claude', command: 'claude' } },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: 'p.md' } },
  });

  it('takes exactly one of privateKeyPath and tokenFile', () => {
    const issues = (app: Record<string, unknown>) =>
      validateConfig(base(app)).ok ? [] : (validateConfig(base(app)) as { errors: { path: string; message: string }[] }).errors.filter((e) => e.path.startsWith('github.app'));
    expect(issues({ tokenFile: 'app-token.json' })).toEqual([]);
    expect(issues({ privateKeyPath: 'app.pem' })).toEqual([]);
    expect(issues({})).toEqual([expect.objectContaining({ path: 'github.app.privateKeyPath', message: expect.stringMatching(/or tokenFile/) })]);
    expect(issues({ privateKeyPath: 'a.pem', tokenFile: 't.json' })).toEqual([expect.objectContaining({ path: 'github.app.tokenFile', message: expect.stringMatching(/not both/) })]);
  });

  it('a token file (from the config or the environment) wins over a key, and the worker acts as the App with it', async () => {
    const path = tokenFile(good({ repositories: ['acme/web'] }));
    const configDir = join(path, '..');
    const userToken = vi.fn();
    expect(appTokenFilePath({ tokenFile: 'app-token.json' }, { configDir, env: {} })).toBe(path);
    expect(appTokenFilePath({}, { configDir, env: { [APP_TOKEN_FILE_ENV]: path } })).toBe(path);
    expect(appTokenFilePath({}, { configDir, env: {} })).toBeNull();

    const fromEnv = createWorkerCredentials(
      { github: { app: { appId: 4242, privateKeyPath: 'never-read.pem' } } },
      { configDir, env: { [APP_TOKEN_FILE_ENV]: path, [APP_KEY_PATH_ENV]: '/nowhere.pem' }, userToken, now: () => T0 },
    );
    expect(fromEnv.kind).toBe('app');
    await expect(fromEnv.token('acme/web')).resolves.toBe('ghs_aaaaaaaaaaaaaaaaaaaa');
    expect(userToken).not.toHaveBeenCalled();
  });

  it('stops at once on an unusable token file', () => {
    expect(() =>
      createWorkerCredentials({ github: { app: { appId: 4242, tokenFile: 'missing.json' } } }, { configDir: root, env: {}, userToken: vi.fn() }),
    ).toThrow(/token file .*missing\.json does not exist/);
  });
});
