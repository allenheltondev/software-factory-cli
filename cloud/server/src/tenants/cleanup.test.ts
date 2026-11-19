import { describe, expect, it } from 'vitest';
import { createMemoryStore, type Tenant } from '../store/store.js';
import { agentKeySecretName } from './agent-keys.js';
import { runCleanup, tenantPrefix } from './cleanup.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 11, 19);
const tenant = (installationId: number): Tenant => ({
  installationId,
  accountId: installationId * 10,
  accountLogin: `acct${installationId}`,
  accountType: 'Organization',
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 'sub-pat',
});

async function setup() {
  const store = createMemoryStore();
  const objects = new Set<string>();
  const secrets = new Set<string>();
  for (const id of [55, 66, 77]) {
    await store.putTenantWithMember(tenant(id), { installationId: id, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    objects.add(`${tenantPrefix(id)}config/1/config.yaml`);
    objects.add(`${tenantPrefix(id)}config/1/prompts/p.md`);
    secrets.add(agentKeySecretName(id, 'ANTHROPIC_API_KEY'));
  }
  const fail = { deleteObjects: false };
  const deps = {
    store,
    listObjects: async (prefix: string) => [...objects].filter((k) => k.startsWith(prefix)),
    deleteObjects: async (keys: string[]) => {
      if (fail.deleteObjects) throw new Error('S3 throttled');
      expect(keys.length).toBeLessThanOrEqual(1000);
      for (const k of keys) objects.delete(k);
    },
    secrets: { remove: async (name: string) => void secrets.delete(name) },
    now: () => NOW,
    log: () => {},
  };
  return { store, objects, secrets, deps, fail };
}

describe('runCleanup', () => {
  it('deletes the S3 prefix and key secrets of uninstalled tenants past their deadline, and only those', async () => {
    const { store, objects, secrets, deps } = await setup();
    await store.markUninstalled(55, NOW - DAY); // due
    await store.markUninstalled(66, NOW + DAY); // not yet
    // 77 stays installed.
    expect(await runCleanup(deps)).toEqual({ cleaned: [55], failed: [] });
    expect([...objects].some((k) => k.startsWith(tenantPrefix(55)))).toBe(false);
    expect(secrets.has(agentKeySecretName(55, 'ANTHROPIC_API_KEY'))).toBe(false);
    expect([...objects].filter((k) => k.startsWith(tenantPrefix(66)))).toHaveLength(2);
    expect([...objects].filter((k) => k.startsWith(tenantPrefix(77)))).toHaveLength(2);
    expect(secrets.has(agentKeySecretName(66, 'ANTHROPIC_API_KEY'))).toBe(true);
    // Done: nothing left to do for 55.
    expect(await store.listDueCleanups(NOW)).toEqual([]);
  });

  it('keeps the entry when a deletion fails, so the next run finishes it', async () => {
    const { store, objects, deps, fail } = await setup();
    await store.markUninstalled(55, NOW - DAY);
    fail.deleteObjects = true;
    expect(await runCleanup(deps)).toMatchObject({ cleaned: [], failed: [{ installationId: 55, error: 'S3 throttled' }] });
    expect(await store.listDueCleanups(NOW)).toEqual([{ installationId: 55, deleteAfter: NOW - DAY }]);
    fail.deleteObjects = false;
    expect(await runCleanup(deps)).toEqual({ cleaned: [55], failed: [] });
    expect([...objects].some((k) => k.startsWith(tenantPrefix(55)))).toBe(false);
  });

  it("also removes the tenant's rows still in the table at the deadline", async () => {
    const { store, deps } = await setup();
    await store.markUninstalled(55, NOW - DAY);
    expect(await store.getMember(55, 's')).not.toBeNull();
    await runCleanup(deps);
    expect(await store.getTenant(55)).toBeNull();
    expect(await store.getMember(55, 's')).toBeNull();
    expect(await store.getTenant(66)).not.toBeNull();
  });

  it('also cleans up after a tombstone (a delete for a tenant that never existed)', async () => {
    const { store, deps } = await setup();
    await store.markUninstalled(99, NOW - DAY);
    expect(await runCleanup(deps)).toEqual({ cleaned: [99], failed: [] });
  });

  it('deletes in batches S3 accepts', async () => {
    const { store, objects, deps } = await setup();
    for (let i = 0; i < 2500; i++) objects.add(`${tenantPrefix(55)}results/${i}.json`);
    await store.markUninstalled(55, NOW - DAY);
    await runCleanup(deps);
    expect([...objects].some((k) => k.startsWith(tenantPrefix(55)))).toBe(false);
  });
});
