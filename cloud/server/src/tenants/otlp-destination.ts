import dns, { type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/**
 * A custom telemetry destination: any OTLP/HTTP endpoint that takes JSON, with one header that
 * carries the tenant's secret (`authorization: Bearer …`, `x-api-key: …`, ...). The runner sends
 * to `<endpoint>/v1/traces`, or to the endpoint itself when it already ends in `/v1/traces` (the
 * OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_TRACES_ENDPOINT forms).
 *
 * The API checks it before it is saved, and the runner checks it again before it sends: HTTPS to a
 * DNS name (no IP literal, no single-label or internal name), on any port, no credentials, query
 * or fragment in the URL, and every address the name resolves to public. A request to it never
 * follows a redirect.
 */

export const MAX_ENDPOINT_CHARS = 512;
/** Headers the runner and fetch set themselves, or that would change how the request travels. */
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'connection', 'transfer-encoding', 'te', 'upgrade', 'expect', 'keep-alive', 'cookie', 'trailer']);
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** A header value: printable ASCII, no line breaks, not starting or ending with a space. */
const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]{6,4094})[\x21-\x7e]$/;
const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.localdomain'];

export type EndpointProblem = { problem: string };

/** The endpoint as the runner will send to it, or why it cannot be one. */
export function parseOtlpEndpoint(raw: unknown): { endpoint: string; tracesUrl: string; host: string } | EndpointProblem {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > MAX_ENDPOINT_CHARS) return { problem: 'The endpoint is an https:// URL of at most 512 characters' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { problem: 'The endpoint is not a URL' };
  }
  if (url.protocol !== 'https:') return { problem: 'The endpoint must use https://' };
  if (url.username || url.password) return { problem: 'Put the credentials in the header, not in the URL' };
  if (url.search || url.hash) return { problem: 'The endpoint has no query string or fragment' };
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) || host.startsWith('[')) return { problem: 'The endpoint is a DNS name, not an IP address' };
  if (!host.includes('.') || host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return { problem: 'The endpoint must be a public DNS name' };
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const tracesUrl = /\/v1\/traces$/.test(base) ? base : `${base}/v1/traces`;
  return { endpoint: base, tracesUrl, host };
}

export function headerNameProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !HEADER_NAME.test(raw)) return 'The header name is letters, digits and dashes, starting with a letter';
  if (RESERVED_HEADERS.has(raw.toLowerCase()) || raw.toLowerCase().startsWith('proxy-')) return `The ${raw} header cannot carry the key`;
  return null;
}

export const headerValueOk = (raw: string) => HEADER_VALUE.test(raw);

/** Whether an address is on the public internet: not loopback, private, link-local, shared, reserved or multicast. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // shared address space (CGNAT)
    if (a === 169 && b === 254) return false; // link-local, the instance metadata service
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(Number(ip.split('.')[2]))))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && Number(ip.split('.')[2]) === 100))) return false;
    if (a === 203 && b === 0 && Number(ip.split('.')[2]) === 113) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (x === '::' || x === '::1') return false;
    const first = parseInt(x.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // unique local
    if ((first & 0xffc0) === 0xfe80) return false; // link-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (x.startsWith('64:ff9b:') || x.startsWith('2001:db8:') || x.startsWith('100::')) return false;
    return true;
  }
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
export const resolveAll: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The endpoint's host resolves, and only to public addresses. */
export async function resolvesPublic(host: string, resolve: Resolver = resolveAll): Promise<boolean> {
  try {
    const addresses = await resolve(host);
    return addresses.length > 0 && addresses.every(isPublicAddress);
  } catch {
    return false;
  }
}

/** `detail`: the start of the answer's body, for a caller that knows what its endpoint says in it. */
export type OtlpCheck = { result: 'valid' } | { result: 'invalid' } | { result: 'not_otlp'; status: number; detail?: string } | { result: 'unreachable'; reason: string };
export type OtlpChecker = (destination: { tracesUrl: string; host: string; header: string }, value: string) => Promise<OtlpCheck>;

/**
 * A DNS lookup for net and tls that answers only with public addresses: the connection is made to
 * the addresses it vetted, so a name that resolves differently by the time of the request still
 * reaches no private one. The certificate is still checked against the host name.
 */
export function publicOnlyLookup(resolve: typeof dns.lookup = dns.lookup): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, '');
      const list = Array.isArray(addresses) ? addresses : [];
      if (!list.length || !list.every((a) => isPublicAddress(a.address))) {
        const refused: NodeJS.ErrnoException = new Error(`${hostname} does not resolve only to public addresses`);
        refused.code = 'ENOTPUBLIC';
        return callback(refused, '');
      }
      if (options?.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as LookupFunction;
}

/** A fetch over the public-only lookup, HTTPS only, never following a redirect: what the check needs of fetch. */
export function publicOnlyFetch(lookupImpl: LookupFunction = publicOnlyLookup()): typeof fetch {
  return ((url: string, init: RequestInit = {}) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      if (target.protocol !== 'https:') return reject(new Error('only https'));
      const req = https.request(target, { method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, lookup: lookupImpl, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size < 65536) chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 65536);
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text: async () => body } as Response);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (typeof init.body === 'string') req.write(init.body);
      req.end();
    })) as typeof fetch;
}

/**
 * An empty export (`{"resourceSpans":[]}`) with the header: what any OTLP/HTTP receiver that takes
 * JSON accepts, and a receiver that wants a key refuses without it. Nothing is recorded by it.
 */
export const checkOtlpEndpoint = (fetchFn: typeof fetch = publicOnlyFetch(), resolve: Resolver = resolveAll, timeoutMs = 8000): OtlpChecker =>
  async ({ tracesUrl, host, header }, value) => {
    if (!(await resolvesPublic(host, resolve))) return { result: 'unreachable', reason: 'its name does not resolve to a public address' };
    try {
      const res = await fetchFn(tracesUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [header]: value },
        body: '{"resourceSpans":[]}',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) return { result: 'invalid' };
      if (res.status >= 300 && res.status < 400) return { result: 'unreachable', reason: 'it answered with a redirect, which is never followed' };
      if (res.ok) return { result: 'valid' };
      if ([400, 404, 405, 406, 415].includes(res.status)) {
        const detail = typeof res.text === 'function' ? (await res.text().catch(() => '')).slice(0, 300) : '';
        return { result: 'not_otlp', status: res.status, ...(detail ? { detail } : {}) };
      }
      return { result: 'unreachable', reason: `it answered HTTP ${res.status}` };
    } catch (error) {
      return { result: 'unreachable', reason: (error as Error)?.name === 'TimeoutError' ? 'it did not answer in time' : 'it could not be reached' };
    }
  };

/**
 * CloudWatch: X-Ray's OTLP traces endpoint in an AWS region, which takes an X-Ray API key as
 * `Authorization: Bearer <key>` (docs.aws.amazon.com/xray/latest/devguide/xray-opentelemetry-bearer-token.html).
 */
export const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$/;
export const cloudWatchEndpoint = (region: string) => `https://xray.${region}.amazonaws.com`;
/** An X-Ray API key (its ServiceCredentialSecret): no spaces; "Bearer " is added here. */
export const CLOUDWATCH_KEY = /^[A-Za-z0-9+/=_.-]{16,512}$/;

/**
 * A trace in the CloudWatch console. AWS documents no link to a trace: this is the form its
 * console uses today, with the trace id in X-Ray's form (1-<first 8 hex>-<the other 24>).
 */
export const cloudWatchTraceUrl = (region: string, traceId: string) =>
  `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:traces/1-${traceId.slice(0, 8)}-${traceId.slice(8)}`;

/**
 * A link template for a custom destination (`links.trace`, `links.conversation`): an https URL
 * whose host is written out, with placeholders in its path and query only. Values are
 * URL-encoded; times are UNIX seconds ({start}, {end}) or milliseconds ({start_ms}, {end_ms}).
 */
export const TRACE_LINK_PLACEHOLDERS = ['trace_id', 'span_id', 'start', 'end', 'start_ms', 'end_ms', 'service'] as const;
export const CONVERSATION_LINK_PLACEHOLDERS = ['conversation', 'start', 'end', 'start_ms', 'end_ms', 'service'] as const;

export function linkTemplateProblem(raw: unknown, allowed: readonly string[], required: string): string | null {
  if (typeof raw !== 'string' || raw.length > 1024) return 'A link template is an https:// URL of at most 1024 characters';
  if (!/^[A-Za-z0-9{}/:._~?&=%#+@!$*,;-]+$/.test(raw)) return 'A link template has only URL characters and {placeholders}';
  const m = /^https:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)(\/.*)?$/.exec(raw);
  if (!m || !m[1]!.includes('.')) return 'A link template starts with https:// and a host written out';
  const names = [...raw.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]!);
  const bad = names.find((n) => !allowed.includes(n));
  if (bad !== undefined) return `{${bad}} is not a placeholder here; use ${allowed.map((a) => `{${a}}`).join(' ')}`;
  if (raw.replace(/\{[a-z_]+\}/g, '').match(/[{}]/)) return 'Every brace in a link template is part of a {placeholder}';
  if (!names.includes(required)) return `A link template names {${required}}`;
  return null;
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => encodeURIComponent(values[name] ?? ''));
}
