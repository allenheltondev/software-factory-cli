import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { AppNav, Container, readySetCloudServices, type AppNavItem, type AppNavLinkProps } from '@readysetcloud/ui';
import { useAuth, type IdClaims } from '@readysetcloud/ui/auth';
import { APP_NAME } from '../auth/AuthScreens';

/** AppNav's in-app links through the router, so navigation stays client-side. Module scope, for a stable identity. */
function RouterNavLink({ href, ...rest }: AppNavLinkProps) {
  return <Link to={href} {...rest} />;
}

export function displayName(user: IdClaims): string | undefined {
  const name = [user.given_name, user.family_name].filter(Boolean).join(' ');
  if (name) return name;
  return typeof user.email === 'string' ? user.email : undefined;
}

export function navItems(pathname: string): AppNavItem[] {
  return [{ id: 'dashboard', label: 'Dashboard', href: '/', active: pathname === '/' }];
}

/**
 * The signed-in shell: the shared Ready, Set, Cloud navbar (app launcher, theme toggle, profile
 * menu) over the page. `currentServiceId="updraft"` highlights this app in the launcher once
 * rsc-core's service registry lists it.
 */
export function AppLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppNav
        appName={APP_NAME}
        currentServiceId="updraft"
        homeHref="/"
        linkComponent={RouterNavLink}
        services={readySetCloudServices}
        authState="authenticated"
        user={user ? { name: displayName(user), email: typeof user.email === 'string' ? user.email : undefined } : undefined}
        navItems={navItems(pathname)}
        closeMenuOnOutsideClick
        onSignOut={() => {
          void signOut().then(() => navigate('/login', { replace: true }));
        }}
      />
      <main>
        <Container className="py-8">
          <Outlet />
        </Container>
      </main>
    </div>
  );
}
