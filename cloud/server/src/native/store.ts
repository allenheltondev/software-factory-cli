import type { NativeTrigger } from './route.js';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

export type AuthState = 'connected' | 'auth-required' | 'expired' | 'unavailable';
export interface Worker {
  version: number;
  installationId: number;
  workerId: string;
  session: string;
  microvmId: string;
  imageVersion: string;
  workerVersion: string;
  auth: AuthState;
  heartbeatAt: number;
  active?: { jobId: string; until: number };
  /** Active lease durably retired; blocks dispatch until quota release is confirmed. */
  settling?: { jobId: string };
  fenced?: boolean;
}
export interface NativeStore {
  get(installationId: number, workerId: string): Promise<Worker | null>;
  /** Compare-and-swap; never expire this row using DynamoDB TTL. */
  put(worker: Worker, previousVersion: number | null): Promise<boolean>;
  queued(installationId: number, workerId: string): Promise<string[]>;
  dequeue(installationId: number, workerId: string, jobId: string): Promise<void>;
}
export const nativePartition = (installationId: number, workerId: string) => `NATIVE#${installationId}#${workerId}`;
export function createNativeStore(table: string, db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })): NativeStore {
  const key = (id: number, worker: string) => ({ pk: nativePartition(id, worker), sk: 'WORKER' });
  return {
    async get(id, worker) {
      const { Item } = await db.send(new GetCommand({ TableName: table, Key: key(id, worker), ConsistentRead: true }));
      return Item ? Item as Worker : null;
    },
    async put(worker, previousVersion) {
      try {
        await db.send(new PutCommand({ TableName: table, Item: { ...key(worker.installationId, worker.workerId), ...worker },
          ConditionExpression: previousVersion === null ? 'attribute_not_exists(pk)' : '#v = :v',
          ...(previousVersion === null ? {} : { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': previousVersion } }) }));
        return true;
      } catch (e) { if (e instanceof ConditionalCheckFailedException) return false; throw e; }
    },
    async queued(id, worker) {
      const { Items } = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :q)',
        ExpressionAttributeValues: { ':p': nativePartition(id, worker), ':q': 'QUEUE#' }, ConsistentRead: true, Limit: 100 }));
      return (Items ?? []).map((i) => String(i.jobId));
    },
    async dequeue(id, worker, jobId) { await db.send(new DeleteCommand({ TableName: table, Key: { pk: nativePartition(id, worker), sk: `QUEUE#${jobId}` } })); },
  };
}


export interface NativeMode {
  enabled: boolean;
  revision: number;
  routingVersion?: number;
  triggers?: NativeTrigger[];
}

/** Per-installation API key/subscription choice, not part of the worker's heartbeat row. */
export interface NativeModeStore {
  enabled(installationId: number, workerId: string): Promise<boolean>;
  snapshot(installationId: number, workerId: string): Promise<NativeMode>;
  /** Commit only if neither dispatch nor the worker changed since the idle checks. */
  setEnabled(installationId: number, workerId: string, enabled: boolean, expected: { revision: number; workerVersion: number | null; routingVersion?: number; triggers?: NativeTrigger[] }): Promise<boolean>;
}

export function createNativeModeStore(
  table: string,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
): NativeModeStore {
  const key = (installationId: number, workerId: string) => ({ pk: nativePartition(installationId, workerId), sk: 'MODE' });
  async function snapshot(installationId: number, workerId: string) {
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: key(installationId, workerId), ConsistentRead: true }));
    return {
      enabled: Item?.enabled === true, revision: Number(Item?.revision ?? 0),
      routingVersion: Number(Item?.routingVersion ?? 0),
      ...(Array.isArray(Item?.triggers) ? { triggers: Item.triggers as NativeTrigger[] } : {}),
    };
  }
  return {
    snapshot,
    async enabled(installationId, workerId) { return (await snapshot(installationId, workerId)).enabled; },
    async setEnabled(installationId, workerId, enabled, expected) {
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Put: {
            TableName: table,
            Item: { ...key(installationId, workerId), enabled, revision: expected.revision + 1,
              routingVersion: (expected.routingVersion ?? 0) + 1,
              ...(expected.triggers ? { triggers: expected.triggers } : {}), updatedAt: new Date().toISOString() },
            ConditionExpression: expected.revision === 0 ? 'attribute_not_exists(revision) OR revision = :revision' : 'revision = :revision',
            ExpressionAttributeValues: { ':revision': expected.revision },
          } },
          { ConditionCheck: {
            TableName: table, Key: { pk: nativePartition(installationId, workerId), sk: 'WORKER' },
            ConditionExpression: expected.workerVersion === null ? 'attribute_not_exists(pk)' : '#v = :v AND attribute_not_exists(active) AND attribute_not_exists(settling)',
            ...(expected.workerVersion === null ? {} : {
              ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': expected.workerVersion },
            }),
          } },
        ] }));
        return true;
      } catch (e) {
        if (e instanceof TransactionCanceledException && e.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) return false;
        throw e;
      }
    },
  };
}
