import { LambdaMicrovmsClient, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createWebhookHandler } from './flows/webhook.js';
import { createRoutineDispatcher } from './routines/dispatch.js';
import { createDynamoRoutineRuleStore } from './routines/rules.js';
import { createGitHubApi } from './github/client.js';
import { appJwt } from './github/jwt.js';
import { createSettingsLoader } from './github/settings.js';
import { createKillSwitch, KILL_SWITCH_PARAMETER } from './jobs/kill-switch.js';
import { createBundleKeys } from './tenants/key-needs.js';
import { configPrefix } from './tenants/paths.js';
import { createLauncher, internetEgressConnector, noIngressConnector, type Launcher } from './jobs/launch.js';
import { quotasFromEnv, throttleCommentPermissions, throttledComment } from './jobs/quotas.js';
import { createRetryHandler, isRetryRequest, type RetryRequest, type RetryResult } from './jobs/retry.js';
import { createDynamoStore } from './store/dynamo.js';
import { nativeAws } from './native/aws.js';

/**
 * The GitHub webhook's Lambda entry point (dist/webhook.mjs): POST /api/webhooks/github, a route
 * with no authorizer. API Gateway passes a JSON body through as the exact string GitHub signed.
 */

const env = process.env;
const store = createDynamoStore(env.TABLE_NAME ?? '');

// GitHub waits 10 seconds for a webhook: one retry at most.
const clientOptions = { maxAttempts: 2 };
const s3 = new S3Client(clientOptions);
const ssm = new SSMClient(clientOptions);
const secrets = new SecretsManagerClient(clientOptions);
const microvms = new LambdaMicrovmsClient(clientOptions);
const github = createGitHubApi();
const loadSettings = createSettingsLoader();

const killSwitch = createKillSwitch({
  read: async () => {
    try {
      return (await ssm.send(new GetParameterCommand({ Name: env.KILL_SWITCH_PARAMETER || KILL_SWITCH_PARAMETER }))).Parameter?.Value ?? null;
    } catch (err) {
      if (err instanceof ParameterNotFound) return null;
      throw err;
    }
  },
});

// The published image version (scripts/build-job-image.ts writes it after a successful build).
// Cached briefly, so a new build is picked up within a minute without a deploy.
const IMAGE_VERSION_TTL_MS = 60_000;
let cachedVersion: { value: string | null; at: number } | undefined;
async function imageVersion(): Promise<string | null> {
  if (cachedVersion && Date.now() - cachedVersion.at < IMAGE_VERSION_TTL_MS) return cachedVersion.value;
  let value: string | null = null;
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: env.JOB_IMAGE_VERSION_PARAMETER ?? '' }));
    value = out.Parameter?.Value?.trim() || null;
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err;
  }
  cachedVersion = { value, at: Date.now() };
  return value;
}

function launcher(): Launcher | undefined {
  if (!env.JOB_IMAGE_ARN || !env.BROKER_FUNCTION_NAME) return undefined;
  const region = env.AWS_REGION ?? '';
  const partition = env.PARTITION ?? 'aws';
  return createLauncher({
    store,
    native: nativeAws(store).launch,
    settings: {
      region,
      bucket: env.TENANT_BUCKET ?? '',
      imageArn: env.JOB_IMAGE_ARN,
      executionRoleArn: env.EXECUTION_ROLE_ARN ?? '',
      ingressConnectorArn: noIngressConnector(partition, region),
      egressConnectorArn: internetEgressConnector(partition, region),
      logGroup: env.MICROVM_LOG_GROUP ?? '',
      brokerFunctionName: env.BROKER_FUNCTION_NAME,
      maximumDurationSeconds: Number(env.MAX_DURATION_SECONDS ?? 10800),
      watchdogReserveSeconds: Number(env.WATCHDOG_RESERVE_SECONDS ?? 600),
    },
    imageVersion,
    bundleKeys: createBundleKeys(async (key) => {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: env.TENANT_BUCKET, Key: key }));
        return (await out.Body?.transformToString('utf8')) ?? null;
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null;
        throw err;
      }
    }, configPrefix),
    putEvent: async (key, body) => {
      await s3.send(new PutObjectCommand({ Bucket: env.TENANT_BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
    },
    runMicrovm: async (input) => {
      const out = await microvms.send(new RunMicrovmCommand(input));
      return { microvmId: out.microvmId };
    },
    quotas: quotasFromEnv(env),
    killSwitch,
    // The App's own token for that one repository, allowed only to write issues (and a pull request's conversation).
    notifyThrottled: async ({ installationId, repository, repositoryId, issue, pullRequest, limit, quotas }) => {
      const settings = await loadSettings();
      if (!settings) return;
      const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId, {
        repositoryIds: [repositoryId],
        permissions: throttleCommentPermissions(pullRequest),
      });
      await github.createIssueComment(token, repository, issue, throttledComment(limit, quotas, pullRequest));
    },
  });
}

const launch = launcher();
const handleWebhook = createWebhookHandler({
  store,
  github,
  loadSettings,
  launch,
  routines: createRoutineDispatcher({
    store, rules: createDynamoRoutineRuleStore(env.TABLE_NAME ?? ''),
    readToken: async (name) => (await secrets.send(new GetSecretValueCommand({ SecretId: name }))).SecretString ?? null,
    notifyRun: async (installationId, repository, repositoryId, issue, sessionUrl) => {
      const settings = await loadSettings();
      if (!settings) return;
      const token = (await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId,
        { repositoryIds: [repositoryId], permissions: { issues: 'write' } })).token;
      await github.createIssueComment(token, repository, issue, `Claude Code scheduled task started: ${sessionUrl}`);
    },
  }),
});

// A retry from the console (jobs/retry.ts): the API function invokes this one directly, since
// the launcher's permissions are here. Only a caller allowed to invoke the function can send it.
const retryJob = launch
  ? createRetryHandler({
      store,
      launch,
      readEvent: async (key) => {
        try {
          const out = await s3.send(new GetObjectCommand({ Bucket: env.TENANT_BUCKET, Key: key }));
          return (await out.Body?.transformToString('utf8')) ?? null;
        } catch (err) {
          if ((err as { name?: string }).name === 'NoSuchKey') return null;
          throw err;
        }
      },
      appBot: async () => {
        const settings = await loadSettings();
        return settings?.slug ? `${settings.slug}[bot]` : undefined;
      },
    })
  : undefined;

export async function handler(event: APIGatewayProxyEvent | RetryRequest): Promise<APIGatewayProxyResult | RetryResult> {
  if (isRetryRequest(event)) {
    return retryJob ? retryJob(event) : { ok: false, status: 503, code: 'jobs_off', message: 'Jobs are not configured' };
  }
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');
  const res = await handleWebhook({ body, headers: event.headers ?? {} });
  return { statusCode: res.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(res.body) };
}
