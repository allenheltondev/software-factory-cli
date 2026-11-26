import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Store } from '../store/store.js';
import { createNativeControl } from './control.js';
import { managedClaude } from './managed.js';
import { nativeRoute, type NativeRoute } from './route.js';
import type { NativeLaunch, NativeReadiness } from '../jobs/launch.js';
import { createNativeModeStore, createNativeStore } from './store.js';
import { classifyReadiness, needsVmState, sessionPhase } from './readiness.js';
import { createImagePolicies } from './image-policy.js';
import { STARTUP_MS } from './admission.js';
import { CODEX_IMAGE_UNSUPPORTED, parseManagedWorkerId, type NativeProvider } from './provider.js';

export { classifyReadiness, HEARTBEAT_FRESH_MS, WORKER_LOST_MS } from './readiness.js';

/** Resolves the legacy pinned route or the current managed session for an installation. */
export function nativeAws(store: Store, disabled?: () => Promise<boolean>) {
  const e = process.env;
  const pinned = nativeRoute(e.NATIVE_WORKER_ROUTE);
  const managed = managedClaude(e, disabled ? { disabled } : {});
  // Codex on a ChatGPT plan (#125): its own managed sessions, on the same image as Claude's.
  const managedCodex = managedClaude(e, { ...(disabled ? { disabled } : {}), provider: 'codex' });
  const managedOf = (provider: NativeProvider) => provider === 'codex' ? managedCodex : managed;
  /** The managed stack of a managed worker id, or undefined (a pinned route, or none deployed). */
  const managedFor = (workerId: string | undefined) => {
    const parsed = parseManagedWorkerId(workerId);
    return parsed ? { ...parsed, managed: managedOf(parsed.provider) } : undefined;
  };
  const imagePolicy = createImagePolicies(e.TABLE_NAME ?? '', e.NATIVE_MANAGED_IMAGE_VERSION ?? '');
  const mode = createNativeModeStore(e.TABLE_NAME ?? '');
  const workers = createNativeStore(e.TABLE_NAME ?? '');
  const secrets = new SecretsManagerClient({});
  const microvms = new LambdaMicrovmsClient({});
  const secret = async (route?: NativeRoute) => {
    if (!route) throw new Error('native worker route is disabled');
    const own = managedFor(route.workerId)?.managed;
    if (route.generation && own) return own.secret(route.installationId, route.generation);
    if (own) throw new Error('Managed worker has not started');
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
      ...(managedFor(route.workerId)?.managed ? {
        provider: managedFor(route.workerId)!.provider,
        async retirement() {
          const session = await managedFor(route.workerId)!.managed!.sessions.session(route.installationId);
          return session?.retiring ? session.retirementReason ?? 'reconnect' : undefined;
        },
      } : {}),
    };
  };
  async function readinessOf(route: NativeRoute, latestImageVersion?: string): Promise<NativeReadiness> {
    const worker = await workers.get(route.installationId, route.workerId);
    // A managed route is judged against the session record itself: route() leaves out the
    // generation of a session that has not bound a VM yet, which is starting, not lost.
    const own = managedFor(route.workerId)?.managed;
    const session = own ? sessionPhase(await own.sessions.session(route.installationId), route, STARTUP_MS) : undefined;
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
        const own = managedFor(job.native?.workerId);
        if (own) return own.managed
          ? makeControl(await own.managed.route(job.installationId)).canServe(job) : false;
        return control.canServe(job);
      },
      async reconcile(job: import('../store/store.js').Job) {
        const own = managedFor(job.native?.workerId)?.managed;
        return own ? makeControl(await own.route(job.installationId)).reconcile(job) : control.reconcile(job);
      },
      async handle(event: unknown) {
      // A managed worker's id names its installation and provider (`managed-<id>`, `managed-codex-<id>`).
      const own = managedFor((event as { workerId?: unknown } | null)?.workerId as string | undefined);
      if (!own?.managed) return control.handle(event);
      const route = await own.managed.route(own.installationId);
      if (!route.generation) return { ok: false };
      return makeControl(route).handle(event);
    } },
    launch: pinned ? forLaunch(pinned) : undefined,
    resolveNative: managed ? async (id: number) => forLaunch(await managed.route(id), managed.imageVersion) : undefined,
    /** The installation's Codex session (ChatGPT plan), as dispatch sees it. */
    // Only where the deployed image was verified with Codex: otherwise there is no Codex route, so
    // dispatch never selects a session that cannot start.
    // On an image not verified with Codex, the route is still resolved with its mode and triggers,
    // marked unavailable: a ChatGPT-plan trigger is refused as unavailable, never moved to an API
    // key, and no session is ever started for it.
    resolveCodex: managedCodex ? async (id: number): Promise<NativeLaunch> => {
      const launch = forLaunch(await managedCodex.route(id), managedCodex.imageVersion);
      return (await managedCodex.available()) ? launch : { ...launch, unavailable: CODEX_IMAGE_UNSUPPORTED };
    } : undefined,
    managed,
    managedCodex,
    managedOf,
  };
}
