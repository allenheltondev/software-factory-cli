import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_OUTCOMES, recordControlCommand, type ControlCommandRecord } from '../db/control.js';
import { openDatabase, openDatabaseReadOnly, type Db } from '../db/database.js';
import { controlsCommand, plainText, renderControls, truncateLine } from './controls.js';
import { CliError, EXIT } from './errors.js';
import { fakeContext } from './fakes.js';

const homes: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** A context that fails the test on any GitHub call, credential use or writable database. */
function setup(o: { db?: boolean } = {}) {
  const ctx = fakeContext();
  homes.push(ctx.paths.dataDir);
  ctx.createApi = () => {
    throw new Error('createApi must not be called');
  };
  ctx.createCredentials = () => {
    throw new Error('createCredentials must not be called');
  };
  ctx.openDb = () => {
    throw new Error('openDb (writable) must not be called');
  };
  ctx.openDbReadOnly = (file) => openDatabaseReadOnly(file);
  mkdirSync(dirname(ctx.paths.configFile), { recursive: true });
  writeFileSync(ctx.paths.configFile, JSON.stringify({
    version: 1, agents: { claude: {} }, pools: { general: { agents: ['claude'] } }, actions: { 'implement-issue': {} },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      'octo/widgets': { id: 42, workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }] },
      'octo/other': { id: 43, workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }] },
    },
  }));
  if (o.db === false) return { ctx, db: null as unknown as Db };
  const db = openDatabase(ctx.paths.dbFile);
  dbs.push(db);
  return { ctx, db };
}

function record(db: Db, r: Partial<ControlCommandRecord> & { source: string }): void {
  recordControlCommand(db, {
    repoId: 42, issue: 7, pullRequest: null, actor: 'allen', command: 'pause', receivedAt: '2026-01-01T00:00:00.000Z', headSha: null, outcome: 'applied', message: 'Paused #7.',
    ...r,
  });
}

function addLoopPr(db: Db, prNumber: number, issue: number): void {
  db.prepare(
    `INSERT INTO revision_prs (repo_id, pr_number, pr_url, source_run_id, original_event_id, workflow_id, issue_number, issue_title, issue_url, label, labels, action, pool, branch, state, created_at, updated_at)
     VALUES (42, ?, '', 'run_1', 'ev_1', 'wf', ?, 't', '', 'updraft:ready', '[]', 'implement-issue', 'general', 'updraft/x', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(prNumber, issue);
}

const parseJson = (text: string) => JSON.parse(text) as ControlCommandRecord[];

describe('updraft controls', () => {
  it('lists a repository’s commands oldest first: by time, then seq, then source', async () => {
    const { ctx, db } = setup();
    // Recorded out of time order; three of them in the same millisecond.
    record(db, { source: 'c-late', receivedAt: '2026-01-02T00:00:00.000Z', command: 'resume' });
    record(db, { source: 'z-same', command: 'stop' });
    record(db, { source: 'a-same', issue: 8, command: 'cancel' });
    record(db, { source: 'm-early', receivedAt: '2025-12-31T00:00:00.000Z', command: 'help' });
    record(db, { source: 'other', repoId: 43 });
    expect(await controlsCommand(ctx, 'octo/widgets', { json: true })).toBe(EXIT.OK);
    // Same millisecond: z-same was recorded before a-same, so seq orders it first, not the source.
    expect(parseJson(ctx.out.text).map((r) => r.source)).toEqual(['m-early', 'z-same', 'a-same', 'c-late']);
  });

  it('breaks a tie of time and seq by source', async () => {
    const { ctx, db } = setup();
    // Records merged from two state copies can share a seq.
    const put = (source: string) =>
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`control:command:42#${source}`, JSON.stringify({ source, repoId: 42, issue: 7, pullRequest: null, actor: 'a', command: 'pause', receivedAt: '2026-01-01T00:00:00.000Z', headSha: null, outcome: 'noop', message: '', seq: 1 }));
    put('b');
    put('a');
    await controlsCommand(ctx, 'octo/widgets', { json: true });
    expect(parseJson(ctx.out.text).map((r) => r.source)).toEqual(['a', 'b']);
  });

  it('filters to one issue, and resolves a pull request the review loop knows to its issue', async () => {
    const { ctx, db } = setup();
    record(db, { source: 's1', issue: 7 });
    record(db, { source: 's2', issue: 8 });
    record(db, { source: 's3', issue: 7, pullRequest: 12, command: 'review' });
    addLoopPr(db, 12, 7);
    await controlsCommand(ctx, 'octo/widgets#7', { json: true });
    expect(parseJson(ctx.out.text).map((r) => r.source)).toEqual(['s1', 's3']);
    ctx.out.text = '';
    await controlsCommand(ctx, 'OCTO/Widgets#12', { json: true });
    expect(parseJson(ctx.out.text).map((r) => r.source)).toEqual(['s1', 's3']);
    ctx.out.text = '';
    await controlsCommand(ctx, 'octo/widgets#8', { json: true });
    expect(parseJson(ctx.out.text).map((r) => r.source)).toEqual(['s2']);
  });

  it('--json prints only a JSON array with the record fields', async () => {
    const { ctx, db } = setup();
    record(db, { source: 's1', headSha: 'abc', message: 'line one\nline two' });
    expect(await controlsCommand(ctx, 'octo/widgets', { json: true })).toBe(EXIT.OK);
    const parsed = parseJson(ctx.out.text);
    expect(parsed).toEqual([{ source: 's1', repoId: 42, issue: 7, pullRequest: null, actor: 'allen', command: 'pause', receivedAt: '2026-01-01T00:00:00.000Z', headSha: 'abc', outcome: 'applied', message: 'line one\nline two', seq: 1 }]);
    expect(ctx.err.text).toBe('');
  });

  it('--limit keeps the newest N, oldest first, and rejects zero, negatives and non-numbers', async () => {
    const { ctx, db } = setup();
    for (let i = 1; i <= 5; i++) record(db, { source: `s${i}`, receivedAt: `2026-01-0${i}T00:00:00.000Z` });
    await controlsCommand(ctx, 'octo/widgets', { json: true, limit: '2' });
    expect(parseJson(ctx.out.text).map((r) => r.source)).toEqual(['s4', 's5']);
    for (const bad of ['0', '-3', 'ten', '1.5', '']) {
      await expect(controlsCommand(ctx, 'octo/widgets', { limit: bad })).rejects.toMatchObject({ exitCode: EXIT.USAGE, message: expect.stringMatching(/--limit must be a positive whole number/) });
    }
  });

  it('defaults to the newest 50', async () => {
    const { ctx, db } = setup();
    for (let i = 0; i < 55; i++) record(db, { source: `s${String(i).padStart(2, '0')}`, receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    await controlsCommand(ctx, 'octo/widgets', { json: true });
    const got = parseJson(ctx.out.text).map((r) => r.source);
    expect(got).toHaveLength(50);
    expect(got[0]).toBe('s05');
    expect(got.at(-1)).toBe('s54');
  });

  it('--outcome filters to one outcome (before the limit) and rejects any other value, listing the valid ones', async () => {
    const { ctx, db } = setup();
    record(db, { source: 's1', outcome: 'refused', receivedAt: '2026-01-01T00:00:00.000Z' });
    record(db, { source: 's2', outcome: 'applied', receivedAt: '2026-01-02T00:00:00.000Z' });
    record(db, { source: 's3', outcome: 'refused', receivedAt: '2026-01-03T00:00:00.000Z' });
    record(db, { source: 's4', outcome: 'applied', receivedAt: '2026-01-04T00:00:00.000Z' });
    await controlsCommand(ctx, 'octo/widgets', { json: true, outcome: 'refused', limit: '5' });
    expect(parseJson(ctx.out.text).map((r) => r.source)).toEqual(['s1', 's3']);
    ctx.out.text = '';
    await controlsCommand(ctx, 'octo/widgets', { json: true, outcome: 'applied', limit: '1' });
    expect(parseJson(ctx.out.text).map((r) => r.source)).toEqual(['s4']);
    const err = await controlsCommand(ctx, 'octo/widgets', { outcome: 'Applied' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    for (const o of CONTROL_OUTCOMES) expect((err as CliError).message).toContain(o);
  });

  it('prints a table with the message on one line, capped, and stored values as plain text', async () => {
    const { ctx, db } = setup();
    record(db, { source: 's1', pullRequest: 12, actor: 'mal\u001b[31mlory\u0007', command: 're\u001b]0;pwned\u0007view', outcome: 'refused', message: `first\r\nsecond\tthird \u001b[2J${'x'.repeat(200)}` });
    record(db, { source: 's2', message: 'short' });
    expect(await controlsCommand(ctx, 'octo/widgets')).toBe(EXIT.OK);
    const text = ctx.out.text;
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^RECEIVED\s+ISSUE\s+PR\s+ACTOR\s+COMMAND\s+OUTCOME\s+MESSAGE$/);
    expect(lines[1]).toContain('#12');
    expect(lines[1]).toContain('mallory');
    expect(lines[1]).toContain('review');
    expect(lines[1]).toContain('first second third xxx');
    const message = lines[1]!.slice(lines[1]!.indexOf('first'));
    expect([...message].length).toBeLessThanOrEqual(80);
    expect(message.endsWith('…')).toBe(true);
    expect(lines[2]).toMatch(/#7\s+-\s+allen\s+pause\s+applied\s+short$/);
  });

  it('strips escapes and controls, and truncates by characters', () => {
    expect(plainText('a\u001b[1;31mb\u001b[0m\u009b2Jc\u202ed\u0000e\n\nf')).toBe('abcde f');
    expect(truncateLine('short')).toBe('short');
    expect(truncateLine('a'.repeat(81))).toBe(`${'a'.repeat(79)}…`);
    expect(truncateLine('a'.repeat(80))).toBe('a'.repeat(80));
    expect(renderControls([])).toMatch(/^RECEIVED/);
  });

  it('says when nothing is recorded, and prints [] in JSON mode', async () => {
    const { ctx, db } = setup();
    record(db, { source: 's1', issue: 7, outcome: 'applied' });
    expect(await controlsCommand(ctx, 'octo/other')).toBe(EXIT.OK);
    expect(ctx.out.text).toBe('No commands recorded for octo/other.\n');
    ctx.out.text = '';
    expect(await controlsCommand(ctx, 'octo/widgets#9')).toBe(EXIT.OK);
    expect(ctx.out.text).toBe('No commands recorded for octo/widgets#9.\n');
    ctx.out.text = '';
    expect(await controlsCommand(ctx, 'octo/widgets', { outcome: 'refused' })).toBe(EXIT.OK);
    expect(ctx.out.text.trimEnd().split('\n')).toHaveLength(1);
    expect(ctx.out.text).toMatch(/^No commands recorded/);
    ctx.out.text = '';
    expect(await controlsCommand(ctx, 'octo/other', { json: true })).toBe(EXIT.OK);
    expect(JSON.parse(ctx.out.text)).toEqual([]);
  });

  it('fails clearly for an unknown repository, a malformed reference and a missing state database', async () => {
    const { ctx } = setup();
    await expect(controlsCommand(ctx, 'nobody/else')).rejects.toThrow(/nobody\/else is not a configured repository/);
    await expect(controlsCommand(ctx, 'nobody/else#3')).rejects.toThrow(/is not a configured repository/);
    for (const bad of ['octo', 'octo/widgets#', 'octo/widgets#x', 'octo/widgets/x', '#7', 'octo/widgets#7#8']) {
      const err = await controlsCommand(ctx, bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toMatch(/is not OWNER\/REPO or OWNER\/REPO#NUMBER/);
      expect((err as CliError).exitCode).not.toBe(EXIT.OK);
    }
    const missing = setup({ db: false }).ctx;
    const err = await controlsCommand(missing, 'octo/widgets').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/No state database at .*; nothing has run yet/);
    expect((err as CliError).exitCode).toBe(EXIT.FAILURE);
  });

  it('never calls GitHub, uses credentials or writes the database', async () => {
    const { ctx, db } = setup();
    record(db, { source: 's1' });
    addLoopPr(db, 12, 7);
    const before = db.prepare('SELECT key, value FROM meta ORDER BY key').all();
    // createApi, createCredentials and openDb throw (setup); the read-only handle cannot write.
    expect(await controlsCommand(ctx, 'octo/widgets#12')).toBe(EXIT.OK);
    expect(await controlsCommand(ctx, 'octo/widgets', { json: true })).toBe(EXIT.OK);
    expect(db.prepare('SELECT key, value FROM meta ORDER BY key').all()).toEqual(before);
  });
});
