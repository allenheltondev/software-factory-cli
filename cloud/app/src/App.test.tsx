import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { configureAuth } from '@readysetcloud/ui/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { safeReturnPath } from './auth/AuthScreens';
import { navItems } from './layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';

beforeEach(() => {
  configureAuth({ region: 'us-east-1', clientId: 'test-client', sharedCookieDomain: '' });
});

describe('App', () => {
  it('sends a signed-out visitor to sign in', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App api={{ me: vi.fn() }} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-ready')).not.toBeInTheDocument();
  });
});

describe('DashboardPage', () => {
  it('greets the caller the API returns', async () => {
    const me = vi.fn().mockResolvedValue({ sub: 'u1', email: 'pat@example.com', name: 'Pat Lee' });
    render(<DashboardPage api={{ me }} />);
    expect(await screen.findByTestId('dashboard-ready')).toHaveTextContent('pat@example.com');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Pat Lee');
  });

  it('says so when the API call fails', async () => {
    render(<DashboardPage api={{ me: vi.fn().mockRejectedValue(new Error('boom')) }} />);
    expect(await screen.findByTestId('dashboard-error')).toBeInTheDocument();
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
  it('marks the dashboard active on /', () => {
    expect(navItems('/')[0]).toMatchObject({ id: 'dashboard', active: true });
    expect(navItems('/elsewhere')[0]).toMatchObject({ active: false });
  });
});
