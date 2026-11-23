import { createHash, randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { LaunchRequest } from '../jobs/launch.js';

export interface ManagedSession {
  generation: string;
  imageVersion: string;
  microvmId?: string;
  requestedAt: number;
}

export interface WaitingClaudeJob {
  id: string;
  request: Pick<LaunchRequest, 'installationId' | 'deliveryId' | 'eventName' | 'appBot'>;
  eventKey: string;
  expiresAt: number;
  status: 'waiting' | 'started' | 'canceled';
  jobId?: string;
  reason?: string;
}

export const managedWorkerId = (id: number) => `managed-${id}`;
const partition = (id: number) => `TENANT#${id}`;
const waitKey = (id: number, job: string) => ({ pk: partition(id), sk: `CLAUDE_WAIT#${job}` });
const sessionKey = (id: number) => ({ pk: partition(id), sk: 'CLAUDE_SESSION' });
export const waitingId = (installationId: number, deliveryId: string) =>
  `job_${createHash('sha256').update(JSON.stringify([installationId, deliveryId, 'claude-wait'])).digest('base64url').slice(0, 16)}`;

export function createClaudeSessions(table: string, db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })) {
  async function putIf(input: ConstructorParameters<typeof PutCommand>[0]) {
    try { await db.send(new PutCommand(input)); return true; }
    catch (error) { if (error instanceof ConditionalCheckFailedException) return false; throw error; }
  }
  async function read<T>(key: { pk: string; sk: string }): Promise<T | undefined> {
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    return Item as T | undefined;
  }
  return {
    session: (id: number) => read<ManagedSession>(sessionKey(id)),
    async requestSession(id: number, previous: ManagedSession | undefined, imageVersion: string, now = Date.now()) {
      const session: ManagedSession = { generation: randomUUID(), imageVersion, requestedAt: now };
      const won = await putIf({ TableName: table, Item: { ...sessionKey(id), ...session },
        ConditionExpression: previous ? 'generation = :g' : 'attribute_not_exists(pk)',
        ...(previous ? { ExpressionAttributeValues: { ':g': previous.generation } } : {}) });
      return won ? session : undefined;
    },
    async bind(id: number, generation: string, microvmId: string) {
      await db.send(new UpdateCommand({ TableName: table, Key: sessionKey(id),
        UpdateExpression: 'SET microvmId = :vm',
        ConditionExpression: 'generation = :g AND (attribute_not_exists(microvmId) OR microvmId = :vm)',
        ExpressionAttributeValues: { ':vm': microvmId, ':g': generation } }));
    },
    async park(request: WaitingClaudeJob['request'], eventKey: string, now = Date.now()) {
      const id = waitingId(request.installationId, request.deliveryId);
      const expiresAt = now + 24 * 60 * 60_000;
      const item: WaitingClaudeJob = { id, request, eventKey, expiresAt, status: 'waiting' };
      const created = await putIf({ TableName: table, Item: { ...waitKey(request.installationId, id), ...item, ttl: Math.ceil(expiresAt / 1000) },
        ConditionExpression: 'attribute_not_exists(pk)' });
      return { id, created };
    },
    get: (id: number, job: string) => read<WaitingClaudeJob>(waitKey(id, job)),
    async pending(id: number) {
      const pending: WaitingClaudeJob[] = [];
      let cursor: ConstructorParameters<typeof QueryCommand>[0]['ExclusiveStartKey'];
      do {
        const page = await db.send(new QueryCommand({ TableName: table, ConsistentRead: true, KeyConditionExpression: 'pk = :p AND begins_with(sk, :q)',
          FilterExpression: '#status = :waiting AND expiresAt > :now', Limit: 50, ExclusiveStartKey: cursor,
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':p': partition(id), ':q': 'CLAUDE_WAIT#', ':waiting': 'waiting', ':now': Date.now() } }));
        pending.push(...(page.Items ?? []) as WaitingClaudeJob[]);
        cursor = page.LastEvaluatedKey;
      } while (cursor && pending.length === 0);
      return pending.slice(0, 3);
    },
    async finish(id: number, job: string, status: 'started' | 'canceled', detail: string) {
      try {
        await db.send(new UpdateCommand({ TableName: table, Key: waitKey(id, job), ConditionExpression: '#status = :waiting',
          UpdateExpression: status === 'started' ? 'SET #status = :status, jobId = :detail' : 'SET #status = :status, reason = :detail',
          ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':waiting': 'waiting', ':status': status, ':detail': detail } }));
      } catch (error) { if (!(error instanceof ConditionalCheckFailedException)) throw error; }
    },
  };
}

export type ClaudeSessions = ReturnType<typeof createClaudeSessions>;
