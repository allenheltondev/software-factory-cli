import { describe, expect, it } from 'vitest';
import { short, snapshot, type TraceInput } from './claude-session-trace.js';

const now = Date.parse('2026-11-25T15:00:00Z');
const base = (patch: Partial<TraceInput> = {}): TraceInput => ({
  installationId: 55, now, latestImageVersion: '10',
  session: { generation: '6f1c2d3e-aaaa-bbbb-cccc-1234567890ab', imageVersion: '10', microvmId: 'mvm-a', requestedAt: now - 3_600_000, readyAt: now - 3_500_000 },
  lease: { installationId: 55, generation: '6f1c2d3e-aaaa-bbbb-cccc-1234567890ab', requestedAt: now - 3_600_000, idleAt: now + 60_000, idleMs: 8 * 3_600_000, mayHaveLaunched: true, microvmId: 'mvm-a' },
  worker: { version: 4, installationId: 55, workerId: 'managed-55', session: 'b0b0b0b0-1111-2222-3333-444455556666', microvmId: 'mvm-a', imageVersion: '10',
    workerVersion: 'tenant-browser-1', auth: 'connected', heartbeatAt: now - 5_000, lastWorkAt: now - 120_000 },
  queued: [], waiting: [], vm: { state: 'RUNNING', imageVersion: '10', idlePolicy: { maxIdleDurationSeconds: 28800, suspendedDurationSeconds: 0, autoResumeEnabled: false } },
  jobs: [{ jobId: 'job_a', status: 'finished', outcome: 'succeeded', microvmId: 'mvm-a', generation: '6f1c2d3e-aaaa-bbbb-cccc-1234567890ab', createdAt: '2026-11-25T14:50:00Z' }],
  ...patch,
});

describe('claude-session-trace snapshot', () => {
  it('reports reuse for a healthy session with shortened identifiers and the effective deadlines', () => {
    const s = snapshot(base());
    expect(s.dispatch).toEqual({ readiness: 'ready', ownerAction: 'none' });
    expect(s.session).toMatchObject({ generation: '6f1c2d3e…', lifetimeEndsAt: '2026-11-25T22:00:00.000Z', idleEndsAt: '2026-11-25T22:58:00.000Z', idleMinutes: 480 });
    expect(s.worker).toMatchObject({ session: 'b0b0b0b0…', heartbeatAgeSeconds: 5, auth: 'connected' });
    expect(s.jobs[0]).toMatchObject({ generation: '6f1c2d3e…' });
    expect(JSON.stringify(s)).not.toMatch(/1234567890ab|444455556666/);
  });
  it('names a suspended environment behind a stale heartbeat as needing a reconnect', () => {
    const s = snapshot(base({ worker: { ...base().worker!, heartbeatAt: now - 10 * 60_000 }, vm: { state: 'SUSPENDED' } }));
    expect(s.dispatch).toEqual({ readiness: 'environment-suspended', ownerAction: 'reconnect' });
    expect(s.vm).toMatchObject({ idlePolicy: 'none reported' });
  });
  it('reports a retiring or missing session as needing a connection', () => {
    expect(snapshot(base({ session: { ...base().session!, retiring: true, retirementReason: 'idle' } })).dispatch).toEqual({ readiness: 'no-session', ownerAction: 'connect' });
    expect(snapshot(base({ session: undefined, lease: undefined, vm: undefined })).session).toBeUndefined();
    expect(short('abc')).toBe('abc');
  });
});
