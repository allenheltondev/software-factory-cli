import { destinationOf, jobTelemetrySnapshotOf, loopOf, stepsOf, telemetryOf } from '../jobs/lifecycle.js';
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  ActiveJob,
  AgentKeyMeta,
  TelemetrySettings,
  CleanupEntry,
  ConfigVersion,
  DeliveryRecord,
  DispatchRules,
  GitHubLink,
  InstallationOffer,
  Job,
  JobFinishDetail,
  JobSummary,
  Member,
  OAuthState,
  Quotas,
  StartResult,
  Store,
  Tenant,
  TenantLimits,
} from './store.js';
import { finishFields, isFailure } from './store.js';

const DAY_SECONDS = 24 * 3600;
const LIMIT_NAMES = ['concurrentJobs', 'jobsPerDay', 'microvmMinutesPerMonth'] as const;

/** The DynamoDB Store over UpdraftTable (layout in store.ts). */
function toDelivery(i: Record<string, unknown>): DeliveryRecord {
  const d: DeliveryRecord = { at: String(i.at), deliveryId: String(i.deliveryId), event: String(i.event), disposition: i.disposition as DeliveryRecord['disposition'] };
  for (const k of ['action', 'repository', 'label', 'sender', 'reason', 'message', 'errorClass', 'jobId'] as const) {
    const v = i[k];
    if (typeof v === 'string') d[k] = v;
  }
  if (typeof i.issue === 'number') d.issue = i.issue;
  return d;
}

const named = (v: unknown) =>
  v && typeof v === 'object' && typeof (v as Record<string, unknown>).slug === 'string'
    ? { name: String((v as Record<string, unknown>).name ?? ''), slug: String((v as Record<string, unknown>).slug) }
    : undefined;

function toTelemetry(i: Record<string, unknown>): TelemetrySettings {
  const key = i.key && typeof i.key === 'object' ? (i.key as Record<string, unknown>) : undefined;
  const e = i.lastExport && typeof i.lastExport === 'object' ? (i.lastExport as Record<string, unknown>) : undefined;
  const team = named(key?.team);
  const environment = named(key?.environment);
  const otlp = i.otlp && typeof i.otlp === 'object' ? (i.otlp as Record<string, unknown>) : undefined;
  const links = i.links && typeof i.links === 'object' ? (i.links as Record<string, unknown>) : undefined;
  return {
    provider: i.provider === 'otlp' ? 'otlp' : i.provider === 'cloudwatch' ? 'cloudwatch' : 'honeycomb',
    ...(i.aws && typeof i.aws === 'object' && typeof (i.aws as Record<string, unknown>).region === 'string' ? { aws: { region: String((i.aws as Record<string, unknown>).region) } } : {}),
    enabled: i.enabled === true,
    region: i.region === 'eu' ? 'eu' : 'us',
    ...(otlp && typeof otlp.endpoint === 'string' && typeof otlp.header === 'string' ? { otlp: { endpoint: otlp.endpoint, header: otlp.header } } : {}),
    ...(links
      ? {
          links: {
            ...(typeof links.trace === 'string' ? { trace: links.trace } : {}),
            ...(typeof links.conversation === 'string' ? { conversation: links.conversation } : {}),
          },
        }
      : {}),
    serviceName: typeof i.serviceName === 'string' ? i.serviceName : 'updraft',
    captureContent: i.captureContent === true,
    updatedAt: String(i.updatedAt ?? ''),
    updatedBy: String(i.updatedBy ?? ''),
    ...(typeof i.version === 'number' ? { version: i.version } : {}),
    ...(i.keyChange && typeof i.keyChange === 'object' && typeof (i.keyChange as Record<string, unknown>).id === 'string'
      ? { keyChange: { id: String((i.keyChange as Record<string, unknown>).id), until: Number((i.keyChange as Record<string, unknown>).until) || 0 } }
      : {}),
    ...(key
      ? {
          key: {
            updatedAt: String(key.updatedAt ?? ''),
            updatedBy: String(key.updatedBy ?? ''),
            ...(typeof key.secretVersion === 'string' ? { secretVersion: key.secretVersion } : {}),
            ...(typeof key.type === 'string' ? { type: key.type } : {}),
            ...(team ? { team } : {}),
            ...(environment ? { environment } : {}),
          },
        }
      : {}),
    ...(e
      ? {
          lastExport: {
            at: String(e.at ?? ''),
            jobId: String(e.jobId ?? ''),
            ...(typeof e.traceId === 'string' ? { traceId: e.traceId } : {}),
            ...(destinationOf(e.destination) ? { destination: destinationOf(e.destination)! } : {}),
            spans: Number(e.spans) || 0,
            exported: Number(e.exported) || 0,
            failed: Number(e.failed) || 0,
            ...(typeof e.lastError === 'string' ? { lastError: e.lastError } : {}),
          },
        }
      : {}),
  };
}

function toJobSummary(i: Record<string, unknown>): JobSummary {
  const d = i.detail && typeof i.detail === 'object' ? (i.detail as Record<string, unknown>) : undefined;
  const detail: JobFinishDetail = {};
  if (d) {
    if (typeof d.updraftOutcome === 'string') detail.updraftOutcome = d.updraftOutcome;
    if (typeof d.verificationPassed === 'boolean') detail.verificationPassed = d.verificationPassed;
    if (typeof d.prUrl === 'string') detail.prUrl = d.prUrl;
    if (typeof d.prNumber === 'number') detail.prNumber = d.prNumber;
    if (Array.isArray(d.logs)) detail.logs = d.logs.map(String);
    const loop = loopOf(d.loop);
    if (loop) detail.loop = loop;
    const steps = stepsOf(d.steps);
    if (steps) detail.steps = steps;
    const telemetry = telemetryOf(d.telemetry);
    if (telemetry) detail.telemetry = telemetry;
  }
  return {
    jobId: String(i.jobId),
    repository: String(i.repository),
    ...(typeof i.issue === 'number' ? { issue: i.issue } : {}),
    ...(typeof i.label === 'string' ? { label: i.label } : {}),
    ...(typeof i.sender === 'string' ? { sender: i.sender } : {}),
    createdAt: String(i.createdAt),
    status: i.status === 'finished' ? 'finished' : 'launched',
    ...(typeof i.outcome === 'string' ? { outcome: i.outcome } : {}),
    ...(typeof i.configVersion === 'number' ? { configVersion: i.configVersion } : {}),
    ...(typeof i.deliveryId === 'string' ? { deliveryId: i.deliveryId } : {}),
    ...(typeof i.finishedAt === 'string' ? { finishedAt: i.finishedAt } : {}),
    ...(typeof i.durationSeconds === 'number' ? { durationSeconds: i.durationSeconds } : {}),
    ...(typeof i.microvmId === 'string' ? { microvmId: i.microvmId } : {}),
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

export function createDynamoStore(tableName: string, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))): Store {
  const T = tableName;
  const userKey = (sub: string) => ({ pk: `USER#${sub}`, sk: 'PROFILE' });
  const offerKey = (sub: string) => ({ pk: `USER#${sub}`, sk: 'OFFER' });
  const ghKey = (id: number) => ({ pk: `GHUSER#${id}`, sk: 'LINK' });
  const tenantKey = (id: number) => ({ pk: `TENANT#${id}`, sk: 'META' });
  const memberKey = (id: number, sub: string) => ({ pk: `TENANT#${id}`, sk: `MEMBER#${sub}` });
  // Zero-padded, so the sort key orders versions numerically.
  const configKey = (id: number, version: number) => ({ pk: `TENANT#${id}`, sk: `CONFIG#${String(version).padStart(10, '0')}` });
  // Its own partition (not the tenant's): claims expire on their own, well before any uninstall deadline.
  const deliveryKey = (id: number, deliveryId: string) => ({ pk: `DELIVERY#${id}#${deliveryId}`, sk: 'CLAIM' });
  // Quotas (jobs/quotas.ts). Slots expire by their TTL; usage counters keep a month and a year.
  const slotSk = (n: number) => `SLOT#${String(n).padStart(4, '0')}`;
  const PLATFORM = 'PLATFORM#JOBS';
  const activeKey = (jobId: string) => ({ pk: 'PLATFORM#ACTIVE', sk: `JOB#${jobId}` });
  const jobSummaryKey = (job: Pick<Job, 'installationId' | 'createdAt' | 'jobId'>) => ({ pk: `TENANT#${job.installationId}`, sk: `JOB#${job.createdAt}#${job.jobId}` });
  /** An item whose TTL has passed is gone, whether or not DynamoDB has deleted it yet. */
  const liveItem = (i: Record<string, unknown>) => typeof i.ttl !== 'number' || i.ttl * 1000 > Date.now();
  /** The summary's update at a finish: the outcome and, when given, what the finish reported. */
  const summaryFinish = (key: { pk: string; sk: string }, outcome: string, extra: Partial<JobSummary>) => {
    const names: Record<string, string> = { '#status': 'status' };
    const values: Record<string, unknown> = { ':finished': 'finished', ':outcome': outcome };
    const sets = ['#status = :finished', 'outcome = :outcome'];
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue;
      names[`#${k}`] = k;
      values[`:${k}`] = v;
      sets.push(`#${k} = :${k}`);
    }
    return { TableName: T, Key: key, UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeNames: names, ExpressionAttributeValues: values };
  };
  const tenantSlotKey = (id: number, n: number) => ({ pk: `TENANT#${id}`, sk: slotSk(n) });
  const platformSlotKey = (n: number) => ({ pk: PLATFORM, sk: slotSk(n) });
  const dayKey = (id: number, day: string) => ({ pk: `TENANT#${id}`, sk: `USAGE#DAY#${day}` });
  const monthKey = (id: number, month: string) => ({ pk: `TENANT#${id}`, sk: `USAGE#MONTH#${month}` });
  const usageTtl = (days: number) => Math.floor(Date.now() / 1000) + days * DAY_SECONDS;
  const jobSlotKeys = (job: Pick<Job, 'installationId' | 'tenantSlot' | 'platformSlot'>) => [
    ...(job.tenantSlot !== undefined ? [tenantSlotKey(job.installationId, job.tenantSlot)] : []),
    ...(job.platformSlot !== undefined ? [platformSlotKey(job.platformSlot)] : []),
  ];
  /** A free slot below `count` (none, or expired), or null. Strongly consistent. */
  async function freeSlot(pk: string, count: number, spread: boolean): Promise<number | null> {
    const now = Math.floor(Date.now() / 1000);
    const held = new Set<string>();
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': 'SLOT#' },
          ConsistentRead: true,
          ExclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) if (typeof item.ttl === 'number' && item.ttl >= now) held.add(String(item.sk));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    // The platform's slots are shared by every tenant: start anywhere, so launches rarely race.
    const start = spread && count > 0 ? Math.floor(Math.random() * count) : 0;
    for (let i = 0; i < count; i++) {
      const n = (start + i) % count;
      if (!held.has(slotSk(n))) return n;
    }
    return null;
  }
  /** Puts a claim or slot held by `jobId` until `ttl`, unless another job's unexpired one is there. */
  const holdItem = (key: { pk: string; sk: string }, jobId: string, ttl: number, extra: Record<string, unknown> = {}) => ({
    Put: {
      TableName: T,
      Item: { ...key, ...extra, jobId, ttl },
      ConditionExpression: 'attribute_not_exists(pk) OR jobId = :job OR #ttl < :now',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':job': jobId, ':now': Math.floor(Date.now() / 1000) },
    },
  });
  /** An update that may be refused by its condition: false when it was. */
  async function tryUpdate(input: ConstructorParameters<typeof UpdateCommand>[0]): Promise<boolean> {
    try {
      await client.send(new UpdateCommand(input));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
  const cancelledAt = (err: TransactionCanceledException, i: number) => err.CancellationReasons?.[i]?.Code === 'ConditionalCheckFailed';
  async function deleteIfHeld(key: { pk: string; sk: string }, jobId: string): Promise<void> {
    try {
      await client.send(new DeleteCommand({ TableName: T, Key: key, ConditionExpression: 'jobId = :job', ExpressionAttributeValues: { ':job': jobId } }));
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }
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

  const toConfigVersion = (id: number, i: Record<string, unknown>): ConfigVersion => ({
    installationId: id,
    version: Number(i.version),
    status: i.status === 'ready' ? 'ready' : 'pending',
    sha256: String(i.sha256),
    files: Array.isArray(i.files) ? i.files.map(String) : [],
    publishedBy: String(i.publishedBy),
    publishedAt: String(i.publishedAt),
    // Stored as written by the publish (tenants/dispatch.ts); absent on versions published before it existed.
    ...(i.dispatch && typeof i.dispatch === 'object' ? { dispatch: i.dispatch as DispatchRules } : {}),
    ...(typeof i.copiedFrom === 'number' ? { copiedFrom: i.copiedFrom } : {}),
  });

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
    if (typeof item.adminDisabledAt === 'string') {
      t.adminDisabled = {
        at: item.adminDisabledAt,
        by: String(item.adminDisabledBy ?? ''),
        ...(typeof item.adminDisabledReason === 'string' ? { reason: item.adminDisabledReason } : {}),
      };
      // Disabled by an admin, and active on GitHub: say so (the item itself keeps GitHub's reason only).
      if (!t.disabledReason) t.disabledReason = 'admin';
    }
    if (item.limits && typeof item.limits === 'object') {
      const given = item.limits as Record<string, unknown>;
      const limits: TenantLimits = {};
      for (const name of LIMIT_NAMES) if (typeof given[name] === 'number') limits[name] = given[name] as number;
      if (Object.keys(limits).length > 0) t.limits = limits;
    }
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

    async getTenant(id, options) {
      const item = await getTenantItem(id, options?.consistent === true);
      return item ? toTenant(item) : null;
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
      const cleanup = { Put: { TableName: T, Item: { ...cleanupKey({ installationId: id, deleteAfter }), installationId: id, deleteAfter } } };
      const conditionFailed = (err: unknown) =>
        err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      // Three outcomes, retried if the tenant changes between the steps:
      //   marked     an existing tenant is now uninstalled
      //   already    it was uninstalled before: finish the sweep with the stored deadline
      //   tombstone  there is no tenant (yet): record one already uninstalled, so that a Connect or
      //              install callback that passed its GitHub check a moment ago cannot create it
      // The cleanup entry is written in the same transaction as the transition, before the sweep:
      // an uninstall is never recorded without its cleanup, whatever fails after it.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: T,
                    Key: tenantKey(id),
                    UpdateExpression: 'SET #status = :disabled, disabledReason = :uninstalled, deleteAfter = :deleteAfter, #ttl = :ttl',
                    ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)',
                    ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
                    ExpressionAttributeValues: { ':disabled': 'disabled', ':uninstalled': 'uninstalled', ':deleteAfter': deleteAfter, ':ttl': ttl },
                  },
                },
                cleanup,
              ],
            }),
          );
          await sweepPartition(id, ttl);
          return 'marked';
        } catch (err) {
          if (!conditionFailed(err)) throw err;
        }
        const existing = await getTenantItem(id, true);
        if (existing?.disabledReason === 'uninstalled') {
          // Uninstalled before: finish (or redo) the sweep with the deadline stored then, so one a
          // failure or timeout cut short completes on the next delivery. (At the deadline the daily
          // cleanup removes whatever is left either way.)
          const stored = typeof existing.deleteAfter === 'number' ? existing.deleteAfter : deleteAfter;
          await recordCleanup({ installationId: id, deleteAfter: stored });
          await sweepPartition(id, Math.ceil(stored / 1000));
          return 'already';
        }
        if (existing) continue; // created or changed since the update was refused: try again
        try {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
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
                  },
                },
                cleanup,
              ],
            }),
          );
          return 'tombstone';
        } catch (err) {
          if (!conditionFailed(err)) throw err;
          // A tenant was created in between: mark that one on the next pass.
        }
      }
      throw new Error(`markUninstalled: tenant ${id} kept changing; retry the delivery`);
    },

    async putJob(job) {
      // A week after the job may last, the record goes; nothing is served for it by then anyway.
      // Its summary in the tenant's partition (the admin view) stays 30 days.
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: T,
                Item: { pk: `JOB#${job.jobId}`, sk: 'META', ...job, ttl: Math.ceil(job.expiresAt / 1000) + 7 * 24 * 3600 },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: T,
                Item: {
                  ...jobSummaryKey(job),
                  jobId: job.jobId,
                  repository: job.repository,
                  ...(job.issue !== undefined ? { issue: job.issue } : {}),
                  ...(job.label ? { label: job.label } : {}),
                  ...(job.sender ? { sender: job.sender } : {}),
                  createdAt: job.createdAt,
                  status: job.status,
                  configVersion: job.configVersion,
                  deliveryId: job.deliveryId,
                  ttl: usageTtl(30),
                },
              },
            },
          ],
        }),
      );
    },

    async markLaunching(jobId) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: T,
            Key: activeKey(jobId),
            UpdateExpression: 'SET phase = :launching',
            ConditionExpression: 'phase = :reserved',
            ExpressionAttributeValues: { ':launching': 'launching', ':reserved': 'reserved' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) throw new Error(`job ${jobId} has no reservation to launch`, { cause: err });
        throw err;
      }
    },

    async getJob(jobId): Promise<Job | null> {
      // Strongly consistent: the launcher wrote it moments before the microVM asks for it.
      const out = await client.send(new GetCommand({ TableName: T, Key: { pk: `JOB#${jobId}`, sk: 'META' }, ConsistentRead: true }));
      const i = out.Item;
      if (!i) return null;
      return {
        jobId: String(i.jobId),
        tokenHash: String(i.tokenHash),
        installationId: Number(i.installationId),
        repository: String(i.repository),
        repositoryId: Number(i.repositoryId),
        configVersion: Number(i.configVersion),
        deliveryId: String(i.deliveryId),
        eventName: String(i.eventName),
        status: i.status === 'finished' ? 'finished' : 'launched',
        ...(typeof i.outcome === 'string' ? { outcome: i.outcome } : {}),
        createdAt: String(i.createdAt),
        expiresAt: Number(i.expiresAt),
        ...(typeof i.microvmId === 'string' ? { microvmId: i.microvmId } : {}),
        ...(typeof i.label === 'string' ? { label: i.label } : {}),
        ...(typeof i.sender === 'string' ? { sender: i.sender } : {}),
        ...(typeof i.imageVersion === 'string' ? { imageVersion: i.imageVersion } : {}),
        ...(typeof i.tenantSlot === 'number' ? { tenantSlot: i.tenantSlot } : {}),
        ...(typeof i.platformSlot === 'number' ? { platformSlot: i.platformSlot } : {}),
        ...(typeof i.reservedSeconds === 'number' ? { reservedSeconds: i.reservedSeconds } : {}),
        ...(i.quotas && typeof i.quotas === 'object' ? { quotas: i.quotas as Quotas } : {}),
        ...(typeof i.issue === 'number' ? { issue: i.issue } : {}),
        ...(Array.isArray(i.agentKeys) ? { agentKeys: (i.agentKeys as unknown[]).map(String) } : {}),
        ...(jobTelemetrySnapshotOf(i.telemetrySnapshot) ? { telemetrySnapshot: jobTelemetrySnapshotOf(i.telemetrySnapshot)! } : {}),
        ...(typeof i.startedAt === 'number' ? { startedAt: i.startedAt } : {}),
        ...(typeof i.stopRequestedAt === 'number' ? { stopRequestedAt: i.stopRequestedAt } : {}),
        ...(typeof i.releasedAt === 'number' ? { releasedAt: i.releasedAt } : {}),
      };
    },

    async attachMicrovm(jobId, microvmId) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: T,
            Key: { pk: `JOB#${jobId}`, sk: 'META' },
            UpdateExpression: 'SET microvmId = :id',
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(microvmId)',
            ExpressionAttributeValues: { ':id': microvmId },
          }),
        );
        return true;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        return false;
      }
    },

    async setJobTelemetrySnapshot(jobId, snapshot) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: T,
            Key: { pk: `JOB#${jobId}`, sk: 'META' },
            UpdateExpression: 'SET telemetrySnapshot = :s',
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(telemetrySnapshot)',
            ExpressionAttributeValues: { ':s': snapshot },
          }),
        );
        return true;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        return false;
      }
    },

    async finishJob(jobId, outcome, finish) {
      try {
        const out = await client.send(
          new UpdateCommand({
            TableName: T,
            Key: { pk: `JOB#${jobId}`, sk: 'META' },
            UpdateExpression: 'SET #status = :finished, outcome = :outcome',
            ConditionExpression: 'attribute_exists(pk) AND #status <> :finished',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':finished': 'finished', ':outcome': outcome },
            ReturnValues: 'ALL_NEW',
          }),
        );
        // The first outcome, on the job's summary and in the month's failures. For the admin view
        // only, so a failure here is logged, never the finish's.
        const job = out.Attributes;
        if (job && typeof job.installationId === 'number' && typeof job.createdAt === 'string') {
          const summary = jobSummaryKey({ installationId: job.installationId, createdAt: job.createdAt, jobId });
          await client
            .send(
              new TransactWriteCommand({
                TransactItems: [
                  {
                    Update: summaryFinish(summary, outcome, finishFields({ ...(typeof job.startedAt === 'number' ? { startedAt: job.startedAt } : {}), ...(typeof job.microvmId === 'string' ? { microvmId: job.microvmId } : {}) }, finish)),
                  },
                  ...(isFailure(outcome)
                    ? [
                        {
                          Update: {
                            TableName: T,
                            Key: monthKey(job.installationId, job.createdAt.slice(0, 7)),
                            UpdateExpression: 'ADD failed :one SET #ttl = if_not_exists(#ttl, :ttl)',
                            ExpressionAttributeNames: { '#ttl': 'ttl' },
                            ExpressionAttributeValues: { ':one': 1, ':ttl': usageTtl(400) },
                          },
                        },
                      ]
                    : []),
                ],
              }),
            )
            .catch((err: unknown) => console.log(JSON.stringify({ jobId, warning: `could not record the outcome on the job's summary: ${(err as Error)?.name}` })));
        }
        return outcome;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Already finished (or never recorded): the first outcome stands.
        const out = await client.send(new GetCommand({ TableName: T, Key: { pk: `JOB#${jobId}`, sk: 'META' }, ConsistentRead: true }));
        return typeof out.Item?.outcome === 'string' ? out.Item.outcome : null;
      }
    },

    async purgeTenantPartition(id) {
      // At the deadline: every row the TTL should have removed, including any an interrupted sweep
      // never reached. Strongly consistent, so nothing just written is missed. Safe to repeat.
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': `TENANT#${id}` },
            ProjectionExpression: 'pk, sk, #ttl',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ConsistentRead: true,
            ExclusiveStartKey,
          }),
        );
        for (const item of page.Items ?? []) await client.send(new DeleteCommand({ TableName: T, Key: { pk: item.pk, sk: item.sk } }));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
    },

    async setTenantLimits(id, limits) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: T,
            Key: tenantKey(id),
            UpdateExpression: limits ? 'SET limits = :limits' : 'REMOVE limits',
            ConditionExpression: 'attribute_exists(pk)',
            ...(limits ? { ExpressionAttributeValues: { ':limits': limits } } : {}),
          }),
        );
        return 'updated';
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        return 'no_tenant';
      }
    },

    async setAdminDisabled(id, disabled) {
      const notUninstalled = 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)';
      const missingOrUninstalled = async () => ((await getTenantItem(id, true)) ? 'uninstalled' : 'no_tenant');
      if (disabled) {
        try {
          await client.send(
            new UpdateCommand({
              TableName: T,
              Key: tenantKey(id),
              UpdateExpression: `SET #status = :disabled, adminDisabledAt = :at, adminDisabledBy = :by${disabled.reason ? ', adminDisabledReason = :reason' : ' REMOVE adminDisabledReason'}`,
              ConditionExpression: notUninstalled,
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':disabled': 'disabled',
                ':at': new Date().toISOString(),
                ':by': disabled.by,
                ':uninstalled': 'uninstalled',
                ...(disabled.reason ? { ':reason': disabled.reason } : {}),
              },
            }),
          );
          return 'updated';
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          return missingOrUninstalled();
        }
      }
      // Enabled, by the state GitHub has it in now, each write conditioned on that state and
      // retried if GitHub changed it in between (a suspend or unsuspend racing the enable).
      for (let attempt = 0; attempt < 3; attempt++) {
        // Active on GitHub: active again.
        if (
          await tryUpdate({
            TableName: T,
            Key: tenantKey(id),
            UpdateExpression: 'SET #status = :active REMOVE adminDisabledAt, adminDisabledBy, adminDisabledReason',
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(disabledReason)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':active': 'active' },
          })
        ) {
          return 'updated';
        }
        // Suspended on GitHub: the admin's disable goes, and it stays disabled for the suspend.
        if (
          await tryUpdate({
            TableName: T,
            Key: tenantKey(id),
            UpdateExpression: 'REMOVE adminDisabledAt, adminDisabledBy, adminDisabledReason',
            ConditionExpression: 'attribute_exists(pk) AND disabledReason = :suspended',
            ExpressionAttributeValues: { ':suspended': 'suspended' },
          })
        ) {
          return 'updated';
        }
        const item = await getTenantItem(id, true);
        if (!item) return 'no_tenant';
        if (item.disabledReason === 'uninstalled') return 'uninstalled';
      }
      throw new Error(`setAdminDisabled: tenant ${id} kept changing; try again`);
    },

    async listTenants() {
      const found: Tenant[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new ScanCommand({
            TableName: T,
            FilterExpression: 'sk = :meta AND begins_with(pk, :tenant)',
            ExpressionAttributeValues: { ':meta': 'META', ':tenant': 'TENANT#' },
            ExclusiveStartKey,
          }),
        );
        for (const item of page.Items ?? []) found.push(toTenant(item));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return found;
    },

    async listRecentJobs(id, limit): Promise<JobSummary[]> {
      const out = await client.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'JOB#' },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return (out.Items ?? []).map(toJobSummary);
    },

    async getJobSummary(id, jobId) {
      // The job's own record says when it was created, which is the summary's key; it is kept a
      // week past the job's end, the summary 30 days, so after that the tenant's summaries are
      // searched. Either way only this tenant's partition is read.
      const meta = await client.send(new GetCommand({ TableName: T, Key: { pk: `JOB#${jobId}`, sk: 'META' } }));
      if (meta.Item) {
        if (Number(meta.Item.installationId) !== id) return null;
        const out = await client.send(new GetCommand({ TableName: T, Key: jobSummaryKey({ installationId: id, createdAt: String(meta.Item.createdAt), jobId }) }));
        return out.Item && liveItem(out.Item) ? toJobSummary(out.Item) : null;
      }
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            FilterExpression: 'jobId = :job',
            ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'JOB#', ':job': jobId },
            ExclusiveStartKey,
          }),
        );
        const hit = (page.Items ?? []).find(liveItem);
        if (hit) return toJobSummary(hit);
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return null;
    },

    async recordDelivery(id, d: DeliveryRecord) {
      // Two rows of one attempt, with the same TTL: by time (the list), and by delivery id (a
      // job's history, its redeliveries included, without reading the tenant's whole month).
      const ttl = usageTtl(30);
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: T, Item: { pk: `TENANT#${id}`, sk: `DELIVERY#${d.at}#${d.deliveryId}`, ...d, ttl } } },
            { Put: { TableName: T, Item: { pk: `TENANT#${id}`, sk: `ATTEMPT#${d.deliveryId}#${d.at}`, ...d, ttl } } },
          ],
        }),
      );
    },

    async listDeliveriesOf(id, deliveryId) {
      const out: DeliveryRecord[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': `ATTEMPT#${deliveryId}#` },
            ExclusiveStartKey,
          }),
        );
        out.push(...(page.Items ?? []).filter(liveItem).map(toDelivery));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },

    async listDeliveries(id, limit) {
      const out = await client.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'DELIVERY#' },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return (out.Items ?? []).filter(liveItem).map(toDelivery);
    },

    async setSuspended(id, suspended) {
      if (suspended) {
        const updated = await tryUpdate({
          TableName: T,
          Key: tenantKey(id),
          UpdateExpression: 'SET #status = :disabled, disabledReason = :suspended',
          // Never over an uninstall, whatever order GitHub delivers events in.
          ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':disabled': 'disabled', ':suspended': 'suspended', ':uninstalled': 'uninstalled' },
        });
        if (updated) return 'updated';
        return (await getTenantItem(id, true)) ? 'uninstalled' : 'no_tenant';
      }
      // Unsuspended, by the state the tenant is in now: every write is conditioned on that state
      // (never over an uninstall), and retried if an admin or GitHub changed it in between.
      for (let attempt = 0; attempt < 3; attempt++) {
        // Disabled by an admin: only GitHub's reason goes, and it stays disabled.
        if (
          await tryUpdate({
            TableName: T,
            Key: tenantKey(id),
            UpdateExpression: 'REMOVE disabledReason',
            ConditionExpression: 'attribute_exists(adminDisabledAt) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled)',
            ExpressionAttributeValues: { ':uninstalled': 'uninstalled' },
          })
        ) {
          return 'updated';
        }
        // Otherwise active again.
        if (
          await tryUpdate({
            TableName: T,
            Key: tenantKey(id),
            UpdateExpression: 'SET #status = :active REMOVE disabledReason',
            ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled) AND attribute_not_exists(adminDisabledAt)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':active': 'active', ':uninstalled': 'uninstalled' },
          })
        ) {
          return 'updated';
        }
        const item = await getTenantItem(id, true);
        if (!item) return 'no_tenant';
        if (item.disabledReason === 'uninstalled') return 'uninstalled';
      }
      throw new Error(`setSuspended: tenant ${id} kept changing; retry the delivery`);
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

    async activateConfig(id, version, options) {
      const expected = options?.expectedActive;
      // With an expected version, it must still be the active one (or none must be, for null).
      const sameBase = expected === undefined ? '' : expected === null ? ' AND attribute_not_exists(activeConfigVersion)' : ' AND activeConfigVersion = :expected';
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
                    'attribute_exists(pk) AND (attribute_not_exists(disabledReason) OR disabledReason <> :uninstalled) AND (attribute_not_exists(activeConfigVersion) OR activeConfigVersion < :v)' +
                    sameBase,
                  ExpressionAttributeValues: { ':v': version, ':uninstalled': 'uninstalled', ...(typeof expected === 'number' ? { ':expected': expected } : {}) },
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
          if (item.disabledReason === 'uninstalled') return 'uninstalled';
          const current = typeof item.activeConfigVersion === 'number' ? item.activeConfigVersion : null;
          if (current !== null && current >= version) return 'superseded';
          return expected !== undefined && current !== expected ? 'changed' : 'superseded';
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
        for (const i of page.Items ?? []) out.push(toConfigVersion(id, i));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out.sort((a, b) => a.version - b.version);
    },

    async getConfigVersion(id, version, options) {
      const out = await client.send(new GetCommand({ TableName: T, Key: configKey(id, version), ConsistentRead: options?.consistent === true }));
      return out.Item ? toConfigVersion(id, out.Item) : null;
    },

    async claimDelivery(id, deliveryId, expiresAt, jobId) {
      // DynamoDB deletes expired items lazily, so an expired claim counts as none.
      const now = Math.floor(Date.now() / 1000);
      try {
        await client.send(
          new PutCommand({
            TableName: T,
            Item: { ...deliveryKey(id, deliveryId), installationId: id, deliveryId, jobId, ttl: Math.ceil(expiresAt / 1000) },
            ConditionExpression: 'attribute_not_exists(pk) OR #ttl < :now',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':now': now },
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async startJob(job, holdUntil): Promise<StartResult> {
      const ttl = Math.ceil(holdUntil / 1000);
      const slots = jobSlotKeys(job);
      const monthLimit = job.quotas ? job.quotas.microvmMinutesPerMonth * 60 : undefined;
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: T,
                  Key: { pk: `JOB#${job.jobId}`, sk: 'META' },
                  UpdateExpression: 'SET startedAt = :at',
                  // Never a finished job, or one whose microVM was asked to stop: a finish or a
                  // terminate that won the race leaves nothing to serve.
                  ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(startedAt) AND attribute_not_exists(stopRequestedAt) AND #status <> :finished',
                  ExpressionAttributeNames: { '#status': 'status' },
                  ExpressionAttributeValues: { ':at': Date.now(), ':finished': 'finished' },
                },
              },
              holdItem(deliveryKey(job.installationId, job.deliveryId), job.jobId, ttl, { installationId: job.installationId, deliveryId: job.deliveryId }),
              ...slots.map((key) => holdItem(key, job.jobId, ttl)),
              ...(job.reservedSeconds
                ? [
                    {
                      Update: {
                        TableName: T,
                        Key: monthKey(job.installationId, job.createdAt.slice(0, 7)),
                        UpdateExpression: 'ADD seconds :seconds SET #ttl = if_not_exists(#ttl, :ttl)',
                        // The month's quota, checked with the charge: launches that passed the
                        // launcher's check together cannot all be charged on the same remainder.
                        ...(monthLimit !== undefined ? { ConditionExpression: 'attribute_not_exists(seconds) OR seconds < :limit' } : {}),
                        ExpressionAttributeNames: { '#ttl': 'ttl' },
                        ExpressionAttributeValues: { ':seconds': job.reservedSeconds, ':ttl': usageTtl(400), ...(monthLimit !== undefined ? { ':limit': monthLimit } : {}) },
                      },
                    },
                  ]
                : []),
            ],
          }),
        );
        return { result: 'started' };
      } catch (err) {
        if (!(err instanceof TransactionCanceledException)) throw err;
        if (cancelledAt(err, 0)) {
          const current = await client.send(new GetCommand({ TableName: T, Key: { pk: `JOB#${job.jobId}`, sk: 'META' }, ConsistentRead: true }));
          const retired = !current.Item || current.Item.status === 'finished' || current.Item.stopRequestedAt !== undefined;
          return { result: retired ? 'retired' : 'already' };
        }
        if (cancelledAt(err, 1)) return { result: 'superseded' };
        if (job.tenantSlot !== undefined && cancelledAt(err, 2)) return { result: 'throttled', limit: 'concurrent_jobs' };
        if (job.platformSlot !== undefined && cancelledAt(err, 2 + (job.tenantSlot !== undefined ? 1 : 0))) return { result: 'throttled', limit: 'platform_concurrency' };
        if (cancelledAt(err, 2 + slots.length)) return { result: 'throttled', limit: 'microvm_minutes' };
        throw err;
      }
    },

    async markStopping(jobId) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: T,
            Key: { pk: `JOB#${jobId}`, sk: 'META' },
            UpdateExpression: 'SET stopRequestedAt = :at',
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(stopRequestedAt)',
            ExpressionAttributeValues: { ':at': Date.now() },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    },

    async holdSlots(job, until) {
      const ttl = Math.ceil(until / 1000);
      let all = true;
      for (const key of jobSlotKeys(job)) {
        try {
          // Only while the job is not released, in the same transaction: a hold made from a read
          // taken before a release (a slow reconciliation) cannot bring its slots back.
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: {
                    TableName: T,
                    Key: { pk: `JOB#${job.jobId}`, sk: 'META' },
                    ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(releasedAt)',
                  },
                },
                holdItem(key, job.jobId, ttl),
              ],
            }),
          );
        } catch (err) {
          if (!(err instanceof TransactionCanceledException)) throw err;
          // Released (or gone): nothing to hold any more.
          if (cancelledAt(err, 0)) return true;
          // Another job's live slot: not this one's to hold.
          if (cancelledAt(err, 1)) all = false;
          else throw err;
        }
      }
      return all;
    },

    async listActiveJobs(): Promise<ActiveJob[]> {
      const entries: ActiveJob[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': 'PLATFORM#ACTIVE', ':prefix': 'JOB#' },
            ConsistentRead: true,
            ExclusiveStartKey,
          }),
        );
        for (const i of page.Items ?? []) {
          if (typeof i.jobId !== 'string') continue;
          entries.push({
            jobId: i.jobId,
            installationId: Number(i.installationId),
            tenantSlot: Number(i.tenantSlot),
            platformSlot: Number(i.platformSlot),
            day: String(i.day),
            month: String(i.month),
            // An entry without a phase may have a microVM: treat it as launching.
            phase: i.phase === 'reserved' ? 'reserved' : 'launching',
            reservedAt: Number(i.reservedAt ?? 0),
            expiresAt: Number(i.expiresAt ?? (typeof i.ttl === 'number' ? i.ttl * 1000 : 0)),
          });
        }
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return entries;
    },

    async forgetActiveJob(entry) {
      for (const key of jobSlotKeys(entry)) await deleteIfHeld(key, entry.jobId);
      await client.send(new DeleteCommand({ TableName: T, Key: activeKey(entry.jobId) }));
    },

    async listPlatformSlots() {
      const now = Math.floor(Date.now() / 1000);
      const held: { jobId: string; expiresAt: number }[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': PLATFORM, ':prefix': 'SLOT#' },
            ConsistentRead: true,
            ExclusiveStartKey,
          }),
        );
        for (const item of page.Items ?? []) {
          if (typeof item.ttl === 'number' && item.ttl >= now && typeof item.jobId === 'string') held.push({ jobId: item.jobId, expiresAt: item.ttl * 1000 });
        }
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return held;
    },

    async releaseJob(job, refund) {
      // Marked once, with the refund: a repeated release refunds nothing. Released is retired too:
      // a delayed start can never admit it (stopRequestedAt, which start and serving check).
      const mark = {
        TableName: T,
        Key: { pk: `JOB#${job.jobId}`, sk: 'META' },
        UpdateExpression: 'SET releasedAt = :at, stopRequestedAt = if_not_exists(stopRequestedAt, :at)',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(releasedAt)',
        ExpressionAttributeValues: { ':at': Date.now() },
      };
      try {
        if (refund && refund.seconds > 0) {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                { Update: mark },
                {
                  Update: {
                    TableName: T,
                    Key: monthKey(job.installationId, refund.month),
                    UpdateExpression: 'ADD seconds :refund',
                    ExpressionAttributeValues: { ':refund': -refund.seconds },
                  },
                },
              ],
            }),
          );
        } else {
          await client.send(new UpdateCommand(mark));
        }
      } catch (err) {
        const already = err instanceof ConditionalCheckFailedException || (err instanceof TransactionCanceledException && cancelledAt(err, 0));
        if (!already) throw err;
      }
      // After the refund: a failure here leaves the slots to run out, never a refund undone, and
      // the active entry for the next reconciliation to finish.
      for (const key of jobSlotKeys(job)) await deleteIfHeld(key, job.jobId);
      await client.send(new DeleteCommand({ TableName: T, Key: activeKey(job.jobId) }));
    },

    async releaseJobSlots(job) {
      for (const key of jobSlotKeys(job)) await deleteIfHeld(key, job.jobId);
    },

    async reserveJob({ installationId: id, jobId, holdUntil, day, month, quotas }) {
      const ttl = Math.ceil(holdUntil / 1000);
      // A slot another launch took between the read and the write: look again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const tenantSlot = await freeSlot(`TENANT#${id}`, quotas.concurrentJobs, false);
        if (tenantSlot === null) return { ok: false, limit: 'concurrent_jobs' };
        const platformSlot = await freeSlot(PLATFORM, quotas.platformConcurrentJobs, true);
        if (platformSlot === null) return { ok: false, limit: 'platform_concurrency' };
        const take = (key: { pk: string; sk: string }) => ({
          Put: {
            TableName: T,
            Item: { ...key, jobId, ttl },
            ConditionExpression: 'attribute_not_exists(pk) OR #ttl < :now',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
          },
        });
        try {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                take(tenantSlotKey(id, tenantSlot)),
                take(platformSlotKey(platformSlot)),
                {
                  Update: {
                    TableName: T,
                    Key: dayKey(id, day),
                    UpdateExpression: 'ADD jobs :one SET #ttl = if_not_exists(#ttl, :ttl)',
                    ConditionExpression: 'attribute_not_exists(jobs) OR jobs < :limit',
                    ExpressionAttributeNames: { '#ttl': 'ttl' },
                    ExpressionAttributeValues: { ':one': 1, ':ttl': usageTtl(40), ':limit': quotas.jobsPerDay },
                  },
                },
                {
                  Update: {
                    TableName: T,
                    Key: monthKey(id, month),
                    UpdateExpression: 'ADD jobs :one SET #ttl = if_not_exists(#ttl, :ttl)',
                    ConditionExpression: 'attribute_not_exists(seconds) OR seconds < :limit',
                    ExpressionAttributeNames: { '#ttl': 'ttl' },
                    ExpressionAttributeValues: { ':one': 1, ':ttl': usageTtl(400), ':limit': quotas.microvmMinutesPerMonth * 60 },
                  },
                },
                // With the long leases: reconciliation finds this reservation even if the launch
                // stops before anything else is written.
                {
                  Put: {
                    TableName: T,
                    Item: {
                      ...activeKey(jobId),
                      jobId,
                      installationId: id,
                      tenantSlot,
                      platformSlot,
                      day,
                      month,
                      phase: 'reserved',
                      reservedAt: Date.now(),
                      expiresAt: holdUntil,
                      ttl: ttl + 7 * 24 * 3600,
                    },
                  },
                },
              ],
            }),
          );
          return { ok: true, tenantSlot, platformSlot };
        } catch (err) {
          if (!(err instanceof TransactionCanceledException)) throw err;
          if (cancelledAt(err, 2)) return { ok: false, limit: 'jobs_per_day' };
          if (cancelledAt(err, 3)) return { ok: false, limit: 'microvm_minutes' };
        }
      }
      throw new Error(`reserveJob: the slots of tenant ${id} kept changing; retry the delivery`);
    },

    async cancelReservation(r, phase, retire) {
      // The counts go back with the entry's delete, in one transaction, only while the entry is
      // there in that phase: a retried or concurrent cancel (two reconciliations) gives back nothing.
      let outcome: 'cancelled' | 'gone' | 'mismatch' = 'cancelled';
      // An admin's release retires the job with it: a launch that finds its reservation gone then
      // finds the job finished, with the admin's outcome (first outcome kept, as finishJob keeps it).
      const finished = {
        UpdateExpression: 'SET #status = :finished, outcome = if_not_exists(outcome, :outcome), stopRequestedAt = if_not_exists(stopRequestedAt, :at)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':finished': 'finished', ':outcome': retire?.outcome, ':at': Date.now() },
      };
      const retiring = retire
        ? [
            { Update: { TableName: T, Key: { pk: `JOB#${retire.job.jobId}`, sk: 'META' }, ConditionExpression: 'attribute_exists(pk)', ...finished } },
            {
              Update: {
                TableName: T,
                Key: jobSummaryKey(retire.job),
                UpdateExpression: 'SET #status = :finished, outcome = if_not_exists(outcome, :outcome)',
                ConditionExpression: 'attribute_exists(pk)',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':finished': 'finished', ':outcome': retire.outcome },
              },
            },
          ]
        : [];
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: T,
                  Key: activeKey(r.jobId),
                  ConditionExpression: 'attribute_exists(pk) AND phase = :phase',
                  ExpressionAttributeValues: { ':phase': phase },
                },
              },
              ...[dayKey(r.installationId, r.day), monthKey(r.installationId, r.month)].map((key) => ({
                Update: { TableName: T, Key: key, UpdateExpression: 'ADD jobs :minus', ExpressionAttributeValues: { ':minus': -1 } },
              })),
              ...retiring,
            ],
          }),
        );
      } catch (err) {
        if (!(err instanceof TransactionCanceledException && cancelledAt(err, 0))) throw err;
        const entry = await client.send(new GetCommand({ TableName: T, Key: activeKey(r.jobId), ConsistentRead: true }));
        outcome = entry.Item ? 'mismatch' : 'gone';
      }
      // A launch moved it on: its slots are a live microVM's, not this cancel's to free.
      if (outcome === 'mismatch') return outcome;
      // Owner-checked, so safe to repeat: a cancel cut short after its transaction finishes here.
      await deleteIfHeld(tenantSlotKey(r.installationId, r.tenantSlot), r.jobId);
      await deleteIfHeld(platformSlotKey(r.platformSlot), r.jobId);
      return outcome;
    },

    async recordThrottle(id, month, notice) {
      await client.send(
        new UpdateCommand({
          TableName: T,
          Key: monthKey(id, month),
          UpdateExpression: 'ADD throttled :one SET #ttl = if_not_exists(#ttl, :ttl)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':ttl': usageTtl(400) },
        }),
      );
      if (!notice) return false;
      try {
        await client.send(
          new PutCommand({
            TableName: T,
            Item: { pk: `TENANT#${id}`, sk: `NOTICE#${notice.repositoryId}#${notice.issue}#${notice.day}`, ttl: usageTtl(2) },
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
        return true;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        return false;
      }
    },

    async getUsage(id, day, month) {
      const [d, m] = await Promise.all([
        client.send(new GetCommand({ TableName: T, Key: dayKey(id, day) })),
        client.send(new GetCommand({ TableName: T, Key: monthKey(id, month) })),
      ]);
      const n = (v: unknown) => (typeof v === 'number' ? v : 0);
      return {
        day,
        jobsToday: n(d.Item?.jobs),
        month,
        jobsThisMonth: n(m.Item?.jobs),
        microvmSecondsThisMonth: n(m.Item?.seconds),
        throttledThisMonth: n(m.Item?.throttled),
        failedThisMonth: n(m.Item?.failed),
      };
    },

    async releaseDelivery(id, deliveryId, jobId) {
      // Only the holder's: a redelivery's claim (another job) stays, and no claim is no-op.
      try {
        await client.send(
          new DeleteCommand({
            TableName: T,
            Key: deliveryKey(id, deliveryId),
            ConditionExpression: 'jobId = :job',
            ExpressionAttributeValues: { ':job': jobId },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
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

    async getTelemetry(id) {
      const out = await client.send(new GetCommand({ TableName: T, Key: { pk: `TENANT#${id}`, sk: 'TELEMETRY' }, ConsistentRead: true }));
      return out.Item ? toTelemetry(out.Item) : null;
    },

    async putTelemetry(id, settings: TelemetrySettings, expected: number) {
      // As for a key's metadata: with the uninstall check in the same transaction. The row is
      // written only over the version the caller read (none yet: 0).
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
                  Item: { pk: `TENANT#${id}`, sk: 'TELEMETRY', ...settings, version: expected + 1 },
                  ConditionExpression: expected === 0 ? 'attribute_not_exists(pk) OR attribute_not_exists(version)' : 'version = :v',
                  ...(expected === 0 ? {} : { ExpressionAttributeValues: { ':v': expected } }),
                },
              },
            ],
          }),
        );
        return 'stored';
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const [tenant, row] = err.CancellationReasons ?? [];
          if (tenant?.Code === 'ConditionalCheckFailed') return 'uninstalled';
          if (row?.Code === 'ConditionalCheckFailed') return 'conflict';
        }
        throw err;
      }
    },

    async recordTelemetryExport(id, result) {
      await tryUpdate({
        TableName: T,
        Key: { pk: `TENANT#${id}`, sk: 'TELEMETRY' },
        UpdateExpression: 'SET lastExport = :e',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':e': result },
      });
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
        .map((i) => ({
          name: String(i.name),
          updatedAt: String(i.updatedAt),
          updatedBy: String(i.updatedBy),
          ...(typeof i.lastUsedAt === 'string' ? { lastUsedAt: i.lastUsedAt, lastUsedOk: i.lastUsedOk === true } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async recordAgentKeyUse(id, name, use) {
      // Only a key that is set, and only the value the job could have read: a key rotated after
      // the job started is a newer value, whose status this job says nothing about.
      await tryUpdate({
        TableName: T,
        Key: { pk: `TENANT#${id}`, sk: `KEY#${name}` },
        UpdateExpression: 'SET lastUsedAt = :at, lastUsedOk = :ok',
        ConditionExpression: 'attribute_exists(pk) AND updatedAt <= :started',
        ExpressionAttributeValues: { ':at': use.at, ':ok': use.ok, ':started': use.jobStartedAt },
      });
    },

    async recordRefusal(id, r) {
      await client.send(
        new PutCommand({ TableName: T, Item: { pk: `TENANT#${id}`, sk: `REFUSAL#${r.at}#${r.deliveryId}`, ...r, ttl: usageTtl(30) } }),
      );
    },

    async listRefusals(id, limit) {
      const out = await client.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': `TENANT#${id}`, ':prefix': 'REFUSAL#' },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return (out.Items ?? []).map((i) => ({ at: String(i.at), deliveryId: String(i.deliveryId), repository: String(i.repository), issue: Number(i.issue), reason: String(i.reason) }));
    },
  };
}
