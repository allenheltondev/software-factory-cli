import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createClaudeSessions, type ManagedSession } from './sessions.js';
import type { Worker } from './store.js';
const session: ManagedSession = {
  generation: 'generation-test-123456',
  microvmId: 'mvm-startup',
  imageVersion: '10',
  requestedAt: 1,
};
function fixture(worker?: Worker, registrationRace = false, enqueueRace = false) {
  const items = new Map<string, Record<string, unknown>>([
    ['TENANT#55|CLAUDE_SESSION', { ...session }],
    ['NATIVE#55#managed-55|MODE', { revision: enqueueRace ? 2 : 1, routingVersion: 1 }],
  ]);
  if (worker) items.set('NATIVE#55#managed-55|WORKER', { ...worker });
  const send = async (command: unknown) => {
    if (!(command instanceof TransactWriteCommand)) throw Error('Unexpected command');
    if (registrationRace) items.set('NATIVE#55#managed-55|WORKER', { version: 1, microvmId: 'mvm-startup' });
    for (const operation of command.input.TransactItems ?? []) {
      const action = operation.Put ?? operation.Update;
      if (!action) throw Error('Unexpected transaction operation');
      const key = 'Item' in action ? action.Item : action.Key;
      const item = items.get(`${key?.pk}|${key?.sk}`);
      const values = action.ExpressionAttributeValues ?? {};
      const expr = action.ConditionExpression;
      const allowed =
        expr === 'attribute_not_exists(pk)'
          ? !item
          : expr === 'generation = :g AND attribute_not_exists(retiring)'
            ? item?.generation === values[':g'] && !item?.retiring
            : expr === 'revision = :revision'
              ? item?.revision === values[':revision']
              : expr === '#v = :v AND attribute_not_exists(active) AND attribute_not_exists(settling)'
                ? item?.version === values[':v'] && !item?.active && !item?.settling
                : false;
      if (!allowed)
        throw new TransactionCanceledException({
          $metadata: {},
          message: 'CAS lost',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        });
    }
    for (const operation of command.input.TransactItems ?? []) {
      if (operation.Put?.Item) {
        const item = operation.Put.Item;
        items.set(`${item.pk}|${item.sk}`, { ...item });
      } else if (operation.Update) {
        const update = operation.Update;
        const key = `${update.Key?.pk}|${update.Key?.sk}`;
        const item = items.get(key)!;
        const values = update.ExpressionAttributeValues!;
        if (update.UpdateExpression?.startsWith('SET retiring = :yes')) { item.retiring = true; item.retirementReason = values[':reason']; }
        else {
          item.revision = values[':next'];
          item.routingVersion = values[':routing'];
        }
      }
    }
    return {};
  };
  return { items, sessions: createClaudeSessions('test', { send } as unknown as DynamoDBDocumentClient) };
}
describe('generation-bound startup retirement', () => {
  it('atomically fences a never-registered generation, routing revision, and future worker registration', async () => {
    const { sessions, items } = fixture();
    expect(await sessions.retire(55, session, { enabled: false, revision: 1, routingVersion: 1 }, null)).toBe(true);
    expect(items.get('TENANT#55|CLAUDE_SESSION')).toMatchObject({ generation: session.generation, retiring: true });
    expect(items.get('NATIVE#55#managed-55|MODE')).toMatchObject({ revision: 2, routingVersion: 2 });
    expect(items.get('NATIVE#55#managed-55|WORKER')).toMatchObject({
      fenced: true,
      microvmId: 'mvm-startup',
      version: 1,
    });
    expect(await sessions.retire(55, session, { enabled: false, revision: 1, routingVersion: 1 }, null)).toBe(false);
  });
  it.each(['registration', 'enqueue'])('commits nothing when a concurrent %s wins', async (race) => {
    const { sessions, items } = fixture(undefined, race === 'registration', race === 'enqueue');
    expect(await sessions.retire(55, session, { enabled: false, revision: 1, routingVersion: 1 }, null)).toBe(false);
    expect(items.get('TENANT#55|CLAUDE_SESSION')).not.toHaveProperty('retiring');
    expect(items.get('NATIVE#55#managed-55|WORKER')?.fenced).not.toBe(true);
  });
});
