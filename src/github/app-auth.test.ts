import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitHubError } from './api.js';
import {
  appRequestProblem,
  createAppAuth,
  createAppJwt,
  GitHubAppError,
  JWT_BACKDATE_SECONDS,
  JWT_LIFETIME_SECONDS,
  loadAppPrivateKey,
  missingAppPermissions,
  redactGitHubSecrets,
  requiredAppPermissions,
  type AppAuth,
} from './app-auth.js';
import { appCommitIdentity, commitIdentityEnv } from './credentials.js';
import { createLogger } from '../util/log.js';

// Keys are generated here, per test run; nothing is committed.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const dir = mkdtempSync(join(tmpdir(), 'updraft-app-auth-'));
const keyPath = join(dir, 'app.private-key.pem');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
writeFileSync(keyPath, PEM, { mode: 0o600 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const MINUTE = 60_000;

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function verifyJwt(jwt: string, key: KeyObject = publicKey): boolean {
  const [header, payload, signature] = jwt.split('.');
  return createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(key, Buffer.from(signature!, 'base64url'));
}

describe('createAppJwt', () => {
  it('signs an RS256 JWT with a backdated iat, a short exp and the App as issuer', () => {
    const jwt = createAppJwt({ appId: 12345, key: privateKey, now: T0 + 999 });
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decode(parts[0]!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(parts[1]!);
    const seconds = T0 / 1000;
    expect(claims).toEqual({ iat: seconds - JWT_BACKDATE_SECONDS, exp: seconds + JWT_LIFETIME_SECONDS, iss: 12345 });
    // GitHub accepts at most ten minutes, and the expiry must not be more than that away.
    expect(JWT_LIFETIME_SECONDS).toBeLessThanOrEqual(600);
    expect(JWT_BACKDATE_SECONDS).toBeGreaterThan(0);
    expect(verifyJwt(jwt)).toBe(true);
    // Signed by this key and no other.
    expect(verifyJwt(jwt, generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey)).toBe(false);
    // Tampering with the claims breaks the signature.
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ ...claims, iss: 1 })).toString('base64url')}.${parts[2]}`;
    expect(verifyJwt(forged)).toBe(false);
  });

  it('accepts a client ID as the issuer', () => {
    const jwt = createAppJwt({ appId: 'Iv23liABCDEF', key: privateKey, now: T0 });
    expect(decode(jwt.split('.')[1]!).iss).toBe('Iv23liABCDEF');
  });
});

describe('loadAppPrivateKey', () => {
  it('loads an RSA key in PKCS#8 and PKCS#1 form', () => {
    expect(loadAppPrivateKey(keyPath).asymmetricKeyType).toBe('rsa');
    const pkcs1 = join(dir, 'pkcs1.pem');
    writeFileSync(pkcs1, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    expect(loadAppPrivateKey(pkcs1).asymmetricKeyType).toBe('rsa');
  });

  it('says what to change for a missing, unparseable or non-RSA key, without repeating its content', () => {
    const missing = join(dir, 'nope.pem');
    expect(() => loadAppPrivateKey(missing)).toThrow(GitHubAppError);
    expect(() => loadAppPrivateKey(missing)).toThrow(/does not exist.*github\.app\.privateKeyPath.*UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH/s);

    const garbage = join(dir, 'garbage.pem');
    writeFileSync(garbage, '-----BEGIN RSA PRIVATE KEY-----\nSECRETSECRETSECRET\n-----END RSA PRIVATE KEY-----\n');
    let caught: unknown;
    try {
      loadAppPrivateKey(garbage);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitHubAppError);
    expect((caught as GitHubAppError).problem).toBe('key');
    expect((caught as Error).message).toMatch(/is not a PEM private key/);
    expect((caught as Error).message).not.toContain('SECRETSECRET');

    const ec = join(dir, 'ec.pem');
    writeFileSync(ec, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(() => loadAppPrivateKey(ec)).toThrow(/is a ec key; GitHub Apps sign with an RSA key/);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('explains an unreadable key', () => {
    const locked = join(dir, 'locked.pem');
    writeFileSync(locked, PEM);
    chmodSync(locked, 0o000);
    expect(() => loadAppPrivateKey(locked)).toThrow(/cannot be read by the user the worker runs as/);
  });

  it('is a permanent error with a status that is neither "gone" nor transient', () => {
    const err = new GitHubAppError('x', 'key');
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(401);
    expect(err.isRateLimit).toBe(false);
    for (const p of ['not-installed', 'suspended', 'permissions'] as const) {
      const e = new GitHubAppError('x', p);
      expect(e.status).toBe(403);
      expect(e.isRateLimit).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// A GitHub that knows one App
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  authorization: string;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeGitHub(o: { installations?: Record<string, number> } = {}) {
  const installations: Record<string, number> = o.installations ?? { 'octo/widgets': 11, 'other/thing': 22 };
  const calls: Call[] = [];
  const state = {
    now: T0,
    minted: 0,
    /** When set, answers the next matching request instead of the normal handler. */
    intercept: null as null | ((call: Call) => Response | null | Promise<Response | null>),
    suspended: new Set<number>(),
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, authorization: headers.Authorization ?? '' };
    calls.push(call);
    const intercepted = await state.intercept?.(call);
    if (intercepted) return intercepted;
    if (call.path === '/app') return json({ id: 4242, slug: 'updraft-bot', name: 'Updraft Bot', permissions: { contents: 'write' } });
    const inst = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(call.path);
    if (inst) {
      const id = installations[`${decodeURIComponent(inst[1]!)}/${decodeURIComponent(inst[2]!)}`.toLowerCase()];
      if (!id) return json({ message: 'Not Found' }, 404);
      return json({ id, suspended_at: state.suspended.has(id) ? '2026-11-01T00:00:00Z' : null, permissions: { metadata: 'read' }, repository_selection: 'selected' });
    }
    const tok = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(call.path);
    if (tok && call.method === 'POST') {
      const id = Number(tok[1]);
      if (!Object.values(installations).includes(id)) return json({ message: 'Not Found' }, 404);
      state.minted++;
      return json(
        {
          token: `ghs_installation${id}Token${String(state.minted).padStart(8, '0')}`,
          expires_at: new Date(state.now + 60 * MINUTE).toISOString(),
          permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' },
          repository_selection: 'selected',
        },
        201,
      );
    }
    if (call.path === '/users/updraft-bot%5Bbot%5D') return json({ id: 987654, login: 'updraft-bot[bot]' });
    return json({ message: 'Not Found' }, 404);
  };
  const lines: string[] = [];
  const log = createLogger({ stream: { write: (s: string) => lines.push(s) } as unknown as NodeJS.WritableStream, level: 'debug' });
  const auth = (over: { installationId?: number } = {}): AppAuth =>
    createAppAuth({ appId: 12345, privateKeyPath: keyPath, fetch: fetchFn, now: () => state.now, log, ...over });
  const count = (re: RegExp, method?: string) => calls.filter((c) => re.test(c.path) && (!method || c.method === method)).length;
  return { calls, state, auth, lines, count };
}

const TOKENS = /access_tokens$/;
const LOOKUPS = /\/installation$/;

describe('createAppAuth', () => {
  it('exchanges a JWT signed by the App for an installation token of the repository', async () => {
    const gh = fakeGitHub();
    const t = await gh.auth().installationToken('octo/widgets');
    expect(t).toMatchObject({
      token: 'ghs_installation11Token00000001',
      installationId: 11,
      expiresAt: T0 + 60 * MINUTE,
      permissions: { contents: 'write' },
      repositorySelection: 'selected',
    });
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /repos/octo/widgets/installation', 'POST /app/installations/11/access_tokens']);
    for (const c of gh.calls) {
      const jwt = c.authorization.replace(/^Bearer /, '');
      expect(verifyJwt(jwt)).toBe(true);
      expect(decode(jwt.split('.')[1]!)).toMatchObject({ iss: 12345, iat: T0 / 1000 - 60 });
    }
  });

  it('caches the token and replaces it ahead of its expiry', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    const first = await auth.installationToken('octo/widgets');
    expect((await auth.installationToken('octo/widgets')).token).toBe(first.token);
    gh.state.now = T0 + 49 * MINUTE; // eleven minutes left
    expect((await auth.installationToken('octo/widgets')).token).toBe(first.token);
    expect(gh.count(TOKENS)).toBe(1);

    gh.state.now = T0 + 51 * MINUTE; // nine minutes left: not enough for a publication attempt
    const second = await auth.installationToken('octo/widgets');
    expect(second.token).not.toBe(first.token);
    expect(second.expiresAt).toBe(T0 + 111 * MINUTE);
    expect(gh.count(TOKENS)).toBe(2);
    // The installation is looked up once, however long the worker runs.
    expect(gh.count(LOOKUPS)).toBe(1);

    // Days later, well past the old token: one request, a new token.
    gh.state.now = T0 + 3 * 24 * 60 * MINUTE;
    const third = await auth.installationToken('octo/widgets');
    expect(third.token).not.toBe(second.token);
    expect(gh.count(TOKENS)).toBe(3);
  });

  it('gives concurrent callers one request and the same token', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    gh.state.intercept = async (call) => {
      if (TOKENS.test(call.path)) await gate;
      return null;
    };
    const pending = Array.from({ length: 6 }, () => auth.installationToken('octo/widgets'));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const got = await Promise.all(pending);
    expect(new Set(got.map((t) => t.token)).size).toBe(1);
    expect(gh.count(TOKENS)).toBe(1);
    expect(gh.count(LOOKUPS)).toBe(1);

    // The same at refresh time.
    gh.state.intercept = null;
    gh.state.now = T0 + 55 * MINUTE;
    const again = await Promise.all(Array.from({ length: 4 }, () => auth.installationToken('octo/widgets')));
    expect(new Set(again.map((t) => t.token)).size).toBe(1);
    expect(again[0]!.token).not.toBe(got[0]!.token);
    expect(gh.count(TOKENS)).toBe(2);
  });

  it('keeps using a token that still works when a refresh fails for a passing reason, then fails once it expired', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    const first = await auth.installationToken('octo/widgets');
    gh.state.now = T0 + 52 * MINUTE;
    gh.state.intercept = (call) => (TOKENS.test(call.path) ? json({ message: 'Server Error' }, 503) : null);

    const during = await Promise.all([auth.installationToken('octo/widgets'), auth.installationToken('octo/widgets')]);
    expect(during.map((t) => t.token)).toEqual([first.token, first.token]);
    expect(gh.count(TOKENS)).toBe(2); // one failed refresh shared by both callers
    // No hammering: the next caller within half a minute does not ask again.
    await auth.installationToken('octo/widgets');
    expect(gh.count(TOKENS)).toBe(2);
    gh.state.now += 31_000;
    expect((await auth.installationToken('octo/widgets')).token).toBe(first.token);
    expect(gh.count(TOKENS)).toBe(3);
    expect(gh.lines.join('')).toMatch(/could not refresh the GitHub App installation token/);

    // A caller that needs a newly issued token gets the failure, not the cached one.
    await expect(auth.installationToken('octo/widgets', { fresh: true })).rejects.toMatchObject({ status: 503 });

    // Past the expiry there is nothing left to fall back on: a transient GitHubError, retried by callers.
    gh.state.now = T0 + 61 * MINUTE;
    const failures = await Promise.allSettled([auth.installationToken('octo/widgets'), auth.installationToken('octo/widgets')]);
    for (const f of failures) {
      expect(f.status).toBe('rejected');
      const reason = (f as PromiseRejectedResult).reason as GitHubError;
      expect(reason).toBeInstanceOf(GitHubError);
      expect(reason).not.toBeInstanceOf(GitHubAppError);
      expect(reason.status).toBe(503);
    }

    // And it recovers by itself when GitHub does.
    gh.state.intercept = null;
    const recovered = await auth.installationToken('octo/widgets');
    expect(recovered.token).not.toBe(first.token);
  });

  it('does not fall back on the cached token when the refresh is refused for good', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    await auth.installationToken('octo/widgets');
    gh.state.now = T0 + 52 * MINUTE;
    gh.state.intercept = (call) => (TOKENS.test(call.path) ? json({ message: 'A JSON web token could not be decoded' }, 401) : null);
    await expect(auth.installationToken('octo/widgets')).rejects.toMatchObject({ name: 'GitHubAppError', problem: 'jwt-rejected' });
  });

  it('issues a new token on request and forgets one GitHub rejected', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    const first = await auth.installationToken('octo/widgets');
    const fresh = await auth.installationToken('octo/widgets', { fresh: true });
    expect(fresh.token).not.toBe(first.token);
    // The new one is what later callers get.
    expect((await auth.installationToken('octo/widgets')).token).toBe(fresh.token);
    auth.reject(fresh.token);
    expect((await auth.installationToken('octo/widgets')).token).not.toBe(fresh.token);
    expect(gh.count(TOKENS)).toBe(3);
  });

  it('finds the installation per repository, so repositories under different owners work', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    const a = await auth.installationToken('octo/widgets');
    const b = await auth.installationToken('other/thing');
    expect([a.installationId, b.installationId]).toEqual([11, 22]);
    expect(a.token).not.toBe(b.token);
    // Cached per repository, case-insensitively, and each installation keeps its own token.
    expect((await auth.installationToken('Octo/Widgets')).token).toBe(a.token);
    expect((await auth.installationToken('other/thing')).token).toBe(b.token);
    expect(gh.count(LOOKUPS)).toBe(2);
    expect(gh.count(TOKENS)).toBe(2);
  });

  it('shares one token between repositories of the same installation', async () => {
    const gh = fakeGitHub({ installations: { 'octo/widgets': 11, 'octo/gadgets': 11 } });
    const auth = gh.auth();
    const a = await auth.installationToken('octo/widgets');
    const b = await auth.installationToken('octo/gadgets');
    expect(b.token).toBe(a.token);
    expect(gh.count(TOKENS)).toBe(1);
  });

  it('uses a configured installation without looking one up', async () => {
    const gh = fakeGitHub();
    const t = await gh.auth({ installationId: 22 }).installationToken('octo/widgets');
    expect(t.installationId).toBe(22);
    expect(gh.count(LOOKUPS)).toBe(0);

    const wrong = gh.auth({ installationId: 999 });
    await expect(wrong.installationToken('octo/widgets')).rejects.toThrow(/has no installation 999.*github\.app\.installationId is wrong/s);
  });

  it('says when the App is not installed on a repository, and asks again next time', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    const err = await auth.installationToken('nobody/nothing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect(err).toMatchObject({ problem: 'not-installed', status: 403 });
    expect((err as Error).message).toMatch(/is not installed on nobody\/nothing\. Install it there/);
    await expect(auth.installationToken('nobody/nothing')).rejects.toThrow(/not installed/);
    expect(gh.count(LOOKUPS)).toBe(2);
    // Once the App's name is known the message carries it.
    await auth.app();
    await expect(auth.installationToken('nobody/nothing')).rejects.toThrow(/the GitHub App updraft-bot is not installed on nobody\/nothing/);
  });

  it('looks the installation up again after it disappeared', async () => {
    const installations: Record<string, number> = { 'octo/widgets': 11 };
    const gh = fakeGitHub({ installations });
    const auth = gh.auth();
    await auth.installationToken('octo/widgets');
    installations['octo/widgets'] = 33; // uninstalled and installed again
    gh.state.now = T0 + 55 * MINUTE;
    await expect(auth.installationToken('octo/widgets')).rejects.toMatchObject({ problem: 'not-installed' });
    await new Promise((r) => setTimeout(r, 0));
    expect((await auth.installationToken('octo/widgets')).installationId).toBe(33);
  });

  it('says when the installation is suspended', async () => {
    const gh = fakeGitHub();
    gh.state.suspended.add(11);
    await expect(gh.auth().installationToken('octo/widgets')).rejects.toMatchObject({ problem: 'suspended', status: 403 });
    await expect(gh.auth().installationToken('octo/widgets')).rejects.toThrow(/installation on octo\/widgets is suspended.*Unsuspend it/s);

    // With a configured installation there is no lookup; the token request is what is refused.
    gh.state.intercept = (call) => (TOKENS.test(call.path) ? json({ message: 'This installation has been suspended' }, 403) : null);
    await expect(gh.auth({ installationId: 11 }).installationToken('octo/widgets')).rejects.toMatchObject({ problem: 'suspended' });
  });

  it('tells a wrong clock from a wrong key or App ID', async () => {
    const gh = fakeGitHub();
    gh.state.intercept = () => json({ message: "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires" }, 401);
    const clock = await gh.auth().installationToken('octo/widgets').catch((e: unknown) => e);
    expect(clock).toMatchObject({ problem: 'clock', status: 401 });
    expect((clock as Error).message).toMatch(/This machine's clock reads 2026-11-18T12:00:00\.000Z; correct it/);

    gh.state.intercept = () => json({ message: "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued" }, 401);
    await expect(gh.auth().app()).rejects.toMatchObject({ problem: 'clock' });

    gh.state.intercept = () => json({ message: 'A JSON web token could not be decoded' }, 401);
    const key = await gh.auth().app().catch((e: unknown) => e);
    expect(key).toMatchObject({ problem: 'jwt-rejected' });
    expect((key as Error).message).toMatch(/github\.app\.appId \(12345\).*private keys listed/s);

    gh.state.intercept = () => json({ message: 'Integration not found' }, 404);
    await expect(gh.auth().app()).rejects.toMatchObject({ problem: 'jwt-rejected' });
  });

  it("recognises a wrong clock from GitHub's own time when the answer is a bare 401", async () => {
    // What GitHub answers to a JWT whose exp is past or whose iat is in the future.
    const at = (serverTime: number) => () => json({ message: 'Bad credentials' }, 401, { date: new Date(serverTime).toUTCString() });
    const gh = fakeGitHub();

    gh.state.intercept = at(T0 - 5 * MINUTE); // this machine is five minutes fast: iat is in GitHub's future
    const fast = await gh.auth().app().catch((e: unknown) => e);
    expect(fast).toMatchObject({ problem: 'clock', status: 401 });
    expect((fast as Error).message).toMatch(/clock reads 2026-11-18T12:00:00\.000Z, GitHub's reads 2026-11-18T11:55:00\.000Z \(this machine is about 300 seconds ahead\); correct it/);

    gh.state.intercept = at(T0 + 20 * MINUTE); // twenty minutes slow: exp is already past
    const slow = await gh.auth().installationToken('octo/widgets').catch((e: unknown) => e);
    expect(slow).toMatchObject({ problem: 'clock' });
    expect((slow as Error).message).toMatch(/about 1200 seconds behind/);

    // Within what the JWT allows for, the clock is not the reason: it is the key or the App ID.
    for (const drift of [0, -30 * 1000, 4 * MINUTE]) {
      gh.state.intercept = at(T0 + drift);
      await expect(gh.auth().app()).rejects.toMatchObject({ problem: 'jwt-rejected' });
    }
  });

  it('leaves passing failures as plain GitHub errors, with their retry time', async () => {
    const gh = fakeGitHub();
    gh.state.intercept = () => json({ message: 'API rate limit exceeded' }, 403, { 'retry-after': '120' });
    const limited = (await gh.auth().installationToken('octo/widgets').catch((e: unknown) => e)) as GitHubError;
    expect(limited).not.toBeInstanceOf(GitHubAppError);
    expect(limited.isRateLimit).toBe(true);
    expect(limited.retryAfterSeconds).toBe(120);

    const down = createAppAuth({
      appId: 1,
      privateKeyPath: keyPath,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.installationToken('octo/widgets')).rejects.toMatchObject({ status: 0 });
  });

  it('reports a key that went missing while running', async () => {
    const moving = join(dir, 'moving.pem');
    writeFileSync(moving, PEM);
    let requests = 0;
    const auth = createAppAuth({
      appId: 1,
      privateKeyPath: moving,
      fetch: async () => {
        requests++;
        return json({});
      },
    });
    rmSync(moving);
    await expect(auth.installationToken('octo/widgets')).rejects.toMatchObject({ problem: 'key' });
    expect(requests).toBe(0);
  });

  it('describes the App and its bot account, and caches both', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    expect(await auth.app()).toEqual({ id: 4242, slug: 'updraft-bot', name: 'Updraft Bot', permissions: { contents: 'write' } });
    await auth.app();
    expect(gh.count(/^\/app$/)).toBe(1);

    const who = await appCommitIdentity(auth, 'octo/widgets');
    expect(who).toEqual({ name: 'updraft-bot[bot]', email: '987654+updraft-bot[bot]@users.noreply.github.com' });
    expect(commitIdentityEnv(who)).toEqual({
      GIT_AUTHOR_NAME: 'updraft-bot[bot]',
      GIT_AUTHOR_EMAIL: '987654+updraft-bot[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'updraft-bot[bot]',
      GIT_COMMITTER_EMAIL: '987654+updraft-bot[bot]@users.noreply.github.com',
    });
    // The bot's user is read with the installation token, not the JWT.
    const userCall = gh.calls.find((c) => c.path.startsWith('/users/'))!;
    expect(userCall.authorization).toBe('Bearer ghs_installation11Token00000001');
    await appCommitIdentity(auth, 'octo/widgets');
    expect(gh.count(/^\/users\//)).toBe(1);
  });

  it('never logs or reports the key, a JWT or a token', async () => {
    const gh = fakeGitHub();
    const auth = gh.auth();
    const t = await auth.installationToken('octo/widgets');
    gh.state.intercept = (call) => json({ message: `Bad credentials for ${call.authorization} and ${t.token}` }, 422);
    const err = (await auth.installationToken('octo/widgets', { fresh: true }).catch((e: unknown) => e)) as Error;
    const jwts = gh.calls.map((c) => c.authorization.replace(/^Bearer /, ''));
    const everything = `${gh.lines.join('')}\n${err.message}`;
    expect(everything).toContain('github app request');
    expect(everything).not.toContain(t.token);
    for (const j of jwts) expect(everything).not.toContain(j);
    expect(everything).not.toContain(PEM.split('\n')[1]!);
  });
});

describe('redactGitHubSecrets', () => {
  it('removes private keys, JWTs, GitHub tokens and the header form of a token', () => {
    const jwt = createAppJwt({ appId: 1, key: privateKey, now: T0 });
    const token = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a';
    const header = Buffer.from(`x-access-token:${token}`).toString('base64');
    const text = `key:\n${PEM.trim()}\njwt ${jwt}; token ${token}; pat ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuv; header AUTHORIZATION: basic ${header}.`;
    const out = redactGitHubSecrets(text);
    expect(out).toBe('key:\n***\njwt ***; token ***; pat *** and ***; header AUTHORIZATION: basic ***.');
    // Ordinary text is left alone.
    const plain = 'pushing updraft/issue-7-job_abc (0123456789ab, 2 commit(s)) to origin (https://github.com/octo/widgets.git)';
    expect(redactGitHubSecrets(plain)).toBe(plain);
  });

  it('removes a key whose end is cut off', () => {
    expect(redactGitHubSecrets(`oops ${PEM.slice(0, 200)}`)).toBe('oops ***');
  });
});

describe('App permissions', () => {
  it('needs only read access for polling, and write access for what publication and comments do', () => {
    expect(requiredAppPermissions({ publish: false, commentOnFailure: false })).toEqual({ metadata: 'read', issues: 'read' });
    expect(requiredAppPermissions({ publish: false, commentOnFailure: true })).toEqual({ metadata: 'read', issues: 'write' });
    expect(requiredAppPermissions({ publish: true, commentOnFailure: false })).toEqual({
      metadata: 'read',
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
    });
  });

  it('names each gap and what to set', () => {
    const need = requiredAppPermissions({ publish: true, commentOnFailure: true });
    expect(missingAppPermissions({ metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' }, need)).toEqual([]);
    expect(missingAppPermissions({ metadata: 'read', contents: 'read', issues: 'write' }, need)).toEqual([
      'Contents: needs "Read and write", the installation has "read"',
      'Pull requests: needs "Read and write", the installation has no access',
    ]);
    expect(missingAppPermissions({}, { metadata: 'read', issues: 'read' })).toEqual([
      'Metadata: needs "Read-only", the installation has no access',
      'Issues: needs "Read-only", the installation has no access',
    ]);
  });
});

describe('appRequestProblem', () => {
  it('explains a rejected installation token and a missing permission, and leaves other failures alone', () => {
    const base = { method: 'POST', path: '/repositories/42/pulls', repoFullName: 'octo/widgets' };
    const denied = appRequestProblem({ ...base, status: 403, detail: 'Resource not accessible by integration' });
    expect(denied).toMatchObject({ problem: 'permissions', status: 403 });
    expect(denied!.message).toMatch(/installation on octo\/widgets lacks a permission.*Contents, Pull requests and Issues read and write.*updraft doctor/s);
    expect(appRequestProblem({ ...base, status: 401, detail: 'Bad credentials' })).toMatchObject({ problem: 'token-rejected', status: 401 });
    expect(appRequestProblem({ ...base, status: 403, detail: 'Repository was archived so is read-only.' })).toBeNull();
    expect(appRequestProblem({ ...base, status: 404, detail: 'Not Found' })).toBeNull();
    expect(appRequestProblem({ ...base, status: 422, detail: 'Validation Failed' })).toBeNull();
  });
});
