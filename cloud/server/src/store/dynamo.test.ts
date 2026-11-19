import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createDynamoStore } from './dynamo.js';
import type { Member, Tenant } from './store.js';

/**
 * The real DynamoDB store against a stand-in document client: an in-memory table that understands
 * exactly the expressions the store sends (and throws on anything else, so a new one gets added
 * here deliberately). `failWhen` makes chosen writes fail, as a throttle or a timeout would.
 */
type Item = Record<string, unknown>;
type Values = Record<string, unknown>;

function fakeTable() {
  const items = new Map<string, Item>();
  const key = (k: Item) => `${String(k.pk)}|${String(k.sk)}`;
  let failWhen: ((name: string, input: Item) => boolean) | null = null;
  /** Written, but not yet visible to an eventually consistent read. */
  const hidden = new Set<string>();
  const visible = (k: string, input: Item) => input.ConsistentRead === true || !hidden.has(k);

  function condition(expr: string | undefined, item: Item | undefined, values: Values = {}): boolean {
    if (!expr) return true;
    if (expr === 'attribute_not_exists(pk)') return !item;
    if (expr === 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)') {
      return Boolean(item) && (item!.disabledReason === undefined || item!.disabledReason !== values[':uninstalled']);
    }
    if (expr === 'attribute_not_exists(pk) OR #sub = :sub') return !item || item.sub === values[':sub'];
    if (expr === 'attribute_not_exists(githubUserId) OR githubUserId = :id') return !item || item.githubUserId === undefined || item.githubUserId === values[':id'];
    throw new Error(`fake table: unsupported condition ${expr}`);
  }

  function update(item: Item, expr: string, names: Record<string, string> = {}, values: Values = {}): Item {
    const next = { ...item };
    const name = (n: string) => names[n] ?? n;
    const [, setPart = '', removePart = ''] = /^(?:SET (.*?))?(?: ?REMOVE (.*))?$/.exec(expr) ?? [];
    for (const assignment of setPart.split(',').map((a) => a.trim()).filter(Boolean)) {
      const [lhs, rhs] = assignment.split('=').map((x) => x.trim());
      next[name(lhs!)] = values[rhs!];
    }
    for (const attr of removePart.split(',').map((a) => a.trim()).filter(Boolean)) delete next[name(attr)];
    return next;
  }

  const ccf = () => new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

  const client = {
    async send(command: { constructor: { name: string }; input: Item }) {
      const name = command.constructor.name;
      const input = command.input;
      if (failWhen?.(name, input)) throw new Error(`injected failure: ${name}`);
      const values = input.ExpressionAttributeValues as Values | undefined;
      switch (name) {
        case 'GetCommand': {
          const k = key(input.Key as Item);
          return { Item: visible(k, input) ? items.get(k) : undefined };
        }
        case 'PutCommand': {
          const item = input.Item as Item;
          if (!condition(input.ConditionExpression as string, items.get(key(item)), values)) throw ccf();
          items.set(key(item), { ...item });
          return {};
        }
        case 'UpdateCommand': {
          const k = key(input.Key as Item);
          const existing = items.get(k);
          if (!condition(input.ConditionExpression as string, existing, values)) throw ccf();
          items.set(k, update(existing ?? { ...(input.Key as Item) }, String(input.UpdateExpression), input.ExpressionAttributeNames as Record<string, string>, values));
          return {};
        }
        case 'DeleteCommand': {
          const k = key(input.Key as Item);
          const old = items.get(k);
          items.delete(k);
          return { Attributes: input.ReturnValues === 'ALL_OLD' ? old : undefined };
        }
        case 'QueryCommand': {
          if (input.IndexName) {
            const pk = values?.[':pk'];
            return { Items: [...items.values()].filter((i) => i.GSI1PK === pk && String(i.GSI1SK).startsWith(String(values?.[':prefix']))) };
          }
          const pk = values?.[':pk'];
          return {
            Items: [...items.values()]
              .filter((i) => i.pk === pk && visible(key(i), input))
              .map((i) => ({ pk: i.pk, sk: i.sk, ttl: i.ttl })),
          };
        }
        case 'TransactWriteCommand': {
          const ops = input.TransactItems as Item[];
          const reasons = ops.map((op) => {
            const [kind, body] = Object.entries(op)[0] as [string, Item];
            const target = kind === 'Put' ? (body.Item as Item) : (body.Key as Item);
            const ok = condition(body.ConditionExpression as string, items.get(key(target)), body.ExpressionAttributeValues as Values);
            return { Code: ok ? 'None' : 'ConditionalCheckFailed' };
          });
          if (reasons.some((r) => r.Code !== 'None')) {
            throw new TransactionCanceledException({ message: 'Transaction cancelled', $metadata: {}, CancellationReasons: reasons });
          }
          for (const op of ops) {
            const [kind, body] = Object.entries(op)[0] as [string, Item];
            if (kind === 'Put') items.set(key(body.Item as Item), { ...(body.Item as Item) });
            if (kind === 'Delete') items.delete(key(body.Key as Item));
            if (kind === 'Update') {
              const k = key(body.Key as Item);
              items.set(k, update(items.get(k) ?? { ...(body.Key as Item) }, String(body.UpdateExpression), body.ExpressionAttributeNames as Record<string, string>, body.ExpressionAttributeValues as Values));
            }
          }
          return {};
        }
        default:
          throw new Error(`fake table: unsupported command ${name}`);
      }
    },
  };

  return {
    client: client as unknown as DynamoDBDocumentClient,
    items,
    fail(fn: ((name: string, input: Item) => boolean) | null) {
      failWhen = fn;
    },
    hideFromEventual(k: string) {
      hidden.add(k);
    },
  };
}

const tenant: Tenant = {
  installationId: 55,
  accountId: 900,
  accountLogin: 'acme',
  accountType: 'Organization',
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 'sub-a',
};
const member = (sub: string): Member => ({ installationId: 55, sub, role: 'owner', githubUserId: 1, githubLogin: sub, addedAt: tenant.createdAt });
const DEADLINE = Date.UTC(2026, 11, 19);
const TTL = Math.ceil(DEADLINE / 1000);

async function seeded() {
  const table = fakeTable();
  const store = createDynamoStore('T', table.client);
  await store.putTenantWithMember(tenant, member('sub-a'));
  await store.putTenantWithMember(tenant, member('sub-b'));
  const memberTtls = () => ['sub-a', 'sub-b'].map((s) => table.items.get(`TENANT#55|MEMBER#${s}`)?.ttl);
  return { table, store, memberTtls };
}

describe('dynamo store: uninstall', () => {
  it('marks the tenant and gives every row in its partition the TTL', async () => {
    const { store, table, memberTtls } = await seeded();
    expect(await store.markUninstalled(55, DEADLINE)).toBe('marked');
    expect(table.items.get('TENANT#55|META')).toMatchObject({ status: 'disabled', disabledReason: 'uninstalled', deleteAfter: DEADLINE, ttl: TTL });
    expect(memberTtls()).toEqual([TTL, TTL]);
  });

  it('a sweep cut short is completed by the next delivery, with the first deadline', async () => {
    const { store, table, memberTtls } = await seeded();
    // The first member write fails (a throttle, a timeout): the tenant is marked, the sweep is not done.
    table.fail((name, input) => name === 'UpdateCommand' && String((input.Key as Item).sk).startsWith('MEMBER#'));
    await expect(store.markUninstalled(55, DEADLINE)).rejects.toThrow(/injected failure/);
    expect(table.items.get('TENANT#55|META')?.disabledReason).toBe('uninstalled');
    expect(memberTtls()).toEqual([undefined, undefined]);

    // GitHub redelivers the delete later; its own deadline would be later, the stored one wins.
    table.fail(null);
    expect(await store.markUninstalled(55, DEADLINE + 3 * 24 * 60 * 60 * 1000)).toBe('already');
    expect(memberTtls()).toEqual([TTL, TTL]);
    expect(table.items.get('TENANT#55|META')).toMatchObject({ deleteAfter: DEADLINE, ttl: TTL });
  });

  it('a partial sweep resumes where it left off', async () => {
    const { store, table, memberTtls } = await seeded();
    let writes = 0;
    table.fail((name, input) => name === 'UpdateCommand' && String((input.Key as Item).sk).startsWith('MEMBER#') && ++writes === 2);
    await expect(store.markUninstalled(55, DEADLINE)).rejects.toThrow();
    expect(memberTtls().filter((t) => t === TTL)).toHaveLength(1);
    table.fail(null);
    await store.markUninstalled(55, DEADLINE);
    expect(memberTtls()).toEqual([TTL, TTL]);
  });

  it('records a tombstone for a tenant it does not know, which no member can join', async () => {
    const { store, table } = await seeded();
    expect(await store.markUninstalled(66, DEADLINE, { id: 7, login: 'late', type: 'User' })).toBe('tombstone');
    expect(table.items.get('TENANT#66|META')).toMatchObject({ disabledReason: 'uninstalled', deleteAfter: DEADLINE, ttl: TTL, accountLogin: 'late' });
    const late = { ...tenant, installationId: 66 };
    expect(await store.putTenantWithMember(late, { ...member('sub-c'), installationId: 66 })).toBe('uninstalled');
    expect(table.items.get('TENANT#66|META')?.status).toBe('disabled');
    expect(table.items.has('TENANT#66|MEMBER#sub-c')).toBe(false);
  });

  it('finds a member an eventually consistent query would still miss', async () => {
    const { store, table, memberTtls } = await seeded();
    table.hideFromEventual('TENANT#55|MEMBER#sub-b'); // committed just before the uninstall
    expect(await store.markUninstalled(55, DEADLINE)).toBe('marked');
    expect(memberTtls()).toEqual([TTL, TTL]);
  });

  it('reads the stored deadline strongly on a replay', async () => {
    const { store, table, memberTtls } = await seeded();
    table.fail((name, input) => name === 'UpdateCommand' && String((input.Key as Item).sk).startsWith('MEMBER#'));
    await expect(store.markUninstalled(55, DEADLINE)).rejects.toThrow();
    table.fail(null);
    table.hideFromEventual('TENANT#55|META'); // a stale read would not see the uninstall yet
    expect(await store.markUninstalled(55, DEADLINE + 1000)).toBe('already');
    expect(memberTtls()).toEqual([TTL, TTL]);
  });

  it('adds no member to an uninstalled tenant, so none escapes the TTL', async () => {
    const { store, table } = await seeded();
    await store.markUninstalled(55, DEADLINE);
    expect(await store.putTenantWithMember(tenant, member('sub-c'))).toBe('uninstalled');
    expect(table.items.has('TENANT#55|MEMBER#sub-c')).toBe(false);
  });

  it('suspend and unsuspend never overwrite an uninstall', async () => {
    const { store, table } = await seeded();
    await store.markUninstalled(55, DEADLINE);
    expect(await store.setSuspended(55, true)).toBe('uninstalled');
    expect(await store.setSuspended(55, false)).toBe('uninstalled');
    expect(table.items.get('TENANT#55|META')).toMatchObject({ disabledReason: 'uninstalled', deleteAfter: DEADLINE });
  });
});

describe('dynamo store: identities and offers', () => {
  it('links one identity per user and removes the offer on unlink', async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    const link = { githubUserId: 7, githubLogin: 'pat', linkedAt: 'now' };
    expect(await store.link('sub-a', link)).toBe('linked');
    expect(await store.link('sub-b', link)).toBe('taken');
    expect(await store.link('sub-a', { ...link, githubUserId: 8 })).toBe('relink');
    await store.putOffer({ sub: 'sub-a', githubUserId: 7, githubLogin: 'pat', installations: [], expiresAt: DEADLINE });
    expect(await store.getOffer('sub-a')).toMatchObject({ githubUserId: 7 });
    await store.unlink('sub-a');
    expect(await store.getLink('sub-a')).toBeNull();
    expect(await store.getOffer('sub-a')).toBeNull();
    expect(await store.link('sub-b', link)).toBe('linked');
  });

  it('keeps the GitHub identity on memberships and lists them by user', async () => {
    const { store } = await seeded();
    expect(await store.listMemberships('sub-a')).toEqual([member('sub-a')]);
  });
});
