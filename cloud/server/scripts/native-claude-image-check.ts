import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  CreateMicrovmAuthTokenCommand, GetMicrovmCommand, RunMicrovmCommand, TerminateMicrovmCommand,
  type LambdaMicrovmsClient,
} from '@aws-sdk/client-lambda-microvms';

interface SmokeImage {
  imageArn: string;
  version: string;
  region: string;
  executionRoleArn: string;
  logGroup: string;
  brokerFunctionName: string;
}

/** Prove the signed-out customer entry point without logging in or binding a tenant. */
export async function checkNativeClaudeImage(client: LambdaMicrovmsClient, image: SmokeImage) {
  if (!image.brokerFunctionName) throw new Error('the stack has no BrokerFunctionName output');
  const connectors = `arn:${image.imageArn.split(':')[1]}:lambda:${image.region}:aws:network-connector:aws-network-connector:`;
  const vm = await client.send(new RunMicrovmCommand({
    imageIdentifier: image.imageArn, imageVersion: image.version, executionRoleArn: image.executionRoleArn,
    maximumDurationInSeconds: 300, logging: { cloudWatch: { logGroup: image.logGroup } },
    ingressNetworkConnectors: [connectors + 'HTTP_INGRESS'], egressNetworkConnectors: [connectors + 'INTERNET_EGRESS'],
    runHookPayload: JSON.stringify({
      storage: 'ephemeral',
      cloud: {
        region: image.region, brokerFunctionName: image.brokerFunctionName,
        workerId: 'signed-out-smoke', workerVersion: 'smoke', imageVersion: image.version,
        controlToken: randomBytes(32).toString('base64url'),
      },
    }),
  }));
  if (!vm.microvmId) throw new Error('AWS returned no smoke worker ID');
  const id = vm.microvmId;
  const signal = AbortSignal.timeout(180_000);
  try {
    console.log(`==> checking signed-out worker ${id} (logs: ${image.logGroup})`);
    let address: string | undefined;
    for (;;) {
      const status = await client.send(new GetMicrovmCommand({ microvmIdentifier: id }), { abortSignal: signal });
      if (status.state === 'RUNNING') {
        address = status.endpoint ?? vm.endpoint;
        break;
      }
      if (status.state === 'TERMINATED') throw new Error(`worker terminated during startup: ${status.stateReason ?? 'unknown reason'}`);
      await pause(5000, undefined, { signal });
    }
    if (!address) throw new Error('AWS returned no smoke worker endpoint');
    const endpoint = new URL(address.includes('://') ? address : 'https://' + address);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.on.aws') || endpoint.username ||
        endpoint.password || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      throw new Error('AWS returned an unexpected smoke worker endpoint');
    }
    const grant = await client.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: id, expirationInMinutes: 5, allowedPorts: [{ port: 8081 }],
    }), { abortSignal: signal });
    const token = grant.authToken?.['X-aws-proxy-auth'];
    if (!token) throw new Error('AWS returned no browser grant');
    const hook = await fetch(new URL('/aws/lambda-microvms/runtime/v1/run', endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'X-aws-proxy-auth': token, 'X-aws-proxy-port': '9000', 'Content-Type': 'application/json' },
      body: '{}',
    });
    await hook.body?.cancel();
    if (![401, 403].includes(hook.status)) throw new Error(`browser grant did not deny the lifecycle port: HTTP ${hook.status}`);
    await verifyLoginPrompt(endpoint, token);
  } catch (error) {
    throw new Error(`Claude sign-in smoke failed for version ${image.version} (worker ${id}, logs ${image.logGroup}): ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error });
  } finally {
    await client.send(new TerminateMicrovmCommand({ microvmIdentifier: id }), { abortSignal: AbortSignal.timeout(15000) });
  }
}

async function verifyLoginPrompt(endpoint: URL, token: string) {
  const url = new URL('/claude-login', endpoint);
  url.protocol = 'wss:';
  // Node's WebSocketInit supports the Origin sent by the console's opaque-origin frame.
  const Socket = WebSocket as unknown as new (url: URL, options: { protocols: string[]; headers: Record<string, string> }) => WebSocket;
  const ws = new Socket(url, {
    protocols: ['lambda-microvms', `lambda-microvms.authentication.${token}`, 'lambda-microvms.port.8081'],
    headers: { Origin: 'null' },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = AbortSignal.timeout(75000);
      timeout.addEventListener('abort', () => reject(new Error('timed out waiting for the Claude sign-in link')));
      ws.addEventListener('error', () => reject(new Error('the browser WebSocket failed to connect')), { once: true });
      ws.addEventListener('close', () => reject(new Error('the connection closed before sign-in')), { once: true });
      ws.addEventListener('message', (event) => {
        try {
          const { url: signInUrl } = JSON.parse(String(event.data));
          const link = new URL(signInUrl);
          if (link.origin === 'https://claude.ai' && link.pathname === '/oauth/authorize' && !link.username && !link.password) {
            resolve();
            return;
          }
        } catch { /* Never print the response, which can contain an OAuth link. */ }
        reject(new Error('the worker did not return an official Claude sign-in link'));
      }, { once: true });
    });
  } finally {
    ws.close();
  }
}
