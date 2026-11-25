import { createWorkflowService } from './tenants/workflow-service.js';
import { createDynamoWorkflowStore } from './workflows/store.js';
import { createWorkflowRecorder } from './workflows/recorder.js';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { handle } from 'hono/aws-lambda';
import { adminAccess, DEFAULT_ADMIN_GROUP } from './admin/access.js';
import { createAdminService } from './admin/admin.js';
import { createApp } from './app.js';
import { createRoutineService } from './routines/service.js';
import { createDynamoRoutineRuleStore } from './routines/rules.js';
import { callerFromClaims, groupsFrom, type Claims } from './caller.js';
import { createGitHubFlows } from './flows/github.js';
import { createGitHubApi } from './github/client.js';
import { createSettingsLoader } from './github/settings.js';
import type { RetryRequest, RetryResult } from './jobs/retry.js';
import type { QueueCancelRequest, QueueCancelResult } from './jobs/queue.js';
import { createDynamoQueueStore } from './jobs/queue-store.js';
import { awsJobStopper } from './jobs/stop-aws.js';
import { nativeAws } from './native/aws.js';
import { quotasFromEnv } from './jobs/quotas.js';
import { createDynamoStore } from './store/dynamo.js';
import { managedClaude } from './native/managed.js';
import { browserLoginGrant } from './native/browser-login.js';
import { legacyNativeTriggers, nativeRoute } from './native/route.js';
import { createKillSwitch, KILL_SWITCH_PARAMETER } from './jobs/kill-switch.js';
import { createReadinessService } from './tenants/readiness-service.js';
import { createNativeModeStore, createNativeStore } from './native/store.js';
import { createNativeSettingsService } from './native/settings.js';
import { createRegistryPolicyService } from './native/registries.js';
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
const requestRetry = async (installationId: number, jobId: string, by?: string): Promise<RetryResult> => {
  const out = await lambda!.send(
    new InvokeCommand({ FunctionName: retryFunction, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ updraftRetry: { installationId, jobId, ...(by ? { by } : {}) } } satisfies RetryRequest)) }),
  );
  // A function error (a crash, a timeout) carries no result: not a retry that started.
  if (out.FunctionError || !out.Payload) return { ok: false, status: 502, code: 'retry_failed', message: 'The job could not be started; try again' };
  return JSON.parse(Buffer.from(out.Payload).toString('utf8')) as RetryResult;
};
// Canceling a queued job (jobs/queue.ts): the webhook function owns the queue's transitions and
// its GitHub comment; this one has checked the caller owns the installation and the entry is its.
const requestQueueCancel = async (installationId: number, jobId: string, by: string): Promise<QueueCancelResult> => {
  const out = await lambda!.send(
    new InvokeCommand({ FunctionName: retryFunction, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ updraftQueue: { action: 'cancel', installationId, jobId, by } } satisfies QueueCancelRequest)) }),
  );
  if (out.FunctionError || !out.Payload) throw new Error('the queued job could not be canceled');
  return JSON.parse(Buffer.from(out.Payload).toString('utf8')) as QueueCancelResult;
};

// Repository readiness (tenants/readiness-service.ts) reads what the launcher reads, and nothing
// more: the kill switch, the published job image, the subscription worker's heartbeat. Never a
// write, a worker start or a model call.
const ssm = new SSMClient({});
const parameter = async (name: string): Promise<string | null> => {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value ?? null;
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
};
const killSwitch = createKillSwitch({ read: () => parameter(process.env.KILL_SWITCH_PARAMETER || KILL_SWITCH_PARAMETER) });
const jobImageParameter = process.env.JOB_IMAGE_VERSION_PARAMETER ?? '';
const native = store ? nativeAws(store) : undefined;

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
        routines: createRoutineService({ store, github, rules: createDynamoRoutineRuleStore(tableName), secrets: createSecretsManagerPort() }),
        nativeClaude: createNativeSettingsService({ github, store,
          ...(managedWorker ? { managed: { ...managedWorker, grant: (route) => browserLoginGrant(managedWorker.imageArn, route) } } : {}),
          route: nativeRoute(process.env.NATIVE_WORKER_ROUTE),
          loginGrant: browserLoginGrant(process.env.NATIVE_WORKER_LOGIN_IMAGE_ARN ?? '', nativeRoute(process.env.NATIVE_WORKER_ROUTE)),
          mode: createNativeModeStore(tableName), workers: createNativeStore(tableName) }),
        workflows: createWorkflowService({ store: createDynamoWorkflowStore(tableName), jobs: store, pauses: store, github }),
        status: createStatusService({
          store,
          requestStop: awsJobStopper(store, native!.control, createWorkflowRecorder({ store: createDynamoWorkflowStore(tableName) })).request,
          github,
          agentKeys: agentKeyService,
          resultRetentionDays: Math.max(1, Number(process.env.RESULT_RETENTION_DAYS ?? 30) || 30),
          timelineTemplate,
          ...(bucket ? { readLog } : {}),
          ...(retryFunction ? { requestRetry, requestQueueCancel } : {}),
          queue: createDynamoQueueStore(tableName),
        }),
        ...(bucket ? { config: createConfigService({ store, github, objects }) } : {}),
        readiness: createReadinessService({
          store,
          github,
          agentKeys: agentKeyService,
          quotas: quotasFromEnv(process.env),
          killSwitch,
          ...(jobImageParameter ? { imageVersion: async () => (await parameter(jobImageParameter))?.trim() || null } : {}),
          native: async (id) => {
            // The binding dispatch would use: the pinned route for its installation, else the managed session.
            const binding = native?.launch?.route.installationId === id ? native.launch : await native?.resolveNative?.(id);
            if (!binding) return undefined;
            const mode = await binding.mode();
            return { enabled: mode.enabled, explicitTriggers: mode.triggers !== undefined, triggers: mode.triggers ?? legacyNativeTriggers(binding.route), readiness: binding.readiness };
          },
        }),
        // Insights: the tenant's shared state database, read only (tenants/*/state/state.db).
        telemetry: createTelemetryService({ store, github, secrets: createSecretsManagerPort(), check: checkHoneycombKey() }),
        registries: createRegistryPolicyService({ store, github }),
        stats: createStatsService({ github, store, ...(bucket ? { readState: createS3StateReader(s3, bucket) } : {}), cacheDir: '/tmp/updraft-state' }),
        admin: {
          access: adminAccess(process.env.ADMIN_GROUP ?? DEFAULT_ADMIN_GROUP),
          service: createAdminService({ store, quotas: quotasFromEnv(process.env) }),
        },
      }
    : {}),
});

export const handler = handle(app);
