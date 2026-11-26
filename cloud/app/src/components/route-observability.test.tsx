import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Lifecycle } from './lifecycle';
import { routingLabel } from './workflows';

/**
 * With models chosen automatically (#193), what a job actually ran with is read from the job:
 * the model and effort of every step, and the route the scheduler took and why.
 */
describe('the route a job actually ran on', () => {
  it('shows the model and effort of each step: the coding agent, and an independent reviewer', () => {
    render(
      <Lifecycle
        running={false}
        detail={{
          steps: [
            { kind: 'implement', agent: 'codex', model: 'gpt-5.5-codex', effort: 'medium', publication: 'published' },
            { kind: 'review', agent: 'claude', model: 'claude-opus-5-5', effort: 'high' },
            { kind: 'revision', agent: 'codex', model: 'gpt-5.5-codex' },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('step-0')).toHaveTextContent('codex');
    expect(screen.getByTestId('step-0')).toHaveTextContent('gpt-5.5-codex (medium)');
    expect(screen.getByTestId('step-1')).toHaveTextContent('claude');
    expect(screen.getByTestId('step-1')).toHaveTextContent('claude-opus-5-5 (high)');
    // A revision keeps the coding agent of the pull request (its affinity).
    expect(screen.getByTestId('step-2')).toHaveTextContent('codex');
  });

  it('says which tier and pool routing chose, what it first chose, and why', () => {
    expect(routingLabel({ source: 'tiers', tier: 'complex', requestedTier: 'standard', pool: 'builders', reason: 'escalated-after-failure' })).toBe('Tier complex (first chosen: standard) · pool builders · routing reason: escalated after failure');
    expect(routingLabel({ source: 'workflow', pool: 'art-coding' })).toBe('pool art-coding');
    expect(routingLabel({ source: 'workflow' })).toBe('Routed by workflow');
  });
});
