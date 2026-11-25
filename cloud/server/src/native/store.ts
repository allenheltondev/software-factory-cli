import { imageDecision, imagePolicyKey, type ImagePolicy } from './image-policy.js';
import type { NativeTrigger } from './route.js';
import type { Job } from '../store/store.js';
import { workflowAdmissionChecks } from '../jobs/workflow-gate.js';
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
  lastWorkAt?: number;
  active?: { jobId: string; until: number };
  /** Active lease durably retired; blocks dispatch until quota release is confirmed. */
  settling?: { jobId: string };
  fenced?: boolean;
}
export interface NativeStore {
  get(installationId: number, workerId: string): Promise<Worker | null>;
  /** Compare-and-swap; never expire this row using DynamoDB TTL. */
  put(worker: Worker, previousVersion: number | null): Promise<boolean>;
  /** Atomically take a queued, unfenced job and this idle worker version, attach its VM,
   * and remove the queue entry. A stop/pause winning the transaction admits nothing. */
  assign(job: Job, worker: Worker, at: number, until: number, policy?: ImagePolicy): Promise<boolean>;
  rebindQueued?(job: Job, route: import('./route.js').NativeRoute, tokenHash: string): Promise<boolean>;
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
    async rebindQueued(job, route, tokenHash) {
      if (!job.native?.generation || !route.generation || job.native.workerId !== route.workerId || job.installationId !== route.installationId) return false;
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: table, Key: { pk: `TENANT#${job.installationId}`, sk: 'CLAUDE_SESSION' },
            ConditionExpression: 'generation = :g AND microvmId = :vm AND imageVersion = :image AND attribute_not_exists(retiring)',
            ExpressionAttributeValues: { ':g': route.generation, ':vm': route.microvmId, ':image': route.imageVersion } } },
          { Update: { TableName: table, Key: { pk: `JOB#${job.jobId}`, sk: 'META' },
            UpdateExpression: 'SET native.generation = :next, imageVersion = :image, tokenHash = :token',
            ConditionExpression: 'native.generation = :old AND tokenHash = :previous AND attribute_not_exists(microvmId) AND attribute_not_exists(startedAt) AND attribute_not_exists(stopRequestedAt) AND #status = :launched',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':next': route.generation, ':old': job.native.generation, ':image': route.imageVersion, ':token': tokenHash, ':previous': job.tokenHash, ':launched': 'launched' } } },
        ] }));
        return true;
      } catch (error) {
        if (error instanceof TransactionCanceledException && error.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) return false;
        throw error;
      }
    },
    async queued(id, worker) {
      const { Items } = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :q)',
        ExpressionAttributeValues: { ':p': nativePartition(id, worker), ':q': 'QUEUE#' }, ConsistentRead: true, Limit: 100 }));
      return (Items ?? []).map((i) => String(i.jobId));
    },
    async assign(job, worker, at, until, policy) {
      if (policy && (policy.imageVersion !== worker.imageVersion || imageDecision(policy, worker.workerVersion) !== 'approved')) return false;
      if (!job.native || job.installationId !== worker.installationId || job.native.workerId !== worker.workerId || job.imageVersion !== worker.imageVersion) return false;
      const next = { ...worker, version: worker.version + 1, lastWorkAt: at, active: { jobId: job.jobId, until } };
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: table, Item: { ...key(worker.installationId, worker.workerId), ...next },
            ConditionExpression: '#v = :v AND attribute_not_exists(active) AND attribute_not_exists(settling) AND attribute_not_exists(fenced)',
            ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': worker.version } } },
          { Update: { TableName: table, Key: { pk: `JOB#${job.jobId}`, sk: 'META' }, UpdateExpression: 'SET microvmId = :vm',
            ConditionExpression: 'installationId = :installation AND #status = :launched AND attribute_not_exists(stopRequestedAt) AND attribute_not_exists(microvmId) AND attribute_exists(launchingAt) AND expiresAt > :at AND imageVersion = :image' + (job.native.generation ? ' AND native.generation = :generation' : ''),
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':vm': worker.microvmId, ':installation': job.installationId, ':launched': 'launched', ':at': at, ':image': worker.imageVersion, ...(job.native.generation ? { ':generation': job.native.generation } : {}) } } },
          { Delete: { TableName: table, Key: { pk: nativePartition(worker.installationId, worker.workerId), sk: `QUEUE#${job.jobId}` },
            ConditionExpression: 'jobId = :job', ExpressionAttributeValues: { ':job': job.jobId } } },
          ...(policy ? [{ ConditionCheck: { TableName: table, Key: imagePolicyKey(worker.imageVersion),
            ConditionExpression: policy.revision === 0 ? 'attribute_not_exists(pk)' : 'revision = :revision AND #state = :approved',
            ...(policy.revision === 0 ? {} : { ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':revision': policy.revision, ':approved': 'approved' } }),
          } }] : []),
          ...workflowAdmissionChecks(table, job),
        ] }));
        return true;
      } catch (error) {
        if (!(error instanceof TransactionCanceledException) || !error.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) throw error;
        return false;
      }
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
  /**
   * Fence an idle worker before an owner's restart stops its VM, in one transaction: the worker
   * row (exactly this VM, unchanged since the idle checks, nothing active or settling) is fenced,
   * so no poll can claim work; and the mode's revision and routing version move on, so neither an
   * enqueue since the empty queue read nor a launch that read the old routing can queue a job.
   */
  fenceForRestart(installationId: number, workerId: string, expected: { revision: number; routingVersion?: number; workerVersion: number; microvmId: string }): Promise<boolean>;
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
    async fenceForRestart(installationId, workerId, expected) {
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: table, Key: key(installationId, workerId),
            UpdateExpression: 'SET revision = :next, routingVersion = :routing',
            ConditionExpression: expected.revision === 0 ? 'attribute_not_exists(revision) OR revision = :revision' : 'revision = :revision',
            ExpressionAttributeValues: { ':revision': expected.revision, ':next': expected.revision + 1, ':routing': (expected.routingVersion ?? 0) + 1 },
          } },
          { Update: {
            TableName: table, Key: { pk: nativePartition(installationId, workerId), sk: 'WORKER' },
            UpdateExpression: 'SET fenced = :fenced, #v = :next',
            ConditionExpression: '#v = :v AND microvmId = :vm AND attribute_not_exists(active) AND attribute_not_exists(settling)',
            ExpressionAttributeNames: { '#v': 'version' },
            ExpressionAttributeValues: { ':fenced': true, ':v': expected.workerVersion, ':next': expected.workerVersion + 1, ':vm': expected.microvmId },
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
