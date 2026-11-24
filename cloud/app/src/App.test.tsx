import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { configureAuth } from '@readysetcloud/ui/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { safeReturnPath } from './auth/AuthScreens';
import { navItems } from './layout/AppLayout';
import { GitHubSettingsPage } from './pages/GitHubSettingsPage';
import { InstallationsPage } from './pages/InstallationsPage';
import type { TenantSummary } from './api/client';
import { fakeApi } from './test/fakeApi';

beforeEach(() => {
  configureAuth({ region: 'us-east-1', clientId: 'test-client', sharedCookieDomain: '' });
});

describe('App', () => {
  it('sends a signed-out visitor to sign in', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App api={fakeApi()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByTestId('github-settings-ready')).not.toBeInTheDocument();
  });
});

describe('GitHubSettingsPage', () => {
  it('shows the GitHub settings for the caller', async () => {
    const me = vi.fn().mockResolvedValue({ sub: 'u1', email: 'pat@example.com', name: 'Pat Lee' });
    render(<GitHubSettingsPage api={fakeApi({ me })} />);
    expect(await screen.findByTestId('github-settings-ready')).toHaveTextContent('pat@example.com');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('GitHub settings');
  });

  it('says so when the API call fails', async () => {
    render(<GitHubSettingsPage api={fakeApi({ me: vi.fn().mockRejectedValue(new Error('boom')) })} />);
    expect(await screen.findByTestId('github-settings-error')).toBeInTheDocument();
  });
});

describe('safeReturnPath', () => {
  it.each([
    [undefined, '/'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/login', '/'],
    ['/signup/confirm', '/'],
    ['/settings?x=1', '/settings?x=1'],
  ])('%s -> %s', (from, expected) => {
    expect(safeReturnPath(from)).toBe(expected);
  });
});

describe('navItems', () => {
  it('keeps repository and job views distinct in the installation sidebar', () => {
    const tenant = { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' } as const;
    expect(navItems('/installations/55', '?tab=repositories', tenant).filter((item) => item.active).map((item) => item.id)).toEqual(['repositories']);
    expect(navItems('/installations/55/claude', '?request=job_example', tenant).filter((item) => item.active).map((item) => item.id)).toEqual(['claude']);
    expect(navItems('/installations/55/jobs/job_123', '', tenant).filter((item) => item.active).map((item) => item.id)).toEqual(['activity']);
    expect(navItems('/installations', '')[0]).toMatchObject({ id: 'installations', active: true });
  });
});

describe('installation home', () => {
  const acme: TenantSummary = { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' };
  const personal: TenantSummary = { ...acme, installationId: 56, accountLogin: 'pat', accountType: 'User' };

  function openHome(tenants: TenantSummary[], preferredId: string | null = null) {
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={{ installations: { state: 'ready', github: { tenants } }, preferredId }} />}>
            <Route index element={<InstallationsPage home />} />
            <Route path="installations" element={<InstallationsPage />} />
            <Route path="installations/55" element={<h1>Acme activity</h1>} />
            <Route path="installations/56" element={<h1>Personal activity</h1>} />
            <Route path="settings/github" element={<h1>GitHub settings</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  it('opens the only installation', async () => {
    openHome([acme]);
    expect(await screen.findByRole('heading', { name: 'Acme activity' })).toBeInTheDocument();
  });

  it('returns to the remembered installation', async () => {
    openHome([acme, personal], '56');
    expect(await screen.findByRole('heading', { name: 'Personal activity' })).toBeInTheDocument();
  });

  it('offers a picker when the remembered installation is no longer accessible', async () => {
    openHome([acme, personal], '57');
    expect(await screen.findByRole('link', { name: 'acme' })).toHaveAttribute('href', '/installations/55');
    expect(screen.getByRole('link', { name: 'pat' })).toHaveAttribute('href', '/installations/56');
  });

  it('takes users without an installation to GitHub setup', async () => {
    openHome([]);
    expect(await screen.findByRole('heading', { name: 'GitHub settings' })).toBeInTheDocument();
  });
});
