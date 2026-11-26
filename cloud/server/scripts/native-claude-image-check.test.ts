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

describe('the Codex session smoke test (#125)', () => {
  function codexFixture(serves: Record<string, boolean>) {
    const send = vi.fn((command: unknown) => {
      if (command instanceof RunMicrovmCommand) return { microvmId: microvmIdentifier };
      if (command instanceof GetMicrovmCommand) return { state: 'RUNNING', endpoint };
      if (command instanceof CreateMicrovmAuthTokenCommand) return { authToken: { 'X-aws-proxy-auth': 'smoke-token' } };
      if (command instanceof TerminateMicrovmCommand) return {};
      throw new Error('unexpected MicroVM command');
    });
    const opened: string[] = [];
    const closed = vi.fn();
    class Socket extends EventTarget {
      constructor(url: URL) {
        super();
        const path = url.pathname;
        queueMicrotask(() => {
          if (serves[path]) { opened.push(path); this.dispatchEvent(new Event('open')); } else this.dispatchEvent(new Event('error'));
        });
      }
      close() { closed(); }
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    vi.stubGlobal('WebSocket', Socket);
    return { run: () => checkNativeClaudeImage({ send } as unknown as LambdaMicrovmsClient, image, 'codex'), send, opened, closed };
  }

  it('starts the image as a Codex session and checks it serves only /codex-login', async () => {
    const { run, send, opened, closed } = codexFixture({ '/codex-login': true });
    await run();
    const payload = JSON.parse((send.mock.calls[0]![0] as RunMicrovmCommand).input.runHookPayload!);
    expect(payload.cloud).toMatchObject({ provider: 'codex', workerId: 'signed-out-smoke' });
    expect(opened).toEqual(['/codex-login']);
    expect(closed).toHaveBeenCalledTimes(2);
    expect(send.mock.lastCall?.[0]).toBeInstanceOf(TerminateMicrovmCommand);
  });

  it('fails when the worker does not serve the Codex route, or serves Claude\'s on a Codex session', async () => {
    await expect(codexFixture({}).run()).rejects.toThrow('did not serve its sign-in route');
    await expect(codexFixture({ '/codex-login': true, '/claude-login': true }).run()).rejects.toThrow('served the Claude sign-in route');
  });

  it('leaves the Claude smoke\'s run hook unchanged: no provider', async () => {
    const { run, send } = fixture({ url: 'https://claude.ai/oauth/authorize' });
    await run();
    expect(JSON.parse((send.mock.calls[0]![0] as RunMicrovmCommand).input.runHookPayload!).cloud).not.toHaveProperty('provider');
  });
});
