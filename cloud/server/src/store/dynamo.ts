import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { GitHubLink, Member, OAuthState, Store, Tenant } from './store.js';

/** The DynamoDB Store over UpdraftTable (layout in store.ts). */
export function createDynamoStore(tableName: string, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))): Store {
  const T = tableName;
  const userKey = (sub: string) => ({ pk: `USER#${sub}`, sk: 'PROFILE' });
  const ghKey = (id: number) => ({ pk: `GHUSER#${id}`, sk: 'LINK' });
  const tenantKey = (id: number) => ({ pk: `TENANT#${id}`, sk: 'META' });
  const memberKey = (id: number, sub: string) => ({ pk: `TENANT#${id}`, sk: `MEMBER#${sub}` });

  const toTenant = (item: Record<string, unknown>): Tenant => {
    const t: Tenant = {
      installationId: Number(item.installationId),
      accountId: Number(item.accountId),
      accountLogin: String(item.accountLogin),
      accountType: String(item.accountType),
      status: item.status === 'disabled' ? 'disabled' : 'active',
      createdAt: String(item.createdAt),
      createdBy: String(item.createdBy),
    };
    if (item.disabledReason === 'suspended' || item.disabledReason === 'uninstalled') t.disabledReason = item.disabledReason;
    if (typeof item.deleteAfter === 'number') t.deleteAfter = item.deleteAfter;
    return t;
  };
  const toMember = (item: Record<string, unknown>): Member => ({
    installationId: Number(item.installationId),
    sub: String(item.sub),
    role: item.role === 'owner' ? 'owner' : 'editor',
    githubLogin: String(item.githubLogin),
    addedAt: String(item.addedAt),
  });

  return {
    async putOAuthState(s) {
      await client.send(
        new PutCommand({
          TableName: T,
          Item: { pk: `OAUTH#${s.state}`, sk: 'STATE', ...s, ttl: Math.ceil(s.expiresAt / 1000) },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    },

    async consumeOAuthState(state) {
      // Delete-and-return in one call: a second use of the same state finds nothing.
      const out = await client.send(
        new DeleteCommand({ TableName: T, Key: { pk: `OAUTH#${state}`, sk: 'STATE' }, ReturnValues: 'ALL_OLD' }),
      );
      const a = out.Attributes;
      if (!a) return null;
      const s: OAuthState = {
        state: String(a.state),
        sub: String(a.sub),
        kind: a.kind === 'install' ? 'install' : 'link',
        expiresAt: Number(a.expiresAt),
      };
      if (typeof a.codeVerifier === 'string') s.codeVerifier = a.codeVerifier;
      return s;
    },

    async getLink(sub) {
      const out = await client.send(new GetCommand({ TableName: T, Key: userKey(sub) }));
      const i = out.Item;
      if (!i || typeof i.githubUserId !== 'number') return null;
      return { githubUserId: i.githubUserId, githubLogin: String(i.githubLogin), linkedAt: String(i.linkedAt) };
    },

    async link(sub, link: GitHubLink) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: T,
                  Item: { ...ghKey(link.githubUserId), sub },
                  ConditionExpression: 'attribute_not_exists(pk) OR #sub = :sub',
                  ExpressionAttributeNames: { '#sub': 'sub' },
                  ExpressionAttributeValues: { ':sub': sub },
                },
              },
              {
                Update: {
                  TableName: T,
                  Key: userKey(sub),
                  UpdateExpression: 'SET githubUserId = :id, githubLogin = :login, linkedAt = :at',
                  ConditionExpression: 'attribute_not_exists(githubUserId) OR githubUserId = :id',
                  ExpressionAttributeValues: { ':id': link.githubUserId, ':login': link.githubLogin, ':at': link.linkedAt },
                },
              },
            ],
          }),
        );
        return 'linked';
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const [gh, user] = err.CancellationReasons ?? [];
          if (gh?.Code === 'ConditionalCheckFailed') return 'taken';
          if (user?.Code === 'ConditionalCheckFailed') return 'relink';
        }
        throw err;
      }
    },

    async unlink(sub) {
      const existing = await this.getLink(sub);
      if (!existing) return;
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: T,
                Key: ghKey(existing.githubUserId),
                ConditionExpression: 'attribute_not_exists(pk) OR #sub = :sub',
                ExpressionAttributeNames: { '#sub': 'sub' },
                ExpressionAttributeValues: { ':sub': sub },
              },
            },
            {
              Update: {
                TableName: T,
                Key: userKey(sub),
                UpdateExpression: 'REMOVE githubUserId, githubLogin, linkedAt',
              },
            },
          ],
        }),
      );
    },

    async getTenant(id) {
      const out = await client.send(new GetCommand({ TableName: T, Key: tenantKey(id) }));
      return out.Item ? toTenant(out.Item) : null;
    },

    async putTenantWithMember(tenant, member) {
      try {
        await client.send(
          new PutCommand({
            TableName: T,
            Item: { ...tenantKey(tenant.installationId), ...tenant },
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // The tenant exists already: keep it as it is.
      }
      await client.send(
        new PutCommand({
          TableName: T,
          Item: {
            ...memberKey(member.installationId, member.sub),
            ...member,
            GSI1PK: `USER#${member.sub}`,
            GSI1SK: `TENANT#${member.installationId}`,
          },
        }),
      );
    },

    async updateTenantStatus(id, update) {
      const names: Record<string, string> = { '#status': 'status' };
      const values: Record<string, unknown> = { ':status': update.status };
      const set = ['#status = :status'];
      const remove: string[] = [];
      if (update.disabledReason) {
        set.push('disabledReason = :reason');
        values[':reason'] = update.disabledReason;
      } else remove.push('disabledReason');
      if (update.deleteAfter) {
        set.push('deleteAfter = :deleteAfter');
        values[':deleteAfter'] = update.deleteAfter;
      } else remove.push('deleteAfter');
      try {
        await client.send(
          new UpdateCommand({
            TableName: T,
            Key: tenantKey(id),
            UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async getMember(id, sub) {
      const out = await client.send(new GetCommand({ TableName: T, Key: memberKey(id, sub) }));
      return out.Item ? toMember(out.Item) : null;
    },

    async listMemberships(sub) {
      const out = await client.send(
        new QueryCommand({
          TableName: T,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
          ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':prefix': 'TENANT#' },
        }),
      );
      return (out.Items ?? []).map(toMember);
    },
  };
}
