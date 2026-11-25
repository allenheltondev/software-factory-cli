// Registry egress (#147): the policy (pure), the proxy over a real Unix socket with name
// resolution and upstream connections replaced, and the shim as a real child process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRY_HOSTS, EGRESS_HEADER, buildAllowlist, classifyAddress, createEgressProxy, hostAllowed, ipv6Groups,
  parseConnect, parseEgressConfig, parseHostRule, refusal, vetTarget,
} from '../image/sandbox/egress-proxy.mjs';
import { diagnosticLine, parseProxyHead, proxyEnv } from '../image/sandbox/egress-shim.mjs';

const SHIM = fileURLToPath(new URL('../image/sandbox/egress-shim.mjs', import.meta.url));
const unix = process.platform !== 'win32';

describe('egress address classification', () => {
  it.each([
    ['93.184.216.34', 'public'],
    ['104.16.0.35', 'public'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['169.254.170.2', 'link-local'],
    ['100.64.0.1', 'carrier-grade-nat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'benchmarking'],
    ['2606:4700::6810:84e5', 'public'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fd00:ec2::254', 'unique-local'],
    ['fd00:ec2::23', 'unique-local'],
    ['fe80::1%eth0', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['::ffff:93.184.216.34', 'public'],
    ['64:ff9b::a00:1', 'private'],
    ['2002:a9fe:a9fe::1', 'reserved'],
    ['::127.0.0.1', 'reserved'],
    ['not-an-ip', 'invalid'],
  ])('%s is %s', (address, kind) => {
    expect(classifyAddress(address)).toBe(kind);
  });

  it('expands IPv6 forms', () => {
    expect(ipv6Groups('::ffff:10.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(ipv6Groups('2001:db8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups('1.2.3.4')).toBeUndefined();
  });
});

describe('egress allowlist', () => {
  const rules = buildAllowlist({ allowHosts: ['npm.internal-mirror.example', '*.pkg.example.dev'] });

  it('allows the default registries and configured hosts, exactly', () => {
    for (const host of DEFAULT_REGISTRY_HOSTS) expect(hostAllowed(host, rules)).toBe(true);
    expect(hostAllowed('npm.internal-mirror.example', rules)).toBe(true);
    expect(hostAllowed('a.pkg.example.dev', rules)).toBe(true);
    expect(hostAllowed('a.b.pkg.example.dev', rules)).toBe(true);
  });

  it('does not match look-alikes, the wildcard apex or arbitrary hosts', () => {
    for (const host of ['pkg.example.dev', 'registry.npmjs.org.evil.example', 'evilregistry.npmjs.org', 'xpkg.example.dev', 'github.com', 'objects.githubusercontent.com', 'example.com']) {
      expect(hostAllowed(host, rules)).toBe(false);
    }
  });

  it('can turn the defaults off', () => {
    const only = buildAllowlist({ defaultRegistries: false, allowHosts: ['registry.corp.example'] });
    expect(only).toEqual([{ wildcard: false, host: 'registry.corp.example' }]);
    expect(hostAllowed('registry.npmjs.org', only)).toBe(false);
  });

  it.each(['10.0.0.1', '[::1]', 'https://registry.example.com', 'registry.example.com:443', '*', '*.com', 'localhost', 'bad_host.example', ''])('refuses the entry %j', (entry) => {
    expect(() => parseHostRule(entry)).toThrow();
  });

  it('validates the worker config section', () => {
    const shim = '/usr/local/lib/updraft-egress/egress-shim.mjs';
    expect(parseEgressConfig(undefined)).toBeUndefined();
    expect(parseEgressConfig({ shim }).rules.length).toBe(DEFAULT_REGISTRY_HOSTS.length);
    expect(() => parseEgressConfig({ shim, extra: true })).toThrow(/unknown key/);
    expect(() => parseEgressConfig({ shim, defaultRegistries: false })).toThrow(/allows no host/);
    expect(() => parseEgressConfig({ shim, allowHosts: ['169.254.169.254'] })).toThrow();
    expect(() => parseEgressConfig({ shim, ports: [0] })).toThrow();
    expect(() => parseEgressConfig({ shim: '/opt/updraft/shim.mjs' })).toThrow(/under \/usr/);
    expect(parseEgressConfig({ shim, ports: [443, 8443], maxConnections: 4 }).limits).toEqual({ ports: [443, 8443], maxConnections: 4 });
  });
});

describe('egress requests', () => {
  it.each([
    ['CONNECT registry.npmjs.org:443 HTTP/1.1', { method: 'CONNECT', host: 'registry.npmjs.org', port: 443 }],
    ['CONNECT Registry.NPMJS.org.:443 HTTP/1.1', { method: 'CONNECT', host: 'registry.npmjs.org', port: 443 }],
    ['CONNECT registry.npmjs.org:80 HTTP/1.1', { reason: 'port-not-allowed' }],
    ['CONNECT 169.254.169.254:443 HTTP/1.1', { reason: 'ip-literal' }],
    ['CONNECT [fd00:ec2::254]:443 HTTP/1.1', { reason: 'ip-literal' }],
    ['GET http://registry.npmjs.org/ HTTP/1.1', { reason: 'https-only' }],
    ['CONNECT registry.npmjs.org HTTP/1.1', { reason: 'bad-request' }],
    ['garbage', { reason: 'bad-request' }],
  ])('%s', (line, expected) => {
    expect(parseConnect(`${line}\r\nHost: x`)).toMatchObject(expected);
  });

  it('checks every resolved address, so a name that also points inward is refused', async () => {
    const rules = buildAllowlist();
    const resolve = async (host) => (host === 'registry.npmjs.org' ? [{ address: '104.16.0.35', family: 4 }, { address: '10.0.0.9', family: 4 }] : []);
    expect(await vetTarget({ host: 'registry.npmjs.org' }, rules, resolve)).toEqual({ reason: 'non-public-address', detail: 'private' });
    expect(await vetTarget({ host: 'pypi.org' }, rules, resolve)).toMatchObject({ reason: 'dns-failure' });
    expect(await vetTarget({ host: 'evil.example' }, rules, resolve)).toEqual({ reason: 'not-allowed' });
    const err = Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    expect(await vetTarget({ host: 'pypi.org' }, rules, async () => { throw err; })).toEqual({ reason: 'dns-failure', detail: 'ENOTFOUND' });
  });

  it('names the reason in the refusal and keeps the header to safe characters', () => {
    const text = refusal('not-allowed', 'evil.example:443\r\nSet-Cookie: x').toString();
    expect(text.startsWith('HTTP/1.1 403 Forbidden\r\n')).toBe(true);
    const head = parseProxyHead(Buffer.from(text));
    expect(head).toEqual({ status: 403, egress: { reason: 'not-allowed', target: 'evil.example:443??Set-Cookie:?x' } });
    expect(text.split('\r\n\r\n')[0]).not.toMatch(/Set-Cookie: x/);
  });
});

// ---------------------------------------------------------------------------
// The proxy and shim for real (Unix sockets, child processes)
// ---------------------------------------------------------------------------

let dir;
let upstream;
let upstreamPort;
let proxy;
let logs;

/** A stand-in registry: echoes what it receives, prefixed. */
async function startUpstream() {
  upstream = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
}

const PUBLIC = '93.184.216.34';
const NAMES = {
  'registry.npmjs.org': [{ address: PUBLIC, family: 4 }],
  'pypi.org': [{ address: PUBLIC, family: 4 }],
  'rebind.example.dev': [{ address: '169.254.169.254', family: 4 }],
  'down.example.dev': [{ address: PUBLIC, family: 4 }],
};

async function startProxy(options = {}) {
  logs = [];
  const connects = [];
  proxy = createEgressProxy({ rules: buildAllowlist({ allowHosts: ['*.example.dev'] }), limits: options.limits }, {
    resolve: async (host) => {
      if (!NAMES[host]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return NAMES[host];
    },
    // Every vetted connection goes to the stand-in; a "down" host to a closed port.
    connect: (target) => {
      connects.push(target);
      return net.connect({ host: '127.0.0.1', port: target.port === 443 && connects.length && options.down ? 1 : upstreamPort });
    },
    log: (record) => logs.push(record),
  });
  const socket = path.join(dir, 'proxy.sock');
  await new Promise((r) => proxy.server.listen(socket, r));
  return { socket, connects };
}

/** CONNECT through `socket` and send `ping` once established. Resolves { head, body }. */
function tunnel(connectTo, target, { send = 'ping', raw } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(connectTo);
    let data = '';
    let sent = false;
    s.on('error', reject);
    s.on('connect', () => s.write(raw ?? `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on('data', (d) => {
      data += d;
      if (!sent && data.startsWith('HTTP/1.1 200') && data.includes('\r\n\r\n')) { sent = true; s.write(send); }
      if (sent && data.includes(`echo:${send}`)) s.end();
    });
    s.on('close', () => {
      const end = data.indexOf('\r\n\r\n');
      resolve({ head: data.slice(0, end), body: data.slice(end + 4) });
    });
  });
}

describe.skipIf(!unix)('egress proxy over its socket', () => {
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-egress-'));
    await startUpstream();
  });
  afterEach(async () => {
    await proxy?.close();
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tunnels to an allowed registry, connecting to the address it checked', async () => {
    const { socket, connects } = await startProxy();
    const result = await tunnel(socket, 'registry.npmjs.org:443');
    expect(result.head).toBe('HTTP/1.1 200 Connection Established');
    expect(result.body).toBe('echo:ping');
    expect(connects).toEqual([{ address: PUBLIC, port: 443, family: 4 }]);
    expect(logs[0]).toEqual({ event: 'egress', decision: 'allow', target: 'registry.npmjs.org:443', address: PUBLIC });
    expect(proxy.stats.allowed).toBe(1);
  });

  it.each([
    ['github.com:443', 403, 'not-allowed'],
    ['registry.npmjs.org:22', 403, 'port-not-allowed'],
    ['169.254.169.254:443', 403, 'ip-literal'],
    ['rebind.example.dev:443', 403, 'non-public-address'],
    ['missing.example.dev:443', 502, 'dns-failure'],
  ])('refuses %s with %i (%s) and never connects', async (target, status, reason) => {
    const { socket, connects } = await startProxy();
    const result = await tunnel(socket, target);
    expect(result.head).toMatch(new RegExp(`^HTTP/1.1 ${status} `));
    expect(result.head).toContain(`${EGRESS_HEADER}: reason=${reason}`);
    expect(result.body).toMatch(new RegExp(`Updraft egress refused \\(${reason}\\)`));
    expect(connects).toEqual([]);
    expect(logs).toEqual([expect.objectContaining({ decision: 'deny', reason })]);
  });

  it('refuses plain HTTP forwarding', async () => {
    const { socket } = await startProxy();
    const result = await tunnel(socket, '', { raw: 'GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n' });
    expect(result.head).toContain('reason=https-only');
  });

  it('reports a registry that refuses the connection', async () => {
    const { socket } = await startProxy({ down: true });
    const result = await tunnel(socket, 'down.example.dev:443');
    expect(result.head).toMatch(/^HTTP\/1.1 502 /);
    expect(result.head).toContain('reason=connect-failed; target=down.example.dev:443; detail=ECONNREFUSED');
  });

  it('bounds concurrent tunnels', async () => {
    const { socket } = await startProxy({ limits: { maxConnections: 1 } });
    const held = net.connect(socket);
    await new Promise((r) => held.on('connect', r));
    held.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n');
    await new Promise((r) => held.once('data', r));
    const second = await tunnel(socket, 'pypi.org:443');
    expect(second.head).toContain('reason=too-many-connections');
    held.destroy();
  });

  it('refuses an oversized request head', async () => {
    const { socket } = await startProxy();
    const result = await tunnel(socket, '', { raw: `CONNECT ${'a'.repeat(9000)}` });
    expect(result.head).toContain('reason=bad-request');
  });
});

/** Run the shim with a node client as its command; resolves { code, stdout, stderr }. */
function runShim(socket, clientSource, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM, socket, '--', process.execPath, '-e', clientSource, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A client that reads HTTPS_PROXY, as a package manager would, and CONNECTs to each target given. */
const CLIENT = `
const net = require('net');
const url = new URL(process.env.HTTPS_PROXY);
const one = (target) => new Promise((resolve) => {
  const s = net.connect(Number(url.port), url.hostname, () => s.write('CONNECT ' + target + ' HTTP/1.1\\r\\n\\r\\n'));
  let data = '';
  s.on('data', (d) => { data += d; if (data.startsWith('HTTP/1.1 200') && data.includes('\\r\\n\\r\\n') && !data.includes('echo:')) s.write('hi'); if (data.includes('echo:hi')) s.end(); });
  s.on('close', () => resolve(data.split('\\r\\n')[0] + (data.includes('echo:hi') ? ' tunneled' : '')));
  s.on('error', () => resolve('error'));
});
(async () => {
  for (const t of process.argv.slice(1)) console.log(await one(t));
  console.log('npm_config_https_proxy=' + (process.env.npm_config_https_proxy === process.env.HTTPS_PROXY));
  process.exit(Number(process.env.EXIT_WITH || 0));
})();`;

describe.skipIf(!unix)('egress shim', () => {
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-egress-'));
    await startUpstream();
  });
  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('points package managers at the proxy, tunnels allowed hosts and explains refusals on stderr', async () => {
    const { socket } = await startProxy();
    const result = await runShim(socket, CLIENT, ['registry.npmjs.org:443', 'github.com:443', 'github.com:443', 'rebind.example.dev:443']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('HTTP/1.1 200 Connection Established tunneled');
    expect(result.stdout).toContain('HTTP/1.1 403 Forbidden');
    expect(result.stdout).toContain('npm_config_https_proxy=true');
    expect(result.stderr).toContain('updraft-egress: refused CONNECT github.com:443 (not-allowed): the host is not an allowed package registry [2 times]');
    expect(result.stderr).toContain('updraft-egress: refused CONNECT rebind.example.dev:443 (non-public-address): the name resolves to a non-public address (link-local)');
  });

  it('keeps the command exit code', async () => {
    const { socket } = await startProxy();
    const result = await runShim(socket, 'process.exit(7)');
    expect(result.code).toBe(7);
    expect(result.stderr).toBe('');
  });

  it('says so when the proxy is not there', async () => {
    const result = await runShim(path.join(dir, 'absent.sock'), CLIENT, ['registry.npmjs.org:443']);
    expect(result.stdout).toContain('HTTP/1.1 502 Bad Gateway');
    expect(result.stderr).toContain('(proxy-unavailable)');
  });

  it('builds the proxy variables and diagnostic lines', () => {
    const env = proxyEnv('http://127.0.0.1:9', { KEEP: '1' });
    expect(env).toMatchObject({ KEEP: '1', HTTPS_PROXY: 'http://127.0.0.1:9', npm_config_https_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1,::1' });
    expect(diagnosticLine({ reason: 'dns-failure', target: 'pypi.org:443', detail: 'EAI_AGAIN', count: 1 }))
      .toBe('updraft-egress: refused CONNECT pypi.org:443 (dns-failure): name resolution failed (EAI_AGAIN)');
  });
});
