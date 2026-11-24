import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { handle } from 'hono/aws-lambda';
import { adminAccess, DEFAULT_ADMIN_GROUP } from './admin/access.js';
import { createAdminService } from './admin/admin.js';
import { createApp } from './app.js';
import { callerFromClaims, groupsFrom, type Claims } from './caller.js';
import { createGitHubFlows } from './flows/github.js';
import { createGitHubApi } from './github/client.js';
import { createSettingsLoader } from './github/settings.js';
import type { RetryRequest, RetryResult } from './jobs/retry.js';
import { quotasFromEnv } from './jobs/quotas.js';
import { createDynamoStore } from './store/dynamo.js';
import { managedClaude } from './native/managed.js';
import { browserLoginGrant } from './native/browser-login.js';
import { nativeRoute } from './native/route.js';
import { createNativeModeStore, createNativeStore } from './native/store.js';
import { createNativeSettingsService } from './native/settings.js';
import { createAgentKeyService } from './tenants/agent-key-service.js';
import { createSecretsManagerPort } from './tenants/secrets-manager.js';
import { checkAgentKeyWithProvider } from './tenants/key-check.js';
import { createBundleKeys } from './tenants/key-needs.js';
import { configPrefix } from './tenants/paths.js';
import { createS3LogReader, createS3StateReader } from './tenants/s3-logs.js';
import { createStatsService } from './tenants/stats-service.js';
import { checkHoneycombKey, createTelemetryService, parseTimelineTemplate } from './tenants/telemetry-service.js';
import { createStatusService } from './tenants/status-service.js';
import { createConfigService, type ObjectStore } from './tenants/config-service.js';

/**
 * The API's Lambda entry point (bundled to dist/index.mjs by scripts/bundle.mjs). API Gateway (REST,
 * Cognito authorizer) invokes it with a proxy event; the authorizer's verified claims are on
 * `requestContext.authorizer.claims`. Those are all strings, so the caller's groups (what admin
 * access is decided by) come from verifying the same ID token here, where `cognito:groups` is the
 * token's own array and each group name is exact.
 */

const clientId = process.env.USER_POOL_CLIENT_ID ?? '';
if (!clientId) console.error('USER_POOL_CLIENT_ID is not set; every /api/v1 request will be refused');
const userPoolId = process.env.USER_POOL_ID ?? '';
const verifier = userPoolId && clientId ? CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' }) : null;
const managedWorker = managedClaude();
const tableName = process.env.TABLE_NAME ?? '';
const store = tableName ? createDynamoStore(tableName) : undefined;
const github = store ? createGitHubFlows({ store, github: createGitHubApi(), loadSettings: createSettingsLoader() }) : undefined;

// Tenant config bundles (tenants/config-service.ts). The function's role reaches only
// tenants/*/config/* in the bucket (template.yaml).
const bucket = process.env.TENANT_BUCKET ?? '';
/** Agent Timeline has no documented conversation link; a deployment that knows one sets its template (tenants/telemetry-service.ts). */
const timelineTemplate = parseTimelineTemplate(process.env.HONEYCOMB_TIMELINE_URL);
if (process.env.HONEYCOMB_TIMELINE_URL && !timelineTemplate) {
  console.log(JSON.stringify({ warning: 'HONEYCOMB_TIMELINE_URL is not a template a link can be made from (it must start with {ui}/{team}/ and name {conversation}); no Agent Timeline links' }));
}
const s3 = new S3Client({});
const objects: ObjectStore = {
  async get(key) {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await out.Body?.transformToString('utf8')) ?? null;
  },
  async put(key, body, contentType) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  },
};

// A job's logs (tenants/status-service.ts): only their end, read with a range. The function's
// role reaches tenants/*/results/* for this, read only.
const readLog = createS3LogReader(s3, bucket);

// Retrying a job (jobs/retry.ts): the webhook function holds the launcher's permissions, so this
// one invokes it directly, and only for a job it has already checked the caller may retry.
const retryFunction = process.env.WEBHOOK_FUNCTION_NAME ?? '';
const lambda = retryFunction ? new LambdaClient({}) : undefined;
const requestRetry = async (installationId: number, jobId: string): Promise<RetryResult> => {
  const out = await lambda!.send(
    new InvokeCommand({ FunctionName: retryFunction, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ updraftRetry: { installationId, jobId } } satisfies RetryRequest)) }),
  );
  // A function error (a crash, a timeout) carries no result: not a retry that started.
  if (out.FunctionError || !out.Payload) return { ok: false, status: 502, code: 'retry_failed', message: 'The job could not be started; try again' };
  return JSON.parse(Buffer.from(out.Payload).toString('utf8')) as RetryResult;
};

const agentKeyService =
  store && github
    ? createAgentKeyService({
        store,
        github,
        secrets: createSecretsManagerPort(),
        check: checkAgentKeyWithProvider(),
        ...(bucket
          ? {
              bundleKeys: createBundleKeys(async (key) => {
                try {
                  return await objects.get(key);
                } catch (err) {
                  if ((err as { name?: string }).name === 'NoSuchKey') return null;
                  throw err;
                }
              }, configPrefix),
            }
          : {}),
      })
    : undefined;

const app = createApp({
  resolveCaller: async (c) => {
    const event = (c.env as { event?: APIGatewayProxyEvent } | undefined)?.event;
    const claims = event?.requestContext?.authorizer?.claims as Claims | undefined;
    const caller = callerFromClaims(claims, clientId);
    if (!caller || !verifier) return caller;
    // The same token the authorizer accepted; a token that does not verify, or is someone else's,
    // leaves the caller with no groups (no admin access), never without a session.
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    try {
      const payload = await verifier.verify(token);
      if (payload.sub === caller.sub) {
        const groups = groupsFrom(payload['cognito:groups']);
        if (groups.length > 0) caller.groups = groups;
      }
    } catch {
      // No groups.
    }
    return caller;
  },
  ...(store && github && agentKeyService
    ? {
        github,
        agentKeys: agentKeyService,
        nativeClaude: createNativeSettingsService({ github, store,
          ...(managedWorker ? { managed: { ...managedWorker, grant: (route) => browserLoginGrant(managedWorker.imageArn, route) } } : {}),
          route: nativeRoute(process.env.NATIVE_WORKER_ROUTE),
          loginGrant: browserLoginGrant(process.env.NATIVE_WORKER_LOGIN_IMAGE_ARN ?? '', nativeRoute(process.env.NATIVE_WORKER_ROUTE)),
          mode: createNativeModeStore(tableName), workers: createNativeStore(tableName) }),
        status: createStatusService({
          store,
          github,
          agentKeys: agentKeyService,
          resultRetentionDays: Math.max(1, Number(process.env.RESULT_RETENTION_DAYS ?? 30) || 30),
          timelineTemplate,
          ...(bucket ? { readLog } : {}),
          ...(retryFunction ? { requestRetry } : {}),
        }),
        ...(bucket ? { config: createConfigService({ store, github, objects }) } : {}),
        // Insights: the tenant's shared state database, read only (tenants/*/state/state.db).
        telemetry: createTelemetryService({ store, github, secrets: createSecretsManagerPort(), check: checkHoneycombKey() }),
        stats: createStatsService({ github, store, ...(bucket ? { readState: createS3StateReader(s3, bucket) } : {}), cacheDir: '/tmp/updraft-state' }),
        admin: {
          access: adminAccess(process.env.ADMIN_GROUP ?? DEFAULT_ADMIN_GROUP),
          service: createAdminService({ store, quotas: quotasFromEnv(process.env) }),
        },
      }
    : {}),
});

export const handler = handle(app);
