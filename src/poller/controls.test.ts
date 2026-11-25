// Mention commands through the poller, against an in-memory GitHub.
import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import type { RepoPermission } from '../control/commands.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { activeControlPause, getControlCommand, listControlCommands } from '../db/control.js';
import { openDatabase, type Db } from '../db/database.js';
import { observeHead } from '../db/pr-reviews.js';
import { getJob } from '../db/queue.js';
import { syncRevisionPrs } from '../db/revisions.js';
import { GitHubError, type GitHubApi, type GitHubIssue, type GitHubIssueComment, type PullRequestDetails, type RepoIssueComment } from '../github/api.js';
import type { WorkerIdentity } from '../github/credentials.js';
import { silentLogger } from '../util/log.js';
import { checkJobDispatchable, pollOnce } from './poller.js';

const REPO_ID = 42;
const FULL = 'octo/widgets';
const ISSUE = 7;
const PR = 100;
const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const HEAD = 'a'.repeat(40);

class FakeGitHub {
  clock = T0;
  comments: RepoIssueComment[] = [];
  posted: Array<{ issue: number; body: string }> = [];
  permissions: Record<string, RepoPermission | null> = { allen: 'write', olive: 'admin', mallory: 'admin' };
  pr = { state: 'open' as 'open' | 'closed', merged: false, headSha: HEAD };
  issueState: 'open' | 'closed' = 'open';
  failPr = false;
  private seq = 0;

  comment(user: string, body: string, over: Partial<RepoIssueComment> = {}): RepoIssueComment {
    this.clock += 1000;
    const at = new Date(this.clock).toISOString();
    const id = 9000 + ++this.seq;
    const onPr = over.onPullRequest ?? true;
    const n = over.issueNumber ?? (onPr ? PR : ISSUE);
    const c: RepoIssueComment = {
      id, body, user, userType: user.endsWith('[bot]') ? 'Bot' : 'User', issueNumber: n, onPullRequest: onPr, createdAt: at, updatedAt: at,
      htmlUrl: `https://github.com/${FULL}/${onPr ? 'pull' : 'issues'}/${n}#issuecomment-${id}`, ...over,
    };
    this.comments.push(c);
    return c;
  }

  async getWorkerIdentity(): Promise<WorkerIdentity> {
    return { kind: 'app', login: 'updraft-app[bot]', appSlug: 'updraft-app' } as WorkerIdentity;
  }
  async listRepoIssueComments(_r: unknown, o: { since: string }) {
    return { comments: this.comments.filter((c) => c.updatedAt >= o.since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)), nextPage: null };
  }
  permissionLookups: string[] = [];
  async getRepoPermission(_r: unknown, login: string) {
    this.permissionLookups.push(login);
    const p = this.permissions[login];
    if (p === undefined) throw new GitHubError('boom', 502);
    return p;
  }
  async getPullRequest(): Promise<PullRequestDetails> {
    if (this.failPr) throw new GitHubError('unavailable', 502);
    return { number: PR, state: this.pr.state, merged: this.pr.merged, headSha: this.pr.headSha } as PullRequestDetails;
  }
  async getIssue(): Promise<GitHubIssue> {
    return { number: ISSUE, title: 'Issue 7', body: '', htmlUrl: '', state: this.issueState, labels: ['updraft:ready'], isPullRequest: false };
  }
  async createIssueComment(_r: unknown, issue: number, body: string): Promise<GitHubIssueComment> {
    this.posted.push({ issue, body });
    return { id: 1 + this.posted.length, htmlUrl: '', body, user: 'updraft-app[bot]' };
  }
  async getPullRequestReviews() {
    return { number: PR, state: this.pr.state, merged: this.pr.merged, updatedAt: new Date(T0).toISOString(), headRef: 'x', headSha: this.pr.headSha, reviews: [] };
  }
  async listIssueEvents() {
    return { events: [], nextPage: null, etag: null, notModified: false };
  }
  async listPullRequestUpdates() {
    return { pulls: [], nextPage: null, etag: null, notModified: true };
  }
  get api(): GitHubApi {
    return this as unknown as GitHubApi;
  }
}

const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function makeConfig(controls = true): UpdraftConfig {
  return configSchema.parse({
    version: 1,
    execution: { mode: 'live' },
    dispatch: { allowedActors: ['allen', 'olive'] },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompt.md', revisePrompt: './revise.md' } },
    ...(controls ? { controls: { enabled: true } } : {}),
    repositories: {
      [FULL]: {
        id: REPO_ID, checkoutPath: './clone', publish: 'draft-pr', revise: true,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
      },
    },
  });
}

async function world(config = makeConfig()) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const gh = new FakeGitHub();
  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: ISSUE });
  const at = new Date(T0).toISOString();
  db.prepare("UPDATE jobs SET status = 'succeeded', attempts = 1 WHERE id = ?").run(jobId);
  db.prepare(`INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome) VALUES ('run_original', ?, 1, 'general', 'claude', 'wrk_1', ?, ?, ?, 'succeeded')`).run(jobId, at, at, at);
  db.prepare(
    `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, base_branch, pr_number, pr_url, attempts, created_at, updated_at, published_at)
     VALUES ('run_original', ?, ?, ?, ?, 'draft-pr', 'published', ?, 'main', ?, ?, 1, ?, ?, ?)`,
  ).run(jobId, REPO_ID, FULL, ISSUE, `updraft/issue-${ISSUE}-${jobId}`, PR, `https://github.com/${FULL}/pull/${PR}`, at, at, at);
  syncRevisionPrs(db, REPO_ID);
  observeHead(db, REPO_ID, PR, HEAD, at);
  const poll = () => pollOnce({ db, api: gh.api, config, log: silentLogger, now: () => gh.clock });
  gh.comment('allen', '@updraft-app pause'); // before the poller ever looked: history
  await poll();
  return { db, gh, poll };
}

describe('mention commands', () => {
  it('never acts on comments from before it first looked', async () => {
    const w = await world();
    await w.poll();
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).toBeNull();
    expect(w.gh.posted).toEqual([]);
  });

  it('pauses on an allowed actor’s mention, replies once, and ignores the redelivery', async () => {
    const w = await world();
    const c = w.gh.comment('allen', '@updraft-app pause — waiting on design');
    const queued = insertQueuedJob(w.db, { repoId: REPO_ID, fullName: FULL, issue: ISSUE });
    await w.poll();
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).toMatchObject({ kind: 'pause', by: 'allen', source: String(c.id) });
    expect(getJob(w.db, queued)!.status).toBe('canceled');
    expect(w.gh.posted).toHaveLength(1);
    expect(w.gh.posted[0]!.body).toMatch(/^<!-- updraft-control:\d+ -->\n@allen Paused #7/);
    expect(getControlCommand(w.db, REPO_ID, String(c.id))).toMatchObject({ outcome: 'applied', actor: 'allen', command: 'pause', replyId: 2 });
    // The same comment read again (overlapping `since`, a restart): nothing more.
    await w.poll();
    await w.poll();
    expect(w.gh.posted).toHaveLength(1);
    expect(listControlCommands(w.db, REPO_ID, ISSUE)).toHaveLength(1);
  });

  it('ignores an actor who is not allowed: no permission lookup, no reply, no state', async () => {
    const w = await world();
    const c = w.gh.comment('mallory', '@updraft-app cancel');
    await w.poll();
    expect(w.gh.permissionLookups).toEqual([]);
    expect(w.gh.posted).toEqual([]);
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).toBeNull();
    expect(getControlCommand(w.db, REPO_ID, String(c.id))).toMatchObject({ outcome: 'ignored', message: 'not_allowed' });
    w.gh.comment('allen', '@updraft-app pause');
    await w.poll();
    expect(w.gh.permissionLookups).toEqual(['allen']);
    expect(w.gh.posted).toHaveLength(1);
  });

  it('refuses stop without maintain, and when the permission cannot be read', async () => {
    const w = await world();
    w.gh.comment('allen', '@updraft-app stop');
    w.gh.permissions.olive = undefined as unknown as RepoPermission;
    w.gh.comment('olive', '@updraft-app cancel');
    await w.poll();
    expect(w.gh.posted.map((p) => p.body)).toEqual([expect.stringContaining('needs maintain or admin'), expect.stringContaining('could not confirm your access')]);
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).toBeNull();
  });

  it('ignores bots, its own replies, quoted and edited commands, and unmanaged subjects', async () => {
    const w = await world();
    w.gh.comment('helper[bot]', '@updraft-app pause');
    w.gh.comment('allen', '> @updraft-app pause');
    w.gh.comment('allen', '<!-- updraft-control:1 -->\n@updraft-app pause');
    const edited = w.gh.comment('allen', '@updraft-app pause');
    edited.updatedAt = new Date(Date.parse(edited.createdAt) + 5000).toISOString();
    w.gh.comment('allen', '@updraft-app pause', { onPullRequest: true, issueNumber: 555 });
    w.gh.comment('allen', '@updraft-app pause', { onPullRequest: false, issueNumber: 556 });
    await w.poll();
    expect(w.gh.posted).toEqual([]);
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).toBeNull();
  });

  it('answers an unknown command with help naming the real handle', async () => {
    const w = await world();
    w.gh.comment('allen', '@updraft-app merge it please');
    await w.poll();
    expect(w.gh.posted[0]!.body).toContain('`@updraft-app resume`');
    expect(w.gh.posted[0]!.body).toContain('not a command I know');
  });

  it('refuses resume on a merged pull request', async () => {
    const w = await world();
    w.gh.comment('allen', '@updraft-app pause');
    await w.poll();
    w.gh.pr = { state: 'closed', merged: true, headSha: HEAD };
    w.gh.comment('allen', '@updraft-app resume');
    await w.poll();
    expect(w.gh.posted[1]!.body).toContain('is merged, so there is nothing to resume');
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).not.toBeNull();
  });

  it('a resume on the issue lifts a pause given on its pull request', async () => {
    const w = await world();
    w.gh.comment('allen', '@updraft-app pause');
    await w.poll();
    w.gh.comment('allen', '@updraft-app resume', { onPullRequest: false });
    await w.poll();
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).toBeNull();
    expect(w.gh.posted[1]).toMatchObject({ issue: ISSUE, body: expect.stringContaining('Resumed #7') });
  });

  it('keeps a command whose subject could not be read for the next cycle', async () => {
    const w = await world();
    w.gh.comment('allen', '@updraft-app pause');
    w.gh.failPr = true;
    const first = await w.poll();
    expect(first.repos[0]!.ok).toBe(false);
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).toBeNull();
  });

  it('reads no comments when controls are off', async () => {
    const config = makeConfig(false);
    const w = await world(config);
    w.gh.comment('allen', '@updraft-app pause');
    await w.poll();
    expect(activeControlPause(w.db, REPO_ID, ISSUE)).toBeNull();
  });

  it('the pre-start check holds a paused workflow’s job', async () => {
    const w = await world();
    w.gh.comment('allen', '@updraft-app pause');
    await w.poll();
    const job = getJob(w.db, insertQueuedJob(w.db, { repoId: REPO_ID, fullName: FULL, issue: ISSUE }))!;
    const check = await checkJobDispatchable({ api: w.gh.api, config: makeConfig(), db: w.db }, job);
    expect(check).toMatchObject({ ok: false, reason: expect.stringContaining('paused by allen') });
    expect(activeControlPause(w.db, REPO_ID, ISSUE)!.held).toContain(job.id);
  });
});
