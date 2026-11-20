import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminTenantDetail } from '../api/client';
import { navItems } from '../layout/AppLayout';
import { fakeApi } from '../test/fakeApi';
import { AdminPage } from './AdminPage';
import { AdminTenantPage } from './AdminTenantPage';

const QUOTAS = { concurrentJobs: 1, jobsPerDay: 20, microvmMinutesPerMonth: 1200, platformConcurrentJobs: 20 };
const USAGE = { day: '2026-11-20', jobsToday: 3, month: '2026-11', jobsThisMonth: 9, microvmSecondsThisMonth: 3601, throttledThisMonth: 2, failedThisMonth: 1 };

const detail = (over: Partial<AdminTenantDetail> = {}): AdminTenantDetail => ({
  installationId: 55,
  accountLogin: 'acme',
  accountType: 'Organization',
  status: 'active',
  activeConfigVersion: 4,
  createdAt: '2026-11-19T00:00:00.000Z',
  quotas: QUOTAS,
  defaults: QUOTAS,
  usage: USAGE,
  recentJobs: [
    { jobId: 'job_second001', repository: 'acme/web', issue: 13, label: 'updraft', sender: 'pat', createdAt: '2026-11-20T11:00:00.000Z', status: 'launched' },
    { jobId: 'job_first0001', repository: 'acme/web', issue: 12, createdAt: '2026-11-20T10:00:00.000Z', status: 'finished', outcome: 'timed_out' },
  ],
  activeJobs: [
    { jobId: 'job_second001', phase: 'launching', reservedAt: '2026-11-20T11:00:00.000Z', expiresAt: '2026-11-20T14:00:00.000Z', repository: 'acme/web', issue: 13, microvmId: 'mvm-2' },
  ],
  ...over,
});

function at(path: string, element: React.ReactNode, route: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('navItems', () => {
  it('adds the admin link for admins only', () => {
    expect(navItems('/').map((i) => i.id)).toEqual(['dashboard']);
    expect(navItems('/admin/tenants/55', true)).toEqual([expect.objectContaining({ id: 'dashboard', active: false }), expect.objectContaining({ id: 'admin', active: true })]);
  });
});

describe('AdminPage', () => {
  it('lists every tenant with its usage against its quotas', async () => {
    const api = fakeApi({
      adminTenants: vi.fn().mockResolvedValue({
        tenants: [detail(), { ...detail(), installationId: 66, accountLogin: 'zeta', status: 'disabled', disabledReason: 'admin' }],
        platform: { activeJobs: 1, platformConcurrentJobs: 20 },
      }),
    });
    at('/admin', <AdminPage api={api} />, '/admin');
    const table = await screen.findByTestId('admin-tenants');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'acme' })).toHaveAttribute('href', '/admin/tenants/55');
    // 3601 seconds is 61 minutes, rounded up as the quota counts them.
    expect(rows[0]!).toHaveTextContent('3 / 20');
    expect(rows[0]!).toHaveTextContent('61 / 1200');
    expect(within(rows[1]!).getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByTestId('platform-capacity')).toHaveTextContent('1 / 20');
  });

  it('says so to someone the server does not let in', async () => {
    const api = fakeApi({ adminTenants: vi.fn().mockRejectedValue(new ApiError(403, 'forbidden')) });
    at('/admin', <AdminPage api={api} />, '/admin');
    expect(await screen.findByTestId('admin-forbidden')).toBeInTheDocument();
  });
});

describe('AdminTenantPage', () => {
  const page = (api: ReturnType<typeof fakeApi>) => at('/admin/tenants/55', <AdminTenantPage api={api} />, '/admin/tenants/:id');

  it("shows the tenant's usage, running jobs and recent jobs", async () => {
    const api = fakeApi({ adminTenant: vi.fn().mockResolvedValue(detail()) });
    page(api);
    expect(await screen.findByTestId('admin-tenant')).toHaveTextContent('acme');
    expect(api.adminTenant).toHaveBeenCalledWith(55);
    expect(screen.getByTestId('active-jobs')).toHaveTextContent('microVM mvm-2');
    const jobs = within(screen.getByTestId('recent-jobs')).getAllByRole('row').slice(1);
    expect(jobs[0]).toHaveTextContent('running');
    expect(jobs[1]).toHaveTextContent('timed_out');
  });

  it('disables the tenant with a reason, and enables it again', async () => {
    const disabled = detail({ status: 'disabled', disabledReason: 'admin', adminDisabled: { at: '2026-11-20T12:00:00.000Z', by: 'admin:ops@example.com', reason: 'abuse' } });
    const api = fakeApi({
      adminTenant: vi.fn().mockResolvedValue(detail()),
      adminDisable: vi.fn().mockResolvedValue(disabled),
      adminEnable: vi.fn().mockResolvedValue(detail()),
    });
    page(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/reason/i), '  abuse ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(api.adminDisable).toHaveBeenCalledWith(55, 'abuse'));
    expect(await screen.findByTestId('admin-disabled')).toHaveTextContent('admin:ops@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(api.adminEnable).toHaveBeenCalledWith(55));
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('saves only the quotas given, and goes back to the defaults', async () => {
    const overridden = detail({ limits: { jobsPerDay: 50 }, quotas: { ...QUOTAS, jobsPerDay: 50 } });
    const api = fakeApi({
      adminTenant: vi.fn().mockResolvedValue(detail()),
      adminSetLimits: vi.fn().mockResolvedValueOnce(overridden).mockResolvedValueOnce(detail()),
    });
    page(api);
    const field = await screen.findByLabelText('Jobs per day');
    expect(field).toHaveAttribute('placeholder', '20');
    await userEvent.type(field, '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save quotas' }));
    await waitFor(() => expect(api.adminSetLimits).toHaveBeenCalledWith(55, { jobsPerDay: 50 }));

    await userEvent.click(await screen.findByRole('button', { name: 'Use the defaults' }));
    await waitFor(() => expect(api.adminSetLimits).toHaveBeenLastCalledWith(55, null));
    await waitFor(() => expect(screen.getByLabelText('Jobs per day')).toHaveValue(null));
  });

  it('releases a job only after the warning is confirmed, and shows a refusal', async () => {
    const api = fakeApi({
      adminTenant: vi.fn().mockResolvedValue(detail()),
      adminReleaseJob: vi.fn().mockRejectedValueOnce(new ApiError(500, 'internal_error', 'try again')).mockResolvedValueOnce(detail({ activeJobs: [] })),
    });
    page(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('outside the quota');
    expect(api.adminReleaseJob).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Release' }));
    expect(await screen.findByTestId('admin-action-error')).toHaveTextContent('try again');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(api.adminReleaseJob).toHaveBeenLastCalledWith('job_second001'));
    expect(await screen.findByText('No job of this tenant holds capacity right now.')).toBeInTheDocument();
  });

  it('says so to someone the server does not let in', async () => {
    page(fakeApi({ adminTenant: vi.fn().mockRejectedValue(new ApiError(403, 'forbidden')) }));
    expect(await screen.findByTestId('admin-forbidden')).toBeInTheDocument();
  });
});
