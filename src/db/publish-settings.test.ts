import { describe, expect, it } from 'vitest';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase, type Db } from './database.js';
import { getPublishSetting, listUnpublishedSinceEnabled, syncPublishSettings } from './publish-settings.js';

const T0 = Date.parse('2026-11-17T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function config(repos: Record<string, { id: number; publish?: 'none' | 'draft-pr' | 'pr' }>): UpdraftConfig {
  return configSchema.parse({
    version: 1,
    execution: { mode: 'live' },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompt.md' } },
    repositories: Object.fromEntries(
      Object.entries(repos).map(([name, r]) => [
        name,
        { ...r, workflows: [{ trigger: { event: 'issue.labeled', label: 'factory:ready' }, action: 'implement-issue', pool: 'general' }] },
      ]),
    ),
  });
}

function insertRun(db: Db, o: { id: string; repoId: number; endedAt: string; outcome?: string; summary?: string | null }): void {
  db.prepare(
    `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES (?, ?, 'o/r', 'wf', ?, 1, 'implement-issue', 'general', '{}', 'succeeded', 1, 't', 't')`,
  ).run(`job_${o.id}`, o.repoId, o.id);
  db.prepare(
    `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome, summary)
     VALUES (?, ?, 1, 'general', 'claude', 'wrk_1', 't', 't', ?, ?, ?)`,
  ).run(o.id, `job_${o.id}`, o.endedAt, o.outcome ?? 'succeeded', o.summary === undefined ? '{"commitCount":1}' : o.summary);
}

describe('syncPublishSettings', () => {
  it('sets enabled_at when publish is turned on, clears it when turned off, keeps it across draft-pr/pr', () => {
    const db = openDatabase(':memory:');
    expect(syncPublishSettings(db, config({ 'o/r': { id: 1 } }), () => T0)).toEqual([]);
    expect(getPublishSetting(db, 1)).toBeNull(); // never on: nothing to remember

    expect(syncPublishSettings(db, config({ 'o/r': { id: 1, publish: 'draft-pr' } }), () => T0 + 1)).toEqual([
      { repoId: 1, repoFullName: 'o/r', from: 'none', to: 'draft-pr', enabledAt: iso(T0 + 1) },
    ]);
    // Loading the same config again changes nothing.
    expect(syncPublishSettings(db, config({ 'o/r': { id: 1, publish: 'draft-pr' } }), () => T0 + 2)).toEqual([]);
    expect(getPublishSetting(db, 1)).toMatchObject({ mode: 'draft-pr', enabledAt: iso(T0 + 1), updatedAt: iso(T0 + 1) });

    syncPublishSettings(db, config({ 'o/r': { id: 1, publish: 'pr' } }), () => T0 + 3);
    expect(getPublishSetting(db, 1)).toMatchObject({ mode: 'pr', enabledAt: iso(T0 + 1) });

    syncPublishSettings(db, config({ 'o/r': { id: 1, publish: 'none' } }), () => T0 + 4);
    expect(getPublishSetting(db, 1)).toMatchObject({ mode: 'none', enabledAt: null });

    syncPublishSettings(db, config({ 'o/r': { id: 1, publish: 'pr' } }), () => T0 + 5);
    expect(getPublishSetting(db, 1)).toMatchObject({ mode: 'pr', enabledAt: iso(T0 + 5) });
  });

  it('treats a repository removed from the config as off, and a renamed one by its id', () => {
    const db = openDatabase(':memory:');
    syncPublishSettings(db, config({ 'o/r': { id: 1, publish: 'draft-pr' }, 'o/s': { id: 2, publish: 'pr' } }), () => T0);
    syncPublishSettings(db, config({ 'o/renamed': { id: 1, publish: 'draft-pr' } }), () => T0 + 1);
    expect(getPublishSetting(db, 1)).toMatchObject({ repoFullName: 'o/renamed', mode: 'draft-pr', enabledAt: iso(T0) });
    expect(getPublishSetting(db, 2)).toMatchObject({ mode: 'none', enabledAt: null });
  });
});

describe('listUnpublishedSinceEnabled', () => {
  it('lists succeeded runs with a summary and no publication that ended at or after enabled_at, oldest first', () => {
    const db = openDatabase(':memory:');
    syncPublishSettings(db, config({ 'o/r': { id: 1, publish: 'draft-pr' }, 'o/off': { id: 2 } }), () => T0);
    insertRun(db, { id: 'run_late', repoId: 1, endedAt: iso(T0 + 20) });
    insertRun(db, { id: 'run_at', repoId: 1, endedAt: iso(T0) });
    insertRun(db, { id: 'run_before', repoId: 1, endedAt: iso(T0 - 1) });
    insertRun(db, { id: 'run_failed', repoId: 1, endedAt: iso(T0 + 1), outcome: 'failed' });
    insertRun(db, { id: 'run_nosummary', repoId: 1, endedAt: iso(T0 + 1), summary: null });
    insertRun(db, { id: 'run_off', repoId: 2, endedAt: iso(T0 + 1) });
    insertRun(db, { id: 'run_other', repoId: 3, endedAt: iso(T0 + 1) });
    insertRun(db, { id: 'run_published', repoId: 1, endedAt: iso(T0 + 1) });
    db.prepare(
      `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, attempts, created_at, updated_at)
       VALUES ('run_published', 'job_run_published', 1, 'o/r', 1, 'draft-pr', 'failed', 'b', 1, 't', 't')`,
    ).run();
    expect(listUnpublishedSinceEnabled(db)).toEqual(['run_at', 'run_late']);

    syncPublishSettings(db, config({ 'o/r': { id: 1 } }), () => T0 + 30);
    expect(listUnpublishedSinceEnabled(db)).toEqual([]);
  });
});
