import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobView, Overview, WorkflowEvent, WorkflowView } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { InstallationPage } from './InstallationPage';
import { JobPage } from './JobPage';
import { WorkflowPage } from './WorkflowPage';
import { reasonLabel } from '../components/workflows';

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
  it('shows waits with how long they lasted, stop and resume with who, the route and models, and marks where the workflow is now', async () => {
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const timeline: WorkflowEvent[] = [
      { id: 'job_old000001:started', at: old, seq: 1, kind: 'job_started', generation: 1, jobId: 'job_old000001', eventName: 'issues' },
      { id: 'job_abcdefgh01:queued', at: NOW, seq: 2, kind: 'waiting', generation: 1, jobId: 'job_abcdefgh01', stage: 'queued', reason: 'concurrent_jobs', message: 'Queued: another job is running.' },
      { id: 'job_abcdefgh01:started', at: NOW, seq: 3, kind: 'job_started', generation: 1, jobId: 'job_abcdefgh01', eventName: 'check_suite' },
      { id: 'job_abcdefgh01:admitted', at: NOW, seq: 4, kind: 'admitted', generation: 1, jobId: 'job_abcdefgh01', reason: 'concurrent_jobs', waited: { for: 'capacity', since: NOW, seconds: 720 } },
      {
        id: 'job_abcdefgh01:finished', at: NOW, seq: 5, kind: 'job_finished', generation: 1, jobId: 'job_abcdefgh01', outcome: 'succeeded', prNumber: 12,
        routing: { source: 'tier', tier: 'complex', requestedTier: 'standard', reason: 'low-confidence' },
        steps: [{ kind: 'revision', agent: 'coder', adapter: 'claude', model: 'claude-opus-4', effort: 'high', outcome: 'succeeded' }],
      },
      { id: 'recovery:ci:1:abc:1:1', at: NOW, seq: 6, kind: 'recovery', generation: 1, jobId: 'job_abcdefgh01', headSha: 'abcdef1234567890', message: 'Started the CI step.' },
      { id: 'control:stop:job_abcdefgh01:1', at: NOW, seq: 7, kind: 'control', generation: 1, jobId: 'job_abcdefgh01', control: { action: 'stop_requested', by: 'pat', reason: 'wrong file' } },
      { id: 'control:pause:control-abc:1', at: NOW, seq: 7, kind: 'control', generation: 1, jobId: 'control-abc', control: { action: 'paused', by: 'pat' } },
      { id: 'control:resume:job_abcdefgh01:1', at: NOW, seq: 8, kind: 'control', generation: 1, jobId: 'job_abcdefgh01', control: { action: 'resumed', by: 'sam' }, waited: { for: 'pause', since: NOW, seconds: 3600 } },
      { id: 'job_late00001:finished', at: NOW, occurredAt: old, seq: 9, kind: 'finish_recovered', generation: 1, jobId: 'job_late00001', outcome: 'failed', waited: { for: 'ci', since: NOW, seconds: 90 } },
    ];
    const history = { shown: 10, omitted: 3, complete: true, workflowRetentionDays: 90, eventRetentionDays: 90, jobRetentionDays: 30, expiredEarlier: true };
    const api = fakeApi({ workflow: vi.fn().mockResolvedValue({ workflow: workflow({ status: 'waiting', paused: true, pastPullRequests: [{ number: 4, generation: 1 }] }), events: timeline, history }) });
    render(
      <MemoryRouter initialEntries={['/installations/55/workflows/99-i7']}>
        <Routes>
          <Route path="/installations/:id/workflows/:workflowId" element={<WorkflowPage api={api} refreshMs={60_000} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('workflow')).toHaveTextContent('Paused');
    expect(screen.getByRole('link', { name: 'Run 1: pull request #4 ↗' })).toHaveAttribute('href', 'https://github.com/acme/web/pull/4');
    const queued = screen.getByTestId('event-job_abcdefgh01:queued');
    expect(queued).toHaveTextContent('Queued for capacity');
    expect(queued).toHaveTextContent('Reason code: concurrent_jobs');
    expect(screen.getByTestId('event-job_abcdefgh01:admitted')).toHaveTextContent(/Started from the queue.*After waiting 12 min for capacity/);
    const finished = screen.getByTestId('event-job_abcdefgh01:finished');
    expect(finished).toHaveTextContent('Tier complex (first chosen: standard) · routing reason: low confidence');
    expect(finished).toHaveTextContent('Coding agent (coder · claude · claude-opus-4 · effort high): succeeded');
    // A pull request link from its number, when the event has no URL.
    expect(within(finished).getByRole('link', { name: 'Pull request #12 ↗' })).toHaveAttribute('href', 'https://github.com/acme/web/pull/12');
    expect(within(screen.getByTestId('event-recovery:ci:1:abc:1:1')).getByRole('link', { name: 'Commit abcdef1 ↗' })).toHaveAttribute('href', 'https://github.com/acme/web/commit/abcdef1234567890');
    expect(screen.getByTestId('event-control:stop:job_abcdefgh01:1')).toHaveTextContent(/Stop requested.*By pat: wrong file/);
    const resumed = screen.getByTestId('event-control:resume:job_abcdefgh01:1');
    expect(resumed).toHaveTextContent('Automation resumed');
    expect(resumed).toHaveTextContent('By sam');
    expect(resumed).toHaveTextContent('Paused for 1 h');
    // The newest event is where the workflow is now; it happened before it was recorded.
    const late = screen.getByTestId('event-job_late00001:finished');
    expect(late).toHaveAttribute('aria-current', 'step');
    expect(late).toHaveTextContent('Latest');
    expect(late).toHaveTextContent('recorded later');
    expect(late).toHaveTextContent("After waiting 1 min 30 s for the pull request's checks");
    expect(screen.getAllByText('Latest')).toHaveLength(1);
    // A job whose record is past its retention is not a dead link.
    expect(within(screen.getByTestId('event-job_old000001:started')).queryByRole('link', { name: 'Job' })).toBeNull();
    expect(screen.getByTestId('event-job_old000001:started')).toHaveTextContent('Job record expired');
    expect(within(late).queryByRole('link', { name: 'Job' })).toBeNull();
    expect(within(resumed).getByRole('link', { name: 'Job' })).toHaveAttribute('href', '/installations/55/jobs/job_abcdefgh01');
    // An id that names no job record (a command's) gets no job link at all.
    expect(within(screen.getByTestId('event-control:pause:control-abc:1')).queryByRole('link', { name: 'Job' })).toBeNull();
    expect(screen.getByTestId('event-control:pause:control-abc:1')).toHaveTextContent(/Paused from GitHub.*By pat/);
    const kept = screen.getByTestId('workflow-history');
    expect(kept).toHaveTextContent('Showing the latest 10 events; 3 older events are not shown.');
    expect(kept).toHaveTextContent('began more than 90 days ago');
    expect(kept).toHaveTextContent("job records 30 days, and a stop's pause until it is resumed");
  });

  it('says when a history read was cut short, and keeps polling a workflow that waits', async () => {
    const history = { shown: 1, omitted: 0, complete: false, workflowRetentionDays: 90, eventRetentionDays: 90, jobRetentionDays: 30, expiredEarlier: false };
    const read = vi.fn().mockResolvedValue({ workflow: workflow({ status: 'waiting', stage: 'queued' }), events: events.slice(0, 1), history });
    render(
      <MemoryRouter initialEntries={['/installations/55/workflows/99-i7']}>
        <Routes>
          <Route path="/installations/:id/workflows/:workflowId" element={<WorkflowPage api={fakeApi({ workflow: read })} refreshMs={20} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('workflow-history')).toHaveTextContent('some may not be shown');
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
  });

  it('finds paused workflows with a filter of their own, whatever their status says', async () => {
    const { WorkflowsList } = await import('../components/workflows');
    render(
      <MemoryRouter>
        <WorkflowsList
          base="/installations/55"
          workflows={[workflow({ paused: true, reason: 'job_canceled' }), workflow({ workflowId: '99-i8', issue: 8, status: 'finished', stage: 'merged' }), workflow({ workflowId: '99-i9', issue: 9, status: 'finished', stage: 'done', paused: true })]}
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Paused (2)' }));
    expect(screen.getAllByTestId(/^workflow-/).map((e) => e.dataset.testid)).toEqual(['workflow-99-i7', 'workflow-99-i9']);
    expect(within(screen.getByTestId('workflow-99-i9')).getByText('Paused')).toBeInTheDocument();
  });
});

describe('Claude wait reasons on the timeline (#176)', () => {
  it('names each new reason code in words, and leaves other codes alone', () => {
    expect(reasonLabel('claude_session_worker_lost')).toBe('The Claude session ended because its worker stopped answering; a new one needs a sign-in');
    expect(reasonLabel('claude_session_lifetime')).toBe('The Claude session ended because it reached its maximum lifetime; a new one needs a sign-in');
    expect(reasonLabel('claude_session_vm_ended')).toMatch(/its VM stopped running/);
    expect(reasonLabel('claude_session_something_new')).toMatch(/because something new;/);
    expect(reasonLabel('claude_startup_failed')).toBe('The Claude session never became ready');
    expect(reasonLabel('claude_auth_required')).toBe('Claude needs a sign-in');
    expect(reasonLabel('concurrent_jobs')).toBeUndefined();
    expect(reasonLabel('claude_unknown_thing')).toBeUndefined();
  });
});
