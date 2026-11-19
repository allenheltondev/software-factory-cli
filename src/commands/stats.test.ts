import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHistory, History } from '../../test/factory-history.js';
import { openDatabase, openDatabaseReadOnly, SCHEMA_VERSION, schemaVersion } from '../db/database.js';
import { EXIT } from './errors.js';
import { fakeContext } from './fakes.js';
import { formatDuration, parseSince, statsCommand } from './stats.js';

const END = Date.parse('2026-11-18T12:00:00.000Z');

/** A context whose clock is END, with (unless `db` is false) the history fixture in a real state DB. */
function setup(o: { db?: boolean; schema?: number } = {}) {
  const ctx = fakeContext();
  ctx.now = () => END;
  if (o.db !== false) {
    const db = openDatabase(ctx.paths.dbFile, o.schema ? { migrateTo: o.schema } : {});
    if (!o.schema) buildHistory(END, db);
    db.close();
  }
  const opened: string[] = [];
  // The command may only ever use the read-only opener.
  ctx.openDbReadOnly = (file) => {
    opened.push(file);
    return openDatabaseReadOnly(file);
  };
  return { ctx, opened };
}

describe('parseSince and formatDuration', () => {
  it('takes clean\'s units, or "all"', () => {
    expect(parseSince('30d')).toBe(30 * 86_400_000);
    expect(parseSince('12h')).toBe(12 * 3_600_000);
    expect(parseSince('2W')).toBe(14 * 86_400_000);
    expect(parseSince('all')).toBeNull();
    expect(parseSince(' ALL ')).toBeNull();
    for (const bad of ['', '30', 'd', '1m', '-1d', 'forever']) {
      expect(() => parseSince(bad), bad).toThrow(expect.objectContaining({ exitCode: EXIT.USAGE, message: expect.stringContaining('--since') }));
    }
  });

  it('prints compact durations', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(400)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000 + 5_000)).toBe('12m 05s');
    expect(formatDuration(3 * 3_600_000 + 4 * 60_000)).toBe('3h 04m');
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 03h');
  });
});

describe('statsCommand', () => {
  it('prints the default 30-day report as aligned text', async () => {
    const { ctx, opened } = setup();
    expect(await statsCommand(ctx, {})).toBe(EXIT.OK);
    expect(opened).toEqual([ctx.paths.dbFile]);
    const text = ctx.out.text;
    expect(text.split('\n').slice(0, 2)).toEqual([
      'Updraft stats for the last 30d (since 2026-10-19 12:00 UTC), all repositories',
      'Facts in the window: 51',
    ]);
    expect(text).toContain(
      [
        'Work items done',
        '                implement  revision  review  total',
        '  succeeded             3         2       4      9',
        '  failed                1         0       0      1',
        '  interrupted           0         0       0      0',
        '  canceled              0         0       0      0',
        '  all finished          4         2       4     10',
        '  queued now            1         0       0      1',
        '  running now           1         0       0      1',
      ].join('\n'),
    );
    expect(text).toContain('                         n      avg   median      p90\n  agent run, implement   5  15m 12s  15m 00s  26m 00s\n');
    expect(text).toContain('  PR opened to merged    1   3h 07m   3h 07m   3h 07m\n');
    expect(text).toContain('  auto-merge blocked  1 head(s) of 1 PR(s): checks-failed 1\n');
    expect(text).toContain('  failed runs         2: implement 2; claude 2; verify commands failed in 1, no verify result in 1\n');
    expect(text).toContain('  changes requested  by the reviewer 2 (1 queued a revision), by people 2 (1 queued a revision)\n');
    expect(text).toContain('  findings           3 in 1 changes-requested review(s) with a count (avg 3.0); 1 without a count; 2 review(s) in all without a count\n');
    expect(text).toContain('  first-pass ready   2 of 3 PR(s) (67%)\n');
    expect(text).toContain('Back-and-forths (3 PR(s) opened in the window)\n  revisions per PR      avg 0.7, max 2; 0: 2, 1: 0, 2: 1, 3+: 0\n');
    expect(text).toContain('  octo/art         2       0    1       1        0        1                0/0           0.0     17m 30s\n');
    // Only names, numbers and codes; no text from issues or reviews.
    expect(text).not.toMatch(/Issue \d|text that must not|please change/);
    // No line wider than a wide terminal, and nothing that needs colour.
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThanOrEqual(140);
    expect(text).not.toContain('\u001b[');
  });

  it('prints the documented JSON shape, for one repository and all of history', async () => {
    const { ctx } = setup();
    await statsCommand(ctx, { json: true, since: 'all', repo: 'OCTO/widgets' });
    const r = JSON.parse(ctx.out.text);
    expect(Object.keys(r)).toEqual(['version', 'generatedAt', 'window', 'repo', 'database', 'facts', 'overall', 'byRepo']);
    expect(r).toMatchObject({ version: 1, repo: 'octo/widgets', database: true, window: { label: 'all', since: null, until: '2026-11-18T12:00:00.000Z' } });
    expect(Object.keys(r.overall)).toEqual(['work', 'time', 'outcomes', 'review', 'backAndForth', 'routing', 'pressure', 'dependencies']);
    expect(Object.keys(r.overall.time)).toEqual(['agentRun', 'queueWait', 'labelToPr', 'prToMerge']);
    expect(r.overall.time.agentRun.byKind.implement).toEqual({ count: 5, total: 5, averageMs: expect.any(Number), medianMs: expect.any(Number), p90Ms: expect.any(Number) });
    expect(r.overall.review.findings).toMatchObject({ total: 5, withCount: 2, average: 2.5 });
    expect(r.byRepo).toHaveLength(1);
    expect(r.byRepo[0]).toMatchObject({ repo: 'octo/widgets', repoId: 42 });
  });

  it('--since today starts at local midnight: includes an event at midnight, not one just before', async () => {
    const midnight = new Date(2026, 10, 18).getTime(); // local midnight
    const ctx = fakeContext();
    ctx.now = () => midnight + 5 * 3_600_000;
    const db = openDatabase(ctx.paths.dbFile);
    const h = new History(midnight - 1, db);
    h.queueIssue({ repoId: 42, fullName: 'octo/widgets', issue: 1 });
    h.run(); // finishes 1 ms before midnight
    h.advance(1);
    h.queueIssue({ repoId: 42, fullName: 'octo/widgets', issue: 2 });
    h.run(); // finishes exactly at midnight
    db.close();
    ctx.openDbReadOnly = (file) => openDatabaseReadOnly(file);

    await statsCommand(ctx, { json: true, since: 'today', repo: 'octo/widgets' });
    const r = JSON.parse(ctx.out.text);
    expect(r.window).toMatchObject({ label: 'today', since: new Date(midnight).toISOString() });
    expect(r.repo).toBe('octo/widgets');
    expect(r.overall.work.finished.total.total).toBe(1);

    const text = fakeContext();
    text.now = ctx.now;
    text.openDbReadOnly = ctx.openDbReadOnly;
    text.paths = ctx.paths;
    await statsCommand(text, { since: ' Today ' });
    expect(text.out.text).toContain('Updraft stats for today (since ');
  });

  it('opens the database read-only and refuses one from before stats, without upgrading it', async () => {
    const { ctx } = setup({ schema: 12 });
    await expect(statsCommand(ctx, {})).rejects.toThrow(/schema v12, from before stats were recorded \(v13\).*run "updraft status" once to upgrade it/);
    const after = openDatabaseReadOnly(ctx.paths.dbFile);
    expect(schemaVersion(after)).toBe(12);
    after.close();
  });

  it('refuses a database newer than it supports', async () => {
    const { ctx } = setup({ schema: 1 });
    const raw = openDatabase(ctx.paths.dbFile, { migrateTo: 1 });
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    await expect(statsCommand(ctx, {})).rejects.toThrow(/newer than this CLI supports/);
  });

  it('does not create the state DB when there is none, and reports nothing recorded', async () => {
    const { ctx, opened } = setup({ db: false });
    expect(await statsCommand(ctx, {})).toBe(EXIT.OK);
    expect(opened).toEqual([]);
    expect(existsSync(ctx.paths.dbFile)).toBe(false);
    expect(ctx.out.text).toContain('No state database yet');
    const json = setup({ db: false }).ctx;
    await statsCommand(json, { json: true });
    expect(JSON.parse(json.out.text)).toMatchObject({ database: false, facts: { total: 0 }, byRepo: [] });
  });

  it('rejects a bad --since or --repo before touching the database', async () => {
    const { ctx, opened } = setup();
    await expect(statsCommand(ctx, { since: '3 months' })).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    await expect(statsCommand(ctx, { repo: 'widgets' })).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    await expect(statsCommand(ctx, { repo: 'a/b/c' })).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    expect(opened).toEqual([]);
  });
});
