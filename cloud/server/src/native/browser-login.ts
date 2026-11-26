import { CreateMicrovmAuthTokenCommand, GetMicrovmCommand, LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { FlowError } from '../flows/github.js';
import type { NativeRoute } from './route.js';

const PORT = 8081;
const EXPIRES_MINUTES = 5;

/** A short-lived, port-scoped grant to the worker's private sign-in route: Claude's, or Codex's device-code route (#125). */
export function browserLoginGrant(imageArn: string, route?: NativeRoute, path: '/claude-login' | '/codex-login' = '/claude-login') {
  if (!route || !imageArn) return undefined;
  const aws = new LambdaMicrovmsClient({});
  return async () => {
    const vm = await aws.send(new GetMicrovmCommand({ microvmIdentifier: route.microvmId }));
    if (vm.imageArn !== imageArn || vm.state !== 'RUNNING' || vm.microvmId !== route.microvmId || vm.imageVersion !== route.imageVersion || !vm.endpoint) {
      throw new FlowError('invalid_settings', 409, 'The subscription worker is no longer running. Start a new worker session.');
    }
    const url = new URL(vm.endpoint.includes('://') ? vm.endpoint : `https://${vm.endpoint}`);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.on.aws') || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('Unexpected MicroVM endpoint');
    url.protocol = 'wss:';
    url.pathname = path;
    const { authToken } = await aws.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: route.microvmId, expirationInMinutes: EXPIRES_MINUTES, allowedPorts: [{ port: PORT }],
    }));
    const token = authToken?.['X-aws-proxy-auth'];
    if (!token || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('Malformed MicroVM endpoint grant');
    const expiresAt = vm.startedAt && vm.maximumDurationInSeconds
      ? new Date(vm.startedAt.getTime() + vm.maximumDurationInSeconds * 1000).toISOString()
      : undefined;
    return { url: url.href, token, port: PORT, ...(expiresAt ? { expiresAt } : {}) };
  };
}
