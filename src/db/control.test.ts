import { afterEach, describe, expect, it } from 'vitest';
import { listControlCommands, recordControlCommand, type ControlCommandRecord } from './control.js';
import { openDatabase, type Db } from './database.js';

const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const record = (source: string, command: string, receivedAt = '2026-01-01T00:00:00.000Z'): ControlCommandRecord => ({
  source, repoId: 42, issue: 7, pullRequest: null, actor: 'allen', command, receivedAt, headSha: null, outcome: 'applied', message: '',
});

describe('control command records', () => {
  it('list in the order recorded when received in the same millisecond, whatever their ids', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    // Ids that sort the other way round, as random cli-<uuid> ids can.
    expect(recordControlCommand(db, record('cli-ffff', 'pause'))).toBe(true);
    expect(recordControlCommand(db, record('cli-0000', 'resume'))).toBe(true);
    expect(recordControlCommand(db, record('cli-8888', 'pause'))).toBe(true);
    expect(listControlCommands(db, 42, 7).map((r) => [r.command, r.seq])).toEqual([['pause', 1], ['resume', 2], ['pause', 3]]);
    // The sequence is one counter row per repository, not a scan of the history.
    expect(db.prepare("SELECT value FROM meta WHERE key = 'control:seq:42'").get()).toEqual({ value: '3' });
  });

  it('orders by time received first, and records a duplicate once', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    recordControlCommand(db, record('2', 'resume', '2026-01-01T00:00:02.000Z'));
    recordControlCommand(db, record('1', 'pause', '2026-01-01T00:00:01.000Z'));
    expect(recordControlCommand(db, record('1', 'stop', '2026-01-01T00:00:03.000Z'))).toBe(false);
    expect(listControlCommands(db, 42, 7).map((r) => r.command)).toEqual(['pause', 'resume']);
  });
});
