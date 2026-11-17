// In-memory GitHubApi fake, then the poller tests.
import { describe, expect, it } from 'vitest';
import { configSchema, type FactoryConfig, type FactoryConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { getCheckpoint, listQueuedJobs } from '../db/ingest.js';
import { silentLogger } from '../util/log.js';
import { MAX_PAGES, backoffSeconds, checkJobDispatchable, pollOnce, type PollerDeps } from './poller.js';
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

  private etag(r: FakeRepo): string {
    return `W/"v${r.version}"`;
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
    if (opts.page === 1 && opts.etag && opts.etag === this.etag(r)) {
      return { events: [], nextPage: null, etag: opts.etag, notModified: true };
    }
    const perPage = opts.perPage ?? 30;
    const newestFirst = [...r.events].reverse();
    const start = (opts.page - 1) * perPage;
    const events = newestFirst.slice(start, start + perPage);
    return {
      events,
      nextPage: start + perPage < newestFirst.length ? opts.page + 1 : null,
      etag: this.etag(r),
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
async function init(deps: PollerDeps) {
  const s = await pollOnce(deps);
  expect(s.repos.every((r) => r.ok)).toBe(true);
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
      .slice(1)
      .map((c) => (c.arg as { page: number }).page);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('records an error when the page cap is hit but still advances', async () => {
    const { gh, db, deps } = setup();
    gh.createIssue(REPO, 1);
    gh.noise(REPO, 1, 1); // non-null starting checkpoint
    await init(deps);
    gh.noise(REPO, 1, MAX_PAGES * 100 + 5);
    gh.label(REPO, 1, READY);
    const s = await pollOnce(deps);
    expect(s.repos[0]).toMatchObject({ ok: true, jobsEnqueued: 1 });
    const errors = db.prepare('SELECT message FROM errors').all() as unknown as Array<{ message: string }>;
    expect(errors[0]!.message).toMatch(/may have been missed/);
    const newest = gh.repos.get(REPO)!.events.at(-1)!.id;
    expect(getCheckpoint(db, REPO)!.lastEventId).toBe(newest);
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
    expect(await checkJobDispatchable(deps, job!)).toEqual({ ok: true });

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
