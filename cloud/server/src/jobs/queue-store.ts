/**
 * Where the Cloud admission queue (jobs/queue.ts) is kept, in UpdraftTable beside the tenant's jobs:
 *
 *   TENANT#<installId>   QUEUE#<jobId>                     one queued job: what started it, its state (TTL 30 days past its end)
 *   TENANT#<installId>   QSUBJ#<repositoryId>#<i|p><n>     the issue's or pull request's waiting entry, while one waits (deduplication)
 *   TENANT#<installId>   QUEUEDEPTH                        how many of the tenant's entries wait (the per-tenant bound)
 *   PLATFORM#QUEUE       <enqueuedAt>#<installId>#<jobId>  a waiting entry, oldest first: what the dispatcher reads
 *
 * An entry is waiting (`queued`, or `admitting` while a dispatcher holds it) from its enqueue until
 * one settle moves it to an end state. The enqueue and the settle are each one transaction over the
 * entry, its subject's lock, the tenant's depth and the platform index, so the depth never drifts
 * and a subject never has two waiting entries. Every other change is a versioned put of the entry
 * alone: two dispatchers, or a dispatcher and a webhook, never both win the same transition.
 *
 * Everything in the TENANT# partition is swept with the tenant on uninstall (store.ts); an index
 * entry whose tenant entry is gone is dropped by the dispatcher.
 */
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

/** Waiting: `queued` (for the dispatcher) or `admitting` (a dispatcher holds it). The rest are ends. */
export type QueueState = 'queued' | 'admitting' | 'admitted' | 'canceled' | 'refused' | 'expired';
export const WAITING_STATES: ReadonlySet<QueueState> = new Set(['queued', 'admitting']);
export const isWaiting = (e: Pick<QueueEntry, 'state'>) => WAITING_STATES.has(e.state);

/**
 * Why an entry waits: the tenant's concurrency is full, the platform's is, or earlier queued work of
 * the tenant goes first (FIFO). Each is a temporary capacity wait, never a budget or a refusal.
 */
export type QueueWaitReason = 'concurrent_jobs' | 'platform_concurrency' | 'queue_ahead' | 'retrying';

export interface QueueEntry {
  /** The job's stable id: the queued job is admitted under it, and its console link works throughout. */
  jobId: string;
  installationId: number;
  repository: string;
  repositoryId: number;
  issue?: number;
  pullRequest?: number;
  workflowIssue?: number;
  /** The event to admit: its GitHub delivery, kind and action, and where its body is kept. */
  deliveryId: string;
  eventName: string;
  action?: string;
  eventKey: string;
  label?: string;
  sender?: string;
  appBot?: string;
  /** The pull request head the event was about (a push or a check suite): stale once the pull request moves on. */
  headSha?: string;
  /** The execution route chosen at enqueue (`standard`, or the subscription worker's id). A change refuses the entry, never reroutes it. */
  route: string;
  /** The config version active at enqueue (provenance); admission checks the version active then. */
  configVersion: number;
  reason: QueueWaitReason;
  state: QueueState;
  /** Epoch ms. */
  enqueuedAt: number;
  /** Past this, a waiting entry is expired rather than admitted. */
  expiresAt: number;
  /** Admission attempts made (a dispatcher took it); bounded, with backoff. */
  attempts: number;
  /** Waits in a row for something outside it that backs off (an offline worker, the kill switch): 30 s doubling to 15 min. Never attempts. */
  waits?: number;
  /** Not looked at again before this (backoff after a failed attempt). */
  nextAttemptAt: number;
  /** While `admitting`: the dispatcher's lease; past it, another may take the entry. */
  admittingUntil?: number;
  /** Deliveries folded into it (the first, then relabels, redeliveries and later pull request events). */
  deliveries: number;
  lastDeliveryAt?: number;
  /**
   * What the queue says on GitHub (repositories.R.notifications, #173). quiet: the issue's one
   * live status comment, which the run takes over, and a separate comment only when a person has
   * to act. verbose, or absent (an entry queued before #173): the separate acknowledgement.
   */
  notifications?: 'quiet' | 'verbose';
  /** Quiet: the separate "please act" comment of a refused or expired entry was posted. */
  actPosted?: true;
  /** The acknowledgement comment on GitHub, and the state it last showed. */
  commentId?: number;
  commentState?: QueueState;
  /** How it ended. */
  outcome?: { at: number; reason: string; message: string; nextAction?: string; by?: string; jobId?: string };
  /** Optimistic concurrency: +1 on every write. */
  version: number;
}

export type EnqueueResult =
  | { result: 'queued'; entry: QueueEntry }
  /** The subject already has a waiting entry: this delivery is folded into it (no new job, no new comment). */
  | { result: 'joined'; entry: QueueEntry }
  /** The tenant's queue is at its bound. */
  | { result: 'full' };

export interface QueueIndexItem {
  installationId: number;
  jobId: string;
  enqueuedAt: number;
}

export interface QueueStore {
  /**
   * Adds a waiting entry, unless its subject already has one (`joined`, that entry) or the
   * tenant's depth is at `maxDepth` (`full`). Safe to repeat with the same entry: a retried
   * enqueue whose first try committed finds its own entry and joins it.
   */
  enqueue(entry: QueueEntry, maxDepth: number): Promise<EnqueueResult>;
  get(installationId: number, jobId: string): Promise<QueueEntry | null>;
  /** The subject's waiting entry, if any. */
  waitingFor(installationId: number, repositoryId: number, subject: { issue?: number; pullRequest?: number }): Promise<QueueEntry | null>;
  /** How many of the tenant's entries wait. */
  depth(installationId: number): Promise<number>;
  /** The tenant's entries, newest first (waiting and ended, while kept). */
  list(installationId: number, limit: number): Promise<QueueEntry[]>;
  /** Waiting entries of every tenant, oldest first. */
  listWaiting(limit: number): Promise<QueueIndexItem[]>;
  /** An index entry whose tenant entry is gone (uninstalled, swept). */
  dropIndex(item: QueueIndexItem): Promise<void>;
  /**
   * Writes `next` if the stored entry is still at `previous.version`: a waiting entry that stays
   * waiting, or any entry whose state does not change (its comment). False: it moved on.
   */
  update(next: QueueEntry, previous: QueueEntry): Promise<boolean>;
  /** Moves a waiting entry to an end state, with its lock, depth and index, if still at `previous.version`. */
  settle(next: QueueEntry, previous: QueueEntry): Promise<boolean>;
}

/** Ended entries are kept this long for the console. */
export const QUEUE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const subjectOf = (e: Pick<QueueEntry, 'issue' | 'pullRequest'>) => (e.issue !== undefined ? `i${e.issue}` : `p${e.pullRequest}`);
const indexSk = (e: Pick<QueueEntry, 'enqueuedAt' | 'installationId' | 'jobId'>) => `${new Date(e.enqueuedAt).toISOString()}#${e.installationId}#${e.jobId}`;
const entryTtl = (e: QueueEntry) => Math.ceil(((isWaiting(e) ? e.expiresAt : (e.outcome?.at ?? e.expiresAt)) + QUEUE_RETENTION_MS) / 1000);

const updatable = (next: QueueEntry, previous: QueueEntry) => (isWaiting(previous) && isWaiting(next)) || next.state === previous.state;

function check(next: QueueEntry, previous: QueueEntry) {
  if (next.jobId !== previous.jobId || next.installationId !== previous.installationId || next.enqueuedAt !== previous.enqueuedAt) {
    throw new Error('a queue entry keeps its identity');
  }
}

export function createMemoryQueueStore(): QueueStore & { dump(): QueueEntry[] } {
  const entries = new Map<string, QueueEntry>();
  const locks = new Map<string, string>();
  const depth = new Map<number, number>();
  const index = new Map<string, QueueIndexItem>();
  const k = (id: number, jobId: string) => `${id}/${jobId}`;
  const lockKey = (e: Pick<QueueEntry, 'installationId' | 'repositoryId' | 'issue' | 'pullRequest'>) => `${e.installationId}/${e.repositoryId}/${subjectOf(e)}`;
  const clone = <X>(x: X): X => structuredClone(x);
  return {
    async enqueue(entry, maxDepth) {
      const own = entries.get(k(entry.installationId, entry.jobId));
      if (own) return { result: 'joined', entry: clone(own) };
      const held = locks.get(lockKey(entry));
      if (held) {
        const existing = entries.get(k(entry.installationId, held));
        if (existing) return { result: 'joined', entry: clone(existing) };
      }
      if ((depth.get(entry.installationId) ?? 0) >= maxDepth) return { result: 'full' };
      const stored = { ...clone(entry), version: 1 };
      entries.set(k(entry.installationId, entry.jobId), stored);
      locks.set(lockKey(entry), entry.jobId);
      depth.set(entry.installationId, (depth.get(entry.installationId) ?? 0) + 1);
      index.set(indexSk(entry), { installationId: entry.installationId, jobId: entry.jobId, enqueuedAt: entry.enqueuedAt });
      return { result: 'queued', entry: clone(stored) };
    },
    async get(id, jobId) {
      const e = entries.get(k(id, jobId));
      return e ? clone(e) : null;
    },
    async waitingFor(id, repositoryId, subject) {
      const held = locks.get(lockKey({ installationId: id, repositoryId, ...subject }));
      const e = held ? entries.get(k(id, held)) : undefined;
      return e && isWaiting(e) ? clone(e) : null;
    },
    async depth(id) {
      return depth.get(id) ?? 0;
    },
    async list(id, limit) {
      return [...entries.values()].filter((e) => e.installationId === id).sort((a, b) => b.enqueuedAt - a.enqueuedAt || b.jobId.localeCompare(a.jobId)).slice(0, limit).map(clone);
    },
    async listWaiting(limit) {
      return [...index.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([, v]) => ({ ...v }));
    },
    async dropIndex(item) {
      index.delete(indexSk(item));
    },
    async update(next, previous) {
      check(next, previous);
      const cur = entries.get(k(previous.installationId, previous.jobId));
      if (!cur || cur.version !== previous.version || !updatable(next, previous)) return false;
      entries.set(k(next.installationId, next.jobId), { ...clone(next), version: previous.version + 1 });
      return true;
    },
    async settle(next, previous) {
      check(next, previous);
      const cur = entries.get(k(previous.installationId, previous.jobId));
      if (!cur || cur.version !== previous.version || !isWaiting(cur) || isWaiting(next)) return false;
      entries.set(k(next.installationId, next.jobId), { ...clone(next), version: previous.version + 1 });
      if (locks.get(lockKey(cur)) === cur.jobId) locks.delete(lockKey(cur));
      depth.set(cur.installationId, Math.max(0, (depth.get(cur.installationId) ?? 0) - 1));
      index.delete(indexSk(cur));
      return true;
    },
    dump: () => [...entries.values()].map(clone),
  };
}

export function createDynamoQueueStore(tableName: string, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))): QueueStore {
  const T = tableName;
  const entryKey = (id: number, jobId: string) => ({ pk: `TENANT#${id}`, sk: `QUEUE#${jobId}` });
  const lockKey = (e: Pick<QueueEntry, 'installationId' | 'repositoryId' | 'issue' | 'pullRequest'>) => ({ pk: `TENANT#${e.installationId}`, sk: `QSUBJ#${e.repositoryId}#${subjectOf(e)}` });
  const depthKey = (id: number) => ({ pk: `TENANT#${id}`, sk: 'QUEUEDEPTH' });
  const indexKey = (e: Pick<QueueEntry, 'enqueuedAt' | 'installationId' | 'jobId'>) => ({ pk: 'PLATFORM#QUEUE', sk: indexSk(e) });
  const live = (i: Record<string, unknown>) => typeof i.ttl !== 'number' || i.ttl * 1000 > Date.now();
  const toEntry = (i: Record<string, unknown>): QueueEntry => {
    const { pk: _p, sk: _s, ttl: _t, ...rest } = i;
    return rest as unknown as QueueEntry;
  };
  const getEntry = async (id: number, jobId: string) => {
    const out = await client.send(new GetCommand({ TableName: T, Key: entryKey(id, jobId), ConsistentRead: true }));
    return out.Item && live(out.Item) ? toEntry(out.Item) : null;
  };
  const versioned = (next: QueueEntry, previous: QueueEntry) => ({
    TableName: T,
    Item: { ...entryKey(next.installationId, next.jobId), ...next, version: previous.version + 1, ttl: entryTtl(next) },
    // The version proves the stored entry is `previous`, whose state the caller checked.
    ConditionExpression: '#v = :v',
    ExpressionAttributeNames: { '#v': 'version' },
    ExpressionAttributeValues: { ':v': previous.version },
  });

  return {
    async enqueue(entry, maxDepth) {
      const stored: QueueEntry = { ...entry, version: 1 };
      const lockTtl = Math.ceil((entry.expiresAt + 24 * 3600 * 1000) / 1000);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: T, Item: { ...entryKey(entry.installationId, entry.jobId), ...stored, ttl: entryTtl(stored) }, ConditionExpression: 'attribute_not_exists(pk)' } },
              {
                // A lock left past its time (an entry that vanished) is free again.
                Put: {
                  TableName: T,
                  Item: { ...lockKey(entry), jobId: entry.jobId, ttl: lockTtl },
                  ConditionExpression: 'attribute_not_exists(pk) OR #ttl < :now',
                  ExpressionAttributeNames: { '#ttl': 'ttl' },
                  ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
                },
              },
              {
                Update: {
                  TableName: T,
                  Key: depthKey(entry.installationId),
                  UpdateExpression: 'ADD #depth :one',
                  ConditionExpression: 'attribute_not_exists(#depth) OR #depth < :max',
                  ExpressionAttributeNames: { '#depth': 'depth' },
                  ExpressionAttributeValues: { ':one': 1, ':max': maxDepth },
                },
              },
              { Put: { TableName: T, Item: { ...indexKey(entry), installationId: entry.installationId, jobId: entry.jobId, enqueuedAt: entry.enqueuedAt, ttl: entryTtl(stored) } } },
            ],
          }),
        );
        return { result: 'queued', entry: stored };
      } catch (err) {
        if (!(err instanceof TransactionCanceledException)) throw err;
        const failed = (i: number) => err.CancellationReasons?.[i]?.Code === 'ConditionalCheckFailed';
        if (failed(0)) {
          // This very entry committed before (a retried enqueue).
          const own = await getEntry(entry.installationId, entry.jobId);
          if (own) return { result: 'joined', entry: own };
        }
        if (failed(1)) {
          const lock = await client.send(new GetCommand({ TableName: T, Key: lockKey(entry), ConsistentRead: true }));
          const held = typeof lock.Item?.jobId === 'string' ? await getEntry(entry.installationId, lock.Item.jobId) : null;
          if (held) return { result: 'joined', entry: held };
          // A lock with no entry (swept): not a reason to drop the delivery; the caller redelivers.
          throw new Error('the subject queue lock is held by a missing entry; retry', { cause: err });
        }
        if (failed(2)) return { result: 'full' };
        throw err;
      }
    },
    get: getEntry,
    async waitingFor(id, repositoryId, subject) {
      const lock = await client.send(new GetCommand({ TableName: T, Key: lockKey({ installationId: id, repositoryId, ...subject }), ConsistentRead: true }));
      if (!lock.Item || !live(lock.Item) || typeof lock.Item.jobId !== 'string') return null;
      const e = await getEntry(id, lock.Item.jobId);
      return e && isWaiting(e) ? e : null;
    },
    async depth(id) {
      const out = await client.send(new GetCommand({ TableName: T, Key: depthKey(id), ConsistentRead: true }));
      return typeof out.Item?.depth === 'number' ? Math.max(0, out.Item.depth) : 0;
    },
    async list(id, limit) {
      const out: QueueEntry[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'QUEUE#' },
            ExclusiveStartKey: start,
          }),
        );
        for (const i of page.Items ?? []) if (live(i)) out.push(toEntry(i));
        start = page.LastEvaluatedKey;
      } while (start && out.length < 2_000);
      return out.sort((a, b) => b.enqueuedAt - a.enqueuedAt || b.jobId.localeCompare(a.jobId)).slice(0, limit);
    },
    async listWaiting(limit) {
      const out: QueueIndexItem[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': 'PLATFORM#QUEUE' },
            ConsistentRead: true,
            Limit: Math.min(limit - out.length, 500),
            ExclusiveStartKey: start,
          }),
        );
        for (const i of page.Items ?? []) {
          if (typeof i.jobId === 'string' && Number.isSafeInteger(i.installationId)) out.push({ installationId: Number(i.installationId), jobId: i.jobId, enqueuedAt: Number(i.enqueuedAt) });
        }
        start = page.LastEvaluatedKey;
      } while (start && out.length < limit);
      return out;
    },
    async dropIndex(item) {
      await client.send(new DeleteCommand({ TableName: T, Key: indexKey(item) }));
    },
    async update(next, previous) {
      check(next, previous);
      if (!updatable(next, previous)) throw new Error('an update keeps a queue entry waiting, or its state as it is; settle ends it');
      try {
        await client.send(new PutCommand(versioned(next, previous)));
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
    async settle(next, previous) {
      check(next, previous);
      if (isWaiting(next) || !isWaiting(previous)) throw new Error('a settle ends a waiting queue entry');
      const attempt = (withLock: boolean) =>
        client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: versioned(next, previous) },
              // Only this entry's lock (or none): never another entry's.
              ...(withLock
                ? [{ Delete: { TableName: T, Key: lockKey(previous), ConditionExpression: 'attribute_not_exists(pk) OR jobId = :job', ExpressionAttributeValues: { ':job': previous.jobId } } }]
                : []),
              { Update: { TableName: T, Key: depthKey(previous.installationId), UpdateExpression: 'ADD #depth :minus', ExpressionAttributeNames: { '#depth': 'depth' }, ExpressionAttributeValues: { ':minus': -1 } } },
              { Delete: { TableName: T, Key: indexKey(previous) } },
            ],
          }),
        );
      for (const withLock of [true, false]) {
        try {
          await attempt(withLock);
          return true;
        } catch (err) {
          if (!(err instanceof TransactionCanceledException)) throw err;
          if (err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return false;
          // The lock is another entry's (this one's ran out and was taken): settle without it.
          if (!(withLock && err.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed')) throw err;
        }
      }
      return false;
    },
  };
}
