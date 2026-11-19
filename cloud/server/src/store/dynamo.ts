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
import type { AgentKeyMeta, CleanupEntry, ConfigVersion, GitHubLink, InstallationOffer, Member, OAuthState, Store, Tenant } from './store.js';

/** The DynamoDB Store over UpdraftTable (layout in store.ts). */
export function createDynamoStore(tableName: string, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))): Store {
  const T = tableName;
  const userKey = (sub: string) => ({ pk: `USER#${sub}`, sk: 'PROFILE' });
  const offerKey = (sub: string) => ({ pk: `USER#${sub}`, sk: 'OFFER' });
  const ghKey = (id: number) => ({ pk: `GHUSER#${id}`, sk: 'LINK' });
  const tenantKey = (id: number) => ({ pk: `TENANT#${id}`, sk: 'META' });
  const memberKey = (id: number, sub: string) => ({ pk: `TENANT#${id}`, sk: `MEMBER#${sub}` });
  // Zero-padded, so the sort key orders versions numerically.
  const configKey = (id: number, version: number) => ({ pk: `TENANT#${id}`, sk: `CONFIG#${String(version).padStart(10, '0')}` });
  // Uninstalled tenants whose data outside the table must be deleted at the deadline. One
  // partition, ordered by deadline, and no TTL: these must outlive the tenant's own rows.
  const cleanupKey = (entry: CleanupEntry) => ({ pk: 'CLEANUP', sk: `${String(entry.deleteAfter).padStart(15, '0')}#${entry.installationId}` });
  async function recordCleanup(entry: CleanupEntry): Promise<void> {
    await client.send(new PutCommand({ TableName: T, Item: { ...cleanupKey(entry), ...entry } }));
  }

  /**
   * Gives everything in a tenant's partition (members now; config and jobs later) the table TTL.
   * Idempotent (rows that already have this TTL are skipped), so it is simply run again until it
   * completes. Throws on the first failed write.
   */
  async function sweepPartition(id: number, ttl: number): Promise<void> {
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': `TENANT#${id}` },
          ProjectionExpression: 'pk, sk, #ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          // Strongly consistent: a member whose transaction committed just before the uninstall
          // must be found, or it would never get the TTL.
          ConsistentRead: true,
          ExclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) {
        if (item.sk === 'META' || item.ttl === ttl) continue;
        await client.send(
          new UpdateCommand({
            TableName: T,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression: 'SET #ttl = :ttl',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':ttl': ttl },
          }),
        );
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }

  async function getTenantItem(id: number, consistent = false): Promise<Record<string, unknown> | undefined> {
    const out = await client.send(new GetCommand({ TableName: T, Key: tenantKey(id), ...(consistent ? { ConsistentRead: true } : {}) }));
    return out.Item;
  }

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
    if (typeof item.activeConfigVersion === 'number') t.activeConfigVersion = item.activeConfigVersion;
    return t;
  };
  const toMember = (item: Record<string, unknown>): Member => ({
    installationId: Number(item.installationId),
    sub: String(item.sub),
    role: item.role === 'owner' ? 'owner' : 'editor',
    // A membership from before identities were recorded matches no identity, so it grants nothing.
    githubUserId: typeof item.githubUserId === 'number' ? item.githubUserId : -1,
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
            { Delete: { TableName: T, Key: offerKey(sub) } },
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
      // The member only while the tenant is not uninstalled, in one transaction with that check: a
      // member can never slip in after an uninstall has started giving the partition its TTL.
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: T,
                  Key: tenantKey(tenant.installationId),
                  ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)',
                  ExpressionAttributeValues: { ':uninstalled': 'uninstalled' },
                },
              },
              {
                Put: {
                  TableName: T,
                  Item: {
                    ...memberKey(member.installationId, member.sub),
                    ...member,
                    GSI1PK: `USER#${member.sub}`,
                    GSI1SK: `TENANT#${member.installationId}`,
                  },
                },
              },
            ],
          }),
        );
        return 'added';
      } catch (err) {
        if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return 'uninstalled';
        throw err;
      }
    },

    async putOffer(offer: InstallationOffer) {
      await client.send(
        new PutCommand({ TableName: T, Item: { ...offerKey(offer.sub), ...offer, ttl: Math.ceil(offer.expiresAt / 1000) } }),
      );
    },

    async getOffer(sub) {
      const out = await client.send(new GetCommand({ TableName: T, Key: offerKey(sub) }));
      const i = out.Item;
      if (!i || !Array.isArray(i.installations)) return null;
      return {
        sub,
        githubUserId: Number(i.githubUserId),
        githubLogin: String(i.githubLogin),
        installations: (i.installations as Record<string, unknown>[]).map((o) => ({
          installationId: Number(o.installationId),
          accountId: Number(o.accountId),
          accountLogin: String(o.accountLogin),
          accountType: String(o.accountType),
          suspended: o.suspended === true,
        })),
        expiresAt: Number(i.expiresAt),
      };
    },

    async markUninstalled(id, deleteAfter, account) {
      const ttl = Math.ceil(deleteAfter / 1000);
      // Three outcomes, retried if the tenant changes between the steps:
      //   marked     an existing tenant is now uninstalled
      //   already    it was uninstalled before: finish the sweep with the stored deadline
      //   tombstone  there is no tenant (yet): record one already uninstalled, so that a Connect or
      //              install callback that passed its GitHub check a moment ago cannot create it
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.send(
            new UpdateCommand({
              TableName: T,
              Key: tenantKey(id),
              UpdateExpression: 'SET #status = :disabled, disabledReason = :uninstalled, deleteAfter = :deleteAfter, #ttl = :ttl',
              ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)',
              ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
              ExpressionAttributeValues: { ':disabled': 'disabled', ':uninstalled': 'uninstalled', ':deleteAfter': deleteAfter, ':ttl': ttl },
            }),
          );
          await sweepPartition(id, ttl);
          await recordCleanup({ installationId: id, deleteAfter });
          return 'marked';
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }
        const existing = await getTenantItem(id, true);
        if (existing?.disabledReason === 'uninstalled') {
          // Uninstalled before: finish (or redo) the sweep with the deadline stored then, so one a
          // failure or timeout cut short completes on the next delivery.
          const stored = typeof existing.deleteAfter === 'number' ? existing.deleteAfter : deleteAfter;
          await sweepPartition(id, Math.ceil(stored / 1000));
          await recordCleanup({ installationId: id, deleteAfter: stored });
          return 'already';
        }
        if (existing) continue; // created or changed since the update was refused: try again
        try {
          await client.send(
            new PutCommand({
              TableName: T,
              Item: {
                ...tenantKey(id),
                installationId: id,
                accountId: account?.id ?? 0,
                accountLogin: account?.login ?? '',
                accountType: account?.type ?? '',
                status: 'disabled',
                disabledReason: 'uninstalled',
                deleteAfter,
                ttl,
                createdAt: new Date().toISOString(),
                createdBy: 'github:installation.deleted',
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            }),
          );
          await recordCleanup({ installationId: id, deleteAfter });
          return 'tombstone';
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          // A tenant was created in between: mark that one on the next pass.
        }
      }
      throw new Error(`markUninstalled: tenant ${id} kept changing; retry the delivery`);
    },

    async setSuspended(id, suspended) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: T,
            Key: tenantKey(id),
            UpdateExpression: suspended ? 'SET #status = :status, disabledReason = :suspended' : 'SET #status = :status REMOVE disabledReason',
            // Never over an uninstall, whatever order GitHub delivers events in.
            ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': suspended ? 'disabled' : 'active',
              ':uninstalled': 'uninstalled',
              ...(suspended ? { ':suspended': 'suspended' } : {}),
            },
          }),
        );
        return 'updated';
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        return (await getTenantItem(id, true)) ? 'uninstalled' : 'no_tenant';
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

    async createConfigVersion(id, meta) {
      // Versions only grow: the next number after the highest there is, claimed with a
      // conditional put (a concurrent publish that took it makes this one try the next), in one
      // transaction with a check that the tenant is not uninstalled.
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'CONFIG#' },
            ScanIndexForward: false,
            Limit: 1,
            ConsistentRead: true,
          }),
        );
        const version = (typeof last.Items?.[0]?.version === 'number' ? last.Items[0].version : 0) + 1;
        try {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: {
                    TableName: T,
                    Key: tenantKey(id),
                    ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)',
                    ExpressionAttributeValues: { ':uninstalled': 'uninstalled' },
                  },
                },
                {
                  Put: {
                    TableName: T,
                    Item: { ...configKey(id, version), ...meta, installationId: id, version, status: 'pending' },
                    ConditionExpression: 'attribute_not_exists(pk)',
                  },
                },
              ],
            }),
          );
          return version;
        } catch (err) {
          if (!(err instanceof TransactionCanceledException)) throw err;
          const [tenant, config] = err.CancellationReasons ?? [];
          if (tenant?.Code === 'ConditionalCheckFailed') return (await getTenantItem(id, true)) ? 'uninstalled' : 'no_tenant';
          if (config?.Code !== 'ConditionalCheckFailed') throw err;
          // Taken by a concurrent publish: try the next number.
        }
      }
      throw new Error(`createConfigVersion: tenant ${id} kept publishing concurrently; try again`);
    },

    async markConfigReady(id, version) {
      await client.send(
        new UpdateCommand({
          TableName: T,
          Key: configKey(id, version),
          UpdateExpression: 'SET #status = :ready',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':ready': 'ready' },
        }),
      );
    },

    async activateConfig(id, version) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: T,
                  Key: configKey(id, version),
                  ConditionExpression: '#status = :ready',
                  ExpressionAttributeNames: { '#status': 'status' },
                  ExpressionAttributeValues: { ':ready': 'ready' },
                },
              },
              {
                Update: {
                  TableName: T,
                  Key: tenantKey(id),
                  UpdateExpression: 'SET activeConfigVersion = :v',
                  // Only ever forward: a slow publish finishing after a later one must not move it back.
                  ConditionExpression:
                    'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled) AND (attribute_not_exists(activeConfigVersion) OR activeConfigVersion < :v)',
                  ExpressionAttributeValues: { ':v': version, ':uninstalled': 'uninstalled' },
                },
              },
            ],
          }),
        );
        return 'activated';
      } catch (err) {
        if (!(err instanceof TransactionCanceledException)) throw err;
        const [config, tenant] = err.CancellationReasons ?? [];
        if (config?.Code === 'ConditionalCheckFailed') return 'not_ready';
        if (tenant?.Code === 'ConditionalCheckFailed') {
          const item = await getTenantItem(id, true);
          if (!item) return 'no_tenant';
          return item.disabledReason === 'uninstalled' ? 'uninstalled' : 'superseded';
        }
        throw err;
      }
    },

    async listConfigVersions(id) {
      const out: ConfigVersion[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'CONFIG#' },
            ExclusiveStartKey,
          }),
        );
        for (const i of page.Items ?? []) {
          out.push({
            installationId: id,
            version: Number(i.version),
            status: i.status === 'ready' ? 'ready' : 'pending',
            sha256: String(i.sha256),
            files: Array.isArray(i.files) ? i.files.map(String) : [],
            publishedBy: String(i.publishedBy),
            publishedAt: String(i.publishedAt),
          });
        }
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out.sort((a, b) => a.version - b.version);
    },

    async putAgentKeyMeta(id, meta: AgentKeyMeta) {
      // With the uninstall check in the same transaction: no key row is written after the sweep.
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: T,
                  Key: tenantKey(id),
                  ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)',
                  ExpressionAttributeValues: { ':uninstalled': 'uninstalled' },
                },
              },
              { Put: { TableName: T, Item: { pk: `TENANT#${id}`, sk: `KEY#${meta.name}`, ...meta } } },
            ],
          }),
        );
        return 'stored';
      } catch (err) {
        if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return 'uninstalled';
        throw err;
      }
    },

    async listDueCleanups(now) {
      const out: CleanupEntry[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND sk <= :until',
            ExpressionAttributeValues: { ':pk': 'CLEANUP', ':until': `${String(now).padStart(15, '0')}#~` },
            ConsistentRead: true,
            ExclusiveStartKey,
          }),
        );
        for (const i of page.Items ?? []) out.push({ installationId: Number(i.installationId), deleteAfter: Number(i.deleteAfter) });
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },

    async completeCleanup(entry) {
      await client.send(new DeleteCommand({ TableName: T, Key: cleanupKey(entry) }));
    },

    async listAgentKeyMeta(id) {
      const out = await client.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'KEY#' },
        }),
      );
      return (out.Items ?? [])
        .map((i) => ({ name: String(i.name), updatedAt: String(i.updatedAt), updatedBy: String(i.updatedBy) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
