// What one run leaves alone in a shared state database because another run holds it
// (src/db/holds.ts, src/worker/scope.ts).
import { describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { openDatabase, type Db } from '../db/database.js';
import { activeForeignHolds, holdKey, holdSubject, listHolds, putHold, releaseHolds } from '../db/holds.js';
import { createEventScope, foreignWork, withoutForeignWork } from './scope.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function withDb<T>(fn: (db: Db) => T): T {
  const db = openDatabase(':memory:');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('holds', () => {
  it('names a job or a pull request, and reads its own keys back', () => {
    expect(holdKey({ job: 'job_x' })).toBe('run-event:hold:job:job_x');
    expect(holdKey({ pr: { repoId: 42, prNumber: 100 } })).toBe('run-event:hold:pr:42#100');
    expect(holdSubject('run-event:hold:job:job_x')).toEqual({ job: 'job_x' });
    expect(holdSubject('run-event:hold:pr:42#100')).toEqual({ pr: { repoId: 42, prNumber: 100 } });
    expect(holdSubject('run-event:hold:pr:nonsense')).toBeNull();
    expect(holdSubject('something-else')).toBeNull();
  });

  it('counts for other runs until it is released or has expired, and never for its holder', () => {
    withDb((db) => {
      putHold(db, { job: 'job_x' }, { holder: 'wrk_a', delivery: 'd-1', until: iso(NOW + 60_000) });
      db.prepare("INSERT INTO meta (key, value) VALUES ('run-event:hold:job:broken', 'not json')").run();
      expect(listHolds(db)).toEqual([{ key: 'run-event:hold:job:job_x', holder: 'wrk_a', delivery: 'd-1', until: iso(NOW + 60_000), releasedAt: null }]);
      expect(activeForeignHolds(db, 'wrk_b', NOW)).toHaveLength(1);
      expect(activeForeignHolds(db, 'wrk_a', NOW)).toEqual([]);
      expect(activeForeignHolds(db, 'wrk_b', NOW + 60_000)).toEqual([]);
      expect(releaseHolds(db, 'wrk_b', iso(NOW))).toBe(0);
      expect(releaseHolds(db, 'wrk_a', iso(NOW))).toBe(1);
      expect(activeForeignHolds(db, 'wrk_b', NOW)).toEqual([]);
      // Taken again by a later run of the same event: one row, held again.
      putHold(db, { job: 'job_x' }, { holder: 'wrk_c', delivery: null, until: iso(NOW + 60_000) });
      expect(listHolds(db)).toMatchObject([{ holder: 'wrk_c', releasedAt: null }]);
    });
  });
});

describe('withoutForeignWork', () => {
  it("leaves a job another run holds out of this run's scope, and takes it once the hold is gone", () => {
    withDb((db) => {
      const held = insertQueuedJob(db, { repoId: 42, fullName: 'o/r', issue: 7 });
      const free = insertQueuedJob(db, { repoId: 42, fullName: 'o/r', issue: 8 });
      putHold(db, { job: held }, { holder: 'wrk_other', delivery: null, until: iso(NOW + 60_000) });
      const scope = () => {
        const inner = createEventScope(db);
        inner.addJob(held);
        inner.addJob(free);
        return inner;
      };

      const foreign = foreignWork(db, 'wrk_me', NOW);
      expect([...foreign.jobs]).toEqual([held]);
      const guarded = withoutForeignWork(scope(), foreign);
      expect([guarded.job(held), guarded.job(free)]).toEqual([false, true]);
      // What was taken note of at the start stands for the life of the run, whatever the hold does later.
      releaseHolds(db, 'wrk_other', iso(NOW));
      expect(guarded.job(held)).toBe(false);

      // A run that starts after the release, or after the expiry, finds nothing held.
      expect(withoutForeignWork(scope(), foreignWork(db, 'wrk_me', NOW)).job(held)).toBe(true);
      putHold(db, { job: held }, { holder: 'wrk_other', delivery: null, until: iso(NOW + 60_000) });
      expect(foreignWork(db, 'wrk_me', NOW + 60_001).jobs.size).toBe(0);
      // A finished job is nobody's unfinished work; it is still its holder's to publish.
      db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(held);
      const finished = foreignWork(db, 'wrk_me', NOW);
      expect(finished.jobs.size).toBe(0);
      expect([finished.covers(held), finished.covers(free)]).toEqual([true, false]);
    });
  });

  it("keeps a held pull request's merge out of scope until this run has work of its own there", () => {
    withDb((db) => {
      putHold(db, { pr: { repoId: 42, prNumber: 100 } }, { holder: 'wrk_other', delivery: null, until: iso(NOW + 60_000) });
      const inner = createEventScope(db);
      inner.addPr(42, 100);
      inner.addPr(42, 101);
      // foreignWork lists the pull requests the database watches; this one is told directly.
      const guarded = withoutForeignWork(inner, { jobs: new Set(), runs: new Set(), prs: new Set(['42#100']), covers: () => false });
      expect([guarded.pr(42, 100), guarded.pr(42, 101)]).toEqual([false, true]);
      guarded.engage();
      expect(guarded.pr(42, 100)).toBe(true);
    });
  });
});
