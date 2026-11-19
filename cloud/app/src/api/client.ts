import { getFreshIdToken, signOut } from '@readysetcloud/ui/auth';

/**
 * Fetch for the Updraft API.
 *
 * - Paths are relative to `/api/v1` and stay same-origin: CloudFront routes `/api/*` to API
 *   Gateway in the cloud, and Vite proxies it locally.
 * - Every request carries `Authorization: Bearer <ID token>`, which API Gateway's Cognito
 *   authorizer verifies (the same header form rsc-core's own clients send).
 * - A 401 means the API refused the session, so it is dropped and the app returns to sign-in.
 */

export const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`API request failed (${status} ${code})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  getToken: () => Promise<string | null>;
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

export interface Me {
  sub: string;
  email?: string;
  name?: string;
}

export function createApiClient({ getToken, onUnauthorized, fetch: fetchImpl = (...a) => fetch(...a) }: ApiClientOptions) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getToken();
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const response = await fetchImpl(`${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`, { ...init, headers });
    if (response.status === 401) onUnauthorized?.();
    if (!response.ok) {
      let code = 'error';
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === 'string') code = body.error;
      } catch {
        // Not JSON (an API Gateway or CloudFront error page): keep the generic code.
      }
      throw new ApiError(response.status, code);
    }
    return (await response.json()) as T;
  }

  return {
    request,
    me: () => request<Me>('/me'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api = createApiClient({
  getToken: async () => (await getFreshIdToken()) ?? null,
  onUnauthorized: () => void signOut(),
});
