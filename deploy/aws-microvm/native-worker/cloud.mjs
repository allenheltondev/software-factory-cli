import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

export function cloudConfig(c) {
  if (!c || Object.keys(c).sort().join(',') !== 'brokerFunctionName,controlSecretArn,imageVersion,region,workerId,workerVersion' ||
      typeof c.workerId !== 'string' || !/^[\w-]{1,64}$/.test(c.workerId) || typeof c.workerVersion !== 'string' || !/^[\w.-]{1,64}$/.test(c.workerVersion) ||
      typeof c.imageVersion !== 'string' || !/^[\w.-]{1,64}$/.test(c.imageVersion) || typeof c.region !== 'string' || !/^[\w-]+-\d$/.test(c.region) ||
      typeof c.brokerFunctionName !== 'string' || !/^[\w:-]{1,200}$/.test(c.brokerFunctionName) ||
      typeof c.controlSecretArn !== 'string' || !/^arn:[\w-]+:secretsmanager:[\w-]+:\d{12}:secret:updraft\/native-workers\//.test(c.controlSecretArn)) throw new Error('invalid cloud worker configuration');
  return c;
}

/** Fail closed on any uncertain broker response: stop polling and let Cloud fence this VM.
 * Only the root dispatcher holds the control credential. A job gets its own broker token.
 */
export async function startCloudWorker(config, microvmId, service, options = {}) {
  cloudConfig(config);
  if (typeof microvmId !== 'string' || !/^[\w:-]{1,200}$/.test(microvmId)) throw new Error('missing worker microvm id');
  const invoke = options.call ?? await (await import('/opt/updraft/runner/worker-control.mjs')).workerControl(config);
  const call = async (message) => {
    let timer;
    try {
      return await Promise.race([invoke(message), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('worker control request timed out')), options.callTimeout ?? 15_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const launch = options.launch ?? ((request) => spawn(process.execPath, ['/opt/updraft/runner/run-job.mjs'], {
    // Deliberately no inherited secret, native HOME, Claude overrides or control token.
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/root', AWS_REGION: config.region,
      UPDRAFT_JOB_UID: '1000', UPDRAFT_JOB_GID: '1000', UPDRAFT_JOB_HOME: '/home/updraft', UPDRAFT_JOB_USER: 'updraft',
      UPDRAFT_NATIVE_WORKER: '1', UPDRAFT_RUN_REQUEST: JSON.stringify(request),
      ...Object.fromEntries(['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE']
        .filter((k) => process.env[k]).map((k) => [k, process.env[k]])) }, stdio: ['ignore', 'inherit', 'inherit'],
  }));
  const session = randomUUID();
  const interval = options.interval ?? 10_000;
  const controller = new globalThis.AbortController();
  let stopped = false;
  let child;
  let ended;
  let childDone = false;
  let auth = await service.authStatus();
  const message = (op) => ({ op, session, microvmId, auth, imageVersion: config.imageVersion, workerVersion: config.workerVersion });
  const stopChild = async () => {
    if (!child || childDone) return;
    child.kill('SIGTERM');
    // runJob cancels/reaps its detached Updraft group before reporting completion. Never
    // start another job after a forced root-runner kill; Cloud physically fences the VM.
    let timer;
    await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(() => { child?.kill('SIGKILL'); resolve(); }, options.stopGrace ?? 25_000); })]);
    clearTimeout(timer);
  };
  const loop = (async () => {
    try {
      // The provider assigns the VM ID during boot. Give the operator time to pin that
      // ID in the Cloud route, without blocking the lifecycle /run response. Registration
      // alone never leases a job, so retries here cannot duplicate execution.
      for (let attempt = 1; !stopped; attempt++) {
        try { await call(message('register')); break; }
        catch (error) {
          if (attempt >= (options.registrationAttempts ?? 120)) throw error;
          await pause(interval, undefined, { signal: controller.signal });
        }
      }
      while (!stopped) {
        if (child) {
          const status = await call(message('heartbeat'));
          if (status.cancel) { await stopChild(); throw new Error('worker job canceled'); }
          if (childDone) {
            await ended;
            const settled = await call(message('settled'));
            if (settled.busy) throw new Error('runner exited without settling its lease');
            child = undefined;
          }
        } else {
          auth = await service.authStatus();
          const response = await call(message('poll'));
          if (stopped) break;
          if (response.request) {
            child = launch(response.request);
            childDone = false;
            ended = new Promise((resolve) => {
              const finish = () => { childDone = true; resolve(); };
              child.once('close', finish); child.once('error', finish);
            });
          } else if (response.busy) throw new Error('uncertain worker assignment');
        }
        if (!stopped) await pause(interval, undefined, { signal: controller.signal });
      }
    } catch {
      if (!stopped) console.error('Cloud worker stopped; operator recovery and confirmed VM termination required.');
      stopped = true;
      await stopChild();
      // No more heartbeats: reconciliation fences any outstanding assignment. Do not
      // free its quota slot locally, restart this loop, or launch a BYOK fallback.
    }
  })();
  return { done: loop, async close() { stopped = true; controller.abort(); await stopChild(); await loop; } };
}
