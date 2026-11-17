import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openDatabase, transaction } from './database.js';

describe('openDatabase', () => {
  it('migrates a fresh database to the current schema', () => {
    const db = openDatabase(':memory:');
    const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(v.user_version).toBe(SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['jobs', 'runs', 'repo_checkpoints', 'worker_lock', 'errors']));
  });

  it('rolls back failed transactions', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO meta (key, value) VALUES ('a', '1')").run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare("SELECT count(*) AS n FROM meta").get()).toEqual({ n: 0 });
  });
});
