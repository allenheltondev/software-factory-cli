// Started by server.mjs for the /run hook, as a new process inside the microVM. Wires the
// real AWS clients and the image's settings to runJob (job.mjs) and exits when it is done.
import os from 'node:os';
import { createAwsDeps } from './aws.mjs';
import { abandonBrokerJob, createBrokerClient, startBrokerJob } from './broker.mjs';
import { BROKER_PAYLOAD_VERSION, ISOLATION_CHECK_PAYLOAD_VERSION, parseRunRequest } from './hooks.mjs';
import { SANDBOX_IMAGE, SANDBOX_RUNTIME, createNftFilter, credentialEndpoints } from './isolation.mjs';
import { checkImageIsolation, runJob } from './job.mjs';
import { configureNativeJob } from './native-config.mjs';

const log = (message) => console.log(`[runner] ${message}`);

function integerFrom(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} is not a non-negative integer`);
  return parsed;
}

async function main() {
  const nativeWorker = process.env.UPDRAFT_NATIVE_WORKER === '1';
  // Which CLI the session's subscription is for (#125): set by the native worker's root
  // dispatcher from its run hook, never by the job. Absent: Claude, as before.
  const nativeProvider = nativeWorker && process.env.UPDRAFT_NATIVE_PROVIDER === 'codex' ? 'codex' : 'claude';
  delete process.env.UPDRAFT_NATIVE_WORKER;
  delete process.env.UPDRAFT_NATIVE_PROVIDER;
  // server.mjs validated this already; parsing again keeps this file usable on its own.
  const raw = JSON.parse(process.env.UPDRAFT_RUN_REQUEST ?? 'null');
  const request = parseRunRequest({ microvmId: raw?.microvmId, runHookPayload: JSON.stringify(raw?.payload ?? null) });
  delete process.env.UPDRAFT_RUN_REQUEST;

  const stopListeners = [];
  let stopRequested = false;
  process.on('SIGTERM', () => {
    stopRequested = true;
    for (const listener of stopListeners) listener();
  });

  // Switching to the job user needs root. The image's ENTRYPOINT is expected to run as root;
  // if it does not, the job runs as whoever this is, and the log says so.
  let jobUser = {
    uid: integerFrom('UPDRAFT_JOB_UID'),
    gid: integerFrom('UPDRAFT_JOB_GID'),
    home: process.env.UPDRAFT_JOB_HOME ?? '/home/updraft',
    name: process.env.UPDRAFT_JOB_USER ?? 'updraft',
  };
  if (jobUser.uid !== undefined && process.getuid?.() !== 0) {
    log(`WARNING: the runner is not root (uid ${process.getuid?.()}), so it cannot switch to uid ${jobUser.uid}; the job runs as the runner's own user`);
    const info = os.userInfo();
    jobUser = { home: info.homedir, name: info.username };
  }

  // What AgentIsolation=enforced needs (isolation.mjs): the sandbox runtime Updraft starts
  // agents through, and a packet filter between every user but root and the addresses that
  // hand out this process's AWS credentials. A problem here is reported by runJob, as a job
  // that was not started.
  const hookPort = Number(process.env.HOOK_PORT ?? 9000);
  let isolation;
  try {
    const endpoints = credentialEndpoints(process.env);
    isolation = {
      runtime: process.env.UPDRAFT_SANDBOX_RUNTIME ?? SANDBOX_RUNTIME,
      image: SANDBOX_IMAGE,
      nodePath: process.execPath,
      endpoints,
      hookPort,
      filter: createNftFilter({ endpoints, hookPort }),
      nativeWorker,
      ...(nativeProvider === 'codex' ? { nativeProvider } : {}),
    };
  } catch (error) {
    isolation = { setupProblem: error?.message ?? String(error) };
  }

  const stateRoot = process.env.UPDRAFT_STATE_ROOT ?? '/var/lib/updraft-jobs';

  // Version 3: an image check, not a job (hooks.mjs). Whoever started it reads the result from
  // the log and terminates the microVM.
  if (request.payload.version === ISOLATION_CHECK_PAYLOAD_VERSION) {
    const report = await checkImageIsolation({ isolation, stateRoot, jobUser, baseEnv: process.env, log });
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  // Version 2 (Updraft Cloud): the job's data and its credentials come from the job broker, and
  // reach only this tenant's; the execution role reaches no tenant's data itself.
  let job = { request, aws: createAwsDeps(request.payload.region) };
  if (request.payload.version === BROKER_PAYLOAD_VERSION) {
    const client = createBrokerClient({ ...request.payload.broker, region: request.payload.region });
    try {
      const started = await startBrokerJob(request.payload, { client, createAwsDeps });
      job = { request: { ...request, payload: started.payload }, aws: started.deps };
    } catch (error) {
      // Report the failed start, so the delivery's claim is given up and a redelivery starts the
      // job again, then stop the microVM rather than bill it. Only the broker can stop it (the
      // execution role cannot terminate), and only once the launcher has recorded this microVM,
      // so both are retried for a while; if it still cannot, the maximum duration ends it.
      log(`the job broker did not start this job: ${error?.message ?? error}`);
      for (const problem of await abandonBrokerJob(client)) log(problem);
      process.exitCode = 2;
      return;
    }
  }

  const result = await runJob(job.request, {
    ...job.aws,
    ...(nativeWorker ? { configureJob: (stateDir) => configureNativeJob(stateDir, nativeProvider) } : {}),
    isolation,
    stateRoot,
    updraftCommand: [process.env.UPDRAFT_COMMAND ?? 'updraft'],
    jobUser,
    baseEnv: process.env,
    log,
    logStream: process.stdout,
    onStop: (listener) => { stopListeners.push(listener); if (stopRequested) listener(); },
  });
  process.exitCode = result.outcome === 'succeeded' ? 0 : 1;
}

main().catch((error) => {
  // Reached only when the request itself is unusable; runJob reports everything else.
  log(`job process failed before it could report: ${error?.message ?? error}`);
  process.exitCode = 2;
});
