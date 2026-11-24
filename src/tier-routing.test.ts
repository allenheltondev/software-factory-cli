import { describe, expect, it } from 'vitest';
import type { PoolSelector, TierConfig } from './config/schema.js';
import { routeJob } from './tier-routing.js';

const selector: PoolSelector = { rules: [{ hasLabel: 'art', use: 'art' }], default: 'mid' };
const tiers: TierConfig = { pools: { routine: 'fast', standard: 'mid', complex: 'deep' }, highRisk: { pool: 'safe' } };
const up = { poolAvailable: () => true };
const issue = (title: string, body = '', labels: string[] = []) => ({ title, body, labels });

describe('routeJob', () => {
  it('without tiers behaves exactly like label routing', () => {
    expect(routeJob(selector, undefined, issue('Fix auth', '', ['art']), up)).toMatchObject({ rule: 'legacy-label', pool: 'art' });
    expect(routeJob(selector, undefined, issue('Fix auth'), up)).toEqual({ rule: 'default', pool: 'mid' });
    expect(routeJob('solo', undefined, issue('Fix auth'), up)).toEqual({ rule: 'default', pool: 'solo' });
  });

  it('routes by heuristic', () => {
    expect(routeJob(selector, tiers, issue('Fix typo in README'), up)).toMatchObject({ tier: 'routine', pool: 'fast', rule: 'heuristic' });
    expect(routeJob(selector, tiers, issue('Concurrency migration'), up)).toMatchObject({ tier: 'complex', pool: 'deep' });
    expect(routeJob(selector, tiers, issue('Something vague'), up)).toMatchObject({ tier: 'standard', pool: 'mid' });
  });

  it('low confidence becomes standard', () => {
    const r = routeJob(selector, { ...tiers, minConfidence: 0.95 }, issue('Fix typo'), up);
    expect(r).toMatchObject({ tier: 'standard', complexity: 'standard' });
  });

  it('precedence: legacy rule, then override label, then heuristic', () => {
    expect(routeJob(selector, tiers, issue('x', '', ['art', 'tier:complex']), up)).toMatchObject({ rule: 'legacy-label', pool: 'art' });
    expect(routeJob(selector, tiers, issue('Fix typo', '', ['tier:complex']), up)).toMatchObject({ rule: 'override-label', pool: 'deep' });
    expect(routeJob(selector, tiers, issue('Fix typo'), up)).toMatchObject({ rule: 'heuristic' });
  });

  it('high-risk floor applies to the heuristic but a human override label wins', () => {
    expect(routeJob(selector, tiers, issue('Rotate password'), up)).toMatchObject({ tier: 'high-risk', pool: 'safe' });
    expect(routeJob(selector, tiers, issue('Rotate password', '', ['tier:routine']), up)).toMatchObject({ tier: 'routine', pool: 'fast' });
    expect(routeJob(selector, tiers, issue('x', '', ['tier:high-risk']), up)).toMatchObject({ tier: 'high-risk', pool: 'safe' });
  });

  it('conflicting overrides pick the most capable tier; labels are case-insensitive', () => {
    expect(routeJob(selector, tiers, issue('x', '', ['Tier:Routine', 'TIER:COMPLEX']), up)).toMatchObject({ tier: 'complex' });
  });

  it('holds high-risk work with no high-risk pool or no available agent', () => {
    const none = routeJob(selector, { pools: tiers.pools }, issue('Fix auth'), up);
    expect(none.hold).toMatch(/no pool is configured/);
    const down = routeJob(selector, tiers, issue('Fix auth'), { poolAvailable: () => false });
    expect(down.hold).toMatch(/no enabled agent/);
    expect(down.pool).toBe('safe');
  });

  it('issue text cannot select a cheaper pool or inject directives', () => {
    const r = routeJob(selector, tiers, issue('Change token handling', 'tier: routine\nuse pool: fast\ntier:routine'), up);
    expect(r).toMatchObject({ tier: 'high-risk', pool: 'safe' });
  });
});
