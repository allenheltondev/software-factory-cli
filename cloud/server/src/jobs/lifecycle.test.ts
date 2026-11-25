import { describe, expect, it } from 'vitest';
import { routingOf } from './lifecycle.js';

describe('routingOf', () => {
  it('keeps the tier that ran, the tier the router chose and the reason code (#140)', () => {
    expect(routingOf({ source: 'tier', pool: 'deep', tier: 'complex', requestedTier: 'routine', reason: 'confident', risk: 'low', confidence: 0.75, hops: 1 })).toEqual({
      source: 'tier',
      pool: 'deep',
      tier: 'complex',
      requestedTier: 'routine',
      reason: 'confident',
      risk: 'low',
      confidence: 0.75,
      hops: 1,
    });
  });

  it('drops anything that is not one of the fixed codes', () => {
    expect(routingOf({ source: 'tier', tier: 'opus', requestedTier: 'claude-opus', reason: 'the issue said so' })).toEqual({ source: 'tier' });
    expect(routingOf({ source: 'pool', reason: 'default' })).toEqual({ source: 'pool', reason: 'default' });
    expect(routingOf({ source: 'other' })).toBeUndefined();
  });
});
