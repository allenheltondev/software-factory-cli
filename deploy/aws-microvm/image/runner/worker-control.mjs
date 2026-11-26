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

/**
 * The broker's answer, classified: a refusal (`ok` not true) is Cloud's decision and is final;
 * a crashed invocation (FunctionError: the broker threw, say on a throttled table) or a transport
 * fault is marked `transient` for the dispatcher's bounded retry. An unreadable payload is final.
 */
export function brokerResponse(out) {
  if (out.FunctionError) throw transient('worker broker unavailable');
  const response = JSON.parse(Buffer.from(out.Payload ?? []).toString('utf8'));
  if (response?.ok !== true) throw new Error('worker broker refused request');
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
    return brokerResponse(out);
  };
}
