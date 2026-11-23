// Fixed-response application listener for validating port-scoped endpoint tokens.
// No job controls, filesystem reads, credentials or repository code run in this process.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { identityCommand } from './service.mjs';

export const PROBE_PORT = 8080;

export function createProbeServer() {
  return http.createServer((request, response) => {
    if (request.url !== '/') { response.writeHead(404).end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : '{"ok":true}\n');
  });
}

export async function startProbe(config, port = PROBE_PORT) {
  const [command, args] = identityCommand(config.workerUid, config.workerGid, process.execPath, [fileURLToPath(import.meta.url), String(port)]);
  const child = spawn(command, args, { cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let timer;
  let ready;
  try {
    ready = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('probe listener startup timed out')), 10000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('probe listener exited before readiness')));
      child.once('message', (message) => {
        if (message?.ready !== true || message.uid !== config.workerUid || message.gid !== config.workerGid || !Number.isInteger(message.port) || message.port <= 0 || message.port > 65535 || (port !== 0 && message.port !== port)) {
          reject(new Error('probe listener identity/readiness mismatch'));
        } else resolve(message);
      });
    });
  } catch (error) { child.kill('SIGKILL'); throw error; }
  finally { clearTimeout(timer); }
  return {
    port: ready.port,
    child,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGKILL');
      await ended;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('probe listener must run as an unprivileged Linux account');
  const server = createProbeServer();
  server.listen(Number(process.argv[2] ?? PROBE_PORT), '0.0.0.0', () => {
    process.send?.({ ready: true, uid: process.getuid(), gid: process.getgid(), port: server.address().port });
  });
}
