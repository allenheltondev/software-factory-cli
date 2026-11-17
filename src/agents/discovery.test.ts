import { describe, expect, it } from 'vitest';
import {
  checkPlatform,
  commonInstallDirs,
  discoverAgents,
  parseCmdShim,
  parseVersion,
  runProcess,
  type AgentReport,
  type DiscoveryProbes,
  type ProcessResult,
} from './discovery.js';

// Real npm cmd-shim output (current format), as installed under %APPDATA%\npm.
const NATIVE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');

const NODE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

// Older cmd-shim format.
const LEGACY_SHIM = [
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\kiro\\cli.js" %*',
  ') ELSE (',
  '  @SETLOCAL',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\node_modules\\kiro\\cli.js" %*',
  ')',
].join('\r\n');

type Responder = (file: string, args: string[]) => ProcessResult | undefined;

const ok = (stdout: string, stderr = ''): ProcessResult => ({ code: 0, stdout, stderr });

/** Fake machine: a set of executable files (with optional contents) and scripted process results. */
function machine(o: {
  platform: NodeJS.Platform;
  arch?: string;
  osRelease?: string;
  glibcVersion?: string | null;
  env?: NodeJS.ProcessEnv;
  homedir: string;
  execPath?: string;
  files: Record<string, string | true>;
  respond?: Responder;
}): DiscoveryProbes & { calls: Array<{ file: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  return {
    calls,
    platform: o.platform,
    arch: o.arch ?? 'x64',
    osRelease: o.osRelease ?? (o.platform === 'win32' ? '10.0.26100' : o.platform === 'darwin' ? '24.1.0' : '6.8.0'),
    glibcVersion: o.glibcVersion === undefined ? (o.platform === 'linux' ? '2.39' : null) : o.glibcVersion,
    env: o.env ?? {},
    homedir: o.homedir,
    execPath: o.execPath ?? (o.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node'),
    isExecutable: (p) => p in o.files,
    readFile: (p) => {
      const f = o.files[p];
      return typeof f === 'string' ? f : f ? '' : null;
    },
    run: async (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd });
      if (file.toLowerCase().endsWith('.cmd') || file.toLowerCase().endsWith('.bat')) {
        return { code: null, stdout: '', stderr: '', error: 'spawn EINVAL' };
      }
      return o.respond?.(file, args) ?? { code: null, stdout: '', stderr: '', error: `spawn ${file} ENOENT` };
    },
  };
}

const byAdapter = (rs: AgentReport[], a: string) => rs.find((r) => r.adapter === a)!;

describe('parseCmdShim', () => {
  const shim = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\tool.cmd';
  it('follows a native-binary shim to the .exe (paths with spaces)', () => {
    expect(parseCmdShim(NATIVE_SHIM, shim)).toEqual({
      kind: 'exe',
      file: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    });
  });

  it('follows a Node shim to its script, preferring a node.exe beside the shim', () => {
    expect(parseCmdShim(NODE_SHIM, shim)).toEqual({
      kind: 'script',
      interpreters: ['C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node.exe', 'node'],
      script: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    });
  });

  it('handles the legacy %~dp0 format and rejects unrelated scripts', () => {
    expect(parseCmdShim(LEGACY_SHIM, 'C:\\npm\\kiro-cli.cmd')).toEqual({
      kind: 'script',
      interpreters: ['C:\\npm\\node.exe', 'node'],
      script: 'C:\\npm\\node_modules\\kiro\\cli.js',
    });
    expect(parseCmdShim('@echo off\r\necho hi\r\n', 'C:\\x.cmd')).toBeNull();
    expect(parseCmdShim('@"C:\\elsewhere\\tool.exe" %*', 'C:\\x.cmd')).toBeNull();
  });
});

describe('discoverAgents on Windows', () => {
  const npm = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm';
  const nodeDir = 'C:\\Program Files\\nodejs';
  const claudeExe = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const codexJs = `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const base = () =>
    machine({
      platform: 'win32',
      homedir: 'C:\\Users\\Jane Doe',
      env: { Path: `C:\\Windows\\system32;"${nodeDir}";${npm}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', APPDATA: 'C:\\Users\\Jane Doe\\AppData\\Roaming' },
      files: {
        [`${npm}\\claude.cmd`]: NATIVE_SHIM,
        [`${npm}\\codex.cmd`]: NODE_SHIM,
        [claudeExe]: true,
        [codexJs]: true,
        [`${nodeDir}\\node.exe`]: true,
      },
      respond: (file, args) => {
        const a = args.join(' ');
        if (file === claudeExe && a === '--version') return ok('2.1.289 (Claude Code)\n');
        if (file === claudeExe && a === 'auth status') return ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'secret@example.com' }));
        if (file === `${nodeDir}\\node.exe` && a === `${codexJs} --version`) return ok('codex-cli 0.104.0\n');
        if (file === `${nodeDir}\\node.exe` && a === `${codexJs} login status`) return ok('', 'Logged in using ChatGPT\n');
        return undefined;
      },
    });

  it('finds npm shims, resolves them to direct spawn targets, and reports Kiro missing', async () => {
    const m = base();
    const rs = await discoverAgents(m);
    expect(rs.map((r) => r.adapter)).toEqual(['codex', 'claude', 'kiro']);

    const claude = byAdapter(rs, 'claude');
    expect(claude).toMatchObject({
      installed: true,
      path: `${npm}\\claude.cmd`,
      onPath: true,
      launch: { file: claudeExe, args: [] },
      runnable: 'yes',
      version: '2.1.289',
      signedIn: 'yes',
      auth: 'claude.ai',
      platform: { supported: 'yes' },
      usable: true,
    });
    expect(JSON.stringify(claude)).not.toContain('secret@example.com');

    const codex = byAdapter(rs, 'codex');
    expect(codex).toMatchObject({
      path: `${npm}\\codex.cmd`,
      launch: { file: `${nodeDir}\\node.exe`, args: [codexJs] },
      version: '0.104.0',
      signedIn: 'yes',
      auth: 'Logged in using ChatGPT',
      usable: true,
    });

    const kiro = byAdapter(rs, 'kiro');
    expect(kiro).toMatchObject({ installed: false, runnable: 'no', signedIn: 'no', usable: false });
    expect(kiro.notes.join()).toMatch(/kiro-cli not found/);

    // Never spawns a .cmd, never sends a prompt.
    expect(m.calls.every((c) => !/\.cmd$/i.test(c.file))).toBe(true);
    expect(m.calls.map((c) => c.args.at(-1))).not.toContain(expect.stringMatching(/Reply/));
  });

  it('uses a node.exe beside the shim, then falls back to the running Node', async () => {
    const m = base();
    m.isExecutable = (p) => p !== `${nodeDir}\\node.exe` && [`${npm}\\claude.cmd`, `${npm}\\codex.cmd`, claudeExe, codexJs].includes(p);
    m.execPath = 'D:\\portable node\\node.exe';
    const rs = await discoverAgents(m, { adapters: ['codex'] });
    expect(rs[0]?.launch).toEqual({ file: 'D:\\portable node\\node.exe', args: [codexJs] });

    const withLocal = base();
    const files = new Set([`${npm}\\codex.cmd`, `${npm}\\node.exe`, codexJs, `${nodeDir}\\node.exe`]);
    withLocal.isExecutable = (p) => files.has(p);
    const r2 = await discoverAgents(withLocal, { adapters: ['codex'] });
    expect(r2[0]?.launch).toEqual({ file: `${npm}\\node.exe`, args: [codexJs] });
  });

  it('flags a shim whose target is gone, or a .cmd that is not an npm shim, as not runnable', async () => {
    const m = base();
    m.isExecutable = (p) => p === `${npm}\\claude.cmd` || p === `${npm}\\codex.cmd`;
    m.readFile = (p) => (p.endsWith('claude.cmd') ? NATIVE_SHIM : p.endsWith('codex.cmd') ? '@echo off\r\necho custom wrapper\r\n' : null);
    const rs = await discoverAgents(m, { adapters: ['claude', 'codex'] });
    expect(byAdapter(rs, 'claude')).toMatchObject({ installed: true, launch: null, runnable: 'no', usable: false, signedIn: 'unknown' });
    expect(byAdapter(rs, 'claude').notes.join()).toMatch(/points to a missing file/);
    expect(byAdapter(rs, 'codex').notes.join()).toMatch(/cannot run without a shell/);
    expect(m.calls).toEqual([]);
  });

  it('finds a native install under WinGet Links or ~/.local/bin that is not on PATH', async () => {
    const winget = 'C:\\Users\\Jane Doe\\AppData\\Local\\Microsoft\\WinGet\\Links\\kiro-cli.exe';
    const local = 'C:\\Users\\Jane Doe\\.local\\bin\\claude.exe';
    const m = machine({
      platform: 'win32',
      homedir: 'C:\\Users\\Jane Doe',
      env: { PATH: 'C:\\Windows\\system32', LOCALAPPDATA: 'C:\\Users\\Jane Doe\\AppData\\Local', KIRO_API_KEY: 'k' },
      files: { [winget]: true, [local]: true },
      respond: (file, args) => (args[0] === '--version' ? ok(`${file.includes('kiro') ? 'kiro-cli 1.20.0' : '2.0.0 (Claude Code)'}\n`) : undefined),
    });
    const rs = await discoverAgents(m, { adapters: ['kiro', 'claude'] });
    const kiro = byAdapter(rs, 'kiro');
    expect(kiro).toMatchObject({ path: winget, onPath: false, launch: { file: winget, args: [] }, version: '1.20.0', signedIn: 'yes' });
    expect(kiro.notes.join()).toMatch(/found outside PATH; add C:\\Users\\Jane Doe\\AppData\\Local\\Microsoft\\WinGet\\Links/);
    // Windows 11+, but Kiro does not document CPU architectures: unknown, still usable.
    expect(kiro.platform.supported).toBe('unknown');
    expect(kiro.usable).toBe(true);
    // claude's auth status failed to spawn: unknown, not "no".
    expect(byAdapter(rs, 'claude')).toMatchObject({ path: local, onPath: false, signedIn: 'unknown', usable: true });
  });
});

describe('discoverAgents on macOS and Linux', () => {
  it('finds Homebrew installs off PATH on macOS', async () => {
    const m = machine({
      platform: 'darwin',
      arch: 'arm64',
      homedir: '/Users/jane',
      env: { PATH: '/usr/bin:/bin' },
      files: { '/opt/homebrew/bin/codex': true },
      respond: (_f, args) => (args[0] === '--version' ? ok('codex-cli 0.104.0\n') : { code: 1, stdout: '', stderr: 'Not logged in\n' }),
    });
    const [codex] = await discoverAgents(m, { adapters: ['codex'] });
    expect(codex).toMatchObject({ path: '/opt/homebrew/bin/codex', onPath: false, version: '0.104.0', signedIn: 'no', usable: false });
    expect(codex?.auth).toMatch(/codex login/);
  });

  it('finds ~/.local/bin and npm-prefix installs under a home path with spaces on Linux', async () => {
    const m = machine({
      platform: 'linux',
      homedir: '/home/jane doe',
      env: { PATH: '/usr/bin', npm_config_prefix: '/opt/my npm' },
      files: { '/home/jane doe/.local/bin/claude': true, '/opt/my npm/bin/codex': true },
      respond: (file, args) => {
        if (args[0] === '--version') return ok('1.2.3\n');
        if (file.endsWith('claude')) return { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), stderr: '' };
        return undefined;
      },
    });
    const rs = await discoverAgents(m, { adapters: ['claude', 'codex'] });
    expect(byAdapter(rs, 'claude')).toMatchObject({ path: '/home/jane doe/.local/bin/claude', launch: { file: '/home/jane doe/.local/bin/claude', args: [] }, signedIn: 'no', usable: false });
    expect(byAdapter(rs, 'codex')).toMatchObject({ path: '/opt/my npm/bin/codex', signedIn: 'unknown', usable: true });
  });

  it('lists install dirs per OS', () => {
    const base = { env: {}, execPath: '/usr/local/bin/node' };
    expect(commonInstallDirs({ ...base, platform: 'darwin', homedir: '/Users/j' })).toEqual(
      expect.arrayContaining(['/usr/local/bin', '/Users/j/.npm-global/bin', '/Users/j/.local/bin', '/opt/homebrew/bin']),
    );
    expect(commonInstallDirs({ ...base, platform: 'linux', homedir: '/home/j' })).toContain('/home/linuxbrew/.linuxbrew/bin');
    expect(commonInstallDirs({ platform: 'win32', homedir: 'C:\\Users\\j', env: {}, execPath: 'C:\\node\\node.exe' })).toEqual([
      'C:\\Users\\j\\AppData\\Roaming\\npm',
      'C:\\node',
      'C:\\Users\\j\\.local\\bin',
      'C:\\Users\\j\\AppData\\Local\\Microsoft\\WinGet\\Links',
    ]);
  });
});

describe('sign-in checks', () => {
  const linux = (respond: Responder, env: NodeJS.ProcessEnv = {}) =>
    machine({
      platform: 'linux',
      homedir: '/home/j',
      env: { PATH: '/usr/bin', ...env },
      files: { '/usr/bin/claude': true, '/usr/bin/codex': true, '/usr/bin/kiro-cli': true },
      respond: (f, a) => (a[0] === '--version' ? ok('1.0.0\n') : respond(f, a)),
    });

  it('claude: api-key auth is reported with its source; an old CLI without "auth status" is unknown', async () => {
    const [r] = await discoverAgents(
      linux(() => ok(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }))),
      { adapters: ['claude'] },
    );
    expect(r).toMatchObject({ signedIn: 'yes', auth: 'api_key via ANTHROPIC_API_KEY' });
    const [old] = await discoverAgents(linux(() => ({ code: 1, stdout: '', stderr: "error: unknown command 'auth'\n" })), { adapters: ['claude'] });
    expect(old).toMatchObject({ signedIn: 'unknown', usable: true });
    expect(old?.notes.join()).toMatch(/unknown command 'auth'/);
  });

  it('codex: CODEX_API_KEY counts for codex exec even when login status says not logged in', async () => {
    const notLogged: Responder = () => ({ code: 1, stdout: '', stderr: 'Not logged in\n' });
    const [r] = await discoverAgents(linux(notLogged, { CODEX_API_KEY: 'k' }), { adapters: ['codex'] });
    expect(r).toMatchObject({ signedIn: 'yes', auth: 'CODEX_API_KEY (codex exec only)' });
  });

  it('kiro: KIRO_API_KEY presence, without running the CLI for auth', async () => {
    const m = linux(() => undefined, { KIRO_API_KEY: 'k' });
    const [r] = await discoverAgents(m, { adapters: ['kiro'] });
    expect(r).toMatchObject({ signedIn: 'yes', usable: true });
    expect(m.calls.map((c) => c.args)).toEqual([['--version']]);
    const [none] = await discoverAgents(linux(() => undefined), { adapters: ['kiro'] });
    expect(none).toMatchObject({ signedIn: 'no', usable: false });
  });

  it('skips auth when --version fails or times out', async () => {
    const m = machine({
      platform: 'linux',
      homedir: '/home/j',
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/claude': true },
      respond: () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
    });
    const [r] = await discoverAgents(m, { adapters: ['claude'] });
    expect(r).toMatchObject({ installed: true, runnable: 'no', signedIn: 'unknown', usable: false });
    expect(r?.notes.join()).toMatch(/timed out/);
    expect(m.calls).toHaveLength(1);
  });
});

describe('deep check', () => {
  const m = (deepCode: number) =>
    machine({
      platform: 'linux',
      homedir: '/home/j',
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/claude': true },
      respond: (_f, a) =>
        a[0] === '--version'
          ? ok('2.1.0\n')
          : a[0] === 'auth'
            ? ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
            : { code: deepCode, stdout: '', stderr: deepCode ? 'Invalid API key\n' : '' },
    });

  it('sends one trivial headless prompt only when asked', async () => {
    const quiet = m(0);
    await discoverAgents(quiet, { adapters: ['claude'] });
    expect(quiet.calls.some((c) => c.args.includes('-p'))).toBe(false);

    const deep = m(0);
    const [r] = await discoverAgents(deep, { adapters: ['claude'], deep: true });
    const call = deep.calls.find((c) => c.args.includes('-p'))!;
    expect(call.args).toEqual(['-p', expect.stringMatching(/OK/), '--max-turns', '1', '--output-format', 'json']);
    expect(call.cwd).toBeTruthy();
    expect(r?.deep).toEqual({ ok: true, detail: 'headless prompt succeeded' });
  });

  it('marks the agent unusable when the prompt fails', async () => {
    const [r] = await discoverAgents(m(1), { adapters: ['claude'], deep: true });
    expect(r).toMatchObject({ usable: false, deep: { ok: false, detail: 'Invalid API key' } });
  });
});

describe('checkPlatform and helpers', () => {
  const kiro = { os: { win32: { label: 'Windows 11', minWindowsBuild: 22000 }, linux: { label: 'Linux', minGlibc: '2.34' } }, arch: null, source: 's' };
  const claude = { os: { darwin: { label: 'macOS 13+', minDarwinMajor: 22 } }, arch: ['x64', 'arm64'], source: 's' };
  const p = (platform: NodeJS.Platform, arch: string, osRelease: string, glibcVersion: string | null = null) => ({ platform, arch, osRelease, glibcVersion });

  it('checks OS, minimum OS version, glibc and CPU separately', () => {
    expect(checkPlatform(kiro, p('win32', 'x64', '10.0.19045')).supported).toBe('no');
    expect(checkPlatform(kiro, p('win32', 'x64', '10.0.26100')).supported).toBe('unknown');
    expect(checkPlatform(kiro, p('linux', 'x64', '6.1.0', '2.31')).detail).toMatch(/glibc 2\.34\+/);
    expect(checkPlatform(kiro, p('linux', 'arm64', '6.1.0', null)).supported).toBe('unknown');
    expect(checkPlatform(kiro, p('darwin', 'arm64', '24.0.0')).supported).toBe('no');
    expect(checkPlatform(claude, p('darwin', 'arm64', '21.6.0')).supported).toBe('no');
    expect(checkPlatform(claude, p('darwin', 'arm64', '23.4.0')).supported).toBe('yes');
    expect(checkPlatform(claude, p('darwin', 'ia32', '23.4.0'))).toMatchObject({ supported: 'no', detail: expect.stringMatching(/ia32/) });
  });

  it('parses versions from common --version formats', () => {
    expect(parseVersion('2.1.289 (Claude Code)\n')).toBe('2.1.289');
    expect(parseVersion('codex-cli 0.104.0\n')).toBe('0.104.0');
    expect(parseVersion('kiro-cli 1.20.0-beta.1')).toBe('1.20.0-beta.1');
    expect(parseVersion('dev build')).toBe('dev build');
    expect(parseVersion('')).toBeNull();
  });

  it('reports an unknown adapter without probing', async () => {
    const m = machine({ platform: 'linux', homedir: '/h', files: {} });
    const [r] = await discoverAgents(m, { adapters: ['gemini'] });
    expect(r).toMatchObject({ installed: false, usable: false, notes: [expect.stringMatching(/not a known adapter/)] });
    expect(m.calls).toEqual([]);
  });
});

describe('runProcess (real child processes)', () => {
  const node = process.execPath;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitDead = async (pid: number, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !alive(pid);
  };
  const pidFrom = (s: string) => Number(s.match(/pid (\d+)/)?.[1] ?? NaN);

  it('returns output and exit code, and reports spawn errors', async () => {
    const r = await runProcess(node, ['-e', 'process.stdout.write("hi"); process.stderr.write("err"); process.exitCode = 3'], { timeoutMs: 10_000 });
    expect(r).toEqual({ code: 3, stdout: 'hi', stderr: 'err' });
    const missing = await runProcess('/definitely/not/here/tool', [], { timeoutMs: 10_000 });
    expect(missing).toMatchObject({ code: null, error: expect.stringMatching(/ENOENT/) });
  });

  it('settles shortly after exit when a grandchild keeps stdout open', async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: ["ignore", "inherit", "inherit"] });',
      'process.stdout.write("grandchild pid " + g.pid + "\\n");',
      'g.unref();',
    ].join('\n');
    const start = Date.now();
    const r = await runProcess(node, ['-e', script], { timeoutMs: 10_000 });
    const elapsed = Date.now() - start;
    const pid = pidFrom(r.stdout);
    try {
      expect(r).toMatchObject({ code: 0, stdout: expect.stringMatching(/grandchild pid \d+/) });
      expect(r.timedOut).toBeUndefined();
      // Well under the grandchild's 5s lifetime: settled on exit + drain, not on close.
      expect(elapsed).toBeLessThan(3000);
    } finally {
      if (pid && alive(pid)) process.kill(pid);
    }
  });

  it('settles at the timeout and kills the whole tree when child and grandchild keep running', async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: ["ignore", "inherit", "inherit"] });',
      'process.stdout.write("grandchild pid " + g.pid + "\\n");',
      'setTimeout(() => {}, 10000);',
    ].join('\n');
    const start = Date.now();
    const r = await runProcess(node, ['-e', script], { timeoutMs: 600, killGraceMs: 200 });
    const elapsed = Date.now() - start;
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(elapsed).toBeLessThan(600 + 1000);
    const pid = pidFrom(r.stdout);
    if (pid) {
      const dead = await waitDead(pid, 5000);
      if (!dead) process.kill(pid);
      expect(dead).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32')('settles at the timeout and SIGKILLs a child that ignores SIGTERM', async () => {
    const script = 'process.on("SIGTERM", () => {}); process.stdout.write("pid " + process.pid + "\\n"); setInterval(() => {}, 1000);';
    const start = Date.now();
    const r = await runProcess(node, ['-e', script], { timeoutMs: 150, killGraceMs: 200 });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(r).toMatchObject({ code: null, timedOut: true });
    const pid = pidFrom(r.stdout);
    if (pid) expect(await waitDead(pid, 3000)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'SIGKILLs a SIGTERM-ignoring grandchild even after its parent exits on SIGTERM',
    async () => {
      const grandchild = 'process.on("SIGTERM", () => {}); process.stdout.write("grandchild pid " + process.pid + " ready\\n"); setInterval(() => {}, 1000);';
      const parent = [
        'const { spawn } = require("node:child_process");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit"] });`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const start = Date.now();
      const r = await runProcess(node, ['-e', parent], { timeoutMs: 800, killGraceMs: 200 });
      expect(Date.now() - start).toBeLessThan(800 + 1000);
      expect(r).toMatchObject({ code: null, timedOut: true, stdout: expect.stringMatching(/grandchild pid \d+ ready/) });
      const pid = pidFrom(r.stdout);
      const dead = await waitDead(pid, 200 + 3000);
      if (!dead) process.kill(pid, 'SIGKILL');
      expect(dead).toBe(true);
    },
  );
});
