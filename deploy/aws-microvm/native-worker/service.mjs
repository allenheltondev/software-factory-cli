// Root supervisor; the official CLI and every repository command run without root.
// Single tenant, one agent at a time. Optional root Cloud dispatch lives in cloud.mjs.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IMAGE, DEFAULT_SOCKET, MAX_FRAME, DEFAULT_TOOL_TIMEOUT_SECONDS, EGRESS_SOCKET, loadConfig, claudeEnv, validateRun, claudeArgs, checkInventory, trustedFile, withEgress, networkNote } from './policy.mjs';
import { createEgressProxy, parseEgressConfig } from '../image/sandbox/egress-proxy.mjs';
import { frames, send } from './protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.resolve(here, '../image/sandbox/updraft-sandbox.mjs');
const egressProxyModule = path.resolve(here, '../image/sandbox/egress-proxy.mjs');

export function identityCommand(uid, gid, file, args) {
  return ['/usr/bin/setpriv', ['--reuid', String(uid), '--regid', String(gid), '--clear-groups', '--no-new-privs', '--pdeathsig', 'SIGKILL', '--', file, ...args]];
}

function startAs(uid, gid, file, args, options) {
  const [command, argv] = identityCommand(uid, gid, file, args);
  return spawn(command, argv, { ...options, detached: true });
}

function kill(child) {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
}

function captureAs(uid, gid, file, args, options, track) {
  const child = track(startAs(uid, gid, file, args, { ...options, stdio: ['ignore', 'pipe', 'ignore'] }));
  return new Promise((resolve) => {
    let stdout = '';
    let invalid = false;
    const timer = setTimeout(() => { invalid = true; kill(child); }, 10000);
    child.stdout.on('data', (data) => {
      if (Buffer.byteLength(stdout) + data.length > 65536) { invalid = true; kill(child); }
      else stdout += data.toString('utf8');
    });
    child.once('error', () => { invalid = true; });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: invalid ? null : code, stdout }); });
  });
}

export function assertEfsMount(c) {
  const type = execFileSync('/usr/bin/findmnt', ['--noheadings', '--output', 'FSTYPE', '--mountpoint', c.credentialHome], { encoding: 'utf8' }).trim();
  if (type !== 'nfs4') throw new Error('credential home must be the mounted EFS access point');
  const parentType = execFileSync('/usr/bin/findmnt', ['--noheadings', '--output', 'FSTYPE', '--target', path.dirname(c.credentialHome)], { encoding: 'utf8' }).trim();
  if (['nfs', 'nfs4'].includes(parentType)) throw new Error('credential mount parent must enforce local permissions');
}

export function assertEphemeralHome(c) {
  const parent = path.dirname(c.credentialHome);
  const mount = execFileSync('/usr/bin/findmnt', ['--noheadings', '--output', 'FSTYPE,OPTIONS', '--mountpoint', parent], { encoding: 'utf8' }).trim();
  const [type, options] = mount.split(/\s+/);
  if (type !== 'tmpfs' || !['nosuid', 'nodev', 'noexec'].every((option) => options?.split(',').includes(option))) {
    throw new Error('disposable Claude home requires a private tmpfs mount');
  }
  const homeMount = execFileSync('/usr/bin/findmnt', ['--noheadings', '--output', 'TARGET', '--target', c.credentialHome], { encoding: 'utf8' }).trim();
  if (homeMount !== parent) throw new Error('unexpected mount inside the disposable Claude home');
}

export async function startService(c, socketPath = DEFAULT_SOCKET, storageProbe = assertEfsMount) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('native worker supervisor requires Linux root');
  process.umask(0o077);
  storageProbe(c);
  for (const file of [process.execPath, '/usr/bin/setpriv', sandbox, ...(c.egress ? [egressProxyModule, c.egress.shim] : []), ...['service.mjs', 'mcp.mjs', 'policy.mjs', 'protocol.mjs'].map((n) => path.join(here, n))]) trustedFile(file);
  const { nativeClaudeAuthFromStatus } = await import(pathToFileURL(c.authModule).href);
  const environment = claudeEnv(c);
  const root = path.dirname(socketPath);
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  fs.chownSync(root, 0, c.workerGid);
  fs.chmodSync(root, 0o711);
  // Never unlink a live service's socket or run two writers against one CLI login.
  if (fs.existsSync(socketPath)) throw new Error('worker socket exists; stop the previous supervisor and remove its stale socket explicitly');
  const scratch = fs.mkdtempSync(`${root}/sessions-`);
  fs.chmodSync(scratch, 0o711);
  const sandboxState = `${scratch}/sandbox`;
  fs.mkdirSync(sandboxState, { mode: 0o700 });
  fs.chownSync(sandboxState, c.workerUid, c.workerGid);
  const children = new Set();
  const clients = new Set();
  const active = new Map();
  const sandboxEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
    UPDRAFT_SANDBOX_CONFIG: c.sandboxConfig, UPDRAFT_SANDBOX_RUNTIME_DIR: sandboxState };
  const track = (child) => { children.add(child); child.once('close', () => children.delete(child)); return child; };
  // Registry egress (#147): a root proxy on a Unix socket in a directory only the job
  // identity's group can traverse. Sandboxed commands keep --network none and reach it
  // through the in-sandbox shim. Claude itself (another identity) cannot open the socket.
  const toolTimeoutMs = (c.toolTimeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * 1000;
  let egress;
  let egressProxy;
  if (c.egress) {
    const policy = parseEgressConfig(c.egress);
    const dir = `${scratch}/egress`;
    fs.mkdirSync(dir, { mode: 0o710 });
    fs.chownSync(dir, 0, c.workerGid);
    fs.chmodSync(dir, 0o710); // the umask above would leave it 0700, closed to the job identity
    egressProxy = createEgressProxy({ rules: policy.rules, limits: policy.limits }, {
      // Decisions only: target, reason and byte counts, never request or payload bytes.
      log: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
    });
    const socketFile = `${dir}/${EGRESS_SOCKET}`;
    try {
      // Linux truncates a longer Unix socket path silently; the shim would then find nothing.
      if (Buffer.byteLength(socketFile) > 100) throw new Error('egress socket path is too long for a Unix socket');
      await new Promise((resolve, reject) => { egressProxy.server.once('error', reject); egressProxy.server.listen(socketFile, resolve); });
      fs.chownSync(socketFile, 0, c.workerGid);
      fs.chmodSync(socketFile, 0o660);
    } catch (error) {
      await egressProxy.close().catch(() => {});
      fs.rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
    egress = { dir, shim: policy.shim, node: process.execPath };
  }
  const closeEgress = async () => { if (egressProxy) await egressProxy.close(); };
  const sandboxChild = (args) => track(startAs(c.workerUid, c.workerGid, process.execPath, [sandbox, ...args], { env: sandboxEnv, stdio: ['pipe', 'pipe', 'pipe'] }));
  // The credential home lock excludes a second supervisor in either storage mode.
  // This file contains no credentials. Never use an expiring directory lock that can
  // strand a login after termination, or permit two refresh-token writers after expiry.
  const lease = spawn('/usr/bin/flock', ['--nonblock', `${c.credentialHome}/.updraft-worker.lock`,
    '/bin/sh', '-c', 'printf ready; exec cat >/dev/null'], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    lease.once('error', reject);
    lease.once('exit', () => reject(new Error('credential home already leased or lock unavailable')));
    lease.stdout.once('data', (data) => data.toString() === 'ready' ? resolve() : reject(new Error('credential lease failed')));
  }).catch(async (error) => { lease.stdin.destroy(); await closeEgress(); fs.rmSync(scratch, { recursive: true, force: true }); throw error; });
  let closing = false;
  lease.once('exit', () => { if (!closing) { for (const client of clients) client.destroy(); for (const child of children) kill(child); server.close(); void closeEgress(); } });
  const releaseLease = async () => {
    closing = true;
    if (lease.exitCode !== null) return;
    const ended = new Promise((resolve) => lease.once('close', resolve));
    lease.stdin.end();
    await ended;
  };

  async function auth(cwd, sessionChildren, readiness = false) {
    // Even the status probe never starts in a repository or loads its settings/helpers.
    const result = await captureAs(c.claudeUid, c.claudeGid, c.claude,
      ['--restricted', '--setting-sources', '', 'auth', 'status'], { cwd, env: environment },
      (child) => { sessionChildren.add(child); child.once('close', () => sessionChildren.delete(child)); return track(child); });
    const status = nativeClaudeAuthFromStatus(result, environment);
    if (readiness) return status.state === 'login_required' ? 'auth-required' : ['connected', 'expired'].includes(status.state) ? status.state : 'unavailable';
    if (status.state !== 'connected') throw new Error(`native Claude subscription unavailable (${status.reason})`);
  }

  async function executeTool(runArgs, run, command, sessionChildren) {
    if (typeof command !== 'string' || command.length > 65536 || command.includes('\0')) throw new Error('invalid tool command');
    const args = withEgress(runArgs, run, ['/bin/sh', '-c', command], egress);
    // Every tool gets the SAME mounts, uid, empty network (registry proxy only) and temporary HOME as verification.
    const child = sandboxChild(['run', ...args]);
    sessionChildren.add(child);
    child.stdin.end();
    return new Promise((resolve) => {
      let output = '';
      let limited = false;
      let timer;
      const finish = (code) => {
        clearTimeout(timer);
        kill(child); // Also reap descendants if the command backgrounded a process.
        sessionChildren.delete(child);
        resolve({ content: [{ type: 'text', text: `${output}\nexit=${code ?? 125}${limited ? ' (output/time limit)' : ''}` }], isError: code !== 0 || limited });
      };
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
        if (Buffer.byteLength(output) + chunk.length > 262144) { limited = true; kill(child); }
        else output += chunk.toString('utf8');
      });
      child.once('error', () => { limited = true; });
      child.once('close', finish);
      timer = setTimeout(() => { limited = true; kill(child); }, toolTimeoutMs);
    });
  }

  async function claudeSession(runArgs, run, prompt, client, cancel) {
    const dir = fs.mkdtempSync(`${scratch}/claude-`);
    fs.chownSync(dir, c.claudeUid, c.claudeGid);
    fs.chmodSync(dir, 0o700);
    const toolSocket = `${dir}/tools.sock`;
    const sessionChildren = new Set();
    const toolClients = new Set();
    let busy = false;
    let initialized = false;
    let failed = false;
    const tools = net.createServer((socket) => {
      if (failed || client.destroyed) { socket.destroy(); return; }
      toolClients.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => toolClients.delete(socket));
      frames(socket, (request) => {
        if (failed || client.destroyed) { socket.destroy(); return; }
        const reply = (result) => send(socket, { jsonrpc: '2.0', id: request.id, result });
        if (request.jsonrpc !== '2.0') { socket.destroy(); return; }
        if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return;
        if (request.method === 'initialize') {
          reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'updraft', version: '0.1.0' } });
        } else if (request.method === 'ping') reply({});
        else if (request.method === 'tools/list') reply({ tools: [{ name: 'exec', description: `Run a shell command in the isolated job worktree. Read/edit files, run git, install dependencies, build and test here. Each command may run ${Math.round(toolTimeoutMs / 1000)} seconds. ${networkNote(Boolean(egress))}`,
          inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }] });
        else if (request.method === 'tools/call' && request.params?.name === 'exec' && !busy && initialized) {
          busy = true;
          void executeTool(runArgs, run, request.params.arguments?.command, sessionChildren)
            .then(reply, () => reply({ content: [{ type: 'text', text: 'Isolated command rejected.' }], isError: true }))
            .finally(() => { busy = false; });
        } else send(socket, { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Request rejected' } });
      });
    });
    let child;
    cancel.stop = () => { failed = true; kill(child); for (const p of sessionChildren) kill(p); };
    try {
      await auth(dir, sessionChildren);
      if (client.destroyed || failed) return 125;
      const config = JSON.stringify({ mcpServers: { updraft: { command: process.execPath, args: [path.join(here, 'mcp.mjs'), toolSocket] } } });
      const args = claudeArgs(run.command.slice(1), config, { egress: Boolean(egress) });
      await new Promise((resolve, reject) => { tools.once('error', reject); tools.listen(toolSocket, resolve); });
      // Cancellation can arrive while the socket starts, before a child exists to kill.
      if (client.destroyed || failed) return 125;
      fs.chownSync(toolSocket, c.claudeUid, c.claudeGid);
      fs.chmodSync(toolSocket, 0o600);
      child = track(startAs(c.claudeUid, c.claudeGid, c.claude, args,
        { cwd: dir, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }));
      child.stdin.end(prompt);
      // Gate all output and tool calls on the official CLI's advertised tool inventory.
      // Refuse built-in Read/Bash/Agent/etc even if a future CLI changes flag behavior.
      frames(child.stdout, (event) => {
        if (failed || client.destroyed) return;
        try {
          if (!initialized) {
            if (!checkInventory(event)) return;
            initialized = true;
          }
          send(client, { stream: 'stdout', data: Buffer.from(`${JSON.stringify(event)}\n`).toString('base64') });
        } catch { cancel.stop(); }
      }, () => cancel.stop());
      // CLI startup errors can contain identity/auth context; return a fixed error instead.
      child.stderr.resume();
      const code = await new Promise((resolve) => { child.once('error', () => resolve(125)); child.once('close', resolve); });
      return initialized && !failed ? (code ?? 125) : 125;
    } finally {
      cancel.stop();
      for (const socket of toolClients) socket.destroy();
      await new Promise((resolve) => tools.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const server = net.createServer((client) => {
    clients.add(client);
    client.on('error', () => client.destroy());
    let received = false;
    const cancel = { stop: () => {} };
    client.once('close', () => { cancel.stop(); clients.delete(client); });
    const output = (text) => send(client, { stream: 'stdout', data: Buffer.from(text).toString('base64') });
    frames(client, (request) => {
      if (received) { client.destroy(); return; }
      received = true;
      void (async () => {
        const { args, prompt } = request;
        if (!Array.isArray(args) || args.some((v) => typeof v !== 'string')) throw new Error('invalid request');
        if (args[0] === 'image' && args[1] === 'inspect' && args.at(-1) === IMAGE && args.length <= 5) { output('sha256:updraft-native-worker-poc\n'); return 0; }
        if (args.length === 1 && args[0] === 'info') { output('Updraft native worker proof of concept\n'); return 0; }
        if (args[0] === 'container' && args[1] === 'inspect' && args.length <= 5) {
          if (!active.has(args.at(-1))) return 1;
          output('running\n'); return 0;
        }
        if (['stop', 'rm'].includes(args[0]) && args.length <= 4) { active.get(args.at(-1))?.stop(); return 0; }
        if (args[0] !== 'run' || typeof prompt !== 'string' || Buffer.byteLength(prompt) > MAX_FRAME / 4) throw new Error('invalid run');
        if (active.size) throw new Error('native worker is busy');
        const runArgs = args.slice(1);
        const run = validateRun(runArgs, c);
        active.set(run.name, cancel);
        try {
          if (run.command.length === 2 && run.command[0] === 'claude' && run.command[1] === '--version') {
            const version = await captureAs(c.claudeUid, c.claudeGid, c.claude,
              ['--restricted', '--setting-sources', '', '--version'], { cwd: '/', env: environment },
              (child) => { cancel.stop = () => kill(child); return track(child); });
            if (version.code !== 0 || !/^\d+\.\d+\.\d+ \(Claude Code\)\s*$/.test(version.stdout)) return 125;
            output(version.stdout); return 0;
          }
          if (run.command[0] === 'claude') return await claudeSession(runArgs, run, prompt, client, cancel);
          // Updraft verification invocations are allowed arbitrary commands, always sandboxed,
          // with the same registry egress as the agent's own tool calls.
          const child = sandboxChild(['run', ...withEgress(runArgs, run, run.command, egress)]);
          cancel.stop = () => kill(child);
          child.stdin.end(prompt);
          let bytes = 0;
          for (const stream of ['stdout', 'stderr']) child[stream].on('data', (data) => {
            bytes += data.length;
            if (bytes > MAX_FRAME) kill(child);
            else send(client, { stream, data: data.toString('base64') });
          });
          return await new Promise((resolve) => { child.once('error', () => resolve(125)); child.once('close', (code) => resolve(code ?? 125)); });
        } finally { cancel.stop(); active.delete(run.name); }
      })().then((exitCode) => send(client, { exitCode }), () => {
        send(client, { stream: 'stderr', data: Buffer.from('Native worker rejected the run; authentication or isolation requirements were not met.\n').toString('base64') });
        send(client, { exitCode: 125 });
      });
    });
  });

  try {
    // Real namespace probe, including network isolation. A failed probe prevents listening.
    const probeDir = fs.mkdtempSync(`${c.workRoot}/.native-probe-`);
    fs.chownSync(probeDir, c.workerUid, c.workerGid);
    // The supervisor can be PID 1 in the MicroVM. /proc/1 also exists inside
    // an isolated PID namespace, so compare namespace identities instead.
    const pidNamespace = fs.readlinkSync('/proc/self/ns/pid');
    const mountNamespace = fs.readlinkSync('/proc/self/ns/mnt');
    const probe = sandboxChild(['run', '--rm', '--name', `probe-${randomUUID()}`, '--user', `${c.workerUid}:${c.workerGid}`,
      '--network', 'none', '--tmpfs', '/updraft-home:mode=1777', '-e', 'HOME=/updraft-home',
      '--mount', `type=bind,source=${probeDir},target=${probeDir}`, '--workdir', probeDir, IMAGE,
      process.execPath, '-e', `const fs=require('fs'),os=require('os'); if(fs.existsSync(${JSON.stringify(c.credentialHome)}) || fs.readlinkSync('/proc/self/ns/pid') === ${JSON.stringify(pidNamespace)} || fs.readlinkSync('/proc/self/ns/mnt') === ${JSON.stringify(mountNamespace)} || Object.values(os.networkInterfaces()).flat().some(a=>!a.internal)) process.exit(1);`]);
    probe.stdin.end();
    probe.stdout.resume(); probe.stderr.resume();
    const code = await new Promise((resolve) => { probe.once('error', () => resolve(125)); probe.once('close', resolve); });
    fs.rmSync(probeDir, { recursive: true, force: true });
    if (code !== 0) throw new Error('native worker namespace probe failed');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chownSync(socketPath, 0, c.workerGid);
    fs.chmodSync(socketPath, 0o660);
  } catch (error) {
    for (const child of children) kill(child);
    await closeEgress();
    await releaseLease();
    fs.rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  return {
    async authStatus() {
      const cwd = fs.mkdtempSync(`${scratch}/status-`);
      fs.chownSync(cwd, c.claudeUid, c.claudeGid);
      try { return await auth(cwd, new Set(), true); }
      catch { return 'unavailable'; }
      finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    },
    async close() {
      const ended = [...children].map((child) => new Promise((resolve) => child.once('close', resolve)));
      for (const client of clients) client.destroy();
      for (const child of children) kill(child);
      await Promise.all(ended);
      await new Promise((resolve) => server.close(resolve));
      await closeEgress();
      await releaseLease();
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const service = await startService(loadConfig(process.argv[2] ?? '/etc/updraft-native-worker.json'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
    process.stdout.write('Native worker isolation probe passed; supervisor ready.\n');
  } catch {
    process.stderr.write('Native worker startup failed; isolation is not enforced.\n');
    process.exitCode = 1;
  }
}
