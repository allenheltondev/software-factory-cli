import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { SummaryItem } from '../jobs/job-finished-event.js';
import type { ReplayLock, ReplayPut } from './job-finished-replay.js';

/**
 * The replay's AWS side (admin/job-finished-replay.ts). Summaries are read with the low-level
 * client, so each item is in DynamoDB's own format, the same as the stream images the live
 * publisher maps: both go through one mapping (jobs/job-finished-event.ts).
 *
 *   TENANT#<installId>   JOB_FINISHED_REPLAY   the replay lock: `expiresAt` (epoch ms), TTL a day
 */

const LOCK_SK = 'JOB_FINISHED_REPLAY';
const lockKey = (id: number) => ({ pk: { S: `TENANT#${id}` }, sk: { S: LOCK_SK } });

export function dynamoReplayLock(tableName: string, client: Pick<DynamoDBClient, 'send'> = new DynamoDBClient({})): ReplayLock {
  return {
    async acquire(id, now, expiresAt) {
      try {
        await client.send(new PutItemCommand({
          TableName: tableName,
          Item: { ...lockKey(id), expiresAt: { N: String(expiresAt) }, ttl: { N: String(Math.floor(expiresAt / 1000) + 86_400) } },
          ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
          ExpressionAttributeValues: { ':now': { N: String(now) } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }));
        return { ok: true };
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        const held = Number(err.Item?.expiresAt?.N);
        return Number.isFinite(held) ? { ok: false, expiresAt: held } : { ok: false };
      }
    },
    async release(id, expiresAt) {
      try {
        await client.send(new DeleteItemCommand({
          TableName: tableName,
          Key: lockKey(id),
          ConditionExpression: 'expiresAt = :mine',
          ExpressionAttributeValues: { ':mine': { N: String(expiresAt) } },
        }));
      } catch (err) {
        // Another replay's lock, or none: nothing of this one's to give back.
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    },
  };
}

/** The tenant's finished job summaries, every page. */
export function dynamoFinishedSummaries(tableName: string, client: Pick<DynamoDBClient, 'send'> = new DynamoDBClient({})) {
  return async function* (id: number): AsyncIterable<SummaryItem> {
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const page = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        FilterExpression: '#status = :finished',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pk': { S: `TENANT#${id}` }, ':prefix': { S: 'JOB#' }, ':finished': { S: 'finished' } },
        ExclusiveStartKey,
      }));
      for (const item of page.Items ?? []) yield item as SummaryItem;
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  };
}

/** The account's default bus, as the live publisher puts (no EventBusName). */
export function eventBridgePut(client = new EventBridgeClient({})): ReplayPut {
  return async (Entries) => client.send(new PutEventsCommand({ Entries }));
}
