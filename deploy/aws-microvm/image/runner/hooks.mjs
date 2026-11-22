// HTTP handling of the Lambda MicroVMs lifecycle hooks. Lambda sends a POST to
// /aws/lambda-microvms/runtime/v1/<hook-name> on the configured hook port and reads the HTTP
// status: 200 means the hook completed.
//
// Hooks handled here:
//   /ready      image build: the process is up and can be snapshotted
//   /validate   image build: answered in case the hook is enabled; nothing to validate
//   /run        a microVM started from the snapshot: start the job, answer at once
//   /suspend    not expected for a job (see README); logged
//   /resume     not expected for a job; logged
//   /terminate  the microVM is going away: stop the job and let it report

export const HOOK_BASE_PATH = '/aws/lambda-microvms/runtime/v1';
export const PAYLOAD_VERSION = 1;
/** Updraft Cloud's payload: the job's broker instead of the job's data (parseBrokerPayload). */
export const BROKER_PAYLOAD_VERSION = 2;
/**
 * An image check, not a job: install the packet filter and run the sandbox self-test in this
 * microVM, print the outcome (ISOLATION CHECK line) and start nothing. The image builds start
 * one from each new version before they activate it, so a version on which the boundary does
 * not hold never runs a job (checkImageIsolation in job.mjs).
 */
export const ISOLATION_CHECK_PAYLOAD_VERSION = 3;

const MAX_BODY_BYTES = 64 * 1024; // the run hook payload is at most 16 KB
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const EVENT_NAME_PATTERN = /^[a-z_]{1,64}$/;
const STATE_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
const MICROVM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/**
 * Validates the body of the /run hook: `{ microvmId, runHookPayload }`, where runHookPayload
 * is the JSON string the launcher passed to RunMicrovm. Throws an Error naming the problem.
 *
 * @param {unknown} body the parsed request body
 */
export function parseRunRequest(body) {
  if (body === null || typeof body !== 'object') throw new Error('the /run body is not a JSON object');
  const { microvmId, runHookPayload } = body;
  if (typeof microvmId !== 'string' || !MICROVM_ID_PATTERN.test(microvmId)) {
    throw new Error('the /run body has no usable microvmId');
  }
  if (typeof runHookPayload !== 'string' || runHookPayload === '') {
    throw new Error('the /run body has no runHookPayload');
  }
  let payload;
  try {
    payload = JSON.parse(runHookPayload);
  } catch {
    throw new Error('runHookPayload is not JSON');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('runHookPayload is not a JSON object');
  }
  if (payload.version === BROKER_PAYLOAD_VERSION) return { microvmId, payload: parseBrokerPayload(payload) };
  if (payload.version === ISOLATION_CHECK_PAYLOAD_VERSION) {
    if (typeof payload.checkId !== 'string' || !DELIVERY_ID_PATTERN.test(payload.checkId)) throw new Error('runHookPayload.checkId is missing or malformed');
    // deliveryId and eventName only name the check in the log lines a job would write.
    return { microvmId, payload: { version: ISOLATION_CHECK_PAYLOAD_VERSION, checkId: payload.checkId, deliveryId: payload.checkId, eventName: 'isolation_check' } };
  }
  if (payload.version !== PAYLOAD_VERSION) {
    throw new Error(`runHookPayload version ${JSON.stringify(payload.version)} is not ${PAYLOAD_VERSION}, ${BROKER_PAYLOAD_VERSION} or ${ISOLATION_CHECK_PAYLOAD_VERSION}; rebuild the image or redeploy the launcher`);
  }
  const text = (name, pattern) => {
    const value = payload[name];
    if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) {
      throw new Error(`runHookPayload.${name} is missing or malformed`);
    }
    return value;
  };
  const seconds = (name, min) => {
    const value = payload[name];
    if (!Number.isInteger(value) || value < min) throw new Error(`runHookPayload.${name} is missing or malformed`);
    return value;
  };
  const secrets = payload.secrets;
  if (secrets === null || typeof secrets !== 'object') throw new Error('runHookPayload.secrets is missing');
  for (const name of ['githubAppPrivateKey', 'agentEnv']) {
    if (typeof secrets[name] !== 'string' || secrets[name] === '') {
      throw new Error(`runHookPayload.secrets.${name} is missing`);
    }
  }
  if (payload.dedupeTable !== undefined && (typeof payload.dedupeTable !== 'string' || !/^[A-Za-z0-9_.-]{3,255}$/.test(payload.dedupeTable))) {
    throw new Error('runHookPayload.dedupeTable is malformed');
  }
  // Optional: the key of the shared state database (absent: the job starts from nothing and
  // saves nothing), and the time before which the job must not start (coalesced events).
  if (payload.stateKey !== undefined && (typeof payload.stateKey !== 'string' || !STATE_KEY_PATTERN.test(payload.stateKey) || payload.stateKey.length > 200)) {
    throw new Error('runHookPayload.stateKey is malformed');
  }
  if (payload.notBefore !== undefined && (typeof payload.notBefore !== 'string' || Number.isNaN(Date.parse(payload.notBefore)))) {
    throw new Error('runHookPayload.notBefore is not a date');
  }
  // Optional settings of state sync; absent means the runner's defaults.
  const optionalSeconds = (name, max) => {
    const value = payload[name];
    if (value === undefined) return {};
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`runHookPayload.${name} is malformed`);
    return { [name]: value };
  };
  const stateSettings = { ...optionalSeconds('stateCheckpointSeconds', 3600), ...optionalSeconds('statePendingWaitSeconds', 1800) };
  // Optional: absent (a launcher older than the setting) means enforced, in the runner.
  if (payload.agentIsolation !== undefined && payload.agentIsolation !== 'enforced' && payload.agentIsolation !== 'disabled') {
    throw new Error('runHookPayload.agentIsolation is malformed');
  }
  const launchedAt = text('launchedAt');
  if (Number.isNaN(Date.parse(launchedAt))) throw new Error('runHookPayload.launchedAt is not a date');
  return {
    microvmId,
    payload: {
      ...(payload.dedupeTable === undefined ? {} : { dedupeTable: payload.dedupeTable }),
      ...(payload.stateKey === undefined ? {} : { stateKey: payload.stateKey }),
      ...(payload.notBefore === undefined ? {} : { notBefore: payload.notBefore }),
      ...stateSettings,
      ...(payload.agentIsolation === undefined ? {} : { agentIsolation: payload.agentIsolation }),
      version: PAYLOAD_VERSION,
      deliveryId: text('deliveryId', DELIVERY_ID_PATTERN),
      eventName: text('eventName', EVENT_NAME_PATTERN),
      region: text('region', /^[a-z0-9-]{1,32}$/),
      bucket: text('bucket'),
      eventKey: text('eventKey'),
      resultKeyPrefix: text('resultKeyPrefix'),
      configPrefix: text('configPrefix'),
      secrets: { githubAppPrivateKey: secrets.githubAppPrivateKey, agentEnv: secrets.agentEnv },
      maximumDurationSeconds: seconds('maximumDurationSeconds', 1),
      watchdogReserveSeconds: seconds('watchdogReserveSeconds', 0),
      launchedAt,
    },
  };
}

/**
 * Version 2 (Updraft Cloud): the payload names the job and its broker, and nothing else about
 * where the job's data is. The runner asks the broker (broker.mjs) for the bucket and keys, with
 * credentials that reach only this tenant's, and for the GitHub token; the execution role itself
 * reaches no tenant's data. The job token is single use and unguessable, and is never logged.
 */
function parseBrokerPayload(payload) {
  const text = (value, name, pattern) => {
    if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) throw new Error(`runHookPayload.${name} is missing or malformed`);
    return value;
  };
  const seconds = (name, min) => {
    const value = payload[name];
    if (!Number.isInteger(value) || value < min) throw new Error(`runHookPayload.${name} is missing or malformed`);
    return value;
  };
  const broker = payload.broker;
  if (broker === null || typeof broker !== 'object') throw new Error('runHookPayload.broker is missing');
  const optionalSeconds = (name, max) => {
    const value = payload[name];
    if (value === undefined) return {};
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`runHookPayload.${name} is malformed`);
    return { [name]: value };
  };
  if (payload.notBefore !== undefined && (typeof payload.notBefore !== 'string' || Number.isNaN(Date.parse(payload.notBefore)))) {
    throw new Error('runHookPayload.notBefore is not a date');
  }
  // Isolation is always enforced for a hosted job; a payload cannot turn it off.
  if (payload.agentIsolation !== undefined && payload.agentIsolation !== 'enforced') throw new Error('runHookPayload.agentIsolation must be enforced');
  // Optional: a retry from the console, so run-event requeues the event's failed jobs first (--retry).
  if (payload.retry !== undefined && payload.retry !== true) throw new Error('runHookPayload.retry is malformed');
  const launchedAt = text(payload.launchedAt, 'launchedAt');
  if (Number.isNaN(Date.parse(launchedAt))) throw new Error('runHookPayload.launchedAt is not a date');
  return {
    ...(payload.notBefore === undefined ? {} : { notBefore: payload.notBefore }),
    ...(payload.retry === true ? { retry: true } : {}),
    ...optionalSeconds('stateCheckpointSeconds', 3600),
    ...optionalSeconds('statePendingWaitSeconds', 1800),
    agentIsolation: 'enforced',
    version: BROKER_PAYLOAD_VERSION,
    deliveryId: text(payload.deliveryId, 'deliveryId', DELIVERY_ID_PATTERN),
    eventName: text(payload.eventName, 'eventName', EVENT_NAME_PATTERN),
    region: text(payload.region, 'region', /^[a-z0-9-]{1,32}$/),
    broker: {
      functionName: text(broker.functionName, 'broker.functionName', /^[A-Za-z0-9:_./-]{1,170}$/),
      jobId: text(broker.jobId, 'broker.jobId', /^[A-Za-z0-9_-]{8,64}$/),
      jobToken: text(broker.jobToken, 'broker.jobToken', /^[A-Za-z0-9_-]{32,256}$/),
    },
    maximumDurationSeconds: seconds('maximumDurationSeconds', 1),
    watchdogReserveSeconds: seconds('watchdogReserveSeconds', 0),
    launchedAt,
  };
}

/**
 * Creates the request listener for the hook port.
 *
 * @param {object} handlers
 * @param {(request: ReturnType<typeof parseRunRequest>) => void} handlers.startJob called once,
 *   for the first valid /run; must return quickly (the job runs on its own)
 * @param {() => Promise<void>} handlers.stopJob called on /terminate; resolves when the job
 *   has stopped and reported, or a bounded wait is over
 * @param {(message: string) => void} handlers.log
 */
export function createHookHandler({ startJob, stopJob, log }) {
  let started = false;

  const answer = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  return async function onRequest(req, res) {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (!path.startsWith(`${HOOK_BASE_PATH}/`)) return answer(res, 404, { error: 'not a lifecycle hook' });
      if (req.method !== 'POST') return answer(res, 405, { error: 'hooks are POST requests' });
      const hook = path.slice(HOOK_BASE_PATH.length + 1);

      switch (hook) {
        case 'ready':
        case 'validate':
          req.resume();
          return answer(res, 200, { status: 'ok' });

        case 'run': {
          const raw = await readBody(req);
          let request;
          try {
            request = parseRunRequest(JSON.parse(raw.toString('utf8') || 'null'));
          } catch (error) {
            // A non-200 answer makes Lambda terminate the microVM, which is what should
            // happen to one that cannot know what to do. The reason is in the log.
            log(`/run rejected: ${error.message}`);
            return answer(res, 400, { error: error.message });
          }
          if (started) {
            log(`/run called again (delivery ${request.payload.deliveryId}); ignored, a job was already started`);
            return answer(res, 200, { status: 'already started' });
          }
          started = true;
          startJob(request);
          return answer(res, 200, { status: 'started' });
        }

        case 'suspend':
        case 'resume':
          req.resume();
          log(`/${hook} called: a job microVM is not meant to be suspended; check the idle policy the launcher sets`);
          return answer(res, 200, { status: 'ok' });

        case 'terminate':
          req.resume();
          await stopJob();
          return answer(res, 200, { status: 'ok' });

        default:
          req.resume();
          return answer(res, 404, { error: 'unknown hook' });
      }
    } catch (error) {
      log(`hook request failed: ${error?.message ?? error}`);
      if (!res.headersSent) answer(res, 500, { error: 'hook failed' });
      else res.end();
    }
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
