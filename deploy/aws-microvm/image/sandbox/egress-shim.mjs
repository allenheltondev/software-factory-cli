#!/usr/bin/env node
// Runs inside the sandbox, in front of one repository command (#147):
//
//   node egress-shim.mjs <proxy socket> -- <command> [args...]
//
// The sandbox has `--network none`: only its own loopback. This listens on 127.0.0.1 (an
// ephemeral port of that private loopback), relays every connection to the egress proxy's Unix
// socket (egress-proxy.mjs, outside the sandbox), and starts the command with the proxy
// variables the common package managers read. It decides nothing: the proxy is the policy,
// and a command that ignores the variables simply has no network, as before.
//
// When the proxy refuses a connection, the shim prints one line per distinct refusal to stderr
// after the command ends, naming the stage, target and reason, so an install that failed for
// lack of network says why instead of reporting ENOTFOUND or a bare 403:
//
//   updraft-egress: refused CONNECT evil.example:443 (not-allowed): ...
//
// The command's exit code is the shim's (128+N when it was killed by signal N).
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EGRESS_HEADER = 'x-updraft-egress';
/** The proxy's answer to a tunnel whose first bytes it refused (egress-proxy.mjs TLS_ACCESS_DENIED). */
const TLS_ACCESS_DENIED = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]);
const MAX_HEAD = 16384;
const MAX_DIAGNOSTICS = 20;

/**
 * The variables that point npm, pnpm, Yarn, Corepack, pip, uv, cargo, go, gem and git at the proxy. Not
 * NODE_USE_ENV_PROXY: on the Node.js in the image it prints an experimental warning from every
 * node process, and package managers read the variables themselves. Pure.
 */
export function proxyEnv(url, env = {}) {
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    ...env,
    HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url,
    ALL_PROXY: url, all_proxy: url,
    NO_PROXY: noProxy, no_proxy: noProxy,
    npm_config_proxy: url, npm_config_https_proxy: url, npm_config_noproxy: noProxy,
    YARN_HTTP_PROXY: url, YARN_HTTPS_PROXY: url,
    CARGO_HTTP_PROXY: url,
    UPDRAFT_EGRESS_PROXY: url,
  };
}

/**
 * The proxy's answer head as { status, egress } once complete, or undefined while incomplete.
 * `egress` is the parsed X-Updraft-Egress header ({ reason, target, detail }) if present. Pure.
 */
export function parseProxyHead(buffer) {
  const end = buffer.indexOf('\r\n\r\n');
  if (end === -1) return undefined;
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1];
  let egress;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1 || line.slice(0, colon).trim().toLowerCase() !== EGRESS_HEADER) continue;
    egress = {};
    for (const part of line.slice(colon + 1).split(';')) {
      const eq = part.indexOf('=');
      if (eq !== -1) egress[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return { status: status ? Number(status) : 0, egress };
}

/** One stderr line for a refusal. Pure. */
export function diagnosticLine({ reason, target, detail, count }) {
  const what = target ? `CONNECT ${target}` : 'a request';
  const why = {
    'not-allowed': 'the host is not an allowed package registry',
    'ip-literal': 'only allowed registry host names are reachable, not addresses',
    'port-not-allowed': 'the port is not allowed',
    'non-public-address': `the name resolves to a non-public address${detail ? ` (${detail})` : ''}`,
    'dns-failure': `name resolution failed${detail ? ` (${detail})` : ''}`,
    'dns-timeout': 'name resolution took too long',
    'request-timeout': 'the request was not sent in time',
    'tls-refused': 'the proxy closed the tunnel at the TLS handshake: it must be TLS whose server name (SNI) is the host the CONNECT named',
    'connect-failed': `the registry refused or dropped the connection${detail ? ` (${detail})` : ''}`,
    'connect-timeout': 'the registry did not answer in time',
    'too-many-connections': 'too many registry connections were open at once',
    'https-only': 'only HTTPS through CONNECT is allowed',
    'proxy-unavailable': 'the worker egress proxy is not reachable; registry access is off for this command',
  }[reason] ?? 'the request was not understood';
  return `updraft-egress: refused ${what} (${reason}): ${why}${count > 1 ? ` [${count} times]` : ''}`;
}

/** Relay one sandbox-local connection to the proxy socket, reporting a refusal through `record`. */
export function relay(client, socketPath, record) {
  const upstream = net.createConnection(socketPath);
  let head = Buffer.alloc(0);
  let headDone = false;
  // Set when the shim itself answered (the proxy is unreachable): that answer must be flushed,
  // never cut off by the dead upstream's close.
  let answered = false;
  let target;
  let afterTunnel = false; // the next upstream bytes are the first after a 200
  client.once('data', (chunk) => { target = /^CONNECT (\S+) /.exec(chunk.toString('latin1', 0, 300))?.[1]; });
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => {
    if (!headDone) {
      headDone = true;
      answered = true;
      client.unpipe(upstream);
      record({ reason: 'proxy-unavailable' });
      const body = 'Updraft egress proxy unavailable\n';
      client.end(`HTTP/1.1 502 Bad Gateway\r\nX-Updraft-Egress: reason=proxy-unavailable\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    } else client.destroy();
  });
  upstream.on('data', (chunk) => {
    if (!headDone) {
      head = Buffer.concat([head, chunk]);
      const parsed = parseProxyHead(head);
      if (!parsed && head.length < MAX_HEAD) return;
      headDone = true;
      if (parsed && parsed.status !== 200) record({ reason: parsed.egress?.reason ?? 'bad-request', target: parsed.egress?.target, detail: parsed.egress?.detail });
      const end = head.indexOf('\r\n\r\n');
      if (parsed?.status === 200 && end !== -1 && end + 4 === head.length) afterTunnel = true;
      else if (parsed?.status === 200 && end !== -1 && head.subarray(end + 4).equals(TLS_ACCESS_DENIED)) record({ reason: 'tls-refused', target });
      client.write(head);
      return;
    }
    if (afterTunnel) {
      afterTunnel = false;
      if (chunk.equals(TLS_ACCESS_DENIED)) record({ reason: 'tls-refused', target });
    }
    client.write(chunk);
  });
  // A clean close (the proxy's refusal, or the registry ending the tunnel) ends the client
  // after what was written is flushed; only a failed tunnel is cut at once.
  upstream.on('close', (hadError) => {
    if (answered) return;
    if (hadError) client.destroy();
    else client.end();
  });
  client.on('close', () => upstream.destroy());
  client.pipe(upstream);
}

/** Start the loopback relay: resolves to { port, server, diagnostics() }. */
export async function startRelay(socketPath, host = '127.0.0.1') {
  const refusals = new Map();
  const record = (r) => {
    const key = `${r.reason}|${r.target ?? ''}|${r.detail ?? ''}`;
    const known = refusals.get(key);
    if (known) known.count += 1;
    else if (refusals.size < MAX_DIAGNOSTICS) refusals.set(key, { ...r, count: 1 });
  };
  const server = net.createServer((client) => relay(client, socketPath, record));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return { port: server.address().port, server, diagnostics: () => [...refusals.values()].map(diagnosticLine) };
}

async function main(argv) {
  const separator = argv.indexOf('--');
  const socketPath = argv[0];
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  if (!socketPath || separator !== 1 || command.length === 0) {
    process.stderr.write('usage: egress-shim.mjs <proxy socket> -- <command> [args...]\n');
    return 125;
  }
  let relayState;
  try {
    relayState = await startRelay(socketPath);
  } catch {
    process.stderr.write('updraft-egress: could not open the sandbox loopback relay; registry access is off for this command\n');
  }
  const env = relayState ? proxyEnv(`http://127.0.0.1:${relayState.port}`, process.env) : process.env;
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  const code = await new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`${command[0]}: ${error.code === 'ENOENT' ? 'command not found' : 'cannot be executed'}\n`);
      resolve(error.code === 'ENOENT' ? 127 : 126);
    });
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? 128 + (os.constants.signals[signal] ?? 0)));
  });
  if (relayState) {
    for (const line of relayState.diagnostics()) process.stderr.write(`${line}\n`);
    relayState.server.close();
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(125));
}
