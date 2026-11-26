import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { callerFromClaims } from './caller.js';

const CLIENT = 'client-123';
const idClaims = {
  sub: 'user-1',
  aud: CLIENT,
  token_use: 'id',
  email: 'pat@example.com',
  given_name: 'Pat',
  family_name: 'Lee',
};

describe('callerFromClaims', () => {
  it('accepts an ID token for this client', () => {
    expect(callerFromClaims(idClaims, CLIENT)).toEqual({ sub: 'user-1', email: 'pat@example.com', name: 'Pat Lee' });
  });

  it('refuses a token minted for another client in the shared pool', () => {
    expect(callerFromClaims({ ...idClaims, aud: 'other-app' }, CLIENT)).toBeNull();
  });

  it('refuses an access token', () => {
    expect(callerFromClaims({ ...idClaims, token_use: 'access' }, CLIENT)).toBeNull();
  });

  it('refuses claims without a sub, missing claims, and an unset client id', () => {
    expect(callerFromClaims({ ...idClaims, sub: ' ' }, CLIENT)).toBeNull();
    expect(callerFromClaims(undefined, CLIENT)).toBeNull();
    expect(callerFromClaims(idClaims, '')).toBeNull();
  });

  it('leaves out a name it does not have', () => {
    expect(callerFromClaims({ sub: 's', aud: CLIENT, token_use: 'id' }, CLIENT)).toEqual({ sub: 's' });
  });
});

describe('createApp', () => {
  const signedIn = createApp({ resolveCaller: () => ({ sub: 'user-1', email: 'pat@example.com' }) });
  const signedOut = createApp({ resolveCaller: () => null });

  it('answers health without a caller', async () => {
    const res = await signedOut.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns the caller from /api/v1/me', async () => {
    const res = await signedIn.request('/api/v1/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'user-1', email: 'pat@example.com', admin: false });
  });

  it('refuses /api/v1 without a caller, including unknown routes', async () => {
    for (const path of ['/api/v1/me', '/api/v1/anything']) {
      const res = await signedOut.request(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('answers 404 with JSON for unknown routes', async () => {
    expect((await signedIn.request('/api/v1/nope')).status).toBe(404);
    const res = await signedOut.request('/elsewhere');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('hides error details', async () => {
    const logError = vi.fn();
    const app = createApp({
      resolveCaller: () => {
        throw new Error('secret detail');
      },
      logError,
    });
    const res = await app.request('/api/v1/me');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret detail');
    expect(logError).toHaveBeenCalledOnce();
  });
});

describe('package registry routes (#157)', () => {
  const view = { hosts: [], defaults: [], max: 20, canEdit: true, version: 0 };
  const registries = { view: vi.fn().mockResolvedValue(view), update: vi.fn().mockResolvedValue({ ...view, hosts: ['npm.pkg.github.com'], version: 1 }) };
  const app = createApp({ resolveCaller: () => ({ sub: 'user-1' }), registries });
  const put = (body: string) => app.request('/api/v1/installations/55/package-registries', { method: 'PUT', body, headers: { 'content-type': 'application/json' } });

  it('reads and writes one installation, passing only hosts and version through', async () => {
    const res = await app.request('/api/v1/installations/55/package-registries');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(registries.view).toHaveBeenCalledWith({ sub: 'user-1' }, 55);
    expect((await put(JSON.stringify({ hosts: ['npm.pkg.github.com'], version: 0 }))).status).toBe(200);
    expect(registries.update).toHaveBeenCalledWith({ sub: 'user-1' }, 55, { hosts: ['npm.pkg.github.com'], version: 0 });
  });

  it.each(['not json', '[]', JSON.stringify({ hosts: [], version: 0, installationId: 56 })])('refuses the body %s', async (body) => {
    registries.update.mockClear();
    expect((await put(body)).status).toBe(400);
    expect(registries.update).not.toHaveBeenCalled();
  });

  it('refuses an installation id that is not a positive integer', async () => {
    expect((await app.request('/api/v1/installations/-1/package-registries')).status).toBe(404);
  });
});

describe('subscription routes per provider (#125)', () => {
  const service = (name: string) => ({
    view: vi.fn(async () => ({ name })), waiting: vi.fn(async () => ({ name })), start: vi.fn(async () => ({ name })),
    restart: vi.fn(async () => ({ name })), login: vi.fn(async () => ({ name })), update: vi.fn(async () => ({ name })),
  });
  const claude = service('claude');
  const codex = service('codex');
  const app = createApp({ resolveCaller: () => ({ sub: 'user-1' }), nativeClaude: claude as never, nativeCodex: codex as never });

  it('serves Claude under claude-subscription exactly as before, and Codex under codex-subscription', async () => {
    expect(await (await app.request('/api/v1/installations/55/claude-subscription')).json()).toEqual({ name: 'claude' });
    expect(await (await app.request('/api/v1/installations/55/codex-subscription')).json()).toEqual({ name: 'codex' });
    const login = await app.request('/api/v1/installations/55/codex-subscription/login', { method: 'POST' });
    expect(login.headers.get('cache-control')).toBe('no-store');
    expect(codex.login).toHaveBeenCalledWith({ sub: 'user-1' }, 55);
    expect(claude.login).not.toHaveBeenCalled();
    const put = await app.request('/api/v1/installations/55/codex-subscription', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, triggers: [{ repositoryId: 9, repository: 'acme/web', label: 'updraft' }] }) });
    expect(put.status).toBe(200);
    expect(codex.update).toHaveBeenCalledWith({ sub: 'user-1' }, 55, true, [{ repositoryId: 9, repository: 'acme/web', label: 'updraft' }]);
    expect(claude.update).not.toHaveBeenCalled();
    expect((await app.request('/api/v1/installations/55/codex-subscription/requests/not-a-job')).status).toBe(404);
  });

  it('has no Codex routes where no Codex session is deployed', async () => {
    const claudeOnly = createApp({ resolveCaller: () => ({ sub: 'user-1' }), nativeClaude: claude as never });
    expect((await claudeOnly.request('/api/v1/installations/55/codex-subscription')).status).toBe(404);
  });
});
