import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, type UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createClaudeSessions, waitingId } from './sessions.js';

function fixtures() {
  const rows = new Map<string, Record<string, unknown>>();
  const id = (row: Record<string, unknown>) => String(row.pk) + '|' + String(row.sk);
  const reject = () => { throw new ConditionalCheckFailedException({ message: 'stale write', $metadata: {} }); };
  const db = { async send(command: GetCommand | PutCommand | UpdateCommand) {
    if (command instanceof GetCommand) return { Item: rows.get(id(command.input.Key!)) };
    if (command instanceof PutCommand) {
      const key = id(command.input.Item!);
      const current = rows.get(key);
      if (command.input.ConditionExpression === 'attribute_not_exists(pk)' ? current : current?.generation !== command.input.ExpressionAttributeValues?.[':g']) reject();
      rows.set(key, command.input.Item!);
      return {};
    }
    const key = id(command.input.Key!);
    const current = rows.get(key);
    if (!current || current.generation !== command.input.ExpressionAttributeValues?.[':g']) reject();
    rows.set(key, { ...current, microvmId: command.input.ExpressionAttributeValues?.[':vm'] });
    return {};
  } };
  return createClaudeSessions('table', db as unknown as DynamoDBDocumentClient);
}

describe('tenant Claude session and waiting request records', () => {
  it('reserves one generation per tenant and binds only the current generation', async () => {
    const service = fixtures();
    const [first, duplicate, other] = await Promise.all([
      service.requestSession(55, undefined, '7'), service.requestSession(55, undefined, '7'), service.requestSession(56, undefined, '7'),
    ]);
    expect(first).toBeDefined();
    expect(duplicate).toBeUndefined();
    expect(other?.generation).not.toBe(first?.generation);
    await expect(service.bind(56, first!.generation, 'mvm-first')).rejects.toThrow();
    await service.bind(55, first!.generation, 'mvm-first');
    expect(await service.session(55)).toMatchObject({ microvmId: 'mvm-first', imageVersion: '7' });
    expect(await service.session(56)).not.toHaveProperty('microvmId');
  });

  it('deduplicates the waiting issue delivery under its own installation only', async () => {
    const service = fixtures();
    const first = await service.park({ installationId: 55, deliveryId: 'delivery' }, 'first.json', 0);
    const duplicate = await service.park({ installationId: 55, deliveryId: 'delivery' }, 'replacement.json', 1);
    expect(first).toEqual({ id: waitingId(55, 'delivery'), created: true });
    expect(duplicate).toEqual({ id: first.id, created: false });
    expect(await service.get(56, first.id)).toBeUndefined();
    expect(await service.get(55, first.id)).toMatchObject({ status: 'waiting', eventKey: 'first.json' });
  });
});
