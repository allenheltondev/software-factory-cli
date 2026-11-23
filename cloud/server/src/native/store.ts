import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
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
