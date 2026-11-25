import { createDynamoWorkflowStore } from './workflows/store.js';
import { createWorkflowRecorder } from './workflows/recorder.js';
import { createWorkflowReconciler, type ReconcileReport } from './workflows/reconcile.js';
import { createLabelScanner, type LabelScanReport } from './workflows/label-scan.js';
import { reconcileMetricsLine } from './workflows/metrics.js';
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
import { createLauncher, internetEgressConnector, noIngressConnector, waitingComment, type Launcher, type LaunchRequest } from './jobs/launch.js';
import { quotasFromEnv, throttleCommentPermissions, throttledComment } from './jobs/quotas.js';
import { createAdmissionQueue, createGitHubRevalidator, createQueueDispatcher, dispatchMetricsLine, isQueueCancelRequest, type DispatchReport, type QueueCancelRequest, type QueueCancelResult, type QueueNotifier } from './jobs/queue.js';
import { createDynamoQueueStore, type QueueEntry } from './jobs/queue-store.js';
import { createRetryHandler, isRetryRequest, type RetryRequest, type RetryResult } from './jobs/retry.js';
import { createDynamoStore } from './store/dynamo.js';
import { nativeAws } from './native/aws.js';
import { awsJobStopper } from './jobs/stop-aws.js';
import { BENCHMARK_LABEL } from './benchmarks/config.js';
import { createBenchmarkDispatch } from './benchmarks/dispatch.js';

/**
 * The GitHub webhook's Lambda entry point (dist/webhook.mjs): POST /api/webhooks/github, a route
 * with no authorizer. API Gateway passes a JSON body through as the exact string GitHub signed.
 */

const env = process.env;
const store = createDynamoStore(env.TABLE_NAME ?? '');
const workflowStore = createDynamoWorkflowStore(env.TABLE_NAME ?? '');
const workflows = createWorkflowRecorder({ store: workflowStore });

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
const benchmarkInstallationConfigured = Number.isSafeInteger(benchmarkInstallationId) && benchmarkInstallationId > 0;
const benchmarkEnabled = benchmarkInstallationConfigured &&
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
const stopJob = awsJobStopper(store, nativeWorker.control, workflows);

const putEvent = async (key: string, body: string) => {
  await s3.send(new PutObjectCommand({ Bucket: env.TENANT_BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
};
const readEvent = async (key: string) => {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: env.TENANT_BUCKET, Key: key }));
    return (await out.Body?.transformToString('utf8')) ?? null;
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
};

// The admission queue (jobs/queue.ts): its acknowledgement is the App's own comment, written with
// a token for that one repository, allowed only to write issues (and a pull request's conversation).
const queueStore = createDynamoQueueStore(env.TABLE_NAME ?? '');
const consoleOrigin = env.UPDRAFT_CONSOLE_ORIGIN || undefined;
const queueToken = async (entry: QueueEntry) => {
  const settings = await loadSettings();
  if (!settings) throw new Error('the App settings are unavailable');
  const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), entry.installationId, {
    repositoryIds: [entry.repositoryId],
    permissions: throttleCommentPermissions(entry.issue === undefined),
  });
  return { token, bot: settings.slug ? `${settings.slug}[bot]` : undefined };
};
const queueNotifier: QueueNotifier = {
  async post(entry, body, marker) {
    const { token, bot } = await queueToken(entry);
    const subject = (entry.issue ?? entry.pullRequest)!;
    // A post whose answer was lost: found again, never posted twice.
    const existing = await github.findIssueComment!(token, entry.repository, subject, marker, bot);
    return existing ?? (await github.postIssueComment!(token, entry.repository, subject, body));
  },
  async find(entry, marker) {
    const { token, bot } = await queueToken(entry);
    return (await github.findIssueComment!(token, entry.repository, (entry.issue ?? entry.pullRequest)!, marker, bot)) ?? undefined;
  },
  async update(entry, commentId, body) {
    const { token } = await queueToken(entry);
    await github.updateIssueComment!(token, entry.repository, commentId, body);
  },
};
const admissionQueue = createAdmissionQueue({ store: queueStore, putEvent, notify: queueNotifier, workflows, ...(consoleOrigin ? { consoleOrigin } : {}) });


function launcher(): Launcher | undefined {
  if (!env.JOB_IMAGE_ARN || !env.BROKER_FUNCTION_NAME) return undefined;
  const region = env.AWS_REGION ?? '';
  const partition = env.PARTITION ?? 'aws';
  return createLauncher({
    store,
    stopJob: stopJob.advance,
    workflows,
    ...(benchmarkInstallationConfigured ? { benchmarkInstallationId } : {}),
    native: nativeWorker.launch,
    resolveNative: nativeWorker.resolveNative,
    ...(nativeWorker.managed ? {
      async parkedClaude(request) {
        const id = waitingId(request.installationId, request.deliveryId);
        return (await nativeWorker.managed!.sessions.get(request.installationId, id))?.id;
      },
      async waitForClaude(request, repository, repositoryId, issue, reason) {
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
                waitingComment(url.href, reason));
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
      consoleOrigin: env.UPDRAFT_CONSOLE_ORIGIN || undefined,
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
    putEvent,
    queue: admissionQueue,
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
const dispatcher = launch
  ? createQueueDispatcher({
      queue: queueStore,
      jobs: store,
      launch,
      readEvent,
      revalidate: createGitHubRevalidator({ github, loadSettings }),
      notify: queueNotifier,
      workflows,
      killSwitch,
      capacity: { store, quotas: quotasFromEnv(env) },
      ...(consoleOrigin ? { consoleOrigin } : {}),
    })
  : undefined;
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
  ...(dispatcher ? { queueEvents: dispatcher } : {}),
  ...(benchmarkInstallationConfigured ? { benchmarkInstallationId } : {}),
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
      readEvent,
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

// Workflow reconciliation (workflows/reconcile.ts), on its own schedule. It reports what it
// finds and starts no job.
const reconcileWorkflows = createWorkflowReconciler({ store: workflowStore, controls: store, jobs: store, github, loadSettings, killSwitch });

const scanLabels = createLabelScanner({ tenants: store, store: workflowStore, github, loadSettings });

const isStreamWake = (event: object): event is { Records: unknown[] } => 'Records' in event && Array.isArray((event as { Records?: unknown }).Records);

/** A dispatch run: on the schedule, or woken by the table stream (a slot freed, work queued). */
async function dispatchQueue(trigger: 'schedule' | 'wake'): Promise<DispatchReport | undefined> {
  if (!dispatcher) return undefined;
  const report = await dispatcher.dispatch();
  console.log(dispatchMetricsLine(report, trigger, Date.now()));
  return report;
}

export async function handler(
  event: APIGatewayProxyEvent | RetryRequest | QueueCancelRequest | { action: 'resumeClaude'; installationId: number } | { action: 'reconcileWorkflows' } | { action: 'dispatchQueue' } | { Records: unknown[] },
): Promise<APIGatewayProxyResult | RetryResult | QueueCancelResult | DispatchReport | (ReconcileReport & { labels: LabelScanReport }) | void> {
  // The table stream (template.yaml QueueWake): a slot was given back, or work was queued. Only a
  // wakeup: the scheduled run catches anything this misses, so it never fails (no stream retries).
  if (isStreamWake(event)) {
    try {
      await dispatchQueue('wake');
    } catch (err) {
      console.error(JSON.stringify({ queueDispatch: 'wake failed', name: (err as Error)?.name, message: (err as Error)?.message }));
    }
    return;
  }
  if ('action' in event && event.action === 'dispatchQueue') {
    const report = await dispatchQueue('schedule');
    if (report && report.failed > 0) throw new Error(`queue dispatch failed for ${report.failed} entr${report.failed === 1 ? 'y' : 'ies'}`);
    return report;
  }
  if (isQueueCancelRequest(event)) {
    if (!dispatcher) return { ok: false, status: 404, code: 'not_found', message: 'Jobs are not configured' };
    const { installationId, jobId, by } = event.updraftQueue;
    return dispatcher.cancel(installationId, jobId, by);
  }
  if ('action' in event && event.action === 'reconcileWorkflows') {
    const report = await reconcileWorkflows();
    // Labeled issues whose delivery never came (workflows/label-scan.ts): reported, never started.
    const labels = !(await killSwitch.engaged()) ? await scanLabels() : { tenants: 0, flagged: 0, failed: 0 };
    const combined = { ...report, labels };
    // Metrics first, whatever follows: a failing run is what the alarms look for.
    console.log(reconcileMetricsLine(report, labels, Date.now()));
    // The next run (five minutes on) retries what failed; fail this one so alarms see it.
    if (report.failed > 0 || labels.failed > 0) throw new Error(`workflow reconciliation failed for ${report.failed} workflow(s) and ${labels.failed} tenant label scan(s)`);
    return combined;
  }
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
