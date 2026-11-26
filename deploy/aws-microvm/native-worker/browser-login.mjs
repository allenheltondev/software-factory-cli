import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeEnv, codexEnv, loadConfig, CODEX_LOGIN_PINS } from './policy.mjs';
import { identityCommand } from './service.mjs';

export const LOGIN_PORT = 8081;
const LIMIT = 65536;
const TIMEOUT = 5 * 60_000;
const AUTH_STATUS_TIMEOUT = 30_000;
const args = ['--restricted', '--setting-sources', '', 'auth'];
/** Codex device codes expire after 15 minutes (codex-rs/login/src/device_code_auth.rs). */
const CODEX_TIMEOUT = 15 * 60_000;
/** The official CLI keeps its ChatGPT login in CODEX_HOME/auth.json, never a keyring, on this worker. */
const CODEX_LOGIN = [...CODEX_LOGIN_PINS, 'login'];

export function loginUrl(output) {
  for (const candidate of output.match(/https:\/\/[^\s\x1b]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.origin === 'https://claude.ai' && !url.username && !url.password && url.pathname === '/oauth/authorize') return url.href;
    } catch { /* only complete, official links are accepted */ }
  }
}

/**
 * The verification page and one-time code that the official `codex login --device-auth` prints
 * (codex-rs/login/src/device_code_auth.rs: "Open this link ... https://auth.openai.com/codex/device"
 * then "Enter this one-time code"). Only that exact page and a plain code are accepted; the CLI
 * itself then polls OpenAI and stores the login. Nothing here can complete the sign-in: the
 * person must open the page, sign in to ChatGPT and type the code.
 */
const ANSI = /\x1b\[[0-9;]*m/g;
export function codexDeviceCode(output) {
  const lines = output.replace(ANSI, '').split(/\r?\n/).map((line) => line.trim());
  const at = lines.findIndex((line) => /^2\. Enter this one-time code\b/.test(line));
  if (at < 0) return undefined;
  const userCode = lines.slice(at + 1).find(Boolean);
  if (!userCode || !/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,2}$/.test(userCode)) return undefined;
  for (const candidate of lines.slice(0, at).join('\n').match(/https:\/\/[^\s]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.origin === 'https://auth.openai.com' && url.pathname === '/codex/device' && !url.search && !url.hash && !url.username && !url.password) {
        return { verificationUrl: url.href, userCode };
      }
    } catch { /* only complete, official links are accepted */ }
  }
  return undefined;
}

/**
 * Codex sign-in for the private panel: the official CLI's own device-code flow. The panel shows
 * the page and the code; the browser never sends anything back (any message ends the attempt).
 * The CLI exchanges and stores the tokens itself in its CODEX_HOME; none pass through here.
 */
export function attachCodexLogin(socket, config, checkAuth, launch = spawn, report = () => {}) {
  let child;
  let sent = false;
  let output = '';
  let bytes = 0;
  let closed = false;
  const send = (message) => { if (!closed && socket.readyState === 1) socket.send(JSON.stringify(message)); };
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
    socket.close();
  }
  function finish(status) {
    send({ status });
    close();
  }
  const timer = setTimeout(() => finish('expired'), CODEX_TIMEOUT);
  socket.once('close', close);
  socket.once('error', close);
  socket.on('message', () => { report('codex_unexpected_input'); finish('failed'); });
  void (async () => {
    const status = await checkAuth();
    if (closed) return;
    if (status === 'connected') { finish('connected'); return; }
    if (status !== 'login_required') { report('codex_auth_status_' + status); finish('failed'); return; }
    child = launch(config.codex, [...CODEX_LOGIN, '--device-auth'], { cwd: '/', env: { ...codexEnv(config), BROWSER: '/bin/false' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', () => { report('codex_launch_error'); finish('failed'); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
      bytes += data.length;
      if (bytes > LIMIT) { report('codex_output_limit'); finish('failed'); return; }
      if (sent || closed) return;
      output += data.toString('utf8');
      const code = codexDeviceCode(output);
      if (!code) return;
      output = '';
      sent = true;
      send(code);
    });
    child.once('close', (code) => {
      if (closed) return;
      child = undefined;
      if (!sent) report(`codex_exited_before_code_${code ?? 'signal'}`);
      void checkAuth().then((state) => finish(code === 0 && state === 'connected' ? 'connected' : 'failed'), () => finish('failed'));
    });
  })().catch(() => { report('codex_login_unavailable'); finish('failed'); });
  return close;
}

export function attachLogin(socket, config, checkAuth, launch = spawn, report = () => {}) {
  let child;
  let sentUrl = false;
  let sentCode = false;
  let output = '';
  let bytes = 0;
  let closed = false;
  const env = { ...claudeEnv(config), BROWSER: '/bin/false' };
  const send = (message) => { if (!closed && socket.readyState === 1) socket.send(JSON.stringify(message)); };
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
    socket.close();
  }
  function finish(status) {
    send({ status });
    close();
  }
  const timer = setTimeout(() => finish('expired'), TIMEOUT);
  socket.once('close', close);
  socket.once('error', close);
  socket.on('message', (data, binary) => {
    const code = binary ? '' : data.toString();
    if (!sentUrl || !child || sentCode || !/^[!-~]{1,2048}$/.test(code)) { report('invalid_input'); finish('failed'); return; }
    sentCode = true;
    child.stdin.end(code + '\n');
  });
  void (async () => {
    const status = await checkAuth();
    if (closed) return;
    if (status === 'connected') { finish('connected'); return; }
    if (!['login_required', 'expired'].includes(status)) { report('auth_status_' + status); finish('failed'); return; }
    child = launch(config.claude, [...args, 'login', '--claudeai'], { cwd: '/', env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => { report('cli_input_error'); finish('failed'); });
    child.once('error', () => { report('cli_launch_error'); finish('failed'); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
      bytes += data.length;
      if (bytes > LIMIT) { report('cli_output_limit'); finish('failed'); return; }
      if (sentUrl || closed) return;
      output += data.toString('utf8');
      if (!output.includes('Paste code')) return;
      const url = loginUrl(output);
      output = '';
      if (!url) { report('cli_authorize_url_missing'); finish('failed'); return; }
      sentUrl = true;
      send({ url });
    });
    child.once('close', (code) => {
      if (closed) return;
      child = undefined;
      if (!sentUrl) report(`cli_exited_before_prompt_${code ?? 'signal'}`);
      void checkAuth().then((status) => finish(code === 0 && status === 'connected' ? 'connected' : 'failed'), () => finish('failed'));
    });
  })().catch(() => { report('login_unavailable'); finish('failed'); });
  return close;
}

async function run(config) {
  if (process.getuid() !== config.claudeUid) throw new Error('incorrect login identity');
  const { WebSocketServer } = await import('ws');
  const { nativeClaudeAuthFromStatus } = await import(pathToFileURL(config.authModule).href);
  async function checkAuth() {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve) => {
      const env = claudeEnv(config);
      execFile(config.claude, [...args, 'status'], { cwd: '/', env, timeout: AUTH_STATUS_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: LIMIT },
        (error, stdout) => {
          const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
          const { state } = nativeClaudeAuthFromStatus({ code, stdout }, env);
          if (state === 'unknown') {
            const outcome = error?.killed ? 'killed'
              : typeof code === 'number' ? `exit_${code}`
                : ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error?.code) ? error.code.toLowerCase() : 'unavailable';
            process.send?.({ loginPhase: `auth_probe_${outcome}_${stdout.length ? 'output' : 'empty'}` });
          }
          resolve(state);
        });
    });
  }
  // Codex sign-in is offered only where the worker config installs the official Codex CLI.
  const codexAuth = config.codex ? await import(pathToFileURL(config.codexAuthModule).href) : undefined;
  async function checkCodexAuth() {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve) => {
      const env = codexEnv(config);
      execFile(config.codex, [...CODEX_LOGIN, 'status'], { cwd: '/', env, timeout: AUTH_STATUS_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: LIMIT },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
          resolve(codexAuth.nativeCodexAuthFromStatus({ code, output: `${stdout}\n${stderr}` }, env).state);
        });
    });
  }
  const httpServer = http.createServer((_req, res) => res.writeHead(404).end());
  const ws = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  let active = false;
  httpServer.on('upgrade', (req, socket, head) => {
    // The only browser client is an opaque-origin sandbox in Updraft. AWS first
    // authenticates the connection with its short-lived, port-scoped token.
    const codexRoute = req.url === '/codex-login' && codexAuth;
    if (active || (req.url !== '/claude-login' && !codexRoute) || req.headers.origin !== 'null' || req.headers['sec-websocket-protocol']) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) => {
      active = true;
      client.once('close', () => { active = false; });
      const report = (phase) => process.send?.({ loginPhase: phase });
      if (codexRoute) attachCodexLogin(client, config, checkCodexAuth, spawn, report);
      else attachLogin(client, config, checkAuth, spawn, report);
    });
  });
  httpServer.listen(LOGIN_PORT, '0.0.0.0', () => process.send?.({ ready: true }));
}

export async function startBrowserLogin(config) {
  const [command, argv] = identityCommand(config.claudeUid, config.claudeGid, process.execPath, [fileURLToPath(import.meta.url)]);
  const child = spawn(command, argv, { cwd: '/', env: claudeEnv(config), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('login listener timed out')), 10000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('login listener exited')));
      child.once('message', (value) => value?.ready === true ? resolve() : reject(new Error('login listener not ready')));
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally { clearTimeout(timer); }
  child.on('message', (value) => {
    if (typeof value?.loginPhase === 'string' && /^[a-z0-9_]{1,60}$/.test(value.loginPhase)) {
      console.error(JSON.stringify({ browserLogin: value.loginPhase }));
    }
  });
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run(loadConfig('/etc/updraft-native-worker.json'));
}
