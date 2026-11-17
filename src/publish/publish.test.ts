import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { publishCommand } from '../commands/publish.js';
import { fakeContext } from '../commands/fakes.js';
import { configSchema, type FactoryConfig, type FactoryConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { getPublication } from '../db/publications.js';
import { getJob } from '../db/queue.js';
import { GitError, runGit, type GitOptions } from '../git/git.js';
import { jobBranchName, jobWorktreePath, prepareJobWorktree } from '../git/worktree.js';
import {
  GitHubError,
  type CreatePullRequestInput,
  type GitHubApi,
  type GitHubIssueComment,
  type GitHubPullRequest,
} from '../github/api.js';
import type { FactoryPaths } from '../paths.js';
import type { RepoRef, RunOutcome } from '../types.js';
import { silentLogger } from '../util/log.js';
import { summarizeRun } from '../worker/run-summary.js';
import {
  createPublisher,
  PUBLISH_ATTEMPT_SECONDS,
  PUBLISH_LEASE_SECONDS,
  publicationMarker,
  publishGitEnv,
  publishRun,
  redactSecret,
  renderPrBody,
  type PublishDeps,
  type RunGit,
} from './publish.js';

const REPO_ID = 42;
const FULL = 'octo/widgets';
const TOKEN = 'ghp_SECRETtoken0123456789';
const T0 = Date.parse('2026-11-17T12:00:00.000Z');

/** GitHub's side of publication, in memory. Optionally checks that a PR's head is on the bare remote. */
class FakePublishApi implements GitHubApi {
  pulls: Array<GitHubPullRequest & { title: string }> = [];
  comments: GitHubIssueComment[] = [];
  readonly calls: string[] = [];
  draftsRefused = false;
  /** Errors to throw on the next call of a method (consumed once). */
  failNext: Partial<Record<'createPullRequest' | 'createIssueComment' | 'listIssueComments' | 'listPullRequestsForHead', GitHubError>> = {};
  /** Create the PR, then fail as if the response was lost. */
  loseNextPullResponse = false;
  private nextId = 1;

  constructor(private readonly remoteHas?: (branch: string) => boolean) {}

  private maybeFail(name: keyof FakePublishApi['failNext']): void {
    const err = this.failNext[name];
    if (err) {
      delete this.failNext[name];
      throw err;
    }
  }

  async getViewer() {
    return { login: 'allen', id: 1 };
  }
  async listUserRepos(): Promise<never[]> {
    return [];
  }
  async getRepo(): Promise<never> {
    throw new Error('not used');
  }
  async listLabels(): Promise<never[]> {
    return [];
  }
  async listIssueEvents(): Promise<never> {
    throw new Error('not used');
  }
  async getIssue(): Promise<never> {
    throw new Error('not used');
  }
  async listEventsForIssue(): Promise<never[]> {
    return [];
  }

  async listPullRequestsForHead(repo: RepoRef, opts: { headOwner: string; head: string }) {
    this.calls.push(`listPulls ${repo.id} ${opts.headOwner}:${opts.head}`);
    this.maybeFail('listPullRequestsForHead');
    return this.pulls.filter((p) => opts.headOwner === 'octo' && p.headRef === opts.head).reverse();
  }

  async createPullRequest(repo: RepoRef, input: CreatePullRequestInput) {
    this.calls.push(`createPull ${repo.id} ${input.head} -> ${input.base} draft=${input.draft}`);
    this.maybeFail('createPullRequest');
    if (input.draft && this.draftsRefused) {
      throw new GitHubError(
        `POST /repositories/${repo.id}/pulls failed: 422 Validation Failed: Draft pull requests are not supported in this repository.`,
        422,
      );
    }
    if (this.remoteHas && !this.remoteHas(input.head)) {
      throw new GitHubError(`POST /repositories/${repo.id}/pulls failed: 422 Validation Failed: head invalid`, 422);
    }
    if (this.pulls.some((p) => p.headRef === input.head && p.state === 'open')) {
      throw new GitHubError(`POST /repositories/${repo.id}/pulls failed: 422 A pull request already exists`, 422);
    }
    const number = 100 + this.pulls.length;
    const pr = {
      number,
      htmlUrl: `https://github.com/${FULL}/pull/${number}`,
      state: 'open' as const,
      draft: input.draft,
      merged: false,
      headRef: input.head,
      headRepoId: REPO_ID,
      baseRef: input.base,
      body: input.body,
      title: input.title,
    };
    this.pulls.push(pr);
    if (this.loseNextPullResponse) {
      this.loseNextPullResponse = false;
      throw new GitHubError('POST /repositories/42/pulls: network error: socket hang up', 0);
    }
    return pr;
  }

  async listIssueComments(repo: RepoRef, issue: number) {
    this.calls.push(`listComments ${repo.id} #${issue}`);
    this.maybeFail('listIssueComments');
    return [...this.comments];
  }

  async createIssueComment(repo: RepoRef, issue: number, body: string) {
    this.calls.push(`createComment ${repo.id} #${issue}`);
    this.maybeFail('createIssueComment');
    const id = this.nextId++;
    const c = { id, htmlUrl: `https://github.com/${FULL}/issues/${issue}#issuecomment-${id}`, body, user: 'allen' };
    this.comments.push(c);
    return c;
  }

  // Publication never reads reviews; these exist only to satisfy the interface.
  async getPullRequest(): Promise<never> {
    throw new Error('not used');
  }
  async listPullRequestReviews(): Promise<never> {
    throw new Error('not used');
  }

  get creates(): string[] {
    return this.calls.filter((c) => c.startsWith('create'));
  }
}

const fixtures: GitFixture[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const f of fixtures.splice(0)) f.cleanup();
});

function makeConfig(f: GitFixture, repoOver: Record<string, unknown> = {}, over: Partial<FactoryConfigInput> = {}): FactoryConfig {
  return configSchema.parse({
    version: 1,
    execution: { mode: 'live' },
    dispatch: { allowedActors: ['allen'] },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompt.md', output: 'local-branch' } },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: f.clone,
        remote: 'origin',
        baseBranch: 'main',
        publish: 'draft-pr',
        workflows: [{ trigger: { event: 'issue.labeled', label: 'factory:ready' }, action: 'implement-issue', pool: 'general' }],
        ...repoOver,
      },
    },
    ...over,
  });
}

function makePaths(root: string): FactoryPaths {
  const dataDir = join(root, 'factory state');
  const logDir = join(dataDir, 'logs');
  return {
    configFile: join(root, 'cfg', 'config.yaml'),
    configDir: join(root, 'cfg'),
    dataDir,
    dbFile: join(dataDir, 'state.db'),
    logDir,
    runsDir: join(logDir, 'runs'),
  };
}

interface Scenario {
  f: GitFixture;
  db: Db;
  paths: FactoryPaths;
  runId: string;
  jobId: string;
  branch: string;
  localSha: string;
  logPath: string;
}

/**
 * A finished live run: the job's worktree prepared from the fixture clone, `commits` commits made
 * on the job branch (as an agent would), its summary stored, and the run closed with `outcome`.
 */
async function scenario(o: { commits?: number; outcome?: RunOutcome; db?: Db; f?: GitFixture } = {}): Promise<Scenario> {
  const f = o.f ?? createGitFixture(FULL);
  if (!o.f) fixtures.push(f);
  const db = o.db ?? openDatabase(':memory:');
  if (!o.db) dbs.push(db);
  const paths = makePaths(f.root);
  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: 7 });
  const job = getJob(db, jobId)!;
  const branch = jobBranchName(job, 1);
  const prepared = await prepareJobWorktree({
    checkoutPath: f.clone,
    repoFullName: FULL,
    remote: 'origin',
    baseBranch: 'main',
    branch,
    worktreePath: jobWorktreePath(paths, job, 1),
  });
  for (let i = 0; i < (o.commits ?? 2); i++) {
    writeFileSync(join(prepared.worktreePath, `change-${i}.txt`), `change ${i}\n`);
    f.git(prepared.worktreePath, 'add', '.');
    f.git(prepared.worktreePath, 'commit', '--quiet', '-m', `Add change ${i} for @someone, closes #99`);
  }
  const { summary } = await summarizeRun({
    worktree: prepared.worktreePath,
    branch,
    baseSha: prepared.baseSha,
    lastOutput: ['Implemented the widget.', 'Ping @octocat; ```not a fence``` here.'],
  });
  const runId = `run_${jobId}`;
  const logPath = join(paths.runsDir, runId, 'run.log');
  mkdirSync(join(paths.runsDir, runId), { recursive: true });
  writeFileSync(logPath, 'software-factory run\n');
  const at = new Date(T0).toISOString();
  db.prepare(
    `INSERT INTO runs (id, job_id, attempt, pool, agent, checkout_path, log_path, worker_id, lease_expires_at, started_at,
                       execution_started_at, ended_at, outcome, summary)
     VALUES (?, ?, 1, 'general', 'claude', ?, ?, 'wrk_1', ?, ?, ?, ?, ?, ?)`,
  ).run(runId, jobId, prepared.worktreePath, logPath, at, at, at, at, o.outcome ?? 'succeeded', JSON.stringify(summary));
  db.prepare("UPDATE jobs SET status = ?, attempts = 1 WHERE id = ?").run(o.outcome === 'failed' ? 'failed' : 'succeeded', jobId);
  const localSha = f.git(f.clone, 'rev-parse', `refs/heads/${branch}`);
  return { f, db, paths, runId, jobId, branch, localSha, logPath };
}

function remoteSha(s: Scenario, branch = s.branch): string | null {
  const out = s.f.git(s.f.root, 'ls-remote', s.f.remoteDir, `refs/heads/${branch}`);
  return out ? out.split(/\s+/)[0]! : null;
}

interface GitCall {
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

/**
 * Real git, recording each call. `fakePushUrl` makes the remote report that push URL; reads of
 * that URL (ls-remote) go to `realUrl` (the fixture's bare remote) so no network is touched.
 */
function recordingGit(o: { fakePushUrl?: string; realUrl?: string; failPushWith?: GitError } = {}): { runGit: RunGit; calls: GitCall[] } {
  const calls: GitCall[] = [];
  return {
    calls,
    runGit: async (args, opts: GitOptions) => {
      calls.push({ args: [...args], env: opts.env });
      if (o.fakePushUrl && args[0] === 'remote' && args[1] === 'get-url') return { stdout: `${o.fakePushUrl}\n`, stderr: '' };
      if (o.failPushWith && args[0] === 'push') throw o.failPushWith;
      const real = o.fakePushUrl && o.realUrl ? args.map((a) => (a === o.fakePushUrl ? o.realUrl! : a)) : args;
      return runGit(real, opts);
    },
  };
}

function deps(s: Scenario, api: GitHubApi, over: Partial<PublishDeps> & { config?: FactoryConfig } = {}): PublishDeps {
  return {
    db: s.db,
    config: makeConfig(s.f),
    paths: s.paths,
    api,
    log: silentLogger,
    token: async () => TOKEN,
    now: () => T0,
    ...over,
  };
}

describe('publishRun', { timeout: 60_000 }, () => {
  it('pushes the job branch, opens a draft PR and comments on the issue', async () => {
    const s = await scenario();
    const api = new FakePublishApi((b) => remoteSha(s, b) !== null);
    const r = await publishRun(deps(s, api), s.runId);

    expect(r.status).toBe('published');
    expect(remoteSha(s)).toBe(s.localSha);
    expect(api.pulls).toHaveLength(1);
    const pr = api.pulls[0]!;
    expect(pr).toMatchObject({ draft: true, headRef: s.branch, baseRef: 'main', title: 'Issue 7' });
    expect(pr.body).toMatch(/^Closes #7\n/);
    expect(pr.body).toContain(`run \`${s.runId}\``);
    expect(pr.body).toMatch(/\*\*Changes:\*\* \d+ files? changed/);
    expect(pr.body).toContain('Implemented the widget.');
    expect(pr.body.trimEnd().endsWith(publicationMarker(s.runId))).toBe(true);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain(pr.htmlUrl);
    expect(api.comments[0]!.body).toContain(publicationMarker(s.runId));

    const pub = getPublication(s.db, s.runId)!;
    expect(pub).toMatchObject({ state: 'published', mode: 'draft-pr', prNumber: pr.number, prUrl: pr.htmlUrl, headSha: s.localSha, baseBranch: 'main', attempts: 1, error: null });
    expect(pub.publishedAt).not.toBeNull();
    expect(s.db.prepare('SELECT outcome FROM runs WHERE id = ?').get(s.runId)).toEqual({ outcome: 'succeeded' });
    const log = readFileSync(s.logPath, 'utf8');
    expect(log).toContain(`publication: opened draft PR #${pr.number}`);
    expect(log).toContain('publication: commented on issue #7');
  });

  it('opens a ready-for-review PR with publish: pr', async () => {
    const s = await scenario();
    const api = new FakePublishApi();
    const r = await publishRun(deps(s, api, { config: makeConfig(s.f, { publish: 'pr' }) }), s.runId);
    expect(r.status).toBe('published');
    expect(api.pulls[0]!.draft).toBe(false);
    expect(getPublication(s.db, s.runId)!.mode).toBe('pr');
  });

  it('never force-pushes or touches the base branch', async () => {
    const s = await scenario();
    const git = recordingGit();
    await publishRun(deps(s, new FakePublishApi(), { runGit: git.runGit }), s.runId);
    const pushes = git.calls.filter((c) => c.args[0] === 'push');
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!.args;
    // The only lease is create-only (empty expected value): it can create the branch, never move it.
    expect(push.filter((a) => /^(-f|--force.*|\+.*)$/.test(a))).toEqual([`--force-with-lease=refs/heads/${s.branch}:`]);
    expect(push.at(-1)).toBe(`${s.localSha}:refs/heads/${s.branch}`);
    expect(push).toContain('--no-verify');
    expect(push.join(' ')).not.toContain('refs/heads/main');
  });

  it('resumes after the PR could not be opened, without pushing or opening anything twice', async () => {
    const s = await scenario();
    const api = new FakePublishApi();
    api.failNext.createPullRequest = new GitHubError('POST /repositories/42/pulls failed: 502 Bad Gateway', 502);
    const git = recordingGit();

    const first = await publishRun(deps(s, api, { runGit: git.runGit }), s.runId);
    expect(first).toMatchObject({ status: 'failed', retryable: true });
    let pub = getPublication(s.db, s.runId)!;
    expect(pub).toMatchObject({ state: 'failed', retryable: true, headSha: s.localSha, prNumber: null });
    expect(pub.nextAttemptAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(remoteSha(s)).toBe(s.localSha);
    expect(readFileSync(s.logPath, 'utf8')).toMatch(/publication: failed: GitHub is unavailable for now/);
    expect((s.db.prepare("SELECT message FROM errors WHERE scope = 'publish'").get() as { message: string }).message).toContain(s.runId);

    const second = await publishRun(deps(s, api, { runGit: git.runGit }), s.runId);
    expect(second.status).toBe('published');
    pub = getPublication(s.db, s.runId)!;
    expect(pub).toMatchObject({ state: 'published', attempts: 2, error: null, retryable: false });
    expect(git.calls.filter((c) => c.args[0] === 'push')).toHaveLength(1);
    expect(api.pulls).toHaveLength(1);
    expect(api.comments).toHaveLength(1);

    // Publishing a published run again changes nothing.
    const callsBefore = api.calls.length;
    const third = await publishRun(deps(s, api), s.runId);
    expect(third).toMatchObject({ status: 'published', already: true });
    expect(api.calls.length).toBe(callsBefore);
  });

  it('finds a PR whose creation response was lost instead of opening a second one', async () => {
    const s = await scenario();
    const api = new FakePublishApi();
    api.loseNextPullResponse = true;
    expect((await publishRun(deps(s, api), s.runId)).status).toBe('failed');
    expect(api.pulls).toHaveLength(1);
    expect((await publishRun(deps(s, api), s.runId)).status).toBe('published');
    expect(api.pulls).toHaveLength(1);
    expect(getPublication(s.db, s.runId)!.prNumber).toBe(api.pulls[0]!.number);
  });

  it('resumes after the comment failed, reusing the recorded PR', async () => {
    const s = await scenario();
    const api = new FakePublishApi();
    api.failNext.createIssueComment = new GitHubError('POST comments: network error: ECONNRESET', 0);
    expect((await publishRun(deps(s, api), s.runId)).status).toBe('failed');
    expect(getPublication(s.db, s.runId)!.prNumber).toBe(100);
    expect((await publishRun(deps(s, api), s.runId)).status).toBe('published');
    expect(api.calls.filter((c) => c.startsWith('listPulls'))).toHaveLength(1);
    expect(api.pulls).toHaveLength(1);
    expect(api.comments).toHaveLength(1);
  });

  it('reuses an existing PR for the head and an existing comment with the marker', async () => {
    const s = await scenario();
    const api = new FakePublishApi();
    api.pulls.push({
      number: 55,
      htmlUrl: `https://github.com/${FULL}/pull/55`,
      state: 'closed',
      draft: true,
      merged: false,
      headRef: s.branch,
      headRepoId: REPO_ID,
      baseRef: 'main',
      body: '',
      title: 'earlier',
    });
    api.comments.push({ id: 9, htmlUrl: 'https://github.com/octo/widgets/issues/7#issuecomment-9', body: `old\n${publicationMarker(s.runId)}`, user: 'allen' });

    const r = await publishRun(deps(s, api), s.runId);
    expect(r.status).toBe('published');
    expect(api.creates).toEqual([]);
    expect(getPublication(s.db, s.runId)).toMatchObject({ prNumber: 55, commentId: 9 });
    expect(readFileSync(s.logPath, 'utf8')).toContain('reusing PR #55 (closed)');
  });

  it('refuses to overwrite a remote branch at a different commit', async () => {
    const s = await scenario();
    const theirs = s.f.pushCommit(s.branch, 'theirs.txt', 'not ours\n');
    const api = new FakePublishApi();
    const r = await publishRun(deps(s, api), s.runId);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error).toMatch(/refusing to overwrite it/);
    expect(remoteSha(s)).toBe(theirs);
    expect(api.creates).toEqual([]);
    expect(getPublication(s.db, s.runId)!.nextAttemptAt).toBeNull();
  });

  it('accepts a remote branch already at the same commit without pushing', async () => {
    const s = await scenario();
    s.f.git(s.f.clone, 'push', '--quiet', 'origin', `refs/heads/${s.branch}:refs/heads/${s.branch}`);
    const git = recordingGit();
    expect((await publishRun(deps(s, new FakePublishApi(), { runGit: git.runGit }), s.runId)).status).toBe('published');
    expect(git.calls.filter((c) => c.args[0] === 'push')).toEqual([]);
  });

  it('fails clearly when GitHub refuses a draft, then publishes as a PR once the config says pr', async () => {
    const s = await scenario();
    const api = new FakePublishApi();
    api.draftsRefused = true;
    const r = await publishRun(deps(s, api), s.runId);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') {
      expect(r.error).toMatch(/refused a draft PR/);
      expect(r.error).toContain(`repositories.${FULL}.publish: pr`);
      expect(r.error).toContain(`factory publish ${s.runId}`);
    }
    expect(api.pulls).toEqual([]);

    const again = await publishRun(deps(s, api, { config: makeConfig(s.f, { publish: 'pr' }) }), s.runId);
    expect(again.status).toBe('published');
    expect(api.pulls).toHaveLength(1);
    expect(api.pulls[0]!.draft).toBe(false);
    expect(getPublication(s.db, s.runId)).toMatchObject({ mode: 'pr', attempts: 2 });
  });

  it('explains which token scopes are needed when GitHub denies access', async () => {
    const s = await scenario();
    const api = new FakePublishApi();
    api.failNext.createPullRequest = new GitHubError('POST /repositories/42/pulls failed: 403 Resource not accessible by personal access token', 403);
    const r = await publishRun(deps(s, api), s.runId);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error).toMatch(/classic "repo" scope.*Contents, Pull requests and Issues/);
  });

  it('does not publish a failed run, or a repository with publish off', async () => {
    const failed = await scenario({ outcome: 'failed' });
    const api = new FakePublishApi();
    expect((await publishRun(deps(failed, api), failed.runId)).status).toBe('not-eligible');
    expect(getPublication(failed.db, failed.runId)).toBeNull();
    expect(remoteSha(failed)).toBeNull();

    const off = await scenario({ f: failed.f, db: failed.db });
    const r = await publishRun(deps(off, api, { config: makeConfig(off.f, { publish: 'none' }) }), off.runId);
    expect(r).toMatchObject({ status: 'not-eligible' });
    const logOnly = await publishRun(deps(off, api, { config: makeConfig(off.f, {}, { execution: { mode: 'log-only' } }) }), off.runId);
    expect(logOnly).toMatchObject({ status: 'not-eligible', reason: expect.stringMatching(/only in live mode/) });
    expect(remoteSha(off)).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it('skips a run that left no commits', async () => {
    const s = await scenario({ commits: 0 });
    const api = new FakePublishApi();
    const r = await publishRun(deps(s, api), s.runId);
    expect(r.status).toBe('skipped');
    expect(getPublication(s.db, s.runId)).toMatchObject({ state: 'skipped', error: expect.stringMatching(/no commits/) });
    expect(remoteSha(s)).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it('keeps the token out of git arguments, run.log and errors', async () => {
    const s = await scenario();
    const git = recordingGit({ fakePushUrl: 'https://github.com/octo/widgets.git', realUrl: s.f.remoteDir });
    let asked = 0;
    const r = await publishRun(deps(s, new FakePublishApi(), { runGit: git.runGit, token: async () => (asked++, TOKEN) }), s.runId);
    expect(r.status).toBe('published');
    expect(asked).toBe(1);
    for (const c of git.calls) expect(c.args.join(' ')).not.toContain(TOKEN);
    // The token reaches git only as a scoped header in GIT_CONFIG_* variables of network commands.
    const push = git.calls.find((c) => c.args[0] === 'push')!;
    const header = Object.entries(push.env ?? {}).find(([, v]) => typeof v === 'string' && v.startsWith('AUTHORIZATION: basic '));
    expect(header).toBeDefined();
    const idx = header![0].replace('GIT_CONFIG_VALUE_', '');
    expect(push.env![`GIT_CONFIG_KEY_${idx}`]).toBe('http.https://github.com/.extraheader');
    expect(Buffer.from(header![1]!.slice('AUTHORIZATION: basic '.length), 'base64').toString()).toBe(`x-access-token:${TOKEN}`);
    expect(readFileSync(s.logPath, 'utf8')).not.toContain(TOKEN);

    // A failure whose output echoes the token is redacted everywhere it is recorded.
    const s2 = await scenario({ f: s.f, db: s.db });
    const leaky = recordingGit({
      fakePushUrl: 'https://github.com/octo/widgets.git',
      realUrl: s2.f.remoteDir,
      failPushWith: new GitError('git push failed', ['push'], 128, `fatal: unable to access: Authentication failed for ${TOKEN}\n`),
    });
    const failed = await publishRun(deps(s2, new FakePublishApi(), { runGit: leaky.runGit }), s2.runId);
    expect(failed).toMatchObject({ status: 'failed', retryable: false });
    if (failed.status === 'failed') {
      expect(failed.error).not.toContain(TOKEN);
      expect(failed.error).toMatch(/refused for lack of access/);
    }
    expect(getPublication(s2.db, s2.runId)!.error).not.toContain(TOKEN);
    expect(readFileSync(s2.logPath, 'utf8')).not.toContain(TOKEN);
    const errors = (s.db.prepare('SELECT message FROM errors').all() as { message: string }[]).map((e) => e.message).join('\n');
    expect(errors).not.toContain(TOKEN);
  });

  it('does not ask for the token for a non-https remote', async () => {
    const s = await scenario();
    let asked = 0;
    const git = recordingGit();
    await publishRun(deps(s, new FakePublishApi(), { runGit: git.runGit, token: async () => (asked++, TOKEN) }), s.runId);
    expect(asked).toBe(0);
    for (const c of git.calls) expect(JSON.stringify(c.env ?? {})).not.toContain('extraheader');
  });

  it('refuses a push URL that points at another repository', async () => {
    const s = await scenario();
    const git = recordingGit({ fakePushUrl: 'https://github.com/evil/widgets-fork.git' });
    const r = await publishRun(deps(s, new FakePublishApi(), { runGit: git.runGit }), s.runId);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error).toMatch(/does not point at octo\/widgets/);
    expect(git.calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('refuses a remote with more than one push URL, since git would push to all of them', async () => {
    const s = await scenario();
    // A second bare repository laid out as OWNER/NAME.git too, so each URL alone would pass the check.
    const second = join(s.f.root, 'mirror repos', `${FULL}.git`);
    mkdirSync(second, { recursive: true });
    s.f.git(second, 'init', '--bare', '--quiet', '-b', 'main');
    s.f.git(s.f.clone, 'remote', 'set-url', '--add', '--push', 'origin', s.f.remoteDir);
    s.f.git(s.f.clone, 'remote', 'set-url', '--add', '--push', 'origin', second);

    const api = new FakePublishApi();
    const r = await publishRun(deps(s, api), s.runId);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error).toMatch(/remote "origin" has 2 push URLs .*exactly one destination/);
    expect(remoteSha(s)).toBeNull();
    expect(s.f.git(s.f.root, 'ls-remote', second, `refs/heads/${s.branch}`)).toBe('');
    expect(api.calls.filter((c) => c.startsWith('createPr') || c.startsWith('createComment'))).toEqual([]);

    // With a single push URL again, it publishes there.
    s.f.git(s.f.clone, 'config', '--unset-all', 'remote.origin.pushurl');
    expect(await publishRun(deps(s, api), s.runId)).toMatchObject({ status: 'published' });
    expect(remoteSha(s)).toBe(s.localSha);
  });

  it('an attempt that outlived its lease cannot record anything over the attempt that took over', async () => {
    const s = await scenario();
    let t = T0;
    const now = () => t;
    // The first attempt's comment reaches GitHub, but its response is held back past the lease.
    let release!: () => void;
    let reached!: () => void;
    const reachedComment = new Promise<void>((r) => (reached = r));
    const held = new Promise<void>((r) => (release = r));
    class SlowCommentApi extends FakePublishApi {
      private first = true;
      override async createIssueComment(repo: RepoRef, issue: number, body: string) {
        const c = await super.createIssueComment(repo, issue, body);
        if (this.first) {
          this.first = false;
          reached();
          await held;
        }
        return c;
      }
    }
    const api = new SlowCommentApi();
    const first = publishRun(deps(s, api, { now }), s.runId);
    await reachedComment;

    t += (PUBLISH_LEASE_SECONDS + 1) * 1000;
    const second = await publishRun(deps(s, api, { now }), s.runId);
    expect(second).toMatchObject({ status: 'published', already: false });
    // The second attempt found the first attempt's comment by its marker instead of posting another.
    expect(api.comments).toHaveLength(1);
    const owned = getPublication(s.db, s.runId)!;
    expect(owned).toMatchObject({ state: 'published', attempts: 2, commentId: api.comments[0]!.id });

    release();
    const stale = await first;
    expect(stale).toMatchObject({ status: 'busy', reason: expect.stringMatching(/attempt 1 was superseded/) });
    expect(api.comments).toHaveLength(1);
    expect(getPublication(s.db, s.runId)).toEqual(owned);
  });

  it('leaves alone a branch created after the check, even one the push could fast-forward', async () => {
    const s = await scenario();
    const base = s.f.git(s.f.clone, 'rev-parse', 'refs/heads/main');
    let created = false;
    // Right after the absence check, another writer creates the branch at the base commit, an
    // ancestor of the job branch.
    const racing: RunGit = async (args, opts) => {
      const r = await runGit(args, opts);
      if (args[0] === 'ls-remote' && !created) {
        created = true;
        s.f.git(s.f.remoteDir, 'update-ref', `refs/heads/${s.branch}`, base);
      }
      return r;
    };
    const api = new FakePublishApi();
    const r = await publishRun(deps(s, api, { runGit: racing }), s.runId);
    expect(created).toBe(true);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error).toMatch(new RegExp(`is at ${base.slice(0, 12)}, but the job branch is at ${s.localSha.slice(0, 12)}; refusing to overwrite it`));
    expect(remoteSha(s)).toBe(base);
    expect(api.calls.filter((c) => c.startsWith('createPr'))).toEqual([]);
  });

  it('treats the branch appearing at exactly the job commit during the push as already pushed', async () => {
    const s = await scenario();
    let raced = false;
    // A concurrent push of the same run lands the same commit between the check and this push.
    const racing: RunGit = async (args, opts) => {
      const r = await runGit(args, opts);
      if (args[0] === 'ls-remote' && !raced) {
        raced = true;
        s.f.git(s.f.clone, 'push', '--quiet', s.f.remoteDir, `${s.localSha}:refs/heads/${s.branch}`);
      }
      return r;
    };
    const r = await publishRun(deps(s, new FakePublishApi(), { runGit: racing }), s.runId);
    expect(raced).toBe(true);
    expect(r).toMatchObject({ status: 'published' });
    // Git sees the branch already at the pushed commit and reports it up to date.
    expect(remoteSha(s)).toBe(s.localSha);
  });

  it('pushes to the validated URL even if the remote is changed after the check', async () => {
    const s = await scenario();
    const second = join(s.f.root, 'mirror repos', `${FULL}.git`);
    mkdirSync(second, { recursive: true });
    s.f.git(second, 'init', '--bare', '--quiet', '-b', 'main');
    let changed = false;
    // Right after the existence check, add a second push URL and a rewrite of the first to it.
    const runGitAndTamper: RunGit = async (args, opts) => {
      const r = await runGit(args, opts);
      if (args[0] === 'ls-remote' && !changed) {
        changed = true;
        s.f.git(s.f.clone, 'remote', 'set-url', '--add', '--push', 'origin', s.f.remoteDir);
        s.f.git(s.f.clone, 'remote', 'set-url', '--add', '--push', 'origin', second);
        s.f.git(s.f.clone, 'config', `url.${second}.pushInsteadOf`, s.f.remoteDir);
      }
      return r;
    };

    const r = await publishRun(deps(s, new FakePublishApi(), { runGit: runGitAndTamper }), s.runId);
    expect(changed).toBe(true);
    expect(r).toMatchObject({ status: 'published' });
    expect(remoteSha(s)).toBe(s.localSha);
    expect(s.f.git(s.f.root, 'ls-remote', second, `refs/heads/${s.branch}`)).toBe('');
  });

  it('rechecks ownership after a lookup that outlived the lease, before posting', async () => {
    const s = await scenario();
    let t = T0;
    const now = () => t;
    let release!: () => void;
    let reached!: () => void;
    const reachedLookup = new Promise<void>((r) => (reached = r));
    const held = new Promise<void>((r) => (release = r));
    // The first attempt's comment lookup comes back empty, but only after the lease ran out.
    class SlowLookupApi extends FakePublishApi {
      private first = true;
      override async listIssueComments(repo: RepoRef, issue: number) {
        const found = await super.listIssueComments(repo, issue);
        if (this.first) {
          this.first = false;
          reached();
          await held;
        }
        return found;
      }
    }
    const api = new SlowLookupApi();
    const first = publishRun(deps(s, api, { now }), s.runId);
    await reachedLookup;

    t += (PUBLISH_LEASE_SECONDS + 1) * 1000;
    expect(await publishRun(deps(s, api, { now }), s.runId)).toMatchObject({ status: 'published' });
    expect(api.comments).toHaveLength(1);

    release();
    expect(await first).toMatchObject({ status: 'busy', reason: expect.stringMatching(/attempt 1 was superseded/) });
    expect(api.comments).toHaveLength(1);
  });

  it('an attempt past its deadline stops before writing, and is retried later', async () => {
    const s = await scenario();
    let t = T0;
    class SlowPrLookupApi extends FakePublishApi {
      override async listPullRequestsForHead(...a: Parameters<FakePublishApi['listPullRequestsForHead']>) {
        t += (PUBLISH_ATTEMPT_SECONDS + 1) * 1000; // still inside the lease, past the attempt deadline
        return super.listPullRequestsForHead(...a);
      }
    }
    const api = new SlowPrLookupApi();
    const r = await publishRun(deps(s, api, { now: () => t }), s.runId);
    expect(r).toMatchObject({ status: 'failed', retryable: true });
    if (r.status === 'failed') expect(r.error).toMatch(/ran past its 8-minute deadline/);
    expect(api.calls.filter((c) => c.startsWith('createPr') || c.startsWith('createComment'))).toEqual([]);
    expect(getPublication(s.db, s.runId)).toMatchObject({ state: 'failed', retryable: true, nextAttemptAt: expect.any(String) });
  });
});

describe('createPublisher', { timeout: 60_000 }, () => {
  it('retries due transient failures on its own and leaves the rest', async () => {
    const s = await scenario();
    const api = new FakePublishApi();
    api.failNext.createPullRequest = new GitHubError('POST pulls failed: 503', 503);
    let now = T0;
    const publisher = createPublisher(deps(s, api, { now: () => now }));
    await publisher.afterRun(s.runId);
    expect(getPublication(s.db, s.runId)!.state).toBe('failed');

    await publisher.retryDue();
    expect(getPublication(s.db, s.runId)!.state).toBe('failed'); // not due yet
    now = T0 + 61_000;
    await publisher.retryDue();
    expect(getPublication(s.db, s.runId)!.state).toBe('published');
    expect(api.pulls).toHaveLength(1);
  });
});

describe('factory publish', { timeout: 60_000 }, () => {
  it('publishes a succeeded run through the same idempotent path, then reports it as already published', async () => {
    const f = createGitFixture(FULL);
    fixtures.push(f);
    const api = new FakePublishApi();
    const ctx = { ...fakeContext({ api, home: join(f.root, 'home') }), openDb: (file: string) => openDatabase(file) };
    mkdirSync(ctx.paths.configDir, { recursive: true });
    const config = makeConfig(f);
    writeFileSync(ctx.paths.configFile, stringify(config));
    const db = openDatabase(ctx.paths.dbFile);
    const s = await scenario({ f, db });
    // The worker's attempt left the branch pushed but no PR.
    api.failNext.createPullRequest = new GitHubError('POST pulls: network error: ETIMEDOUT', 0);
    await publishRun(deps(s, api, { paths: ctx.paths }), s.runId);
    db.close();

    const git = recordingGit();
    const code = await publishCommand(ctx, s.runId, { fileExists: () => true, token: async () => TOKEN, runGit: git.runGit });
    expect(code).toBe(0);
    expect(ctx.out.text).toMatch(new RegExp(`Published ${s.runId}: draft PR #100 https://github.com/${FULL}/pull/100`));
    expect(git.calls.some((c) => c.args[0] === 'push')).toBe(false);

    const again = await publishCommand(ctx, s.runId, { fileExists: () => true, token: async () => TOKEN });
    expect(again).toBe(0);
    expect(ctx.out.text).toContain(`Already published ${s.runId}`);
    expect(api.pulls).toHaveLength(1);
    expect(api.comments).toHaveLength(1);
  });

  it('refuses a failed run', async () => {
    const f = createGitFixture(FULL);
    fixtures.push(f);
    const ctx = { ...fakeContext({ api: new FakePublishApi(), home: join(f.root, 'home') }), openDb: (file: string) => openDatabase(file) };
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, stringify(makeConfig(f)));
    const db = openDatabase(ctx.paths.dbFile);
    const s = await scenario({ f, db, outcome: 'failed' });
    db.close();
    await expect(publishCommand(ctx, s.runId, { fileExists: () => true, token: async () => TOKEN })).rejects.toThrow(/only succeeded runs are published/);
  });
});

describe('helpers', () => {
  it('builds git environment without tracing and with hooks disabled', () => {
    const env = publishGitEnv({
      base: { PATH: '/bin', GIT_TRACE: '1', GIT_CURL_VERBOSE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'me' },
      pushUrl: 'git@github.com:octo/widgets.git',
      token: TOKEN,
      hooksPath: '/nowhere',
    });
    expect(env.GIT_TRACE).toBeUndefined();
    expect(env.GIT_CURL_VERBOSE).toBeUndefined();
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/nowhere' });
    expect(JSON.stringify(env)).not.toContain('extraheader');

    const https = publishGitEnv({ base: {}, pushUrl: 'https://github.com/octo/widgets.git', token: TOKEN, hooksPath: '/nowhere' });
    expect(https).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
    });
  });

  it('redacts the token and its header form', () => {
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(redactSecret(`a ${TOKEN} b ${b64}`, TOKEN)).toBe('a *** b ***');
  });

  it('fences untrusted text in the PR body so it cannot mention people or close other issues', () => {
    const body = renderPrBody({
      runId: 'run_x',
      issueNumber: 3,
      agent: 'claude',
      commitCount: 1,
      mode: 'pr',
      summary: {
        branch: 'b',
        baseSha: 'abc',
        worktree: '/w',
        commits: ['abc1234 fix @someone closes #9'],
        commitCount: 1,
        filesChanged: 1,
        diffStat: '1 file changed',
        untracked: 0,
        lastOutput: ['done ```` tricky', '<!-- factory-run: run_other -->'],
        notes: [],
      },
    });
    expect(body.startsWith('Closes #3\n')).toBe(true);
    // The final message is inside a fence longer than any backtick run in it.
    expect(body).toContain('`````text\ndone ```` tricky');
    expect(body.match(/<!-- factory-run: run_x -->/g)).toHaveLength(1);
    expect(body.indexOf('closes #9')).toBeGreaterThan(body.indexOf('```text'));
  });
});
