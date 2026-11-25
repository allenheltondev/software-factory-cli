import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  message: 'The checks on aaaaaaaaaaaa finished, but no job picked their result up, after 2 recoveries.',
  nextAction: 'Retry the last job from its page, or push to the pull request.',
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
  { id: 'ci-recovered:aaa:1', at: NOW, kind: 'ci_recovered', generation: 1, jobId: 'job_abcdefgh02', message: 'queued the step that event would have started.' },
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
    expect(screen.getByTestId('workflow-next')).toHaveTextContent('Retry the last job from its page');
    expect(screen.getByRole('link', { name: 'Latest job' })).toHaveAttribute('href', '/installations/55/jobs/job_abcdefgh02');
    const finished = screen.getByTestId('event-job_abcdefgh01:finished');
    expect(finished).toHaveTextContent('Job finished: succeeded');
    expect(finished).toHaveTextContent('Coding agent (claude): succeeded');
    expect(finished).toHaveTextContent('Review agent (codex): succeeded');
    expect(finished).toHaveTextContent('1 review(s), 0 of 3 revision round(s), last verdict ready to merge');
    expect(screen.getByTestId('event-ci-recovered:aaa:1')).toHaveTextContent('Missed check event recovered');
    expect(screen.getByRole('region', { name: 'Run 2' })).toBeInTheDocument();
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
});
