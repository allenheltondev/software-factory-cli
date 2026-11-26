// The local control state machine against a real state database.
import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { activeControlPause, getControlPause, resumeWorkflow } from '../db/control.js';
import { openDatabase, type Db } from '../db/database.js';
import { getLoopPr, observeHead } from '../db/pr-reviews.js';
import { getJob } from '../db/queue.js';
import { syncRevisionPrs } from '../db/revisions.js';
import { reviewOf, revisionOf } from '../types.js';
import { applyLocalControl, holdPausedJob, pauseProblem, resumeIsElevated, type LocalControlRequest } from './local.js';

const REPO = { id: 42, fullName: 'octo/widgets' };
const ISSUE = 7;
const PR = 100;
const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const PUSHED = 'b'.repeat(40);

const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function makeConfig(): UpdraftConfig {
  return configSchema.parse({
    version: 1,
    execution: { mode: 'live' },
    dispatch: { allowedActors: ['allen'] },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompt.md', revisePrompt: './revise.md' } },
    repositories: {
      [REPO.fullName]: {
        id: REPO.id,
        checkoutPath: './clone',
        publish: 'draft-pr',
        revise: true,
        review: true,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
      },
    },
  });
}

/** An issue whose job published PR #100 at HEAD. */
function world(opts: { pr?: boolean } = {}) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const config = makeConfig();
  const cfg = config.repositories[REPO.fullName]!;
  let clock = T0;
  const now = () => (clock += 1000);
  const jobId = insertQueuedJob(db, { repoId: REPO.id, fullName: REPO.fullName, issue: ISSUE });
  if (opts.pr !== false) {
    const at = new Date(T0).toISOString();
    db.prepare("UPDATE jobs SET status = 'succeeded', attempts = 1 WHERE id = ?").run(jobId);
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome)
       VALUES ('run_original', ?, 1, 'general', 'claude', 'wrk_1', ?, ?, ?, 'succeeded')`,
    ).run(jobId, at, at, at);
    db.prepare(
      `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, base_branch, pr_number, pr_url,
                                 attempts, created_at, updated_at, published_at)
       VALUES ('run_original', ?, ?, ?, ?, 'draft-pr', 'published', ?, 'main', ?, ?, 1, ?, ?, ?)`,
    ).run(jobId, REPO.id, REPO.fullName, ISSUE, `updraft/issue-${ISSUE}-${jobId}`, PR, `https://github.com/${REPO.fullName}/pull/${PR}`, at, at, at);
    syncRevisionPrs(db, REPO.id);
    observeHead(db, REPO.id, PR, HEAD, at);
  }
  let seq = 0;
  const run = (command: LocalControlRequest['command'], over: Partial<LocalControlRequest> = {}) =>
    applyLocalControl(db, config, {
      command, repo: REPO, cfg, issue: ISSUE, pullRequest: opts.pr === false ? null : PR, headSha: opts.pr === false ? null : HEAD, subjectState: 'open',
      actor: 'allen', source: String(1000 + ++seq), url: `https://github.com/${REPO.fullName}/pull/${PR}#issuecomment-${seq}`, text: '', target: null, authority: 'maintain', ...over,
    }, now);
  /** A running job under a live worker (so a cancel request is recorded, not stale). */
  const running = (id = insertQueuedJob(db, { repoId: REPO.id, fullName: REPO.fullName, issue: ISSUE })) => {
    const at = new Date(clock).toISOString();
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(id);
    db.prepare(`INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at) VALUES (?, ?, 1, 'general', 'claude', 'wrk_live', ?, ?)`)
      .run(`run_${id}`, id, new Date(clock + 3_600_000).toISOString(), at);
    db.prepare(`INSERT OR REPLACE INTO worker_lock (id, worker_id, pid, hostname, started_at, heartbeat_at) VALUES (1, 'wrk_live', 1, 'h', ?, ?)`).run(at, new Date(T0 + 10_000_000).toISOString());
    return id;
  };
  return { db, config, cfg, run, running, jobId, now, setClock: (t: number) => (clock = t) };
}

describe('pause and resume', () => {
  it('pause holds queued work, gates new work, and resume puts back exactly what it held', () => {
    const w = world();
    const queued = insertQueuedJob(w.db, { repoId: REPO.id, fullName: REPO.fullName, issue: ISSUE });
    const other = insertQueuedJob(w.db, { repoId: REPO.id, fullName: REPO.fullName, issue: 8 });
    const paused = w.run('pause');
    expect(paused.outcome).toBe('applied');
    expect(getJob(w.db, queued)!.status).toBe('canceled');
    expect(getJob(w.db, other)!.status).toBe('queued');

    // Work queued while paused is held by the gate.
    const later = insertQueuedJob(w.db, { repoId: REPO.id, fullName: REPO.fullName, issue: ISSUE });
    const problem = pauseProblem(w.db, getJob(w.db, later)!);
    expect(problem).toMatch(/paused by allen/);
    expect(holdPausedJob(w.db, getJob(w.db, later)!, problem!)).toBe(true);
    expect(activeControlPause(w.db, REPO.id, ISSUE)!.held).toEqual([queued, later]);

    // A second pause changes nothing.
    expect(w.run('pause').outcome).toBe('noop');

    const resumed = w.run('resume');
    expect(resumed.outcome).toBe('applied');
    expect(getJob(w.db, queued)!.status).toBe('queued');
    expect(getJob(w.db, later)!.status).toBe('queued');
    expect(getControlPause(w.db, REPO.id, ISSUE)).toMatchObject({ state: 'resumed', resumedBy: 'allen' });
    // A duplicate resume finds nothing paused and requeues nothing.
    expect(w.run('resume')).toMatchObject({ outcome: 'noop' });
  });

  it('pause says what is still running instead of claiming it stopped', () => {
    const w = world();
    const active = w.running();
    const res = w.run('pause');
    expect(res.message).toContain(`Still running: job ${active}`);
    expect(getJob(w.db, active)!.status).toBe('running');
  });

  it('resume after a human push reviews the new head and drops nothing it should not', () => {
    const w = world();
    w.run('pause');
    const res = w.run('resume', { headSha: PUSHED });
    expect(res.message).toContain(`current head ${PUSHED.slice(0, 12)}`);
    expect(getLoopPr(w.db, REPO.id, PR)!.headSha).toBe(PUSHED);
    const reviews = w.db.prepare("SELECT id FROM jobs WHERE status = 'queued'").all() as Array<{ id: string }>;
    expect(reviews.map((r) => reviewOf(getJob(w.db, r.id)!)?.headSha)).toEqual([PUSHED]);
  });

  it('refuses to resume a closed issue or merged pull request', () => {
    const w = world();
    w.run('pause');
    expect(w.run('resume', { subjectState: 'merged' })).toMatchObject({ outcome: 'refused' });
    expect(activeControlPause(w.db, REPO.id, ISSUE)).not.toBeNull();
  });
});

describe('stop and cancel', () => {
  it('stops the one running job, pauses, and resume after the stop requeues it', () => {
    const w = world();
    const active = w.running();
    const res = w.run('stop');
    expect(res.outcome).toBe('applied');
    expect(res.message).toContain(`Stopping job ${active}`);
    const run = w.db.prepare('SELECT cancel_requested_at FROM runs WHERE job_id = ?').get(active) as { cancel_requested_at: string | null };
    expect(run.cancel_requested_at).not.toBeNull();
    expect(resumeIsElevated(w.db, REPO.id, ISSUE)).toBe(true);
    // Still stopping: resume waits.
    expect(w.run('resume')).toMatchObject({ outcome: 'refused' });
    // The worker ends it as canceled; resume now requeues it.
    w.db.prepare("UPDATE jobs SET status = 'canceled' WHERE id = ?").run(active);
    expect(w.run('resume')).toMatchObject({ outcome: 'applied' });
    expect(getJob(w.db, active)!.status).toBe('queued');
  });

  it('a duplicate stop does not request twice', () => {
    const w = world();
    w.running();
    w.run('stop');
    expect(w.run('stop').message).toContain('already requested');
  });

  it('reports no active job, and ambiguity, without stopping anything', () => {
    const w = world();
    expect(w.run('stop')).toMatchObject({ outcome: 'noop' });
    expect(activeControlPause(w.db, REPO.id, ISSUE)).toBeNull();
    const a = w.running();
    const b = insertQueuedJob(w.db, { repoId: REPO.id, fullName: REPO.fullName, issue: ISSUE });
    w.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(b);
    const res = w.run('stop');
    expect(res.outcome).toBe('ambiguous');
    expect(res.message).toContain(a);
    expect(activeControlPause(w.db, REPO.id, ISSUE)).toBeNull();
    expect(w.run('stop', { target: a })).toMatchObject({ outcome: 'applied' });
    expect(w.run('stop', { target: 'job_unknown1' })).toMatchObject({ outcome: 'refused' });
  });

  it('cancel holds queued work and asks the running job to stop, keeping the pull request', () => {
    const w = world();
    const queued = insertQueuedJob(w.db, { repoId: REPO.id, fullName: REPO.fullName, issue: ISSUE });
    const active = w.running();
    const res = w.run('cancel');
    expect(res.outcome).toBe('applied');
    expect(getJob(w.db, queued)!.status).toBe('canceled');
    expect(activeControlPause(w.db, REPO.id, ISSUE)).toMatchObject({ kind: 'cancel', held: [queued, active] });
    expect(getLoopPr(w.db, REPO.id, PR)!.state).toBe('open');
  });

  it('checks the authority against the pause it lifts, inside the resume', () => {
    const w = world();
    w.run('pause');
    // Decided as a plain pause by the caller; a cancel lands before the resume runs.
    const before = activeControlPause(w.db, REPO.id, ISSUE)!;
    w.run('cancel');
    const after = activeControlPause(w.db, REPO.id, ISSUE)!;
    expect(after.kind).toBe('cancel');
    // The upgrade changed the pause's identity: a resume of the earlier one lifts nothing.
    expect(after.at).not.toBe(before.at);
    expect(resumeWorkflow(w.db, REPO.id, ISSUE, before, 'pat')).toBeNull();
    expect(w.run('resume', { actor: 'pat', authority: 'write' })).toMatchObject({ outcome: 'refused', message: expect.stringContaining('needs maintain') });
    expect(activeControlPause(w.db, REPO.id, ISSUE)).not.toBeNull();
    expect(w.run('resume', { authority: 'maintain' })).toMatchObject({ outcome: 'applied' });
  });

  it('lets write access lift a plain pause', () => {
    const w = world();
    w.run('pause');
    expect(w.run('resume', { actor: 'pat', authority: 'write' })).toMatchObject({ outcome: 'applied' });
  });

  it('a stop after a pause makes the resume need maintain', () => {
    const w = world();
    w.run('pause');
    expect(resumeIsElevated(w.db, REPO.id, ISSUE)).toBe(false);
    w.running();
    w.run('stop');
    expect(activeControlPause(w.db, REPO.id, ISSUE)!.kind).toBe('stop');
  });
});

describe('review and steer', () => {
  it('reviews the current head again, once per command', () => {
    const w = world();
    const first = w.run('review', { source: 'c1' });
    expect(first.outcome).toBe('applied');
    expect(w.run('review', { source: 'c1' }).outcome).toBe('noop');
    expect(w.run('review', { source: 'c2' }).outcome).toBe('applied');
    const jobs = (w.db.prepare("SELECT id FROM jobs WHERE status = 'queued'").all() as Array<{ id: string }>).map((r) => getJob(w.db, r.id)!);
    expect(jobs.map((j) => reviewOf(j)?.headSha)).toEqual([HEAD, HEAD]);
  });

  it('will not review while paused, without a pull request, or on a merged one', () => {
    const w = world();
    w.run('pause');
    expect(w.run('review')).toMatchObject({ outcome: 'refused' });
    expect(world({ pr: false }).run('review')).toMatchObject({ outcome: 'refused' });
    expect(world().run('review', { subjectState: 'merged' })).toMatchObject({ outcome: 'refused' });
  });

  it('turns steering into a change request for the next coding run, under the revision budget', () => {
    const w = world();
    const res = w.run('steer', { text: 'Keep the existing API and add a regression test.', source: 's1' });
    expect(res.outcome).toBe('applied');
    const job = (w.db.prepare("SELECT id FROM jobs WHERE status = 'queued'").all() as Array<{ id: string }>).map((r) => getJob(w.db, r.id)!)[0]!;
    expect(revisionOf(job)).toMatchObject({ trigger: 'changes_requested', review: { id: 'steer:s1', author: 'allen', body: 'Keep the existing API and add a regression test.' } });
    expect(w.run('steer', { text: 'again', source: 's1' }).outcome).toBe('noop');
    expect(w.run('steer', { text: '' })).toMatchObject({ outcome: 'refused' });
  });

  it('holds steering given while paused for the resume', () => {
    const w = world();
    w.run('pause');
    const res = w.run('steer', { text: 'Use the new client.' });
    expect(res.message).toContain('once resumed');
    const held = activeControlPause(w.db, REPO.id, ISSUE)!.held;
    expect(held).toHaveLength(1);
    w.run('resume');
    expect(getJob(w.db, held[0]!)!.status).toBe('queued');
  });

  it('says escalation is not available yet, changing nothing', () => {
    expect(world().run('escalate')).toMatchObject({ outcome: 'unsupported' });
  });
});
