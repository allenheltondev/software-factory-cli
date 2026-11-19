import { describe, expect, it } from 'vitest';
import { signBody, verifySignature } from '../github/signature.js';
import type { AppSettings } from '../github/settings.js';
import { createMemoryStore, type Tenant } from '../store/store.js';
import { createWebhookHandler, RETENTION_MS } from './webhook.js';

const SETTINGS = { webhookSecret: 'hook-secret' } as AppSettings;
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

async function setup() {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant, { installationId: 55, sub: 'sub-pat', role: 'owner', githubLogin: 'pat', addedAt: tenant.createdAt });
  const handle = createWebhookHandler({ store, loadSettings: async () => SETTINGS, now: () => NOW, log: () => {} });
  const deliver = (event: string, payload: unknown, secret = SETTINGS.webhookSecret) => {
    const body = JSON.stringify(payload);
    return handle({ body, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': 'd1', 'X-Hub-Signature-256': signBody(body, secret) } });
  };
  return { store, handle, deliver };
}

describe('verifySignature', () => {
  it('accepts the right signature only', () => {
    const body = '{"a":1}';
    expect(verifySignature(body, signBody(body, 's'), 's')).toBe(true);
    expect(verifySignature(body, signBody(body, 'other'), 's')).toBe(false);
    expect(verifySignature(`${body} `, signBody(body, 's'), 's')).toBe(false);
    expect(verifySignature(body, 'sha256=xyz', 's')).toBe(false);
    expect(verifySignature(body, undefined, 's')).toBe(false);
    expect(verifySignature(body, signBody(body, ''), '')).toBe(false);
  });
});

describe('webhook', () => {
  it('refuses a bad signature before reading anything', async () => {
    const { deliver, store } = await setup();
    const res = await deliver('installation', { action: 'deleted', installation: { id: 55 } }, 'wrong');
    expect(res.status).toBe(401);
    expect((await store.getTenant(55))?.status).toBe('active');
  });

  it('answers 503 until the App is registered', async () => {
    const store = createMemoryStore();
    const handle = createWebhookHandler({ store, loadSettings: async () => null, log: () => {} });
    expect((await handle({ body: '{}', headers: {} })).status).toBe(503);
  });

  it('disables an uninstalled tenant and schedules its deletion', async () => {
    const { deliver, store } = await setup();
    const res = await deliver('installation', { action: 'deleted', installation: { id: 55 } });
    expect(res.body.disposition).toBe('tenant_uninstalled');
    expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'uninstalled', deleteAfter: NOW + RETENTION_MS });
  });

  it('suspends and unsuspends', async () => {
    const { deliver, store } = await setup();
    await deliver('installation', { action: 'suspend', installation: { id: 55 } });
    expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'suspended' });
    await deliver('installation', { action: 'unsuspend', installation: { id: 55 } });
    const t = await store.getTenant(55);
    expect(t?.status).toBe('active');
    expect(t?.disabledReason).toBeUndefined();
  });

  it('does not revive an uninstalled tenant on unsuspend', async () => {
    const { deliver, store } = await setup();
    await deliver('installation', { action: 'deleted', installation: { id: 55 } });
    await deliver('installation', { action: 'unsuspend', installation: { id: 55 } });
    expect((await store.getTenant(55))?.status).toBe('disabled');
  });

  it('creates nothing for an installation that was never onboarded', async () => {
    const { deliver, store } = await setup();
    const res = await deliver('installation', { action: 'created', installation: { id: 66 } });
    expect(res.body.disposition).toBe('ignored');
    expect((await deliver('installation', { action: 'suspend', installation: { id: 66 } })).body.disposition).toBe('no_tenant');
    expect(await store.getTenant(66)).toBeNull();
  });

  it('answers ping and acknowledges other events without acting', async () => {
    const { deliver } = await setup();
    expect((await deliver('ping', { zen: 'hi' })).body.disposition).toBe('pong');
    expect((await deliver('issues', { action: 'labeled', installation: { id: 55 } })).body).toEqual({ ok: true, disposition: 'ignored' });
  });

  it('rejects a signed body that is not JSON', async () => {
    const { handle } = await setup();
    const body = 'not json';
    const res = await handle({ body, headers: { 'x-github-event': 'installation', 'x-hub-signature-256': signBody(body, 'hook-secret') } });
    expect(res.status).toBe(400);
  });
});
