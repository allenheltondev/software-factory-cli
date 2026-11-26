// Loaded only by the root native dispatcher, never by Updraft or the Claude process.

const TRANSIENT_NAMES = new Set(['TimeoutError', 'AbortError', 'ThrottlingException', 'TooManyRequestsException', 'ServiceException',
  'ResourceConflictException', 'ResourceNotReadyException', 'EC2ThrottledException', 'SubnetIPAddressLimitReachedException']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/**
 * Whether a failed broker invocation is a transport fault that a retry may outlive (#176): a
 * timeout, throttling, a 5xx, a function being updated by a deploy, a dropped connection. A
 * 4xx other than throttling (an access denial, a missing function) is not: retrying cannot help.
 */
export function transientInvokeError(error) {
  if (!error || typeof error !== 'object') return false;
  if (TRANSIENT_NAMES.has(error.name)) return true;
  const status = error.$metadata?.httpStatusCode;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return NETWORK_CODES.has(error.code) || NETWORK_CODES.has(error.cause?.code);
}

const transient = (message, cause) => Object.assign(new Error(message, { cause }), { transient: true });

/** Only these may be retried after the broker could not answer: both are idempotent, and Cloud's state decides the retry. */
const RETRYABLE_OPS = new Set(['poll', 'heartbeat']);

/**
 * The broker's answer, classified.
 * - A crashed invocation (FunctionError) or a transport fault is marked `transient`.
 * - `{ ok: false, error: 'unavailable' }` is the broker's handler catching its own failure (a
 *   throttled table during a deploy, say: broker-lambda.ts), not a decision: transient for a poll
 *   or a heartbeat, never for a settlement or anything else.
 * - Any other refusal (`ok` not true) is Cloud's decision and is final, as is an unreadable payload.
 * The dispatcher retries what is transient with bounded backoff (native-worker/cloud.mjs).
 */
export function brokerResponse(out, op) {
  if (out.FunctionError) throw transient('worker broker unavailable');
  const response = JSON.parse(Buffer.from(out.Payload ?? []).toString('utf8'));
  if (response?.ok !== true) {
    if (response?.error === 'unavailable' && RETRYABLE_OPS.has(op)) throw transient('worker broker unavailable');
    throw new Error('worker broker refused request');
  }
  return response;
}

export async function workerControl(config) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const lambda = new LambdaClient({ region: config.region });
  const secrets = new SecretsManagerClient({ region: config.region });
  const token = config.controlToken ?? (await secrets.send(new GetSecretValueCommand({ SecretId: config.controlSecretArn }))).SecretString;
  if (!token || token.length < 32 || token.length > 256) throw new Error('worker control credential unavailable');
  return async (body) => {
    let out;
    try {
      out = await lambda.send(new InvokeCommand({ FunctionName: config.brokerFunctionName,
        Payload: Buffer.from(JSON.stringify({ ...body, action: 'worker', workerId: config.workerId, token })) }), { abortSignal: globalThis.AbortSignal.timeout(15_000) });
    } catch (error) {
      if (transientInvokeError(error)) throw transient('worker broker unreachable', error);
      throw error;
    }
    return brokerResponse(out, body?.op);
  };
}
