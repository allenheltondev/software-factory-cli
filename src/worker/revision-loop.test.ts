// The revision loop end to end, wired the way `updraft start` wires it: the real poller, the
// real worker, the live executor driving the fake agent, and the revision push, against real git
// and an in-memory GitHub. A review goes in; a fast-forwarded PR branch and one reply come out.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter } from '../../test/fake-adapter.js';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { registerAdapter } from '../agents/adapters/registry.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { getJob, getRun, latestRunOfJob } from '../db/queue.js';
import { getRevision } from '../db/revisions.js';
import type { GitHubApi, GitHubIssue, GitHubIssueComment, GitHubIssueEvent, GitHubReview, IssueEventsPage, PullRequestReviews, PullRequestUpdatesPage } from '../github/api.js';
import { resolvePaths, type UpdraftPaths } from '../paths.js';
import { checkJobDispatchable, pollOnce } from '../poller/poller.js';
import { createRevisionPublisher, revisionMarker } from '../publish/revision.js';
import { revisionOf, type RepoRef } from '../types.js';
import { silentLogger } from '../util/log.js';
import { runDaemon } from './daemon.js';
import { createExecutor } from './prepare-only.js';

const REPO_ID = 42;
const FULL = 'octo/widgets';
const PR = 100;
const ISSUE = 7;

const fixtures: GitFixture[] = [];
const dbs: Db[] = [];
const restores: Array<() => void> = [];
beforeEach(() => {
  restores.push(registerAdapter(fakeAdapter({ name: 'claude' })));
});
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r();
  for (const db of dbs.splice(0)) db.close();
  for (const f of fixtures.splice(0)) f.cleanup();
});

/** The parts of GitHub the loop touches. Anything else it called would be a bug. */
class FakeGitHub {
  updatedAt = '2026-11-18T12:00:00Z';
  state: 'open' | 'closed' = 'open';
  reviews: GitHubReview[] = [];
  comments: Array<GitHubIssueComment & { issue: number }> = [];
  readonly writes: string[] = [];
  private version = 0;
  issueEvents: GitHubIssueEvent[] = [];

  constructor(readonly headRef: string) {}

  requestChanges(body: string): GitHubReview {
    this.version++;
    this.updatedAt = new Date(Date.parse(this.updatedAt) + 60_000).toISOString();
    const review: GitHubReview = {
      id: `PRR_${this.version}`,
      state: 'CHANGES_REQUESTED',
      author: 'allen',
      submittedAt: this.updatedAt,
      body,
      url: `https://github.com/${FULL}/pull/${PR}#pullrequestreview-${this.version}`,
      lastEditedAt: null,
      editor: null,
      comments: [],
      commentCount: 0,
    };
    this.reviews.push(review);
    return review;
  }

  async listIssueEvents(): Promise<IssueEventsPage> {
    return { events: [], nextPage: null, etag: null, notModified: false };
  }
  async listPullRequestUpdates(_repo: RepoRef, opts: { etag?: string | null }): Promise<PullRequestUpdatesPage> {
    const etag = `W/"${this.version}"`;
    if (opts.etag === etag) return { pulls: [], nextPage: null, etag, notModified: true };
    return { pulls: [{ number: PR, state: this.state, merged: false, updatedAt: this.updatedAt }], nextPage: null, etag, notModified: false };
  }
  async getPullRequestReviews(): Promise<PullRequestReviews> {
    return { number: PR, state: this.state, merged: false, updatedAt: this.updatedAt, headRef: this.headRef, headSha: '0'.repeat(40), reviews: this.reviews };
  }
  async getIssue(): Promise<GitHubIssue> {
    return { number: ISSUE, title: 'Add a widget', body: 'Please add a widget.', htmlUrl: `https://github.com/${FULL}/issues/${ISSUE}`, state: 'open', labels: ['updraft:ready'], isPullRequest: false };
  }
  async listEventsForIssue(): Promise<GitHubIssueEvent[]> {
    return this.issueEvents;
  }
  async getIssueBodyEdit() {
    return { lastEditedAt: null, editor: null };
  }
  async listIssueComments(_repo: RepoRef, issue: number): Promise<GitHubIssueComment[]> {
    return this.comments.filter((c) => c.issue === issue);
  }
  async createIssueComment(_repo: RepoRef, issue: number, body: string): Promise<GitHubIssueComment> {
    this.writes.push(`comment #${issue}`);
    const c = { id: this.comments.length + 1, htmlUrl: `https://github.com/${FULL}/pull/${issue}#issuecomment-${this.comments.length + 1}`, body, user: 'allen', issue };
    this.comments.push(c);
    return c;
  }

  get api(): GitHubApi {
    return new Proxy(this, {
      get(target, prop) {
        // Not a thenable: an awaited api must resolve to itself.
        if (prop in target || prop === 'then' || typeof prop === 'symbol') return Reflect.get(target, prop, target) as unknown;
        return () => {
          throw new Error(`the revision loop must not call ${String(prop)}`);
        };
      },
    }) as unknown as GitHubApi;
  }
}

function setup() {
  const f = createGitFixture(FULL);
  fixtures.push(f);
  const paths: UpdraftPaths = resolvePaths({ env: { UPDRAFT_HOME: join(f.root, 'updraft home') } });
  mkdirSync(join(paths.configDir, 'prompts'), { recursive: true });
  writeFileSync(join(paths.configDir, 'prompts', 'implement.md'), 'Implement the issue below.\n');
  writeFileSync(join(paths.configDir, 'prompts', 'revise.md'), 'Address the review below. Commit your work.\n');
  const emptyGitConfig = join(f.root, 'agent gitconfig');
  writeFileSync(emptyGitConfig, '');
  const config: UpdraftConfig = configSchema.parse({
    version: 1,
    pollIntervalSeconds: 10,
    execution: { mode: 'live' },
    agents: {
      claude: {
        command: process.execPath,
        args: ['--mode', 'success'],
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: emptyGitConfig,
          GIT_AUTHOR_NAME: 'Fake Agent',
          GIT_AUTHOR_EMAIL: 'agent@example.com',
          GIT_COMMITTER_NAME: 'Fake Agent',
          GIT_COMMITTER_EMAIL: 'agent@example.com',
        },
      },
    },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement.md', revisePrompt: './prompts/revise.md', timeoutMinutes: 2 } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: relative(paths.configDir, f.clone),
        remote: 'origin',
        baseBranch: 'main',
        publish: 'draft-pr',
        revise: true,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
      },
    },
  });
  const db = openDatabase(':memory:');
  dbs.push(db);

  // The issue job that already ran and was published as PR #100.
  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: ISSUE });
  const prBranch = `updraft/issue-${ISSUE}-${jobId}`;
  const published = f.pushCommit(prBranch, 'widget.txt', 'a widget\n');
  const at = '2026-11-18T11:00:00.000Z';
  db.prepare("UPDATE jobs SET status = 'succeeded', attempts = 1 WHERE id = ?").run(jobId);
  db.prepare(
    `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome)
     VALUES ('run_original', ?, 1, 'general', 'claude', 'wrk_0', ?, ?, ?, 'succeeded')`,
  ).run(jobId, at, at, at);
  db.prepare(
    `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, base_branch, head_sha, pr_number, pr_url,
                               attempts, created_at, updated_at, published_at)
     VALUES ('run_original', ?, ?, ?, ?, 'draft-pr', 'published', ?, 'main', ?, ?, ?, 1, ?, ?, ?)`,
  ).run(jobId, REPO_ID, FULL, ISSUE, prBranch, published, PR, `https://github.com/${FULL}/pull/${PR}`, at, at, at);
  const gh = new FakeGitHub(prBranch);
  gh.issueEvents = [{ id: Number(getJob(db, jobId)!.eventId), event: 'labeled', createdAt: at, actor: 'allen', label: 'updraft:ready', issue: null }];
  return { f, paths, config, db, gh, prBranch, published };
}

const remoteHead = (f: GitFixture, branch: string) => f.git(f.root, 'ls-remote', f.remoteDir, `refs/heads/${branch}`).split(/\s+/)[0] ?? '';

describe('the revision loop, end to end', { timeout: 120_000 }, () => {
  it('turns a change request into commits on the PR branch and one reply, and nothing else', async () => {
    const { f, paths, config, db, gh, prBranch, published } = setup();
    const review = gh.requestChanges('Please also add a FAKE_AGENT.md.');
    const api = gh.api;
    const controller = new AbortController();
    const done = runDaemon({
      db,
      config,
      paths,
      log: silentLogger,
      signal: controller.signal,
      executor: createExecutor(config),
      poll: () => pollOnce({ db, api, config, log: silentLogger }),
      checkDispatchable: (job) => checkJobDispatchable({ api, config }, job),
      publisher: createRevisionPublisher({
        db,
        config,
        paths,
        api,
        log: silentLogger,
        token: async () => {
          throw new Error('a local remote needs no token');
        },
      }),
      hostname: hostname(),
      pid: process.pid,
    });
    const revisionJobId = () => (db.prepare("SELECT id FROM jobs WHERE event_id LIKE 'review:%'").get() as { id: string } | undefined)?.id;
    await vi.waitFor(
      () => {
        const id = revisionJobId();
        const run = id ? latestRunOfJob(db, id) : null;
        expect(run && getRevision(db, run.id)?.state).toBe('published');
      },
      { timeout: 90_000, interval: 100 },
    );
    controller.abort();
    await done;

    const job = getJob(db, revisionJobId()!)!;
    expect(job).toMatchObject({ status: 'succeeded', eventId: `review:${review.id}`, issueNumber: ISSUE });
    expect(revisionOf(job)?.review.body).toBe('Please also add a FAKE_AGENT.md.');
    const run = getRun(db, latestRunOfJob(db, job.id)!.id)!;
    expect(run.outcome).toBe('succeeded');

    // The PR branch moved forward by exactly the agent's commit; main did not move.
    const head = remoteHead(f, prBranch);
    expect(head).not.toBe(published);
    f.git(f.clone, 'fetch', '--quiet', 'origin', prBranch);
    expect(f.git(f.clone, 'rev-parse', `${head}~1`)).toBe(published);
    expect(f.git(f.clone, 'log', '-1', '--format=%s', head)).toBe('fake agent: implement the issue');
    expect(remoteHead(f, 'main')).toBe(f.git(f.clone, 'rev-parse', 'origin/main'));
    // The revision's own local branch was never pushed under its own name.
    expect(remoteHead(f, run.summary!.branch)).toBe('');
    expect(getRevision(db, run.id)).toMatchObject({ state: 'published', baseSha: published, headSha: head, prNumber: PR, reviewId: review.id });

    // One write to GitHub in all: the reply on the PR.
    expect(gh.writes).toEqual([`comment #${PR}`]);
    expect(gh.comments[0]!.body).toContain(revisionMarker(run.id));
    expect(gh.comments[0]!.body).toContain('pushed 1 commit(s)');

    // The agent got the revise prompt and the review, in the worktree made from the PR head.
    const prompt = readFileSync(join(paths.runsDir, run.id, 'prompt.md'), 'utf8');
    expect(prompt.startsWith('Address the review below. Commit your work.\n')).toBe(true);
    expect(prompt).toContain('<untrusted-review-body>\nPlease also add a FAKE_AGENT.md.\n</untrusted-review-body>');
    expect(prompt).toContain('<untrusted-issue-body>\nPlease add a widget.\n</untrusted-issue-body>');
    expect(existsSync(join(run.checkoutPath!, 'widget.txt'))).toBe(true);
    const log = readFileSync(run.logPath!, 'utf8');
    expect(log).toContain(`revision: pushing ${published.slice(0, 12)}..${head.slice(0, 12)} (1 commit(s)) to ${prBranch}`);
  });
});
