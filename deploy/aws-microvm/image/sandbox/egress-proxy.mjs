// Controlled package-registry egress for sandboxed repository commands (#147).
//
// A sandboxed command that runs with `--network none` has only its own loopback. This proxy
// runs outside the sandbox (as root, in the supervisor) on a Unix socket that is bound into
// the sandbox; egress-shim.mjs, inside the sandbox, exposes that socket on the sandbox's own
// loopback and points the package managers at it. The proxy is the policy:
//
//   - HTTPS CONNECT only, to an allowed port (443 unless configured), to a host on the
//     allowlist: exact names, or "*.example.com" for subdomains of example.com only. Plain HTTP
//     forwarding, IP literals and every other method are refused.
//   - The proxy resolves the name itself and connects to an address it checked. Loopback,
//     private, link-local (the instance metadata service), carrier-grade NAT, multicast,
//     documentation, IPv6 unique-local and every other non-public range is refused, so neither
//     DNS rebinding nor a registry name that resolves inward reaches the machine or its network.
//     A redirect is a new CONNECT from the client, and is checked again.
//   - The tunnel must then carry TLS whose ClientHello names, in its SNI, exactly that host:
//     nothing is forwarded upstream before that is checked. Plain bytes, another name, no
//     name and Encrypted Client Hello get a TLS access_denied alert. What happens inside the
//     TLS session is not seen (docs/package-egress.md, "What the boundary is").
//   - Bounded at every stage: accepted clients at admission, unsettled DNS lookups, tunnels,
//     a deadline per stage (head, DNS, connect, hello, idle), head size and tunnel bytes.
//   - Every refusal before the tunnel answers with a status line and an `X-Updraft-Egress`
//     header naming the stage and reason, which the shim turns into one stderr line.
//
// Dependency-free on purpose (Node.js built-ins only), like the sandbox runtime. Name
// resolution and connecting come in through `deps`, so the policy is tested without a network.
import dns from 'node:dns';
import net from 'node:net';

/** The public registries of the common ecosystems. A tenant adds its own with allowHosts. */
export const DEFAULT_REGISTRY_HOSTS = Object.freeze([
  // npm, Yarn, pnpm (and Corepack's downloads of them)
  'registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com',
  // Python: pip, uv, Poetry
  'pypi.org', 'files.pythonhosted.org',
  // Rust: cargo
  'index.crates.io', 'static.crates.io', 'crates.io',
  // Go modules
  'proxy.golang.org', 'sum.golang.org',
  // Ruby: gem, Bundler
  'rubygems.org', 'index.rubygems.org',
  // JVM: Maven Central
  'repo.maven.apache.org', 'repo1.maven.org',
  // .NET: NuGet
  'api.nuget.org',
]);

/**
 * Every stage of a connection is bounded. `maxClients` is a hard limit on live client sockets,
 * whatever their stage (request head, DNS, connect, TLS hello, tunnel, refusal being flushed):
 * Node destroys a connection beyond it on arrival;
 * `maxConnections` counts those past DNS (connecting, hello, tunnel); `maxPendingLookups`
 * counts resolver calls that have not settled, including ones whose deadline already passed,
 * so hung lookups cannot accumulate.
 */
export const DEFAULT_LIMITS = Object.freeze({
  ports: [443],
  maxClients: 64,
  maxConnections: 32,
  maxPendingLookups: 8, // distinct names being resolved
  headTimeoutMs: 10_000,
  dnsTimeoutMs: 5_000,
  connectTimeoutMs: 10_000,
  helloTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
  maxTunnelBytes: 2 * 1024 * 1024 * 1024,
  maxHeadBytes: 8192,
  maxHelloBytes: 16_384,
});

/** The header a refusal carries; egress-shim.mjs reads it. */
export const EGRESS_HEADER = 'X-Updraft-Egress';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A lower-case DNS name with at least two labels, or undefined. Pure. */
export function normalizeHost(text) {
  if (typeof text !== 'string') return undefined;
  let host = text.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253 || net.isIP(host) !== 0) return undefined;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  if (/^[0-9]+$/.test(labels.at(-1))) return undefined; // 10.0.0.1-like names that are not IP literals
  return host;
}

/**
 * An allowlist entry: `registry.example.com` (that name only) or `*.example.com` (any name
 * below example.com, not example.com itself). Throws on anything else: IP addresses, ports,
 * URLs, a bare `*`, or a wildcard over a public suffix with fewer than two labels. Pure.
 */
export function parseHostRule(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (raw.startsWith('*.')) {
    const suffix = normalizeHost(raw.slice(2));
    if (!suffix) throw new Error(`"${text}" is not a host name pattern (use registry.example.com or *.example.com)`);
    return { wildcard: true, host: suffix };
  }
  const host = normalizeHost(raw);
  if (!host) throw new Error(`"${text}" is not a host name (an allowlist names hosts, not addresses, URLs or ports)`);
  return { wildcard: false, host };
}

/** The allowlist from the defaults (unless turned off) and extra entries. Throws on a bad entry. Pure. */
export function buildAllowlist({ defaultRegistries = true, allowHosts = [] } = {}) {
  if (!Array.isArray(allowHosts)) throw new Error('allowHosts is not a list');
  const rules = [...(defaultRegistries ? DEFAULT_REGISTRY_HOSTS : []), ...allowHosts].map(parseHostRule);
  const seen = new Set();
  return rules.filter((rule) => {
    const key = `${rule.wildcard ? '*.' : ''}${rule.host}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether `host` (already normalized) is allowed by `rules`. Pure. */
export function hostAllowed(host, rules) {
  return rules.some((rule) => (rule.wildcard ? host.endsWith(`.${rule.host}`) : host === rule.host));
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function ipv4Octets(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  return octets.every((n, i) => /^\d{1,3}$/.test(parts[i]) && n <= 255) ? octets : undefined;
}

/** IPv4 ranges that are not the public internet, as [first octets..., prefix length, name]. */
const IPV4_BLOCKED = [
  [[0, 0, 0, 0], 8, 'unspecified'],
  [[10, 0, 0, 0], 8, 'private'],
  [[100, 64, 0, 0], 10, 'carrier-grade-nat'],
  [[127, 0, 0, 0], 8, 'loopback'],
  [[169, 254, 0, 0], 16, 'link-local'],
  [[172, 16, 0, 0], 12, 'private'],
  [[192, 0, 0, 0], 24, 'reserved'],
  [[192, 0, 2, 0], 24, 'documentation'],
  [[192, 88, 99, 0], 24, 'reserved'],
  [[192, 168, 0, 0], 16, 'private'],
  [[198, 18, 0, 0], 15, 'benchmarking'],
  [[198, 51, 100, 0], 24, 'documentation'],
  [[203, 0, 113, 0], 24, 'documentation'],
  [[224, 0, 0, 0], 4, 'multicast'],
  [[240, 0, 0, 0], 4, 'reserved'],
];

function ipv4Value(octets) {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function classifyIpv4(octets) {
  const value = ipv4Value(octets);
  for (const [base, bits, name] of IPV4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (ipv4Value(base) & mask) >>> 0) return name;
  }
  return 'public';
}

/** The eight 16-bit groups of an IPv6 address, or undefined. Pure. */
export function ipv6Groups(text) {
  let address = String(text).toLowerCase();
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  if (net.isIPv6(address) === false) return undefined;
  const lastColon = address.lastIndexOf(':');
  if (address.slice(lastColon + 1).includes('.')) {
    // A trailing dotted quad (::ffff:10.0.0.1) is the last two groups.
    const o = ipv4Octets(address.slice(lastColon + 1));
    if (!o) return undefined;
    address = `${address.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = address.split('::');
  const parse = (part) => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  let groups;
  if (halves.length === 2) {
    const head = parse(halves[0]);
    const rest = parse(halves[1]);
    groups = [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest];
  } else groups = parse(address);
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}

/**
 * "public" for an address on the public internet; otherwise the name of the range that keeps
 * the proxy from connecting to it ("loopback", "private", "link-local", ...). Pure.
 */
export function classifyAddress(text) {
  const v4 = ipv4Octets(String(text));
  if (v4) return classifyIpv4(v4);
  const g = ipv6Groups(text);
  if (!g) return 'invalid';
  const embedded = () => classifyIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  // ::ffff:a.b.c.d and the NAT64 prefix carry an IPv4 address: judge that address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded();
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded();
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local'; // fc00::/7, includes fd00:ec2::254
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
  if (g[0] === 0x2001 && g[1] < 0x0200) return 'reserved'; // 2001::/23: Teredo, ORCHID, benchmarking...
  if (g[0] === 0x2002) return 'reserved'; // 6to4 relays an IPv4 address we cannot judge
  if ((g[0] & 0xe000) !== 0x2000) return 'reserved'; // only 2000::/3 is global unicast
  return 'public';
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/** What a refusal's status line says, by reason. */
const STATUS = {
  'bad-request': [400, 'Bad Request'],
  'https-only': [405, 'Method Not Allowed'],
  'not-allowed': [403, 'Forbidden'],
  'ip-literal': [403, 'Forbidden'],
  'port-not-allowed': [403, 'Forbidden'],
  'non-public-address': [403, 'Forbidden'],
  'dns-failure': [502, 'Bad Gateway'],
  'dns-timeout': [504, 'Gateway Timeout'],
  'request-timeout': [408, 'Request Timeout'],
  'connect-failed': [502, 'Bad Gateway'],
  'connect-timeout': [504, 'Gateway Timeout'],
  'too-many-connections': [503, 'Service Unavailable'],
};

/** A host or detail safe to put in a header and a log line: bounded, printable, no separators. */
export function sanitize(text, max = 120) {
  return String(text ?? '').replace(/[^A-Za-z0-9._:*\-[\]]/g, '?').slice(0, max);
}

/** What the refusal means to the person reading the command's output. */
export function explain(reason, target) {
  switch (reason) {
    case 'not-allowed': return `${target} is not an allowed package registry; add it to the worker's egress allowHosts if the repository needs it`;
    case 'ip-literal': return `${target} is an address; only allowed registry host names are reachable`;
    case 'port-not-allowed': return `${target} uses a port the egress policy does not allow`;
    case 'non-public-address': return `${target} resolves to a non-public address, which is never reachable from a job`;
    case 'dns-failure': return `${target} could not be resolved`;
    case 'dns-timeout': return `resolving ${target} took too long`;
    case 'request-timeout': return 'the request was not sent in time';
    case 'connect-failed': return `${target} refused or dropped the connection`;
    case 'connect-timeout': return `${target} did not answer in time`;
    case 'too-many-connections': return 'too many registry connections are open at once';
    case 'https-only': return 'only HTTPS (CONNECT) requests to package registries are allowed';
    default: return 'the proxy could not read the request';
  }
}

/** The bytes of one refusal response. Pure. */
export function refusal(reason, target = '', detail = '') {
  const [code, text] = STATUS[reason] ?? STATUS['bad-request'];
  const safeTarget = sanitize(target);
  const parts = [`reason=${reason}`, ...(safeTarget ? [`target=${safeTarget}`] : []), ...(detail ? [`detail=${sanitize(detail, 40)}`] : [])];
  const body = `Updraft egress refused (${reason}): ${explain(reason, safeTarget || 'the target')}\n`;
  return Buffer.from([
    `HTTP/1.1 ${code} ${text}`,
    `${EGRESS_HEADER}: ${parts.join('; ')}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n'));
}

/**
 * The request head as { method, host, port } or { reason }. Accepts `CONNECT host:port
 * HTTP/1.x`. A bracketed IPv6 or an IPv4 literal is an ip-literal; anything else is refused. Pure.
 */
export function parseConnect(head, { ports = DEFAULT_LIMITS.ports } = {}) {
  const line = String(head).split('\r\n', 1)[0];
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line);
  if (!m) return { reason: 'bad-request' };
  if (m[1] !== 'CONNECT') return { reason: 'https-only', target: m[1] };
  const target = m[2];
  const hp = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(target);
  if (!hp) return { reason: 'bad-request', target };
  const port = Number(hp[2]);
  const rawHost = hp[1].replace(/^\[|\]$/g, '');
  if (net.isIP(rawHost) !== 0) return { reason: 'ip-literal', target };
  const host = normalizeHost(rawHost);
  if (!host) return { reason: 'bad-request', target };
  if (!ports.includes(port)) return { reason: 'port-not-allowed', target: `${host}:${port}` };
  return { method: 'CONNECT', host, port, target: `${host}:${port}` };
}

async function defaultResolve(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

function defaultConnect({ address, port, family }) {
  return net.connect({ host: address, port, family });
}

/**
 * Decide where a parsed CONNECT may go: { address, family } of the first public address, or
 * { reason }. Every address of the name is checked, so a name that also resolves inward is
 * refused as a whole rather than raced.
 */
export async function vetTarget({ host }, rules, resolve = defaultResolve) {
  if (!hostAllowed(host, rules)) return { reason: 'not-allowed' };
  let addresses;
  try {
    addresses = await resolve(host);
  } catch (error) {
    if (error?.code === 'EGRESS_DNS_TIMEOUT') return { reason: 'dns-timeout' };
    return { reason: 'dns-failure', detail: error?.code ?? 'lookup failed' };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { reason: 'dns-failure', detail: 'no addresses' };
  for (const a of addresses) {
    const kind = classifyAddress(a.address);
    if (kind !== 'public') return { reason: 'non-public-address', detail: kind };
  }
  return { address: addresses[0].address, family: addresses[0].family };
}

// ---------------------------------------------------------------------------
// TLS: what a tunnel must start with
// ---------------------------------------------------------------------------

/** A fatal TLS alert, access_denied: the answer to a tunnel whose first bytes are refused. */
export const TLS_ACCESS_DENIED = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]);

const EXT_SERVER_NAME = 0x0000;
const EXT_ENCRYPTED_CLIENT_HELLO = 0xfe0d;

/**
 * Read the TLS ClientHello at the start of `buffer` (one or more handshake records). Pure.
 * Returns { incomplete: true } while more bytes are needed, { sni } when it names exactly one
 * host, or { error } with: "not-tls" (the bytes are not a TLS handshake), "no-sni",
 * "opaque-handshake" (Encrypted Client Hello: the visible name is not the real one), or
 * "malformed" (including a hello larger than `maxBytes`).
 */
export function parseClientHello(buffer, maxBytes = DEFAULT_LIMITS.maxHelloBytes) {
  if (buffer.length >= 1 && buffer[0] !== 0x16) return { error: 'not-tls' };
  if (buffer.length >= 2 && buffer[1] !== 0x03) return { error: 'not-tls' };
  // Collect the handshake bytes of consecutive handshake records.
  const parts = [];
  let offset = 0;
  let collected = 0;
  let needed;
  while (needed === undefined || collected < needed) {
    if (offset + 5 > buffer.length) return offset + 5 > maxBytes + 5 ? { error: 'malformed' } : { incomplete: true };
    if (buffer[offset] !== 0x16 || buffer[offset + 1] !== 0x03) return { error: offset === 0 ? 'not-tls' : 'malformed' };
    const length = buffer.readUInt16BE(offset + 3);
    if (length === 0 || length > 16_384) return { error: 'malformed' };
    if (offset + 5 + length > buffer.length) return offset + 5 + length > maxBytes + 64 ? { error: 'malformed' } : { incomplete: true };
    parts.push(buffer.subarray(offset + 5, offset + 5 + length));
    collected += length;
    offset += 5 + length;
    if (needed === undefined && collected >= 4) {
      const first = Buffer.concat(parts);
      if (first[0] !== 0x01) return { error: 'malformed' }; // not a ClientHello
      needed = 4 + first.readUIntBE(1, 3);
      if (needed > maxBytes) return { error: 'malformed' };
    }
  }
  const hello = Buffer.concat(parts).subarray(4, needed);
  let at = 2 + 32; // legacy_version, random
  const take = (n) => {
    if (at + n > hello.length) throw new Error('short');
    const out = hello.subarray(at, at + n);
    at += n;
    return out;
  };
  try {
    take(take(1)[0]); // session id
    take(take(2).readUInt16BE(0)); // cipher suites
    take(take(1)[0]); // compression methods
    if (at === hello.length) return { error: 'no-sni' };
    const extensions = take(take(2).readUInt16BE(0));
    let sni;
    for (let e = 0; e < extensions.length;) {
      if (e + 4 > extensions.length) return { error: 'malformed' };
      const type = extensions.readUInt16BE(e);
      const length = extensions.readUInt16BE(e + 2);
      const data = extensions.subarray(e + 4, e + 4 + length);
      if (data.length !== length) return { error: 'malformed' };
      e += 4 + length;
      if (type === EXT_ENCRYPTED_CLIENT_HELLO) return { error: 'opaque-handshake' };
      if (type !== EXT_SERVER_NAME) continue;
      if (sni !== undefined || data.length < 2 || data.readUInt16BE(0) !== data.length - 2) return { error: 'malformed' };
      for (let n = 2; n < data.length;) {
        if (n + 3 > data.length) return { error: 'malformed' };
        const nameType = data[n];
        const nameLength = data.readUInt16BE(n + 1);
        const name = data.subarray(n + 3, n + 3 + nameLength);
        if (name.length !== nameLength) return { error: 'malformed' };
        n += 3 + nameLength;
        if (nameType !== 0) continue;
        if (sni !== undefined) return { error: 'malformed' };
        sni = name.toString('latin1');
      }
    }
    return sni === undefined ? { error: 'no-sni' } : { sni };
  } catch {
    return { error: 'malformed' };
  }
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/**
 * The proxy server (not yet listening). `options.rules` is buildAllowlist's result.
 * `deps.resolve(host)` and `deps.connect({address, port, family})` replace DNS and TCP;
 * `deps.log(record)` receives one object per decision and per closed tunnel (no payload bytes,
 * no request headers beyond the target).
 *
 * Each accepted socket moves through head -> dns -> connect -> hello -> tunnel, each stage
 * with its own deadline. Ending is terminal and happens once (`finish`): timers, listeners,
 * the upstream socket and the slots it held are released together, and anything that
 * arrives later (a resolver answer, a connect) is ignored.
 *
 * The trust boundary: a tunnel carries TLS whose ClientHello names, in its SNI, exactly the
 * allowed host the CONNECT named, to an address that host resolved to and that is public.
 * Nothing is forwarded upstream before that is checked. What happens inside the TLS session
 * is not seen (see docs/package-egress.md, "What the boundary is").
 */
export function createEgressProxy(options, deps = {}) {
  const rules = options.rules;
  if (!Array.isArray(rules)) throw new Error('the egress proxy needs an allowlist');
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const resolveName = deps.resolve ?? defaultResolve;
  const connect = deps.connect ?? defaultConnect;
  const log = deps.log ?? (() => {});
  const stats = { allowed: 0, denied: 0, dropped: 0, clients: 0, open: 0, lookups: 0 };
  const sockets = new Set();

  /**
   * Name lookups. Concurrent requests for one name share a single resolver call (a package
   * manager opens many tunnels to one registry at once). Each call has exactly one completion
   * handler, which settles the waiters attached at that moment. A request waits as a waiter
   * that is detached on its own deadline and when its connection ends, so a resolver that never
   * settles holds one entry here, not one per request. Each distinct name counts against
   * maxPendingLookups until its call settles, deadline or not.
   */
  const lookups = new Map(); // host -> { waiters: Set<waiter> }
  const lookupAllowed = (host) => lookups.has(host) || lookups.size < limits.maxPendingLookups;
  const lookup = (host) => {
    let entry = lookups.get(host);
    if (!entry) {
      entry = { waiters: new Set() };
      const current = entry;
      lookups.set(host, current);
      stats.lookups = lookups.size;
      const settle = (ok, value) => {
        if (lookups.get(host) === current) lookups.delete(host);
        stats.lookups = lookups.size;
        for (const waiter of [...current.waiters]) waiter.done(ok, value);
      };
      Promise.resolve().then(() => resolveName(host)).then((value) => settle(true, value), (error) => settle(false, error));
    }
    const waiters = entry.waiters;
    const waiter = {};
    const promise = new Promise((resolveWaiter, rejectWaiter) => {
      waiter.done = (ok, value) => {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        if (ok) resolveWaiter(value);
        else rejectWaiter(value);
      };
    });
    waiter.timer = setTimeout(() => waiter.done(false, Object.assign(new Error('dns timeout'), { code: 'EGRESS_DNS_TIMEOUT' })), limits.dnsTimeoutMs);
    waiters.add(waiter);
    // Detached, the waiter's promise never settles and nothing references it any more.
    const cancel = () => { clearTimeout(waiter.timer); waiters.delete(waiter); };
    return { promise, cancel };
  };

  const server = net.createServer((client) => {
    // Admitted: counted (stats.clients, and by Node for maxConnections) until the socket has
    // physically closed, refusal and flush included.
    sockets.add(client);
    stats.clients += 1;
    client.on('error', () => {});
    client.once('close', () => { sockets.delete(client); stats.clients -= 1; });

    let stage = 'head';
    let done = false;
    let timer;
    let upstream;
    let tunnelSlot = false;
    let request;
    let vetted;
    let cancelLookup;
    let buffered = Buffer.alloc(0);
    const arm = (ms, onTimeout) => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, ms);
    };

    /** End this connection, once. `reason` answers it (an HTTP refusal before the 200, a TLS alert after). */
    const finish = (reason, detail = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.removeListener('data', onData);
      cancelLookup?.();
      if (tunnelSlot) stats.open -= 1;
      if (upstream) {
        upstream.removeAllListeners('connect');
        upstream.on('error', () => {});
        upstream.destroy();
      }
      if (reason) {
        stats.denied += 1;
        log({ event: 'egress', decision: 'deny', reason, target: sanitize(request?.target ?? ''), ...(detail ? { detail: sanitize(detail, 40) } : {}) });
        if (stage === 'hello') client.end(TLS_ACCESS_DENIED);
        else client.end(refusal(reason, request?.target ?? '', detail));
        const kill = setTimeout(() => client.destroy(), 1000);
        client.once('close', () => clearTimeout(kill));
      } else client.destroy();
    };
    client.once('close', () => {
      if (!done) {
        if (stage !== 'tunnel') log({ event: 'egress', decision: 'aborted', stage, target: sanitize(request?.target ?? '') });
        finish();
      }
    });

    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === 'head') onHead();
      else if (stage === 'hello') onHello();
      else if (buffered.length > limits.maxHelloBytes + limits.maxHeadBytes) finish('bad-request', 'sent before the tunnel');
    };

    const onHead = () => {
      const end = buffered.indexOf('\r\n\r\n');
      // The head's size is checked whether or not it is complete.
      if ((end === -1 ? buffered.length : end + 4) > limits.maxHeadBytes) { finish('bad-request', 'head too large'); return; }
      if (end === -1) return;
      request = parseConnect(buffered.subarray(0, end).toString('latin1'), limits);
      buffered = buffered.subarray(end + 4);
      if (request.reason) { const reason = request.reason; request = { target: request.target }; finish(reason); return; }
      if (!lookupAllowed(request.host)) { finish('too-many-connections', 'lookups'); return; }
      stage = 'dns';
      clearTimeout(timer); // the resolver has its own deadline
      const resolveForThis = (host) => {
        const pending = lookup(host);
        cancelLookup = pending.cancel;
        return pending.promise;
      };
      void vetTarget(request, rules, resolveForThis).then(onVetted, () => finish('dns-failure'));
    };

    const onVetted = (target) => {
      if (done) return; // the peer left, or the connection ended, while the name resolved
      cancelLookup = undefined;
      if (target.reason) { finish(target.reason, target.detail); return; }
      if (stats.open >= limits.maxConnections) { finish('too-many-connections'); return; }
      stats.open += 1;
      tunnelSlot = true;
      vetted = target;
      stage = 'connect';
      arm(limits.connectTimeoutMs, () => finish('connect-timeout'));
      upstream = connect({ address: target.address, port: request.port, family: target.family });
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.on('error', (error) => {
        if (stage === 'tunnel') client.destroy();
        else finish(stage === 'hello' ? '' : 'connect-failed', error?.code ?? '');
      });
      upstream.once('connect', () => {
        if (done) return;
        // Nothing reaches the registry until the client's first bytes are checked.
        upstream.pause();
        stage = 'hello';
        arm(limits.helloTimeoutMs, () => finish('tls-required', 'no client hello'));
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        onHello();
      });
    };

    const onHello = () => {
      if (buffered.length === 0) return;
      const hello = parseClientHello(buffered, limits.maxHelloBytes);
      if (hello.incomplete) return;
      if (hello.error) { finish(hello.error === 'not-tls' ? 'tls-required' : `tls-${hello.error}`); return; }
      if (normalizeHost(hello.sni) !== request.host) { finish('tls-authority-mismatch', sanitize(hello.sni, 40)); return; }
      startTunnel();
    };

    const startTunnel = () => {
      stage = 'tunnel';
      clearTimeout(timer);
      client.removeListener('data', onData);
      stats.allowed += 1;
      log({ event: 'egress', decision: 'allow', target: request.target, address: vetted.address });
      let bytes = 0;
      const count = (chunk) => {
        bytes += chunk.length;
        if (bytes > limits.maxTunnelBytes) { client.destroy(); upstream.destroy(); }
      };
      client.on('data', count);
      upstream.on('data', count);
      for (const s of [client, upstream]) s.setTimeout(limits.idleTimeoutMs, () => { client.destroy(); upstream.destroy(); });
      upstream.write(buffered);
      buffered = Buffer.alloc(0);
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.resume();
      upstream.once('close', () => client.destroy());
      client.once('close', () => {
        upstream.destroy();
        log({ event: 'egress', decision: 'closed', target: request.target, bytes });
      });
    };

    arm(limits.headTimeoutMs, () => finish('request-timeout'));
    client.on('data', onData);
  });

  // The hard limit: beyond maxClients live sockets (admitted ones count until they close),
  // Node destroys a new connection at once, before any handler, timer or write. No answer is
  // sent; the shim reports a connection closed without one as "proxy-busy".
  server.maxConnections = limits.maxClients;
  let lastDropLog = 0;
  server.on('drop', () => {
    stats.dropped += 1;
    const now = Date.now();
    if (now - lastDropLog >= 1000) {
      lastDropLog = now;
      log({ event: 'egress', decision: 'drop', reason: 'too-many-connections', dropped: stats.dropped });
    }
  });

  return {
    server,
    stats,
    /** What is actually held: live sockets (clients and upstreams), lookups and attached waiters. */
    live() {
      let waiters = 0;
      for (const entry of lookups.values()) waiters += entry.waiters.size;
      return { sockets: sockets.size, lookups: lookups.size, waiters };
    },
    /** Stop accepting and drop every open connection. */
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/**
 * The egress section of a worker config, validated, as { rules, limits }. `undefined` means
 * egress is off. Throws on unknown keys or bad values. Pure.
 */
export function parseEgressConfig(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('egress is not an object');
  const known = new Set(['defaultRegistries', 'allowHosts', 'ports', 'maxConnections', 'shim']);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`egress: unknown key "${key}"`);
  if (raw.defaultRegistries !== undefined && typeof raw.defaultRegistries !== 'boolean') throw new Error('egress.defaultRegistries is not true or false');
  const rules = buildAllowlist({ defaultRegistries: raw.defaultRegistries ?? true, allowHosts: raw.allowHosts ?? [] });
  if (rules.length === 0) throw new Error('egress allows no host; remove the egress section to keep the network off');
  const limits = {};
  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports) || raw.ports.length === 0 || raw.ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('egress.ports is not a list of ports');
    limits.ports = [...new Set(raw.ports)];
  }
  if (raw.maxConnections !== undefined) {
    if (!Number.isInteger(raw.maxConnections) || raw.maxConnections < 1 || raw.maxConnections > 256) throw new Error('egress.maxConnections is not 1 to 256');
    limits.maxConnections = raw.maxConnections;
  }
  if (typeof raw.shim !== 'string' || !raw.shim.startsWith('/') || !raw.shim.startsWith('/usr/')) throw new Error('egress.shim must be an absolute path under /usr, which the sandbox mounts');
  return { rules, limits, shim: raw.shim };
}
