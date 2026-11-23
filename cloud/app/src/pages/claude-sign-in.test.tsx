import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ClaudeSignInView } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { ClaudeSignInPage } from './ClaudeSignInPage';

const URL = 'https://claude.ai/oauth/authorize?IeTNORyX8crYI1Al5bOf5n3lUsK';
const waiting: ClaudeSignInView = { state: 'waiting', repository: 'acme/web', issue: 12, url: URL, waitsUntil: '2026-11-22T12:15:00.000Z' };

const show = (api: ReturnType<typeof fakeApi>) =>
  render(
    <MemoryRouter initialEntries={['/installations/55/claude-sign-in/job_signin01']}>
      <Routes>
        <Route path="/installations/:id/claude-sign-in/:jobId" element={<ClaudeSignInPage api={api} pollMs={10} />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ClaudeSignInPage', () => {
  it('gives the claude.ai link and takes the code, then follows the job until it is signed in', async () => {
    const views: ClaudeSignInView[] = [{ state: 'exchanging', repository: 'acme/web', issue: 12, by: 'pat' }, { state: 'done', repository: 'acme/web', issue: 12, by: 'pat' }];
    const done: ClaudeSignInView = { state: 'done', repository: 'acme/web', issue: 12, by: 'pat' };
    const claudeSignIn = vi.fn(async (): Promise<ClaudeSignInView> => (claudeSignIn.mock.calls.length === 1 ? waiting : (views.shift() ?? done)));
    const submitClaudeSignInCode = vi.fn(async () => ({ state: 'code', repository: 'acme/web', issue: 12, by: 'pat' }) as ClaudeSignInView);
    show(fakeApi({ claudeSignIn, submitClaudeSignInCode }));
    expect(await screen.findByTestId('sign-in-link')).toHaveAttribute('href', URL);
    expect(screen.getByTestId('sign-in')).toHaveTextContent('Job for acme/web#12');
    expect(screen.getByTestId('sign-in-deadline')).toHaveTextContent('apply the label again');
    await userEvent.type(screen.getByLabelText('Code from Claude'), ' abc123#state ');
    await userEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    expect(submitClaudeSignInCode).toHaveBeenCalledWith(55, 'job_signin01', 'abc123#state');
    expect(await screen.findByTestId('sign-in-finishing')).toHaveTextContent('Code received from pat');
    expect(await screen.findByTestId('sign-in-done')).toHaveTextContent('Signed in by pat');
  });

  it("says why the code was not taken, and why a sign-in did not finish", async () => {
    show(
      fakeApi({
        claudeSignIn: async () => waiting,
        submitClaudeSignInCode: async () => {
          throw new ApiError(409, 'sign_in_closed', 'This sign-in is not waiting for a code any more');
        },
      }),
    );
    await userEvent.type(await screen.findByLabelText('Code from Claude'), 'abc123#state');
    await userEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    expect(await screen.findByTestId('sign-in-submit-error')).toHaveTextContent('not waiting for a code any more');
  });

  it('shows a sign-in that failed with its reason', async () => {
    show(fakeApi({ claudeSignIn: async () => ({ state: 'failed', repository: 'acme/web', issue: 12, reason: 'no code was given within 15 minutes' }) }));
    await waitFor(() => expect(screen.getByTestId('sign-in-failed')).toHaveTextContent('no code was given within 15 minutes'));
    expect(screen.queryByTestId('sign-in-link')).toBeNull();
  });
});
