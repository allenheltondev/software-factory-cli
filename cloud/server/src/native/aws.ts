import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Store } from '../store/store.js';
import { createNativeControl } from './control.js';
import { nativeRoute } from './route.js';
import { createNativeModeStore, createNativeStore } from './store.js';

/** No native route is enabled unless the operator explicitly supplies the test route. */
export function nativeAws(store: Store, disabled: () => Promise<boolean> = async () => false) {
  const e = process.env;
  const route = nativeRoute(e.NATIVE_WORKER_ROUTE);
  const mode = createNativeModeStore(e.TABLE_NAME ?? '');
  const enabled = async () => !!route && mode.enabled(route.installationId, route.workerId);
  const secrets = new SecretsManagerClient({});
  const microvms = new LambdaMicrovmsClient({});
  const secret = async () => {
    if (!route) throw new Error('native worker route is disabled');
    const value = (await secrets.send(new GetSecretValueCommand({ SecretId: route.controlSecretArn }))).SecretString;
    if (!value || value.length < 32 || value.length > 256) throw new Error('invalid worker control credential');
    return value;
  };
  const control = createNativeControl({ store, workers: createNativeStore(e.TABLE_NAME ?? ''), route, secret, disabled, enabled,
    settings: { region: e.AWS_REGION ?? '', bucket: e.TENANT_BUCKET ?? '', imageArn: '', executionRoleArn: '', ingressConnectorArn: '', egressConnectorArn: '', logGroup: '',
      brokerFunctionName: e.BROKER_FUNCTION_NAME ?? e.AWS_LAMBDA_FUNCTION_NAME ?? '', maximumDurationSeconds: Number(e.MAX_DURATION_SECONDS ?? 10800), watchdogReserveSeconds: Number(e.WATCHDOG_RESERVE_SECONDS ?? 600) },
    async terminateMicrovm(id) { await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: id })); },
    async microvmState(id) {
      try { return (await microvms.send(new GetMicrovmCommand({ microvmIdentifier: id }))).state ?? 'UNKNOWN'; }
      catch (e) { if (e instanceof ResourceNotFoundException) return null; throw e; }
    },
  });
  return { control, launch: route ? { route, secret, enabled } : undefined };
}
