import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Insights, JobView, StatsReport } from '../api/client';
import { Lifecycle, LoopBadges } from '../components/lifecycle';
import { fillDays, modelName, repoRows } from '../lib/insights';
import { fakeApi } from '../test/fakeApi';
import reportJson from '../test/insights-report.json';
import { InsightsPage } from './InsightsPage';

// A real `updraft stats --json` report: the CLI's fixture history (test/factory-history.ts).
const report = reportJson as unknown as StatsReport;
const insights = (over: Partial<Insights> = {}): Insights => ({ window: '30d', hasState: true, stateUpdatedAt: new Date().toISOString(), report, ...over });

function Where() {
  const l = useLocation();
  return <span data-testid="where">{l.search}</span>;
}

function show(api: ReturnType<typeof fakeApi>, path = '/installations/55/insights') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/installations/:id/insights"
          element={
            <>
              <InsightsPage api={api} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const api = (over: Partial<ReturnType<typeof fakeApi>> = {}) =>
  fakeApi({
    insights: vi.fn().mockResolvedValue(insights()),
    overview: vi.fn().mockRejectedValue(new Error('no overview')),
    ...over,
  });

describe('InsightsPage', () => {
  it('shows the headline numbers: issues worked, pull requests, what review caught, rounds', async () => {
    show(api());
    const tiles = await screen.findByTestId('insights-headline');
    expect(within(tiles).getByText('Issues worked').parentElement?.parentElement).toHaveTextContent('4');
    expect(tiles).toHaveTextContent('Issues caught in review');
    expect(tiles).toHaveTextContent('in 2 change requests · 3 per request');
    expect(tiles).toHaveTextContent('first-pass ready 67%');
  });

  it('breaks it down by repository and by model, for coding and for reviewing', async () => {
    show(api());
    const repos = await screen.findByTestId('insights-repos');
    expect(within(repos).getByTestId('repo-octo/widgets')).toBeInTheDocument();
    expect(within(repos).getByTestId('repo-octo/art')).toBeInTheDocument();
    const coding = screen.getByTestId('insights-coding-models');
    expect(within(coding).getByTestId('coding-claude/cli-default')).toHaveTextContent('Claude default model');
    expect(within(coding).getByTestId('coding-kiro/cli-default')).toBeInTheDocument();
    const reviewing = screen.getByTestId('insights-review-models');
    expect(within(reviewing).getByTestId('review-codex/cli-default')).toHaveTextContent('3 caught');
    expect(within(reviewing).getByTestId('review-codex/cli-default')).toHaveTextContent('4 reviews · sent back 50%');
  });

  it('changes the window and the repository through the address, and asks the API for them', async () => {
    const a = api({ overview: vi.fn().mockResolvedValue({ tenant: { accountLogin: 'acme' }, repositories: [{ fullName: 'octo/widgets', configured: true }] }) });
    show(a);
    await screen.findByTestId('insights-headline');
    expect(screen.getByTestId('insights')).toHaveTextContent('Insights · acme');
    await userEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(a.insights).toHaveBeenLastCalledWith(55, { window: '7d' }));
    expect(screen.getByTestId('where')).toHaveTextContent('?window=7d');
    await userEvent.click(within(screen.getByTestId('insights-repos')).getByRole('button', { name: 'octo/art' }));
    await waitFor(() => expect(a.insights).toHaveBeenLastCalledWith(55, { window: '7d', repo: 'octo/art' }));
  });

  it('says what to do when nothing has run yet', async () => {
    show(api({ insights: vi.fn().mockResolvedValue(insights({ hasState: false, report: { ...report, facts: { total: 0, backfilled: 0 }, byRepo: [] } })) }));
    expect(await screen.findByText('No jobs have run yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configure repositories' })).toHaveAttribute('href', '/installations/55/config');
  });

  it('shows the error of a first load', async () => {
    show(api({ insights: vi.fn().mockRejectedValue(new Error('boom')) }));
    expect(await screen.findByTestId('insights-error')).toHaveTextContent('boom');
  });
});

describe('insights helpers', () => {
  it('fills every day of the window, with zeros', () => {
    const days = fillDays([{ day: '2026-11-17', jobsSucceeded: 2, jobsFailed: 0, prsOpened: 0, prsMerged: 0, reviews: 0, changesRequested: 0, findings: 1, revisions: 0 }], {
      since: '2026-11-11T12:00:00.000Z',
      until: '2026-11-18T12:00:00.000Z',
    });
    expect(days.map((d) => d.day)).toEqual(['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18']);
    expect(days[6]).toMatchObject({ jobsSucceeded: 2, findings: 1 });
    expect(fillDays(undefined, { since: null, until: '2026-11-18T00:00:00.000Z' })).toHaveLength(1);
  });

  it('names models for people', () => {
    expect(modelName('claude/opus effort high')).toEqual({ name: 'opus', via: 'Claude · effort high' });
    expect(modelName('codex/cli-default')).toEqual({ name: 'Codex default model', via: 'Codex' });
    expect(modelName('unknown').name).toBe('Not recorded');
  });

  it('lists configured repositories that have done nothing yet, busiest first', () => {
    const rows = repoRows(report, ['octo/widgets', 'octo/quiet']);
    expect(rows[0]!.repo).toBe('octo/widgets');
    expect(rows.at(-1)).toMatchObject({ repo: 'octo/quiet', issues: 0, successRate: null });
  });
});

describe('the job lifecycle', () => {
  const detail: JobView['detail'] = {
    loop: { rounds: 1, maxRevisions: 3, reviews: 2, verdict: 'ready-to-merge', stage: 'merged', merged: true },
    steps: [
      { kind: 'implement', agent: 'claude', outcome: 'succeeded', verificationPassed: true, publication: 'published' },
      { kind: 'review', agent: 'codex', outcome: 'succeeded', publication: 'published' },
      { kind: 'revision', agent: 'claude', outcome: 'succeeded', verificationPassed: true, publication: 'published' },
      { kind: 'review', agent: 'codex', outcome: 'succeeded', publication: 'published' },
    ],
  };

  it('shows each step in order and where the pull request ended up', () => {
    render(<Lifecycle detail={detail} running={false} />);
    expect(screen.getByTestId('step-0')).toHaveTextContent('Wrote the changePull request opened');
    expect(screen.getByTestId('step-1')).toHaveTextContent('Asked for changes');
    expect(screen.getByTestId('step-2')).toHaveTextContent('claude addressed the review');
    expect(screen.getByTestId('step-3')).toHaveTextContent('Reviewed (2)Ready to merge');
    expect(screen.getByTestId('step-loop')).toHaveTextContent('Merged');
    expect(screen.getByTestId('step-loop')).toHaveTextContent('1 round of 3 · 2 reviews');
  });

  it('marks a failed verification, and says when there is nothing to show', () => {
    const { unmount } = render(<Lifecycle detail={{ steps: [{ kind: 'implement', agent: 'claude', outcome: 'failed', verificationPassed: false }] }} running={false} />);
    expect(screen.getByTestId('step-0')).toHaveTextContent('Verification failed');
    unmount();
    render(<Lifecycle running />);
    expect(screen.getByText('The steps show up here when the job ends.')).toBeInTheDocument();
  });

  it('badges the jobs list with the stage and the rounds', () => {
    render(<LoopBadges job={{ detail }} />);
    expect(screen.getByTestId('loop-badges')).toHaveTextContent('Merged1 round of 3· 2 reviews');
  });
});
