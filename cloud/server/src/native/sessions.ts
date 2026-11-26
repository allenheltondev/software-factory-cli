import { imagePolicyKey, type ImagePolicy } from './image-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { nativePartition, type NativeMode, type Worker } from './store.js';
import { STARTUP_MS } from './admission.js';
import type { LaunchRequest } from '../jobs/launch.js';

export type RetirementReason = 'reconnect' | 'idle' | 'lifetime' | 'vm-ended' | 'expired' | 'suspended' | 'worker-lost' | 'disabled' | 'startup-failed' | 'image-revoked' | 'image-blocked';

export interface ManagedSession {
  generation: string;
  imageVersion: string;
  microvmId?: string;
  requestedAt: number;
  startupDeadline?: number;
  readyAt?: number;
  retiring?: boolean;
  /**
   * Why it was sealed, as specifically as cleanup could tell (#176). `lifetime` is the eight-hour
   * hard limit; `vm-ended` a VM that AWS no longer runs before that. `expired` is either, and is
   * only on records sealed before the two were told apart.
   */
  retirementReason?: RetirementReason;
  admissionRequired?: boolean;
}

export interface WaitingClaudeJob {
  id: string;
  request: Pick<LaunchRequest, 'installationId' | 'deliveryId' | 'eventName' | 'appBot'>;
  eventKey: string;
  expiresAt: number;
  status: 'waiting' | 'started' | 'canceled';
  jobId?: string;
  reason?: string;
  /** The issue the job is for: where a later sign-in notice is commented (#176). Absent on older records. */
  subject?: { repository: string; repositoryId: number; issue: number };
  /** When the one sign-in notice for this job was claimed (at park, or later by waiting-notice.ts). */
  noticeAt?: number;
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
      const session: ManagedSession = { generation: randomUUID(), imageVersion, requestedAt: now, startupDeadline: now + STARTUP_MS, admissionRequired: true };
      const won = await putIf({ TableName: table, Item: { ...sessionKey(id), ...session },
        ConditionExpression: previous ? 'generation = :g' : 'attribute_not_exists(pk)',
        ...(previous ? { ExpressionAttributeValues: { ':g': previous.generation } } : {}) });
      return won ? session : undefined;
    },
    async bind(id: number, generation: string, microvmId: string) {
      await db.send(new UpdateCommand({ TableName: table, Key: sessionKey(id),
        UpdateExpression: 'SET microvmId = :vm',
        ConditionExpression: 'generation = :g AND attribute_not_exists(retiring) AND (attribute_not_exists(microvmId) OR microvmId = :vm)',
        ExpressionAttributeValues: { ':vm': microvmId, ':g': generation } }));
    },
    async ready(id: number, generation: string, now = Date.now()) {
      try {
        await db.send(new UpdateCommand({ TableName: table, Key: sessionKey(id),
          UpdateExpression: 'SET readyAt = if_not_exists(readyAt, :now)',
          ConditionExpression: 'generation = :g AND attribute_not_exists(retiring)',
          ExpressionAttributeValues: { ':g': generation, ':now': now } }));
      } catch (err) { if (!(err instanceof ConditionalCheckFailedException)) throw err; }
    },
    /** Seal the exact generation AND its dispatch revision, including a missing worker row. */
    async retire(id: number, session: ManagedSession, mode: NativeMode, worker: Worker | null, reason: NonNullable<ManagedSession['retirementReason']> = 'reconnect', emergency?: ImagePolicy) {
      if (emergency && (emergency.state !== 'revoked' || emergency.imageVersion !== session.imageVersion || emergency.revision < 1)) return false;
      const fenced: Worker = { ...(worker ?? { version: 0, installationId: id, workerId: managedWorkerId(id), session: session.generation,
        imageVersion: session.imageVersion, workerVersion: 'unregistered', auth: 'unavailable', heartbeatAt: 0 }),
        microvmId: session.microvmId ?? 'mvm-pending', version: (worker?.version ?? 0) + 1, fenced: true };
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: table, Key: sessionKey(id), UpdateExpression: 'SET retiring = :yes, retirementReason = :reason',
            ConditionExpression: 'generation = :g AND attribute_not_exists(retiring)',
            ExpressionAttributeValues: { ':g': session.generation, ':yes': true, ':reason': reason } } },
          { Update: { TableName: table, Key: { pk: nativePartition(id, managedWorkerId(id)), sk: 'MODE' },
            UpdateExpression: 'SET revision = :next, routingVersion = :routing',
            ConditionExpression: mode.revision === 0 ? 'attribute_not_exists(revision) OR revision = :revision' : 'revision = :revision',
            ExpressionAttributeValues: { ':revision': mode.revision, ':next': mode.revision + 1, ':routing': (mode.routingVersion ?? 0) + 1 } } },
          { Put: { TableName: table, Item: { pk: nativePartition(id, managedWorkerId(id)), sk: 'WORKER', ...fenced },
            ConditionExpression: worker ? (emergency ? '#v = :v' : '#v = :v AND attribute_not_exists(active) AND attribute_not_exists(settling)') : 'attribute_not_exists(pk)',
            ...(worker ? { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': worker.version } } : {}) } },
          ...(emergency ? [{ ConditionCheck: { TableName: table, Key: imagePolicyKey(session.imageVersion),
            ConditionExpression: 'revision = :revision AND #state = :revoked',
            ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':revision': emergency.revision, ':revoked': 'revoked' },
          } }] : []),
        ] }));
        return true;
      } catch (err) {
        if (err instanceof TransactionCanceledException && err.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) return false;
        throw err;
      }
    },
    /**
     * Claims the one sign-in notice of a waiting job: true for exactly one caller, while it still
     * waits. Whoever wins comments; a failed comment gives the claim back (`releaseNotice`).
     */
    async claimNotice(id: number, job: string, now = Date.now()) {
      try {
        await db.send(new UpdateCommand({ TableName: table, Key: waitKey(id, job), UpdateExpression: 'SET noticeAt = :now',
          ConditionExpression: '#status = :waiting AND attribute_not_exists(noticeAt) AND expiresAt > :now',
          ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':waiting': 'waiting', ':now': now } }));
        return true;
      } catch (error) { if (error instanceof ConditionalCheckFailedException) return false; throw error; }
    },
    async releaseNotice(id: number, job: string, at: number) {
      try {
        await db.send(new UpdateCommand({ TableName: table, Key: waitKey(id, job), UpdateExpression: 'REMOVE noticeAt',
          ConditionExpression: 'noticeAt = :at', ExpressionAttributeValues: { ':at': at } }));
      } catch (error) { if (!(error instanceof ConditionalCheckFailedException)) throw error; }
    },
    /** Waiting jobs of the installation that have no sign-in notice yet and know their issue (bounded). */
    async unnoticed(id: number, now = Date.now()) {
      const found: WaitingClaudeJob[] = [];
      let cursor: ConstructorParameters<typeof QueryCommand>[0]['ExclusiveStartKey'];
      let pages = 0;
      do {
        const page = await db.send(new QueryCommand({ TableName: table, ConsistentRead: true, KeyConditionExpression: 'pk = :p AND begins_with(sk, :q)',
          FilterExpression: '#status = :waiting AND expiresAt > :now AND attribute_not_exists(noticeAt) AND attribute_exists(subject)', Limit: 100, ExclusiveStartKey: cursor,
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':p': partition(id), ':q': 'CLAUDE_WAIT#', ':waiting': 'waiting', ':now': now } }));
        found.push(...(page.Items ?? []) as WaitingClaudeJob[]);
        cursor = page.LastEvaluatedKey;
      } while (cursor && ++pages < 10 && found.length < 25);
      return found.slice(0, 25);
    },
    async park(request: WaitingClaudeJob['request'], eventKey: string, now = Date.now(), subject?: WaitingClaudeJob['subject']) {
      const id = waitingId(request.installationId, request.deliveryId);
      const expiresAt = now + 24 * 60 * 60_000;
      const item: WaitingClaudeJob = { id, request, eventKey, expiresAt, status: 'waiting', ...(subject ? { subject } : {}) };
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
