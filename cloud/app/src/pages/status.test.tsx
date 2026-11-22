import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Delivery, type JobView, type Overview } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { InstallationPage } from './InstallationPage';
import { JobPage } from './JobPage';

const NOW = new Date().toISOString();
const overview = (over: Partial<Overview> = {}): Overview => ({
  tenant: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' },
  installation: { status: 'active', checked: true, missingPermissions: [] },
  repositories: [
    { fullName: 'acme/web', htmlUrl: 'https://github.com/acme/web', private: true, reachable: true, configured: true, paused: false },
    { fullName: 'acme/docs', htmlUrl: 'https://github.com/acme/docs', private: false, reachable: true, configured: false, paused: false },
  ],
  config: { activeVersion: 3, publishedAt: NOW, publishedBy: 'pat' },
  keys: [
    { name: 'ANTHROPIC_API_KEY', configured: true, required: true },
    { name: 'CODEX_API_KEY', configured: false, required: false },
  ],
  activity: { window: { deliveries: 3, deliveriesComplete: true, jobs: 2, jobsComplete: true }, deliveries: { launched: 2, filtered: 1 }, jobs: { success: 1, verify_failure: 1 }, running: 0, lastDeliveryAt: NOW },
  ...over,
});
const job = (over: Partial<JobView> = {}): JobView => ({
  jobId: 'job_abcdefgh01',
  repository: 'acme/web',
  issue: 12,
  label: 'updraft',
  sender: 'pat',
  createdAt: NOW,
  status: 'finished',
  outcome: 'failed',
  configVersion: 3,
  durationSeconds: 125,
  deliveryId: 'd-1',
  result: 'verify_failure',
  issueUrl: 'https://github.com/acme/web/issues/12',
  logs: ['updraft.log', 'run.log'],
  ...over,
});
const deliveries: Delivery[] = [
  { at: NOW, deliveryId: 'd-3', event: 'issues', action: 'labeled', repository: 'acme/web', issue: 14, label: 'updraft', sender: 'sam', disposition: 'filtered', reason: 'actor_not_allowed' },
  { at: NOW, deliveryId: 'd-2', event: 'issues', action: 'labeled', repository: 'acme/web', issue: 13, disposition: 'throttled', reason: 'jobs_per_day' },
  { at: NOW, deliveryId: 'd-1', event: 'issues', action: 'labeled', repository: 'acme/web', issue: 12, disposition: 'launched', jobId: 'job_abcdefgh01' },
];

function showInstallation(api: ReturnType<typeof fakeApi>, path = '/installations/55', refreshMs?: number) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/installations/:id" element={<InstallationPage api={api} {...(refreshMs ? { refreshMs } : {})} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const api = (over: Partial<ReturnType<typeof fakeApi>> = {}) =>
  fakeApi({
    overview: vi.fn().mockResolvedValue(overview()),
    jobs: vi.fn().mockResolvedValue({ jobs: [job(), job({ jobId: 'job_abcdefgh02', issue: 11, result: 'success', outcome: 'succeeded', prUrl: 'https://github.com/acme/web/pull/7', telemetry: { traceId: 'ab'.repeat(16), traceUrl: 'https://ui.honeycomb.io/t', conversationUrl: 'https://ui.honeycomb.io/q', spans: 1, exported: 1, failed: 0 } })] }),
    deliveries: vi.fn().mockResolvedValue({ deliveries }),
    ...over,
  });

describe('InstallationPage (#71)', () => {
  it('shows the status, the numbers, and the jobs with how each ended', async () => {
    showInstallation(api());
    expect(await screen.findByTestId('installation-status')).toHaveTextContent('Active');
    const stats = screen.getByTestId('stats');
    expect(stats).toHaveTextContent('v3');
    expect(stats).toHaveTextContent('1 of 2');
    expect(stats).toHaveTextContent('50%');
    expect(screen.queryByTestId('attention')).not.toBeInTheDocument();
    const failed = screen.getByTestId('job-job_abcdefgh01');
    expect(failed).toHaveTextContent('Verification failed');
    expect(failed).toHaveTextContent('2 min 5 s');
    expect(within(failed).getByRole('link', { name: 'acme/web#12' })).toHaveAttribute('href', '/installations/55/jobs/job_abcdefgh01');
    expect(within(screen.getByTestId('job-job_abcdefgh02')).getByRole('link', { name: /pull request/i })).toHaveAttribute('href', 'https://github.com/acme/web/pull/7');
    expect(within(screen.getByTestId('job-job_abcdefgh02')).getByRole('link', { name: /conversation/i })).toHaveAttribute('href', 'https://ui.honeycomb.io/q');
  });

  it('says when its counts are of the latest jobs, not all 30 days', async () => {
    showInstallation(api({ overview: vi.fn().mockResolvedValue(overview({ activity: { ...overview().activity, window: { deliveries: 500, deliveriesComplete: false, jobs: 500, jobsComplete: false } } })) }));
    expect(await screen.findByTestId('stats')).toHaveTextContent('Latest 500 jobs');
  });

  it('says what needs attention, and where to fix each', async () => {
    showInstallation(
      api({
        overview: vi.fn().mockResolvedValue(
          overview({
            installation: { status: 'missing_permissions', checked: true, missingPermissions: [{ name: 'contents', needs: 'write', granted: 'read' }] },
            config: { activeVersion: null },
            keys: [{ name: 'ANTHROPIC_API_KEY', configured: false, required: true }],
            repositories: [{ fullName: 'acme/gone', reachable: false, configured: true, paused: false }],
          }),
        ),
      }),
    );
    expect(await screen.findByTestId('installation-status')).toHaveTextContent('Missing permissions');
    // Setting up: the checklist says what is left, step by step, each with where to do it.
    const app = screen.getByTestId('setup-app');
    expect(app).toHaveAttribute('aria-current', 'step');
    expect(app).toHaveTextContent('contents (write)');
    expect(within(app).getByRole('link', { name: /Review permissions/ })).toHaveAttribute('href', 'https://github.com/organizations/acme/settings/installations/55');
    expect(within(screen.getByTestId('setup-config')).getByRole('link', { name: 'Configure' })).toHaveAttribute('href', '/installations/55/config');
    expect(within(screen.getByTestId('setup-keys')).getByRole('link', { name: 'Add keys' })).toHaveAttribute('href', '/installations/55/keys');
    // Needs attention keeps only what the checklist does not say.
    expect(screen.queryByTestId('attention-permissions')).toBeNull();
    expect(screen.queryByTestId('attention-config')).toBeNull();
    expect(screen.getByTestId('attention-unreachable')).toHaveTextContent('acme/gone');
  });

  it('walks a new installation to its first job, the next step open, and leaves once jobs can run', async () => {
    const fresh = overview({
      config: { activeVersion: 2, triggers: [{ repository: 'acme/web', label: 'updraft' }] },
      keys: [
        { name: 'ANTHROPIC_API_KEY', configured: false, required: true },
        { name: 'KIRO_API_KEY', configured: false, required: false },
      ],
      telemetry: { configured: false, enabled: false },
      activity: { window: { deliveries: 0, deliveriesComplete: true, jobs: 0, jobsComplete: true }, deliveries: {}, jobs: {}, running: 0 },
    });
    const { unmount } = showInstallation(api({ overview: vi.fn().mockResolvedValue(fresh), jobs: vi.fn().mockResolvedValue({ jobs: [] }), deliveries: vi.fn().mockResolvedValue({ deliveries: [] }) }));
    expect(await screen.findByTestId('setup-progress')).toHaveTextContent('3 of 5 done');
    const keys = screen.getByTestId('setup-keys');
    expect(keys).toHaveAttribute('aria-current', 'step');
    expect(keys).toHaveTextContent('Your configuration runs Claude: add its key.');
    expect(screen.getByTestId('setup-telemetry')).toHaveTextContent('Optional');
    expect(within(screen.getByTestId('setup-first-job')).getByRole('link', { name: /Open its issues/ })).toHaveAttribute('href', 'https://github.com/acme/web/issues');
    unmount();
    // Keys in, then the first job: the next step says which label to add, where.
    showInstallation(
      api({
        overview: vi.fn().mockResolvedValue({ ...fresh, keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true }] }),
        jobs: vi.fn().mockResolvedValue({ jobs: [] }),
        deliveries: vi.fn().mockResolvedValue({ deliveries: [] }),
      }),
    );
    const first = await screen.findByTestId('setup-first-job');
    expect(first).toHaveAttribute('aria-current', 'step');
    expect(first).toHaveTextContent('Add the label updraft to an issue in acme/web.');
  });

  it("sends the first job to the configuration when no label there is the viewer's to apply, and counts a first job after its record is gone", async () => {
    const ready = overview({
      config: { activeVersion: 2 },
      keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true }],
      telemetry: { configured: false, enabled: false },
      activity: { window: { deliveries: 0, deliveriesComplete: true, jobs: 0, jobsComplete: true }, deliveries: {}, jobs: {}, running: 0 },
    });
    const { unmount } = showInstallation(api({ overview: vi.fn().mockResolvedValue(ready), jobs: vi.fn().mockResolvedValue({ jobs: [] }), deliveries: vi.fn().mockResolvedValue({ deliveries: [] }) }));
    const first = await screen.findByTestId('setup-first-job');
    expect(first).toHaveTextContent('add your GitHub login to the allowed actors');
    expect(within(first).getByRole('link', { name: 'Edit configuration' })).toHaveAttribute('href', '/installations/55/config');
    unmount();
    showInstallation(api({ overview: vi.fn().mockResolvedValue({ ...ready, activity: { ...ready.activity, firstJobAt: '2026-10-01T00:00:00.000Z' } }), jobs: vi.fn().mockResolvedValue({ jobs: [] }), deliveries: vi.fn().mockResolvedValue({ deliveries: [] }) }));
    await screen.findByTestId('installation-status');
    expect(screen.queryByTestId('setup')).toBeNull();
  });

  it('shows no checklist once every step jobs need is done, telemetry or not', async () => {
    showInstallation(api({ overview: vi.fn().mockResolvedValue(overview({ telemetry: { configured: false, enabled: false } })) }));
    await screen.findByTestId('installation-status');
    expect(screen.queryByTestId('setup')).toBeNull();
  });

  it('lists deliveries with what became of each, and filters to the problems', async () => {
    showInstallation(api(), '/installations/55?tab=deliveries');
    const list = await screen.findByTestId('delivery-list');
    expect(within(list).getByTestId('delivery-d-3')).toHaveTextContent('The person who applied the label may not start work.');
    expect(within(list).getByTestId('delivery-d-2')).toHaveTextContent('The daily job limit was reached.');
    expect(within(within(list).getByTestId('delivery-d-1')).getByRole('link', { name: 'View job' })).toHaveAttribute('href', '/installations/55/jobs/job_abcdefgh01');
    await userEvent.click(screen.getByRole('button', { name: /problems/i }));
    await waitFor(() => expect(screen.queryByTestId('delivery-d-3')).not.toBeInTheDocument());
    expect(screen.getByTestId('delivery-d-2')).toBeInTheDocument();
  });

  it('shows the repositories with which are configured', async () => {
    showInstallation(api(), '/installations/55?tab=repositories');
    const list = await screen.findByTestId('repository-list');
    expect(list).toHaveTextContent('acme/webPrivateConfigured');
    expect(list).toHaveTextContent('acme/docsNot configured');
  });

  it('refreshes itself while a job runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const a = api({ overview: vi.fn().mockResolvedValue(overview({ activity: { window: { deliveries: 3, deliveriesComplete: true, jobs: 2, jobsComplete: true }, deliveries: {}, jobs: {}, running: 1 } })) });
      showInstallation(a, '/installations/55', 1000);
      await screen.findByTestId('installation-status');
      expect(a.overview).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      await waitFor(() => expect(a.overview).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a refusal, and never calls the API for a bad id', async () => {
    const refused = api({ overview: vi.fn().mockRejectedValue(new ApiError(403, 'not_authorized', 'You are not a member of that installation')) });
    showInstallation(refused);
    expect(await screen.findByTestId('installation-error')).toHaveTextContent('not a member');
    const never = api();
    showInstallation(never, '/installations/abc');
    expect(never.overview).not.toHaveBeenCalled();
  });
});

function showJob(a: ReturnType<typeof fakeApi>, path = '/installations/55/jobs/job_abcdefgh01') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/installations/:id/jobs/:jobId" element={<JobPage api={a} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('JobPage (#71)', () => {
  it('says how the job ended and what to do, with its facts, deliveries and the agent transcript first', async () => {
    const jobLog = vi.fn().mockImplementation(async (_id: number, _job: string, name: string) => ({ name, text: `${name} contents\nnpm test failed\n`, size: 40, truncated: false }));
    showJob(fakeApi({ job: vi.fn().mockResolvedValue({ job: job(), deliveries: [deliveries[2]] }), jobLog }));
    expect(await screen.findByTestId('job-result')).toHaveTextContent('Verification failed');
    expect(screen.getByTestId('job-help')).toHaveTextContent("verify commands");
    expect(screen.getByTestId('job-facts')).toHaveTextContent('2 min 5 s');
    expect(within(screen.getByTestId('job-facts')).getByRole('link', { name: 'v3' })).toHaveAttribute('href', '/installations/55/config/history');
    expect(screen.getByTestId('job-deliveries')).toHaveTextContent('Launched');
    expect(await screen.findByTestId('log-text')).toHaveTextContent('run.log contents');
    expect(jobLog).toHaveBeenCalledWith(55, 'job_abcdefgh01', 'run.log');
    await userEvent.click(screen.getByText('Updraft log'));
    await waitFor(() => expect(screen.getByTestId('log-text')).toHaveTextContent('updraft.log contents'));
  });

  it('says when a log was cut to its end, and when it has expired', async () => {
    const jobLog = vi
      .fn()
      .mockResolvedValueOnce({ name: 'run.log', text: 'tail\n', size: 5 * 1024 * 1024, truncated: true })
      .mockRejectedValue(new ApiError(410, 'log_expired', 'expired'));
    showJob(fakeApi({ job: vi.fn().mockResolvedValue({ job: job(), deliveries: [] }), jobLog }));
    expect(await screen.findByTestId('log-size')).toHaveTextContent('of 5.0 MB');
    await userEvent.click(screen.getByText('Updraft log'));
    expect(await screen.findByText('This log has expired')).toBeInTheDocument();
  });

  it('shows a running job without logs yet, and refuses a bad job id without asking', async () => {
    showJob(fakeApi({ job: vi.fn().mockResolvedValue({ job: job({ status: 'launched', result: 'running', logs: [], durationSeconds: undefined }), deliveries: [] }) }));
    expect(await screen.findByText('Logs appear when the job ends')).toBeInTheDocument();
    expect(screen.getByTestId('job-facts')).toHaveTextContent('Running…');
    const never = fakeApi();
    showJob(never, '/installations/55/jobs/not-a-job');
    expect(await screen.findByTestId('job-error')).toBeInTheDocument();
    expect(never.job).not.toHaveBeenCalled();
  });
});
