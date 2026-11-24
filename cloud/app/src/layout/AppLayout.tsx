import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext } from 'react-router';
import { AppNav, Container, readySetCloudServices, type AppNavItem, type AppNavLinkProps } from '@readysetcloud/ui';
import { useAuth, type IdClaims } from '@readysetcloud/ui/auth';
import { api as defaultApi, type ApiClient, type GitHubStatus, type TenantSummary } from '../api/client';
import { APP_NAME } from '../auth/AuthScreens';

function RouterNavLink({ href, ...rest }: AppNavLinkProps) {
  return <Link to={href} {...rest} />;
}

export function displayName(user: IdClaims): string | undefined {
  const name = [user.given_name, user.family_name].filter(Boolean).join(' ');
  if (name) return name;
  return typeof user.email === 'string' ? user.email : undefined;
}

export function navItems(pathname: string, search: string, tenant?: TenantSummary, admin = false): AppNavItem[] {
  const items: AppNavItem[] = [
    { id: 'installations', label: 'Installations', href: '/installations', active: pathname === '/installations' },
  ];
  if (tenant) {
    const base = `/installations/${tenant.installationId}`;
    const repositories = pathname === base && new URLSearchParams(search).get('tab') === 'repositories';
    items.push(
      { id: 'activity', label: 'Activity', href: base, active: (pathname === base && !repositories) || pathname.startsWith(`${base}/jobs/`), section: tenant.accountLogin },
      { id: 'repositories', label: 'Repositories', href: `${base}?tab=repositories`, active: repositories, section: tenant.accountLogin },
      { id: 'insights', label: 'Insights', href: `${base}/insights`, active: pathname === `${base}/insights`, section: tenant.accountLogin },
      { id: 'config', label: 'Configuration', href: `${base}/config`, active: pathname === `${base}/config` || pathname.startsWith(`${base}/config/`), section: 'Installation settings' },
      { id: 'keys', label: 'Agent keys', href: `${base}/keys`, active: pathname === `${base}/keys`, section: 'Installation settings' },
      { id: 'claude', label: 'Claude subscription', href: `${base}/claude`, active: pathname === `${base}/claude`, section: 'Installation settings' },
      { id: 'telemetry', label: 'Telemetry', href: `${base}/telemetry`, active: pathname === `${base}/telemetry`, section: 'Installation settings' },
    );
  }
  items.push({ id: 'github', label: 'GitHub settings', href: '/settings/github', active: pathname === '/settings/github', section: 'Account' });
  if (admin) items.push({ id: 'admin', label: 'Admin', href: '/admin', active: pathname === '/admin' || pathname.startsWith('/admin/'), section: 'Account' });
  return items;
}

type Installations = { state: 'loading' | 'error' } | { state: 'ready'; github: GitHubStatus };

export function useInstallations() {
  return useOutletContext<{ installations: Installations; preferredId: string | null }>();
}

function lastInstallation(account: string): string | null {
  try {
    return window.localStorage.getItem(`updraft:last-installation:${account}`);
  } catch {
    return null;
  }
}

type LayoutApi = Pick<ApiClient, 'me' | 'githubStatus'>;

export function AppLayout({ api = defaultApi }: { api?: LayoutApi }) {
  const auth = useAuth();
  const { pathname } = useLocation();
  const account = typeof auth.user?.sub === 'string' ? auth.user.sub : undefined;
  const managingGitHub = pathname === '/settings/github' || pathname === '/github/callback';

  // Returning from GitHub management starts with a fresh installation list.
  return <ConsoleLayout key={JSON.stringify([account, managingGitHub])} api={api} auth={auth} account={account} managingGitHub={managingGitHub} />;
}

function ConsoleLayout({ api, auth, account, managingGitHub }: {
  api: LayoutApi;
  auth: ReturnType<typeof useAuth>;
  account: string | undefined;
  managingGitHub: boolean;
}) {
  const { user, signOut } = auth;
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const id = /^\/installations\/(\d+)(?:\/|$)/.exec(pathname)?.[1];
  const [admin, setAdmin] = useState(false);
  const [installations, setInstallations] = useState<Installations>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    void api.me().then(
      (me) => live && setAdmin(me.admin === true),
      () => live && setAdmin(false),
    );
    return () => {
      live = false;
    };
  }, [api, account]);

  useEffect(() => {
    if (managingGitHub) return;
    let live = true;
    void api.githubStatus().then(
      (github) => live && setInstallations({ state: 'ready', github }),
      () => live && setInstallations({ state: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [api, account, managingGitHub]);

  const tenants = installations.state === 'ready' ? installations.github.tenants : [];
  const tenant = tenants.find((item) => String(item.installationId) === id);
  useEffect(() => {
    if (!account || !tenant) return;
    try {
      window.localStorage.setItem(`updraft:last-installation:${account}`, String(tenant.installationId));
    } catch {
      // Navigation also works when storage is unavailable.
    }
  }, [account, tenant]);

  return (
    <div className="relative flex min-h-screen flex-col bg-background text-foreground min-[641px]:flex-row">
      <AppNav
        appName={APP_NAME}
        currentServiceId="updraft"
        homeHref="/"
        layout="side"
        linkComponent={RouterNavLink}
        services={readySetCloudServices}
        authState="authenticated"
        user={user ? { name: displayName(user), email: typeof user.email === 'string' ? user.email : undefined } : undefined}
        navItems={navItems(pathname, search, tenant, admin)}
        closeMenuOnOutsideClick
        onSignOut={() => {
          void signOut().then(() => navigate('/login', { replace: true }));
        }}
      />
      <main className="min-w-0 flex-1">
        <Container className="py-6" style={{ maxWidth: '90rem' }}>
          <Outlet key={id} context={{ installations, preferredId: account ? lastInstallation(account) : null }} />
        </Container>
      </main>
    </div>
  );
}
