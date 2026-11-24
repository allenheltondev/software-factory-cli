import { describe, expect, it } from 'vitest';
import { createClaudeAdmission, SESSION_SECONDS, IDLE_MS, managedPolicy } from './admission.js';
import { admissionFixture } from './admission-fixture.js';
const now = Date.UTC(2026, 10, 24);
describe('platform-wide managed session admission', () => {
  it('bounds concurrent connects across installations with atomic admission', async () => {
    const fixture = admissionFixture();
    const admission = createClaudeAdmission('test', fixture.db);
    const limits = { concurrent: 2, dailySeconds: 10 * SESSION_SECONDS, tenantDailySeconds: 3 * SESSION_SECONDS };
    const outcomes = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((id) =>
        createClaudeAdmission('test', fixture.db).reserve(id, `generation-${id}`, now, limits),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(await admission.list()).toHaveLength(2);
    expect(fixture.read()?.seconds).toBe(0);
    expect(fixture.read()?.launches).toBe(2);
  });
  it('reserves maximum exposure but settles short sessions once at confirmed termination', async () => {
    const fixture = admissionFixture();
    const admission = createClaudeAdmission('test', fixture.db);
    const limits = { concurrent: 2, dailySeconds: 2 * SESSION_SECONDS, tenantDailySeconds: 2 * SESSION_SECONDS };
    await Promise.all([admission.reserve(1, 'same', now, limits), admission.reserve(1, 'same', now, limits)]);
    expect(fixture.read()?.seconds).toBe(0);
    expect(fixture.read()?.launches).toBe(1);
    await admission.launching('same', now);
    await admission.release('same', now + 20 * 60000);
    expect(fixture.read()?.seconds).toBe(1200);
    await admission.release('same', now + 21 * 60000);
    expect(fixture.read()?.seconds).toBe(1200);
    await admission.reserve(1, 'next', now + 20 * 60000, limits);
    await admission.launching('next', now + 20 * 60000);
    await admission.release('next', now + 20 * 60000 + SESSION_SECONDS * 1000);
    await expect(admission.reserve(1, 'third', now + 9 * 3600000, limits)).rejects.toThrow('runtime budget');
    await expect(admission.reserve(1, 'tomorrow', now + 86400000, limits)).resolves.toMatchObject({
      generation: 'tomorrow',
    });
  });
  it('allows realistic short intermittent sessions without the old three-session lockout', async () => {
    const fixture = admissionFixture();
    const admission = createClaudeAdmission('test', fixture.db);
    for (let attempt = 0; attempt < 6; attempt++) {
      const start = now + attempt * 3600000;
      await admission.reserve(1, `session-${attempt}`, start);
      await admission.launching(`session-${attempt}`, start);
      await admission.release(`session-${attempt}`, start + 20 * 60000);
    }
    expect(fixture.read()?.seconds).toBe(2 * 3600);
    expect(fixture.read()?.launches).toBe(6);
    expect(await admission.list()).toHaveLength(0);
  });
  it('bounds launches separately even when unused runtime is returned', async () => {
    const admission = createClaudeAdmission('test', admissionFixture().db);
    const limits = {
      concurrent: 4,
      dailySeconds: 24 * SESSION_SECONDS,
      tenantDailySeconds: 3 * SESSION_SECONDS,
      tenantLaunchesPerDay: 4,
      platformLaunchesPerDay: 5,
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      await admission.reserve(1, `attempt-${attempt}`, now, limits);
      await admission.release(`attempt-${attempt}`, now);
    }
    await expect(admission.reserve(1, 'fifth', now, limits)).rejects.toThrow('launch limit');
    await admission.reserve(2, 'other', now, limits);
    await expect(admission.reserve(3, 'platform-limit', now, limits)).rejects.toThrow('launch limit');
  });
  it('carries maximum-exposure holds across midnight and settles only the current day runtime', async () => {
    const fixture = admissionFixture();
    const admission = createClaudeAdmission('test', fixture.db);
    const limits = { concurrent: 3, dailySeconds: SESSION_SECONDS, tenantDailySeconds: SESSION_SECONDS * 3 };
    const start = now + 23 * 3600000 + 50 * 60000;
    await admission.reserve(1, 'overnight', start, limits);
    await admission.launching('overnight', start);
    const end = now + 86400000 + 10 * 60000;
    await expect(admission.reserve(2, 'new-day', end, limits)).rejects.toThrow('runtime budget');
    await admission.release('overnight', end);
    expect(fixture.read()?.seconds).toBe(600);
    expect(fixture.read()?.day).toBe('2026-11-25');
  });
  it('defaults to an eight-hour idle connection and validates configurable policy', () => {
    expect(IDLE_MS).toBe(8 * 3600000);
    expect(managedPolicy({})).toMatchObject({ idleMs: IDLE_MS, tenantLaunchesPerDay: 12 });
    expect(
      managedPolicy({ NATIVE_MANAGED_IDLE_MINUTES: '120', NATIVE_MANAGED_TENANT_LAUNCHES_PER_DAY: '20' }),
    ).toMatchObject({ idleMs: 2 * 3600000, tenantLaunchesPerDay: 20 });
    expect(() => managedPolicy({ NATIVE_MANAGED_IDLE_MINUTES: '0' })).toThrow('NATIVE_MANAGED_IDLE_MINUTES');
  });
  it('never frees uncertain capacity on a deadline or TTL and fences retired launch attempts', async () => {
    const fixture = admissionFixture();
    const admission = createClaudeAdmission('test', fixture.db);
    await admission.reserve(1, 'old', now, {
      concurrent: 1,
      dailySeconds: SESSION_SECONDS * 10,
      tenantDailySeconds: SESSION_SECONDS * 10,
    });
    await admission.launching('old');
    await admission.retiring('old');
    await expect(admission.launching('old')).rejects.toThrow('retired');
    await expect(
      admission.reserve(2, 'new', now + 86400000, {
        concurrent: 1,
        dailySeconds: SESSION_SECONDS * 10,
        tenantDailySeconds: SESSION_SECONDS * 10,
      }),
    ).rejects.toThrow('capacity is full');
    expect(fixture.read()).not.toHaveProperty('ttl');
    await admission.release('old', now + 86400000);
    await expect(admission.reserve(2, 'new', now + 86400000)).resolves.toMatchObject({ installationId: 2 });
  });
  it('migrates known legacy active holds without refunding unknown closed sessions', async () => {
    const fixture = admissionFixture({
      pk: 'CLAUDE_CAPACITY',
      sk: 'REGISTRY',
      revision: 1,
      day: '2026-11-24',
      seconds: 2 * SESSION_SECONDS,
      tenants: { '1': 2 * SESSION_SECONDS },
      leases: {
        legacy: {
          installationId: 1,
          generation: 'legacy',
          requestedAt: now,
          idleAt: now + 15 * 60000,
          microvmId: 'mvm-legacy',
          mayHaveLaunched: false,
        },
      },
    });
    const admission = createClaudeAdmission('test', fixture.db);
    expect(await admission.get('legacy')).toMatchObject({
      idleMs: IDLE_MS,
      idleAt: now + IDLE_MS,
      mayHaveLaunched: true,
    });
    await admission.reserve(1, 'legacy', now);
    expect(fixture.read()?.seconds).toBe(SESSION_SECONDS);
    await admission.release('legacy', now + 20 * 60000);
    expect(fixture.read()?.seconds).toBe(SESSION_SECONDS + 1200);
  });
});
