import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type JobView, type TelemetryView } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { JobPage } from './JobPage';
import { TelemetryPage } from './TelemetryPage';

const NOW = new Date().toISOString();
const off: TelemetryView = { provider: 'honeycomb', enabled: false, region: 'us', serviceName: 'updraft', captureContent: false, keyConfigured: false };
const on: TelemetryView = {
  ...off,
  enabled: true,
  region: 'eu',
  keyConfigured: true,
  key: { updatedAt: NOW, updatedBy: 'pat', type: 'ingest', team: { name: 'Acme', slug: 'acme' }, environment: { name: 'Production', slug: 'production' } },
  environmentUrl: 'https://ui-eu1.honeycomb.io/acme/environments/production',
};

function show(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={['/installations/55/telemetry']}>
      <Routes>
        <Route path="/installations/:id/telemetry" element={<TelemetryPage api={api} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TelemetryPage', () => {
  it('asks for a key first, checks it in the chosen region, and shows where it goes', async () => {
    const setTelemetryKey = vi.fn().mockResolvedValue(on);
    show(fakeApi({ telemetry: vi.fn().mockResolvedValue(off), setTelemetryKey }));
    expect(await screen.findByTestId('telemetry-state')).toHaveTextContent('Not set up');
    expect(screen.queryByTestId('telemetry-settings')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^EU/ }));
    await userEvent.type(screen.getByLabelText('Ingest key'), 'hcaik_01j1824es7n4evcmv81cn392jbsecret');
    await userEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    expect(setTelemetryKey).toHaveBeenCalledWith(55, 'hcaik_01j1824es7n4evcmv81cn392jbsecret', 'eu');
    expect(await screen.findByTestId('telemetry-key-saved')).toHaveTextContent('Honeycomb accepted the key');
    expect(screen.getByTestId('telemetry-state')).toHaveTextContent('Sending');
    expect(screen.getByTestId('telemetry-key-facts')).toHaveTextContent('Acme');
    expect(screen.getByTestId('telemetry-key-facts')).toHaveTextContent('Production');
    expect(screen.getByTestId('telemetry-open')).toHaveAttribute('href', 'https://ui-eu1.honeycomb.io/acme/environments/production');
    expect(screen.getByTestId('telemetry-settings')).toBeInTheDocument();
  });

  it("says why Honeycomb refused a key, and stops a value that cannot be one before sending it", async () => {
    const setTelemetryKey = vi.fn().mockRejectedValue(new ApiError(400, 'invalid_key', 'Honeycomb (US) rejected that key; nothing was changed. Is it for the other region?'));
    show(fakeApi({ telemetry: vi.fn().mockResolvedValue(off), setTelemetryKey }));
    const input = await screen.findByLabelText('Ingest key');
    await userEvent.type(input, 'not a key');
    expect(screen.getByRole('button', { name: 'Check and save' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'hcaik_01j1824es7n4evcmv81cn392jbsecret');
    await userEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    expect(await screen.findByTestId('telemetry-key-error')).toHaveTextContent('Is it for the other region?');
  });

  it('pauses sending, records content, renames the dataset, and shows how the last job went', async () => {
    const updateTelemetry = vi.fn().mockImplementation(async (_id: number, input: Partial<TelemetryView>) => ({ ...on, ...input }));
    const view: TelemetryView = { ...on, lastExport: { at: NOW, jobId: 'job_abcdefgh01', traceId: 'ab'.repeat(16), traceUrl: 'https://ui-eu1.honeycomb.io/acme/environments/production/trace?trace_id=x', spans: 40, exported: 38, failed: 2, lastError: 'HTTP 503' } };
    show(fakeApi({ telemetry: vi.fn().mockResolvedValue(view), updateTelemetry }));
    expect(await screen.findByTestId('telemetry-last')).toHaveTextContent('Partly delivered');
    expect(screen.getByTestId('telemetry-last')).toHaveTextContent('38 of 40 spans reached Honeycomb (last error: HTTP 503)');
    expect(screen.getByTestId('telemetry-last-trace')).toHaveAttribute('href', expect.stringContaining('trace?trace_id='));
    await userEvent.click(screen.getByRole('button', { name: 'Paused' }));
    expect(updateTelemetry).toHaveBeenLastCalledWith(55, { enabled: false });
    await waitFor(() => expect(screen.getByTestId('telemetry-state')).toHaveTextContent('Paused'));
    await userEvent.click(screen.getByRole('button', { name: 'Prompts and outputs' }));
    expect(updateTelemetry).toHaveBeenLastCalledWith(55, { captureContent: true });
    const name = screen.getByLabelText('Service name');
    await userEvent.clear(name);
    await userEvent.type(name, 'factory');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateTelemetry).toHaveBeenLastCalledWith(55, { serviceName: 'factory' });
  });

  it('removes the key', async () => {
    const removeTelemetryKey = vi.fn().mockResolvedValue(off);
    show(fakeApi({ telemetry: vi.fn().mockResolvedValue(on), removeTelemetryKey }));
    await userEvent.click(await screen.findByTestId('telemetry-remove'));
    expect(removeTelemetryKey).toHaveBeenCalledWith(55);
    expect(await screen.findByTestId('telemetry-state')).toHaveTextContent('Not set up');
    expect(screen.getByLabelText('Ingest key')).toBeInTheDocument();
  });
});

describe('the job page links to its trace', () => {
  const job = (over: Partial<JobView> = {}): JobView => ({ jobId: 'job_abcdefgh01', repository: 'acme/web', issue: 12, createdAt: NOW, status: 'finished', outcome: 'succeeded', result: 'success', logs: [], ...over });
  const showJob = (j: JobView) =>
    render(
      <MemoryRouter initialEntries={['/installations/55/jobs/job_abcdefgh01']}>
        <Routes>
          <Route path="/installations/:id/jobs/:jobId" element={<JobPage api={fakeApi({ job: vi.fn().mockResolvedValue({ job: j, deliveries: [] }), jobLog: vi.fn() })} />} />
        </Routes>
      </MemoryRouter>,
    );

  it('shows the trace link and the conversation when telemetry was on', async () => {
    showJob(job({ telemetry: { traceId: 'ab'.repeat(16), traceUrl: 'https://ui.honeycomb.io/acme/environments/prod/trace?trace_id=abab', conversationId: 'acme/web#12', spans: 31, exported: 31, failed: 0 } }));
    expect(await screen.findByTestId('job-trace-link')).toHaveAttribute('href', 'https://ui.honeycomb.io/acme/environments/prod/trace?trace_id=abab');
    expect(screen.getByTestId('job-conversation')).toHaveTextContent('acme/web#12');
    expect(screen.getByTestId('job-telemetry-count')).toHaveTextContent('31 of 31 spans sent');
  });

  it('links to the conversation and to the spans worth opening the trace at', async () => {
    const trace = 'https://ui.honeycomb.io/acme/environments/prod/trace?trace_id=abab';
    showJob(
      job({
        telemetry: {
          traceId: 'ab'.repeat(16),
          traceUrl: trace,
          conversationId: 'acme/web#12',
          conversationUrl: 'https://ui.honeycomb.io/acme/environments/prod/datasets/updraft/?query=q',
          timeline: [
            { kind: 'agent', run: 'implement', agent: 'claude-opus', url: `${trace}&span=1`, failed: true, thrashing: true },
            { kind: 'test_failed', run: 'implement', url: `${trace}&span=2` },
            { kind: 'agent', run: 'review', agent: 'codex', verdict: 'changes-requested', url: `${trace}&span=3` },
            { kind: 'step_failed', step: 'runner_restore_state', url: `${trace}&span=4` },
          ],
          spans: 31,
          exported: 31,
          failed: 0,
        },
      }),
    );
    expect(await screen.findByTestId('job-conversation-link')).toHaveAttribute('href', 'https://ui.honeycomb.io/acme/environments/prod/datasets/updraft/?query=q');
    expect(screen.queryByTestId('job-timeline-link')).not.toBeInTheDocument();
    const links = screen.getByTestId('job-timeline');
    expect(links).toHaveTextContent('Implementation · claude-opus');
    expect(links).toHaveTextContent('did not succeed');
    expect(links).toHaveTextContent('went in circles');
    expect(links).toHaveTextContent('First failing test run (implementation)');
    expect(links).toHaveTextContent('Review · codex');
    expect(links).toHaveTextContent('changes requested');
    expect(links).toHaveTextContent('Failed step: runner restore state');
    expect(screen.getByRole('link', { name: 'First failing test run (implementation) ↗' })).toHaveAttribute('href', `${trace}&span=2`);
  });

  it('prefers the Agent Timeline link when the deployment has one, and lists the conversation', async () => {
    const other = job({ jobId: 'job_abcdefgh02', createdAt: new Date(Date.now() + 60_000).toISOString(), detail: { steps: [{ kind: 'review' }] }, telemetry: { traceId: 'cd'.repeat(16), traceUrl: 'https://ui.honeycomb.io/t2', spans: 1, exported: 1, failed: 0 } });
    render(
      <MemoryRouter initialEntries={['/installations/55/jobs/job_abcdefgh01']}>
        <Routes>
          <Route
            path="/installations/:id/jobs/:jobId"
            element={
              <JobPage
                api={fakeApi({
                  job: vi.fn().mockResolvedValue({
                    job: job({ telemetry: { traceId: 'ab'.repeat(16), conversationId: 'acme/web#12', conversationUrl: 'https://q', timelineUrl: 'https://ui.honeycomb.io/acme/timeline', spans: 1, exported: 1, failed: 0 } }),
                    deliveries: [],
                    conversation: [other],
                  }),
                  jobLog: vi.fn(),
                })}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('job-timeline-link')).toHaveAttribute('href', 'https://ui.honeycomb.io/acme/timeline');
    expect(screen.queryByTestId('job-conversation-link')).not.toBeInTheDocument();
    const list = screen.getByTestId('job-conversation-jobs');
    expect(list.textContent).toMatch(/This job.*Review/);
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/installations/55/jobs/job_abcdefgh02');
  });

  it('points to the settings when it was not', async () => {
    showJob(job());
    expect(await screen.findByRole('link', { name: 'Set up agent telemetry' })).toHaveAttribute('href', '/installations/55/telemetry');
    expect(screen.queryByTestId('job-work')).not.toBeInTheDocument();
  });

  it('shows what the agents did with no destination at all: totals and moments, no links', async () => {
    showJob(
      job({
        telemetry: {
          traceId: 'ab'.repeat(16),
          local: true,
          totals: { runs: 2, inputTokens: 125_000, outputTokens: 4200, costUsd: 1.234, toolCalls: 41, toolErrors: 3, thrashing: true, durationMs: 600_000 },
          timeline: [
            { kind: 'agent', run: 'implement', agent: 'claude-opus', offsetMs: 5000, durationMs: 300_000, thrashing: true },
            { kind: 'test_failed', run: 'implement', offsetMs: 65_000, durationMs: 4000 },
          ],
          spans: 0,
          exported: 0,
          failed: 0,
        },
      }),
    );
    const totals = await screen.findByTestId('job-totals');
    expect(totals).toHaveTextContent('125k / 4,200');
    expect(totals).toHaveTextContent('$1.23');
    expect(totals).toHaveTextContent('41 (3 failed)');
    const timeline = screen.getByTestId('job-timeline');
    expect(timeline).toHaveTextContent('+5 s');
    expect(timeline).toHaveTextContent('Implementation · claude-opus');
    expect(timeline).toHaveTextContent('5 min');
    expect(timeline).toHaveTextContent('went in circles');
    expect(timeline).toHaveTextContent('+1 min 5 s');
    expect(screen.queryByRole('link', { name: /First failing test run/ })).not.toBeInTheDocument();
    // Nothing went anywhere: no trace link, no count of spans sent, an offer to set it up.
    expect(screen.queryByTestId('job-trace-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('job-telemetry-count')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up agent telemetry' })).toBeInTheDocument();
  });
});
