import { vi } from 'vitest';
import type { ApiClient, GitHubStatus } from '../api/client';

/** A full ApiClient of mocks; pass the ones a test cares about. */
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const status: GitHubStatus = { configured: true, appSlug: 'updraft', linked: null, tenants: [] };
  return {
    request: vi.fn(),
    me: vi.fn().mockResolvedValue({ sub: 'u1', email: 'pat@example.com', name: 'Pat Lee' }),
    githubStatus: vi.fn().mockResolvedValue(status),
    startLink: vi.fn().mockResolvedValue({ url: 'https://github.com/login/oauth/authorize?state=s' }),
    unlink: vi.fn().mockResolvedValue({ ok: true }),
    startInstall: vi.fn().mockResolvedValue({ url: 'https://github.com/apps/updraft/installations/new?state=s' }),
    completeCallback: vi.fn(),
    repositories: vi.fn(),
    ...overrides,
  } as ApiClient;
}
