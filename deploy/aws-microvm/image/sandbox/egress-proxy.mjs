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
//   - Bounded: concurrent tunnels, connect and idle time, and bytes per tunnel.
//   - Every refusal answers with a status line and an `X-Updraft-Egress` header that name the
//     stage and reason, which the shim turns into one stderr line for the command's output.
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

export const DEFAULT_LIMITS = Object.freeze({
  ports: [443],
  maxConnections: 32,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
  maxTunnelBytes: 2 * 1024 * 1024 * 1024,
  maxHeadBytes: 8192,
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
    return { reason: 'dns-failure', detail: error?.code ?? 'lookup failed' };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { reason: 'dns-failure', detail: 'no addresses' };
  for (const a of addresses) {
    const kind = classifyAddress(a.address);
    if (kind !== 'public') return { reason: 'non-public-address', detail: kind };
  }
  return { address: addresses[0].address, family: addresses[0].family };
}

/**
 * The proxy server (not yet listening). `options.rules` is buildAllowlist's result.
 * `deps.resolve(host)` and `deps.connect({address, port, family})` replace DNS and TCP;
 * `deps.log(record)` receives one object per decision and per closed tunnel (no payload bytes,
 * no request headers beyond the target).
 */
export function createEgressProxy(options, deps = {}) {
  const rules = options.rules;
  if (!Array.isArray(rules)) throw new Error('the egress proxy needs an allowlist');
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const resolve = deps.resolve ?? defaultResolve;
  const connect = deps.connect ?? defaultConnect;
  const log = deps.log ?? (() => {});
  const stats = { allowed: 0, denied: 0, open: 0 };
  const sockets = new Set();

  const server = net.createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let head = Buffer.alloc(0);
    let settled = false;
    const deny = (reason, target = '', detail = '') => {
      if (settled) return;
      settled = true;
      stats.denied += 1;
      log({ event: 'egress', decision: 'deny', reason, target: sanitize(target), ...(detail ? { detail: sanitize(detail, 40) } : {}) });
      client.end(refusal(reason, target, detail));
    };
    const headTimer = setTimeout(() => deny('bad-request', '', 'no request'), limits.connectTimeoutMs);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > limits.maxHeadBytes) { clearTimeout(headTimer); client.off('data', onData); deny('bad-request', '', 'head too large'); }
        return;
      }
      clearTimeout(headTimer);
      client.off('data', onData);
      client.pause();
      const rest = head.subarray(end + 4);
      const request = parseConnect(head.subarray(0, end).toString('latin1'), limits);
      if (request.reason) { deny(request.reason, request.target); return; }
      if (stats.open >= limits.maxConnections) { deny('too-many-connections', request.target); return; }
      stats.open += 1;
      let released = false;
      const release = () => { if (!released) { released = true; stats.open -= 1; } };
      client.once('close', release);
      void vetTarget(request, rules, resolve).then((target) => {
        if (client.destroyed) { release(); return; }
        if (target.reason) { release(); deny(target.reason, request.target, target.detail); return; }
        const upstream = connect({ address: target.address, port: request.port, family: target.family });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        const timer = setTimeout(() => { upstream.destroy(); release(); deny('connect-timeout', request.target); }, limits.connectTimeoutMs);
        upstream.on('error', (error) => {
          clearTimeout(timer);
          // Before the tunnel: answer with the reason. After it: just end both sides.
          if (!settled) { release(); deny('connect-failed', request.target, error?.code ?? ''); }
          else client.destroy();
        });
        upstream.once('connect', () => {
          clearTimeout(timer);
          if (settled || client.destroyed) { upstream.destroy(); return; }
          settled = true;
          stats.allowed += 1;
          log({ event: 'egress', decision: 'allow', target: request.target, address: target.address });
          let bytes = 0;
          const count = (chunk) => {
            bytes += chunk.length;
            if (bytes > limits.maxTunnelBytes) { client.destroy(); upstream.destroy(); }
          };
          client.on('data', count);
          upstream.on('data', count);
          for (const s of [client, upstream]) s.setTimeout(limits.idleTimeoutMs, () => { client.destroy(); upstream.destroy(); });
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (rest.length) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
          upstream.once('close', () => client.destroy());
          client.once('close', () => {
            upstream.destroy();
            log({ event: 'egress', decision: 'closed', target: request.target, bytes });
          });
        });
      }, () => { release(); deny('dns-failure', request.target); });
    };
    client.on('data', onData);
  });

  return {
    server,
    stats,
    /** Stop accepting and drop every open tunnel. */
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
