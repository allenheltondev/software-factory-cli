import { waitingId } from './native/sessions.js';
import { LambdaMicrovmsClient, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createWebhookHandler } from './flows/webhook.js';
import { createRoutineDispatcher } from './routines/dispatch.js';
import { createDynamoRoutineRuleStore } from './routines/rules.js';
import { createGitHubApi, GitHubError } from './github/client.js';
import { appJwt } from './github/jwt.js';
import { createSettingsLoader } from './github/settings.js';
import { createKillSwitch, KILL_SWITCH_PARAMETER } from './jobs/kill-switch.js';
import { createBundleKeys } from './tenants/key-needs.js';
import { configPrefix } from './tenants/paths.js';
import { createLauncher, internetEgressConnector, noIngressConnector, type Launcher, type LaunchRequest } from './jobs/launch.js';
import { quotasFromEnv, throttleCommentPermissions, throttledComment } from './jobs/quotas.js';
import { createRetryHandler, isRetryRequest, type RetryRequest, type RetryResult } from './jobs/retry.js';
import { createDynamoStore } from './store/dynamo.js';
import { nativeAws } from './native/aws.js';
import { BENCHMARK_LABEL } from './benchmarks/config.js';
import { createBenchmarkDispatch } from './benchmarks/dispatch.js';

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
const benchmarkInstallationId = Number(env.BENCHMARK_INSTALLATION_ID);
const benchmarkRepositoryId = Number(env.BENCHMARK_REPOSITORY_ID);
const benchmarkEnabled = Number.isSafeInteger(benchmarkInstallationId) && benchmarkInstallationId > 0 &&
  Number.isSafeInteger(benchmarkRepositoryId) && benchmarkRepositoryId > 0;

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

const nativeWorker = nativeAws(store);

function launcher(): Launcher | undefined {
  if (!env.JOB_IMAGE_ARN || !env.BROKER_FUNCTION_NAME) return undefined;
  const region = env.AWS_REGION ?? '';
  const partition = env.PARTITION ?? 'aws';
  return createLauncher({
    store,
    ...(benchmarkEnabled ? { benchmarkInstallationId } : {}),
    native: nativeWorker.launch,
    resolveNative: nativeWorker.resolveNative,
    ...(nativeWorker.managed ? {
      async parkedClaude(request) {
        const id = waitingId(request.installationId, request.deliveryId);
        return (await nativeWorker.managed!.sessions.get(request.installationId, id))?.id;
      },
      async waitForClaude(request, repository, repositoryId, issue) {
        const { installationId, deliveryId, eventName, appBot } = request;
        const id = waitingId(installationId, deliveryId);
        const eventKey = `tenants/${installationId}/events/claude-wait/${id}.json`;
        await s3.send(new PutObjectCommand({ Bucket: env.TENANT_BUCKET, Key: eventKey, Body: request.body, Tagging: 'updraft-retention=claude-wait' }));
        const waiting = await nativeWorker.managed!.sessions.park({ installationId, deliveryId, eventName, appBot }, eventKey);
        if (waiting.created && env.CLAUDE_CONSOLE_ORIGIN) {
          try {
            const settings = await loadSettings();
            if (settings) {
              const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId,
                { repositoryIds: [repositoryId], permissions: { issues: 'write' } });
              const url = new URL(`/installations/${installationId}/claude?request=${id}`, env.CLAUDE_CONSOLE_ORIGIN);
              await github.createIssueComment(token, repository, issue,
                `This Updraft job is waiting for Claude subscription sign-in. [Open the waiting job in Updraft](${url.href}). An installation owner can sign in once and the job will resume automatically.`);
            }
          } catch (error) { console.error(JSON.stringify({ claudeWaiting: 'issue comment failed', name: (error as Error)?.name })); }
        }
        return waiting.id;
      },
    } : {}),
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
const dispatchBenchmark = benchmarkEnabled && launch ? createBenchmarkDispatch({
  installationId: benchmarkInstallationId,
  repositoryId: benchmarkRepositoryId,
  store,
  launch,
  async readConfig(installationId, version) {
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: env.TENANT_BUCKET, Key: `${configPrefix(installationId, version)}config.yaml` }));
      return (await result.Body?.transformToString('utf8')) ?? null;
    } catch (error) {
      if ((error as Error)?.name === 'NoSuchKey') return null;
      throw error;
    }
  },
  async issueOpenWithMarker(installationId, repository, repositoryId, issue) {
    const settings = await loadSettings();
    if (!settings || !github.issueState) return false;
    try {
      const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId,
        { repositoryIds: [repositoryId], permissions: { issues: 'read' } });
      const state = await github.issueState(token, repository, issue);
      return state.open && !state.pullRequest && state.labels.some((label) => label.toLowerCase() === BENCHMARK_LABEL);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  },
}) : undefined;
const handleWebhook = createWebhookHandler({
  store,
  github,
  loadSettings,
  launch,
  ...(benchmarkEnabled ? { benchmarkInstallationId } : {}),
  routines: createRoutineDispatcher({
    store, rules: createDynamoRoutineRuleStore(env.TABLE_NAME ?? ''), killSwitch,
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

async function resumeClaude(installationId: number) {
  const sessions = nativeWorker.managed?.sessions;
  if (!sessions || !launch) return;
  for (const pending of await sessions.pending(installationId)) {
    const key = `tenants/${installationId}/events/claude-wait/${pending.id}.json`;
    if (pending.eventKey !== key || pending.request.installationId !== installationId) continue;
    const existing = await store.getJob(pending.id);
    if (existing) {
      await sessions.finish(installationId, pending.id, 'started', existing.jobId);
      continue;
    }
    const out = await s3.send(new GetObjectCommand({ Bucket: env.TENANT_BUCKET, Key: key }));
    const body = await out.Body?.transformToString('utf8');
    if (!body) throw new Error('Waiting job event unavailable');
    const payload = JSON.parse(body) as LaunchRequest['payload'];
    const repository = payload.repository?.full_name;
    const repositoryId = payload.repository?.id;
    const issue = payload.issue?.number;
    const label = payload.label?.name;
    if (typeof repository !== 'string' || typeof repositoryId !== 'number' || typeof issue !== 'number' || typeof label !== 'string') {
      await sessions.finish(installationId, pending.id, 'canceled', 'The original issue or label is unavailable.');
      continue;
    }
    const settings = await loadSettings();
    if (!settings || !github.issueState) throw new Error('GitHub issue status is unavailable');
    let current;
    try {
      const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId,
        { repositoryIds: [repositoryId], permissions: { issues: 'read' } });
      current = await github.issueState(token, repository, issue);
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      await sessions.finish(installationId, pending.id, 'canceled', 'The issue or repository is no longer accessible.');
      continue;
    }
    if (!current.open || !current.labels.some((name) => name.toLowerCase() === label.toLowerCase())) {
      await sessions.finish(installationId, pending.id, 'canceled', 'The issue was closed or its start label was removed.');
      continue;
    }
    const result = await launch({ ...pending.request, body, payload, jobId: pending.id, resumeClaude: true });
    if (result.disposition === 'launched' && result.jobId) await sessions.finish(installationId, pending.id, 'started', result.jobId);
    else if (['not_dispatched', 'tenant_inactive', 'no_config', 'missing_key'].includes(result.disposition) &&
      result.reason !== 'native_worker_unavailable') {
      await sessions.finish(installationId, pending.id, 'canceled', result.message ?? 'This job is no longer eligible to start. Check the installation configuration.');
    }
  }
}

export async function handler(event: APIGatewayProxyEvent | RetryRequest | { action: 'resumeClaude'; installationId: number }): Promise<APIGatewayProxyResult | RetryResult | void> {
  if ('action' in event) {
    if (event.action === 'resumeClaude' && Number.isSafeInteger(event.installationId) && event.installationId > 0) await resumeClaude(event.installationId);
    return;
  }
  if (isRetryRequest(event)) {
    return retryJob ? retryJob(event) : { ok: false, status: 503, code: 'jobs_off', message: 'Jobs are not configured' };
  }
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');
  if (event.resource === '/api/benchmark/jobs' && event.httpMethod === 'POST') {
    const reply = (statusCode: number, data: object) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    if (!dispatchBenchmark) return reply(404, { disposition: 'benchmark_unavailable' });
    const identity = event.requestContext?.identity;
    if (!identity?.userArn || identity.accountId !== env.BENCHMARK_ACCOUNT_ID) return reply(403, { disposition: 'forbidden' });
    if (Buffer.byteLength(body) > 8192) return reply(400, { disposition: 'invalid_benchmark' });
    let request: unknown;
    try { request = JSON.parse(body); } catch { return reply(400, { disposition: 'invalid_benchmark' }); }
    const result = await dispatchBenchmark(request);
    return reply(result.status, result);
  }
  const res = await handleWebhook({ body, headers: event.headers ?? {} });
  return { statusCode: res.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(res.body) };
}
