// A custom telemetry destination, as the runner checks it before it sends (the API checked it
// before it was saved: cloud/server/src/tenants/otlp-destination.ts, the same rules). HTTPS to a
// DNS name that resolves only to public addresses, never an IP literal or an internal name, no
// credentials, query or fragment in the URL; one header, not one the runner or fetch sets itself.

import dns from 'node:dns';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'connection', 'transfer-encoding', 'te', 'upgrade', 'expect', 'keep-alive', 'cookie', 'trailer']);
const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.localdomain'];

/** `{ endpoint, tracesUrl, host }`, or null when it is not one the runner sends to. */
export function parseOtlpEndpoint(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 512) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || isIP(host) || !host.includes('.') || host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return null;
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return { endpoint, tracesUrl: /\/v1\/traces$/.test(endpoint) ? endpoint : `${endpoint}/v1/traces`, host };
}

export function headerNameOk(raw) {
  return typeof raw === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(raw) && !RESERVED_HEADERS.has(raw) && !raw.startsWith('proxy-');
}

/** Whether an address is on the public internet: not loopback, private, link-local, shared, reserved or multicast. */
export function isPublicAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicAddress(mapped[1]);
    if (x === '::' || x === '::1') return false;
    const first = parseInt(x.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
    if (x.startsWith('64:ff9b:') || x.startsWith('2001:db8:') || x.startsWith('100::')) return false;
    return true;
  }
  return false;
}

/** The host resolves, and only to public addresses. Never throws. */
export async function resolvesPublic(host, resolve = async (h) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address)) {
  try {
    const addresses = await resolve(host);
    return addresses.length > 0 && addresses.every(isPublicAddress);
  } catch {
    return false;
  }
}

/**
 * A DNS lookup for net and tls that answers only with public addresses: the connection is made to
 * the addresses it vetted, so a name that resolves differently by the time of the request still
 * reaches no private one. The certificate is still checked against the host name.
 */
export function publicOnlyLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options ?? {});
    resolve(hostname, { ...opts, all: true, verbatim: true }, (error, addresses) => {
      if (error) return cb(error);
      const list = Array.isArray(addresses) ? addresses : [];
      if (!list.length || !list.every((a) => isPublicAddress(a.address))) {
        const refused = new Error(`${hostname} does not resolve only to public addresses`);
        refused.code = 'ENOTPUBLIC';
        return cb(refused);
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

/**
 * A fetch for a custom destination: HTTPS only, over the public-only lookup, never following a
 * redirect (a 3xx is the answer), with the answer's body read up to 64 KiB. What the exporter
 * needs of fetch: { ok, status, text() }.
 */
export function publicOnlyFetch({ lookup: lookupImpl = publicOnlyLookup(), request = https.request } = {}) {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      if (target.protocol !== 'https:') return reject(new Error('only https'));
      const req = request(target, { method: init.method ?? 'GET', headers: init.headers ?? {}, lookup: lookupImpl, signal: init.signal }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (size < 65536) chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 65536);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => body });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}
