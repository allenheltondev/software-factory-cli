import { createHmac } from 'node:crypto';
import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { FlowError } from '../flows/github.js';
import type { NativeRoute } from './route.js';
import { createClaudeSessions, managedWorkerId } from './sessions.js';
import { createNativeStore } from './store.js';

const MAX_SECONDS = 8 * 60 * 60;

export function managedClaude(env = process.env) {
  const imageArn = env.NATIVE_MANAGED_IMAGE_ARN;
  const imageVersion = env.NATIVE_MANAGED_IMAGE_VERSION;
  const executionRoleArn = env.NATIVE_MANAGED_ROLE_ARN;
  const logGroup = env.NATIVE_MANAGED_LOG_GROUP;
  const controlSecretArn = env.NATIVE_MANAGED_SECRET_ARN;
  if (!imageArn || !imageVersion || !controlSecretArn) return undefined;

  const sessions = createClaudeSessions(env.TABLE_NAME ?? '');
  const workers = createNativeStore(env.TABLE_NAME ?? '');
  const microvms = new LambdaMicrovmsClient({});
  const secrets = new SecretsManagerClient({});
  const base = (installationId: number): NativeRoute => ({
    installationId, imageVersion, workerId: managedWorkerId(installationId), microvmId: 'mvm-pending', controlSecretArn,
  });

  async function secret(installationId: number, generation: string) {
    const root = (await secrets.send(new GetSecretValueCommand({ SecretId: controlSecretArn }))).SecretString;
    if (!root || root.length < 32) throw new Error('Managed worker control secret unavailable');
    return createHmac('sha256', root).update(JSON.stringify(['updraft-worker', installationId, generation])).digest('base64url');
  }

  async function route(id: number): Promise<NativeRoute> {
    const session = await sessions.session(id);
    return { ...base(id), ...(session?.microvmId ? { microvmId: session.microvmId, generation: session.generation, imageVersion: session.imageVersion } : {}) };
  }

  async function start(id: number) {
    const region = env.AWS_REGION ?? '';
    if (!executionRoleArn) throw new Error('Managed worker execution role is unavailable');
    const brokerFunctionName = env.BROKER_FUNCTION_NAME;
    if (!brokerFunctionName || !region) throw new Error('Managed worker launch configuration is incomplete');
    let session = await sessions.session(id);
    if (session?.microvmId) {
      try {
        const vm = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: session.microvmId }));
        if (vm.state !== 'TERMINATED') {
          const worker = await workers.get(id, managedWorkerId(id));
          if (!worker?.fenced || worker.microvmId !== session.microvmId) return;
          throw new FlowError('invalid_settings', 409, 'Wait for the previous worker to stop before starting another session');
        }
      } catch (error) { if (!(error instanceof ResourceNotFoundException)) throw error; }
    }
    if (!session || session.microvmId) {
      const reserved = await sessions.requestSession(id, session, imageVersion!);
      session = reserved ?? await sessions.session(id);
      if (!session || session.microvmId) return;
    }
    const partition = imageArn!.split(':')[1];
    const connector = `arn:${partition}:lambda:${region}:aws:network-connector:aws-network-connector:`;
    const token = await secret(id, session.generation);
    const result = await microvms.send(new RunMicrovmCommand({
      clientToken: session.generation, imageIdentifier: imageArn, imageVersion: session.imageVersion, executionRoleArn,
      maximumDurationInSeconds: MAX_SECONDS,
      ...(logGroup ? { logging: { cloudWatch: { logGroup } } } : {}),
      ingressNetworkConnectors: [connector + 'HTTP_INGRESS'], egressNetworkConnectors: [connector + 'INTERNET_EGRESS'],
      runHookPayload: JSON.stringify({ storage: 'ephemeral', cloud: {
        region, brokerFunctionName, workerId: managedWorkerId(id), imageVersion: session.imageVersion, workerVersion: 'tenant-browser-1', controlToken: token,
      } }),
    }));
    if (!result.microvmId) throw new Error('Managed worker launch returned no VM');
    await sessions.bind(id, session.generation, result.microvmId);
  }

  return { route, start, sessions, imageArn, secret };
}
