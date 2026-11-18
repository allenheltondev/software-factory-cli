import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateConfig } from '../config/validate.js';
import { reviewTrigger } from '../poller/review-trigger.js';
import type { GitHubReview } from './api.js';
import { APP_KEY_PATH_ENV, createAppAuth, GitHubAppError } from './app-auth.js';
import { createGitHubApi } from './client.js';
import {
  appIdentity,
  appPrivateKeyPath,
  createAppCredentials,
  createUserCredentials,
  createWorkerCredentials,
  isWorkerLogin,
  repoOfRequest,
  userIdentity,
} from './credentials.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const root = mkdtempSync(join(tmpdir(), 'updraft-credentials-'));
const configDir = join(root, 'cfg');
mkdirSync(join(configDir, 'keys'), { recursive: true });
const keyPath = join(configDir, 'keys', 'app.pem');
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-18T12:00:00.000Z');

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface Call {
  method: string;
  path: string;
  authorization: string;
  body: string | null;
}

/** GitHub with one App installed on octo/widgets (installation 11, repo id 42) and other/thing (22, repo id 77). */
function fakeGitHub(api: (call: Call) => Response | null = () => null) {
  const calls: Call[] = [];
  let minted = 0;
  const installs: Record<string, number> = { 'octo/widgets': 11, 'other/thing': 22 };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, authorization: headers.Authorization ?? '', body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    if (call.path === '/app') return json({ id: 4242, slug: 'updraft-bot', name: 'Updraft Bot' });
    const inst = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(call.path);
    if (inst) return installs[inst[1]!] ? json({ id: installs[inst[1]!], suspended_at: null }) : json({ message: 'Not Found' }, 404);
    const tok = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(call.path);
    if (tok) return json({ token: `ghs_inst${tok[1]}xxxxxxxxxxxxxxxx${++minted}`, expires_at: new Date(T0 + 3_600_000).toISOString(), permissions: {} }, 201);
    return api(call) ?? json({ message: 'Not Found' }, 404);
  };
  const credentials = createAppCredentials(createAppAuth({ appId: 12345, privateKeyPath: keyPath, fetch: fetchFn, now: () => T0 }));
  const apiCalls = () => calls.filter((c) => c.path !== '/app' && !/installation|access_tokens/.test(c.path));
  return { calls, apiCalls, fetchFn, credentials };
}

const issue = { number: 7, title: 'T', body: 'B', html_url: 'https://github.com/octo/widgets/issues/7', state: 'open', labels: [] };

describe('repoOfRequest', () => {
  const names = new Map([[42, 'octo/widgets']]);
  it('finds the repository in id routes, name routes and GraphQL variables', () => {
    expect(repoOfRequest('/repositories/42/issues/events?per_page=100&page=2', undefined, names)).toBe('octo/widgets');
    expect(repoOfRequest('/repositories/42', undefined, names)).toBe('octo/widgets');
    expect(repoOfRequest('/repositories/43/issues', undefined, names)).toBeNull();
    expect(repoOfRequest('/repos/Octo/Widgets.js/labels', undefined, names)).toBe('Octo/Widgets.js');
    expect(repoOfRequest('/graphql', { query: 'q', variables: { owner: 'octo', name: 'widgets', number: 1 } }, names)).toBe('octo/widgets');
    expect(repoOfRequest('/graphql', { query: 'q' }, names)).toBeNull();
    expect(repoOfRequest('/user', undefined, names)).toBeNull();
    expect(repoOfRequest('/user/repos?per_page=100', undefined, names)).toBeNull();
  });
});

describe('worker identity', () => {
  it('is the account for a user and <slug>[bot] for an App', () => {
    expect(userIdentity({ login: 'allen', id: 5 })).toEqual({ kind: 'user', login: 'allen', id: 5 });
    expect(appIdentity({ id: 4242, slug: 'updraft-bot' })).toEqual({ kind: 'app', login: 'updraft-bot[bot]', id: 4242, appSlug: 'updraft-bot' });
  });

  it('recognises the worker by login, in both spellings GitHub uses for a bot', () => {
    const user = userIdentity({ login: 'Allen', id: 5 });
    expect(isWorkerLogin(user, 'allen')).toBe(true);
    expect(isWorkerLogin(user, 'allen[bot]')).toBe(false);
    expect(isWorkerLogin(user, null)).toBe(false);
    const bot = appIdentity({ id: 4242, slug: 'updraft-bot' });
    expect(isWorkerLogin(bot, 'updraft-bot[bot]')).toBe(true); // REST
    expect(isWorkerLogin(bot, 'Updraft-Bot')).toBe(true); // GraphQL
    expect(isWorkerLogin(bot, 'allen')).toBe(false);
    expect(isWorkerLogin(bot, '')).toBe(false);
    expect(isWorkerLogin(bot, undefined)).toBe(false);
  });

  it('answers through the API as the gh account, with GET /user', async () => {
    const paths: string[] = [];
    const api = await createGitHubApi({
      token: 't0k',
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname);
        return json({ login: 'allen', id: 5 });
      },
    });
    expect(await api.getWorkerIdentity()).toEqual({ kind: 'user', login: 'allen', id: 5 });
    expect(paths).toEqual(['/user']);
  });

  it('answers through the API as the App, with GET /app and never GET /user', async () => {
    const gh = fakeGitHub();
    const api = await createGitHubApi({ credentials: gh.credentials, fetch: gh.fetchFn });
    expect(await api.getWorkerIdentity()).toEqual({ kind: 'app', login: 'updraft-bot[bot]', id: 4242, appSlug: 'updraft-bot' });
    expect(gh.calls.map((c) => c.path)).toEqual(['/app']);
    // What only a person's sign-in can do says so instead of failing obscurely.
    await expect(api.getViewer()).rejects.toMatchObject({ name: 'GitHubAppError', problem: 'not-for-apps' });
    await expect(api.listUserRepos()).rejects.toThrow(/cannot be made as a GitHub App installation.*updraft configure/s);
    expect(gh.apiCalls()).toEqual([]);
  });
});

describe('the bot and dispatch', () => {
  const config = (allowedActors: string[]) => {
    const r = validateConfig({
      version: 1,
      dispatch: { allowedActors },
      agents: { claude: {} },
      pools: { general: { agents: ['claude'] } },
      actions: { implement: {} },
      repositories: {},
    });
    if (!r.ok) throw new Error('invalid test config');
    return r.config;
  };
  const review = (author: string): GitHubReview => ({
    id: 'R_1',
    state: 'CHANGES_REQUESTED',
    author,
    submittedAt: '2026-11-18T12:00:00Z',
    body: 'please change',
    url: 'https://github.com/octo/widgets/pull/1#pullrequestreview-1',
    lastEditedAt: null,
    editor: null,
    comments: [],
    commentCount: 0,
  });

  it('never lets a review by the worker itself start a revision unless the bot is listed', () => {
    const allowed = config(['allen']).dispatch.allowedActors;
    for (const login of ['updraft-bot', 'updraft-bot[bot]']) {
      expect(reviewTrigger(review(login), allowed)).toMatchObject({ triggers: false, disposition: 'not-allowed' });
    }
    expect(reviewTrigger(review('allen'), allowed)).toMatchObject({ triggers: true });
    // Listing the bot is the only way, and it is the user's explicit choice.
    expect(reviewTrigger(review('updraft-bot'), ['allen', 'updraft-bot'])).toMatchObject({ triggers: true });
  });
});

describe('createUserCredentials', () => {
  it('reads the token once, and again when a new one is asked for', async () => {
    let reads = 0;
    const c = createUserCredentials(async () => `tok${++reads}`);
    expect(c.kind).toBe('user');
    expect(await c.token(null)).toBe('tok1');
    expect(await c.token('octo/widgets')).toBe('tok1');
    expect(await c.token('octo/widgets', { fresh: true })).toBe('tok2');
    expect(await c.token(null)).toBe('tok2');
    expect(reads).toBe(2);
  });

  it('does not keep a failed read', async () => {
    let reads = 0;
    const c = createUserCredentials(async () => {
      if (++reads === 1) throw new Error('gh is not signed in');
      return 'tok';
    });
    await expect(c.token(null)).rejects.toThrow(/not signed in/);
    expect(await c.token(null)).toBe('tok');
  });
});

describe('createWorkerCredentials', () => {
  const base = { configDir, env: {} as NodeJS.ProcessEnv, userToken: async () => 'user-token' };

  it('is the gh account without github.app', async () => {
    const c = createWorkerCredentials({ github: undefined }, base);
    expect(c.kind).toBe('user');
    expect(c.app).toBeUndefined();
    expect(await c.token('octo/widgets')).toBe('user-token');
    expect(createWorkerCredentials(null, base).kind).toBe('user');
  });

  it('is the App with github.app, with the key path relative to the config directory', () => {
    const c = createWorkerCredentials({ github: { app: { appId: 12345, privateKeyPath: 'keys/app.pem', installationId: 11 } } }, base);
    expect(c.kind).toBe('app');
    expect(c.app?.privateKeyPath).toBe(keyPath);
    expect(c.app?.appId).toBe(12345);
  });

  it('takes the key path from the environment when it is set there', () => {
    const app = { appId: 1, privateKeyPath: 'missing.pem' };
    expect(appPrivateKeyPath(app, { configDir, env: {} })).toBe(join(configDir, 'missing.pem'));
    expect(appPrivateKeyPath(app, { configDir, env: { [APP_KEY_PATH_ENV]: keyPath } })).toBe(keyPath);
    expect(appPrivateKeyPath(app, { configDir, env: { [APP_KEY_PATH_ENV]: 'keys/app.pem' } })).toBe(keyPath);
    expect(appPrivateKeyPath(app, { configDir, env: { [APP_KEY_PATH_ENV]: '  ' } })).toBe(join(configDir, 'missing.pem'));
    expect(createWorkerCredentials({ github: { app } }, { ...base, env: { [APP_KEY_PATH_ENV]: keyPath } }).kind).toBe('app');
  });

  it('stops at once when the key cannot be used', () => {
    expect(() => createWorkerCredentials({ github: { app: { appId: 1, privateKeyPath: 'missing.pem' } } }, base)).toThrow(GitHubAppError);
    expect(() => createWorkerCredentials({ github: { app: { appId: 1, privateKeyPath: 'missing.pem' } } }, base)).toThrow(/does not exist/);
  });
});

describe('the API client as a GitHub App', () => {
  it('sends each request with the token of the installation that covers its repository', async () => {
    const gh = fakeGitHub((call) => {
      if (call.path === '/repositories/42/issues/7' || call.path === '/repositories/77/issues/7') return json(issue);
      if (call.path === '/repos/other/thing') {
        return json({ id: 77, full_name: 'other/thing', name: 'thing', owner: { login: 'other' }, private: true, archived: false, default_branch: 'main', description: null });
      }
      if (call.path === '/repositories/42/labels') return json([{ name: 'ready', color: 'fff', description: null }]);
      return null;
    });
    const api = await createGitHubApi({ credentials: gh.credentials, fetch: gh.fetchFn });
    await api.getIssue({ id: 42, fullName: 'octo/widgets' }, 7);
    await api.getIssue({ id: 77, fullName: 'other/thing' }, 7);
    await api.getRepo('other/thing');
    await api.listLabels({ id: 42, fullName: 'octo/widgets' });
    expect(gh.apiCalls().map((c) => [c.path, c.authorization])).toEqual([
      ['/repositories/42/issues/7', 'Bearer ghs_inst11xxxxxxxxxxxxxxxx1'],
      ['/repositories/77/issues/7', 'Bearer ghs_inst22xxxxxxxxxxxxxxxx2'],
      ['/repos/other/thing', 'Bearer ghs_inst22xxxxxxxxxxxxxxxx2'],
      ['/repositories/42/labels', 'Bearer ghs_inst11xxxxxxxxxxxxxxxx1'],
    ]);
    // One token per installation, however many requests.
    expect(gh.calls.filter((c) => c.path.endsWith('access_tokens'))).toHaveLength(2);
  });

  it('uses the repository of a GraphQL query, and of the pages a listing links to', async () => {
    let commentPages = 0;
    const gh = fakeGitHub((call) => {
      if (call.path === '/graphql') return json({ data: { repository: { databaseId: 77, issue: { lastEditedAt: null, editor: null } } } });
      if (call.path === '/repositories/42/issues/7/comments') {
        return ++commentPages === 1
          ? json([{ id: 1, html_url: 'u', body: 'a', user: { login: 'updraft-bot[bot]' } }], 200, {
              link: '<https://api.github.com/repositories/42/issues/7/comments?per_page=100&page=2>; rel="next"',
            })
          : json([{ id: 2, html_url: 'u', body: 'b', user: { login: 'allen' } }]);
      }
      return null;
    });
    const api = await createGitHubApi({ credentials: gh.credentials, fetch: gh.fetchFn });
    expect((await api.listIssueComments({ id: 42, fullName: 'octo/widgets' }, 7)).map((c) => c.user)).toEqual(['updraft-bot[bot]', 'allen']);
    await api.getIssueBodyEdit({ id: 77, fullName: 'other/thing' }, 3);
    const used = gh.apiCalls().map((c) => [c.path, c.authorization]);
    expect(used).toEqual([
      ['/repositories/42/issues/7/comments', 'Bearer ghs_inst11xxxxxxxxxxxxxxxx1'],
      ['/repositories/42/issues/7/comments', 'Bearer ghs_inst11xxxxxxxxxxxxxxxx1'],
      ['/graphql', 'Bearer ghs_inst22xxxxxxxxxxxxxxxx2'],
    ]);
  });

  it('replaces a token GitHub rejects and tries the request once more', async () => {
    let rejected = 0;
    const gh = fakeGitHub((call) => {
      if (call.path !== '/repositories/42/issues/7') return null;
      if (call.authorization.endsWith('1')) {
        rejected++;
        return json({ message: 'Bad credentials' }, 401);
      }
      return json(issue);
    });
    const api = await createGitHubApi({ credentials: gh.credentials, fetch: gh.fetchFn });
    expect((await api.getIssue({ id: 42, fullName: 'octo/widgets' }, 7)).number).toBe(7);
    expect(rejected).toBe(1);
    expect(gh.apiCalls().map((c) => c.authorization)).toEqual(['Bearer ghs_inst11xxxxxxxxxxxxxxxx1', 'Bearer ghs_inst11xxxxxxxxxxxxxxxx2']);
  });

  it('reports a token that keeps being rejected, and a missing permission, as App problems that say what to do', async () => {
    const gh = fakeGitHub((call) => {
      if (call.path === '/repositories/42/issues/7') return json({ message: 'Bad credentials' }, 401);
      if (call.path === '/repositories/42/pulls') return json({ message: 'Resource not accessible by integration' }, 403);
      if (call.path === '/repositories/42/issues/7/comments') return json({ message: 'API rate limit exceeded' }, 403, { 'retry-after': '30' });
      return null;
    });
    const api = await createGitHubApi({ credentials: gh.credentials, fetch: gh.fetchFn });
    const repo = { id: 42, fullName: 'octo/widgets' };
    const unauthorized = await api.getIssue(repo, 7).catch((e: unknown) => e);
    expect(unauthorized).toMatchObject({ name: 'GitHubAppError', problem: 'token-rejected', status: 401 });
    expect((unauthorized as Error).message).not.toMatch(/gh auth login/);
    expect(gh.apiCalls()).toHaveLength(2); // one retry, no more

    const denied = await api.createPullRequest(repo, { title: 't', head: 'h', base: 'main', body: '', draft: true }).catch((e: unknown) => e);
    expect(denied).toMatchObject({ name: 'GitHubAppError', problem: 'permissions', status: 403 });
    expect((denied as Error).message).toMatch(/installation on octo\/widgets lacks a permission/);

    // A rate limit is not an App problem: it stays a retryable GitHub error.
    const limited = await api.listIssueComments(repo, 7).catch((e: unknown) => e);
    expect(limited).toMatchObject({ name: 'GitHubError', status: 403, retryAfterSeconds: 30 });
  });

  it('says which repository lacks the App, with a status the poller does not read as "gone"', async () => {
    const gh = fakeGitHub();
    const api = await createGitHubApi({ credentials: gh.credentials, fetch: gh.fetchFn });
    const err = await api.getIssue({ id: 9, fullName: 'nobody/nothing' }, 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'GitHubAppError', problem: 'not-installed', status: 403 });
    expect([301, 404, 410]).not.toContain((err as GitHubAppError).status);
    expect(gh.apiCalls()).toEqual([]);
  });

  it('does not retry a 401 for a user token, as before', async () => {
    let requests = 0;
    const api = await createGitHubApi({
      token: 't0k',
      fetch: async () => {
        requests++;
        return json({ message: 'Bad credentials' }, 401);
      },
    });
    await expect(api.getIssue({ id: 42, fullName: 'octo/widgets' }, 7)).rejects.toThrow(/gh auth login/);
    expect(requests).toBe(1);
  });
});
