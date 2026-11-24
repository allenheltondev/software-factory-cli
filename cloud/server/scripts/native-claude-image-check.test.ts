import {
  CreateMicrovmAuthTokenCommand, GetMicrovmCommand, RunMicrovmCommand, TerminateMicrovmCommand,
  type LambdaMicrovmsClient,
} from '@aws-sdk/client-lambda-microvms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkNativeClaudeImage } from './native-claude-image-check.js';

const image = {
  imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:updraft-native-claude',
  version: '6.0', region: 'us-east-1', executionRoleArn: 'worker-role',
  logGroup: 'worker-logs', brokerFunctionName: 'broker',
};
const endpoint = 'microvm.example.on.aws';
const microvmIdentifier = 'microvm-smoke';

function fixture(message: object, lifecycleStatus = 403) {
  const send = vi.fn((command: unknown) => {
    if (command instanceof RunMicrovmCommand) return { microvmId: microvmIdentifier };
    if (command instanceof GetMicrovmCommand) return { state: 'RUNNING', endpoint };
    if (command instanceof CreateMicrovmAuthTokenCommand) return { authToken: { 'X-aws-proxy-auth': 'smoke-token' } };
    if (command instanceof TerminateMicrovmCommand) return {};
    throw new Error('unexpected MicroVM command');
  });
  const onConnect = vi.fn();
  class Socket extends EventTarget {
    constructor(url: URL, options: unknown) {
      super();
      onConnect(url.href, options);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })));
    }
    close() {}
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: lifecycleStatus })));
  vi.stubGlobal('WebSocket', Socket);
  return { run: () => checkNativeClaudeImage({ send } as unknown as LambdaMicrovmsClient, image), send, onConnect };
}

afterEach(() => vi.unstubAllGlobals());

describe('the Claude image release smoke test', () => {
  it('requires the official link on the scoped browser connection and terminates the probe', async () => {
    const { run, send, onConnect } = fixture({ url: 'https://claude.ai/oauth/authorize?state=synthetic' });
    await run();
    expect(send.mock.calls[2]?.[0]).toMatchObject({ input: { microvmIdentifier, allowedPorts: [{ port: 8081 }] } });
    expect(onConnect).toHaveBeenCalledWith(`wss://${endpoint}/claude-login`, {
      protocols: ['lambda-microvms', 'lambda-microvms.authentication.smoke-token', 'lambda-microvms.port.8081'],
      headers: { Origin: 'null' },
    });
    expect(send.mock.lastCall?.[0]).toBeInstanceOf(TerminateMicrovmCommand);
  });

  it('refuses activation when the worker never returns a sign-in link and terminates the probe', async () => {
    const { run, send } = fixture({ status: 'failed' });
    await expect(run()).rejects.toThrow('the worker did not return an official Claude sign-in link');
    expect(send.mock.lastCall?.[0]).toBeInstanceOf(TerminateMicrovmCommand);
  });

  it('refuses activation if the browser grant reaches the lifecycle port', async () => {
    const { run, send, onConnect } = fixture({ url: 'https://claude.ai/oauth/authorize' }, 409);
    await expect(run()).rejects.toThrow('browser grant did not deny the lifecycle port');
    expect(onConnect).not.toHaveBeenCalled();
    expect(send.mock.lastCall?.[0]).toBeInstanceOf(TerminateMicrovmCommand);
  });
});
