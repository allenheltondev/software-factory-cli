import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { IMAGE, TOOL, MAX_FRAME, GIT_IDENTITY, claudeArgs, claudeEnv, checkInventory, validateRun, resolveRunEnvironment } from '../native-worker/policy.mjs';
import { frames, readPrompt } from '../native-worker/protocol.mjs';
import { bootPayload } from '../native-worker/hooks.mjs';
import { endpointPorts, tokenArgs, verifyHookPort } from '../native-worker/endpoint-token.mjs';
import { containInvocation } from '../../../src/worker/container.ts';
import { commitIdentityEnv } from '../../../src/github/credentials.ts';
import { containerSchema } from '../../../src/config/schema.ts';
import { createGitFixture } from '../../../test/git-fixtures.ts';
import { createProbeServer, PROBE_PORT } from '../native-worker/probe.mjs';

describe('native Claude worker policy', () => {
  it.skipIf(process.platform === 'win32')('accepts actual commitAsApp containInvocation arguments without adding identity to Claude', () => {
    const f = createGitFixture();
    try {
      const worktree = path.join(f.root, 'job');
      f.git(f.clone, 'worktree', 'add', '--quiet', '-b', 'identity-proof', worktree, 'HEAD');
      const env = commitIdentityEnv({ name: 'updraft[bot]', email: '42+updraft[bot]@users.noreply.github.com' });
      const wrapped = containInvocation({ invocation: { file: 'claude', args: ['-p'], promptVia: 'stdin' },
        container: containerSchema.parse({ image: IMAGE, network: 'none' }), runtime: '/runtime', runId: 'identity-proof',
        worktree, promptFile: path.join(f.root, 'prompt.md'), agentEnv: env, user: '1000:1000' });
      const args = resolveRunEnvironment(wrapped.invocation.args, env);
      const run = validateRun(args.slice(1), { workRoot: fs.realpathSync(f.root), workerUid: 1000, workerGid: 1000 });
      expect(run.env.filter((entry) => GIT_IDENTITY.includes(entry.name))).toEqual(Object.entries(env).map(([name, value]) => ({ name, value })));
      for (const name of GIT_IDENTITY) expect(claudeEnv({ credentialHome: '/private' })[name]).toBeUndefined();
    } finally { f.cleanup(); }
  });
  it('resolves only explicit Git identity fields from the runtime client environment', () => {
    const args = ['run', '--rm', '--name', 'test', '-e', 'HOME=/updraft-home', ...GIT_IDENTITY.flatMap((name) => ['-e', name]), IMAGE, 'claude', '-p'];
    const env = Object.fromEntries(GIT_IDENTITY.map((name) => [name, name.endsWith('EMAIL') ? '42+updraft[bot]@users.noreply.github.com' : 'updraft[bot]']));
    const resolved = resolveRunEnvironment(args, { ...env, ANTHROPIC_API_KEY: 'do-not-forward', NODE_OPTIONS: 'do-not-forward' });
    for (const name of GIT_IDENTITY) expect(resolved).toContain(`${name}=${env[name]}`);
    expect(resolved.join(' ')).not.toContain('do-not-forward');
    expect(() => resolveRunEnvironment(args, {})).toThrow();
    for (const name of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'GIT_CONFIG_COUNT', 'GIT_SSH_COMMAND', 'CLAUDE_CONFIG_DIR']) {
      expect(() => resolveRunEnvironment(['run', '--rm', '--name', 'test', '-e', name, IMAGE, 'claude'], { [name]: 'unsafe' })).toThrow();
    }
  });
  it('accepts only EFS identifiers in the lifecycle payload, never credentials or commands', () => {
    const payload = { fileSystemId: 'fs-0123456789abcdef0', accessPointId: 'fsap-0123456789abcdef0' };
    expect(bootPayload(JSON.stringify(payload))).toEqual(payload);
    for (const value of [{ ...payload, token: 'secret' }, { ...payload, fileSystemId: 'fs-1234,other=unsafe' }, {}, null]) {
      expect(() => bootPayload(JSON.stringify(value))).toThrow();
    }
  });
  it('replaces bypassPermissions and removes built-in tools, project configuration and hooks', () => {
    const args = claudeArgs(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'sonnet', '--effort', 'high'], '{}');
    expect(args).toContain('--restricted');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', '']);
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('{"disableAllHooks":true}');
    expect(args).toContain(TOOL);
    expect(args).not.toContain('bypassPermissions');
    expect(args.slice(-4)).toEqual(['--model', 'sonnet', '--effort', 'high']);
  });

  it.each([
    ['--tools', 'Read'], ['--mcp-config', '/repo/evil.json'], ['--settings', '/repo/settings.json'],
    ['--plugin-dir', '/repo/plugin'], ['--resume', '/repo/session.jsonl'], ['--add-dir', '/'],
    ['--dangerously-skip-permissions'], ['--permission-mode', 'acceptEdits'], ['--output-format', 'text'],
    ['--model'], ['--model', '--tools'], ['--setting-sources', 'project'], ['--system-prompt', 'unsafe'],
  ])('rejects caller-controlled capability flags: %s', (...extra) => {
    expect(() => claudeArgs(['-p', '--output-format', 'stream-json', ...extra], '{}')).toThrow();
  });

  it('requires exactly the isolated tool inventory, allowing only the CLI termination tool', () => {
    expect(checkInventory({ type: 'system', subtype: 'init', tools: [TOOL] })).toBe(true);
    expect(checkInventory({ type: 'system', subtype: 'init', tools: [TOOL, 'EndConversation'] })).toBe(true);
    for (const tools of [[TOOL, 'Read'], [TOOL, 'Bash'], [TOOL, 'Agent'], [], ['mcp__other__exec']]) {
      expect(() => checkInventory({ type: 'system', subtype: 'init', tools })).toThrow();
    }
    expect(checkInventory({ type: 'assistant' })).toBe(false);
  });

  it('constructs a fresh Claude environment without inherited API keys, OAuth or loader variables', () => {
    const env = claudeEnv({ credentialHome: '/mnt/native/home' });
    expect(env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/mnt/native/home', CLAUDE_CONFIG_DIR: '/mnt/native/home/.claude', DISABLE_AUTOUPDATER: '1' });
  });

  it.skipIf(process.platform === 'win32')('rejects external, symlinked or widened mounts and network access', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-policy-'));
    try {
      const work = fs.realpathSync(dir);
      const job = `${work}/job`;
      fs.mkdirSync(job);
      const c = { workerUid: 1000, workerGid: 1000, workRoot: work };
      const args = ['--rm', '--name', 'test', '--user', '1000:1000', '--network', 'none', '--tmpfs', '/updraft-home:mode=1777', '-e', 'HOME=/updraft-home', '--mount', `type=bind,source=${job},target=${job}`, '--workdir', job, IMAGE, 'claude', '-p'];
      expect(validateRun(args, c).command).toEqual(['claude', '-p']);
      for (const [before, after] of [['none', 'host'], ['1000:1000', '0:0'], ['HOME=/updraft-home', 'ANTHROPIC_API_KEY=secret']]) {
        expect(() => validateRun(args.map((a) => a === before ? after : a), c)).toThrow();
      }
      fs.symlinkSync('/etc', `${work}/escape`);
      const bad = ['--mount', `type=bind,source=${work}/escape,target=${work}/escape`, ...args];
      expect(() => validateRun(bad, c)).toThrow('outside workRoot');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('privileged worker framing', () => {
  it('preserves a UTF-8 prompt when every byte arrives in a separate chunk', async () => {
    const text = 'Implement café 😀 漢字 and keep naïve names intact.';
    async function* chunks() { for (const byte of Buffer.from(text, 'utf8')) yield Buffer.from([byte]); }
    expect(await readPrompt(chunks())).toBe(text);
  });

  it('limits raw prompt bytes without reducing the accepted limit for Unicode', async () => {
    const limit = MAX_FRAME / 4;
    async function* chunks(extra = false) {
      yield Buffer.alloc(limit - 4, 97);
      for (const byte of Buffer.from('😀')) yield Buffer.from([byte]);
      if (extra) yield Buffer.from('a');
    }
    expect(Buffer.byteLength(await readPrompt(chunks()))).toBe(limit);
    await expect(readPrompt(chunks(true))).rejects.toThrow('prototype limit');
  });
  it('parses fragmented messages and rejects oversized and malformed input', () => {
    const stream = new PassThrough();
    const received = [];
    let failures = 0;
    frames(stream, (v) => received.push(v), () => failures++);
    stream.write('{"a":'); stream.write('1}\n{}\n');
    expect(received).toEqual([{ a: 1 }, {}]);
    stream.write('broken\n');
    expect(failures).toBe(1);
    stream.write('a'.repeat(MAX_FRAME + 1));
    expect(failures).toBe(2);
  });
});

describe('native worker endpoint provisioning', () => {
  it('provides the sample application port with only a fixed HTTP probe, never lifecycle controls', async () => {
    expect(PROBE_PORT).toBe(8080);
    const server = createProbeServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await globalThis.fetch(origin);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(await (await globalThis.fetch(origin, { method: 'HEAD' })).text()).toBe('');
      expect((await globalThis.fetch(origin, { method: 'POST' })).status).toBe(405);
      expect((await globalThis.fetch(`${origin}/aws/lambda-microvms/runtime/v1/run`, { method: 'POST', body: '{}' })).status).toBe(404);
      // Contact the included real listener for the valid-token leg. Gateway denial remains
      // simulated here; a 401 on the permitted leg must still fail the provisioning proof.
      await verifyHookPort('https://worker.example/', 'scoped-token', PROBE_PORT, async (_url, options) =>
        options.headers['X-aws-proxy-port'] === String(PROBE_PORT) ? globalThis.fetch(origin) : { status: 403 });
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it('issues tokens only for explicit non-lifecycle ports', () => {
    expect(tokenArgs('mvm-test-123', [{ port: 8080 }])).toContain('[{"port":8080}]');
    for (const ports of [[], [{ allPorts: {} }], [{ range: { startPort: 8999, endPort: 9001 } }], [{ port: 9000 }], [{ port: 8080, allPorts: {} }], [{ port: '8080' }]]) {
      expect(() => endpointPorts(ports)).toThrow();
    }
  });

  it('requires permitted-port access and then gateway denial of the privileged hook', async () => {
    const calls = [];
    const probe = async (url, options) => {
      calls.push({ url, options });
      return new globalThis.Response(calls.length === 1 ? '{"ok":true}\n' : '', { status: calls.length === 1 ? 200 : 403 });
    };
    await verifyHookPort('https://worker.example/', 'endpoint-token', 8080, probe);
    expect(calls[0].options.headers['X-aws-proxy-port']).toBe('8080');
    expect(calls[1].options.headers['X-aws-proxy-port']).toBe('9000');
    expect(calls[1].options.body).toBe('{}');
    await expect(verifyHookPort('https://worker.example/', 'bad-token', 8080, async () => ({ status: 401 }))).rejects.toThrow('permitted');
    let count = 0;
    await expect(verifyHookPort('https://worker.example/', 'endpoint-token', 8080, async () => {
      const status = ++count === 1 ? 200 : 503;
      return new globalThis.Response(status === 200 ? '{"ok":true}' : '', { status });
    })).rejects.toThrow('reachable');
  });

  it.each([404, 405, 429, 401, 403, 500])('rejects HTTP %i before attempting hook-port verification', async (status) => {
    let calls = 0;
    await expect(verifyHookPort('https://worker.example/', 'endpoint-token', 8080, async () => {
      calls++;
      return new globalThis.Response('{"ok":true}', { status });
    })).rejects.toThrow('permitted');
    expect(calls).toBe(1);
  });

  it.each(['<html>error</html>', 'not json', 'null', '[]', '{"ok":false}', '{"ok":"true"}', '{}', '{"ok":true,"other":1}', ' '.repeat(129)])(
    'rejects an incorrect or oversized HTTP 200 probe body: %s', async (body) => {
      let calls = 0;
      await expect(verifyHookPort('https://worker.example/', 'endpoint-token', 8080, async () => {
        calls++;
        return new globalThis.Response(body, { status: 200 });
      })).rejects.toThrow('probe response');
      expect(calls).toBe(1);
    },
  );
});
