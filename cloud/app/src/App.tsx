import { Link, Route, Routes } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { AuthProvider } from '@readysetcloud/ui/auth';
import type { ApiClient } from './api/client';
import { ForgotPasswordPage, LoginPage, SignUpPage } from './auth/AuthScreens';
import { RequireSignIn } from './auth/RequireSignIn';
import { AppLayout } from './layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { GitHubCallbackPage } from './pages/GitHubCallbackPage';
import { AdminPage } from './pages/AdminPage';
import { AdminTenantPage } from './pages/AdminTenantPage';
import { ConfigHistoryPage } from './pages/ConfigHistoryPage';
import { ConfigPage } from './pages/ConfigPage';
import { InstallationPage } from './pages/InstallationPage';

function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      description="There is nothing at this address."
      action={
        <Link className="auth-link" to="/">
          Back to the dashboard
        </Link>
      }
    />
  );
}

/** The route table. The router is supplied by the caller (main.tsx, tests); tests can pass a fake API. */
export function App({ api }: { api?: ApiClient }) {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/signup/confirm" element={<SignUpPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route
          element={
            <RequireSignIn>
              <AppLayout api={api} />
            </RequireSignIn>
          }
        >
          <Route index element={<DashboardPage api={api} />} />
          <Route path="github/callback" element={<GitHubCallbackPage api={api} />} />
          <Route path="installations/:id" element={<InstallationPage api={api} />} />
          <Route path="installations/:id/config" element={<ConfigPage api={api} />} />
          <Route path="installations/:id/config/history" element={<ConfigHistoryPage api={api} />} />
          <Route path="admin" element={<AdminPage api={api} />} />
          <Route path="admin/tenants/:id" element={<AdminTenantPage api={api} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
