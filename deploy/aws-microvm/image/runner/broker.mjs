// The runner's side of Updraft Cloud's job broker (cloud/server/src/broker/broker.ts), for a
// version 2 run-hook payload. The microVM's execution role can invoke the broker and little else;
// the broker answers only to this job's token, with:
//
//   start / credentials  the job's descriptor (bucket, event, config, results and state keys,
//                        the tenant's key secrets) and AWS credentials scoped to this tenant
//   github-token         an installation token for the job's one repository, as Updraft's
//                        token file (github.app.tokenFile)
//   finish               the job is over
//
// Nothing here ever logs a token or a credential.

/** Refresh scoped credentials this long before they expire. */
export const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60 * 1000;

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
 * it), and returns the AWS calls with tenant-scoped credentials plus the broker's GitHub token
 * and finish. Termination keeps the execution role (createAwsDeps).
 */
export async function startBrokerJob(payload, { client, createAwsDeps, now = Date.now }) {
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
  };
  return { payload: filled, deps };
}
