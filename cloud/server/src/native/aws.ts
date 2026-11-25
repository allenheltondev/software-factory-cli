import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Store } from '../store/store.js';
import { createNativeControl } from './control.js';
import { managedClaude } from './managed.js';
import { nativeRoute, type NativeRoute } from './route.js';
import type { NativeReadiness } from '../jobs/launch.js';
import { createNativeModeStore, createNativeStore } from './store.js';
import { classifyReadiness, needsVmState, sessionPhase } from './readiness.js';
import { createImagePolicies } from './image-policy.js';
import { STARTUP_MS } from './admission.js';

export { classifyReadiness, HEARTBEAT_FRESH_MS, WORKER_LOST_MS } from './readiness.js';

/** Resolves the legacy pinned route or the current managed session for an installation. */
export function nativeAws(store: Store, disabled?: () => Promise<boolean>) {
  const e = process.env;
  const pinned = nativeRoute(e.NATIVE_WORKER_ROUTE);
  const managed = managedClaude(e, disabled ? { disabled } : {});
  const imagePolicy = createImagePolicies(e.TABLE_NAME ?? '', e.NATIVE_MANAGED_IMAGE_VERSION ?? '');
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
    imagePolicy: route?.generation ? () => imagePolicy(route.imageVersion) : undefined,
    enabled: async () => !!route && mode.enabled(route.installationId, route.workerId),
    settings: { region: e.AWS_REGION ?? '', bucket: e.TENANT_BUCKET ?? '', imageArn: '', executionRoleArn: '', ingressConnectorArn: '', egressConnectorArn: '', logGroup: '',
      brokerFunctionName: e.BROKER_FUNCTION_NAME ?? e.AWS_LAMBDA_FUNCTION_NAME ?? '', consoleOrigin: e.UPDRAFT_CONSOLE_ORIGIN || undefined, maximumDurationSeconds: Number(e.MAX_DURATION_SECONDS ?? 10800), watchdogReserveSeconds: Number(e.WATCHDOG_RESERVE_SECONDS ?? 600) },
    async terminateMicrovm(id) { await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: id })); },
    microvmState,
  });
  // Latest image selection and exact compatibility approval are independent.
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
    // A managed route is judged against the session record itself: route() leaves out the
    // generation of a session that has not bound a VM yet, which is starting, not lost.
    const session = managed && route.workerId.startsWith('managed-')
      ? sessionPhase(await managed.sessions.session(route.installationId), route, STARTUP_MS) : undefined;
    const first = classifyReadiness(route, worker, Date.now(), latestImageVersion, { session, ...(latestImageVersion ? { imagePolicy: await imagePolicy(route.imageVersion) } : {}) });
    if (!needsVmState(first, route, session)) return first;
    // Only on these paths does dispatch ask AWS: it tells a suspended or ended environment from a
    // worker that is starting, briefly silent, or lost. An unreadable state leaves the first
    // answer: the job waits or asks for a reconnect, and is never sent to a silent worker.
    const vmState = await microvmState(route.microvmId).catch(() => undefined);
    return vmState === undefined ? first : classifyReadiness(route, worker, Date.now(), latestImageVersion, { session, vmState, ...(latestImageVersion ? { imagePolicy: await imagePolicy(route.imageVersion) } : {}) });
  }

  const control = makeControl(pinned);
  return {
    control: { ...control,
      async canServe(job: import('../store/store.js').Job) {
        if (job.native?.workerId.startsWith('managed-')) return managed
          ? makeControl(await managed.route(job.installationId)).canServe(job) : false;
        return control.canServe(job);
      },
      async reconcile(job: import('../store/store.js').Job) {
        return job.native?.workerId.startsWith('managed-') && managed
          ? makeControl(await managed.route(job.installationId)).reconcile(job) : control.reconcile(job);
      },
      async handle(event: unknown) {
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
