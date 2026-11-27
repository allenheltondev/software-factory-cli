import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowEvent, WorkflowView } from '../api/client';
import { workflowLifecycle } from '../lib/workflowLifecycle';
import { WorkflowLifecycle } from './WorkflowLifecycle';

afterEach(cleanup);
const workflow: WorkflowView = { workflowId: '99-i206', repository: 'acme/web', repositoryId: 99, issue: 206, generation: 1, status: 'finished', stage: 'merged', createdAt: '2026-11-27T12:00:00Z', updatedAt: '2026-11-27T12:05:00Z' };
const start: WorkflowEvent = { id: 'j:start', jobId: 'j', kind: 'job_started', generation: 1, at: workflow.createdAt, stage: 'implementing', eventName: 'issues' };
const finish: WorkflowEvent = { id: 'j:finish', jobId: 'j', kind: 'job_finished', generation: 1, at: workflow.updatedAt, stage: 'merged', outcome: 'succeeded', prUrl: 'https://github.com/acme/web/pull/9', steps: [
  { kind: 'implement', outcome: 'succeeded', verificationPassed: true, publication: 'published' },
  { kind: 'review', outcome: 'succeeded' },
  { kind: 'revision', agent: 'coder', adapter: 'codex', model: 'recorded-model', modelSource: 'response', verificationPassed: true, publication: 'published', outcome: 'succeeded', usage: { durationMs: 60000 } },
  { kind: 'review', outcome: 'succeeded' },
], routing: { source: 'tier', tier: 'complex' }, loop: { reviews: 2, rounds: 1 } };

describe('workflow lifecycle read model', () => {
  it('deduplicates and orders shuffled events and recovered finishes without counting attempts twice', () => {
    const model = workflowLifecycle(workflow, [finish, start, start, { ...finish, id: 'recovered', kind: 'finish_recovered' }], 1);
    expect(model.events.map((e) => e.id)).toEqual(['j:start', 'j:finish', 'recovered']);
    expect(model.reviews).toBe(2);
    expect(model.revisions).toBe(1);
    expect(model.elapsedSeconds).toBe(300);
    expect(model.edges).toEqual(expect.arrayContaining([{ from: 4, to: 3, count: 1 }, { from: 4, to: 2, count: 1 }, { from: 3, to: 5, count: 1 }]));
    expect(model.edges.some((e) => e.from === 5)).toBe(false);
  });
  it('isolates generations and does not invent transitions between independent jobs from time order', () => {
    const model = workflowLifecycle({ ...workflow, generation: 2 }, [start, finish, { ...finish, id: 'new', jobId: 'new', generation: 2, steps: [{ kind: 'review', outcome: 'succeeded' }], loop: { rounds: 0, reviews: 1 } }], 2);
    expect(model.reviews).toBe(1);
    expect(model.revisions).toBe(0);
    expect(model.stages[1]!.status).toBe('Not observed');
    expect(model.edges.some((e) => e.from === 4)).toBe(false);
  });
  it('uses sequence numbers to order simultaneous events and leaves incomplete history unknown', () => {
    const model = workflowLifecycle(workflow, [{ ...start, id: 'b', seq: 2 }, { ...start, id: 'z', seq: 1 }], 1);
    expect(model.events.map((e) => e.id)).toEqual(['z', 'b']);
    expect(model.stages[2]!.status).toBe('Not observed');
    expect(workflowLifecycle(workflow, [], 1).elapsedSeconds).toBeUndefined();
  });
  it('preserves version order across clock skew and represents queue waits and human controls', () => {
    const queued: WorkflowEvent = { id: 'queue', generation: 1, kind: 'waiting', stage: 'queued', seq: 1, at: '2026-11-27T12:01:00Z' };
    const admitted: WorkflowEvent = { ...queued, id: 'admit', kind: 'admitted', seq: 2, at: '2026-11-27T12:00:00Z', waited: { for: 'capacity', seconds: 60, since: workflow.createdAt } };
    const paused: WorkflowEvent = { ...queued, id: 'pause', kind: 'control', seq: 3, control: { action: 'paused', by: 'owner' } };
    const model = workflowLifecycle(workflow, [paused, admitted, queued], 1);
    expect(model.events.map((e) => e.id)).toEqual(['queue', 'admit', 'pause']);
    expect(model.stages[0]!.status).toBe('Paused');
    expect(model.stages[0]!.attempts[1]).toMatchObject({ status: 'Completed', waitSeconds: 60, waitFor: 'capacity' });
    expect(workflowLifecycle({ ...workflow, status: 'waiting', stage: 'queued' }, [queued], 1).stages[0]!.status).toBe('Waiting');
  });
  it('distinguishes verification failure, CI repair retry, cancellation, pause and manual merge', () => {
    const repair: WorkflowEvent = { ...finish, stage: 'waiting-for-ci', eventName: 'check_suite', outcome: 'failed', steps: [{ kind: 'revision', verificationPassed: false, outcome: 'failed' }] };
    const failed = workflowLifecycle({ ...workflow, status: 'blocked', stage: 'waiting-for-ci' }, [{ ...start, retry: true }, repair], 1);
    expect(failed.stages[2]!.status).toBe('Failed');
    expect(failed.stages[4]!.attempts[0]!.label).toContain('CI repair');
    expect(failed.stages[0]!.attempts[0]!.label).toContain('Retry');
    const canceled = workflowLifecycle({ ...workflow, status: 'blocked', stage: 'failed', reason: 'job_canceled' }, [start], 1);
    expect(canceled.stages[1]!.status).toBe('Canceled');
    const paused = workflowLifecycle({ ...workflow, status: 'waiting', stage: 'reviewing-loop' }, [start], 1, { jobId: 'j', at: 1, by: 'owner', subject: 206, canResume: true });
    expect(paused.stages[3]!.status).toBe('Paused');
    expect(workflowLifecycle({ ...workflow, status: 'waiting', stage: 'ready-to-merge' }, [{ ...finish, stage: 'ready-to-merge' }], 1).outcome).toBe('Awaiting manual merge');
  });
});

describe('workflow lifecycle illustration', () => {
  it('renders the fixed ring, accessible equivalent, causal loops and selectable model details', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowLifecycle workflow={workflow} events={[start, finish]} base="/installations/55" /></MemoryRouter>);
    expect(screen.getByTestId('lifecycle-outcome')).toHaveTextContent('finished: merged');
    expect(within(screen.getByRole('list', { name: 'Lifecycle stages' })).getAllByRole('button')).toHaveLength(6);
    expect(screen.getByLabelText('Recorded transitions')).toHaveTextContent('Revision / remediation → Review: 1');
    await user.click(screen.getByRole('button', { name: /5\. Revision/ }));
    expect(screen.getByText(/Model: recorded-model/)).toHaveTextContent('Tier: complex');
    expect(screen.getByRole('link', { name: 'Job details' })).toHaveAttribute('href', '/installations/55/jobs/j');
    expect(screen.getByText(/Reported at .*1 min/)).toBeInTheDocument();
  });
  it('keeps positions for a direct path and switches runs without mixing attempts', async () => {
    const user = userEvent.setup();
    const direct = { ...finish, id: 'new:finish', jobId: 'new', generation: 2, steps: [{ kind: 'review', outcome: 'succeeded' }], loop: { rounds: 0, reviews: 1 } };
    render(<MemoryRouter><WorkflowLifecycle workflow={{ ...workflow, generation: 2 }} events={[start, finish, direct]} base="/installations/55" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /5\. Revision/ })).toHaveTextContent('Skipped');
    expect(screen.getByLabelText('Recorded transitions')).toHaveTextContent('Review → Delivery: 1');
    await user.selectOptions(screen.getByLabelText('Execution run'), '1');
    expect(screen.getByRole('button', { name: /5\. Revision/ })).toHaveTextContent('Completed');
    expect(screen.getByTestId('lifecycle-outcome')).toHaveTextContent('merged');
  });
  it('renders a running retry with failed verification and unknown metadata explicitly', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowLifecycle workflow={{ ...workflow, status: 'active', stage: 'fixing-ci' }} events={[{ ...start, retry: true }, { ...finish, stage: 'waiting-for-ci', steps: [{ kind: 'revision', outcome: 'failed', verificationPassed: false }] }]} base="/installations/55" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /5\. Revision/ })).toHaveTextContent('Running');
    await user.click(screen.getByRole('button', { name: /3\. Verification/ }));
    expect(screen.getByText(/Verification: failed/)).toHaveTextContent('Failed');
    expect(screen.getByText(/Agent: unknown/)).toHaveTextContent('Model: unknown');
  });
});
