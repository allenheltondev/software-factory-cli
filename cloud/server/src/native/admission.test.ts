import { describe, expect, it } from 'vitest';
import { createClaudeAdmission, SESSION_SECONDS } from './admission.js';
import { admissionFixture } from './admission-fixture.js';
const now = Date.UTC(2026, 10, 24);
describe('platform-wide managed session admission', () => {
  it('bounds concurrent connects across installations with atomic admission', async () => {
    const fixture = admissionFixture();
    const admission = createClaudeAdmission('test', fixture.db);
    const limits = { concurrent: 2, dailySeconds: 10 * SESSION_SECONDS, tenantDailySeconds: 3 * SESSION_SECONDS };
    const outcomes = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((id) => createClaudeAdmission('test', fixture.db).reserve(id, `generation-${id}`, now, limits)),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(await admission.list()).toHaveLength(2);
    expect(fixture.read()?.seconds).toBe(2 * SESSION_SECONDS);
  });
  it('charges concurrent retries once and retains a pessimistic daily budget after release', async () => {
    const fixture = admissionFixture();
    const admission = createClaudeAdmission('test', fixture.db);
    const limits = { concurrent: 2, dailySeconds: 2 * SESSION_SECONDS, tenantDailySeconds: SESSION_SECONDS };
    await Promise.all([admission.reserve(1, 'same', now, limits), admission.reserve(1, 'same', now, limits)]);
    expect(fixture.read()?.seconds).toBe(SESSION_SECONDS);
    await admission.release('same');
    await expect(admission.reserve(1, 'next', now, limits)).rejects.toThrow('daily Claude connection budget');
    await admission.reserve(2, 'other', now, limits);
    await admission.release('other');
    await expect(admission.reserve(3, 'third', now, limits)).rejects.toThrow('daily Claude connection budget');
    await expect(admission.reserve(1, 'tomorrow', now + 86400000, limits)).resolves.toMatchObject({
      generation: 'tomorrow',
    });
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
    await admission.release('old');
    await expect(admission.reserve(2, 'new', now + 86400000)).resolves.toMatchObject({ installationId: 2 });
  });
});
