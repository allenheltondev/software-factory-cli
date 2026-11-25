import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createDynamoQueueStore, createMemoryQueueStore, type QueueEntry, type QueueStore } from './queue-store.js';

type Item = Record<string, unknown>;

/**
 * A stand-in document client that understands exactly the expressions the queue store sends, and
 * throws on anything else: a new expression gets added here deliberately.
 */
function fakeTable() {
  const items = new Map<string, Item>();
  const k = (key: Item) => `${String(key.pk)}|${String(key.sk)}`;
  const holds = (expr: string | undefined, item: Item | undefined, values: Item = {}): boolean => {
    if (!expr) return true;
    if (expr === 'attribute_not_exists(pk)') return !item;
    if (expr === 'attribute_not_exists(pk) OR #ttl < :now') return !item || Number(item.ttl) < Number(values[':now']);
    if (expr === 'attribute_not_exists(#depth) OR #depth < :max') return item?.depth === undefined || Number(item.depth) < Number(values[':max']);
    if (expr === '#v = :v') return item?.version === values[':v'];
    if (expr === 'attribute_not_exists(pk) OR jobId = :job') return !item || item.jobId === values[':job'];
    throw new Error(`unexpected condition: ${expr}`);
  };
  type Op = { kind: 'put' | 'delete' | 'update'; input: Item };
  const apply = (op: Op) => {
    const input = op.input as { Item?: Item; Key?: Item; UpdateExpression?: string; ExpressionAttributeValues?: Item };
    if (op.kind === 'put') items.set(k(input.Item!), structuredClone(input.Item!));
    else if (op.kind === 'delete') items.delete(k(input.Key!));
    else if (input.UpdateExpression === 'ADD #depth :one' || input.UpdateExpression === 'ADD #depth :minus') {
      const cur = items.get(k(input.Key!)) ?? { ...input.Key };
      const by = Number(input.ExpressionAttributeValues![':one'] ?? input.ExpressionAttributeValues![':minus']);
      items.set(k(input.Key!), { ...cur, depth: Number(cur.depth ?? 0) + by });
    } else throw new Error(`unexpected update: ${input.UpdateExpression}`);
  };
  const ok = (op: Op) => {
    const input = op.input as { Item?: Item; Key?: Item; ConditionExpression?: string; ExpressionAttributeValues?: Item };
    return holds(input.ConditionExpression, items.get(k(input.Item ?? input.Key!)), input.ExpressionAttributeValues);
  };
  const client = {
    async send(command: unknown) {
      if (command instanceof GetCommand) return { Item: items.get(k(command.input.Key!)) };
      if (command instanceof PutCommand) {
        const op: Op = { kind: 'put', input: command.input as Item };
        if (!ok(op)) throw new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
        apply(op);
        return {};
      }
      if (command instanceof DeleteCommand) {
        apply({ kind: 'delete', input: command.input as Item });
        return {};
      }
      if (command instanceof UpdateCommand) {
        apply({ kind: 'update', input: command.input as Item });
        return {};
      }
      if (command instanceof QueryCommand) {
        const v = command.input.ExpressionAttributeValues as Item;
        const out = [...items.values()]
          .filter((i) => i.pk === v[':pk'] && (v[':prefix'] === undefined || String(i.sk).startsWith(String(v[':prefix']))))
          .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
        return { Items: out.slice(0, command.input.Limit ?? out.length) };
      }
      if (command instanceof TransactWriteCommand) {
        const ops: Op[] = (command.input.TransactItems ?? []).map((t) => (t.Put ? { kind: 'put', input: t.Put } : t.Delete ? { kind: 'delete', input: t.Delete } : t.Update ? { kind: 'update', input: t.Update } : { kind: 'put', input: {} })) as Op[];
        const reasons = ops.map((op) => (ok(op) ? { Code: 'None' } : { Code: 'ConditionalCheckFailed' }));
        if (reasons.some((r) => r.Code !== 'None')) throw new TransactionCanceledException({ message: 'cancelled', $metadata: {}, CancellationReasons: reasons });
        ops.forEach(apply);
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return { client: client as never, items };
}

const NOW = Date.now();
const entry = (jobId: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  jobId, installationId: 55, repository: 'acme/web', repositoryId: 9, issue: 2, deliveryId: `d-${jobId}`, eventName: 'issues', eventKey: `k/${jobId}`,
  label: 'updraft', route: 'standard', configVersion: 1, reason: 'concurrent_jobs', state: 'queued', enqueuedAt: NOW, expiresAt: NOW + 1000, attempts: 0,
  nextAttemptAt: NOW, deliveries: 1, version: 0, ...over,
});

/** The same behaviour from both stores: the memory one the tests use, and the DynamoDB one. */
for (const [name, make] of [['memory', () => ({ store: createMemoryQueueStore() as QueueStore })], ['dynamo', () => {
  const t = fakeTable();
  return { store: createDynamoQueueStore('t', t.client), items: t.items };
}]] as const) {
  describe(`the ${name} queue store`, () => {
    it('keeps one waiting entry per subject, and joins the rest to it', async () => {
      const { store } = make();
      expect(await store.enqueue(entry('job_a'), 5)).toMatchObject({ result: 'queued', entry: { version: 1 } });
      expect(await store.enqueue(entry('job_b'), 5)).toMatchObject({ result: 'joined', entry: { jobId: 'job_a' } });
      // A retried enqueue of the very same entry finds itself.
      expect(await store.enqueue(entry('job_a'), 5)).toMatchObject({ result: 'joined', entry: { jobId: 'job_a' } });
      expect(await store.depth(55)).toBe(1);
      expect(await store.waitingFor(55, 9, { issue: 2 })).toMatchObject({ jobId: 'job_a' });
    });

    it('bounds the tenant and frees the place, the lock and the index at the settle', async () => {
      const { store } = make();
      await store.enqueue(entry('job_a'), 2);
      await store.enqueue(entry('job_b', { issue: 3, enqueuedAt: NOW + 1 }), 2);
      expect(await store.enqueue(entry('job_c', { issue: 4 }), 2)).toEqual({ result: 'full' });
      expect((await store.listWaiting(10)).map((i) => i.jobId)).toEqual(['job_a', 'job_b']);
      const a = (await store.get(55, 'job_a'))!;
      expect(await store.settle({ ...a, state: 'canceled', outcome: { at: NOW, reason: 'x', message: 'y' } }, a)).toBe(true);
      // Once only: the same transition from the same version loses.
      expect(await store.settle({ ...a, state: 'expired' }, a)).toBe(false);
      expect(await store.depth(55)).toBe(1);
      expect((await store.listWaiting(10)).map((i) => i.jobId)).toEqual(['job_b']);
      expect(await store.waitingFor(55, 9, { issue: 2 })).toBeNull();
      expect(await store.enqueue(entry('job_c', { issue: 4 }), 2)).toMatchObject({ result: 'queued' });
      expect((await store.list(55, 10)).map((e) => e.state).sort()).toEqual(['canceled', 'queued', 'queued']);
    });

    it('lets exactly one of two writers move an entry on', async () => {
      const { store } = make();
      const { entry: e } = (await store.enqueue(entry('job_a'), 5)) as { entry: QueueEntry };
      expect(await store.update({ ...e, state: 'admitting', admittingUntil: NOW + 1 }, e)).toBe(true);
      expect(await store.update({ ...e, state: 'admitting', admittingUntil: NOW + 2 }, e)).toBe(false);
      expect(await store.settle({ ...e, state: 'canceled' }, e)).toBe(false);
      const cur = (await store.get(55, 'job_a'))!;
      expect(cur).toMatchObject({ state: 'admitting', version: 2 });
      // An ended entry takes a comment, never a new state.
      await store.settle({ ...cur, state: 'admitted' }, cur);
      const ended = (await store.get(55, 'job_a'))!;
      expect(await store.update({ ...ended, commentId: 7, commentState: 'admitted' }, ended)).toBe(true);
      const commented = (await store.get(55, 'job_a'))!;
      if (name === 'dynamo') await expect(store.update({ ...commented, state: 'queued' }, commented)).rejects.toThrow();
      else expect(await store.update({ ...commented, state: 'queued' }, commented)).toBe(false);
    });
  });
}
