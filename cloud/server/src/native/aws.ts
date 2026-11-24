import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Store } from '../store/store.js';
import { createNativeControl } from './control.js';
import { managedClaude } from './managed.js';
import { nativeRoute, type NativeRoute } from './route.js';
import { createNativeModeStore, createNativeStore } from './store.js';

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
  const makeControl = (route?: NativeRoute) => createNativeControl({ store, workers, route, secret: () => secret(route), disabled: disabled ?? (() => managed?.disabled() ?? Promise.resolve(false)),
    enabled: async () => !!route && mode.enabled(route.installationId, route.workerId),
    settings: { region: e.AWS_REGION ?? '', bucket: e.TENANT_BUCKET ?? '', imageArn: '', executionRoleArn: '', ingressConnectorArn: '', egressConnectorArn: '', logGroup: '',
      brokerFunctionName: e.BROKER_FUNCTION_NAME ?? e.AWS_LAMBDA_FUNCTION_NAME ?? '', maximumDurationSeconds: Number(e.MAX_DURATION_SECONDS ?? 10800), watchdogReserveSeconds: Number(e.WATCHDOG_RESERVE_SECONDS ?? 600) },
    async terminateMicrovm(id) { await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: id })); },
    async microvmState(id) {
      try { return (await microvms.send(new GetMicrovmCommand({ microvmIdentifier: id }))).state ?? 'UNKNOWN'; }
      catch (e) { if (e instanceof ResourceNotFoundException) return null; throw e; }
    },
  });
  // A managed worker still on an image older than the deployed one gets no new job: the job
  // waits for sign-in instead, and the console asks the owner to restart the worker.
  const forLaunch = (route: NativeRoute, latestImageVersion?: string) => ({
    route, secret: () => secret(route), mode: () => mode.snapshot(route.installationId, route.workerId),
    async ready() {
      if (latestImageVersion !== undefined && route.imageVersion !== latestImageVersion) return false;
      const worker = await workers.get(route.installationId, route.workerId);
      return !!worker && worker.microvmId === route.microvmId && worker.imageVersion === route.imageVersion &&
        !worker.fenced && worker.auth === 'connected' && Date.now() - worker.heartbeatAt <= 60_000;
    },
  });
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
