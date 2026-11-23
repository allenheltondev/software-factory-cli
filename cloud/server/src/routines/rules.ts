import { createHash } from 'node:crypto';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

export interface RoutineRule {
  id: string;
  repositoryId: number;
  repository: string;
  label: string;
  url: string;
  updatedAt: string;
  updatedBy: string;
}
export interface RoutineRuleStore {
  list(installationId: number): Promise<RoutineRule[]>;
  get(installationId: number, id: string): Promise<RoutineRule | null>;
  put(installationId: number, rule: RoutineRule): Promise<'stored' | 'uninstalled'>;
  remove(installationId: number, id: string): Promise<void>;
}
export const MAX_ROUTINES = 25;
export const routineLabel = (s: string) => s.trim().toLowerCase();
export const routineId = (repositoryId: number, label: string) =>
  createHash('sha256').update(`${repositoryId}\n${routineLabel(label)}`).digest('hex').slice(0, 32);
export const routineSecretName = (installationId: number, id: string) =>
  `updraft/tenants/${installationId}/routine-triggers/${id}`;

/** Permit only Anthropic's official per-routine fire endpoint, never an arbitrary URL. */
export function validRoutineUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 300) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'api.anthropic.com' && !u.port &&
      !u.username && !u.password && !u.search && !u.hash &&
      /^\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/.test(u.pathname) &&
      u.toString() === raw;
  } catch { return false; }
}
/** This is a *routine-specific trigger* token, not a Claude.ai session login. */
export const validRoutineToken = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 512 && /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(s);
function ruleOf(raw: Record<string, unknown> | undefined): RoutineRule | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.repositoryId !== 'number' ||
      typeof raw.repository !== 'string' || typeof raw.label !== 'string' ||
      !validRoutineUrl(raw.url) || typeof raw.updatedAt !== 'string' || typeof raw.updatedBy !== 'string') return null;
  return { id: raw.id, repositoryId: raw.repositoryId, repository: raw.repository,
    label: raw.label, url: raw.url, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy };
}
export function createDynamoRoutineRuleStore(tableName: string, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))): RoutineRuleStore {
  const key = (id: number, ruleId: string) => ({ pk: `TENANT#${id}`, sk: `ROUTINE#${ruleId}` });
  return {
    async list(id) {
      const result: RoutineRule[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'ROUTINE#' },
          ConsistentRead: true, ExclusiveStartKey,
        }));
        for (const raw of page.Items ?? []) { const rule = ruleOf(raw); if (rule) result.push(rule); }
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return result.sort((a,b) => a.repository.localeCompare(b.repository) || a.label.localeCompare(b.label));
    },
    async get(id, ruleId) {
      const out = await client.send(new GetCommand({ TableName: tableName, Key: key(id, ruleId), ConsistentRead: true }));
      return ruleOf(out.Item);
    },
    async put(id, rule) {
      try {
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: { TableName: tableName, Key: { pk: `TENANT#${id}`, sk: 'META' },
              ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :gone)',
              ExpressionAttributeValues: { ':gone': 'uninstalled' } } },
            { Put: { TableName: tableName, Item: { ...key(id, rule.id), ...rule } } },
          ],
        }));
        return 'stored';
      } catch (err) {
        if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return 'uninstalled';
        throw err;
      }
    },
    async remove(id, ruleId) {
      await client.send(new DeleteCommand({ TableName: tableName, Key: key(id, ruleId) }));
    },
  };
}
