/**
 * Where workflows are kept (workflows/workflow.ts): their record, their timeline and, for the
 * reconciler, when each is due a look. In UpdraftTable, beside the tenant's jobs:
 *
 *   TENANT#<installId>   WORKFLOW#<workflowId>          the workflow (TTL 90 days from its last change)
 *   TENANT#<installId>   WFEV#<workflowId>#<eventId>    one timeline event, written once (TTL 90 days)
 *   TENANT#<installId>   WFPR#<repositoryId>#<pr>       which workflow a pull request belongs to (TTL 90 days)
 *   TENANT#<installId>   WFJOB#<jobId>                  which workflow a job belongs to (TTL 90 days)
 *   PLATFORM#WORKFLOW-DUE  <nextCheckAt>#<installId>#<workflowId>   a workflow the reconciler looks at then
 *
 * A save is conditional on the version it read, so two finishes (or a finish and the reconciler)
 * never overwrite each other's change: the loser reads again and reapplies (saveWithRetry).
 */
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Workflow, WorkflowEvent } from './workflow.js';

export interface WorkflowStore {
  getWorkflow(installationId: number, workflowId: string): Promise<Workflow | null>;
  /** Saves `next` if the stored record is still at `next.version - 1` (or absent, for version 1). False when it moved on. */
  saveWorkflow(next: Workflow, previous: Workflow | null): Promise<boolean>;
  /** Records an event once: a second call with the same id changes nothing. */
  addWorkflowEvent(installationId: number, workflowId: string, event: WorkflowEvent): Promise<void>;
  /** A workflow's events, oldest first (at most `limit`, the newest). */
  listWorkflowEvents(installationId: number, workflowId: string, limit: number): Promise<WorkflowEvent[]>;
  /** A tenant's workflows, most recently changed first. */
  listWorkflows(installationId: number, limit: number): Promise<Workflow[]>;
  linkPullRequest(installationId: number, repositoryId: number, pullRequest: number, workflowId: string): Promise<void>;
  workflowOfPullRequest(installationId: number, repositoryId: number, pullRequest: number): Promise<string | null>;
  linkJob(installationId: number, jobId: string, workflowId: string): Promise<void>;
  workflowOfJob(installationId: number, jobId: string): Promise<string | null>;
  /** Workflows due a look at or before `now` (epoch ms), oldest due first. */
  listDueWorkflows(now: number, limit: number): Promise<{ installationId: number; workflowId: string }[]>;
}

const TTL_DAYS = 90;
const byTime = (a: WorkflowEvent, b: WorkflowEvent) => a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id);
const ttl = (now = Date.now()) => Math.floor(now / 1000) + TTL_DAYS * 24 * 3600;

export function createMemoryWorkflowStore(): WorkflowStore & { dump(): { workflows: Workflow[]; events: Map<string, WorkflowEvent[]> } } {
  const workflows = new Map<string, Workflow>();
  const events = new Map<string, WorkflowEvent[]>();
  const prs = new Map<string, string>();
  const jobs = new Map<string, string>();
  const k = (id: number, wf: string) => `${id}/${wf}`;
  return {
    async getWorkflow(id, wf) {
      const w = workflows.get(k(id, wf));
      return w ? structuredClone(w) : null;
    },
    async saveWorkflow(next, previous) {
      const key = k(next.installationId, next.workflowId);
      const stored = workflows.get(key);
      if ((stored?.version ?? 0) !== (previous?.version ?? 0)) return false;
      workflows.set(key, structuredClone(next));
      return true;
    },
    async addWorkflowEvent(id, wf, event) {
      const list = events.get(k(id, wf)) ?? [];
      if (list.some((e) => e.id === event.id)) return;
      list.push(structuredClone(event));
      events.set(k(id, wf), list);
    },
    async listWorkflowEvents(id, wf, limit) {
      return (events.get(k(id, wf)) ?? [])
        .map((e) => structuredClone(e))
        .sort(byTime)
        .slice(-limit);
    },
    async listWorkflows(id, limit) {
      return [...workflows.values()]
        .filter((w) => w.installationId === id)
        .map((w) => structuredClone(w))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    },
    async linkPullRequest(id, repo, pr, wf) {
      if (!prs.has(`${id}/${repo}/${pr}`)) prs.set(`${id}/${repo}/${pr}`, wf);
    },
    async workflowOfPullRequest(id, repo, pr) {
      return prs.get(`${id}/${repo}/${pr}`) ?? null;
    },
    async linkJob(id, job, wf) {
      if (!jobs.has(`${id}/${job}`)) jobs.set(`${id}/${job}`, wf);
    },
    async workflowOfJob(id, job) {
      return jobs.get(`${id}/${job}`) ?? null;
    },
    async listDueWorkflows(now, limit) {
      return [...workflows.values()]
        .filter((w) => w.nextCheckAt !== undefined && Date.parse(w.nextCheckAt) <= now)
        .sort((a, b) => a.nextCheckAt!.localeCompare(b.nextCheckAt!))
        .slice(0, limit)
        .map((w) => ({ installationId: w.installationId, workflowId: w.workflowId }));
    },
    dump: () => ({ workflows: [...workflows.values()], events }),
  };
}

export function createDynamoWorkflowStore(tableName: string, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))): WorkflowStore {
  const T = tableName;
  const wfKey = (id: number, wf: string) => ({ pk: `TENANT#${id}`, sk: `WORKFLOW#${wf}` });
  const evKey = (id: number, wf: string, ev: string) => ({ pk: `TENANT#${id}`, sk: `WFEV#${wf}#${ev}` });
  const prKey = (id: number, repo: number, pr: number) => ({ pk: `TENANT#${id}`, sk: `WFPR#${repo}#${pr}` });
  const jobKey = (id: number, job: string) => ({ pk: `TENANT#${id}`, sk: `WFJOB#${job}` });
  const dueKey = (w: Pick<Workflow, 'installationId' | 'workflowId'>, at: string) => ({ pk: 'PLATFORM#WORKFLOW-DUE', sk: `${at}#${w.installationId}#${w.workflowId}` });
  const live = (i: Record<string, unknown>) => typeof i.ttl !== 'number' || i.ttl * 1000 > Date.now();
  const strip = <X>(i: Record<string, unknown>): X => {
    const { pk: _p, sk: _s, ttl: _t, ...rest } = i;
    return rest as X;
  };
  return {
    async getWorkflow(id, wf) {
      const out = await client.send(new GetCommand({ TableName: T, Key: wfKey(id, wf), ConsistentRead: true }));
      return out.Item && live(out.Item) ? strip<Workflow>(out.Item) : null;
    },
    async saveWorkflow(next, previous) {
      const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
        {
          Put: {
            TableName: T,
            Item: { ...wfKey(next.installationId, next.workflowId), ...next, ttl: ttl() },
            ...(previous
              ? { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': previous.version } }
              : { ConditionExpression: 'attribute_not_exists(pk)' }),
          },
        },
      ];
      // The due index follows the record: the old entry goes, the new one comes.
      if (previous?.nextCheckAt && previous.nextCheckAt !== next.nextCheckAt) items.push({ Delete: { TableName: T, Key: dueKey(previous, previous.nextCheckAt) } });
      if (next.nextCheckAt && next.nextCheckAt !== previous?.nextCheckAt) {
        items.push({ Put: { TableName: T, Item: { ...dueKey(next, next.nextCheckAt), installationId: next.installationId, workflowId: next.workflowId, ttl: ttl() } } });
      }
      try {
        await client.send(new TransactWriteCommand({ TransactItems: items }));
        return true;
      } catch (err) {
        if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return false;
        throw err;
      }
    },
    async addWorkflowEvent(id, wf, event) {
      try {
        await client.send(
          new PutCommand({ TableName: T, Item: { ...evKey(id, wf, event.id), ...event, ttl: ttl() }, ConditionExpression: 'attribute_not_exists(pk)' }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    },
    async listWorkflowEvents(id, wf, limit) {
      const out: WorkflowEvent[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': `WFEV#${wf}#` },
            ExclusiveStartKey: start,
          }),
        );
        for (const i of page.Items ?? []) if (live(i)) out.push(strip<WorkflowEvent>(i));
        start = page.LastEvaluatedKey;
      } while (start && out.length < 2_000);
      return out.sort(byTime).slice(-limit);
    },
    async listWorkflows(id, limit) {
      const out: Workflow[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'WORKFLOW#' },
            ExclusiveStartKey: start,
          }),
        );
        for (const i of page.Items ?? []) if (live(i)) out.push(strip<Workflow>(i));
        start = page.LastEvaluatedKey;
      } while (start && out.length < 5_000);
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
    },
    async linkPullRequest(id, repo, pr, wf) {
      try {
        await client.send(new PutCommand({ TableName: T, Item: { ...prKey(id, repo, pr), workflowId: wf, ttl: ttl() }, ConditionExpression: 'attribute_not_exists(pk)' }));
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    },
    async workflowOfPullRequest(id, repo, pr) {
      const out = await client.send(new GetCommand({ TableName: T, Key: prKey(id, repo, pr) }));
      return out.Item && live(out.Item) && typeof out.Item.workflowId === 'string' ? out.Item.workflowId : null;
    },
    async linkJob(id, job, wf) {
      try {
        await client.send(new PutCommand({ TableName: T, Item: { ...jobKey(id, job), workflowId: wf, ttl: ttl() }, ConditionExpression: 'attribute_not_exists(pk)' }));
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    },
    async workflowOfJob(id, job) {
      const out = await client.send(new GetCommand({ TableName: T, Key: jobKey(id, job) }));
      return out.Item && live(out.Item) && typeof out.Item.workflowId === 'string' ? out.Item.workflowId : null;
    },
    async listDueWorkflows(now, limit) {
      const page = await client.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :pk AND sk <= :now',
          ExpressionAttributeValues: { ':pk': 'PLATFORM#WORKFLOW-DUE', ':now': `${new Date(now).toISOString()}~` },
          Limit: limit,
        }),
      );
      return (page.Items ?? []).filter(live).map((i) => ({ installationId: Number(i.installationId), workflowId: String(i.workflowId) }));
    },
  };
}
