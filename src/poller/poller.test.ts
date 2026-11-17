// In-memory GitHubApi fake, then the poller tests.
import { describe, expect, it } from 'vitest';
import { configSchema, type FactoryConfig, type FactoryConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { getCheckpoint, listQueuedJobs } from '../db/ingest.js';
import { silentLogger } from '../util/log.js';
import { EVENTS_PER_PAGE, OVERLAP_MS, backoffSeconds, checkJobDispatchable, pollOnce, type PollerDeps } from './poller.js';
import {
  GitHubError,
  type GitHubApi,
  type GitHubIssue,
  type GitHubIssueEvent,
  type GitHubLabel,
  type GitHubRepo,
  type IssueEventsPage,
} from '../github/api.js';
import type { RepoRef } from '../types.js';

interface FakeRepo {
  fullName: string;
  events: GitHubIssueEvent[];
  issues: Map<number, GitHubIssue & { gone?: number }>;
  version: number;
  fail: GitHubError | null;
}

class FakeGitHub implements GitHubApi {
  readonly repos = new Map<number, FakeRepo>();
  private nextEventId = 1000;
  clock = Date.parse('2026-01-01T00:00:00Z');
  /** Pages past this answer 422, like GitHub's pagination limit. */
  maxPages = Number.POSITIVE_INFINITY;
  readonly calls: Array<{ method: string; repoId?: number; arg?: unknown }> = [];

  addRepo(id: number, fullName: string): void {
    this.repos.set(id, { fullName, events: [], issues: new Map(), version: 0, fail: null });
  }

  private repo(id: number): FakeRepo {
    const r = this.repos.get(id);
    if (!r) throw new GitHubError(`repo ${id} not found`, 404);
    return r;
  }

  failRepo(id: number, err: GitHubError | null): void {
    this.repo(id).fail = err;
  }

  createIssue(repoId: number, number: number, opts: { labels?: string[]; isPullRequest?: boolean; title?: string } = {}): void {
    const r = this.repo(repoId);
    r.issues.set(number, {
      number,
      title: opts.title ?? `Issue ${number}`,
      body: `Body of issue ${number}`,
      htmlUrl: `https://github.com/${r.fullName}/issues/${number}`,
      state: 'open',
      labels: [...(opts.labels ?? [])],
      isPullRequest: opts.isPullRequest ?? false,
    });
    r.version++;
  }

  private pushEvent(repoId: number, number: number, event: string, extra: Partial<GitHubIssueEvent> = {}): GitHubIssueEvent {
    const r = this.repo(repoId);
    const issue = r.issues.get(number);
    this.clock += 1000;
    const ev: GitHubIssueEvent = {
      id: this.nextEventId++,
      event,
      createdAt: new Date(this.clock).toISOString(),
      actor: 'allen',
      label: null,
      issue: issue
        ? { number, title: issue.title, htmlUrl: issue.htmlUrl, isPullRequest: issue.isPullRequest }
        : { number, title: '?', htmlUrl: '?', isPullRequest: false },
      ...extra,
    };
    r.events.push(ev);
    r.version++;
    return ev;
  }

  label(repoId: number, number: number, label: string, actor = 'allen'): GitHubIssueEvent {
    const issue = this.repo(repoId).issues.get(number)!;
    if (!issue.labels.includes(label)) issue.labels.push(label);
    return this.pushEvent(repoId, number, 'labeled', { label, actor });
  }

  /** A labeled event inserted now (highest id) whose created_at is in the past. */
  labelAt(repoId: number, number: number, label: string, createdAtMs: number): GitHubIssueEvent {
    const issue = this.repo(repoId).issues.get(number)!;
    if (!issue.labels.includes(label)) issue.labels.push(label);
    const saved = this.clock;
    const ev = this.pushEvent(repoId, number, 'labeled', { label, actor: 'allen', createdAt: new Date(createdAtMs).toISOString() });
    this.clock = saved;
    return ev;
  }

  unlabel(repoId: number, number: number, label: string, actor = 'allen'): GitHubIssueEvent {
    const issue = this.repo(repoId).issues.get(number)!;
    issue.labels = issue.labels.filter((l) => l !== label);
    return this.pushEvent(repoId, number, 'unlabeled', { label, actor });
  }

  close(repoId: number, number: number): GitHubIssueEvent {
    this.repo(repoId).issues.get(number)!.state = 'closed';
    return this.pushEvent(repoId, number, 'closed');
  }

  /** Make getIssue fail with 404/410/301 (deleted or transferred). */
  makeGone(repoId: number, number: number, status = 404): void {
    this.repo(repoId).issues.get(number)!.gone = status;
  }

  noise(repoId: number, number: number, count: number): void {
    for (let i = 0; i < count; i++) this.pushEvent(repoId, number, 'mentioned');
  }

  private newestFirst(r: FakeRepo): GitHubIssueEvent[] {
    // Like GitHub: ordered by created_at desc, so ids are not monotonic in page order.
    return [...r.events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  }

  /** Like GitHub, the page-1 ETag reflects page 1's content only, not deeper pages. */
  private etag(r: FakeRepo, perPage: number): string {
    const ids = this.newestFirst(r)
      .slice(0, perPage)
      .map((e) => e.id);
    return `W/"${perPage}:${ids.join(',')}"`;
  }

  async getViewer() {
    return { login: 'allen', id: 1 };
  }

  async listUserRepos(): Promise<GitHubRepo[]> {
    return [];
  }

  async getRepo(fullName: string): Promise<GitHubRepo> {
    throw new GitHubError(`${fullName} not found`, 404);
  }

  async listLabels(_repo: RepoRef): Promise<GitHubLabel[]> {
    return [];
  }

  async listIssueEvents(repo: RepoRef, opts: { page: number; perPage?: number; etag?: string | null }): Promise<IssueEventsPage> {
    this.calls.push({ method: 'listIssueEvents', repoId: repo.id, arg: opts });
    const r = this.repo(repo.id);
    if (r.fail) throw r.fail;
    const perPage = opts.perPage ?? 30;
    if (opts.page === 1 && opts.etag && opts.etag === this.etag(r, perPage)) {
      return { events: [], nextPage: null, etag: opts.etag, notModified: true };
    }
    if (opts.page > this.maxPages) throw new GitHubError('pagination is limited for this resource', 422);
    const newestFirst = this.newestFirst(r);
    const start = (opts.page - 1) * perPage;
    const events = newestFirst.slice(start, start + perPage);
    return {
      events,
      nextPage: start + perPage < newestFirst.length ? opts.page + 1 : null,
      etag: this.etag(r, perPage),
      notModified: false,
    };
  }

  async getIssue(repo: RepoRef, issueNumber: number): Promise<GitHubIssue> {
    this.calls.push({ method: 'getIssue', repoId: repo.id, arg: issueNumber });
    const r = this.repo(repo.id);
    if (r.fail) throw r.fail;
    const issue = r.issues.get(issueNumber);
    if (!issue) throw new GitHubError(`issue ${issueNumber} not found`, 404);
    if (issue.gone) throw new GitHubError(`issue ${issueNumber} gone`, issue.gone);
    const { gone: _gone, ...rest } = issue;
    return { ...rest, labels: [...rest.labels] };
  }
}

// ---------------------------------------------------------------------------

const REPO = 101;
const OTHER = 202;
const READY = 'factory:ready';

function makeConfig(overrides: Partial<FactoryConfigInput> = {}, repoExtra: Record<string, unknown> = {}): FactoryConfig {
  return configSchema.parse({
    version: 1,
    dispatch: { allowedActors: ['allen'] },
    agents: { codex: {}, claude: {}, kiro: {} },
    pools: { art: { agents: ['codex'] }, general: { agents: ['claude', 'kiro'] } },
    actions: { 'implement-issue': { output: 'log' } },
    repositories: {
      'allen/kids': {
        id: REPO,
        workflows: [
          {
            trigger: { event: 'issue.labeled', label: READY },
            action: 'implement-issue',
            pool: { rules: [{ hasLabel: 'art', use: 'art' }], default: 'general' },
          },
        ],
        ...repoExtra,
      },
    },
    ...overrides,
  });
}

function setup(config: FactoryConfig = makeConfig()) {
  const gh = new FakeGitHub();
  for (const [name, repo] of Object.entries(config.repositories)) gh.addRepo(repo.id, name);
  const db = openDatabase(':memory:');
  let t = Date.parse('2026-02-01T00:00:00Z');
  const deps: PollerDeps = { db, api: gh, config, log: silentLogger, now: () => t, backoff: new Map() };
  const advance = (secs: number) => {
    t += secs * 1000;
  };
  return { gh, db, deps, advance };
}

/** First poll initializes the checkpoint at the current position (enqueues nothing). */
/** Clears the fake's recorded calls afterwards, so tests see only later polls. */
async function init(deps: PollerDeps) {
  const s = await pollOnce(deps);
  expect(s.repos.every((r) => r.ok)).toBe(true);
  (deps.api as FakeGitHub).calls.length = 0;
  return s;
}

interface JobRowLite {
  id: string;
  status: string;
  status_reason: string | null;
  pool: string;
  event_id: string;
  issue_number: number;
  workflow_id: string;
}

function allJobs(db: Db): JobRowLite[] {
  return db
    .prepare('SELECT id, status, status_reason, pool, event_id, issue_number, workflow_id FROM jobs ORDER BY rowid')
    .all() as unknown as JobRowLite[];
}

describe('pollOnce: subscription start', () => {
  it('first poll without backfill enqueues nothing and records the newest event id', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    const ev = gh.label(REPO, 1, READY);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 0 });
    expect(allJobs(db)).toHaveLength(0);
    expect(getCheckpoint(db, REPO)).toMatchObject({ lastEventId: ev.id, fullName: 'allen/kids' });
  });

  it('first poll on an empty repo, then later events are picked up', async () => {
    const { gh, db, deps } = setup();
    await init(deps);
    expect(getCheckpoint(db, REPO)?.lastEventId).toBeNull();
    gh.createIssue(REPO, 1);
    gh.label(REPO, 1, READY);
    const s = await pollOnce(deps);
    expect(s.repos[0]!.jobsEnqueued).toBe(1);
  });

  it('backfillSince enqueues matching events created at/after it', async () => {
    const config = makeConfig({}, { backfillSince: '2026-01-01T00:00:02.500Z' });
    const { gh, db, deps } = setup(config);
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    gh.label(REPO, 1, READY); // 00:00:01, before backfillSince
    gh.label(REPO, 2, 'bug'); // 00:00:02
    gh.label(REPO, 2, READY); // 00:00:03, after
    const s = await pollOnce(deps);
    expect(s.repos[0]!.jobsEnqueued).toBe(1);
    expect(allJobs(db).map((j) => j.issue_number)).toEqual([2]);
    // The checkpoint now exists, so backfill is not repeated.
    expect((await pollOnce(deps)).repos[0]!.jobsEnqueued).toBe(0);
    expect(allJobs(db)).toHaveLength(1);
    // A later scan's overlap reaches back over the pre-backfill label; it stays excluded.
    gh.noise(REPO, 2, 1);
    expect((await pollOnce(deps)).repos[0]!.jobsEnqueued).toBe(0);
    expect(allJobs(db).map((j) => j.issue_number)).toEqual([2]);
  });

  it('initial snapshot covers an existing higher-id label that sorts onto page 2', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    gh.createIssue(REPO, 3);
    gh.noise(REPO, 1, EVENTS_PER_PAGE); // page 1 at initialization
    // Already exists before the subscription: highest id, but older than all of page 1.
    const oldest = Date.parse(gh.repos.get(REPO)!.events[0]!.createdAt);
    const existing = gh.labelAt(REPO, 2, READY, oldest - 1000);
    await init(deps);
    expect(getCheckpoint(db, REPO)!.startEventId).toBe(existing.id);
    // Zero changes between polls: nothing is queued.
    expect((await pollOnce(deps)).repos[0]).toMatchObject({ ok: true, jobsEnqueued: 0 });
    // A genuinely new arrival still dispatches.
    const fresh = gh.label(REPO, 3, READY);
    expect((await pollOnce(deps)).repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(allJobs(db).map((j) => j.event_id)).toEqual([String(fresh.id)]);
  });

  it('never dispatches a label applied before the subscription started', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.label(REPO, 1, READY); // already labeled when the repo is added
    await init(deps);
    expect(getCheckpoint(db, REPO)!.startEventId).toBe(gh.repos.get(REPO)!.events.at(-1)!.id);
    gh.noise(REPO, 1, 1); // one unrelated event; the overlap now covers the old label
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 0 });
    expect(allJobs(db)).toHaveLength(0);
    // Re-applying the label after the subscription started does dispatch.
    gh.unlabel(REPO, 1, READY);
    gh.label(REPO, 1, READY);
    expect((await pollOnce(deps)).repos[0]!.jobsEnqueued).toBe(1);
  });
});

describe('pollOnce: dispatch and routing', () => {
  it('dispatch label with art present routes to the art pool', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1, { labels: ['art'] });
    await init(deps);
    const ev = gh.label(REPO, 1, READY);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, eventsSeen: 1, jobsEnqueued: 1 });
    const [job] = listQueuedJobs(db);
    expect(job).toMatchObject({
      pool: 'art',
      status: 'queued',
      repoId: REPO,
      repoFullName: 'allen/kids',
      eventId: String(ev.id),
      issueNumber: 1,
      action: 'implement-issue',
      workflowId: `implement-issue:${READY}`,
    });
    expect(job!.envelope).toEqual({
      schemaVersion: 1,
      type: 'issue.labeled',
      repo: { id: REPO, fullName: 'allen/kids' },
      issue: { number: 1, title: 'Issue 1', url: 'https://github.com/allen/kids/issues/1' },
      eventId: String(ev.id),
      url: 'https://github.com/allen/kids/issues/1',
      actor: 'allen',
      label: READY,
      labelsAtEnqueue: ['art', READY],
      createdAt: ev.createdAt,
    });
  });

  it('dispatch label without art routes to general', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1, { labels: ['bug'] });
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    expect(listQueuedJobs(db).map((j) => j.pool)).toEqual(['general']);
  });

  it('trigger label matching is case-insensitive', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, 'Factory:Ready');
    await pollOnce(deps);
    expect(listQueuedJobs(db)).toHaveLength(1);
  });

  it('adding art alone creates no job', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, 'art');
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ eventsSeen: 1, jobsEnqueued: 0 });
    expect(allJobs(db)).toHaveLength(0);
  });

  it('adding art after the job was queued does not change the queued job', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    gh.label(REPO, 1, 'art');
    await pollOnce(deps);
    expect(listQueuedJobs(db).map((j) => j.pool)).toEqual(['general']);
  });

  it('ignores labels applied by actors outside the allowlist (logins compared case-insensitively)', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    await init(deps);
    gh.label(REPO, 1, READY, 'mallory');
    gh.label(REPO, 2, READY, 'ALLEN');
    await pollOnce(deps);
    expect(allJobs(db).map((j) => j.issue_number)).toEqual([2]);
  });

  it('workflow allowedActors overrides the global allowlist', async () => {
    const config = makeConfig();
    config.repositories['allen/kids']!.workflows[0]!.allowedActors = ['bot'];
    const { gh, db, deps } = setup(config);
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    await init(deps);
    gh.label(REPO, 1, READY, 'allen');
    gh.label(REPO, 2, READY, 'bot');
    await pollOnce(deps);
    expect(allJobs(db).map((j) => j.issue_number)).toEqual([2]);
  });

  it('ignores pull requests', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 5, { isPullRequest: true });
    await init(deps);
    gh.label(REPO, 5, READY);
    await pollOnce(deps);
    expect(allJobs(db)).toHaveLength(0);
    expect(gh.calls.filter((c) => c.method === 'getIssue')).toHaveLength(0);
  });

  it('does not enqueue when the issue closed before the poll', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    gh.close(REPO, 1);
    await pollOnce(deps);
    expect(allJobs(db)).toHaveLength(0);
  });

  it('skips an event whose issue was deleted or transferred without failing the repo', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    gh.createIssue(REPO, 3);
    await init(deps);
    gh.label(REPO, 1, READY);
    gh.label(REPO, 2, READY);
    gh.label(REPO, 3, READY);
    gh.makeGone(REPO, 1, 404);
    gh.makeGone(REPO, 2, 301);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(allJobs(db).map((j) => j.issue_number)).toEqual([3]);
  });

  it('one event matching several workflows enqueues one job per workflow', async () => {
    const config = makeConfig();
    config.repositories['allen/kids']!.workflows.push({
      id: 'triage',
      trigger: { event: 'issue.labeled', label: READY },
      action: 'implement-issue',
      pool: 'general',
    });
    const { gh, db, deps } = setup(config);
    gh.createIssue(REPO, 1, { labels: ['art'] });
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    expect(allJobs(db).map((j) => [j.workflow_id, j.pool])).toEqual([
      [`implement-issue:${READY}`, 'art'],
      ['triage', 'general'],
    ]);
    // One issue fetch per issue per cycle; the re-check reuses the cycle cache.
    expect(gh.calls.filter((c) => c.method === 'getIssue')).toHaveLength(1);
  });

  it('processes events oldest to newest', async () => {
    const { gh, db, deps } = setup();
    for (const n of [1, 2, 3]) gh.createIssue(REPO, n);
    await init(deps);
    gh.label(REPO, 3, READY);
    gh.label(REPO, 1, READY);
    gh.label(REPO, 2, READY);
    await pollOnce(deps);
    expect(listQueuedJobs(db).map((j) => j.issueNumber)).toEqual([3, 1, 2]);
  });
});

describe('pollOnce: replay and re-dispatch', () => {
  it('replaying the same events after a crash does not duplicate jobs', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    const before = getCheckpoint(db, REPO)!;
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    expect(allJobs(db)).toHaveLength(1);
    // Simulate a restart from the older checkpoint, so the batch is fetched again.
    db.prepare('UPDATE repo_checkpoints SET last_event_id = ?, etag = NULL WHERE repo_id = ?').run(before.lastEventId, REPO);
    const s = await pollOnce({ ...deps, backoff: new Map() });
    expect(s.repos[0]).toMatchObject({ ok: true, eventsSeen: 1, jobsEnqueued: 0 });
    expect(allJobs(db)).toHaveLength(1);
  });

  it('removing and re-adding the label creates a second job', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    // Pretend the worker took the first job.
    db.prepare("UPDATE jobs SET status = 'running'").run();
    gh.unlabel(REPO, 1, READY);
    await pollOnce(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    const jobs = allJobs(db);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.event_id).not.toBe(jobs[1]!.event_id);
    expect(jobs.map((j) => j.status)).toEqual(['running', 'queued']);
  });

  it('remove + re-add within one cycle yields one job, from the latest application', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    gh.unlabel(REPO, 1, READY);
    const last = gh.label(REPO, 1, READY);
    await pollOnce(deps);
    expect(allJobs(db).map((j) => j.event_id)).toEqual([String(last.id)]);
  });
});

describe('pollOnce: queued job re-check', () => {
  it('cancels a queued job after the trigger label is removed', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    gh.unlabel(REPO, 1, READY);
    const s = await pollOnce(deps);
    expect(s.jobsCanceled).toBe(1);
    const [job] = allJobs(db);
    expect(job!.status).toBe('canceled');
    expect(job!.status_reason).toMatch(/no longer carries trigger label "factory:ready"/);
  });

  it('cancels a queued job when the issue closes', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    gh.close(REPO, 1);
    expect((await pollOnce(deps)).jobsCanceled).toBe(1);
    expect(allJobs(db)[0]).toMatchObject({ status: 'canceled', status_reason: 'issue #1 is closed' });
  });

  it('cancels a queued job whose workflow was removed from config and leaves running jobs alone', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    await init(deps);
    gh.label(REPO, 1, READY);
    gh.label(REPO, 2, READY);
    await pollOnce(deps);
    db.prepare("UPDATE jobs SET status = 'running' WHERE issue_number = 2").run();
    const config = makeConfig();
    config.repositories['allen/kids']!.workflows[0]!.id = 'renamed';
    const s = await pollOnce({ ...deps, config });
    expect(s.jobsCanceled).toBe(1);
    expect(allJobs(db).map((j) => [j.issue_number, j.status])).toEqual([
      [1, 'canceled'],
      [2, 'running'],
    ]);
    expect(allJobs(db)[0]!.status_reason).toMatch(/workflow "implement-issue:factory:ready" no longer exists/);
  });

  it('does not cancel when the re-check hits a transient API error', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    gh.failRepo(REPO, new GitHubError('boom', 502));
    const s = await pollOnce(deps);
    expect(s.jobsCanceled).toBe(0);
    expect(allJobs(db)[0]!.status).toBe('queued');
  });
});

describe('pollOnce: errors and paging', () => {
  it('API error keeps the checkpoint, records it, backs off, and other repos keep polling', async () => {
    const config = makeConfig();
    config.repositories['allen/other'] = { ...structuredClone(config.repositories['allen/kids']!), id: OTHER };
    const { gh, db, deps, advance } = setup(config);
    gh.createIssue(REPO, 1);
    gh.createIssue(OTHER, 1);
    await init(deps);
    const cp = getCheckpoint(db, REPO)!;
    gh.label(REPO, 1, READY);
    gh.label(OTHER, 1, READY);
    gh.failRepo(REPO, new GitHubError('GET /x failed: 500', 500));

    const s = await pollOnce(deps);
    expect(s.repos.find((r) => r.repo === 'allen/kids')).toMatchObject({ ok: false });
    expect(s.repos.find((r) => r.repo === 'allen/other')).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(getCheckpoint(db, REPO)).toEqual(cp);
    const errors = db.prepare('SELECT scope, repo_full_name, message FROM errors').all() as unknown as Array<Record<string, string>>;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ scope: 'poll', repo_full_name: 'allen/kids' });

    // Backing off: the failing repo is skipped on the next immediate cycle.
    gh.failRepo(REPO, null);
    const listCalls = () => gh.calls.filter((c) => c.method === 'listIssueEvents' && c.repoId === REPO).length;
    const n = listCalls();
    const s2 = await pollOnce(deps);
    expect(s2.repos.find((r) => r.repo === 'allen/kids')).toMatchObject({ ok: false, skipped: true });
    expect(listCalls()).toBe(n);

    // After the backoff window it recovers and catches up from the kept checkpoint.
    advance(backoffSeconds(1, null));
    const s3 = await pollOnce(deps);
    expect(s3.repos.find((r) => r.repo === 'allen/kids')).toMatchObject({ ok: true, jobsEnqueued: 1 });
  });

  it('honors retryAfterSeconds and caps exponential backoff', () => {
    expect(backoffSeconds(1, null)).toBe(30);
    expect(backoffSeconds(2, null)).toBe(60);
    expect(backoffSeconds(20, null)).toBe(900);
    expect(backoffSeconds(1, 3600)).toBe(3600);
  });

  it('a failing issue fetch (not 404/410/301) fails the repo and keeps the checkpoint', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    const cp = getCheckpoint(db, REPO);
    gh.label(REPO, 1, READY);
    gh.getIssue = async () => {
      throw new GitHubError('rate limited', 403, 60);
    };
    const s = await pollOnce(deps);
    expect(s.repos[0]!.ok).toBe(false);
    expect(getCheckpoint(db, REPO)).toEqual(cp);
    expect(deps.backoff!.get(REPO)!.until).toBe(deps.now!() + 60_000);
  });

  it('uses the stored ETag and does nothing on 304', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    const cp = getCheckpoint(db, REPO)!;
    expect(cp.etag).toMatch(/^W\//);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, eventsSeen: 0 });
    const last = gh.calls.filter((c) => c.method === 'listIssueEvents').at(-1)!;
    expect(last.arg).toMatchObject({ page: 1, etag: cp.etag });
    expect(getCheckpoint(db, REPO)!.updatedAt).toBe(cp.updatedAt);
  });

  it('pages back to the checkpoint across multiple pages', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    await init(deps);
    gh.label(REPO, 1, READY); // oldest new event, lands on page 3
    gh.noise(REPO, 1, 220);
    gh.label(REPO, 2, READY);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, eventsSeen: 222, jobsEnqueued: 2 });
    expect(listQueuedJobs(db).map((j) => j.issueNumber)).toEqual([1, 2]);
    const pages = gh.calls
      .filter((c) => c.method === 'listIssueEvents')
      .map((c) => (c.arg as { page: number }).page);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('finds a new event that sorts below an already-seen one across a page boundary', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    gh.noise(REPO, 1, 5);
    await init(deps);
    const seenAt = Date.parse(getCheckpoint(db, REPO)!.lastEventCreatedAt!);
    // 99 newer events fill page 1 together with the newest already-seen event...
    gh.noise(REPO, 1, 99);
    // ...and a label inserted now (highest id) but created 2s before that event sorts onto page 2.
    const late = gh.labelAt(REPO, 2, READY, seenAt - 2000);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(listQueuedJobs(db).map((j) => j.eventId)).toEqual([String(late.id)]);
    const pages = gh.calls
      .filter((c) => c.method === 'listIssueEvents')
      .map((c) => (c.arg as { page: number }).page);
    expect(pages).toEqual([1, 2]);
  });

  it('fetches page 1 unconditionally when the overlap extends past page 1', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    gh.noise(REPO, 1, 150); // 150s of events: page 1 alone does not reach the 5-minute boundary
    await init(deps);
    expect(getCheckpoint(db, REPO)!.page1CoversOverlap).toBe(false);
    // A delayed label whose created_at sorts onto page 2; page 1 (and its ETag) is unchanged.
    const events = gh.repos.get(REPO)!.events;
    const late = gh.labelAt(REPO, 2, READY, Date.parse(events[30]!.createdAt) + 500);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(listQueuedJobs(db).map((j) => j.eventId)).toEqual([String(late.id)]);
    const calls = gh.calls.filter((c) => c.method === 'listIssueEvents');
    expect(calls.map((c) => (c.arg as { page: number }).page)).toEqual([1, 2]);
    expect(calls[0]!.arg).toMatchObject({ etag: null }); // no 304 shortcut while the overlap spans pages
  });

  it('does not treat an exactly full single page as the whole stream', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    gh.noise(REPO, 1, EVENTS_PER_PAGE); // exactly one full page at initialization
    await init(deps);
    expect(getCheckpoint(db, REPO)!.page1CoversOverlap).toBe(false);
    // A late label one second older than everything: it alone starts page 2, page 1 is unchanged.
    const oldest = Date.parse(gh.repos.get(REPO)!.events[0]!.createdAt);
    const late = gh.labelAt(REPO, 2, READY, oldest - 1000);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(listQueuedJobs(db).map((j) => j.eventId)).toEqual([String(late.id)]);
  });

  it('does not revive a superseded label when the overlap spans pages', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY); // old application; ends up on page 2
    gh.noise(REPO, 1, 120);
    gh.unlabel(REPO, 1, READY); // removal and reapplication land on page 1
    const reapplied = gh.label(REPO, 1, READY);
    const first = await pollOnce(deps);
    expect(first.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(getCheckpoint(db, REPO)!.page1CoversOverlap).toBe(false);
    // Nothing new. The next scan must still see page 1's removal next to page 2's old application.
    const second = await pollOnce(deps);
    expect(second.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 0 });
    expect(allJobs(db).map((j) => j.event_id)).toEqual([String(reapplied.id)]);
  });

  it('ends the cycle on a page-1 304 when page 1 already covers the overlap', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.noise(REPO, 1, 5);
    await init(deps);
    expect(getCheckpoint(db, REPO)!.page1CoversOverlap).toBe(true);
    await pollOnce(deps);
    const pages = gh.calls
      .filter((c) => c.method === 'listIssueEvents')
      .map((c) => (c.arg as { page: number }).page);
    expect(pages).toEqual([1]);
  });

  it('stops once events are older than the overlap window', async () => {
    const { gh, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.noise(REPO, 1, 400); // 400s of history before the checkpoint
    await init(deps);
    gh.noise(REPO, 1, 150);
    await pollOnce(deps);
    const pages = gh.calls
      .filter((c) => c.method === 'listIssueEvents')
      .map((c) => (c.arg as { page: number }).page);
    // 150 new + OVERLAP_MS of rescanned history (1 event/s in the fake) fits in 5 pages, not 6.
    expect(OVERLAP_MS).toBe(300_000);
    expect(pages).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads a long backlog back to the checkpoint in one pass', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.noise(REPO, 1, 1);
    await init(deps);
    gh.label(REPO, 1, READY); // oldest new event, on page 16
    gh.noise(REPO, 1, 1500);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM errors').get()).toEqual({ n: 0 });
    const newest = gh.repos.get(REPO)!.events.at(-1)!.id;
    expect(getCheckpoint(db, REPO)!.lastEventId).toBe(newest);
  });

  it('keeps the checkpoint when the backlog scan fails partway, then recovers', async () => {
    const { gh, db, deps, advance } = setup();
    gh.createIssue(REPO, 1);
    gh.noise(REPO, 1, 1);
    await init(deps);
    const before = getCheckpoint(db, REPO)!;
    gh.label(REPO, 1, READY);
    gh.noise(REPO, 1, 1500);
    // Transient failure on page 6 of 16.
    const original = gh.listIssueEvents.bind(gh);
    gh.listIssueEvents = async (repo, opts) => {
      if (opts.page === 6) throw new GitHubError('server error', 502);
      return original(repo, opts);
    };
    const failed = await pollOnce(deps);
    expect(failed.repos[0]).toMatchObject({ ok: false });
    expect(getCheckpoint(db, REPO)).toMatchObject({ lastEventId: before.lastEventId, etag: before.etag });
    expect(listQueuedJobs(db)).toHaveLength(0);

    gh.listIssueEvents = original;
    advance(3600);
    const ok = await pollOnce(deps);
    expect(ok.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
  });

  it("records an error and advances only when GitHub can't serve older events", async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.noise(REPO, 1, 1);
    await init(deps);
    gh.label(REPO, 1, READY); // on page 5, past GitHub's limit below
    gh.noise(REPO, 1, 400);
    gh.maxPages = 3;
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 0 });
    const errors = db.prepare('SELECT message FROM errors').all() as unknown as Array<{ message: string }>;
    expect(errors[0]!.message).toMatch(/GitHub stopped serving issue events at page 4.*may have been missed/);
    const newest = gh.repos.get(REPO)!.events.at(-1)!.id;
    expect(getCheckpoint(db, REPO)!.lastEventId).toBe(newest);
  });

  it('falls back to the id boundary plus one page for checkpoints without a stored time', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.createIssue(REPO, 2);
    gh.noise(REPO, 1, 5);
    await init(deps);
    db.prepare('UPDATE repo_checkpoints SET last_event_created_at = NULL').run();
    const seenAt = Date.parse(gh.repos.get(REPO)!.events.at(-1)!.createdAt);
    gh.noise(REPO, 1, 99);
    gh.labelAt(REPO, 2, READY, seenAt - 2000);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    expect(getCheckpoint(db, REPO)!.lastEventCreatedAt).not.toBeNull();
  });
});

describe('checkJobDispatchable', () => {
  it('reports ok, label removal, closure, and missing repo config', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    const [job] = listQueuedJobs(db);
    expect(await checkJobDispatchable(deps, job!)).toEqual({
      ok: true,
      issue: {
        title: 'Issue 1',
        body: 'Body of issue 1',
        labels: [READY],
        url: 'https://github.com/allen/kids/issues/1',
      },
    });

    gh.unlabel(REPO, 1, READY);
    expect(await checkJobDispatchable(deps, job!)).toMatchObject({ ok: false, reason: expect.stringMatching(/trigger label/) });

    gh.label(REPO, 1, READY);
    gh.close(REPO, 1);
    expect(await checkJobDispatchable(deps, job!)).toEqual({ ok: false, reason: 'issue #1 is closed' });

    const config = makeConfig({ repositories: {} });
    expect(await checkJobDispatchable({ api: gh, config }, job!)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no longer configured/),
    });
  });

  it('rejects on transient API errors instead of reporting not-dispatchable', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    await init(deps);
    gh.label(REPO, 1, READY);
    await pollOnce(deps);
    const [job] = listQueuedJobs(db);
    gh.failRepo(REPO, new GitHubError('bad gateway', 502));
    await expect(checkJobDispatchable(deps, job!)).rejects.toBeInstanceOf(GitHubError);
  });
});
