import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobView, Overview, WorkflowEvent, WorkflowView } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { InstallationPage } from './InstallationPage';
import { JobPage } from './JobPage';
import { WorkflowPage } from './WorkflowPage';

afterEach(cleanup);

const NOW = new Date().toISOString();
const workflow = (over: Partial<WorkflowView> = {}): WorkflowView => ({
  workflowId: '99-i7',
  repository: 'acme/web',
  repositoryId: 99,
  issue: 7,
  pullRequest: 12,
  prUrl: 'https://github.com/acme/web/pull/12',
  generation: 1,
  status: 'blocked',
  stage: 'waiting-for-ci',
  reason: 'ci_event_missed',
  message: 'The checks on aaaaaaaaaaaa finished (1 failed, 1 passed), but no job picked their result up: the check event never reached Updraft.',
  nextAction: 'Re-run a check on GitHub (its result restarts the review loop), or retry the last job from its page.',
  lastJobId: 'job_abcdefgh02',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const events: WorkflowEvent[] = [
  { id: 'job_abcdefgh01:started', at: NOW, seq: 1, kind: 'job_started', generation: 1, jobId: 'job_abcdefgh01', eventName: 'issues', stage: 'implementing' } as WorkflowEvent,
  {
    id: 'job_abcdefgh01:finished',
    at: NOW,
    kind: 'job_finished',
    generation: 1,
    jobId: 'job_abcdefgh01',
    outcome: 'succeeded',
    stage: 'waiting-for-ci',
    prNumber: 12,
    prUrl: 'https://github.com/acme/web/pull/12',
    steps: [
      { kind: 'implement', agent: 'claude', outcome: 'succeeded' },
      { kind: 'review', agent: 'codex', outcome: 'succeeded' },
    ],
    loop: { rounds: 0, maxRevisions: 3, reviews: 1, verdict: 'ready-to-merge' },
  },
  { id: 'ci-missed:aaa@3', at: NOW, kind: 'blocked', generation: 1, message: 'The check event never reached Updraft.' },
  { id: 'job_abcdefgh09:started', at: NOW, kind: 'job_started', generation: 2, jobId: 'job_abcdefgh09', eventName: 'issues', retry: false },
];

describe('workflows in the console', () => {
  it('shows a workflow: where it is, why it is blocked, what to do, and its timeline by run with roles', async () => {
    const api = fakeApi({ workflow: vi.fn().mockResolvedValue({ workflow: workflow({ generation: 2 }), events }) });
    render(
      <MemoryRouter initialEntries={['/installations/55/workflows/99-i7']}>
        <Routes>
          <Route path="/installations/:id/workflows/:workflowId" element={<WorkflowPage api={api} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('workflow')).toHaveTextContent('acme/web#7');
    expect(api.workflow).toHaveBeenCalledWith(55, '99-i7');
    expect(screen.getByTestId('workflow-status')).toHaveTextContent('Blocked');
    expect(screen.getByTestId('workflow-state')).toHaveTextContent('no job picked their result up');
    expect(screen.getByTestId('workflow-next')).toHaveTextContent('Re-run a check on GitHub');
    expect(screen.getByRole('link', { name: 'Latest job' })).toHaveAttribute('href', '/installations/55/jobs/job_abcdefgh02');
    const finished = screen.getByTestId('event-job_abcdefgh01:finished');
    expect(finished).toHaveTextContent('Job finished: succeeded');
    expect(finished).toHaveTextContent('Coding agent (claude): succeeded');
    expect(finished).toHaveTextContent('Review agent (codex): succeeded');
    expect(finished).toHaveTextContent('1 review(s), 0 of 3 revision round(s), last verdict ready to merge');
    expect(screen.getByTestId('event-ci-missed:aaa@3')).toHaveTextContent('Blocked');
    expect(screen.getByRole('region', { name: 'Run 2' })).toBeInTheDocument();
  });

  it('shows a pause that outlives its job, and an owner resumes exactly that pause from here', async () => {
    const user = userEvent.setup();
    const pause = { jobId: 'job_abcdefgh02', at: Date.now() - 9 * 86_400_000, by: 'pat', reason: 'off course', subject: 12, canResume: true };
    const resumeWorkflow = vi.fn().mockResolvedValue({ resumed: true });
    const api = fakeApi({ workflow: vi.fn().mockResolvedValueOnce({ workflow: workflow(), events, pause }).mockResolvedValue({ workflow: workflow(), events }), resumeWorkflow });
    render(
      <MemoryRouter initialEntries={['/installations/55/workflows/99-i7']}>
        <Routes>
          <Route path="/installations/:id/workflows/:workflowId" element={<WorkflowPage api={api} />} />
        </Routes>
      </MemoryRouter>,
    );
    const panel = await screen.findByTestId('workflow-pause');
    expect(panel).toHaveTextContent('Automation is paused. pat stopped job job_abcdefgh02');
    expect(panel).toHaveTextContent('off course');
    expect(within(panel).getByRole('link', { name: 'job job_abcdefgh02' })).toHaveAttribute('href', '/installations/55/jobs/job_abcdefgh02');
    await user.click(within(panel).getByRole('button', { name: 'Resume automation' }));
    expect(resumeWorkflow).toHaveBeenCalledWith(55, '99-i7', pause);
    await waitFor(() => expect(screen.queryByTestId('workflow-pause')).toBeNull());
  });

  it('shows a pause without the resume action to someone who may not resume it, and says why a resume failed', async () => {
    const pause = { jobId: 'job_abcdefgh02', at: Date.now(), by: 'pat', subject: 7, canResume: false };
    const view = fakeApi({ workflow: vi.fn().mockResolvedValue({ workflow: workflow(), events, pause }), resumeWorkflow: vi.fn() });
    const { unmount } = render(
      <MemoryRouter initialEntries={['/installations/55/workflows/99-i7']}>
        <Routes>
          <Route path="/installations/:id/workflows/:workflowId" element={<WorkflowPage api={view} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('workflow-pause')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume automation' })).toBeNull();
    unmount();

    const user = userEvent.setup();
    const owner = fakeApi({ workflow: vi.fn().mockResolvedValue({ workflow: workflow(), events, pause: { ...pause, canResume: true } }), resumeWorkflow: vi.fn().mockRejectedValue(new Error('A newer stop controls this workflow; look at it again before resuming')) });
    render(
      <MemoryRouter initialEntries={['/installations/55/workflows/99-i7']}>
        <Routes>
          <Route path="/installations/:id/workflows/:workflowId" element={<WorkflowPage api={owner} />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Resume automation' }));
    expect(await screen.findByTestId('workflow-pause-error')).toHaveTextContent('A newer stop controls this workflow');
  });

  it('refuses an address that is not a workflow without asking the API', async () => {
    const api = fakeApi();
    render(
      <MemoryRouter initialEntries={['/installations/55/workflows/nope']}>
        <Routes>
          <Route path="/installations/:id/workflows/:workflowId" element={<WorkflowPage api={api} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('workflow-error')).toHaveTextContent('There is no workflow at this address.');
    expect(api.workflow).not.toHaveBeenCalled();
  });

  it('lists workflows on the installation page, and keeps the page working when they cannot be read', async () => {
    const overview = {
      tenant: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' },
      installation: { status: 'active', checked: true, missingPermissions: [] },
      repositories: [],
      config: { activeVersion: 3, publishedAt: NOW, publishedBy: 'pat' },
      keys: [],
      activity: { window: { deliveries: 0, deliveriesComplete: true, jobs: 0, jobsComplete: true }, deliveries: {}, jobs: {}, running: 0, lastDeliveryAt: null },
    } as unknown as Overview;
    const api = fakeApi({
      overview: vi.fn().mockResolvedValue(overview),
      jobs: vi.fn().mockResolvedValue({ jobs: [] }),
      deliveries: vi.fn().mockResolvedValue({ deliveries: [] }),
      workflows: vi.fn().mockResolvedValue({ workflows: [workflow()] }),
    });
    render(
      <MemoryRouter initialEntries={['/installations/55?tab=workflows']}>
        <Routes>
          <Route path="/installations/:id" element={<InstallationPage api={api} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Workflows \(1\)/)).toBeInTheDocument();
    const row = await screen.findByTestId('workflow-99-i7');
    expect(within(row).getByRole('link', { name: 'acme/web#7' })).toHaveAttribute('href', '/installations/55/workflows/99-i7');
    expect(row).toHaveTextContent('Blocked');
    expect(row).toHaveTextContent('Waiting for CI');

    cleanup();
    const broken = fakeApi({ ...api, workflows: vi.fn().mockRejectedValue(new Error('no')) });
    render(
      <MemoryRouter initialEntries={['/installations/55']}>
        <Routes>
          <Route path="/installations/:id" element={<InstallationPage api={broken} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Workflows \(0\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('installation-error')).toBeNull();
  });

  it('links a job to its workflow', async () => {
    const job = { jobId: 'job_abcdefgh01', repository: 'acme/web', issue: 7, createdAt: NOW, status: 'finished', outcome: 'succeeded', result: 'success', logs: [] } as unknown as JobView;
    const api = fakeApi({ job: vi.fn().mockResolvedValue({ job, deliveries: [] }), jobWorkflow: vi.fn().mockResolvedValue({ workflowId: '99-i7' }) });
    render(
      <MemoryRouter initialEntries={['/installations/55/jobs/job_abcdefgh01']}>
        <Routes>
          <Route path="/installations/:id/jobs/:jobId" element={<JobPage api={api} />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('job-workflow')).toHaveAttribute('href', '/installations/55/workflows/99-i7'));
  });

  it('shows what a workflow added up to, saying what is estimated or missing, and that a rebuilt one is history', async () => {
    const totals = { jobs: 3, retries: 1, reviews: 2, revisions: 1, inputTokens: 12_500, outputTokens: 2_000, costUsd: 1.234, stepsWithoutCost: 1, subscription: true, activeSeconds: 900, wallSeconds: 3600, running: false };
    const api = fakeApi({ workflow: vi.fn().mockResolvedValue({ workflow: workflow({ workflowId: 'legacy-0123456789ab-i5', reconstructed: true, gaps: ['Rebuilt from job records, which are kept 30 days.'] }), events, totals }) });
    render(
      <MemoryRouter initialEntries={['/installations/55/workflows/legacy-0123456789ab-i5']}>
        <Routes>
          <Route path="/installations/:id/workflows/:workflowId" element={<WorkflowPage api={api} />} />
        </Routes>
      </MemoryRouter>,
    );
    const shown = await screen.findByTestId('workflow-totals');
    expect(shown).toHaveTextContent('3 (1 retry)');
    expect(shown).toHaveTextContent('12.5k in, 2.0k out');
    expect(shown).toHaveTextContent('Cost (estimate)$1.23');
    expect(within(shown).getByTitle(/not what was billed. 1 step\(s\) reported no cost/)).toBeInTheDocument();
    expect(screen.getByTestId('workflow-rebuilt')).toHaveTextContent('Rebuilt from job records');
  });

  it('narrows the list by status and repository', async () => {
    const { WorkflowsList } = await import('../components/workflows');
    render(
      <MemoryRouter>
        <WorkflowsList
          base="/installations/55"
          workflows={[workflow(), workflow({ workflowId: '98-i3', repository: 'acme/api', repositoryId: 98, issue: 3, status: 'finished', stage: 'merged' }), workflow({ workflowId: '99-i8', issue: 8, status: 'active', stage: 'implementing' })]}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId(/^workflow-/)).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Blocked (1)' }));
    expect(screen.getAllByTestId(/^workflow-/).map((e) => e.dataset.testid)).toEqual(['workflow-99-i7']);
    await userEvent.click(screen.getByRole('button', { name: 'All (3)' }));
    await userEvent.selectOptions(screen.getByLabelText('Repository'), 'acme/api');
    expect(screen.getAllByTestId(/^workflow-/).map((e) => e.dataset.testid)).toEqual(['workflow-98-i3']);
  });
});
