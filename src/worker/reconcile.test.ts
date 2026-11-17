import { describe, expect, it, vi } from 'vitest';
import { configSchema, type FactoryConfig } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { claimNextJob, getJob, getRun, setRunProcess, type Claim } from '../db/queue.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope } from '../types.js';
import { silentLogger } from '../util/log.js';
import type { ProcessControl } from './process.js';
import { reconcileInterruptedRuns } from './reconcile.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');
const now = () => T0;

function makeConfig(): FactoryConfig {
  return configSchema.parse({
    version: 1,
    maxConcurrent: 5,
    agents: { claude: { maxConcurrent: 5 } },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement-issue.md' } },
    dispatch: { allowedActors: ['allen'] },
  });
}

let seq = 0;
function insertJob(db: Db): string {
  seq++;
  const id = `job_${String(seq).padStart(5, '0')}`;
  const createdAt = new Date(T0 - 1_000_000 + seq * 1000).toISOString();
  const envelope: EventEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    type: 'issue.labeled',
    repo: { id: 1, fullName: 'owner/repo' },
    issue: { number: seq, title: `Issue ${seq}`, url: `https://github.com/owner/repo/issues/${seq}` },
    eventId: String(seq),
    url: `https://github.com/owner/repo/issues/${seq}`,
    actor: 'allen',
    label: 'factory:ready',
    labelsAtEnqueue: ['factory:ready'],
    createdAt,
  };
  db.prepare(
    `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES (?, 1, 'owner/repo', 'implement-issue:factory:ready', ?, ?, 'implement-issue', 'general', ?, 'queued', 0, ?, ?)`,
  ).run(id, envelope.eventId, seq, JSON.stringify(envelope), createdAt, createdAt);
  return id;
}

/** A run left open by an earlier worker, with an agent pid recorded. */
function openRun(db: Db, o: { workerId: string; hostname: string; pid: number }): Claim {
  insertJob(db);
  const claim = claimNextJob(db, makeConfig(), {
    workerId: o.workerId,
    hostname: o.hostname,
    leaseSeconds: 60,
    runsDir: 'runs',
    now,
  })!;
  setRunProcess(db, claim.run.id, { pid: o.pid });
  return claim;
}

function fakeProcesses(alive: number[]) {
  const terminated: number[] = [];
  const pc: ProcessControl = {
    isAlive: (pid) => alive.includes(pid) && !terminated.includes(pid),
    terminate: vi.fn(async (pid: number) => {
      terminated.push(pid);
    }),
  };
  return { pc, terminated };
}

describe('reconcileInterruptedRuns: which pids are signalled', () => {
  it('reaps a live pid from any earlier worker on this host, not just the previous lock holder', async () => {
    const db = openDatabase(':memory:');
    // wrk_1 crashed, wrk_2 took over and also crashed without reaping wrk_1's agent.
    const older = openRun(db, { workerId: 'wrk_1', hostname: 'host-a', pid: 101 });
    const newer = openRun(db, { workerId: 'wrk_2', hostname: 'host-a', pid: 102 });
    const { pc, terminated } = fakeProcesses([101, 102]);

    await reconcileInterruptedRuns(db, { hostname: 'host-a', processControl: pc, log: silentLogger, now });

    expect(terminated.sort()).toEqual([101, 102]);
    expect(getRun(db, older.run.id)?.error).toMatch(/terminated leftover agent process 101/);
    expect(getRun(db, newer.run.id)?.error).toMatch(/terminated leftover agent process 102/);
  });

  it('never signals a pid recorded on another host, or on an unknown host', async () => {
    const db = openDatabase(':memory:');
    const remote = openRun(db, { workerId: 'wrk_1', hostname: 'host-b', pid: 201 });
    const unknown = openRun(db, { workerId: 'wrk_2', hostname: 'host-a', pid: 202 });
    db.prepare('UPDATE runs SET hostname = NULL WHERE id = ?').run(unknown.run.id); // e.g. migrated from v3
    const { pc } = fakeProcesses([201, 202]);

    await reconcileInterruptedRuns(db, { hostname: 'host-a', processControl: pc, log: silentLogger, now });

    expect(pc.terminate).not.toHaveBeenCalled();
    expect(getRun(db, remote.run.id)?.error).toMatch(/pid 201 was not signalled \(recorded on host host-b\)/);
    expect(getRun(db, unknown.run.id)?.error).toMatch(/pid 202 was not signalled \(recorded on an unknown host\)/);
    expect(getJob(db, remote.job.id)?.status).toBe('interrupted');
    expect(getJob(db, unknown.job.id)?.status).toBe('interrupted');
  });
});
