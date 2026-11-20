import { LambdaMicrovmsClient, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createWebhookHandler } from './flows/webhook.js';
import { createGitHubApi } from './github/client.js';
import { appJwt } from './github/jwt.js';
import { createSettingsLoader } from './github/settings.js';
import { createKillSwitch, KILL_SWITCH_PARAMETER } from './jobs/kill-switch.js';
import { createLauncher, internetEgressConnector, noIngressConnector, type Launcher } from './jobs/launch.js';
import { quotasFromEnv, throttledComment } from './jobs/quotas.js';
import { createDynamoStore } from './store/dynamo.js';

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
    putEvent: async (key, body) => {
      await s3.send(new PutObjectCommand({ Bucket: env.TENANT_BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
    },
    runMicrovm: async (input) => {
      const out = await microvms.send(new RunMicrovmCommand(input));
      return { microvmId: out.microvmId };
    },
    quotas: quotasFromEnv(env),
    killSwitch,
    // The App's own token for that one repository, allowed only to write issues.
    notifyThrottled: async ({ installationId, repository, repositoryId, issue, limit, quotas }) => {
      const settings = await loadSettings();
      if (!settings) return;
      const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId, {
        repositoryIds: [repositoryId],
        permissions: { issues: 'write' },
      });
      await github.createIssueComment(token, repository, issue, throttledComment(limit, quotas));
    },
  });
}

const handleWebhook = createWebhookHandler({
  store,
  github,
  loadSettings,
  launch: launcher(),
});

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');
  const res = await handleWebhook({ body, headers: event.headers ?? {} });
  return { statusCode: res.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(res.body) };
}
