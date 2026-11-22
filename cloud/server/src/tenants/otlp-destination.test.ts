import { describe, expect, it, vi } from 'vitest';
import { checkOtlpEndpoint, fillTemplate, headerNameProblem, isPublicAddress, linkTemplateProblem, parseOtlpEndpoint, TRACE_LINK_PLACEHOLDERS } from './otlp-destination.js';

const destination = { tracesUrl: 'https://otlp.example.com/v1/traces', host: 'otlp.example.com', header: 'authorization' };
const publicDns = async () => ['52.1.2.3'];

describe('checkOtlpEndpoint', () => {
  it('sends an empty OTLP/HTTP JSON export with the header, and follows no redirect', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    expect(await checkOtlpEndpoint(fetchFn as never, publicDns)(destination, 'Bearer abcdefgh')).toEqual({ result: 'valid' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://otlp.example.com/v1/traces');
    expect(init).toMatchObject({ method: 'POST', body: '{"resourceSpans":[]}', redirect: 'manual', headers: { 'content-type': 'application/json', authorization: 'Bearer abcdefgh' } });
  });

  it('tells a refused key, an endpoint that is not OTLP/HTTP JSON, a redirect and an unreachable one apart', async () => {
    const answer = (status: number) => checkOtlpEndpoint((async () => ({ ok: status < 300, status })) as never, publicDns)(destination, 'Bearer abcdefgh');
    expect(await answer(401)).toEqual({ result: 'invalid' });
    expect(await answer(403)).toEqual({ result: 'invalid' });
    expect(await answer(415)).toEqual({ result: 'not_otlp', status: 415 });
    expect(await answer(404)).toEqual({ result: 'not_otlp', status: 404 });
    expect(await answer(302)).toMatchObject({ result: 'unreachable', reason: expect.stringMatching(/redirect/) });
    expect(await answer(503)).toMatchObject({ result: 'unreachable' });
    const down = await checkOtlpEndpoint((async () => Promise.reject(new TypeError('fetch failed'))) as never, publicDns)(destination, 'Bearer abcdefgh');
    expect(down).toMatchObject({ result: 'unreachable' });
  });

  it('never sends to a name that resolves to a private address', async () => {
    const fetchFn = vi.fn();
    expect(await checkOtlpEndpoint(fetchFn as never, async () => ['52.1.2.3', '169.254.169.254'])(destination, 'Bearer abcdefgh')).toMatchObject({ result: 'unreachable', reason: expect.stringMatching(/public/) });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('the endpoint, header and link rules', () => {
  it('parses an endpoint the way the runner sends to it', () => {
    expect(parseOtlpEndpoint('https://api.example.com/otlp/')).toEqual({ endpoint: 'https://api.example.com/otlp', tracesUrl: 'https://api.example.com/otlp/v1/traces', host: 'api.example.com' });
    expect(parseOtlpEndpoint('https://api.example.com/v1/traces')).toMatchObject({ tracesUrl: 'https://api.example.com/v1/traces' });
    for (const bad of ['ftp://x.example.com', 'https://127.0.0.1', 'https://[fd00::1]', 'https://0x7f000001', 'https://metadata', 'https://a.localhost']) {
      expect(parseOtlpEndpoint(bad), bad).toHaveProperty('problem');
    }
  });

  it('keeps the header to one the runner does not set itself', () => {
    expect(headerNameProblem('x-api-key')).toBeNull();
    expect(headerNameProblem('Content-Length')).toMatch(/cannot carry/);
    expect(headerNameProblem('proxy-authorization')).toMatch(/cannot carry/);
  });

  it('tells public addresses from the rest', () => {
    expect(isPublicAddress('52.1.2.3')).toBe(true);
    for (const ip of ['10.0.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.169.254', '100.100.100.100', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('fills a link template with encoded values only', () => {
    expect(linkTemplateProblem('https://ui.example.com/t/{trace_id}', TRACE_LINK_PLACEHOLDERS, 'trace_id')).toBeNull();
    expect(linkTemplateProblem('https://ui.example.com/t/{span_id}', TRACE_LINK_PLACEHOLDERS, 'trace_id')).toMatch(/names \{trace_id\}/);
    expect(linkTemplateProblem('https://ui.example.com/t/{trace_id}"><b>', TRACE_LINK_PLACEHOLDERS, 'trace_id')).toMatch(/URL characters/);
    expect(fillTemplate('https://ui.example.com/c?q={conversation}', { conversation: 'a/b#1 x&y' })).toBe('https://ui.example.com/c?q=a%2Fb%231%20x%26y');
  });
});
