// Registry egress (#147): the policy (pure), the proxy over a real Unix socket with name
// resolution and upstream connections replaced, and the shim as a real child process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRY_HOSTS, EGRESS_HEADER, TLS_ACCESS_DENIED, buildAllowlist, classifyAddress, createEgressProxy, hostAllowed, ipv6Groups,
  parseClientHello, parseConnect, parseEgressConfig, parseHostRule, refusal, vetTarget,
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
// TLS ClientHello parsing
// ---------------------------------------------------------------------------

/** A ClientHello exactly as Node's TLS client sends it, for `servername` (none when undefined). */
async function clientHello(servername) {
  const capture = net.createServer();
  await new Promise((r) => capture.listen(0, '127.0.0.1', r));
  const first = new Promise((resolve) => capture.once('connection', (s) => s.once('data', (d) => { resolve(d); s.destroy(); })));
  const socket = tls.connect({ host: '127.0.0.1', port: capture.address().port, ...(servername ? { servername } : {}), rejectUnauthorized: false });
  socket.on('error', () => {});
  const bytes = await first;
  socket.destroy();
  await new Promise((r) => capture.close(r));
  return bytes;
}

/** A synthetic ClientHello with the given extensions ([type, Buffer]), split into records of `recordSize`. */
function buildHello(extensions, { recordSize = 16_384 } = {}) {
  const ext = Buffer.concat(extensions.map(([type, data]) => Buffer.concat([Buffer.from([type >> 8, type & 0xff, data.length >> 8, data.length & 0xff]), data])));
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0]), Buffer.from([0, 2, 0x13, 0x01]), Buffer.from([1, 0]),
    Buffer.from([ext.length >> 8, ext.length & 0xff]), ext,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
  const records = [];
  for (let i = 0; i < handshake.length; i += recordSize) {
    const part = handshake.subarray(i, i + recordSize);
    records.push(Buffer.from([0x16, 0x03, 0x01, part.length >> 8, part.length & 0xff]), part);
  }
  return Buffer.concat(records);
}
const sniExtension = (...names) => {
  const list = Buffer.concat(names.map((n) => Buffer.concat([Buffer.from([0, n.length >> 8, n.length & 0xff]), Buffer.from(n)])));
  return [0, Buffer.concat([Buffer.from([list.length >> 8, list.length & 0xff]), list])];
};

describe('egress TLS ClientHello', () => {
  it("reads the server name from Node's own ClientHello, and its absence", async () => {
    const hello = await clientHello('registry.npmjs.org');
    expect(parseClientHello(hello)).toEqual({ sni: 'registry.npmjs.org' });
    expect(parseClientHello(hello.subarray(0, 20))).toEqual({ incomplete: true });
    expect(parseClientHello(await clientHello(undefined))).toEqual({ error: 'no-sni' });
  });

  it('reads a ClientHello split across records', () => {
    expect(parseClientHello(buildHello([sniExtension('pypi.org')], { recordSize: 7 }))).toEqual({ sni: 'pypi.org' });
  });

  it.each([
    ['plain bytes', Buffer.from('GET / HTTP/1.1\r\n\r\n'), 'not-tls'],
    ['an SSH banner', Buffer.from('SSH-2.0-OpenSSH_9.6\r\n'), 'not-tls'],
    ['Encrypted Client Hello', buildHello([sniExtension('public.example'), [0xfe0d, Buffer.from([0, 1, 2])]]), 'opaque-handshake'],
    ['two host names', buildHello([sniExtension('pypi.org', 'evil.example')]), 'malformed'],
    ['two server_name extensions', buildHello([sniExtension('pypi.org'), sniExtension('pypi.org')]), 'malformed'],
    ['no extensions at all', buildHello([]), 'no-sni'],
    ['a handshake that is not a ClientHello', Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]), 'malformed'],
  ])('refuses %s', (_, bytes, error) => {
    expect(parseClientHello(bytes)).toEqual({ error });
  });

  it('refuses a ClientHello larger than the limit', () => {
    const big = buildHello([sniExtension('pypi.org'), [0x0015, Buffer.alloc(20_000)]]);
    expect(parseClientHello(big, 16_384)).toEqual({ error: 'malformed' });
  });
});

// ---------------------------------------------------------------------------
// The proxy and shim for real (Unix sockets, child processes)
// ---------------------------------------------------------------------------

let dir;
let upstream;
let upstreamPort;
let received;
let proxy;
let logs;

/** A stand-in registry: records and echoes what it receives, prefixed. */
async function startUpstream() {
  received = [];
  upstream = net.createServer((s) => s.on('data', (d) => { received.push(d); s.write(Buffer.concat([Buffer.from('echo:'), d])); }));
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

/** A lookup that settles only when told to: { promise, resolve(), reject() }. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function startProxy(options = {}) {
  logs = [];
  const connects = [];
  const lookups = [];
  proxy = createEgressProxy({ rules: buildAllowlist({ allowHosts: ['*.example.dev'] }), limits: options.limits }, {
    resolve: async (host) => {
      if (host.startsWith('hang')) {
        const d = deferred();
        lookups.push(d);
        return d.promise;
      }
      if (!NAMES[host]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return NAMES[host];
    },
    // Every vetted connection goes to the stand-in; a "down" host to a closed port; with
    // `stall`, a socket that never connects.
    connect: (target) => {
      connects.push(target);
      if (options.stall) return new net.Socket();
      return net.connect({ host: '127.0.0.1', port: options.down ? 1 : upstreamPort });
    },
    log: (record) => logs.push(record),
  });
  const socket = path.join(dir, 'proxy.sock');
  await new Promise((r) => proxy.server.listen(socket, r));
  return { socket, connects, lookups };
}

/**
 * CONNECT through `socket`; once established, send `first` (a ClientHello, or any bytes).
 * Resolves { head, rest } where rest is what came back after the head.
 */
function tunnel(connectTo, target, { first, raw, close = 'echo' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(connectTo);
    let data = Buffer.alloc(0);
    let sent = false;
    s.on('error', reject);
    s.on('connect', () => s.write(raw ?? `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on('data', (d) => {
      data = Buffer.concat([data, d]);
      const text = data.toString('latin1');
      if (!sent && text.startsWith('HTTP/1.1 200') && text.includes('\r\n\r\n') && first) { sent = true; s.write(first); }
      if (sent && close === 'echo' && text.includes('echo:')) s.end();
    });
    s.on('close', () => {
      const end = data.indexOf('\r\n\r\n');
      resolve({ head: data.subarray(0, end).toString('latin1'), rest: data.subarray(end + 4) });
    });
  });
}

/** Open a connection and leave it at `bytes` (a partial head), resolved once accepted. */
async function hold(socket, bytes) {
  const s = net.connect(socket);
  s.on('error', () => {});
  await new Promise((r) => s.on('connect', r));
  if (bytes) s.write(bytes);
  return s;
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!unix)('egress proxy over its socket', () => {
  let npmHello;
  let evilHello;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-egress-'));
    await startUpstream();
    npmHello ??= await clientHello('registry.npmjs.org');
    evilHello ??= await clientHello('evil.example');
  });
  afterEach(async () => {
    await proxy?.close();
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tunnels TLS for the allowed name, connecting to the address it checked', async () => {
    const { socket, connects } = await startProxy();
    const result = await tunnel(socket, 'registry.npmjs.org:443', { first: npmHello });
    expect(result.head).toBe('HTTP/1.1 200 Connection Established');
    expect(Buffer.concat(received).equals(npmHello)).toBe(true);
    expect(result.rest.subarray(0, 5).toString()).toBe('echo:');
    expect(connects).toEqual([{ address: PUBLIC, port: 443, family: 4 }]);
    expect(logs[0]).toEqual({ event: 'egress', decision: 'allow', target: 'registry.npmjs.org:443', address: PUBLIC });
    await settle();
    expect(proxy.stats).toMatchObject({ allowed: 1, clients: 0, open: 0 });
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
    expect(result.rest.toString()).toMatch(new RegExp(`Updraft egress refused \\(${reason}\\)`));
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

  describe('binds the tunnel to TLS for the CONNECT host', () => {
    it.each([
      ['a ClientHello for another name', () => evilHello, 'tls-authority-mismatch'],
      ['plain bytes', () => Buffer.from('GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n'), 'tls-required'],
      ['a ClientHello without a server name', () => buildHello([]), 'tls-no-sni'],
      ['Encrypted Client Hello', () => buildHello([sniExtension('registry.npmjs.org'), [0xfe0d, Buffer.from([0])]]), 'tls-opaque-handshake'],
    ])('refuses %s, forwarding nothing upstream', async (_, bytes, reason) => {
      const { socket, connects } = await startProxy();
      const result = await tunnel(socket, 'registry.npmjs.org:443', { first: bytes(), close: 'server' });
      expect(result.head).toBe('HTTP/1.1 200 Connection Established');
      expect(result.rest.equals(TLS_ACCESS_DENIED)).toBe(true);
      expect(connects).toHaveLength(1);
      await settle();
      expect(received).toEqual([]);
      expect(logs).toContainEqual(expect.objectContaining({ decision: 'deny', reason }));
      expect(proxy.stats).toMatchObject({ allowed: 0, clients: 0, open: 0 });
    });

    it('waits for a ClientHello that arrives in pieces', async () => {
      const { socket } = await startProxy();
      const s = net.connect(socket);
      let data = '';
      s.on('data', async (d) => {
        data += d;
        if (data === 'HTTP/1.1 200 Connection Established\r\n\r\n') {
          for (let i = 0; i < npmHello.length; i += 50) { s.write(npmHello.subarray(i, i + 50)); await settle(5); }
        }
        if (data.includes('echo:')) s.end();
      });
      s.on('connect', () => s.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n'));
      await new Promise((r) => s.on('close', r));
      expect(Buffer.concat(received).equals(npmHello)).toBe(true);
    });

    it('ends a tunnel whose client never says hello', async () => {
      const { socket } = await startProxy({ limits: { helloTimeoutMs: 100 } });
      const result = await tunnel(socket, 'registry.npmjs.org:443', { close: 'server' });
      expect(result.rest.equals(TLS_ACCESS_DENIED)).toBe(true);
      expect(logs).toContainEqual(expect.objectContaining({ reason: 'tls-required', detail: 'no?client?hello' }));
      expect(proxy.stats).toMatchObject({ clients: 0, open: 0 });
    });
  });

  describe('bounds every stage, and recovers', () => {
    it('caps accepted clients at admission, counting partial request heads', async () => {
      const { socket } = await startProxy({ limits: { maxClients: 3 } });
      const held = [];
      for (let i = 0; i < 3; i += 1) held.push(await hold(socket, 'CONNECT registry.np'));
      await settle();
      expect(proxy.stats.clients).toBe(3);
      const refused = await tunnel(socket, 'registry.npmjs.org:443');
      expect(refused.head).toMatch(/^HTTP\/1.1 503 /);
      expect(refused.head).toContain('reason=too-many-connections');
      for (const s of held) s.destroy();
      await settle();
      expect(proxy.stats.clients).toBe(0);
      const next = await tunnel(socket, 'registry.npmjs.org:443', { first: npmHello });
      expect(next.head).toBe('HTTP/1.1 200 Connection Established');
    });

    it('refuses an oversized head, complete or not', async () => {
      const { socket } = await startProxy();
      const complete = await tunnel(socket, '', { raw: `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nX-Pad: ${'a'.repeat(9000)}\r\n\r\n` });
      expect(complete.head).toContain('reason=bad-request; detail=head?too?large');
      const partial = await tunnel(socket, '', { raw: `CONNECT ${'a'.repeat(9000)}` });
      expect(partial.head).toContain('reason=bad-request');
    });

    it('ends a request head that never completes', async () => {
      const { socket } = await startProxy({ limits: { headTimeoutMs: 100 } });
      const result = await tunnel(socket, '', { raw: 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n' });
      expect(result.head).toMatch(/^HTTP\/1.1 408 /);
      expect(result.head).toContain('reason=request-timeout');
      expect(proxy.stats.clients).toBe(0);
    });

    it('gives DNS a deadline, ignores the late answer and bounds unsettled lookups', async () => {
      const { socket, connects, lookups } = await startProxy({ limits: { dnsTimeoutMs: 100, maxPendingLookups: 2 } });
      for (const host of ['hang1.example.dev', 'hang2.example.dev']) {
        const result = await tunnel(socket, `${host}:443`);
        expect(result.head).toMatch(/^HTTP\/1.1 504 /);
        expect(result.head).toContain('reason=dns-timeout');
      }
      // Both lookups are still unsettled: a third request is refused before it adds a lookup.
      expect(proxy.stats.lookups).toBe(2);
      const third = await tunnel(socket, 'registry.npmjs.org:443');
      expect(third.head).toContain('reason=too-many-connections; target=registry.npmjs.org:443; detail=lookups');
      // The late answers settle the lookups but connect nothing.
      for (const d of lookups) d.resolve([{ address: PUBLIC, family: 4 }]);
      await settle();
      expect(proxy.stats.lookups).toBe(0);
      expect(connects).toEqual([]);
      const next = await tunnel(socket, 'registry.npmjs.org:443', { first: npmHello });
      expect(next.head).toBe('HTTP/1.1 200 Connection Established');
      expect(proxy.stats.clients).toBe(0);
    });

    it('shares one lookup between concurrent requests for a name, as package managers open them', async () => {
      const { socket, lookups } = await startProxy({ limits: { dnsTimeoutMs: 200, maxPendingLookups: 1 } });
      const results = await Promise.all(Array.from({ length: 20 }, () => tunnel(socket, 'hang.example.dev:443')));
      for (const r of results) expect(r.head).toContain('reason=dns-timeout');
      expect(lookups).toHaveLength(1);
      expect(proxy.stats.lookups).toBe(1);
      lookups[0].resolve([{ address: PUBLIC, family: 4 }]);
      await settle();
      expect(proxy.stats).toMatchObject({ lookups: 0, clients: 0 });
    });

    it('releases everything when the peer leaves during DNS', async () => {
      const { socket, connects, lookups } = await startProxy();
      const s = await hold(socket, 'CONNECT hang.example.dev:443 HTTP/1.1\r\n\r\n');
      await settle();
      expect(proxy.stats).toMatchObject({ clients: 1, lookups: 1 });
      s.destroy();
      await settle();
      expect(proxy.stats.clients).toBe(0);
      lookups[0].resolve([{ address: PUBLIC, family: 4 }]);
      await settle();
      expect(connects).toEqual([]);
      expect(logs).toContainEqual(expect.objectContaining({ decision: 'aborted', stage: 'dns' }));
    });

    it('releases the tunnel slot when the peer leaves during connect, and times the connect out', async () => {
      const { socket } = await startProxy({ stall: true, limits: { connectTimeoutMs: 100 } });
      const s = await hold(socket, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n');
      await settle(20);
      expect(proxy.stats).toMatchObject({ clients: 1, open: 1 });
      s.destroy();
      await settle();
      expect(proxy.stats).toMatchObject({ clients: 0, open: 0 });
      const timedOut = await tunnel(socket, 'registry.npmjs.org:443');
      expect(timedOut.head).toMatch(/^HTTP\/1.1 504 /);
      expect(timedOut.head).toContain('reason=connect-timeout');
      expect(proxy.stats).toMatchObject({ clients: 0, open: 0 });
    });

    it('bounds concurrent tunnels', async () => {
      const { socket } = await startProxy({ limits: { maxConnections: 1 } });
      const held = await hold(socket, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n');
      await new Promise((r) => held.once('data', r));
      const second = await tunnel(socket, 'pypi.org:443');
      expect(second.head).toContain('reason=too-many-connections');
      held.destroy();
      await settle();
      const third = await tunnel(socket, 'pypi.org:443', { first: await clientHello('pypi.org') });
      expect(third.head).toBe('HTTP/1.1 200 Connection Established');
    });
  });
});

/** Run the shim with a node client as its command; resolves { code, stdout, stderr }. */
function runShim(socket, clientSource, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM, socket, '--', process.execPath, '-e', clientSource, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * A client that reads HTTPS_PROXY, as a package manager would, and CONNECTs to each target
 * given; once established it sends the ClientHello in HELLO_<host> (hex), or plain bytes.
 */
const CLIENT = `
const net = require('net');
const url = new URL(process.env.HTTPS_PROXY);
const one = (target) => new Promise((resolve) => {
  const host = target.split(':')[0];
  const hello = process.env['HELLO_' + host.replace(/[^a-z0-9]/gi, '_')];
  const s = net.connect(Number(url.port), url.hostname, () => s.write('CONNECT ' + target + ' HTTP/1.1\\r\\n\\r\\n'));
  let data = '';
  let sent = false;
  s.on('data', (d) => {
    data += d.toString('latin1');
    if (!sent && data.startsWith('HTTP/1.1 200') && data.includes('\\r\\n\\r\\n')) { sent = true; s.write(hello ? Buffer.from(hello, 'hex') : 'plain bytes'); }
    if (data.includes('echo:')) s.end();
  });
  s.on('close', () => resolve(data.split('\\r\\n')[0] + (data.includes('echo:') ? ' tunneled' : '')));
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
    const env = { HELLO_registry_npmjs_org: (await clientHello('registry.npmjs.org')).toString('hex') };
    const result = await runShim(socket, CLIENT, ['registry.npmjs.org:443', 'github.com:443', 'github.com:443', 'rebind.example.dev:443', 'pypi.org:443'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('HTTP/1.1 200 Connection Established tunneled');
    expect(result.stdout).toContain('HTTP/1.1 403 Forbidden');
    expect(result.stdout).toContain('npm_config_https_proxy=true');
    expect(result.stderr).toContain('updraft-egress: refused CONNECT github.com:443 (not-allowed): the host is not an allowed package registry [2 times]');
    expect(result.stderr).toContain('updraft-egress: refused CONNECT rebind.example.dev:443 (non-public-address): the name resolves to a non-public address (link-local)');
    // pypi.org got plain bytes instead of a ClientHello: refused at the handshake.
    expect(result.stderr).toContain('updraft-egress: refused CONNECT pypi.org:443 (tls-refused)');
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
