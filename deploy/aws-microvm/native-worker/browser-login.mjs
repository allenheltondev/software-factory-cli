import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeEnv, loadConfig } from './policy.mjs';
import { identityCommand } from './service.mjs';

export const LOGIN_PORT = 8081;
const LIMIT = 65536;
const TIMEOUT = 5 * 60_000;
const args = ['--restricted', '--setting-sources', '', 'auth'];

export function loginUrl(output) {
  for (const candidate of output.match(/https:\/\/[^\s\x1b]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.origin === 'https://claude.ai' && !url.username && !url.password && url.pathname === '/oauth/authorize') return url.href;
    } catch { /* only complete, official links are accepted */ }
  }
}

export function attachLogin(socket, config, checkAuth, launch = spawn) {
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
    if (!sentUrl || !child || sentCode || !/^[!-~]{1,2048}$/.test(code)) { finish('failed'); return; }
    sentCode = true;
    child.stdin.end(code + '\n');
  });
  void (async () => {
    const status = await checkAuth();
    if (closed) return;
    if (status === 'connected') { finish('connected'); return; }
    if (!['login_required', 'expired'].includes(status)) { finish('failed'); return; }
    child = launch(config.claude, [...args, 'login', '--claudeai'], { cwd: '/', env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => finish('failed'));
    child.once('error', () => finish('failed'));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
      bytes += data.length;
      if (bytes > LIMIT) { finish('failed'); return; }
      if (sentUrl || closed) return;
      output += data.toString('utf8');
      if (!output.includes('Paste code')) return;
      const url = loginUrl(output);
      output = '';
      if (!url) { finish('failed'); return; }
      sentUrl = true;
      send({ url });
    });
    child.once('close', (code) => {
      if (closed) return;
      child = undefined;
      void checkAuth().then((status) => finish(code === 0 && status === 'connected' ? 'connected' : 'failed'), () => finish('failed'));
    });
  })().catch(() => finish('failed'));
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
      execFile(config.claude, [...args, 'status'], { cwd: '/', env, timeout: 10000, maxBuffer: LIMIT },
        (error, stdout) => resolve(nativeClaudeAuthFromStatus({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout }, env).state));
    });
  }
  const httpServer = http.createServer((_req, res) => res.writeHead(404).end());
  const ws = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  let active = false;
  httpServer.on('upgrade', (req, socket, head) => {
    // The only browser client is an opaque-origin sandbox in Updraft. AWS first
    // authenticates the connection with its short-lived, port-scoped token.
    if (active || req.url !== '/claude-login' || req.headers.origin !== 'null' || req.headers['sec-websocket-protocol']) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) => {
      active = true;
      client.once('close', () => { active = false; });
      attachLogin(client, config, checkAuth);
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
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run(loadConfig('/etc/updraft-native-worker.json'));
}
