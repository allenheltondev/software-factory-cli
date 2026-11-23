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
    connect: vi.fn(),
    repositories: vi.fn(),
    config: vi.fn(),
    previewConfig: vi.fn(),
    publishConfig: vi.fn(),
    configVersions: vi.fn(),
    configVersion: vi.fn(),
    reactivateConfig: vi.fn(),
    overview: vi.fn(),
    insights: vi.fn(),
    deliveries: vi.fn(),
    jobs: vi.fn(),
    job: vi.fn(),
    jobLog: vi.fn(),
    retryJob: vi.fn(),
    agentKeys: vi.fn(),
    routines: vi.fn(),
    setRoutine: vi.fn(),
    removeRoutine: vi.fn(),
    nativeClaude: vi.fn(),
    setNativeClaudeMode: vi.fn(),
    telemetry: vi.fn(),
    updateTelemetry: vi.fn(),
    setTelemetryKey: vi.fn(),
    removeTelemetryKey: vi.fn(),
    setAgentKey: vi.fn(),
    adminTenants: vi.fn(),
    adminTenant: vi.fn(),
    adminDisable: vi.fn(),
    adminEnable: vi.fn(),
    adminSetLimits: vi.fn(),
    adminReleaseJob: vi.fn(),
    ...overrides,
  } as ApiClient;
}
