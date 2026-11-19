import { describe, expect, it } from 'vitest';
import { decideEscalation, parseEscalationRequest, type EscalationInput } from './escalation.js';

const tiers = { pools: { routine: 'fast', standard: 'std', complex: 'deep' }, highRisk: { pool: 'safe' } };
const policy = (o: object = {}) => ({ enabled: true, maxHops: 1, ceiling: 'complex', onVerificationFailure: true, allowAgentRequests: true, ...o }) as EscalationInput['policy'];
const input = (o: Partial<EscalationInput> = {}): EscalationInput => ({
  policy: policy(),
  tiers,
  currentTier: 'standard',
  hops: 0,
  source: 'agent-request',
  request: { reason: 'migration-risk', requestedTier: 'complex', evidence: 'touches the schema migration runner' },
  poolAvailable: () => true,
  ...o,
});

describe('parseEscalationRequest', () => {
  it('reads the last marker line and validates it', () => {
    const out = 'working\nupdraft-escalation: {"reason":"migration-risk","requestedTier":"complex","evidence":"schema migration runner is involved"}\n';
    expect(parseEscalationRequest(out)).toMatchObject({ ok: true, request: { requestedTier: 'complex' } });
  });
  it('rejects unknown fields (no pool or agent can be named), bad tiers and bad JSON', () => {
    const bad = (j: string) => parseEscalationRequest(`updraft-escalation: ${j}`);
    expect(bad('{"reason":"other","requestedTier":"complex","evidence":"long enough evidence","pool":"deep"}')).toMatchObject({ ok: false });
    expect(bad('{"reason":"other","requestedTier":"routine","evidence":"long enough evidence"}')).toMatchObject({ ok: false });
    expect(bad('{nope')).toMatchObject({ ok: false });
    expect(parseEscalationRequest('nothing here')).toBeNull();
  });
});

describe('decideEscalation', () => {
  it('escalates to the requested stronger tier', () => {
    expect(decideEscalation(input())).toMatchObject({ escalate: true, toTier: 'complex', pool: 'deep' });
  });
  it('clamps to the ceiling and never reaches high-risk without it', () => {
    const d = decideEscalation(input({ request: { reason: 'security-risk', requestedTier: 'high-risk', evidence: 'handles credentials here' } }));
    expect(d).toMatchObject({ escalate: true, toTier: 'complex' });
    expect(decideEscalation(input({ currentTier: 'complex', request: { reason: 'security-risk', requestedTier: 'high-risk', evidence: 'handles credentials here' } }))).toMatchObject({ escalate: false });
    expect(decideEscalation(input({ currentTier: 'complex', policy: policy({ ceiling: 'high-risk' }), request: { reason: 'security-risk', requestedTier: 'high-risk', evidence: 'handles credentials here' } }))).toMatchObject({ escalate: true, pool: 'safe' });
  });
  it('never lowers or repeats a tier', () => {
    expect(decideEscalation(input({ currentTier: 'complex' }))).toMatchObject({ escalate: false });
  });
  it('enforces the hop cap', () => {
    expect(decideEscalation(input({ hops: 1 }))).toMatchObject({ escalate: false });
  });
  it('is off without a policy, and honors the per-source switches', () => {
    expect(decideEscalation(input({ policy: undefined }))).toMatchObject({ escalate: false });
    expect(decideEscalation(input({ policy: policy({ allowAgentRequests: false }) }))).toMatchObject({ escalate: false });
    const v = decideEscalation(input({ source: 'verification-failure', request: undefined }));
    expect(v).toMatchObject({ escalate: true, toTier: 'complex' });
    expect(decideEscalation(input({ source: 'verification-failure', request: undefined, policy: policy({ onVerificationFailure: false }) }))).toMatchObject({ escalate: false });
  });
  it('refuses a pool nobody can run', () => {
    expect(decideEscalation(input({ poolAvailable: () => false }))).toMatchObject({ escalate: false });
  });
});
