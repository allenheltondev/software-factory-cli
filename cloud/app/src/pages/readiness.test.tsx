import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient, type Overview, type ReadinessCheck, type ReadinessReport } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { InstallationPage } from './InstallationPage';

const NOW = new Date().toISOString();
const overview: Overview = {
  tenant: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' },
  installation: { status: 'active', checked: true, missingPermissions: [] },
  repositories: [{ fullName: 'acme/web', htmlUrl: 'https://github.com/acme/web', private: true, reachable: true, configured: true, paused: false }],
  config: { activeVersion: 3, publishedAt: NOW, publishedBy: 'pat' },
  keys: [],
  telemetry: { configured: false, enabled: false },
  activity: { window: { deliveries: 0, deliveriesComplete: true, jobs: 0, jobsComplete: true }, deliveries: {}, jobs: {}, running: 0 },
} as Overview;

const c = (id: string, over: Partial<ReadinessCheck> = {}): ReadinessCheck => ({ id, stage: 'config', required: true, state: 'verified', summary: `${id} summary`, ...over });
const report = (over: Partial<ReadinessReport> = {}): ReadinessReport => ({
  checkedAt: NOW,
  cached: false,
  configVersion: 3,
  installation: [c('tenant', { stage: 'installation' }), c('telemetry', { stage: 'telemetry', required: false, state: 'off', fix: { text: 'Set up telemetry', target: 'telemetry' } })],
  repositories: [
    {
      repository: 'acme/web', repositoryId: 9, status: 'action_needed',
      checks: [
        c('agent-keys', { stage: 'credentials', state: 'failing', problem: 'missing_credentials', summary: 'ANTHROPIC_API_KEY is needed and not set.', fix: { text: 'Add the key', target: 'keys' } }),
        c('github-events', { stage: 'github', state: 'failing', problem: 'permissions', summary: 'The App is not subscribed to check_suite.', fix: { text: 'Accept the events on GitHub', target: 'github' } }),
        c('ci-logs', { stage: 'ci', required: false, state: 'failing', problem: 'permissions', summary: 'No Actions logs.' }),
        c('egress', { stage: 'egress', state: 'unverified', unverified: 'needs_run', summary: 'Registry access needs a run.' }),
      ],
    },
    { repository: 'acme/api', repositoryId: 10, status: 'ready', checks: [c('triggers')] },
    { repository: 'acme/docs', repositoryId: 11, status: 'unknown', checks: [c('github-permissions', { stage: 'github', state: 'unverified', unverified: 'read_failed', summary: 'GitHub could not be asked.' })] },
    { repository: 'acme/site', repositoryId: 12, status: 'not_configured', checks: [] },
  ],
  limitations: ['Readiness does not run a job.'],
  ...over,
});

function show(readiness: ReturnType<typeof vi.fn>) {
  const api = fakeApi({
    overview: vi.fn().mockResolvedValue(overview),
    jobs: vi.fn().mockResolvedValue({ jobs: [] }),
    deliveries: vi.fn().mockResolvedValue({ deliveries: [] }),
    readiness: readiness as unknown as ApiClient['readiness'],
  });
  render(
    <MemoryRouter initialEntries={['/installations/55?tab=repositories']}>
      <Routes>
        <Route path="/installations/:id" element={<InstallationPage api={api} />} />
      </Routes>
    </MemoryRouter>,
  );
  return api;
}

describe('repository readiness in the console (#137)', () => {
  it('shows each repository with its state, its stage-specific problems and where to fix them', async () => {
    const readiness = vi.fn().mockResolvedValue(report());
    show(readiness);
    const web = await screen.findByTestId('readiness-acme/web');
    expect(within(web).getByText('Action needed')).toBeInTheDocument();
    expect(web).toHaveTextContent('2 to resolve');
    // Expanded by default, since something must be fixed.
    expect(web.querySelector('details')).toHaveAttribute('open');
    const keys = within(web).getByTestId('check-agent-keys');
    expect(keys).toHaveTextContent('Agent keys');
    expect(keys).toHaveTextContent('Failing');
    expect(within(keys).getByRole('link', { name: 'Add the key' })).toHaveAttribute('href', '/installations/55/keys');
    expect(within(within(web).getByTestId('check-github-events')).getByRole('link', { name: /Accept the events/ })).toHaveAttribute('href', 'https://github.com/organizations/acme/settings/installations/55');
    // Optional problems and what only a run shows are labeled as such, never as failing or verified.
    expect(within(web).getByTestId('check-ci-logs')).toHaveTextContent('Optional');
    expect(within(web).getByTestId('check-egress')).toHaveTextContent('Needs a run');
    expect(within(web).getByTestId('check-telemetry')).toHaveTextContent('Off');
    expect(within(web).getByTestId('check-telemetry')).toHaveTextContent('optional');

    expect(within(screen.getByTestId('readiness-acme/api')).getByText('Ready')).toBeInTheDocument();
    const docs = screen.getByTestId('readiness-acme/docs');
    expect(within(docs).getByText('Unknown')).toBeInTheDocument();
    expect(within(docs).getByTestId('check-github-permissions')).toHaveTextContent('Not verified');
    expect(screen.getByTestId('readiness')).toHaveTextContent('acme/site is reachable but not configured');
    expect(screen.getByTestId('readiness-checked')).toHaveTextContent('configuration v3');
    expect(screen.getByTestId('readiness-limitations')).toHaveTextContent('does not run a job');
    expect(readiness).toHaveBeenCalledWith(55, true);
  });

  it('says when a result is a saved one, and checks again on request', async () => {
    const readiness = vi.fn().mockResolvedValueOnce(report({ cached: true })).mockResolvedValueOnce(report({ repositories: [{ repository: 'acme/web', status: 'ready', checks: [c('triggers')] }] }));
    show(readiness);
    expect(await screen.findByTestId('readiness-checked')).toHaveTextContent('saved result');
    await userEvent.click(screen.getByRole('button', { name: 'Check readiness again' }));
    await waitFor(() => expect(within(screen.getByTestId('readiness-acme/web')).getByText('Ready')).toBeInTheDocument());
    expect(readiness).toHaveBeenLastCalledWith(55, true);
    expect(screen.getByTestId('readiness-checked')).not.toHaveTextContent('saved result');
  });

  it('marks the shown result outdated when checking again fails', async () => {
    const readiness = vi.fn().mockResolvedValueOnce(report()).mockRejectedValueOnce(new ApiError(502, 'internal_error', 'Bad gateway'));
    show(readiness);
    expect(await screen.findByTestId('readiness-report')).not.toHaveAttribute('data-stale');
    await userEvent.click(screen.getByRole('button', { name: 'Check readiness again' }));
    expect(await screen.findByTestId('readiness-error')).toHaveTextContent('may be out of date');
    expect(screen.getByTestId('readiness-report')).toHaveAttribute('data-stale', 'true');
  });

  it('shows a failed check as an error, never as an empty healthy list', async () => {
    show(vi.fn().mockRejectedValue(new ApiError(403, 'not_authorized', 'You are not a member of that installation')));
    expect(await screen.findByTestId('readiness-error')).toHaveTextContent('not a member');
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('shows installation-wide problems once, for every repository', async () => {
    show(vi.fn().mockResolvedValue(report({
      installation: [c('kill-switch', { stage: 'capacity', state: 'failing', problem: 'paused', summary: 'The platform has paused all jobs.' })],
      repositories: [{ repository: 'acme/web', status: 'paused', checks: [] }],
    })));
    const all = await screen.findByTestId('readiness-installation');
    expect(all).toHaveTextContent('The platform has paused all jobs.');
    expect(within(all).getByTestId('check-kill-switch')).toHaveTextContent('Paused');
    expect(screen.getByTestId('readiness-acme/web').querySelector('summary')).toHaveTextContent('Paused');
  });
});
