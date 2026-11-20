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
    if (expr === 'attribute_exists(pk)') return Boolean(item);
    if (
      expr ===
      'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled) AND (attribute_not_exists(activeConfigVersion) OR activeConfigVersion < :v)'
    ) {
      return Boolean(item) && item!.disabledReason !== values[':uninstalled'] && (item!.activeConfigVersion === undefined || (item!.activeConfigVersion as number) < (values[':v'] as number));
    }
    if (expr === '#status = :ready') return item?.status === values[':ready'];
    if (expr === 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)') {
      return Boolean(item) && (item!.disabledReason === undefined || item!.disabledReason !== values[':uninstalled']);
    }
    if (expr === 'attribute_not_exists(pk) OR #sub = :sub') return !item || item.sub === values[':sub'];
    if (expr === 'attribute_not_exists(githubUserId) OR githubUserId = :id') return !item || item.githubUserId === undefined || item.githubUserId === values[':id'];
    if (expr === 'attribute_not_exists(pk) OR #ttl < :now') return !item || (item.ttl as number) < (values[':now'] as number);
    if (expr === 'attribute_exists(pk) AND #status <> :finished') return Boolean(item) && item!.status !== values[':finished'];
    if (expr === 'jobId = :job') return Boolean(item) && item!.jobId === values[':job'];
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
          if (!condition(input.ConditionExpression as string, old, values)) throw ccf();
          items.delete(k);
          return { Attributes: input.ReturnValues === 'ALL_OLD' ? old : undefined };
        }
        case 'QueryCommand': {
          if (input.IndexName) {
            const pk = values?.[':pk'];
            return { Items: [...items.values()].filter((i) => i.GSI1PK === pk && String(i.GSI1SK).startsWith(String(values?.[':prefix']))) };
          }
          const pk = values?.[':pk'];
          const prefix = String(input.KeyConditionExpression).includes('begins_with(sk, :prefix)') ? String(values?.[':prefix']) : '';
          const until = String(input.KeyConditionExpression).includes('sk <= :until') ? String(values?.[':until']) : null;
          let found = [...items.values()]
            .filter((i) => i.pk === pk && String(i.sk).startsWith(prefix) && (until === null || String(i.sk) <= until) && visible(key(i), input))
            .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
          if (input.ScanIndexForward === false) found.reverse();
          if (typeof input.Limit === 'number') found = found.slice(0, input.Limit);
          return { Items: input.ProjectionExpression ? found.map((i) => ({ pk: i.pk, sk: i.sk, ttl: i.ttl })) : found.map((i) => ({ ...i })) };
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

describe('dynamo store: config versions and agent keys', () => {
  const meta = { sha256: 'abc', files: ['config.yaml'], publishedBy: 'admin', publishedAt: '2026-11-19T00:00:00.000Z' };

  it('allocates versions that only grow, and activates only a ready one', async () => {
    const { store, table } = await seeded();
    expect(await store.createConfigVersion(55, meta)).toBe(1);
    expect(await store.createConfigVersion(55, meta)).toBe(2);
    expect(table.items.has('TENANT#55|CONFIG#0000000002')).toBe(true);
    expect(await store.activateConfig(55, 2)).toBe('not_ready');
    await store.markConfigReady(55, 2);
    expect(await store.activateConfig(55, 2)).toBe('activated');
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(2);
    expect((await store.listConfigVersions(55)).map((v) => [v.version, v.status])).toEqual([
      [1, 'pending'],
      [2, 'ready'],
    ]);
  });

  it('takes the next number when a concurrent publish claimed this one', async () => {
    const { store, table } = await seeded();
    await store.createConfigVersion(55, meta);
    // A concurrent publish claims 2 between this one's read and its claim: the claim fails, and 3 wins.
    let raced = false;
    table.fail((name) => {
      if (name === 'TransactWriteCommand' && !raced) {
        raced = true;
        table.items.set('TENANT#55|CONFIG#0000000002', { pk: 'TENANT#55', sk: 'CONFIG#0000000002', version: 2, status: 'pending' });
      }
      return false;
    });
    expect(await store.createConfigVersion(55, meta)).toBe(3);
    expect(raced).toBe(true);
  });

  it('neither allocates nor activates for an uninstalled tenant, and the version keeps the TTL sweep', async () => {
    const { store, table } = await seeded();
    const v = await store.createConfigVersion(55, meta);
    await store.markConfigReady(55, v as number);
    await store.markUninstalled(55, DEADLINE);
    expect(table.items.get('TENANT#55|CONFIG#0000000001')?.ttl).toBe(TTL);
    expect(await store.createConfigVersion(55, meta)).toBe('uninstalled');
    expect(await store.activateConfig(55, 1)).toBe('uninstalled');
    expect(await store.createConfigVersion(77, meta)).toBe('no_tenant');
  });

  it('records that an agent key is set, never its value', async () => {
    const { store } = await seeded();
    await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't2', updatedBy: 'admin' });
    await store.putAgentKeyMeta(55, { name: 'ANTHROPIC_API_KEY', updatedAt: 't1', updatedBy: 'admin' });
    expect(await store.listAgentKeyMeta(55)).toEqual([
      { name: 'ANTHROPIC_API_KEY', updatedAt: 't1', updatedBy: 'admin' },
      { name: 'CODEX_API_KEY', updatedAt: 't2', updatedBy: 'admin' },
    ]);
  });
});

describe('dynamo store: review fixes on #78', () => {
  const meta = { sha256: 'abc', files: ['config.yaml'], publishedBy: 'admin', publishedAt: 't' };

  it('never activates an older version after a newer one (superseded)', async () => {
    const { store } = await seeded();
    const v1 = (await store.createConfigVersion(55, meta)) as number;
    const v2 = (await store.createConfigVersion(55, meta)) as number;
    await store.markConfigReady(55, v2);
    expect(await store.activateConfig(55, v2)).toBe('activated');
    await store.markConfigReady(55, v1);
    expect(await store.activateConfig(55, v1)).toBe('superseded');
    expect((await store.getTenant(55))?.activeConfigVersion).toBe(v2);
    expect(await store.activateConfig(55, v2)).toBe('superseded');
  });

  it('refuses key metadata once the tenant is uninstalled', async () => {
    const { store, table } = await seeded();
    expect(await store.putAgentKeyMeta(55, { name: 'ANTHROPIC_API_KEY', updatedAt: 't', updatedBy: 'a' })).toBe('stored');
    await store.markUninstalled(55, DEADLINE);
    expect(table.items.get('TENANT#55|KEY#ANTHROPIC_API_KEY')?.ttl).toBe(TTL);
    expect(await store.putAgentKeyMeta(55, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'a' })).toBe('uninstalled');
    expect(table.items.has('TENANT#55|KEY#CODEX_API_KEY')).toBe(false);
    expect(await store.putAgentKeyMeta(77, { name: 'CODEX_API_KEY', updatedAt: 't', updatedBy: 'a' })).toBe('uninstalled');
  });

  it('records a cleanup entry for every uninstall (marked, repeated, tombstone), without a TTL, due at the deadline', async () => {
    const { store, table } = await seeded();
    await store.markUninstalled(55, DEADLINE);
    await store.markUninstalled(55, DEADLINE + 5000); // repeated: the first deadline
    await store.markUninstalled(66, DEADLINE + 10_000, { id: 1, login: 'x', type: 'User' }); // tombstone
    const entries = [...table.items.values()].filter((i) => i.pk === 'CLEANUP');
    expect(entries.map((e) => [e.installationId, e.deleteAfter, e.ttl])).toEqual([
      [55, DEADLINE, undefined],
      [66, DEADLINE + 10_000, undefined],
    ]);
    expect(await store.listDueCleanups(DEADLINE - 1)).toEqual([]);
    expect(await store.listDueCleanups(DEADLINE)).toEqual([{ installationId: 55, deleteAfter: DEADLINE }]);
    await store.completeCleanup({ installationId: 55, deleteAfter: DEADLINE });
    expect(await store.listDueCleanups(DEADLINE + 10_000)).toEqual([{ installationId: 66, deleteAfter: DEADLINE + 10_000 }]);
  });
});

describe('dynamo store: the uninstall and its cleanup entry are one transaction', () => {
  it('a sweep that fails part-way still leaves a due cleanup entry (the review case)', async () => {
    const { store, table } = await seeded();
    table.fail((name, input) => name === 'UpdateCommand' && String((input.Key as Item).sk).startsWith('MEMBER#'));
    await expect(store.markUninstalled(55, DEADLINE)).rejects.toThrow(/injected failure/);
    table.fail(null);
    expect(table.items.get('TENANT#55|META')?.disabledReason).toBe('uninstalled');
    expect(await store.listDueCleanups(DEADLINE)).toEqual([{ installationId: 55, deleteAfter: DEADLINE }]);
  });

  it('a failed transaction changes nothing, so the uninstall is never half-recorded', async () => {
    const { store, table } = await seeded();
    table.fail((name) => name === 'TransactWriteCommand');
    await expect(store.markUninstalled(55, DEADLINE)).rejects.toThrow(/injected failure/);
    await expect(store.markUninstalled(66, DEADLINE)).rejects.toThrow(/injected failure/); // the tombstone too
    table.fail(null);
    expect(table.items.get('TENANT#55|META')?.disabledReason).toBeUndefined();
    expect(table.items.has('TENANT#66|META')).toBe(false);
    expect(await store.listDueCleanups(DEADLINE)).toEqual([]);
  });

  it('purges every row of the partition, including one the sweep never reached', async () => {
    const { store, table } = await seeded();
    table.fail((name, input) => name === 'UpdateCommand' && String((input.Key as Item).sk).startsWith('MEMBER#'));
    await store.markUninstalled(55, DEADLINE).catch(() => {});
    table.fail(null);
    expect(table.items.get('TENANT#55|MEMBER#sub-a')?.ttl).toBeUndefined();
    await store.purgeTenantPartition(55);
    expect([...table.items.keys()].filter((k) => k.startsWith('TENANT#55|'))).toEqual([]);
    await store.purgeTenantPartition(55); // again: nothing to do
    expect(await store.listDueCleanups(DEADLINE)).toEqual([{ installationId: 55, deleteAfter: DEADLINE }]);
  });
});

describe('dynamo store: delivery claims and finished jobs (review fixes on #80)', () => {
  const LATER = Date.now() + 3_600_000;

  it('a claim is released only by the job holding it, and releasing again is harmless', async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    expect(await store.claimDelivery(55, 'd-1', LATER, 'job_first0001')).toBe(true);
    expect(await store.claimDelivery(55, 'd-1', LATER, 'job_second001')).toBe(false);
    expect(table.items.get('DELIVERY#55#d-1|CLAIM')?.jobId).toBe('job_first0001');

    // A late release from some other job (an earlier delivery's, delayed) leaves the claim alone.
    await store.releaseDelivery(55, 'd-1', 'job_second001');
    expect(table.items.has('DELIVERY#55#d-1|CLAIM')).toBe(true);

    await store.releaseDelivery(55, 'd-1', 'job_first0001');
    expect(table.items.has('DELIVERY#55#d-1|CLAIM')).toBe(false);
    await store.releaseDelivery(55, 'd-1', 'job_first0001'); // no claim: nothing happens

    // The redelivery's job claims it; the first job's repeated release cannot take it away.
    expect(await store.claimDelivery(55, 'd-1', LATER, 'job_second001')).toBe(true);
    await store.releaseDelivery(55, 'd-1', 'job_first0001');
    expect(table.items.get('DELIVERY#55#d-1|CLAIM')?.jobId).toBe('job_second001');
  });

  it('an expired claim counts as none', async () => {
    const store = createDynamoStore('T', fakeTable().client);
    expect(await store.claimDelivery(55, 'd-1', Date.now() - 5_000, 'job_first0001')).toBe(true);
    expect(await store.claimDelivery(55, 'd-1', LATER, 'job_second001')).toBe(true);
  });

  it('finishing keeps the first outcome and returns it, also to a repeated finish', async () => {
    const store = createDynamoStore('T', fakeTable().client);
    await store.putJob({
      jobId: 'job_first0001',
      tokenHash: 'ab',
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 99,
      configVersion: 1,
      deliveryId: 'd-1',
      eventName: 'issues',
      status: 'launched',
      createdAt: tenant.createdAt,
      expiresAt: LATER,
    });
    expect(await store.finishJob('job_first0001', 'failed')).toBe('failed');
    expect(await store.finishJob('job_first0001', 'succeeded')).toBe('failed');
    expect((await store.getJob('job_first0001'))?.outcome).toBe('failed');
    expect(await store.finishJob('job_nobody001', 'failed')).toBeNull();
  });

  it('reads a config version strongly consistently when asked (dispatch right after a publish)', async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    table.items.set('TENANT#55|CONFIG#0000000001', { pk: 'TENANT#55', sk: 'CONFIG#0000000001', version: 1, status: 'ready', createdAt: tenant.createdAt, createdBy: 'sub-a' });
    table.hideFromEventual('TENANT#55|CONFIG#0000000001');
    expect(await store.getConfigVersion(55, 1)).toBeNull();
    expect((await store.getConfigVersion(55, 1, { consistent: true }))?.version).toBe(1);
  });
});
