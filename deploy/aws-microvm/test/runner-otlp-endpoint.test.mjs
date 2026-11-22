import { describe, expect, it } from 'vitest';
import { headerNameOk, isPublicAddress, parseOtlpEndpoint, publicOnlyFetch, publicOnlyLookup, resolvesPublic } from '../image/runner/otlp-endpoint.mjs';

describe('a custom OTLP endpoint, as the runner checks it', () => {
  it('sends to the base endpoint plus /v1/traces, or to a traces endpoint as given', () => {
    expect(parseOtlpEndpoint('https://otlp.example.com/otlp/')).toEqual({ endpoint: 'https://otlp.example.com/otlp', tracesUrl: 'https://otlp.example.com/otlp/v1/traces', host: 'otlp.example.com' });
    expect(parseOtlpEndpoint('https://otlp.example.com:4318/v1/traces')?.tracesUrl).toBe('https://otlp.example.com:4318/v1/traces');
  });

  it('refuses anything but https to a public DNS name, with no credentials, query or fragment', () => {
    for (const bad of ['http://otlp.example.com', 'https://10.0.0.1', 'https://[::1]', 'https://localhost', 'https://collector', 'https://otel.internal', 'https://u:p@otlp.example.com', 'https://otlp.example.com/?k=1', 'https://otlp.example.com/#x', 'https://2130706433', '', 42]) {
      expect(parseOtlpEndpoint(bad), String(bad)).toBeNull();
    }
  });

  it('takes a header the runner does not set itself', () => {
    expect(headerNameOk('authorization')).toBe(true);
    expect(headerNameOk('x-api-key')).toBe(true);
    for (const bad of ['host', 'content-type', 'proxy-authorization', 'Authorization', 'x y', '']) expect(headerNameOk(bad), bad).toBe(false);
  });

  it('tells public addresses from private, loopback, link-local, shared and reserved ones', () => {
    for (const ip of ['8.8.8.8', '52.1.2.3', '2606:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'nonsense']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('needs every address of the name to be public, and a name that resolves', async () => {
    expect(await resolvesPublic('h', async () => ['8.8.8.8', '1.1.1.1'])).toBe(true);
    expect(await resolvesPublic('h', async () => ['8.8.8.8', '10.0.0.1'])).toBe(false);
    expect(await resolvesPublic('h', async () => [])).toBe(false);
    expect(
      await resolvesPublic('h', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).toBe(false);
  });

  it('connects only to the public addresses its lookup vetted, whatever the name resolves to later', async () => {
    const resolveTo = (addresses) => (_h, _o, cb) => cb(null, addresses);
    const answer = (lookupFn, opts) => new Promise((resolve) => lookupFn('otlp.example.com', opts, (...args) => resolve(args)));
    expect(await answer(publicOnlyLookup(resolveTo([{ address: '52.1.2.3', family: 4 }])), {})).toEqual([null, '52.1.2.3', 4]);
    expect(await answer(publicOnlyLookup(resolveTo([{ address: '52.1.2.3', family: 4 }])), { all: true })).toEqual([null, [{ address: '52.1.2.3', family: 4 }]]);
    const [refused] = await answer(publicOnlyLookup(resolveTo([{ address: '52.1.2.3', family: 4 }, { address: '169.254.169.254', family: 4 }])), {});
    expect(refused).toMatchObject({ code: 'ENOTPUBLIC' });
    // The request itself goes through it: a private answer at connection time never connects.
    const send = publicOnlyFetch({ lookup: publicOnlyLookup(resolveTo([{ address: '10.0.0.1', family: 4 }])) });
    await expect(send('https://otlp.example.com/v1/traces', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'ENOTPUBLIC' });
    await expect(send('http://otlp.example.com/v1/traces', { method: 'POST', body: '{}' })).rejects.toThrow(/https/);
  });
});
