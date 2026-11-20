// The runner's side of Updraft Cloud's job broker (cloud/server/src/broker/broker.ts), for a
// version 2 run-hook payload. The microVM's execution role can invoke the broker and little else;
// the broker answers only to this job's token, with:
//
//   start / credentials  the job's descriptor (bucket, event, config, results and state keys,
//                        the tenant's key secrets) and AWS credentials scoped to this tenant
//   github-token         an installation token for the job's one repository, as Updraft's
//                        token file (github.app.tokenFile)
//   finish               the job is over
//   terminate            stop this job's microVM; the execution role cannot terminate microVMs,
//                        since that would reach every tenant's
//
// Nothing here ever logs a token or a credential.

/** Refresh scoped credentials this long before they expire. */
export const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Asking the broker to stop this microVM: attempts, and the first delay (then twice it, three
 * times it...), about 30 seconds in all. The launcher records the microVM's id once RunMicrovm
 * returns, so a job that ends quickly (refused at start, say) can ask before the broker knows
 * which microVM is its own ("unavailable"); a later attempt finds it.
 */
export const TERMINATE_ATTEMPTS = 6;
export const TERMINATE_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stops this job's microVM through the broker, retrying (bounded) until the broker can. */
export async function terminateThroughBroker(client, options = {}) {
  await retryBroker(() => client.terminate(), options);
}

/** The outcome a job reports when the broker would not start it. */
export const START_FAILED_OUTCOME = 'start_failed';

/**
 * A job the broker did not start (its `start` failed: a throttled STS call, say): report it
 * finished with a failed outcome, which gives up the delivery's claim so a redelivery can start
 * the job again, then stop the microVM. Both are retried (bounded); neither failing stops the
 * other. Resolves to what could not be done, for the log.
 */
export async function abandonBrokerJob(client, options = {}) {
  const problems = [];
  await retryBroker(() => client.finish(START_FAILED_OUTCOME), options).catch((error) => {
    problems.push(`the job broker did not record the failed start (a redelivery is refused until the claim expires): ${error?.message ?? error}`);
  });
  await terminateThroughBroker(client, options).catch((error) => {
    problems.push(`the job broker did not stop this microVM: ${error?.message ?? error}`);
  });
  return problems;
}

async function retryBroker(operation, { attempts = TERMINATE_ATTEMPTS, delayMs = TERMINATE_DELAY_MS, wait = sleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await wait(delayMs * attempt);
    }
  }
}

/**
 * @param {{ functionName: string, jobId: string, jobToken: string, region: string }} broker
 * @param {{ invoke?: (functionName: string, body: object) => Promise<object> }} [options]
 *   tests pass their own; by default a Lambda Invoke with the microVM's execution role
 */
export function createBrokerClient(broker, options = {}) {
  let lambda;
  const invoke =
    options.invoke ??
    (async (functionName, body) => {
      // Loaded only here, so this module (and its tests) need no AWS SDK installed.
      const { InvokeCommand, LambdaClient } = await import('@aws-sdk/client-lambda');
      lambda ??= new LambdaClient({ region: broker.region });
      const out = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(body)) }));
      if (out.FunctionError) throw new Error(`the job broker failed (${out.FunctionError})`);
      return JSON.parse(Buffer.from(out.Payload ?? []).toString('utf8') || 'null');
    });

  async function call(action, extra = {}) {
    const response = await invoke(broker.functionName, { action, jobId: broker.jobId, token: broker.jobToken, ...extra });
    if (!response || response.ok !== true) {
      // "refused" means: not this job's token, or the job is finished, expired or its tenant inactive.
      throw new Error(`the job broker refused ${action} (${response?.error ?? 'no answer'})`);
    }
    return response;
  }

  return {
    /** The descriptor and the first credentials. */
    start: () => call('start'),
    credentials: () => call('credentials'),
    /** The token file document (Updraft's github.app.tokenFile format). */
    githubToken: async () => (await call('github-token')).tokenFile,
    finish: (outcome) => call('finish', { outcome }),
    /** Stops this job's microVM (the one the launcher recorded); works after finish too. */
    terminate: () => call('terminate'),
  };
}

/**
 * An AWS SDK credential provider over the broker: the first credentials from `start`, then new
 * ones from `credentials` shortly before each set expires (role chaining caps a set at an hour).
 */
export function brokerCredentialProvider(client, initial, { now = Date.now } = {}) {
  let current = toSdk(initial);
  let inflight;
  return async () => {
    if (current.expiration.getTime() - now() > CREDENTIAL_REFRESH_MARGIN_MS) return current;
    inflight ??= client
      .credentials()
      .then((response) => {
        current = toSdk(response.credentials);
        return current;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

function toSdk(c) {
  if (!c?.accessKeyId || !c.secretAccessKey || !c.sessionToken || !c.expiration) throw new Error('the job broker returned no usable credentials');
  return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, expiration: new Date(c.expiration) };
}

/**
 * Starts a version 2 job: asks the broker for the job's descriptor and first credentials, fills
 * the descriptor into the payload (where the job's data is, as a version 1 payload would carry
 * it), and returns the AWS calls with tenant-scoped credentials plus the broker's GitHub token,
 * finish and terminate (the broker stops this job's microVM; runJob's microVM id is not used).
 */
export async function startBrokerJob(payload, { client, createAwsDeps, now = Date.now, terminateOptions }) {
  const started = await client.start();
  const d = started.descriptor;
  for (const name of ['bucket', 'eventKey', 'configPrefix', 'resultKeyPrefix', 'stateKey']) {
    if (typeof d?.[name] !== 'string' || d[name] === '') throw new Error(`the job broker's descriptor has no ${name}`);
  }
  const filled = {
    ...payload,
    bucket: d.bucket,
    eventKey: d.eventKey,
    configPrefix: d.configPrefix,
    resultKeyPrefix: d.resultKeyPrefix,
    stateKey: d.stateKey,
    agentKeySecrets: d.agentKeySecrets ?? {},
  };
  const deps = {
    ...createAwsDeps(payload.region, { credentials: brokerCredentialProvider(client, started.credentials, { now }) }),
    githubToken: () => client.githubToken(),
    finishJob: (outcome) => client.finish(outcome),
    // A job that fails while preparing can end before the launcher has recorded its microVM.
    terminate: () => terminateThroughBroker(client, terminateOptions),
  };
  return { payload: filled, deps };
}
