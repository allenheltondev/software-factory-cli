import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

export function cloudConfig(c) {
  if (!c || !['brokerFunctionName,controlSecretArn,imageVersion,region,workerId,workerVersion', 'brokerFunctionName,controlToken,imageVersion,region,workerId,workerVersion'].includes(Object.keys(c).sort().join(',')) ||
      typeof c.workerId !== 'string' || !/^[\w-]{1,64}$/.test(c.workerId) || typeof c.workerVersion !== 'string' || !/^[\w.-]{1,64}$/.test(c.workerVersion) ||
      typeof c.imageVersion !== 'string' || !/^[\w.-]{1,64}$/.test(c.imageVersion) || typeof c.region !== 'string' || !/^[\w-]+-\d$/.test(c.region) ||
      typeof c.brokerFunctionName !== 'string' || !/^[\w:-]{1,200}$/.test(c.brokerFunctionName) ||
      !(typeof c.controlToken === 'string' ? /^[A-Za-z0-9_-]{43}$/.test(c.controlToken) : typeof c.controlSecretArn === 'string' && /^arn:[\w-]+:secretsmanager:[\w-]+:\d{12}:secret:updraft\/native-workers\//.test(c.controlSecretArn))) throw new Error('invalid cloud worker configuration');
  return c;
}

/**
 * The root job runner's environment. Deliberately no inherited secret, native HOME, Claude
 * overrides or control token. The runner is root and installs the packet filter itself, so its
 * PATH includes the sbin directories: Amazon Linux 2023 installs `nft` as /usr/sbin/nft.
 */
export function runnerEnvironment(config, request, env = process.env) {
  return { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: '/root', AWS_REGION: config.region,
    UPDRAFT_JOB_UID: '1000', UPDRAFT_JOB_GID: '1000', UPDRAFT_JOB_HOME: '/home/updraft', UPDRAFT_JOB_USER: 'updraft',
    UPDRAFT_NATIVE_WORKER: '1', UPDRAFT_RUN_REQUEST: JSON.stringify(request),
    ...Object.fromEntries(['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE']
      .filter((k) => env[k]).map((k) => [k, env[k]])) };
}

/** A broker call that failed in transport (timeout, throttling, a 5xx, a crashed invocation), not by Cloud's decision. */
export const isTransient = (error) => error?.transient === true;
/**
 * How long a run of transient broker failures may last before the worker stops anyway. Shorter
 * than Cloud's three-minute worker-lost grace (readiness.ts WORKER_LOST_MS): a worker either
 * recovers before Cloud would retire its session, or stops as it always did.
 */
export const TRANSIENT_BUDGET_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 30_000;

/** Fail closed on any authoritative or uncertain broker answer: stop polling and let Cloud fence this VM.
 * A transient transport failure of a poll or a heartbeat (a backend redeploy, a throttled or
 * cold broker, #176) is retried with bounded backoff instead: both are idempotent, and Cloud's
 * own state decides what the retry gets. An assignment whose poll response was lost is still
 * held for this worker, so the retried poll is refused and the worker stops, as before.
 * Registration retries as it always did; a settlement is never retried after an uncertain answer.
 * A refusal (fenced, revoked, another generation or session, bad credential) always stops it.
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
        timer = setTimeout(() => reject(Object.assign(new Error('worker control request timed out'), { transient: true })), options.callTimeout ?? 15_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const now = options.now ?? Date.now;
  const budget = options.transientBudget ?? TRANSIENT_BUDGET_MS;
  let failingSince;
  let failures = 0;
  /** A poll or heartbeat that may be retried: its answer, or undefined after a transient failure within budget (backed off). */
  const retryable = async (op) => {
    try {
      const response = await call(message(op));
      failingSince = undefined;
      failures = 0;
      return response;
    } catch (error) {
      if (!isTransient(error) || stopped) throw error;
      failingSince ??= now();
      if (now() - failingSince > budget) throw error;
      failures++;
      const wait = Math.min(interval * 2 ** (failures - 1), options.maxBackoff ?? MAX_BACKOFF_MS);
      console.error(JSON.stringify({ nativeWorker: 'retry', op, reason: 'broker_transient', attempt: failures, waitMs: wait }));
      await pause(wait, undefined, { signal: controller.signal }).catch(() => {});
      return undefined;
    }
  };
  const launch = options.launch ?? ((request) => spawn(process.execPath, ['/opt/updraft/runner/run-job.mjs'], {
    env: runnerEnvironment(config, request), stdio: ['ignore', 'inherit', 'inherit'],
  }));
  const session = randomUUID();
  const interval = options.interval ?? 10_000;
  const controller = new globalThis.AbortController();
  let stopped = false;
  let child;
  let ended;
  let childDone = false;
  // Set when a job's registry hosts could not be removed after its runner exited: the next
  // iteration stops this worker rather than poll for work with the previous job's rules.
  let egressResetFailed = false;
  // A status probe that cannot tell (a slow or failed `claude auth status`) is probed once more
  // before it is reported: one unreadable probe should not park the next issue (#144). Only a
  // fresh answer is ever sent; an earlier "connected" is never reused in its place.
  const probeAuth = async () => {
    const first = await service.authStatus();
    if (first !== 'unavailable' || stopped) return first;
    await pause(options.authRetryDelay ?? 1_000, undefined, { signal: controller.signal }).catch(() => {});
    return stopped ? first : service.authStatus();
  };
  let auth = await service.authStatus();
  const message = (op) => ({ op, session, microvmId, auth, imageVersion: config.imageVersion, workerVersion: config.workerVersion });
  const stopChild = async () => {
    if (!child || childDone) return true;
    child.kill('SIGTERM');
    // runJob cancels/reaps its detached Updraft group before reporting completion. Never
    // start another job after a forced root-runner kill; Cloud physically fences the VM.
    let timer;
    let forced = false;
    await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(() => { forced = true; child?.kill('SIGKILL'); resolve(); }, options.stopGrace ?? 25_000); })]);
    clearTimeout(timer);
    return !forced;
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
        if (egressResetFailed) throw new Error('egress policy reset failed');
        if (child) {
          const status = await retryable('heartbeat');
          if (!status) continue;
          // A cancel for a runner that already exited has nothing left to stop: settle it, and let
          // Cloud's answer decide (a lease it cannot settle still stops this worker). Ending the
          // loop here would strand a healthy shared session until its VM is fenced (#144).
          if (status.cancel && !childDone && !await stopChild()) throw new Error('worker cancellation required a forced kill');
          if (childDone) {
            await ended;
            // Settlement is idempotent. An explicit busy answer can mean Cloud still has
            // its durable release marker after write contention. Wait a bounded number
            // of times without polling or launching another job. Refusals and transport
            // uncertainty still stop the dispatcher immediately.
            let settled;
            for (let attempt = 0; attempt < 3; attempt++) {
              settled = await call(message('settled'));
              if (!settled.busy) break;
              console.log(JSON.stringify({ nativeWorker: 'wait', reason: 'settlement_busy', attempt: attempt + 1 }));
              if (attempt < 2) await pause(interval, undefined, { signal: controller.signal });
            }
            if (settled.busy) throw new Error('runner exited without settling its lease');
            child = undefined;
          }
        } else {
          auth = await probeAuth();
          const response = await retryable('poll');
          if (stopped) break;
          if (!response) continue;
          if (response.request) {
            // The installation's registry hosts for exactly this assignment (#157), applied
            // before the runner starts and removed as soon as it exits. Bound to the job id the
            // broker token is for; anything else leaves the image's hosts only. A failure to apply
            // stops this worker before the job runs.
            service.applyJobEgress?.(response.egress, response.request?.payload?.broker?.jobId);
            child = launch(response.request);
            childDone = false;
            ended = new Promise((resolve) => {
              const finish = () => {
                if (!childDone) {
                  try { service.resetJobEgress?.(); } catch {
                    egressResetFailed = true;
                    console.error('Removing the finished job\'s registry hosts failed; the worker stops before polling again.');
                  }
                }
                childDone = true;
                resolve();
              };
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
      try { service.resetJobEgress?.(); } catch { /* the supervisor is going away */ }
      // No more heartbeats: reconciliation fences any outstanding assignment. Do not
      // free its quota slot locally, restart this loop, or launch a BYOK fallback.
    }
  })();
  return { done: loop, async close() { stopped = true; controller.abort(); await stopChild(); await loop; } };
}
