import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { DashboardPage, tenantStatusLabel } from './DashboardPage';
import { callbackInput, GitHubCallbackPage } from './GitHubCallbackPage';
import { InstallationPage } from './InstallationPage';

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

describe('DashboardPage', () => {
  it('says when the GitHub App is not set up yet', async () => {
    const api = fakeApi({ githubStatus: vi.fn().mockResolvedValue({ configured: false, linked: null, tenants: [] }) });
    render(<DashboardPage api={api} />);
    expect(await screen.findByTestId('github-not-configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect github/i })).not.toBeInTheDocument();
  });

  it('starts linking and sends the browser to GitHub', async () => {
    const api = fakeApi();
    const go = vi.fn();
    render(<DashboardPage api={api} go={go} />);
    await userEvent.click(await screen.findByRole('button', { name: /connect github/i }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=s'));
    expect(api.startLink).toHaveBeenCalledOnce();
  });

  it('offers to install once linked, and lists installations', async () => {
    const api = fakeApi({
      githubStatus: vi.fn().mockResolvedValue({
        configured: true,
        linked: { githubLogin: 'pat', githubUserId: 1 },
        tenants: [
          { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' },
          { installationId: 56, accountLogin: 'old', accountType: 'User', status: 'disabled', disabledReason: 'uninstalled', role: 'owner' },
        ],
      }),
    });
    const go = vi.fn();
    render(
      <MemoryRouter>
        <DashboardPage api={api} go={go} />
      </MemoryRouter>,
    );
    const list = await screen.findByTestId('tenant-list');
    expect(list).toHaveTextContent('acme');
    expect(list).toHaveTextContent('Uninstalled');
    expect(screen.getByRole('link', { name: 'acme' })).toHaveAttribute('href', '/installations/55');
    await userEvent.click(screen.getByRole('button', { name: /install the app/i }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://github.com/apps/updraft/installations/new?state=s'));
  });

  it('shows the server\'s message when starting fails', async () => {
    const api = fakeApi({ startLink: vi.fn().mockRejectedValue(new ApiError(503, 'github_app_not_configured', 'Not registered yet')) });
    render(<DashboardPage api={api} go={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /connect github/i }));
    expect(await screen.findByTestId('dashboard-action-error')).toHaveTextContent('Not registered yet');
  });

  it('labels tenant states', () => {
    expect(tenantStatusLabel({ status: 'active' }).label).toBe('Active');
    expect(tenantStatusLabel({ status: 'disabled', disabledReason: 'suspended' }).label).toBe('Suspended');
  });
});

describe('GitHubCallbackPage', () => {
  function renderAt(url: string, completeCallback = vi.fn(), connect = vi.fn()) {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/github/callback" element={<GitHubCallbackPage api={{ completeCallback, connect }} />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </StrictMode>,
    );
    return completeCallback;
  }

  it('reads what GitHub sent', () => {
    expect(callbackInput('?code=c&state=s&installation_id=55&setup_action=install')).toEqual({
      code: 'c',
      state: 's',
      installationId: '55',
      setupAction: 'install',
    });
    expect(callbackInput('')).toEqual({});
  });

  it('posts once (even under StrictMode), drops the code from the address bar, and shows the result', async () => {
    const complete = renderAt(
      '/github/callback?code=c&state=s&installation_id=55&setup_action=install',
      vi.fn().mockResolvedValue({ kind: 'installed', githubLogin: 'pat', installationId: 55, accountLogin: 'acme' }),
    );
    expect(await screen.findByTestId('callback-installed')).toHaveTextContent('Connected acme');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ code: 'c', state: 's', installationId: '55', setupAction: 'install' });
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/github\/callback$/);
  });

  it('does not post without a state, and says to start again', async () => {
    const complete = renderAt('/github/callback?code=c&installation_id=55');
    expect(await screen.findByTestId('callback-error')).toHaveTextContent(/did not come from Updraft/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('shows the server\'s refusal', async () => {
    renderAt('/github/callback?code=c&state=s', vi.fn().mockRejectedValue(new ApiError(403, 'not_authorized', 'Only an owner of acme')));
    expect(await screen.findByTestId('callback-error')).toHaveTextContent('Only an owner of acme');
  });

  it('after linking, offers existing installations and connects the one picked', async () => {
    const connect = vi.fn().mockResolvedValue({ installationId: 55, accountLogin: 'acme' });
    renderAt(
      '/github/callback?code=c&state=s',
      vi.fn().mockResolvedValue({
        kind: 'linked',
        githubLogin: 'pat',
        installations: [
          { installationId: 55, accountLogin: 'acme', accountType: 'Organization', connected: false },
          { installationId: 56, accountLogin: 'pat', accountType: 'User', connected: true },
        ],
      }),
      connect,
    );
    const list = await screen.findByTestId('connect-list');
    expect(list).toHaveTextContent('acme');
    expect(screen.getByRole('link', { name: 'Connected' })).toHaveAttribute('href', '/installations/56');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(connect).toHaveBeenCalledWith(55);
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Connected' })).toHaveLength(2));
  });

  it('shows why a connect was refused', async () => {
    renderAt(
      '/github/callback?code=c&state=s',
      vi.fn().mockResolvedValue({ kind: 'linked', githubLogin: 'pat', installations: [{ installationId: 55, accountLogin: 'acme', accountType: 'Organization', connected: false }] }),
      vi.fn().mockRejectedValue(new ApiError(409, 'offer_expired', 'Find your installations again')),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Find your installations again')).toBeInTheDocument();
  });

  it('explains an install request that waits for an org owner', async () => {
    renderAt('/github/callback?code=c&state=s&setup_action=request', vi.fn().mockResolvedValue({ kind: 'requested', githubLogin: 'pat' }));
    expect(await screen.findByTestId('callback-requested')).toBeInTheDocument();
  });
});

describe('InstallationPage', () => {
  function renderAt(id: string, repositories: ApiClient['repositories']) {
    render(
      <MemoryRouter initialEntries={[`/installations/${id}`]}>
        <Routes>
          <Route path="/installations/:id" element={<InstallationPage api={{ repositories }} />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('lists the repositories', async () => {
    const repositories = vi.fn().mockResolvedValue({
      tenant: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' },
      repositories: [{ id: 1, fullName: 'acme/api', private: true, htmlUrl: 'https://github.com/acme/api' }],
    });
    renderAt('55', repositories);
    expect(await screen.findByTestId('repository-list')).toHaveTextContent('acme/api');
    expect(repositories).toHaveBeenCalledWith(55);
  });

  it('shows a refusal, and never calls the API for a bad id', async () => {
    const repositories = vi.fn().mockRejectedValue(new ApiError(403, 'not_authorized', 'You are not a member of that installation'));
    renderAt('55', repositories);
    expect(await screen.findByTestId('installation-error')).toHaveTextContent('not a member');

    const never = vi.fn();
    renderAt('abc', never);
    expect(never).not.toHaveBeenCalled();
  });
});
