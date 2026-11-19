import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createApiClient', () => {
  it('calls /api/v1 with the ID token as a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ sub: 'u1' }));
    const client = createApiClient({ getToken: async () => 'id-token', fetch: fetchImpl });

    await expect(client.me()).resolves.toEqual({ sub: 'u1' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/me');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer id-token');
  });

  it('sends no authorization header when signed out', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}));
    await createApiClient({ getToken: async () => null, fetch: fetchImpl }).request('/x');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('drops the session on a 401', async () => {
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      getToken: async () => 't',
      onUnauthorized,
      fetch: vi.fn().mockResolvedValue(json({ error: 'unauthorized' }, 401)),
    });
    await expect(client.me()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('keeps a generic code for a non-JSON error page', async () => {
    const client = createApiClient({
      getToken: async () => 't',
      fetch: vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 })),
    });
    const err = await client.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: 'error' });
  });
});
