// The launcher's logic, free of the AWS SDK so it can be tested with stand-ins: configuration
// from the environment, the RunMicrovm input, and the webhook handler itself.
import { verifySignature } from './signature.mjs';
import { canLaunch, decideEvent } from './filter.mjs';

/** RunMicrovm's runHookPayload limit ("max 16 KB"; the API model says 16,384 bytes). */
export const MAX_RUN_HOOK_PAYLOAD_BYTES = 16384;
/** RunMicrovm's maximumDurationInSeconds range. */
export const MAX_DURATION_LIMIT_SECONDS = 28800;
/** Version of the run-hook payload. The runner in the image refuses versions it does not know. */
export const PAYLOAD_VERSION = 1;

// GitHub sends a GUID. The id becomes part of an S3 key, so accept nothing else.
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const EVENT_NAME_PATTERN = /^[a-z_]{1,64}$/;

/**
 * Reads the launcher's settings from environment variables (set by the SAM template).
 * Throws with the name of the first missing or invalid variable.
 */
export function loadConfig(env) {
  const need = (name) => {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is not set`);
    return value.trim();
  };
  const integer = (name, min, max) => {
    const value = Number(need(name));
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  const maximumDurationSeconds = integer('MAX_DURATION_SECONDS', 600, MAX_DURATION_LIMIT_SECONDS);
  const watchdogReserveSeconds = integer('WATCHDOG_RESERVE_SECONDS', 60, 3600);
  if (watchdogReserveSeconds >= maximumDurationSeconds) {
    throw new Error('WATCHDOG_RESERVE_SECONDS must be less than MAX_DURATION_SECONDS');
  }
  const dedupeWindowSeconds = env.DEDUPE_WINDOW_SECONDS === undefined || env.DEDUPE_WINDOW_SECONDS === '' ? 0 : integer('DEDUPE_WINDOW_SECONDS', 0, 86400);
  const dedupeTable = (env.DEDUPE_TABLE ?? '').trim();
  if (dedupeWindowSeconds > 0 && dedupeTable === '') throw new Error('DEDUPE_TABLE is not set but DEDUPE_WINDOW_SECONDS is');
  const idlePolicyMode = (env.IDLE_POLICY_MODE ?? 'explicit').trim() || 'explicit';
  if (idlePolicyMode !== 'explicit' && idlePolicyMode !== 'omit') {
    throw new Error('IDLE_POLICY_MODE must be "explicit" or "omit"');
  }
  return {
    region: need('AWS_REGION'),
    imageArn: need('IMAGE_ARN'),
    imageVersion: (env.IMAGE_VERSION ?? '').trim(),
    executionRoleArn: need('EXECUTION_ROLE_ARN'),
    ingressConnectorArn: need('INGRESS_CONNECTOR_ARN'),
    egressConnectorArn: need('EGRESS_CONNECTOR_ARN'),
    logGroup: need('MICROVM_LOG_GROUP'),
    bucket: need('BUCKET'),
    eventPrefix: prefix(env.EVENT_PREFIX, 'events/'),
    resultPrefix: prefix(env.RESULT_PREFIX, 'results/'),
    configPrefix: prefix(env.CONFIG_PREFIX, 'config/'),
    webhookSecretArn: need('WEBHOOK_SECRET_ARN'),
    githubAppKeySecretArn: need('GITHUB_APP_KEY_SECRET_ARN'),
    agentEnvSecretArn: need('AGENT_ENV_SECRET_ARN'),
    maximumDurationSeconds,
    watchdogReserveSeconds,
    idlePolicyMode,
    dedupeTable,
    dedupeWindowSeconds,
    triggerLabels: (env.TRIGGER_LABELS ?? '')
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label !== ''),
  };
}

function prefix(value, fallback) {
  const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  return text.endsWith('/') ? text : `${text}/`;
}

/** Where the launcher stores a delivery's webhook body. */
export function eventKeyFor(config, deliveryId) {
  return `${config.eventPrefix}${deliveryId}/event.json`;
}

/**
 * The run-hook payload: references and the event's identity, never a secret value. The
 * runner in the microVM fetches everything else with its execution role.
 */
export function buildRunHookPayload(config, { deliveryId, eventName, launchedAt }) {
  const dedupe = config.dedupeWindowSeconds > 0 ? { dedupeTable: config.dedupeTable } : {};
  return {
    ...dedupe,
    version: PAYLOAD_VERSION,
    deliveryId,
    eventName,
    region: config.region,
    bucket: config.bucket,
    eventKey: eventKeyFor(config, deliveryId),
    resultKeyPrefix: `${config.resultPrefix}${deliveryId}/`,
    configPrefix: config.configPrefix,
    secrets: {
      githubAppPrivateKey: config.githubAppKeySecretArn,
      agentEnv: config.agentEnvSecretArn,
    },
    maximumDurationSeconds: config.maximumDurationSeconds,
    watchdogReserveSeconds: config.watchdogReserveSeconds,
    launchedAt,
  };
}

/**
 * The RunMicrovm request. Field names are those of RunMicrovmRequest in
 * @aws-sdk/client-lambda-microvms; see the README for the documentation page behind each.
 */
export function buildRunMicrovmInput(config, { deliveryId, eventName, launchedAt }) {
  const runHookPayload = JSON.stringify(buildRunHookPayload(config, { deliveryId, eventName, launchedAt }));
  const size = Buffer.byteLength(runHookPayload, 'utf8');
  if (size > MAX_RUN_HOOK_PAYLOAD_BYTES) {
    throw new Error(`run hook payload is ${size} bytes; the limit is ${MAX_RUN_HOOK_PAYLOAD_BYTES}`);
  }
  const input = {
    imageIdentifier: config.imageArn,
    executionRoleArn: config.executionRoleArn,
    // No inbound endpoint traffic at all: nobody connects to a job. Lambda still calls the hooks.
    ingressNetworkConnectors: [config.ingressConnectorArn],
    egressNetworkConnectors: [config.egressConnectorArn],
    maximumDurationInSeconds: config.maximumDurationSeconds,
    logging: { cloudWatch: { logGroup: config.logGroup } },
    runHookPayload,
  };
  if (config.imageVersion !== '') input.imageVersion = config.imageVersion;
  if (config.idlePolicyMode === 'explicit') {
    // A job gets no endpoint traffic, so by the service's definition it is idle from the first
    // second. Allow it to be idle for as long as it may live: the maximum duration ends the
    // microVM before the idle limit can. If it is suspended anyway, do not keep it around
    // (0 seconds suspended) and do not resume it.
    input.idlePolicy = {
      maxIdleDurationSeconds: config.maximumDurationSeconds,
      suspendedDurationSeconds: 0,
      autoResumeEnabled: false,
    };
  }
  return input;
}

/**
 * Handles one webhook request.
 *
 * @param {{ headers?: Record<string, string | undefined>, body?: string, isBase64Encoded?: boolean }} request
 *   an API Gateway HTTP API (payload format 2.0) event; header names are lower-case there
 * @param {object} deps
 * @param {ReturnType<typeof loadConfig>} deps.config
 * @param {() => Promise<string>} deps.getWebhookSecret
 * @param {(bucket: string, key: string, body: Buffer) => Promise<void>} deps.putObject
 * @param {(input: object) => Promise<{ microvmId?: string, state?: string }>} deps.runMicrovm
 * @param {(deliveryId: string, nowSeconds: number, expiresSeconds: number) => Promise<boolean>} [deps.claimDelivery]
 *   records the delivery unless an unexpired record exists; false means "already launched"
 * @param {(deliveryId: string) => Promise<void>} [deps.releaseDelivery] removes that record
 * @param {(entry: object) => void} deps.log
 * @param {() => Date} [deps.now]
 */
export async function handleWebhook(request, deps) {
  const { config, log } = deps;
  const headers = lowerCaseKeys(request.headers ?? {});
  const rawBody = Buffer.from(request.body ?? '', request.isBase64Encoded ? 'base64' : 'utf8');
  const signature = headers['x-hub-signature-256'];

  // 1. Authenticate. Nothing in the body is looked at before this passes.
  if (typeof signature !== 'string' || signature === '') {
    log({ level: 'warn', message: 'rejected: no X-Hub-Signature-256 header' });
    return respond(401, { error: 'signature required' });
  }
  let secret;
  try {
    secret = await deps.getWebhookSecret();
  } catch (error) {
    log({ level: 'error', message: 'cannot read the webhook secret', error: describe(error) });
    return respond(500, { error: 'webhook secret unavailable' });
  }
  if (typeof secret !== 'string' || secret === '') {
    log({ level: 'error', message: 'the webhook secret is empty; set its value in Secrets Manager' });
    return respond(500, { error: 'webhook secret unavailable' });
  }
  if (!verifySignature(rawBody, signature, secret)) {
    log({ level: 'warn', message: 'rejected: signature does not match' });
    return respond(401, { error: 'signature mismatch' });
  }

  // 2. Identify. From here on the request is known to come from GitHub for this App.
  const deliveryId = headers['x-github-delivery'];
  const eventName = headers['x-github-event'];
  if (typeof deliveryId !== 'string' || !DELIVERY_ID_PATTERN.test(deliveryId)) {
    log({ level: 'warn', message: 'rejected: missing or malformed X-GitHub-Delivery' });
    return respond(400, { error: 'X-GitHub-Delivery is missing or malformed' });
  }
  if (typeof eventName !== 'string' || !EVENT_NAME_PATTERN.test(eventName)) {
    log({ level: 'warn', deliveryId, message: 'rejected: missing or malformed X-GitHub-Event' });
    return respond(400, { error: 'X-GitHub-Event is missing or malformed' });
  }

  // 3. Filter cheaply. Anything that cannot lead to work gets a 2xx and no microVM.
  if (!canLaunch(eventName)) {
    // Not worth parsing a body for an event this deployment never acts on (ping included).
    const reason = eventName === 'ping' ? 'ping' : `event "${eventName}" is not handled`;
    log({ level: 'info', deliveryId, eventName, message: `ignored: ${reason}` });
    return respond(200, { deliveryId, ignored: reason });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    log({ level: 'warn', deliveryId, eventName, message: 'rejected: body is not JSON' });
    return respond(400, { error: 'body is not JSON; set the webhook content type to application/json' });
  }
  const decision = decideEvent(eventName, payload, config);
  if (!decision.launch) {
    log({ level: 'info', deliveryId, eventName, message: `ignored: ${decision.reason}` });
    return respond(200, { deliveryId, ignored: decision.reason });
  }

  // 4. Deduplicate on the delivery id. A redelivery while a microVM for the same delivery may
  //    still be running would run the agent twice. This is a convenience, not a guarantee:
  //    if the table cannot be reached the launch goes ahead, and run-event's own idempotency
  //    is what prevents a second pull request.
  const nowDate = deps.now?.() ?? new Date();
  let claimed = false;
  if (config.dedupeWindowSeconds > 0 && deps.claimDelivery) {
    const nowSeconds = Math.floor(nowDate.getTime() / 1000);
    try {
      claimed = await deps.claimDelivery(deliveryId, nowSeconds, nowSeconds + config.dedupeWindowSeconds);
      if (!claimed) {
        const reason = `duplicate: a microVM was already launched for this delivery in the last ${config.dedupeWindowSeconds} s and has not reported a failure`;
        log({ level: 'info', deliveryId, eventName, message: `ignored: ${reason}` });
        return respond(200, { deliveryId, duplicate: true, ignored: reason });
      }
    } catch (error) {
      log({ level: 'warn', deliveryId, eventName, message: 'deduplication unavailable; launching anyway', error: describe(error) });
    }
  }

  // 5. Store the body (it can exceed the 16 KB run-hook payload) and launch.
  const launchedAt = nowDate.toISOString();
  const eventKey = eventKeyFor(config, deliveryId);
  try {
    await deps.putObject(config.bucket, eventKey, rawBody);
    const input = buildRunMicrovmInput(config, { deliveryId, eventName, launchedAt });
    const result = await deps.runMicrovm(input);
    log({
      level: 'info',
      deliveryId,
      eventName,
      message: 'microVM launched',
      microvmId: result?.microvmId,
      state: result?.state,
      eventKey,
    });
    return respond(202, { deliveryId, microvmId: result?.microvmId ?? null });
  } catch (error) {
    // A 5xx marks the delivery as failed in the App's "Recent Deliveries", from where it can
    // be redelivered once the cause is fixed.
    log({ level: 'error', deliveryId, eventName, message: 'launch failed', error: describe(error) });
    if (claimed) {
      // Nothing is running, so the redelivery that retries this must not be refused.
      await deps.releaseDelivery?.(deliveryId).catch((releaseError) => {
        log({ level: 'warn', deliveryId, message: 'could not release the delivery record', error: describe(releaseError) });
      });
    }
    return respond(500, { deliveryId, error: 'launch failed' });
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function lowerCaseKeys(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

function describe(error) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}
