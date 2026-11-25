import { describe, expect, it } from 'vitest';
import { History, HOUR, MIN, routingRows } from '../../test/factory-history.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { migrate, openDatabase } from './database.js';
import { noteJobRetried, noteRouteDecided, noteRunSelected, routeSourceOf } from './metrics.js';
import { retryJob } from './queue.js';
import { computeStats, MIN_SAMPLE, rate } from './stats.js';
import { commitPollBatch, type NewJob } from './ingest.js';
import { ENVELOPE_SCHEMA_VERSION, type RoutingDecision } from '../types.js';

const END = Date.parse('2026-11-18T12:00:00.000Z');
const WINDOW = { since: null, now: END, label: 'all' };
const REPO = { repoId: 42, fullName: 'octo/widgets' };

const config: UpdraftConfig = configSchema.parse({
  version: 1,
  maxConcurrent: 10,
  agents: {
    'claude-fast': { adapter: 'claude', model: 'haiku', effort: 'low', maxConcurrent: 5 },
    'claude-deep': { adapter: 'claude', model: 'opus', effort: 'high', maxConcurrent: 5 },
    codex: { maxConcurrent: 5 },
  },
  pools: { fast: { agents: ['claude-fast'] }, deep: { agents: ['claude-deep'] }, plain: { agents: ['codex'] }, reviewers: { agents: ['codex'] } },
  actions: { 'implement-issue': {} },
  dispatch: { allowedActors: ['allen'] },
  repositories: {
    'octo/widgets': {
      id: 42,
      review: { pool: 'reviewers' },
      workflows: [
        {
          id: 'wf',
          trigger: { event: 'issue.labeled', label: 'updraft:ready' },
          action: 'implement-issue',
          pool: 'plain',
          tiers: { pools: { routine: 'fast', standard: 'plain', complex: 'deep' } },
        },
      ],
    },
  },
});

const routed = (tier: NonNullable<RoutingDecision['tier']>, pool: string, extra: Partial<RoutingDecision> = {}): RoutingDecision => ({
  rule: 'heuristic',
  tier,
  pool,
  risk: 'low',
  confidence: 0.8,
  detail: 'free text that must not be stored',
  ...extra,
});

function history(): History {
  const h = new History(END - 5 * HOUR);
  h.config = config;
  return h;
}

const queue = (h: History, issue: number, routing: RoutingDecision) => h.queueIssue({ ...REPO, issue, pool: routing.pool, routing });

describe('run selection facts', () => {
  it('records the profile, adapter, configured model and effort, and the routing decision, once per run', () => {
    const h = history();
    queue(h, 1, routed('routine', 'fast', { rule: 'override-label' }));
    const { runId } = h.run({ runMs: 5 * MIN });
    const [route] = routingRows(h.db).filter((r) => r.kind === 'route.decided');
    expect(route).toBeUndefined(); // queueIssue inserts directly, not through a poll batch
    const sel = routingRows(h.db).filter((r) => r.kind === 'run.selected');
    expect(sel).toEqual([
      expect.objectContaining({
        subject_id: runId,
        agent: 'claude-fast',
        adapter: 'claude',
        model: 'haiku',
        effort: 'low',
        model_source: 'configured',
        tier: 'routine',
        requested_tier: 'routine',
        risk: 'low',
        route_source: 'override',
        hops: 0,
        retries: 0,
        job_kind: 'implement',
      }),
    ]);
    // A replay records nothing more.
    const job = h.db.prepare('SELECT * FROM jobs').get() as never;
    noteRunSelected(h.db, config, job, { id: runId, agent: 'claude-fast', pool: 'fast', started_at: h.iso() });
    expect(routingRows(h.db).filter((r) => r.kind === 'run.selected')).toHaveLength(1);
  });

  it('says unknown when the profile names no model, and never keeps free text or odd values', () => {
    const h = history();
    queue(h, 1, routed('standard', 'plain'));
    h.run({});
    expect(routingRows(h.db)).toEqual([expect.objectContaining({ adapter: 'codex', model: null, effort: null, model_source: 'unknown', route_source: 'local-rule' })]);
    expect(JSON.stringify(routingRows(h.db))).not.toMatch(/free text/);
    const odd = configSchema.parse({ ...config, agents: { ...config.agents, codex: { model: '/home/me/.secret/model', maxConcurrent: 1 } } });
    const h2 = new History(END - HOUR);
    h2.config = odd;
    h2.queueIssue({ ...REPO, issue: 1, pool: 'plain' });
    h2.run({});
    expect(routingRows(h2.db)[0]).toMatchObject({ model: null });
  });

  it('records the tier the router chose when several tiers share its pool (#140)', () => {
    const h = history();
    h.config = configSchema.parse({
      ...config,
      repositories: { 'octo/widgets': { ...config.repositories['octo/widgets']!, workflows: [{ ...config.repositories['octo/widgets']!.workflows[0]!, tiers: { pools: { routine: 'plain', standard: 'plain', complex: 'plain' } } }] } },
    });
    queue(h, 1, routed('complex', 'plain'));
    h.run({});
    expect(routingRows(h.db).find((r) => r.kind === 'run.selected')).toMatchObject({ tier: 'complex', requested_tier: 'complex' });
  });

  it('keeps the tier a retry or escalation resolved to, and counts retries once', () => {
    const h = history();
    const jobId = queue(h, 1, routed('routine', 'fast'));
    h.run({ outcome: 'failed', verify: false });
    retryJob(h.db, jobId, h.now);
    const job = h.db.prepare('SELECT * FROM jobs').get() as never;
    noteJobRetried(h.db, { ...(job as object), retries: 1 } as never, h.iso()); // replay
    h.run({ outcome: 'succeeded', verify: true });
    const rows = routingRows(h.db);
    expect(rows.filter((r) => r.kind === 'job.retried')).toEqual([expect.objectContaining({ subject_id: `${jobId}:1`, retries: 1 })]);
    expect(rows.filter((r) => r.kind === 'run.selected').map((r) => r.retries)).toEqual([0, 1]);
  });

  it('records an escalation, and attributes the job to the tier that ended it', () => {
    const h = history();
    const jobId = queue(h, 1, routed('routine', 'fast'));
    h.run({
      outcome: 'failed',
      verify: false,
      handling: { kind: 'escalate', fromTier: 'routine', toTier: 'complex', pool: 'deep', reason: 'free text reason', source: 'verification' },
    });
    const { runId } = h.run({ outcome: 'succeeded', verify: true });
    const rows = routingRows(h.db);
    expect(rows.filter((r) => r.kind === 'job.escalated')).toEqual([
      expect.objectContaining({ subject_id: `${jobId}:1`, tier: 'complex', requested_tier: 'routine', reason: 'verification', agent: 'claude-fast', hops: 1 }),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/free text/);
    expect(rows.find((r) => r.kind === 'run.selected' && r.subject_id === runId)).toMatchObject({ tier: 'complex', requested_tier: 'routine', hops: 1, model: 'opus' });

    const { overall } = computeStats(h.db, WINDOW);
    const t = overall.routing.byTier;
    // The success is complex's (flagged as reached by escalation); the failed run is routine's.
    expect(t.complex).toMatchObject({ jobs: 1, success: { count: 1, of: 1 }, escalatedIn: { jobs: 1, succeeded: 1 }, verificationFailures: 0 });
    expect(t.routine).toMatchObject({ jobs: 0, escalatedOut: 1, verificationFailures: 1 });
    expect(overall.routing.byProfile['claude-deep']).toMatchObject({ jobs: 1 });
    expect(overall.routing.byProfile['claude-fast']).toMatchObject({ jobs: 0, verificationFailures: 1, escalatedOut: 1 });
  });

  it('records usage-limit cooldowns and deferrals as pressure, not as token use', () => {
    const h = history();
    queue(h, 1, routed('standard', 'plain'));
    const until = h.t + 90 * MIN;
    h.run({
      outcome: 'failed',
      handling: { kind: 'usage-limit', cooldown: { scope: 'agent', name: 'codex', untilMs: until, stated: true }, maxDeferrals: 2, detail: 'You have hit your limit for alice@example.com' },
    });
    const { overall } = computeStats(h.db, WINDOW);
    expect(overall.pressure).toEqual({
      cooldowns: { count: 1, totalMs: 90 * MIN, byName: { codex: { count: 1, totalMs: 90 * MIN, stated: 1 } } },
      deferrals: { count: 1, byAgent: { codex: 1 } },
      unavailable: { startFailedRuns: 0, byAgent: {} },
      tokenUsage: { reported: false },
    });
    expect(JSON.stringify(routingRows(h.db))).not.toMatch(/alice|hit your limit/);
  });
});

describe('route decisions at enqueue', () => {
  it('records the decision with a code for the reason, never its text', () => {
    const h = history();
    const jobId = queue(h, 1, routed('standard', 'plain', { uncertain: true, detail: 'secret detail' }));
    // The poller path: commitPollBatch calls noteRouteDecided for each inserted job.
    const row = h.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as { envelope: string };
    noteRouteDecided(h.db, { id: jobId, repoId: 42, repoFullName: 'octo/widgets', envelope: row.envelope, at: h.iso() });
    noteRouteDecided(h.db, { id: jobId, repoId: 42, repoFullName: 'octo/widgets', envelope: row.envelope, at: h.iso() });
    expect(routingRows(h.db)).toEqual([expect.objectContaining({ kind: 'route.decided', subject_id: jobId, reason: 'low-confidence', route_source: 'local-rule', tier: 'standard', confidence: 0.8 })]);
    expect(JSON.stringify(routingRows(h.db))).not.toMatch(/secret detail/);
    const { overall } = computeStats(h.db, WINDOW);
    expect(overall.routing.decisions).toMatchObject({ total: 1, bySource: { 'local-rule': 1 }, byTier: { standard: 1 }, triageFallbacks: 0 });
  });

  it('records a decision for each job a poll batch inserts, once even when the batch is replayed', () => {
    const db = openDatabase(':memory:');
    const job = (eventId: string, routing?: RoutingDecision): NewJob => ({
      repoId: 7,
      repoFullName: 'o/r',
      workflowId: 'wf',
      eventId,
      issueNumber: 1,
      action: 'a',
      pool: 'general',
      envelope: {
        schemaVersion: ENVELOPE_SCHEMA_VERSION,
        type: 'issue.labeled',
        repo: { id: 7, fullName: 'o/r' },
        issue: { number: 1, title: 'Private title', url: 'u' },
        eventId,
        url: 'u',
        actor: 'allen',
        label: 'updraft:ready',
        labelsAtEnqueue: [],
        createdAt: '2026-01-01T00:00:00Z',
        ...(routing ? { routing } : {}),
      },
    });
    const batch = { repoId: 7, fullName: 'o/r', lastEventId: 2, etag: null, jobs: [job('1', routed('complex', 'deep', { rule: 'triage', triage: { origin: 'cli', agent: 'a', reason: 'secret reason' } })), job('2')] };
    commitPollBatch(db, batch);
    commitPollBatch(db, batch);
    const rows = routingRows(db);
    expect(rows).toHaveLength(1); // the job without a tier-routing decision has nothing to record
    expect(rows[0]).toMatchObject({ kind: 'route.decided', tier: 'complex', route_source: 'cli-triage', reason: 'triage-answered' });
    expect(JSON.stringify(rows)).not.toMatch(/secret reason|Private title/);
  });

  it('tells a triage fallback from a local rule and from a triage answer', () => {
    expect(routeSourceOf({ rule: 'heuristic', triage: { origin: 'fallback' } })).toBe('fallback');
    expect(routeSourceOf({ rule: 'triage', triage: { origin: 'cli' } })).toBe('cli-triage');
    expect(routeSourceOf({ rule: 'heuristic' })).toBe('local-rule');
    expect(routeSourceOf({ rule: 'override-label' })).toBe('override');
    expect(routeSourceOf(null)).toBeNull();
  });
});

describe('review results by tier', () => {
  it('attributes review rounds and head changes to the tier that wrote the PR, and filters by repository', () => {
    const h = history();
    queue(h, 1, routed('routine', 'fast'));
    const first = h.run({ runMs: 10 * MIN, verify: true });
    h.publish(first.runId, { ...REPO, issue: 1, pr: 7, delay: MIN });
    h.review({ ...REPO, pr: 7, verdict: 'changes-requested', findings: 2, revise: true });
    const other = { repoId: 43, fullName: 'octo/other' };
    h.queueIssue({ ...other, issue: 1, pool: 'plain' });

    const heads = h.db.prepare("SELECT head_sha FROM metric_events WHERE kind = 'review.verdict'").all() as Array<{ head_sha: string | null }>;
    expect(heads).toEqual([{ head_sha: expect.stringMatching(/^sha_/) }]);

    const all = computeStats(h.db, WINDOW);
    const routine = all.overall.routing.byTier.routine!;
    expect(routine).toMatchObject({ jobs: 1, prsOpened: 1, reviewed: 1, changesRequested: 1, reviewReady: { count: 0, of: 1 } });
    // The reviewer's verdict, by the model its run was selected with.
    expect(all.overall.review.byModel).toEqual({
      'codex/cli-default': {
        adapter: 'codex',
        model: null,
        effort: null,
        runs: 1,
        readyToMerge: 0,
        changesRequested: 1,
        failed: 0,
        findings: { total: 2, withCount: 1, average: 2 },
      },
    });
    expect(all.overall.daily).toEqual([
      { day: '2026-11-18', jobsSucceeded: 2, jobsFailed: 0, prsOpened: 1, prsMerged: 0, reviews: 1, changesRequested: 1, findings: 2, revisions: 0 },
    ]);
    const one = computeStats(h.db, { ...WINDOW, repo: 'octo/other' });
    expect(one.overall.routing.byTier).toEqual({});
    expect(computeStats(h.db, { ...WINDOW, repo: 'OCTO/widgets' }).overall.routing.byTier.routine).toMatchObject({ jobs: 1 });
  });
});

describe('old data', () => {
  it('reads a database from before schema v16: runs without selection data are unknown, not an error', () => {
    const h = new History(END - 5 * HOUR);
    h.queueIssue({ ...REPO, issue: 1 });
    h.run({ runMs: MIN });
    // Downgrade to v15: the routing columns and facts are gone.
    h.db.exec("DELETE FROM metric_events WHERE kind IN ('run.selected','route.decided','job.retried')");
    for (const c of ['tier', 'requested_tier', 'risk', 'adapter', 'model', 'effort', 'model_source', 'route_source', 'confidence', 'hops', 'retries', 'head_sha']) {
      h.db.exec(`ALTER TABLE metric_events DROP COLUMN ${c}`);
    }
    h.db.exec('PRAGMA user_version = 15');
    const before = computeStats(h.db, WINDOW).overall;
    expect(before.routing.byTier).toMatchObject({ unknown: { jobs: 1, success: { count: 1, of: 1 }, smallSample: true } });
    expect(before.routing.byProfile).toMatchObject({ claude: { jobs: 1 } });
    expect(before.routing.byModel).toMatchObject({ unknown: { jobs: 1, modelSource: 'unknown' } });
    // The migration is additive and idempotent.
    migrate(h.db);
    expect(computeStats(h.db, WINDOW).overall.routing.byTier.unknown).toMatchObject({ jobs: 1 });
  });

  it('opens a database without a state file as empty routing and pressure sections', () => {
    const report = computeStats(null, WINDOW);
    expect(report.overall.routing).toMatchObject({ decisions: { total: 0 }, byTier: {}, byProfile: {}, byModel: {} });
    expect(report.overall.pressure.tokenUsage).toEqual({ reported: false });
    openDatabase(':memory:').close();
  });
});

describe('uncertainty', () => {
  it('reports a Wilson interval and flags small samples', () => {
    expect(rate(0, 0)).toEqual({ count: 0, of: 0, rate: null, low: null, high: null });
    const r = rate(9, 10);
    expect(r.rate).toBe(0.9);
    expect(r.low!).toBeGreaterThan(0.55);
    expect(r.low!).toBeLessThan(0.6);
    expect(r.high!).toBeGreaterThan(0.97);
    expect(rate(100, 100).high).toBeCloseTo(1, 10);
    expect(MIN_SAMPLE).toBe(20);
  });
});
