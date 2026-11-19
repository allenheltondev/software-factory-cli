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

  /** A message the server meant for people (flow errors carry one), or a generic one. */
  constructor(status: number, code: string, message?: string) {
    super(message ?? `API request failed (${status} ${code})`);
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

export interface TenantSummary {
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: 'active' | 'disabled';
  disabledReason?: 'suspended' | 'uninstalled';
  role: 'owner' | 'editor';
}

export interface GitHubStatus {
  configured: boolean;
  appSlug?: string;
  linked: { githubLogin: string; githubUserId: number } | null;
  tenants: TenantSummary[];
}

export interface Repository {
  id: number;
  fullName: string;
  private: boolean;
  htmlUrl: string;
}

export interface CallbackInput {
  code?: string;
  state?: string;
  installationId?: string;
  setupAction?: string;
}

export interface ConnectableInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  connected: boolean;
}

export type CallbackResult =
  | { kind: 'linked'; githubLogin: string; installations: ConnectableInstallation[] }
  | { kind: 'installed'; githubLogin: string; installationId: number; accountLogin: string }
  | { kind: 'requested'; githubLogin: string };

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
      let message: string | undefined;
      try {
        const body = (await response.json()) as { error?: unknown; message?: unknown };
        if (typeof body.error === 'string') code = body.error;
        if (typeof body.message === 'string') message = body.message;
      } catch {
        // Not JSON (an API Gateway or CloudFront error page): keep the generic code.
      }
      throw new ApiError(response.status, code, message);
    }
    return (await response.json()) as T;
  }

  return {
    request,
    me: () => request<Me>('/me'),
    githubStatus: () => request<GitHubStatus>('/github'),
    startLink: () => request<{ url: string }>('/github/link', { method: 'POST' }),
    unlink: () => request<{ ok: true }>('/github/link', { method: 'DELETE' }),
    startInstall: () => request<{ url: string }>('/github/install', { method: 'POST' }),
    completeCallback: (input: CallbackInput) =>
      request<CallbackResult>('/github/callback', { method: 'POST', body: JSON.stringify(input) }),
    connect: (installationId: number) =>
      request<{ installationId: number; accountLogin: string }>(`/github/connect/${installationId}`, { method: 'POST' }),
    repositories: (installationId: number) =>
      request<{ tenant: TenantSummary; repositories: Repository[] }>(`/installations/${installationId}/repositories`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api = createApiClient({
  getToken: async () => (await getFreshIdToken()) ?? null,
  onUnauthorized: () => void signOut(),
});
