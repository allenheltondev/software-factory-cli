import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { GitHubError, type GitHubApi, type GitHubInstallation, type OrgMembership } from '../github/client.js';
import type { AppSettings } from '../github/settings.js';
import { createMemoryStore } from '../store/store.js';
import { signBody } from '../github/signature.js';
import { createGitHubFlows, STATE_TTL_MS } from './github.js';
import { createWebhookHandler } from './webhook.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SETTINGS: AppSettings = {
  appId: '123',
  clientId: 'Iv1.client',
  slug: 'updraft-test',
  appUrl: 'https://updraft.example',
  privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  clientSecret: 'client-secret',
  webhookSecret: 'hook-secret',
};

const PAT: Caller = { sub: 'sub-pat' };
const SAM: Caller = { sub: 'sub-sam' };

/** A GitHub where codes map to users, and installations, memberships and repos are set per test. */
function fakeGitHub() {
  const codes = new Map<string, { token: string; user: { id: number; login: string }; verifier?: string }>();
  const userInstallations = new Map<string, number[]>();
  const installations = new Map<number, GitHubInstallation>();
  const memberships = new Map<string, OrgMembership>();
  const calls: string[] = [];
  const api: GitHubApi = {
    async exchangeCode({ code, codeVerifier, clientSecret }) {
      calls.push(`exchange:${code}`);
      const c = codes.get(code);
      if (!c || clientSecret !== SETTINGS.clientSecret) throw new GitHubError(400, 'bad code');
      if (c.verifier && c.verifier !== codeVerifier) throw new GitHubError(400, 'bad verifier');
      codes.delete(code); // codes are single use on GitHub too
      return c.token;
    },
    async getUser(token) {
      for (const c of [...codes.values(), ...issued]) if (c.token === token) return c.user;
      throw new GitHubError(401, 'bad token');
    },
    async listUserInstallationIds(token) {
      return userInstallations.get(token) ?? [];
    },
    async getOrgMembership(token, org) {
      return memberships.get(`${token}/${org}`) ?? null;
    },
    async getInstallation(jwt, id) {
      expect(jwt.split('.')).toHaveLength(3);
      return installations.get(id) ?? null;
    },
    async createInstallationToken() {
      return { token: 'inst-token', expiresAt: Date.now() + 60 * 60 * 1000 };
    },
    async getBotUser(_token, slug) {
      return { id: 777, login: `${slug}[bot]` };
    },
    async listInstallationRepositories(token) {
      expect(token).toBe('inst-token');
      return [
        { id: 2, fullName: 'acme/web', private: true, htmlUrl: 'https://github.com/acme/web' },
        { id: 1, fullName: 'acme/api', private: false, htmlUrl: 'https://github.com/acme/api' },
      ];
    },
  };
  const issued: { token: string; user: { id: number; login: string } }[] = [];
  return {
    api,
    calls,
    userInstallations,
    installations,
    memberships,
    /** GitHub hands the browser this code after authorizing as `user`. */
    code(code: string, user: { id: number; login: string }, verifier?: string) {
      const token = `token-${code}`;
      codes.set(code, { token, user, ...(verifier ? { verifier } : {}) });
      issued.push({ token, user });
      return token;
    },
  };
}

const PAT_GH = { id: 101, login: 'pat' };
const SAM_GH = { id: 202, login: 'sam' };

describe('GitHub flows', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let gh: ReturnType<typeof fakeGitHub>;
  let clock: number;
  let flows: ReturnType<typeof createGitHubFlows>;
  let n = 0;

  beforeEach(() => {
    store = createMemoryStore();
    gh = fakeGitHub();
    clock = Date.UTC(2026, 10, 19);
    flows = createGitHubFlows({ store, github: gh.api, loadSettings: async () => SETTINGS, now: () => clock, randomToken: () => `rnd${++n}` });
  });

  async function startedLink(caller: Caller) {
    const { url } = await flows.startLink(caller);
    const u = new URL(url);
    return { state: u.searchParams.get('state')!, verifier: `rnd${n - 1}`, url: u };
  }

  async function startedInstall(caller: Caller) {
    const { url } = await flows.startInstall(caller);
    return new URL(url).searchParams.get('state')!;
  }

  describe('linking', () => {
    it('sends the browser to GitHub with PKCE and the callback URL, and links on return', async () => {
      const { state, verifier, url } = await startedLink(PAT);
      expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(url.searchParams.get('redirect_uri')).toBe('https://updraft.example/github/callback');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).not.toBe(verifier);

      gh.code('c1', PAT_GH, verifier);
      await expect(flows.completeCallback(PAT, { code: 'c1', state })).resolves.toEqual({ kind: 'linked', githubLogin: 'pat', installations: [] });
      expect(await store.getLink(PAT.sub)).toMatchObject({ githubUserId: 101, githubLogin: 'pat' });
    });

    it('refuses a replayed state', async () => {
      const { state, verifier } = await startedLink(PAT);
      gh.code('c1', PAT_GH, verifier);
      await flows.completeCallback(PAT, { code: 'c1', state });
      gh.code('c2', PAT_GH, verifier);
      await expect(flows.completeCallback(PAT, { code: 'c2', state })).rejects.toMatchObject({ code: 'state_invalid' });
    });

    it('refuses a state issued to another user, and burns it', async () => {
      const { state, verifier } = await startedLink(SAM);
      gh.code('c1', PAT_GH, verifier);
      await expect(flows.completeCallback(PAT, { code: 'c1', state })).rejects.toMatchObject({ code: 'state_invalid' });
      await expect(flows.completeCallback(SAM, { code: 'c1', state })).rejects.toMatchObject({ code: 'state_invalid' });
      expect(gh.calls).toEqual([]); // GitHub was never asked
    });

    it('refuses a missing, unknown or expired state', async () => {
      await expect(flows.completeCallback(PAT, { code: 'c' })).rejects.toMatchObject({ code: 'state_invalid', status: 400 });
      await expect(flows.completeCallback(PAT, { code: 'c', state: 'made-up' })).rejects.toMatchObject({ code: 'state_invalid' });
      const { state, verifier } = await startedLink(PAT);
      gh.code('c1', PAT_GH, verifier);
      clock += STATE_TTL_MS + 1;
      await expect(flows.completeCallback(PAT, { code: 'c1', state })).rejects.toMatchObject({ code: 'state_invalid' });
    });

    it('refuses a code GitHub will not exchange (PKCE verifier mismatch)', async () => {
      const { state } = await startedLink(PAT);
      gh.code('c1', PAT_GH, 'some-other-verifier');
      await expect(flows.completeCallback(PAT, { code: 'c1', state })).rejects.toMatchObject({ code: 'github_exchange_failed' });
    });

    it('links one GitHub identity to one RSC user only', async () => {
      const a = await startedLink(PAT);
      gh.code('c1', PAT_GH, a.verifier);
      await flows.completeCallback(PAT, { code: 'c1', state: a.state });
      const b = await startedLink(SAM);
      gh.code('c2', PAT_GH, b.verifier);
      await expect(flows.completeCallback(SAM, { code: 'c2', state: b.state })).rejects.toMatchObject({ code: 'github_identity_taken' });
    });

    it('refuses a different identity until unlinked, then relinks', async () => {
      const a = await startedLink(PAT);
      gh.code('c1', PAT_GH, a.verifier);
      await flows.completeCallback(PAT, { code: 'c1', state: a.state });
      const b = await startedLink(PAT);
      gh.code('c2', SAM_GH, b.verifier);
      await expect(flows.completeCallback(PAT, { code: 'c2', state: b.state })).rejects.toMatchObject({ code: 'github_account_mismatch' });

      await flows.unlink(PAT);
      const c = await startedLink(PAT);
      gh.code('c3', SAM_GH, c.verifier);
      await expect(flows.completeCallback(PAT, { code: 'c3', state: c.state })).resolves.toMatchObject({ githubLogin: 'sam' });
    });
  });

  describe('installation onboarding', () => {
    const orgInstall = (id: number, login = 'acme'): GitHubInstallation => ({
      id,
      account: { id: 900, login, type: 'Organization' },
      suspendedAt: null,
    });

    it('onboards an org installation for an org admin as owner', async () => {
      const state = await startedInstall(PAT);
      const token = gh.code('i1', PAT_GH);
      gh.userInstallations.set(token, [55]);
      gh.installations.set(55, orgInstall(55));
      gh.memberships.set(`${token}/acme`, { role: 'admin', state: 'active' });

      await expect(flows.completeCallback(PAT, { code: 'i1', state, installationId: '55', setupAction: 'install' })).resolves.toEqual({
        kind: 'installed',
        githubLogin: 'pat',
        installationId: 55,
        accountLogin: 'acme',
      });
      expect(await store.getMember(55, PAT.sub)).toMatchObject({ role: 'owner', githubLogin: 'pat' });
      const status = await flows.status(PAT);
      expect(status.linked).toMatchObject({ githubLogin: 'pat' });
      expect(status.tenants).toEqual([{ installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' }]);
    });

    it('refuses an installation id the GitHub user cannot access (a forged query parameter)', async () => {
      const state = await startedInstall(PAT);
      const token = gh.code('i1', PAT_GH);
      gh.userInstallations.set(token, [55]);
      gh.installations.set(66, orgInstall(66, 'victim'));
      await expect(flows.completeCallback(PAT, { code: 'i1', state, installationId: '66' })).rejects.toMatchObject({
        code: 'installation_not_found',
      });
      expect(await store.getTenant(66)).toBeNull();
    });

    it('refuses an installation of another App', async () => {
      const state = await startedInstall(PAT);
      const token = gh.code('i1', PAT_GH);
      gh.userInstallations.set(token, [77]);
      await expect(flows.completeCallback(PAT, { code: 'i1', state, installationId: '77' })).rejects.toMatchObject({
        code: 'installation_not_found',
      });
    });

    it('refuses an org member who is not an admin', async () => {
      const state = await startedInstall(PAT);
      const token = gh.code('i1', PAT_GH);
      gh.userInstallations.set(token, [55]);
      gh.installations.set(55, orgInstall(55));
      gh.memberships.set(`${token}/acme`, { role: 'member', state: 'active' });
      await expect(flows.completeCallback(PAT, { code: 'i1', state, installationId: '55' })).rejects.toMatchObject({
        code: 'not_authorized',
        status: 403,
      });
      expect(await store.getTenant(55)).toBeNull();
    });

    it('refuses a pending org admin, and a non-member', async () => {
      for (const [i, membership] of [{ role: 'admin', state: 'pending' }, null].entries()) {
        const state = await startedInstall(PAT);
        const token = gh.code(`p${i}`, PAT_GH);
        gh.userInstallations.set(token, [55]);
        gh.installations.set(55, orgInstall(55));
        if (membership) gh.memberships.set(`${token}/acme`, membership);
        await expect(flows.completeCallback(PAT, { code: `p${i}`, state, installationId: '55' })).rejects.toMatchObject({
          code: 'not_authorized',
        });
      }
    });

    it('onboards a user-account installation only for that account', async () => {
      const userInstall: GitHubInstallation = { id: 88, account: { id: SAM_GH.id, login: 'sam', type: 'User' }, suspendedAt: null };
      const state = await startedInstall(PAT);
      const token = gh.code('i1', PAT_GH);
      gh.userInstallations.set(token, [88]); // pat can see sam's installation (a collaborator), but it is not pat's
      gh.installations.set(88, userInstall);
      await expect(flows.completeCallback(PAT, { code: 'i1', state, installationId: '88' })).rejects.toMatchObject({ code: 'not_authorized' });

      const state2 = await startedInstall(SAM);
      const token2 = gh.code('i2', SAM_GH);
      gh.userInstallations.set(token2, [88]);
      await expect(flows.completeCallback(SAM, { code: 'i2', state: state2, installationId: '88' })).resolves.toMatchObject({
        kind: 'installed',
        accountLogin: 'sam',
      });
    });

    it('refuses an install by a GitHub account other than the linked one', async () => {
      const a = await startedLink(PAT);
      gh.code('c1', PAT_GH, a.verifier);
      await flows.completeCallback(PAT, { code: 'c1', state: a.state });
      const state = await startedInstall(PAT);
      gh.code('i1', SAM_GH);
      await expect(flows.completeCallback(PAT, { code: 'i1', state, installationId: '55' })).rejects.toMatchObject({
        code: 'github_account_mismatch',
      });
    });

    it('treats an install request (org member, needs owner approval) as linked, nothing onboarded', async () => {
      const state = await startedInstall(PAT);
      gh.code('i1', PAT_GH);
      await expect(flows.completeCallback(PAT, { code: 'i1', state, setupAction: 'request' })).resolves.toEqual({
        kind: 'requested',
        githubLogin: 'pat',
      });
      expect((await flows.status(PAT)).tenants).toEqual([]);
    });

    it('a link state cannot finish an install, and a link code needs its verifier', async () => {
      const { state } = await startedLink(PAT);
      const token = gh.code('i1', PAT_GH, 'link-verifier');
      gh.userInstallations.set(token, [55]);
      await expect(flows.completeCallback(PAT, { code: 'i1', state, installationId: '55' })).rejects.toMatchObject({
        code: 'github_exchange_failed',
      });
      expect(await store.getTenant(55)).toBeNull();
    });
  });

  describe('repositories', () => {
    async function onboarded() {
      const state = await startedInstall(PAT);
      const token = gh.code('i1', PAT_GH);
      gh.userInstallations.set(token, [55]);
      gh.installations.set(55, { id: 55, account: { id: 900, login: 'acme', type: 'Organization' }, suspendedAt: null });
      gh.memberships.set(`${token}/acme`, { role: 'admin', state: 'active' });
      await flows.completeCallback(PAT, { code: 'i1', state, installationId: '55' });
    }

    it('lists the installation\'s repositories for a member', async () => {
      await onboarded();
      const out = await flows.repositories(PAT, 55);
      expect(out.repositories.map((r) => r.fullName)).toEqual(['acme/api', 'acme/web']);
    });

    it('refuses a non-member, the same way as an unknown installation', async () => {
      await onboarded();
      await expect(flows.repositories(SAM, 55)).rejects.toMatchObject({ code: 'not_authorized', status: 403 });
      await expect(flows.repositories(SAM, 99)).rejects.toMatchObject({ code: 'not_authorized', status: 403 });
    });

    it('lists nothing for a disabled tenant', async () => {
      await onboarded();
      await store.setSuspended(55, true);
      expect((await flows.repositories(PAT, 55)).repositories).toEqual([]);
    });

    it('ends access when the GitHub identity that earned it is unlinked', async () => {
      await onboarded();
      await flows.unlink(PAT);
      await expect(flows.repositories(PAT, 55)).rejects.toMatchObject({ code: 'not_authorized', status: 403 });
      expect((await flows.status(PAT)).tenants).toEqual([]);
    });

    it('does not carry access over to a different GitHub identity linked later', async () => {
      await onboarded();
      await flows.unlink(PAT);
      const l = await startedLink(PAT);
      gh.code('relink', SAM_GH, l.verifier); // pat's RSC account now linked to @sam
      await flows.completeCallback(PAT, { code: 'relink', state: l.state });
      await expect(flows.repositories(PAT, 55)).rejects.toMatchObject({ code: 'not_authorized' });
      expect((await flows.status(PAT)).tenants).toEqual([]);
    });

    it('restores access when the same identity is linked again', async () => {
      await onboarded();
      await flows.unlink(PAT);
      const l = await startedLink(PAT);
      gh.code('again', PAT_GH, l.verifier);
      await flows.completeCallback(PAT, { code: 'again', state: l.state });
      expect((await flows.repositories(PAT, 55)).repositories).toHaveLength(2);
    });

    it('an uninstalled tenant shows as uninstalled until its deadline, then is gone', async () => {
      await onboarded();
      await store.markUninstalled(55, clock + 1000);
      expect((await flows.status(PAT)).tenants).toEqual([
        expect.objectContaining({ installationId: 55, status: 'disabled', disabledReason: 'uninstalled' }),
      ]);
      expect((await flows.repositories(PAT, 55)).repositories).toEqual([]);

      clock += 1001;
      expect((await flows.status(PAT)).tenants).toEqual([]);
      await expect(flows.repositories(PAT, 55)).rejects.toMatchObject({ code: 'not_authorized' });
    });
  });

  describe('connecting an existing installation', () => {
    const acme: GitHubInstallation = { id: 55, account: { id: 900, login: 'acme', type: 'Organization' }, suspendedAt: null };
    const other: GitHubInstallation = { id: 66, account: { id: 901, login: 'other', type: 'Organization' }, suspendedAt: null };

    /** pat links; GitHub lists acme (pat is an admin) and other (pat is only a member). */
    async function linkedWithInstallations() {
      const l = await startedLink(PAT);
      const token = gh.code('c1', PAT_GH, l.verifier);
      gh.userInstallations.set(token, [55, 66, 77]); // 77: not this App's
      gh.installations.set(55, acme);
      gh.installations.set(66, other);
      gh.memberships.set(`${token}/acme`, { role: 'admin', state: 'active' });
      gh.memberships.set(`${token}/other`, { role: 'member', state: 'active' });
      return flows.completeCallback(PAT, { code: 'c1', state: l.state });
    }

    it('linking offers only the installations the user has authority over', async () => {
      await expect(linkedWithInstallations()).resolves.toEqual({
        kind: 'linked',
        githubLogin: 'pat',
        installations: [{ installationId: 55, accountLogin: 'acme', accountType: 'Organization', connected: false }],
      });
    });

    it('connects an offered installation as owner, bound to the linked identity', async () => {
      await linkedWithInstallations();
      await expect(flows.connect(PAT, 55)).resolves.toEqual({ installationId: 55, accountLogin: 'acme' });
      expect(await store.getMember(55, PAT.sub)).toMatchObject({ role: 'owner', githubUserId: PAT_GH.id });
      expect((await flows.repositories(PAT, 55)).repositories).toHaveLength(2);
    });

    it('refuses an installation that was not offered', async () => {
      await linkedWithInstallations();
      await expect(flows.connect(PAT, 66)).rejects.toMatchObject({ code: 'not_authorized', status: 403 });
      await expect(flows.connect(PAT, 77)).rejects.toMatchObject({ code: 'not_authorized' });
      expect(await store.getTenant(66)).toBeNull();
    });

    it('refuses an expired offer, another user\'s offer, and an offer after unlinking', async () => {
      await linkedWithInstallations();
      await expect(flows.connect(SAM, 55)).rejects.toMatchObject({ code: 'offer_expired' });
      clock += 10 * 60 * 1000 + 1;
      await expect(flows.connect(PAT, 55)).rejects.toMatchObject({ code: 'offer_expired' });

      clock -= 10 * 60 * 1000 + 1;
      await flows.unlink(PAT);
      await expect(flows.connect(PAT, 55)).rejects.toMatchObject({ code: 'offer_expired' });
    });

    it('marks installations already connected', async () => {
      await linkedWithInstallations();
      await flows.connect(PAT, 55);
      const again = await linkedWithInstallations();
      expect(again.kind === 'linked' && again.installations).toEqual([expect.objectContaining({ installationId: 55, connected: true })]);
    });

    it('refuses an installation GitHub removed after offering it, creating no tenant (the review\'s case)', async () => {
      await linkedWithInstallations();
      gh.installations.delete(55); // uninstalled on GitHub; no tenant existed, so the webhook found nothing
      await expect(flows.connect(PAT, 55)).rejects.toMatchObject({ code: 'installation_not_found', status: 404 });
      expect(await store.getTenant(55)).toBeNull();
    });

    it('connects with the installation\'s current suspension, not the offer\'s', async () => {
      await linkedWithInstallations();
      gh.installations.set(55, { ...acme, suspendedAt: '2026-11-19T00:00:00Z' });
      await flows.connect(PAT, 55);
      expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'suspended' });
    });

    it('refuses an installation id that now belongs to another account', async () => {
      await linkedWithInstallations();
      gh.installations.set(55, { ...acme, account: { id: 999, login: 'someone-else', type: 'Organization' } });
      await expect(flows.connect(PAT, 55)).rejects.toMatchObject({ code: 'not_authorized' });
      expect(await store.getTenant(55)).toBeNull();
    });

    /** GitHub answers the installation check, then removes the App: its delete arrives before Updraft writes. */
    function deleteRightAfterTheCheck() {
      const handle = createWebhookHandler({ store, github: gh.api, loadSettings: async () => SETTINGS, now: () => clock, log: () => {} });
      const original = gh.api.getInstallation.bind(gh.api);
      const dispositions: string[] = [];
      gh.api.getInstallation = async (jwt, id) => {
        const current = await original(jwt, id);
        gh.installations.delete(id);
        const body = JSON.stringify({ action: 'deleted', installation: { id, account: { id: 900, login: 'acme', type: 'Organization' } } });
        const res = await handle({ body, headers: { 'x-github-event': 'installation', 'x-hub-signature-256': signBody(body, SETTINGS.webhookSecret) } });
        dispositions.push(res.body.disposition);
        return current;
      };
      return dispositions;
    }

    it('a delete delivered between the GitHub check and the first tenant write leaves no active tenant (the review\x27s case)', async () => {
      await linkedWithInstallations();
      const dispositions = deleteRightAfterTheCheck();
      await expect(flows.connect(PAT, 55)).rejects.toMatchObject({ code: 'tenant_disabled' });
      expect(dispositions).toEqual(['tombstone']);
      expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'uninstalled' });
      expect(await store.getMember(55, PAT.sub)).toBeNull();
      expect((await flows.status(PAT)).tenants).toEqual([]);
    });

    it('the same race on the first-install callback leaves no active tenant', async () => {
      const state = await startedInstall(PAT);
      const token = gh.code('i1', PAT_GH);
      gh.userInstallations.set(token, [55]);
      gh.installations.set(55, acme);
      gh.memberships.set(`${token}/acme`, { role: 'admin', state: 'active' });
      deleteRightAfterTheCheck();
      await expect(flows.completeCallback(PAT, { code: 'i1', state, installationId: '55' })).rejects.toMatchObject({ code: 'tenant_disabled' });
      expect(await store.getTenant(55)).toMatchObject({ disabledReason: 'uninstalled' });
      expect(await store.getMember(55, PAT.sub)).toBeNull();
    });

    it('refuses to connect an installation that was uninstalled', async () => {
      await linkedWithInstallations();
      await flows.connect(PAT, 55);
      await store.markUninstalled(55, clock + 1000);
      await linkedWithInstallations();
      await expect(flows.connect(PAT, 55)).rejects.toMatchObject({ code: 'tenant_disabled' });
    });
  });

  it('answers 503 until the App is registered', async () => {
    const unconfigured = createGitHubFlows({ store, github: gh.api, loadSettings: async () => null });
    await expect(unconfigured.startLink(PAT)).rejects.toMatchObject({ code: 'github_app_not_configured', status: 503 });
    expect(await unconfigured.status(PAT)).toEqual({ configured: false, linked: null, tenants: [] });
  });

  it('maps flow errors to HTTP through the app, without internals', async () => {
    const app = createApp({ resolveCaller: () => PAT, github: flows });
    const res = await app.request('/api/v1/github/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'x', state: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'state_invalid' });

    const started = await app.request('/api/v1/github/link', { method: 'POST' });
    expect((await started.json()) as { url: string }).toHaveProperty('url');
    expect((await app.request('/api/v1/installations/abc/repositories')).status).toBe(404);
  });
});
