import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createDynamoStore } from './dynamo.js';
import type { Job, Member, Quotas, Tenant } from './store.js';

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
    if (expr === 'attribute_not_exists(jobs) OR jobs < :limit') return !item || item.jobs === undefined || (item.jobs as number) < (values[':limit'] as number);
    if (expr === 'attribute_not_exists(seconds) OR seconds < :limit') {
      return !item || item.seconds === undefined || (item.seconds as number) < (values[':limit'] as number);
    }
    if (expr === 'attribute_exists(pk) AND attribute_not_exists(startedAt) AND attribute_not_exists(stopRequestedAt) AND #status <> :finished') {
      return Boolean(item) && item!.startedAt === undefined && item!.stopRequestedAt === undefined && item!.status !== values[':finished'];
    }
    if (expr === 'attribute_exists(pk) AND attribute_not_exists(stopRequestedAt)') return Boolean(item) && item!.stopRequestedAt === undefined;
    if (expr === 'attribute_exists(pk) AND attribute_not_exists(releasedAt)') return Boolean(item) && item!.releasedAt === undefined;
    if (expr === 'attribute_not_exists(pk) OR jobId = :job OR #ttl < :now') {
      return !item || item.jobId === values[':job'] || (item.ttl as number) < (values[':now'] as number);
    }
    if (expr === 'attribute_exists(pk) AND #status <> :finished') return Boolean(item) && item!.status !== values[':finished'];
    if (expr === 'jobId = :job') return Boolean(item) && item!.jobId === values[':job'];
    if (expr === 'phase = :reserved') return Boolean(item) && item!.phase === values[':reserved'];
    if (expr === 'attribute_exists(pk) AND phase = :phase') return Boolean(item) && item!.phase === values[':phase'];
    throw new Error(`fake table: unsupported condition ${expr}`);
  }

  /** SET (with if_not_exists), ADD and REMOVE clauses, in any order. */
  function update(item: Item, expr: string, names: Record<string, string> = {}, values: Values = {}): Item {
    const next = { ...item };
    const name = (n: string) => names[n] ?? n;
    // Commas outside parentheses separate the actions of a clause.
    const actions = (body: string) => {
      const out: string[] = [];
      let depth = 0;
      let current = '';
      for (const ch of body) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          out.push(current.trim());
          current = '';
        } else current += ch;
      }
      if (current.trim()) out.push(current.trim());
      return out;
    };
    for (const [, kind, body = ''] of expr.matchAll(/(SET|ADD|REMOVE)\s+(.*?)(?=\s+(?:SET|ADD|REMOVE)\s|$)/g)) {
      for (const action of actions(body)) {
        if (kind === 'REMOVE') delete next[name(action)];
        else if (kind === 'ADD') {
          const [attr = '', value = ''] = action.split(/\s+/);
          const current = next[name(attr)];
          next[name(attr)] = (typeof current === 'number' ? current : 0) + (values[value] as number);
        } else {
          const [lhs = '', rhs = ''] = action.split('=').map((x) => x.trim());
          const ifNotExists = /^if_not_exists\((\S+?),\s*(\S+?)\)$/.exec(rhs);
          next[name(lhs)] = ifNotExists ? (next[name(ifNotExists[1]!)] ?? values[ifNotExists[2]!]) : values[rhs];
        }
      }
    }
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
const QUOTAS: Quotas = { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 };
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

  it("a started job holds its claim and slots for its lifetime, is charged once, and loses to another job's live claim or slot", async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    const SOON = Date.now() + 60_000;
    const MONTH = 'USAGE#MONTH#2026-11';
    const job = (jobId: string, deliveryId: string, extra: Partial<Job> = {}): Job => ({
      jobId,
      tokenHash: 'ab',
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 99,
      configVersion: 1,
      deliveryId,
      eventName: 'issues',
      status: 'launched',
      createdAt: '2026-11-20T12:00:00.000Z',
      expiresAt: LATER,
      ...extra,
    });

    // Its own short claim and slots, held to the job's lifetime and charged its maximum duration.
    const first = job('job_first0001', 'd-1', { tenantSlot: 0, platformSlot: 3, reservedSeconds: 10800 });
    await store.putJob(first);
    expect(await store.claimDelivery(55, 'd-1', SOON, first.jobId)).toBe(true);
    expect(await store.reserveJob({ installationId: 55, jobId: first.jobId, holdUntil: SOON, day: '2026-11-20', month: '2026-11', quotas: { ...QUOTAS, platformConcurrentJobs: 1 } })).toMatchObject({ ok: true });
    table.items.set('PLATFORM#JOBS|SLOT#0003', { pk: 'PLATFORM#JOBS', sk: 'SLOT#0003', jobId: first.jobId, ttl: Math.ceil(SOON / 1000) });
    expect(await store.startJob(first, LATER)).toEqual({ result: 'started' });
    for (const k of ['DELIVERY#55#d-1|CLAIM', 'TENANT#55|SLOT#0000', 'PLATFORM#JOBS|SLOT#0003']) {
      expect(table.items.get(k)).toMatchObject({ jobId: first.jobId, ttl: Math.ceil(LATER / 1000) });
    }
    expect(table.items.get(`TENANT#55|${MONTH}`)?.seconds).toBe(10800);
    expect(typeof (await store.getJob(first.jobId))?.startedAt).toBe('number');
    expect(await store.claimDelivery(55, 'd-1', LATER, 'job_second001')).toBe(false);

    // A retried start: nothing more is charged.
    expect(await store.startJob(first, LATER)).toEqual({ result: 'already' });
    expect(table.items.get(`TENANT#55|${MONTH}`)?.seconds).toBe(10800);

    // A redelivery's job holds the claim: superseded, and nothing changed.
    const second = job('job_second001', 'd-2', { tenantSlot: 1, reservedSeconds: 600 });
    await store.putJob(second);
    expect(await store.claimDelivery(55, 'd-2', LATER, 'job_other0001')).toBe(true);
    expect(await store.startJob(second, LATER)).toEqual({ result: 'superseded' });
    expect(table.items.get(`TENANT#55|${MONTH}`)?.seconds).toBe(10800);
    expect((await store.getJob(second.jobId))?.startedAt).toBeUndefined();

    // Another job holds its slot (its own ran out and was taken): throttled.
    const third = job('job_third0001', 'd-3', { tenantSlot: 0 });
    await store.putJob(third);
    expect(await store.startJob(third, LATER)).toEqual({ result: 'throttled', limit: 'concurrent_jobs' });

    // A missing or expired claim is taken back.
    const fourth = job('job_fourth001', 'd-4');
    await store.putJob(fourth);
    expect(await store.claimDelivery(55, 'd-4', Date.now() - 5_000, fourth.jobId)).toBe(true);
    expect(await store.startJob(fourth, LATER)).toEqual({ result: 'started' });

    // The slots go only with their own job.
    await store.releaseJobSlots(third);
    expect(table.items.has('TENANT#55|SLOT#0000')).toBe(true);
    await store.releaseJobSlots(first);
    expect(table.items.has('TENANT#55|SLOT#0000')).toBe(false);
    expect(table.items.has('PLATFORM#JOBS|SLOT#0003')).toBe(false);
  });

  it('reserves a slot of the tenant and of the platform and counts the job, until a quota stops it', async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    const SOON = Date.now() + 60_000;
    const reserve = (installationId: number, jobId: string, quotas: Partial<typeof QUOTAS> = {}, holdUntil = SOON) =>
      store.reserveJob({ installationId, jobId, holdUntil, day: '2026-11-20', month: '2026-11', quotas: { ...QUOTAS, concurrentJobs: 1, jobsPerDay: 2, ...quotas } });

    const a = await reserve(55, 'job_a00000001');
    expect(a).toEqual({ ok: true, tenantSlot: 0, platformSlot: expect.any(Number) });
    expect(await store.getUsage(55, '2026-11-20', '2026-11')).toEqual({
      day: '2026-11-20',
      jobsToday: 1,
      month: '2026-11',
      jobsThisMonth: 1,
      microvmSecondsThisMonth: 0,
      throttledThisMonth: 0,
    });
    // One at a time: a second is refused, and takes nothing.
    expect(await reserve(55, 'job_b00000001')).toEqual({ ok: false, limit: 'concurrent_jobs' });
    expect((await store.getUsage(55, '2026-11-20', '2026-11')).jobsToday).toBe(1);

    // A failed launch gives everything back, once: a repeat (a retry, a concurrent reclaim) gives nothing more.
    if (!a.ok) throw new Error('unreachable');
    const reservation = { installationId: 55, jobId: 'job_a00000001', tenantSlot: a.tenantSlot, platformSlot: a.platformSlot, day: '2026-11-20', month: '2026-11' };
    // Not in the phase asked for: nothing happens to the counts.
    expect(await store.cancelReservation(reservation, 'launching')).toBe(false);
    expect((await store.getUsage(55, '2026-11-20', '2026-11')).jobsToday).toBe(1);
    expect(await store.cancelReservation(reservation, 'reserved')).toBe(true);
    expect(table.items.has('TENANT#55|SLOT#0000')).toBe(false);
    expect((await store.getUsage(55, '2026-11-20', '2026-11')).jobsToday).toBe(0);
    expect(await store.cancelReservation(reservation, 'reserved')).toBe(false);
    expect(await store.getUsage(55, '2026-11-20', '2026-11')).toMatchObject({ jobsToday: 0, jobsThisMonth: 0 });

    // Jobs per day: counted at launch, whatever becomes of the job.
    for (const jobId of ['job_c00000001', 'job_d00000001']) {
      const r = await reserve(55, jobId);
      if (!r.ok) throw new Error(`refused: ${r.limit}`);
      await store.releaseJobSlots({ installationId: 55, jobId, tenantSlot: r.tenantSlot, platformSlot: r.platformSlot });
    }
    expect(await reserve(55, 'job_e00000001')).toEqual({ ok: false, limit: 'jobs_per_day' });
    // The day's refusal left the slots it would have taken free.
    expect(table.items.has('TENANT#55|SLOT#0000')).toBe(false);

    // A slot whose job never started runs out: it is free again.
    expect(await reserve(56, 'job_f00000001', {}, Date.now() - 5_000)).toMatchObject({ ok: true });
    expect(await reserve(56, 'job_g00000001')).toMatchObject({ ok: true, tenantSlot: 0 });

    // MicroVM minutes: a month at its quota starts nothing.
    table.items.set('TENANT#57|USAGE#MONTH#2026-11', { pk: 'TENANT#57', sk: 'USAGE#MONTH#2026-11', seconds: 60 });
    expect(await reserve(57, 'job_h00000001', { microvmMinutesPerMonth: 1 })).toEqual({ ok: false, limit: 'microvm_minutes' });
    expect(await reserve(57, 'job_h00000001', { microvmMinutesPerMonth: 2 })).toMatchObject({ ok: true });

  });

  it('records each reservation as active, reserved until the launch marks it launching, and drops it when cancelled', async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    const r = await store.reserveJob({ installationId: 55, jobId: 'job_a00000001', holdUntil: LATER, day: '2026-11-20', month: '2026-11', quotas: QUOTAS });
    if (!r.ok) throw new Error(r.limit);
    expect(await store.listActiveJobs()).toEqual([
      { jobId: 'job_a00000001', installationId: 55, tenantSlot: r.tenantSlot, platformSlot: r.platformSlot, day: '2026-11-20', month: '2026-11', phase: 'reserved', reservedAt: expect.any(Number), expiresAt: LATER },
    ]);
    await store.markLaunching('job_a00000001');
    expect((await store.listActiveJobs())[0]?.phase).toBe('launching');
    await expect(store.markLaunching('job_a00000001')).rejects.toThrow('no reservation to launch');
    expect(await store.cancelReservation({ installationId: 55, jobId: 'job_a00000001', tenantSlot: r.tenantSlot, platformSlot: r.platformSlot, day: '2026-11-20', month: '2026-11' }, 'launching')).toBe(true);
    expect(await store.listActiveJobs()).toEqual([]);
    await expect(store.markLaunching('job_a00000001')).rejects.toThrow('no reservation to launch');
  });

  it("stops at the platform's ceiling, across tenants", async () => {
    const store = createDynamoStore('T', fakeTable().client);
    const reserve = (installationId: number) =>
      store.reserveJob({ installationId, jobId: `job_p000000${installationId}`, holdUntil: Date.now() + 60_000, day: '2026-11-20', month: '2026-11', quotas: { ...QUOTAS, platformConcurrentJobs: 2 } });
    const taken = [await reserve(60), await reserve(61)];
    expect(taken.map((r) => (r.ok ? r.platformSlot : null)).sort()).toEqual([0, 1]);
    expect(await reserve(62)).toEqual({ ok: false, limit: 'platform_concurrency' });
  });

  it('releases a job once its microVM stopped: the unused time refunded once, and its slots freed', async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    table.items.set('TENANT#55|USAGE#MONTH#2026-11', { pk: 'TENANT#55', sk: 'USAGE#MONTH#2026-11', seconds: 10800 });
    table.items.set('TENANT#55|SLOT#0000', { pk: 'TENANT#55', sk: 'SLOT#0000', jobId: 'job_first0001', ttl: Math.ceil(LATER / 1000) });
    const job: Job = {
      jobId: 'job_first0001',
      tokenHash: 'ab',
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 99,
      configVersion: 1,
      deliveryId: 'd-1',
      eventName: 'issues',
      status: 'finished',
      createdAt: '2026-11-20T12:00:00.000Z',
      expiresAt: LATER,
      tenantSlot: 0,
    };
    await store.putJob(job);
    table.items.set('PLATFORM#ACTIVE|JOB#job_first0001', { pk: 'PLATFORM#ACTIVE', sk: 'JOB#job_first0001', jobId: job.jobId, phase: 'launching' });
    expect((await store.listActiveJobs()).map((e) => e.jobId)).toEqual([job.jobId]);
    await store.releaseJob(job, { month: '2026-11', seconds: 9000 });
    await store.releaseJob(job, { month: '2026-11', seconds: 9000 });
    expect(table.items.get('TENANT#55|USAGE#MONTH#2026-11')?.seconds).toBe(1800);
    expect(table.items.has('TENANT#55|SLOT#0000')).toBe(false);
    expect(typeof (await store.getJob(job.jobId))?.releasedAt).toBe('number');
    // A hold from a read taken before the release (a slow reconciliation) brings nothing back.
    expect(await store.holdSlots(job, LATER)).toBe(true);
    expect(table.items.has('TENANT#55|SLOT#0000')).toBe(false);
    // Released: no longer an active job for reconciliation, and retired: it can never start.
    expect(await store.listActiveJobs()).toEqual([]);
    expect(typeof (await store.getJob(job.jobId))?.stopRequestedAt).toBe('number');
    expect(await store.startJob({ ...job, status: 'launched' }, LATER)).toEqual({ result: 'retired' });
  });

  it('never starts a finished job, and checks the month in the transaction that charges it', async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    const base: Job = {
      jobId: 'job_first0001',
      tokenHash: 'ab',
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 99,
      configVersion: 1,
      deliveryId: 'd-1',
      eventName: 'issues',
      status: 'launched',
      createdAt: '2026-11-20T12:00:00.000Z',
      expiresAt: LATER,
      reservedSeconds: 10800,
      quotas: { ...QUOTAS, microvmMinutesPerMonth: 200 },
    };
    // Finished before its start committed (a concurrent finish): retired, nothing charged.
    await store.putJob(base);
    await store.finishJob(base.jobId, 'start_failed');
    expect(await store.startJob(base, LATER)).toEqual({ result: 'retired' });
    expect(table.items.get('TENANT#55|USAGE#MONTH#2026-11')).toBeUndefined();

    // Launches that passed the launcher's check on the same remainder (200 minutes): the first two
    // starts are charged 180 each while the month is under, and the third finds it spent.
    const [second, third, fourth] = ['job_second001', 'job_third0001', 'job_fourth001'].map((jobId, i) => ({ ...base, jobId, deliveryId: `d-${i + 2}` }));
    for (const j of [second!, third!, fourth!]) await store.putJob(j);
    expect(await store.startJob(second!, LATER)).toEqual({ result: 'started' });
    expect(await store.startJob(third!, LATER)).toEqual({ result: 'started' });
    expect(await store.startJob(fourth!, LATER)).toEqual({ result: 'throttled', limit: 'microvm_minutes' });
    expect(table.items.get('TENANT#55|USAGE#MONTH#2026-11')?.seconds).toBe(21600);
    expect((await store.getJob(fourth!.jobId))?.startedAt).toBeUndefined();
  });

  it('a stopping job never starts; a refused one holds what slots it has; reconciliation lists the platform slots', async () => {
    const table = fakeTable();
    const store = createDynamoStore('T', table.client);
    const job: Job = {
      jobId: 'job_first0001',
      tokenHash: 'ab',
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 99,
      configVersion: 1,
      deliveryId: 'd-1',
      eventName: 'issues',
      status: 'launched',
      createdAt: '2026-11-20T12:00:00.000Z',
      expiresAt: LATER,
      tenantSlot: 0,
      platformSlot: 1,
    };
    await store.putJob(job);
    await store.markStopping(job.jobId);
    const stopping = (await store.getJob(job.jobId))!.stopRequestedAt;
    expect(typeof stopping).toBe('number');
    await store.markStopping(job.jobId);
    expect((await store.getJob(job.jobId))!.stopRequestedAt).toBe(stopping);
    expect(await store.startJob(job, LATER)).toEqual({ result: 'retired' });

    // Its own short slot is held on; another job's live slot is left alone.
    table.items.set('TENANT#55|SLOT#0000', { pk: 'TENANT#55', sk: 'SLOT#0000', jobId: job.jobId, ttl: Math.ceil((Date.now() + 60_000) / 1000) });
    table.items.set('PLATFORM#JOBS|SLOT#0001', { pk: 'PLATFORM#JOBS', sk: 'SLOT#0001', jobId: 'job_other001', ttl: Math.ceil(LATER / 1000) });
    expect(await store.holdSlots(job, LATER)).toBe(false);
    expect(table.items.get('TENANT#55|SLOT#0000')).toMatchObject({ jobId: job.jobId, ttl: Math.ceil(LATER / 1000) });
    expect(table.items.get('PLATFORM#JOBS|SLOT#0001')?.jobId).toBe('job_other001');

    table.items.set('PLATFORM#JOBS|SLOT#0002', { pk: 'PLATFORM#JOBS', sk: 'SLOT#0002', jobId: 'job_expired1', ttl: Math.floor(Date.now() / 1000) - 10 });
    expect(await store.listPlatformSlots()).toEqual([{ jobId: 'job_other001', expiresAt: Math.ceil(LATER / 1000) * 1000 }]);
  });

  it('keeps a tenant\'s quota overrides, and removes them', async () => {
    const { store } = await seeded();
    expect(await store.setTenantLimits(55, { concurrentJobs: 3, microvmMinutesPerMonth: 5000 })).toBe('updated');
    expect((await store.getTenant(55))?.limits).toEqual({ concurrentJobs: 3, microvmMinutesPerMonth: 5000 });
    expect(await store.setTenantLimits(55, null)).toBe('updated');
    expect((await store.getTenant(55))?.limits).toBeUndefined();
    expect(await store.setTenantLimits(56, { jobsPerDay: 1 })).toBe('no_tenant');
  });

  it('counts throttled deliveries, and says to comment once per issue a day', async () => {
    const store = createDynamoStore('T', fakeTable().client);
    const notice = { repositoryId: 99, issue: 12, day: '2026-11-20' };
    expect(await store.recordThrottle(55, '2026-11', notice)).toBe(true);
    expect(await store.recordThrottle(55, '2026-11', notice)).toBe(false);
    expect(await store.recordThrottle(55, '2026-11', { ...notice, issue: 13 })).toBe(true);
    expect(await store.recordThrottle(55, '2026-11', { ...notice, day: '2026-11-21' })).toBe(true);
    expect(await store.recordThrottle(55, '2026-11')).toBe(false);
    expect((await store.getUsage(55, '2026-11-20', '2026-11')).throttledThisMonth).toBe(5);
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
