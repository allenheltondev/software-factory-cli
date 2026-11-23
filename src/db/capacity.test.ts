import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { configSchema, type UpdraftConfig, type UpdraftConfigInput } from '../config/schema.js';
import { jobBranchName, jobWorktreePath } from '../git/worktree.js';
import { decideFailureHandling } from '../worker/failure-policy.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope } from '../types.js';
import { activeCooldowns, jobCounters, listPolicyEvents } from './capacity.js';
import { openDatabase, type Db } from './database.js';
import { claimNextJob, finishRun, getJob, getRun, requestJobCancel, markExecutionStarted, type Claim } from './queue.js';

const T0 = Date.parse('2026-11-18T10:00:00.000Z');
const RUNS_DIR = join('C:', 'updraft state', 'runs');
const MIN = 60_000;

function makeConfig(over: Partial<UpdraftConfigInput> = {}): UpdraftConfig {
  return configSchema.parse({
    version: 1,
    maxConcurrent: 5,
    capacity: { groups: { acct: { maxConcurrent: 1, defaultCooldownMinutes: 30, maxCooldownMinutes: 120 } }, maxDeferrals: 2 },
    agents: {
      'claude-a': { adapter: 'claude', capacityGroup: 'acct', maxConcurrent: 2 },
      'claude-b': { adapter: 'claude', capacityGroup: 'acct', maxConcurrent: 2 },
      codex: { maxConcurrent: 1 },
    },
    pools: { std: { agents: ['claude-a', 'claude-b', 'codex'] }, deep: { agents: ['codex'] }, only: { agents: ['claude-a', 'claude-b'] } },
    actions: { 'implement-issue': { prompt: './p.md' } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      'owner/repo': {
        id: 1,
        workflows: [
          {
            trigger: { event: 'issue.labeled', label: 'updraft:ready' },
            action: 'implement-issue',
            pool: 'std',
            tiers: { pools: { routine: 'std', standard: 'std', complex: 'deep' }, escalation: {} },
          },
        ],
      },
    },
    ...over,
  });
}

let seq = 0;
function insertJob(db: Db, o: { pool?: string; issue?: number; tier?: 'standard' | 'complex' } = {}): string {
  seq++;
  const id = `job_${String(seq).padStart(5, '0')}`;
  const issue = o.issue ?? seq;
  const createdAt = new Date(T0 - 1_000_000 + seq * 1000).toISOString();
  const envelope: EventEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    type: 'issue.labeled',
    repo: { id: 1, fullName: 'owner/repo' },
    issue: { number: issue, title: `Issue ${issue}`, url: 'https://github.com/owner/repo/issues/1' },
    eventId: String(seq),
    url: 'https://github.com/owner/repo/issues/1',
    actor: 'allen',
    label: 'updraft:ready',
    labelsAtEnqueue: ['updraft:ready'],
    createdAt,
    routing: { rule: 'heuristic', pool: o.pool ?? 'std', tier: o.tier ?? 'standard' },
  };
  db.prepare(
    `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES (?, 1, 'owner/repo', 'implement-issue:updraft:ready', ?, ?, 'implement-issue', ?, ?, 'queued', 0, ?, ?)`,
  ).run(id, envelope.eventId, issue, o.pool ?? 'std', JSON.stringify(envelope), createdAt, createdAt);
  return id;
}

const claimAt = (db: Db, config: UpdraftConfig, at = T0): Claim | null =>
  claimNextJob(db, config, { workerId: 'wrk', hostname: 'h', leaseSeconds: 60, runsDir: RUNS_DIR, now: () => at });

const LIMIT = { outcome: 'failed' as const, error: 'agent failed', cliOutput: "ERROR: You've hit your usage limit. Try again in 45 minutes." };

type Result = Parameters<typeof decideFailureHandling>[4];

/** What the daemon does for a finished run: decide, then record. */
function finish(db: Db, config: UpdraftConfig, c: Claim, result: Result, at = T0) {
  const h = decideFailureHandling(db, config, c.job, c.run, result, at);
  finishRun(db, c.run.id, { outcome: h.outcome, error: h.error ?? null, now: () => at, ...(h.handling ? { handling: h.handling } : {}) });
  return h;
}

describe('shared subscription capacity groups', () => {
  it.each([1, 2])('serializes the native-worker example profiles even with global concurrency %i', (globalLimit) => {
    const example = configSchema.pick({ maxConcurrent: true, agents: true, capacity: true }).parse(
      parse(readFileSync(new URL('../../deploy/aws-microvm/native-worker/updraft.example.yaml', import.meta.url), 'utf8')),
    );
    expect(example.maxConcurrent).toBe(1);
    const config = makeConfig({ ...example, maxConcurrent: globalLimit,
      pools: { std: { agents: ['claude'] }, only: { agents: ['claude-review'] }, deep: { agents: ['claude-review'] } } });
    const db = openDatabase(':memory:');
    try {
      const one = insertJob(db, { pool: 'std' });
      const two = insertJob(db, { pool: 'only' });
      const first = claimAt(db, config)!;
      expect(first.job.id).toBe(one);
      expect(first.run.agent).toBe('claude');
      expect(claimAt(db, config)).toBeNull();
      expect(getJob(db, two)).toMatchObject({ status: 'queued', attempts: 0 });
      finishRun(db, first.run.id, { outcome: 'succeeded', now: () => T0 });
      const second = claimAt(db, config)!;
      expect(second.job.id).toBe(two);
      expect(second.run.agent).toBe('claude-review');
      finishRun(db, second.run.id, { outcome: 'succeeded', now: () => T0 });
      expect(getJob(db, two)?.status).toBe('succeeded');
    } finally { db.close(); }
  });

  it('lets two profiles in one group run at most the group budget at once', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db, { pool: 'only' });
    insertJob(db, { pool: 'only' });
    const first = claimAt(db, config)!;
    expect(first).not.toBeNull();
    expect(claimAt(db, config)).toBeNull(); // the other job waits: the group has one slot
    const waiting = db.prepare("SELECT status_reason FROM jobs WHERE status = 'queued'").get() as { status_reason: string };
    expect(waiting.status_reason).toMatch(/waiting: .*group "acct" is at its limit of 1/);
    finishRun(db, first.run.id, { outcome: 'succeeded', now: () => T0 });
    expect(claimAt(db, config)).not.toBeNull();
  });

  it('changes nothing when capacity is not configured', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({
      capacity: undefined,
      agents: { 'claude-a': { adapter: 'claude', maxConcurrent: 2 }, 'claude-b': { adapter: 'claude', maxConcurrent: 2 }, codex: {} },
    });
    insertJob(db, { pool: 'only' });
    insertJob(db, { pool: 'only' });
    expect(claimAt(db, config)).not.toBeNull();
    expect(claimAt(db, config)).not.toBeNull();
  });
});

describe('usage-limit cooldown', () => {
  function limitRun(db: Db, config: UpdraftConfig, pool = 'std') {
    insertJob(db, { pool });
    const c = claimAt(db, config)!;
    finish(db, config, c, LIMIT);
    return c;
  }

  it('cools the whole group down for the stated wait, requeues the job and explains it', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    const c = limitRun(db, config);
    const cd = activeCooldowns(db, T0);
    expect(cd).toHaveLength(1);
    expect(cd[0]).toMatchObject({ scope: 'group', name: 'acct', stated: true, until: new Date(T0 + 45 * MIN).toISOString() });
    const job = getJob(db, c.job.id)!;
    expect(job.status).toBe('queued');
    expect(job.statusReason).toMatch(/waiting: claude-.* hit a usage limit/);
    expect(getRun(db, c.run.id)).toMatchObject({ outcome: 'failed' });
    expect(listPolicyEvents(db, c.job.id).map((e) => e.kind)).toEqual(['cooldown', 'deferred']);
    expect(listPolicyEvents(db, c.job.id)[0]!.runId).toBe(c.run.id);
  });

  it('falls back within the same pool, then waits with no eligible worker, then recovers at expiry', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    limitRun(db, config);
    // Both claude profiles share the cooled group: the same job falls back to codex in the same pool.
    const next = claimAt(db, config, T0 + MIN)!;
    expect(next.run.agent).toBe('codex');
    finishRun(db, next.run.id, { outcome: 'succeeded', now: () => T0 + MIN });

    // A pool with only grouped profiles has no eligible worker: it waits and says why.
    insertJob(db, { pool: 'only' });
    expect(claimAt(db, config, T0 + 2 * MIN)).toBeNull();
    const reason = (db.prepare("SELECT status_reason FROM jobs WHERE status = 'queued'").get() as { status_reason: string }).status_reason;
    expect(reason).toMatch(/cooling down until 2026-11-18T10:45:00.000Z/);

    // Expiry: the same job starts again with no manual step.
    expect(claimAt(db, config, T0 + 46 * MIN)).not.toBeNull();
  });

  it('survives a restart: the cooldown is read from the database', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    limitRun(db, config, 'only');
    expect(claimAt(db, config, T0 + 5 * MIN)).toBeNull();
  });

  it('bounds a stated wait by maxCooldownMinutes and uses the default when none is stated', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db, { pool: 'only' });
    const c = claimAt(db, config)!;
    const h = decideFailureHandling(db, config, c.job, c.run, { outcome: 'failed', cliOutput: 'usage limit reached. Try again in 5 days.' }, T0);
    expect(h.handling).toMatchObject({ kind: 'usage-limit', cooldown: { stated: true, untilMs: T0 + 120 * MIN } });
    const h2 = decideFailureHandling(db, config, c.job, c.run, { outcome: 'failed', cliOutput: "You've hit your limit" }, T0);
    expect(h2.handling).toMatchObject({ cooldown: { stated: false, untilMs: T0 + 30 * MIN } });
  });

  it('does not treat auth failures or generic errors as quota exhaustion', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db);
    const c = claimAt(db, config)!;
    for (const out of ['Not logged in · Please run /login', 'error: compile failed']) {
      expect(decideFailureHandling(db, config, c.job, c.run, { outcome: 'failed', error: 'x', cliOutput: out }, T0).handling).toBeUndefined();
    }
  });

  it('stops requeueing after maxDeferrals, so a limit cannot loop forever', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    const id = insertJob(db, { pool: 'only' });
    let at = T0;
    for (let i = 0; i < 3; i++) {
      const c = claimAt(db, config, at)!;
      expect(c).not.toBeNull();
      finish(db, config, c, LIMIT, at);
      at += 200 * MIN; // past every cooldown
    }
    const job = getJob(db, id)!;
    expect(job.status).toBe('failed');
    expect(job.statusReason).toMatch(/cap 2/);
    expect(listPolicyEvents(db, id).some((e) => e.kind === 'exhausted')).toBe(true);
  });

  it('a user cancel wins over requeueing', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db);
    const c = claimAt(db, config)!;
    db.prepare("INSERT INTO worker_lock (id, worker_id, pid, hostname, started_at, heartbeat_at) VALUES (1, 'wrk', 1, 'h', ?, ?)").run(
      new Date(T0).toISOString(),
      new Date(T0).toISOString(),
    );
    markExecutionStarted(db, c.run.id, { workerId: 'wrk', now: () => T0 });
    expect(requestJobCancel(db, c.job.id, () => T0).kind).toBe('requested');
    finish(db, config, c, LIMIT);
    expect(getJob(db, c.job.id)!.status).toBe('canceled');
  });
});

describe('escalation', () => {
  const REQUEST = 'updraft-escalation: {"reason":"migration-risk","requestedTier":"complex","evidence":"this needs a data migration"}';
  const noCommits = { commitCount: 0 } as never;

  it('moves a job to the stronger pool after a clean-exit request before any edit, as a new attempt', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db);
    const c = claimAt(db, config)!;
    finish(db, config, c, { outcome: 'succeeded', escalationRequest: REQUEST, summary: noCommits });
    const job = getJob(db, c.job.id)!;
    expect(job).toMatchObject({ status: 'queued', pool: 'deep' });
    expect(job.statusReason).toMatch(/escalated standard -> complex/);
    expect(jobCounters(db, job.id).escalationHops).toBe(1);
    expect(getRun(db, c.run.id)).toMatchObject({ outcome: 'failed' });
    const again = claimAt(db, config, T0 + MIN)!;
    expect(again.run.agent).toBe('codex');
    expect(again.run.attempt).toBe(2);
    // The new attempt has its own branch and worktree; the earlier ones stay as they were.
    const paths = { dataDir: 'D' };
    expect(jobBranchName(job, 2)).not.toBe(jobBranchName(job, 1));
    expect(jobWorktreePath(paths, job, 2)).not.toBe(jobWorktreePath(paths, job, 1));
  });

  it('never runs two attempts of one issue at once: the escalated job waits for the open run', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db);
    const c = claimAt(db, config)!;
    expect(claimAt(db, config)).toBeNull();
    finish(db, config, c, { outcome: 'failed', error: 'verification failed: "npm test" exited 1', summary: { verification: {} } as never });
    expect(claimAt(db, config, T0 + MIN)).not.toBeNull();
  });

  it('escalates after a failed verification without a request, once, then stops at the hop cap', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    const id = insertJob(db);
    const verify: Result = { outcome: 'failed', error: 'verification failed: "npm test" exited 1', summary: { verification: {} } as never };
    finish(db, config, claimAt(db, config)!, verify);
    expect(getJob(db, id)).toMatchObject({ status: 'queued', pool: 'deep' });
    finish(db, config, claimAt(db, config, T0 + MIN)!, verify, T0 + MIN);
    expect(getJob(db, id)!.status).toBe('failed');
    expect(listPolicyEvents(db, id).map((e) => e.kind)).toEqual(['escalated', 'escalation-denied']);
  });

  it('treats an ordinary failure, an invalid request and an after-edit request as plain outcomes', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    const bad = 'updraft-escalation: {"reason":"other","requestedTier":"complex","evidence":"long enough","pool":"deep"}';
    for (const result of [
      { outcome: 'failed', error: 'agent exited 1' },
      { outcome: 'failed', error: 'x', escalationRequest: bad },
      { outcome: 'succeeded', escalationRequest: REQUEST, summary: { commitCount: 2 } as never },
    ] as Result[]) {
      const id = insertJob(db);
      const c = claimAt(db, config)!;
      finish(db, config, c, result);
      expect(getJob(db, id)!.status).not.toBe('queued');
      expect(getJob(db, id)!.pool).toBe('std');
    }
  });

  it('is off unless the workflow configures it', () => {
    const db = openDatabase(':memory:');
    const base = makeConfig();
    const repo = base.repositories['owner/repo']!;
    const wf = repo.workflows[0]!;
    const config = { ...base, repositories: { 'owner/repo': { ...repo, workflows: [{ ...wf, tiers: { ...wf.tiers!, escalation: undefined } }] } } };
    insertJob(db);
    const c = claimAt(db, config)!;
    expect(decideFailureHandling(db, config, c.job, c.run, { outcome: 'succeeded', escalationRequest: REQUEST }, T0).handling).toBeUndefined();
  });
});
