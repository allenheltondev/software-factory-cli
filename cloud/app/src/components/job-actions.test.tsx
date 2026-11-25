import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { JobView } from '../api/client';
import { JobActions, JobStopStatus } from './job-actions';

const job: JobView = { jobId: 'job_stoppable01', repository: 'acme/web', issue: 12, canStop: true,
  status: 'launched', result: 'running', createdAt: new Date().toISOString(), logs: [] };
describe('job card stop action', () => {
  it('offers a secondary action, confirms its exact target, and restores focus on cancel', async () => {
    const user = userEvent.setup(); const stopJob = vi.fn();
    render(<JobActions job={job} installationId={55} api={{ stopJob }} onRefresh={() => {}} />);
    const trigger = screen.getByLabelText('Actions for acme/web#12');
    expect(screen.queryByRole('button', { name: 'Stop job' })).not.toBeVisible();
    trigger.focus(); await user.keyboard('{Enter}'); await user.click(screen.getByRole('button', { name: 'Stop job' }));
    expect(screen.getByRole('dialog')).toBeVisible(); expect(screen.getByText(job.jobId)).toBeVisible();
    expect(screen.getByText(/Existing commits, pull requests and logs are preserved/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(stopJob).not.toHaveBeenCalled(); expect(trigger).toHaveFocus();
  });
  it('requests only a job ID, refreshes authoritative status, and shows a retryable error', async () => {
    const user = userEvent.setup(); const refresh = vi.fn();
    const stopJob = vi.fn().mockRejectedValueOnce(new Error('AWS unavailable')).mockResolvedValueOnce({ jobId: job.jobId, state: 'stopping' });
    render(<JobActions job={job} installationId={55} api={{ stopJob }} onRefresh={refresh} />);
    await user.click(screen.getByLabelText('Actions for acme/web#12')); await user.click(screen.getByRole('button', { name: 'Stop job' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop job' }));
    expect(await screen.findByText('AWS unavailable')).toBeVisible(); expect(refresh).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop job' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); expect(stopJob).toHaveBeenLastCalledWith(55, job.jobId);
  });
  it('hides actions from nonoperators and reports stopping separately from confirmed cancellation', () => {
    const { rerender } = render(<JobActions job={{ ...job, canStop: false }} installationId={55} api={{ stopJob: vi.fn() }} onRefresh={() => {}} />);
    expect(screen.queryByLabelText(/Actions/)).not.toBeInTheDocument();
    const stop = { requestedAt: Date.now(), by: 'pat', reason: 'off course' };
    rerender(<JobStopStatus job={{ ...job, stop }} />);
    expect(screen.getByText(/Execution has not yet been confirmed stopped/)).toBeVisible();
    rerender(<JobStopStatus job={{ ...job, outcome: 'canceled', stop: { ...stop, confirmedAt: Date.now(), reconnectRequired: true } }} />);
    expect(screen.getByText(/Canceled. Requested by pat/)).toBeVisible();
    expect(screen.getByText(/Reconnect Claude/)).toBeVisible();
  });
  it('resumes future automation explicitly without restarting the stopped job', async () => {
    const user = userEvent.setup(); const resumeJob = vi.fn().mockResolvedValue({ resumed: true }); const refresh = vi.fn();
    render(<JobActions job={{ ...job, canStop: false, canResume: true }} installationId={55} api={{ resumeJob }} onRefresh={refresh} />);
    await user.click(screen.getByLabelText('Actions for acme/web#12'));
    await user.click(screen.getByRole('button', { name: 'Resume automation' }));
    expect(resumeJob).toHaveBeenCalledWith(55, job.jobId); expect(refresh).toHaveBeenCalledOnce();
  });
});
