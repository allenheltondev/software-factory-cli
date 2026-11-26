import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachCodexLogin, attachLogin, codexDeviceCode, loginUrl } from '../native-worker/browser-login.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { IMAGE, TOOL, MAX_FRAME, GIT_IDENTITY, EGRESS_TARGET, CODEX_SERVER, CODEX_TOOL, claudeArgs, claudeEnv, codexArgs, codexEnv, checkCodexEvent, checkInventory, validateRun, resolveRunEnvironment, withEgress, networkNote } from '../native-worker/policy.mjs';
import { parseRunArgs } from '../image/sandbox/updraft-sandbox.mjs';
import { frames, readPrompt } from '../native-worker/protocol.mjs';
import { bootPayload } from '../native-worker/hooks.mjs';
import { endpointPorts, tokenArgs, verifyHookPort } from '../native-worker/endpoint-token.mjs';
import { containInvocation } from '../../../src/worker/container.ts';
import { commitIdentityEnv } from '../../../src/github/credentials.ts';
import { containerSchema } from '../../../src/config/schema.ts';
import { createGitFixture } from '../../../test/git-fixtures.ts';
import { createProbeServer, PROBE_PORT } from '../native-worker/probe.mjs';

describe('disposable worker browser login', () => {
  it('accepts only the official authorization endpoint', () => {
    expect(loginUrl('Continue: https://claude.ai/oauth/authorize?state=sample')).toBe('https://claude.ai/oauth/authorize?state=sample');
    for (const url of ['https://claude.ai.evil.test/oauth/authorize', 'https://claude.ai/setup', 'http://claude.ai/oauth/authorize']) {
      expect(loginUrl(url)).toBeUndefined();
    }
  });

  it('passes a single code only to the official CLI and reports sanitized readiness', async () => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close: vi.fn(), send: vi.fn() });
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough() });
    const launch = vi.fn(() => child);
    const status = vi.fn().mockResolvedValueOnce('login_required').mockResolvedValueOnce('connected');
    const disconnect = attachLogin(socket, { claude: '/trusted/claude', credentialHome: '/private/home' }, status, launch);
    try {
      await vi.waitFor(() => expect(launch).toHaveBeenCalledWith('/trusted/claude',
        ['--restricted', '--setting-sources', '', 'auth', 'login', '--claudeai'], expect.anything()));
      child.stdout.write('unrelated output\nhttps://claude.ai/oauth/authorize?state=sample\nPaste code here if prompted >');
      expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ url: 'https://claude.ai/oauth/authorize?state=sample' }));
      socket.emit('message', Buffer.from('synthetic-code'), false);
      expect(stdin.end).toHaveBeenCalledExactlyOnceWith('synthetic-code\n');
      child.emit('close', 0);
      await vi.waitFor(() => expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ status: 'connected' })));
      expect(socket.close).toHaveBeenCalledOnce();
    } finally { disconnect(); }
  });

  it('does not launch an interactive command after the CLI is connected', async () => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close: vi.fn(), send: vi.fn() });
    const launch = vi.fn();
    attachLogin(socket, { credentialHome: '/private/home' }, async () => 'connected', launch);
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce());
    expect(launch).not.toHaveBeenCalled();
  });
});

// What `codex login --device-auth` prints (codex-rs/login/src/device_code_auth.rs), colors included.
const devicePrompt = (url = 'https://auth.openai.com/codex/device', code = 'ABCD-1234') =>
  `\nWelcome to Codex [v\x1b[90m0.200.0\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94m${url}\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m${code}\x1b[0m\n\n\x1b[90mContinue only if you started this login in Codex.\x1b[0m\n`;

describe('disposable worker Codex sign-in (official device code)', () => {
  it('accepts only the official verification page and a plain one-time code', () => {
    expect(codexDeviceCode(devicePrompt())).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
    for (const text of [
      devicePrompt('https://auth.openai.com.evil.test/codex/device'), devicePrompt('https://auth.openai.com/codex/device?next=https://evil.test'),
      devicePrompt('http://auth.openai.com/codex/device'), devicePrompt('https://auth.openai.com/oauth/authorize'),
      devicePrompt(undefined, 'abcd 1234'), devicePrompt(undefined, '<script>'), devicePrompt().split('2. Enter')[0],
    ]) expect(codexDeviceCode(text)).toBeUndefined();
  });

  it('runs the official device login, shows the page and code, and reports only sanitized status', async () => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close: vi.fn(), send: vi.fn() });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const launch = vi.fn(() => child);
    const status = vi.fn().mockResolvedValueOnce('login_required').mockResolvedValueOnce('connected');
    const disconnect = attachCodexLogin(socket, { codex: '/trusted/codex', credentialHome: '/private/home' }, status, launch);
    try {
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      const [file, args, options] = launch.mock.calls[0];
      expect(file).toBe('/trusted/codex');
      expect(args).toEqual(['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', 'login', '--device-auth']);
      expect(options.env).toEqual({ ...codexEnv({ credentialHome: '/private/home' }), BROWSER: '/bin/false' });
      expect(options.stdio[0]).toBe('ignore'); // nothing from the browser ever reaches the CLI
      const [first, second] = [devicePrompt().slice(0, 200), devicePrompt().slice(200)];
      child.stdout.write(first);
      expect(socket.send).not.toHaveBeenCalled();
      child.stdout.write(second);
      expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }));
      child.stdout.write('Successfully logged in\n');
      child.emit('close', 0);
      await vi.waitFor(() => expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ status: 'connected' })));
      expect(socket.close).toHaveBeenCalledOnce();
    } finally { disconnect(); }
  });

  it('ends the attempt if the browser sends anything, and never starts a login over an API key', async () => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close: vi.fn(), send: vi.fn() });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const report = vi.fn();
    attachCodexLogin(socket, { codex: '/trusted/codex', credentialHome: '/h' }, async () => 'login_required', () => child, report);
    await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBe(1));
    socket.emit('message', Buffer.from('injected'), false);
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ status: 'failed' }));
    expect(report).toHaveBeenCalledWith('codex_unexpected_input');

    const other = Object.assign(new EventEmitter(), { readyState: 1, close: vi.fn(), send: vi.fn() });
    const launch = vi.fn();
    attachCodexLogin(other, { codex: '/trusted/codex', credentialHome: '/h' }, async () => 'wrong_method', launch, report);
    await vi.waitFor(() => expect(other.send).toHaveBeenLastCalledWith(JSON.stringify({ status: 'failed' })));
    expect(launch).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('codex_auth_status_wrong_method');
  });

  it('does not start a login when Codex is already signed in with ChatGPT', async () => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close: vi.fn(), send: vi.fn() });
    const launch = vi.fn();
    attachCodexLogin(socket, { codex: '/trusted/codex', credentialHome: '/h' }, async () => 'connected', launch);
    await vi.waitFor(() => expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ status: 'connected' })));
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('native Codex worker policy', () => {
  const mcp = { command: '/usr/local/bin/node', args: ['/opt/updraft/native-worker/mcp.mjs', '/run/updraft-native/s/codex-x/tools.sock'] };
  const pair = (args, key) => args.find((a, n) => args[n - 1] === '-c' && a.startsWith(`${key}=`));

  it('replaces the bypass default with a restricted, configuration-free, ChatGPT-only launch and one MCP tool', () => {
    const args = codexArgs(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5-codex', '-c', 'model_reasoning_effort="high"',
      '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"'], mcp);
    expect(args.slice(0, 8)).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only']);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    for (const expected of ['approval_policy="never"', 'model_provider="openai"', 'forced_login_method="chatgpt"', 'cli_auth_credentials_store="file"',
      'features.shell_tool=false', 'features.unified_exec=false', 'features.view_image=false', 'web_search="disabled"',
      `mcp_servers.${CODEX_SERVER}.required=true`, `mcp_servers.${CODEX_SERVER}.enabled_tools=["${CODEX_TOOL}"]`]) {
      expect(args[args.indexOf(expected) - 1]).toBe('-c');
    }
    expect(pair(args, `mcp_servers.${CODEX_SERVER}.command`)).toBe(`mcp_servers.${CODEX_SERVER}.command="/usr/local/bin/node"`);
    expect(JSON.parse(pair(args, `mcp_servers.${CODEX_SERVER}.args`).split('=').slice(1).join('='))).toEqual(mcp.args);
    expect(args.filter((a) => a.startsWith('model_provider='))).toEqual(['model_provider="openai"']);
    expect(args.slice(-4)).toEqual(['--model', 'gpt-5-codex', '-c', 'model_reasoning_effort="high"']);
    expect(pair(args, 'developer_instructions')).toContain('Network access is disabled.');
    expect(pair(codexArgs(['exec', '--json'], mcp, { egress: true }), 'developer_instructions')).toContain('limited to package registries');
  });

  it.each([
    [['exec', '--json', '--sandbox', 'danger-full-access']], [['exec', '--json', '-s', 'workspace-write']], [['exec', '--json', '--full-auto']],
    [['exec', '--json', '-c', 'model_provider="azure"']], [['exec', '--json', '-c', 'mcp_servers.evil.command="/bin/sh"']],
    [['exec', '--json', '-c', 'features.shell_tool=true']], [['exec', '--json', '-c', 'model_reasoning_effort=high; rm']],
    [['exec', '--json', '--profile', 'api']], [['exec', '--json', '--add-dir', '/']], [['exec', '--json', '--cd', '/']],
    [['exec', '--json', '--image', '/etc/passwd']], [['exec', '--json', '--model']], [['exec', '--json', '--model', '--oss']],
    [['exec']], [['resume', '--json']], [['exec', '--json', 'resume', '--last']], [['exec', '--json', '--output-schema', '/repo/s.json']],
  ])('refuses caller-controlled capability options: %j', (input) => {
    expect(() => codexArgs(input, mcp)).toThrow();
  });

  it('lets a turn think, talk, plan and call only the isolated tool', () => {
    expect(checkCodexEvent({ type: 'thread.started', thread_id: 't' })).toBe(true);
    for (const event of [{ type: 'turn.started' }, { type: 'turn.completed', usage: {} }, { type: 'turn.failed', error: { message: 'x' } }, { type: 'error', message: 'retrying' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }, { type: 'item.started', item: { type: 'reasoning', text: '' } },
      { type: 'item.updated', item: { type: 'todo_list', items: [] } }, { type: 'item.completed', item: { type: 'error', message: 'x' } },
      { type: 'item.started', item: { type: 'mcp_tool_call', server: CODEX_SERVER, tool: CODEX_TOOL, arguments: {} } }]) {
      expect(checkCodexEvent(event)).toBe(false);
    }
  });

  it.each([
    { type: 'item.started', item: { type: 'command_execution', command: 'cat ~/.codex/auth.json' } },
    { type: 'item.completed', item: { type: 'file_change', changes: [] } },
    { type: 'item.started', item: { type: 'web_search', query: 'x' } },
    { type: 'item.started', item: { type: 'collab_tool_call' } },
    { type: 'item.started', item: { type: 'mcp_tool_call', server: 'other', tool: 'exec' } },
    { type: 'item.started', item: { type: 'mcp_tool_call', server: CODEX_SERVER, tool: 'read_resource' } },
    { type: 'item.started', item: { type: 'image_view' } },
    { type: 'item.started' }, { type: 'session.configured' }, {}, null,
  ])('ends the session on anything else: %j', (event) => {
    expect(() => checkCodexEvent(event)).toThrow(/isolation rejected/);
  });

  it('gives Codex only its private home: no inherited keys, tokens or endpoints', () => {
    expect(codexEnv({ credentialHome: '/mnt/native/home' })).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/mnt/native/home', CODEX_HOME: '/mnt/native/home/.codex' });
  });
});

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
  it.skipIf(process.platform === 'win32')('accepts the base checkout of containInvocation only as the paths it mounts', () => {
    const f = createGitFixture();
    try {
      const worktree = path.join(f.root, 'job');
      f.git(f.clone, 'worktree', 'add', '--quiet', '-b', 'base-check-proof', worktree, 'HEAD');
      const baseDir = path.join(f.root, 'base-checks', 'run', 'base');
      const scratchDir = path.join(f.root, 'base-checks', 'run', 'scratch');
      for (const dir of [baseDir, scratchDir]) fs.mkdirSync(dir, { recursive: true });
      const env = { UPDRAFT_BASE_DIR: baseDir, UPDRAFT_SCRATCH_DIR: scratchDir };
      const wrapped = containInvocation({ invocation: { file: 'claude', args: ['-p'], promptVia: 'stdin' },
        container: containerSchema.parse({ image: IMAGE, network: 'none' }), runtime: '/runtime', runId: 'base-check-proof',
        worktree, promptFile: path.join(f.root, 'prompt.md'), agentEnv: env, user: '1000:1000', baseCheck: { baseDir, scratchDir } });
      const c = { workRoot: fs.realpathSync(f.root), workerUid: 1000, workerGid: 1000 };
      const run = validateRun(resolveRunEnvironment(wrapped.invocation.args, env).slice(1), c);
      expect(run.env.filter((entry) => entry.name.startsWith('UPDRAFT_'))).toEqual([{ name: 'UPDRAFT_BASE_DIR', value: baseDir }, { name: 'UPDRAFT_SCRATCH_DIR', value: scratchDir }]);
      expect(run.mounts.filter((m) => [baseDir, scratchDir].includes(m.target)).map((m) => m.readOnly)).toEqual([true, false]);
      // A value that is not the run's own mount of that kind is refused: no pointing the agent elsewhere.
      for (const other of [{ ...env, UPDRAFT_BASE_DIR: '/etc' }, { ...env, UPDRAFT_BASE_DIR: scratchDir }, { ...env, UPDRAFT_SCRATCH_DIR: baseDir },
        { ...env, UPDRAFT_SCRATCH_DIR: worktree }, { ...env, UPDRAFT_BASE_DIR: 'relative' }, { ...env, UPDRAFT_BASE_DIR: `${baseDir}\nX=1` }]) {
        expect(() => validateRun(resolveRunEnvironment(wrapped.invocation.args, other).slice(1), c)).toThrow();
      }
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
    expect(bootPayload('{"storage":"ephemeral"}')).toEqual({ storage: 'ephemeral' });
    expect(() => bootPayload(JSON.stringify({ ...payload, storage: 'ephemeral' }))).toThrow();
    expect(() => bootPayload('{"storage":"host-directory"}')).toThrow();
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

  it('tells Claude whether registries are reachable, and never to report unrun checks as passing', () => {
    const prompt = (args) => args[args.indexOf('--append-system-prompt') + 1];
    expect(prompt(claudeArgs(['-p', '--output-format', 'stream-json'], '{}'))).toContain('Network access is disabled.');
    const limited = prompt(claudeArgs(['-p', '--output-format', 'stream-json'], '{}', { egress: true }));
    expect(limited).toContain('limited to package registries');
    expect(limited).toContain('never describe unrun checks as passing');
    expect(limited).not.toContain('Network access is disabled');
    expect(networkNote(false)).toBe('Network access is disabled.');
  });

  it('adds registry egress to a sandboxed command without opening the network', () => {
    const runArgs = ['--rm', '--name', 'n', '--user', '1000:1000', '--network', 'none', '--tmpfs', '/updraft-home:mode=1777',
      '-e', 'HOME=/updraft-home', '--mount', 'type=bind,source=/w/job,target=/w/job', '--workdir', '/w/job', IMAGE, 'npm', 'test'];
    const run = parseRunArgs(runArgs);
    const egress = { dir: '/run/updraft-native/sessions-x/egress', shim: '/usr/local/lib/updraft-egress/egress-shim.mjs', node: '/usr/local/bin/node' };
    const wrapped = withEgress(runArgs, run, ['/bin/sh', '-c', 'npm ci'], egress);
    const parsed = parseRunArgs(wrapped);
    expect(parsed.network).toBe('none');
    expect(parsed.mounts).toContainEqual({ source: egress.dir, target: EGRESS_TARGET, readOnly: true });
    expect(parsed.command).toEqual([egress.node, egress.shim, `${EGRESS_TARGET}/proxy.sock`, '--', '/bin/sh', '-c', 'npm ci']);
    expect(withEgress(runArgs, run, run.command, undefined)).toEqual(runArgs);
    expect(() => withEgress(runArgs.map((a) => (a === IMAGE ? 'other' : a)), run, run.command, egress)).toThrow();
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
