import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Store } from '../store/store.js';
import { createNativeControl } from './control.js';
import { managedClaude } from './managed.js';
import { nativeRoute, type NativeRoute } from './route.js';
import type { NativeReadiness } from '../jobs/launch.js';
import { createNativeModeStore, createNativeStore, type Worker } from './store.js';

export const HEARTBEAT_FRESH_MS = 60_000;

/**
 * Dispatch's readiness rules, pure, so the operator trace script reports exactly what dispatch
 * decides. `vmState` is consulted only for a stale heartbeat (undefined: not read).
 */
export function classifyReadiness(route: NativeRoute, worker: Worker | null, now: number, latestImageVersion?: string, vmState?: string | null): NativeReadiness {
  if (latestImageVersion !== undefined && route.imageVersion !== latestImageVersion) return 'image-outdated';
  if (!worker) return 'worker-missing';
  if (worker.microvmId !== route.microvmId || worker.imageVersion !== route.imageVersion) return 'worker-replaced';
  if (worker.fenced) return 'fenced';
  if (now - worker.heartbeatAt > HEARTBEAT_FRESH_MS) {
    if (vmState === 'SUSPENDED' || vmState === 'SUSPENDING') return 'environment-suspended';
    if (vmState === null || vmState === 'TERMINATED' || vmState === 'TERMINATING') return 'environment-ended';
    return 'heartbeat-stale';
  }
  if (worker.auth === 'auth-required') return 'auth-required';
  if (worker.auth === 'expired') return 'expired';
  return worker.auth === 'connected' ? 'ready' : 'auth-unavailable';
}

/** Resolves the legacy pinned route or the current managed session for an installation. */
export function nativeAws(store: Store, disabled?: () => Promise<boolean>) {
  const e = process.env;
  const pinned = nativeRoute(e.NATIVE_WORKER_ROUTE);
  const managed = managedClaude(e, disabled ? { disabled } : {});
  const mode = createNativeModeStore(e.TABLE_NAME ?? '');
  const workers = createNativeStore(e.TABLE_NAME ?? '');
  const secrets = new SecretsManagerClient({});
  const microvms = new LambdaMicrovmsClient({});
  const secret = async (route?: NativeRoute) => {
    if (!route) throw new Error('native worker route is disabled');
    if (route.generation && managed) return managed.secret(route.installationId, route.generation);
    if (managed && route.workerId.startsWith('managed-')) throw new Error('Managed worker has not started');
    const value = (await secrets.send(new GetSecretValueCommand({ SecretId: route.controlSecretArn }))).SecretString;
    if (!value || value.length < 32 || value.length > 256) throw new Error('invalid worker control credential');
    return value;
  };
  async function microvmState(id: string): Promise<string | null> {
    try { return (await microvms.send(new GetMicrovmCommand({ microvmIdentifier: id }))).state ?? 'UNKNOWN'; }
    catch (e) { if (e instanceof ResourceNotFoundException) return null; throw e; }
  }
  const makeControl = (route?: NativeRoute) => createNativeControl({ store, workers, route, secret: () => secret(route), disabled: disabled ?? (() => managed?.disabled() ?? Promise.resolve(false)),
    enabled: async () => !!route && mode.enabled(route.installationId, route.workerId),
    settings: { region: e.AWS_REGION ?? '', bucket: e.TENANT_BUCKET ?? '', imageArn: '', executionRoleArn: '', ingressConnectorArn: '', egressConnectorArn: '', logGroup: '',
      brokerFunctionName: e.BROKER_FUNCTION_NAME ?? e.AWS_LAMBDA_FUNCTION_NAME ?? '', maximumDurationSeconds: Number(e.MAX_DURATION_SECONDS ?? 10800), watchdogReserveSeconds: Number(e.WATCHDOG_RESERVE_SECONDS ?? 600) },
    async terminateMicrovm(id) { await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: id })); },
    microvmState,
  });
  // A managed worker still on an image older than the deployed one gets no new job: the job
  // waits instead, and the console asks the owner to restart the worker. Each reason not to
  // dispatch is named, so a healthy session between polls is never reported as signed out (#144).
  const forLaunch = (route: NativeRoute, latestImageVersion?: string) => {
    const readiness = () => readinessOf(route, latestImageVersion);
    return {
      route, secret: () => secret(route), mode: () => mode.snapshot(route.installationId, route.workerId),
      async ready() { return (await readiness()) === 'ready'; },
      readiness,
    };
  };
  async function readinessOf(route: NativeRoute, latestImageVersion?: string): Promise<NativeReadiness> {
    const worker = await workers.get(route.installationId, route.workerId);
    const first = classifyReadiness(route, worker, Date.now(), latestImageVersion);
    if (first !== 'heartbeat-stale') return first;
    // Only on this path does dispatch ask AWS: it tells a suspended or ended environment (which
    // needs a reconnect) from a heartbeat gap a healthy one recovers from. An unreadable state
    // is reported as the gap: the job waits either way, and is never sent to a stale worker.
    return classifyReadiness(route, worker, Date.now(), latestImageVersion, await microvmState(route.microvmId).catch(() => 'UNKNOWN'));
  }

  const control = makeControl(pinned);
  return {
    control: { ...control, async handle(event: unknown) {
      const id = /^(?:managed-)([1-9]\d*)$/.exec(String((event as { workerId?: unknown } | null)?.workerId))?.[1];
      if (!managed || !id || !Number.isSafeInteger(Number(id))) return control.handle(event);
      const route = await managed.route(Number(id));
      if (!route.generation) return { ok: false };
      return makeControl(route).handle(event);
    } },
    launch: pinned ? forLaunch(pinned) : undefined,
    resolveNative: managed ? async (id: number) => forLaunch(await managed.route(id), managed.imageVersion) : undefined,
    managed,
  };
}
