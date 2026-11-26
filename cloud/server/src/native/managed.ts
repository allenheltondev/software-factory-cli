import { createImagePolicies, imageDecision } from './image-policy.js';
import { createHmac } from 'node:crypto';
import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResourceNotFoundException,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { createKillSwitch, KILL_SWITCH_PARAMETER } from '../jobs/kill-switch.js';
import {
  createClaudeAdmission,
  IDLE_MS,
  managedPolicy,
  SESSION_SECONDS,
  STARTUP_MS,
  type ClaudeAdmission,
} from './admission.js';
import type { ManagedSession } from './sessions.js';
import { FlowError } from '../flows/github.js';
import type { NativeRoute } from './route.js';
import { createManagedSessions } from './sessions.js';
import { managedWorkerId, providerKeys, type NativeProvider } from './provider.js';
import { createNativeModeStore, createNativeStore, type Worker } from './store.js';
import { classifyReadiness } from './readiness.js';

export const MANAGED_IDLE_POLICY = { maxIdleDurationSeconds: SESSION_SECONDS, suspendedDurationSeconds: 0, autoResumeEnabled: false };
/** A VM in these states runs no worker loop: it cannot serve, and with no resume it never will. */
export const SUSPENDED_STATES = ['SUSPENDING', 'SUSPENDED'];

export function managedClaude(
  env = process.env,
  options: { disabled?: () => Promise<boolean>; now?: () => number; admission?: ClaudeAdmission; provider?: NativeProvider } = {},
) {
  // One image for both CLIs (#125): a Codex session is the same image, told its provider.
  const provider = options.provider ?? 'claude';
  const keys = providerKeys(provider);
  const name = keys.name;
  const workerOf = (id: number) => managedWorkerId(id, provider);
  const imageArn = env.NATIVE_MANAGED_IMAGE_ARN;
  const imageVersion = env.NATIVE_MANAGED_IMAGE_VERSION;
  const executionRoleArn = env.NATIVE_MANAGED_ROLE_ARN;
  const logGroup = env.NATIVE_MANAGED_LOG_GROUP;
  const controlSecretArn = env.NATIVE_MANAGED_SECRET_ARN;
  if (!imageArn || !imageVersion || !controlSecretArn) return undefined;

  const imagePolicy = createImagePolicies(env.TABLE_NAME ?? '', imageVersion);
  const sessions = createManagedSessions(env.TABLE_NAME ?? '', undefined, provider);
  const workers = createNativeStore(env.TABLE_NAME ?? '');
  const mode = createNativeModeStore(env.TABLE_NAME ?? '');
  const admission = options.admission ?? createClaudeAdmission(env.TABLE_NAME ?? '', undefined, provider);
  const now = options.now ?? Date.now;
  const policy = managedPolicy(env);
  const ssm = new SSMClient({});
  const killSwitch = createKillSwitch({
    now,
    read: async () => {
      try {
        return (
          (await ssm.send(new GetParameterCommand({ Name: env.KILL_SWITCH_PARAMETER || KILL_SWITCH_PARAMETER })))
            .Parameter?.Value ?? null
        );
      } catch (err) {
        if (err instanceof ParameterNotFound) return null;
        throw err;
      }
    },
  });
  const disabled = options.disabled ?? (() => killSwitch.engaged());
  const microvms = new LambdaMicrovmsClient({});
  const secrets = new SecretsManagerClient({});
  const base = (installationId: number): NativeRoute => ({
    installationId,
    imageVersion,
    workerId: workerOf(installationId),
    microvmId: 'mvm-pending',
    controlSecretArn,
  });

  async function secret(installationId: number, generation: string) {
    const root = (await secrets.send(new GetSecretValueCommand({ SecretId: controlSecretArn }))).SecretString;
    if (!root || root.length < 32) throw new Error('Managed worker control secret unavailable');
    return createHmac('sha256', root)
      .update(JSON.stringify(['updraft-worker', installationId, generation]))
      .digest('base64url');
  }

  async function route(id: number): Promise<NativeRoute> {
    const session = await sessions.session(id);
    return {
      ...base(id),
      ...(session?.microvmId && !session.retiring
        ? { microvmId: session.microvmId, generation: session.generation, imageVersion: session.imageVersion }
        : {}),
    };
  }

  async function launch(session: ManagedSession, id: number, preparedToken?: string, recovery = false) {
    // Recovery is only for an already sealed generation with an ambiguous launch marker.
    // Replaying its original client token discovers the VM for termination, never dispatch.
    if (recovery) {
      const sealed = await sessions.session(id);
      const lease = await admission.get(session.generation);
      if (!sealed?.retiring || sealed.generation !== session.generation || sealed.imageVersion !== session.imageVersion || !lease?.mayHaveLaunched) {
        throw new FlowError('invalid_settings', 409, 'Recovery requires the exact sealed generation and its launch marker');
      }
    } else {
      const read = await imagePolicy(session.imageVersion);
      if (imageDecision(read) !== 'approved') throw new FlowError('invalid_settings', 409, `Reserved ${name} image cannot start: ${read.reason}`);
      // A session must never outlive its image's approval just because later rollouts moved the
      // latest image on (#176): record a bootstrap approval before the VM exists. A drain or
      // revocation that won the race is honored here, before launch.
      const image = imagePolicy.durable ? await imagePolicy.durable(read) : read;
      if (imageDecision(image) !== 'approved') throw new FlowError('invalid_settings', 409, `Reserved ${name} image cannot start: ${image.reason}`);
    }
    const region = env.AWS_REGION ?? '';
    const brokerFunctionName = env.BROKER_FUNCTION_NAME;
    if (!executionRoleArn || !brokerFunctionName || !region)
      throw new Error('Managed worker launch configuration is incomplete');
    const partition = imageArn!.split(':')[1];
    const connector = `arn:${partition}:lambda:${region}:aws:network-connector:aws-network-connector:`;
    const token = preparedToken ?? (await secret(id, session.generation));
    const result = await microvms.send(
      new RunMicrovmCommand({
        clientToken: session.generation,
        imageIdentifier: imageArn,
        imageVersion: session.imageVersion,
        executionRoleArn,
        maximumDurationInSeconds: SESSION_SECONDS,
        // Idle is measured by inbound endpoint traffic, and this worker only polls outward: with
        // the service default it could be suspended minutes after sign-in, its heartbeats would
        // stop, and the next issue would ask for sign-in again (#144). Idle for its whole life,
        // like a job VM; never kept suspended (the image has no suspend/resume hooks).
        idlePolicy: MANAGED_IDLE_POLICY,
        ...(logGroup ? { logging: { cloudWatch: { logGroup } } } : {}),
        ingressNetworkConnectors: [connector + 'HTTP_INGRESS'],
        egressNetworkConnectors: [connector + 'INTERNET_EGRESS'],
        runHookPayload: JSON.stringify({
          storage: 'ephemeral',
          cloud: {
            region,
            brokerFunctionName,
            workerId: workerOf(id),
            imageVersion: session.imageVersion,
            workerVersion: 'tenant-browser-1',
            controlToken: token,
            // Claude's payload is unchanged; only a Codex session names its provider.
            ...(provider === 'codex' ? { provider } : {}),
          },
        }),
      }),
    );
    if (!result.microvmId) throw new Error('Managed worker launch returned no VM');
    return result.microvmId;
  }

  async function stateOf(microvmId: string): Promise<string | null> {
    try {
      return (await microvms.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }))).state ?? 'UNKNOWN';
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }
  async function lifecycle(id: number, generation?: string) {
    const session = await sessions.session(id);
    if (generation && session?.generation !== generation)
      throw new FlowError(
        'invalid_settings',
        409,
        `The ${name} environment changed. Check its current status before reconnecting.`,
      );
    if (!session) return { preparing: false, startupFailed: false, retiring: false };
    const lease = await admission.get(session.generation);
    const worker = await workers.get(id, workerOf(id));
    const ready =
      !!worker &&
      worker.microvmId === session.microvmId &&
      ['auth-required', 'connected', 'expired'].includes(worker.auth);
    if (ready && !session.retiring && !session.readyAt) {
      await sessions.ready(id, session.generation, now());
      if (lease) {
        await admission.touch(session.generation, now());
        lease.idleAt = now() + (lease.idleMs ?? IDLE_MS);
      }
    }
    const startupFailed =
      !session.readyAt && !ready && now() >= (session.startupDeadline ?? session.requestedAt + STARTUP_MS);
    const idleMs = lease?.idleMs ?? policy.idleMs ?? IDLE_MS;
    const busy = worker?.active || worker?.settling || (await workers.queued(id, workerOf(id))).length > 0;
    const lifetimeAt = session.requestedAt + SESSION_SECONDS * 1000;
    const idleAt = lease
      ? Math.max(lease.idleAt, (worker?.lastWorkAt ?? 0) + idleMs, busy ? now() + idleMs : 0)
      : lifetimeAt;
    return {
      expiresAt: new Date(Math.min(lifetimeAt, idleAt)).toISOString(),
      idleSeconds: idleMs / 1000,
      idleExpiresAt: new Date(idleAt).toISOString(),
      retired: session.retiring === true && !['reconnect', 'startup-failed'].includes(session.retirementReason ?? ''),
      retirementReason: session.retirementReason,
      preparing: !!lease && !session.retiring && !startupFailed && !session.readyAt && !ready,
      startupFailed,
      retiring: session.retiring === true,
    };
  }

  /** Session + mode + worker fencing is atomic, even when the worker never registered. */
  async function retire(
    id: number,
    generation: string,
    reason: NonNullable<ManagedSession['retirementReason']> = 'reconnect',
    /**
     * Cleanup's reason, decided again on the exact worker snapshot whose version the sealing
     * transaction checks: a worker that heartbeat or worked since cleanup read it is left alone
     * (#144). A later write changes that version, so the transaction then fails instead.
     */
    stillDue?: (worker: Worker | null) => boolean,
  ): Promise<boolean> {
    const session = await sessions.session(id);
    if (!session || session.generation !== generation) return false;
    if (!session.retiring) {
      const snapshot = await mode.snapshot(id, workerOf(id));
      const worker = await workers.get(id, workerOf(id));
      if (stillDue && !stillDue(worker)) {
        console.log(JSON.stringify({ [keys.logKey]: 'keep', installationId: id, generation, microvmId: session.microvmId, reason, why: 'recovered' }));
        return false;
      }
      const image = await imagePolicy(session.imageVersion);
      const emergency = reason === 'image-revoked' && image.state === 'revoked' ? image : undefined;
      if (reason === 'image-revoked' && !emergency) return false;
      const mandatory = imageDecision(image) !== 'approved';
      if ((!emergency && (worker?.active || worker?.settling)) || (!mandatory && (await workers.queued(id, workerOf(id))).length)) {
        throw new FlowError(
          'invalid_settings',
          409,
          `Wait for active, settling, and queued ${name} jobs to finish before reconnecting.`,
        );
      }
      if (!(await sessions.retire(id, session, snapshot, worker, reason, ...(emergency ? [emergency] as const : [])))) {
        // For cleanup, a worker that changed after this read is one that is alive: keep it.
        if (stillDue) {
          console.log(JSON.stringify({ [keys.logKey]: 'keep', installationId: id, generation, microvmId: session.microvmId, reason, why: 'changed' }));
          return false;
        }
        throw new FlowError(
          'invalid_settings',
          409,
          `The ${name} environment or its work changed. Try reconnecting again.`,
        );
      }
    }
    let lease = await admission.get(generation);
    // Adoption/replay is allowed only for this atomically sealed generation. Every possible
    // replay gets a durable launch marker, including a retry of an interrupted legacy adoption.
    if (!lease && !session.microvmId && !session.admissionRequired) {
      await admission.reserve(id, generation, now(), policy, true);
      lease = await admission.get(generation);
    }
    if (!session.microvmId && !lease?.microvmId && !session.admissionRequired && !lease?.mayHaveLaunched) {
      await admission.launching(generation, now(), true);
      lease = await admission.get(generation);
    }
    await admission.retiring(generation);
    let vm = session.microvmId ?? lease?.microvmId;
    // A durable launch marker means AWS might have accepted an invocation whose response was lost.
    // Replay the SAME client token to discover that VM; never free capacity on a timeout/absent row.
    if (!vm && (lease?.mayHaveLaunched || !session.admissionRequired)) {
      vm = await launch(session, id, undefined, true);
      if (lease) await admission.bind(generation, vm);
    }
    if (vm) {
      const state = await stateOf(vm);
      if (state !== null && state !== 'TERMINATED') {
        await stop(vm);
        if (!['TERMINATED', null].includes(await stateOf(vm))) return false;
      }
    }
    await admission.release(generation, now());
    return true;
  }

  async function start(id: number) {
    const image = await imagePolicy(imageVersion!);
    if (imageDecision(image) !== 'approved') throw new FlowError('invalid_settings', 409, `${name} image cannot start: ${image.reason}`);
    if (await disabled())
      throw new FlowError(
        'throttled',
        503,
        `${name} connections are temporarily paused by an operator. Try again later.`,
      );
    if (!executionRoleArn || !env.BROKER_FUNCTION_NAME || !env.AWS_REGION)
      throw new FlowError('invalid_settings', 409, `${name} launch configuration is incomplete. Contact an operator.`);
    let session = await sessions.session(id);
    if (session && !session.retiring && !session.microvmId) {
      const reservedImage = await imagePolicy(session.imageVersion);
      if (imageDecision(reservedImage) !== 'approved') {
        const reason = reservedImage.state === 'revoked' ? 'image-revoked' : 'image-blocked';
        if (!await retire(id, session.generation, reason)) throw new FlowError('invalid_settings', 409, `The blocked ${name} environment is stopping. Try again shortly.`);
        session = { ...session, retiring: true };
      }
    }
    if (
      session &&
      (session.retiring ||
        (!session.microvmId && now() >= (session.startupDeadline ?? session.requestedAt + STARTUP_MS)))
    ) {
      if (!(await retire(id, session.generation)))
        throw new FlowError('invalid_settings', 409, `The previous ${name} environment is stopping. Try again shortly.`);
      session = { ...session, retiring: true };
    } else if (session?.microvmId) {
      const state = await stateOf(session.microvmId);
      if (state !== null && state !== 'TERMINATED') {
        const worker = await workers.get(id, workerOf(id));
        if (worker?.fenced && worker.microvmId === session.microvmId)
          throw new FlowError(
            'invalid_settings',
            409,
            'Wait for the previous worker to stop before starting another session',
          );
        if ((await lifecycle(id)).startupFailed)
          throw new FlowError(
            'invalid_settings',
            409,
            `This ${name} environment did not become ready. Reconnect ${name} to replace it safely.`,
          );
        await admission.reserve(id, session.generation, now(), policy);
        await admission.bind(session.generation, session.microvmId);
        return;
      }
      await admission.release(session.generation, now());
    }
    if (!session || session.microvmId || session.retiring) {
      const reserved = await sessions.requestSession(id, session, imageVersion!, now());
      session = reserved ?? (await sessions.session(id));
      if (!session || session.microvmId || session.retiring) return;
    }
    const reservedImage = await imagePolicy(session.imageVersion);
    if (imageDecision(reservedImage) !== 'approved') {
      await retire(id, session.generation, reservedImage.state === 'revoked' ? 'image-revoked' : 'image-blocked');
      throw new FlowError('invalid_settings', 409, `Reserved ${name} image cannot start: ${reservedImage.reason}`);
    }
    await admission.reserve(id, session.generation, now(), policy);
    // Fetch the secret before the launch marker. Failure here can be sealed/released without a VM.
    let token: string;
    try {
      token = await secret(id, session.generation);
    } catch (err) {
      await retire(id, session.generation);
      throw err;
    }
    await admission.launching(session.generation, now());
    const current = await sessions.session(id);
    if (!current || current.generation !== session.generation || current.retiring)
      throw new FlowError('invalid_settings', 409, `This ${name} environment is retiring. Try again shortly.`);
    const vm = await launch(session, id, token);
    await admission.bind(session.generation, vm);
    await sessions.bind(id, session.generation, vm);
  }

  /** Called on the existing five-minute reconciliation schedule, not just while a console is open. */
  async function reconcile() {
    let failed = 0;
    let released = 0;
    const paused = await disabled();
    for (const lease of await admission.list()) {
      try {
        const session = await sessions.session(lease.installationId);
        if (!session || session.generation !== lease.generation) {
          // A false launch marker is reclaimable only with an atomic stale-session check.
          if (await admission.reclaimUnlaunched(lease.generation)) {
            released++;
          } else if (lease.microvmId && ['TERMINATED', null].includes(await stateOf(lease.microvmId))) {
            await admission.release(lease.generation, now());
            released++;
          } else failed++;
          continue;
        }
        // A committed seal is irreversible. Finish physical retirement before consulting
        // current policy or busy/queue state: reapproval cannot make this generation usable.
        if (session.retiring) {
          const reason = session.retirementReason ?? 'reconnect';
          console.log(JSON.stringify({ [keys.logKey]: 'retire', installationId: lease.installationId, generation: lease.generation, microvmId: session.microvmId, reason, retry: true }));
          if (await retire(lease.installationId, lease.generation, reason)) released++;
          continue;
        }
        // Emergency containment cannot depend on the revoked image polling, registering, or
        // owning an active job. Never-started queue entries survive generation retirement.
        const image = await imagePolicy(session.imageVersion);
        if (image.state === 'revoked') {
          console.log(JSON.stringify({ [keys.logKey]: 'retire', installationId: lease.installationId, generation: lease.generation, microvmId: session.microvmId, reason: 'image-revoked' }));
          if (await retire(lease.installationId, lease.generation, 'image-revoked')) released++;
          continue;
        }
        const worker = await workers.get(lease.installationId, workerOf(lease.installationId));
        if (
          worker?.active ||
          worker?.settling ||
          (await workers.queued(lease.installationId, workerOf(lease.installationId))).length
        ) {
          await admission.touch(lease.generation, now());
          continue;
        }
        const state = session.microvmId ? await stateOf(session.microvmId) : undefined;
        const lifecycleState = await lifecycle(lease.installationId, lease.generation);
        const idleMs = lease.idleMs ?? IDLE_MS;
        const lifetimeOver = () => now() >= session.requestedAt + SESSION_SECONDS * 1000;
        // Every worker-dependent part of the decision is a function of one worker snapshot, so
        // retire() can make it again on the snapshot its transaction is conditioned on.
        const due = (w: Worker | null): NonNullable<ManagedSession['retirementReason']> | undefined => {
          if (w?.active || w?.settling) return undefined;
          const registered = !!w && w.microvmId === session.microvmId && ['auth-required', 'connected', 'expired'].includes(w.auth);
          const startupFailed = lifecycleState.startupFailed && !registered;
          // A ready session whose dispatcher has been silent past its grace never recovers (its
          // loop does not restart): retire it, rather than advertise it until the idle deadline.
          const lost = !!session.readyAt && !!session.microvmId && classifyReadiness(
            { ...base(lease.installationId), microvmId: session.microvmId, imageVersion: session.imageVersion },
            w, now(), undefined, { vmState: state }) === 'worker-lost';
          const idle = now() >= Math.max(lease.idleAt, (w?.lastWorkAt ?? 0) + idleMs);
          const gone = state === null || state === 'TERMINATED';
          const suspendedVm = SUSPENDED_STATES.includes(state ?? '');
          if (!(paused || session.retiring || lease.retiring || gone || suspendedVm || lost || startupFailed || idle || lifetimeOver())) return undefined;
          return session.retirementReason ?? (paused ? 'disabled' : startupFailed ? 'startup-failed' : suspendedVm ? 'suspended'
            : lost ? 'worker-lost' : lifetimeOver() ? 'lifetime' : gone ? 'vm-ended' : 'idle');
        };
        const reason = due(worker);
        if (reason) {
          console.log(JSON.stringify({ [keys.logKey]: 'retire', installationId: lease.installationId, generation: lease.generation,
            microvmId: session.microvmId, vmState: state ?? null, reason, idleMs, imageVersion: session.imageVersion,
            requestedAt: session.requestedAt, heartbeatAt: worker?.heartbeatAt ?? null }));
          if (await retire(lease.installationId, lease.generation, reason, (fresh) => due(fresh) !== undefined)) released++;
        }
      } catch {
        failed++;
      }
    }
    return { released, failed };
  }
  /** The state of the installation's current session VM, or null when it has none or it is gone. */
  async function vmState(id: number, generation?: string): Promise<string | null> {
    const session = await sessions.session(id);
    if (generation && session?.generation !== generation)
      throw new FlowError(
        'invalid_settings',
        409,
        `The ${name} environment changed. Check its current status before reconnecting.`,
      );
    if (!session?.microvmId) return null;
    try {
      return (await microvms.send(new GetMicrovmCommand({ microvmIdentifier: session.microvmId }))).state ?? null;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }

  /**
   * Ends exactly the VM the caller inspected and fenced, never whatever the session points at
   * now: a replacement started meanwhile (another tab, say) is left alone.
   */
  async function stop(microvmId: string) {
    try {
      await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
  }

  return {
    provider,
    route,
    start,
    stop,
    vmState,
    lifecycle,
    retire,
    reconcile,
    disabled,
    sessions,
    imageArn,
    imageVersion,
    imagePolicy,
    policy: {
      maxSessionSeconds: SESSION_SECONDS,
      idleSeconds: (policy.idleMs ?? IDLE_MS) / 1000,
      concurrentSessions: policy.concurrent,
      tenantDailySeconds: policy.tenantDailySeconds,
      platformDailySeconds: policy.dailySeconds,
      tenantLaunchesPerDay: policy.tenantLaunchesPerDay!,
      platformLaunchesPerDay: policy.platformLaunchesPerDay!,
    },
    secret,
  };
}
