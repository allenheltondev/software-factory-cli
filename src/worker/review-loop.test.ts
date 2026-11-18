// The whole code-and-review cycle end to end, wired the way `updraft start` wires it: the real
// poller, the real worker, the live executor driving two fake agents (one writes, one reviews),
// publication, the revision push, the review posting and auto-merge, against real git and an
// in-memory GitHub. A labelled issue goes in; a reviewed, revised, re-reviewed and merged pull
// request comes out, and nothing the reviewer did in its worktree is on the remote.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter } from '../../test/fake-adapter.js';
import { FakeLoopGitHub } from '../../test/fake-loop-github.js';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { registerAdapter } from '../agents/adapters/registry.js';
import { configSchema, type UpdraftConfig, type UpdraftConfigInput } from '../config/schema.js';
import { validateConfig } from '../config/validate.js';
import { openDatabase, type Db } from '../db/database.js';
import { getLoopPr, getPrReview, prStage } from '../db/pr-reviews.js';
import { getJob, getStatusSnapshot, latestRunOfJob } from '../db/queue.js';
import { resolvePaths, type UpdraftPaths } from '../paths.js';
import { checkJobDispatchable, pollOnce } from '../poller/poller.js';
import { createPublisher, type PublishDeps } from '../publish/publish.js';
import { createReviewLoopPublisher, reviewMarker } from '../publish/review.js';
import { createRevisionPublisher } from '../publish/revision.js';
import { reviewOf, revisionOf, type Job } from '../types.js';
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
  restores.push(registerAdapter(fakeAdapter({ name: 'codex' })));
});
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r();
  for (const db of dbs.splice(0)) db.close();
  for (const f of fixtures.splice(0)) f.cleanup();
});

function setup(over: { repo?: Record<string, unknown>; reviewerArgs?: string[] } = {}) {
  const f = createGitFixture(FULL);
  fixtures.push(f);
  const paths: UpdraftPaths = resolvePaths({ env: { UPDRAFT_HOME: join(f.root, 'updraft home') } });
  mkdirSync(join(paths.configDir, 'prompts'), { recursive: true });
  writeFileSync(join(paths.configDir, 'prompts', 'implement.md'), 'Implement the issue below.\n');
  writeFileSync(join(paths.configDir, 'prompts', 'revise.md'), 'Address the review below. Commit your work.\n');
  writeFileSync(join(paths.configDir, 'prompts', 'review.md'), 'Review the pull request below.\n');
  const emptyGitConfig = join(f.root, 'agent gitconfig');
  writeFileSync(emptyGitConfig, '');
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_AUTHOR_NAME: 'Fake Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Fake Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
  };
  const raw: UpdraftConfigInput = {
    version: 1,
    execution: { mode: 'live' },
    agents: {
      claude: { command: process.execPath, args: ['--mode', 'success'], env },
      codex: { command: process.execPath, args: over.reviewerArgs ?? ['--mode', 'review'], env },
    },
    pools: { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement.md', revisePrompt: './prompts/revise.md', reviewPrompt: './prompts/review.md', timeoutMinutes: 2 } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: relative(paths.configDir, f.clone),
        remote: 'origin',
        baseBranch: 'main',
        publish: 'draft-pr',
        revise: true,
        review: true,
        autoMerge: 'squash',
        ...over.repo,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general', reviewPool: 'reviewers' }],
      },
    },
  };
  expect(validateConfig(raw)).toMatchObject({ ok: true });
  const config: UpdraftConfig = configSchema.parse(raw);
  // Faster than the schema allows a user to set: auto-merge is evaluated after each poll.
  config.pollIntervalSeconds = 1;
  const db = openDatabase(':memory:');
  dbs.push(db);

  // The labelled issue, already queued as a job.
  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: ISSUE });
  const prBranch = `updraft/issue-${ISSUE}-${jobId}`;
  const gh = new FakeLoopGitHub(FULL, ISSUE, PR);
  gh.headSha = () => remoteHead(f, prBranch);
  gh.issueEvents = [{ id: Number(getJob(db, jobId)!.eventId), event: 'labeled', createdAt: '2026-11-18T11:00:00.000Z', actor: 'allen', label: 'updraft:ready', issue: null }];
  return { f, paths, config, db, gh, jobId, prBranch };
}

const remoteHead = (f: GitFixture, branch: string) => f.git(f.root, 'ls-remote', f.remoteDir, `refs/heads/${branch}`).split(/\s+/)[0] ?? '';

function start(s: ReturnType<typeof setup>) {
  const { db, config, paths, gh } = s;
  const api = gh.api;
  const controller = new AbortController();
  const deps: PublishDeps = {
    db,
    config,
    paths,
    api,
    log: silentLogger,
    token: async () => {
      throw new Error('a local remote needs no token');
    },
  };
  const done = runDaemon({
    db,
    config,
    paths,
    log: silentLogger,
    signal: controller.signal,
    executor: createExecutor(config),
    poll: () => pollOnce({ db, api, config, log: silentLogger }),
    checkDispatchable: (job) => checkJobDispatchable({ api, config }, job),
    publisher: createReviewLoopPublisher(deps, createRevisionPublisher(deps, createPublisher(deps))),
    hostname: hostname(),
    pid: process.pid,
  });
  return {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

const jobsOf = (db: Db): Job[] => (db.prepare('SELECT id FROM jobs ORDER BY created_at, rowid').all() as { id: string }[]).map((r) => getJob(db, r.id)!);

describe('the code-and-review cycle, end to end', { timeout: 180_000 }, () => {
  it('publishes, reviews, revises, reviews again, marks the PR ready and merges exactly the reviewed commit', async () => {
    const s = setup();
    const { f, paths, db, gh, jobId, prBranch } = s;
    const worker = start(s);
    await vi.waitFor(() => expect(gh.merges).toHaveLength(1), { timeout: 150_000, interval: 100 });
    await vi.waitFor(() => expect(getLoopPr(db, REPO_ID, PR)?.mergeState).toBe('merged'), { timeout: 10_000, interval: 50 });
    await worker.stop();

    // Four jobs, in order: the issue, review of the first head, the revision, review of the second head.
    const jobs = jobsOf(db);
    expect(jobs.map((j) => [j.envelope.type, j.status])).toEqual([
      ['issue.labeled', 'succeeded'],
      ['pull_request.review', 'succeeded'],
      ['pull_request.changes_requested', 'succeeded'],
      ['pull_request.review', 'succeeded'],
    ]);
    const [issueJob, review1, revision, review2] = jobs as [Job, Job, Job, Job];
    expect(issueJob.id).toBe(jobId);
    const runOf = (j: Job) => latestRunOfJob(db, j.id)!;
    // The agent that wrote the code never reviewed it.
    expect([runOf(issueJob).agent, runOf(review1).agent, runOf(revision).agent, runOf(review2).agent]).toEqual(['claude', 'codex', 'claude', 'codex']);

    // The remote: main untouched, the PR branch with the two code commits, and nothing else.
    const head2 = remoteHead(f, prBranch);
    f.git(f.clone, 'fetch', '--quiet', 'origin', prBranch);
    const head1 = f.git(f.clone, 'rev-parse', `${head2}~1`);
    expect(f.git(f.clone, 'log', '--format=%s', `origin/main..${head2}`).split('\n')).toEqual(['fake agent: implement the issue', 'fake agent: implement the issue']);
    expect(f.git(f.root, 'ls-remote', '--heads', f.remoteDir).split('\n').map((l) => l.split(/\s+/)[1]).sort()).toEqual(['refs/heads/main', `refs/heads/${prBranch}`]);
    expect(f.git(f.clone, 'ls-tree', '-r', '--name-only', head2)).not.toContain('REVIEW_NOTES.md');

    // Each review was of one exact commit, and the verdicts are the worker's own record.
    expect(reviewOf(review1)).toMatchObject({ headSha: head1, authorAgent: 'claude', pullRequest: { number: PR, branch: prBranch, baseBranch: 'main' } });
    expect(reviewOf(review2)).toMatchObject({ headSha: head2, authorAgent: 'claude' });
    expect(getPrReview(db, runOf(review1).id)).toMatchObject({
      verdict: 'changes-requested',
      headSha: head1,
      state: 'published',
      outcome: 'revision-queued',
      revisionJobId: revision.id,
      agent: 'codex',
      findingsCount: 1,
    });
    expect(getPrReview(db, runOf(review2).id)).toMatchObject({ verdict: 'ready-to-merge', headSha: head2, state: 'published', outcome: 'ready', findingsCount: 0 });
    // The count line is telemetry: it is not part of the findings that were kept, posted or passed on.
    expect(getPrReview(db, runOf(review1).id)!.findings).not.toContain('UPDRAFT-FINDINGS');
    // And it is in the rollup, with the merge and the revision round.
    expect(
      db.prepare("SELECT kind, outcome, findings FROM metric_events WHERE kind IN ('review.verdict', 'pr.merged', 'revision.pushed') ORDER BY at, id").all(),
    ).toEqual([
      { kind: 'review.verdict', outcome: 'changes-requested', findings: 1 },
      { kind: 'revision.pushed', outcome: null, findings: null },
      { kind: 'review.verdict', outcome: 'ready-to-merge', findings: 0 },
      { kind: 'pr.merged', outcome: 'merged', findings: null },
    ]);

    // The revision came from the reviewer's verdict, from local state, with its findings as fenced input.
    expect(revisionOf(revision)).toMatchObject({ trigger: 'updraft_review', reviewedSha: head1, review: { author: 'updraft-bot', id: `updraft-review:${runOf(review1).id}` } });
    const revisePrompt = readFileSync(join(paths.runsDir, runOf(revision).id, 'prompt.md'), 'utf8');
    expect(revisePrompt).toContain('An automated reviewer');
    expect(revisePrompt).toMatch(/<untrusted-review-body>\n[\s\S]*widget\.txt:1 @octocat says this closes #1[\s\S]*\n<\/untrusted-review-body>/);
    expect(revisePrompt).not.toContain('UPDRAFT-VERDICT');

    // What GitHub saw, in order. One comment review per reviewer run, each pinned to its commit;
    // the merge names the reviewed commit and the configured method.
    expect(gh.writes).toEqual([
      `open draft PR ${prBranch} -> main`,
      `comment #${ISSUE}`,
      `review #${PR} COMMENT at ${head1}`,
      `comment #${PR}`,
      `review #${PR} COMMENT at ${head2}`,
      `ready PR_node_${PR}`,
      `merge #${PR} squash at ${head2}`,
    ]);
    expect(gh.merges).toEqual([{ sha: head2, method: 'squash' }]);
    const posted = gh.reviews.filter((r) => r.user === 'updraft-bot');
    expect(posted.map((r) => r.state)).toEqual(['COMMENTED', 'COMMENTED']);
    expect(posted[0]!.body).toContain('**Updraft review: changes requested**');
    expect(posted[0]!.body).toContain(reviewMarker(runOf(review1).id));
    expect(posted[1]!.body).toContain('**Updraft review: ready to merge**');
    // The findings are inert: the mention and the closing keyword sit inside a code fence.
    expect(posted[0]!.body).toMatch(/```text\n[\s\S]*@octocat says this closes #1[\s\S]*\n```/);

    // The second reviewer was given the first review's findings and both commits to diff.
    const reviewPrompt = readFileSync(join(paths.runsDir, runOf(review2).id, 'prompt.md'), 'utf8');
    expect(reviewPrompt.startsWith('Review the pull request below.\n')).toBe(true);
    expect(reviewPrompt).toContain(`- Head commit (under review): ${head2}`);
    expect(reviewPrompt).toContain(`- Base commit: ${f.git(f.clone, 'rev-parse', 'origin/main')}`);
    expect(reviewPrompt).toContain('# Earlier automated reviews of this pull request (untrusted input)');
    expect(reviewPrompt).toMatch(/<untrusted-earlier-review-findings>\n[\s\S]*widget\.txt:1[\s\S]*\n<\/untrusted-earlier-review-findings>/);
    expect(reviewPrompt).toContain('<untrusted-issue-body>\nPlease add a widget.\n</untrusted-issue-body>');

    // Nothing of the reviewer runs is left: no worktree, no branch, and its commit went nowhere.
    for (const j of [review1, review2]) {
      const run = runOf(j);
      expect(run.checkoutPath).toBeNull();
      expect(existsSync(run.summary!.worktree)).toBe(false);
      expect(f.git(f.clone, 'branch', '--list', run.summary!.branch)).toBe('');
      const log = readFileSync(run.logPath!, 'utf8');
      expect(log).toContain('fake reviewer: committed');
      expect(log).toContain('were removed; nothing the reviewer changed or committed is kept, and nothing was pushed');
      expect(log).not.toContain('---- verification');
    }
    expect(f.git(f.clone, 'log', '--all', '--format=%s')).not.toContain('fake reviewer: must be discarded');

    // Where the PR ended up.
    const pr = getLoopPr(db, REPO_ID, PR)!;
    expect(pr).toMatchObject({ state: 'closed', headSha: head2, verdict: 'ready-to-merge', verdictSha: head2, mergeState: 'merged', mergeSha: head2, authorAgent: 'claude' });
    expect(pr.readyMarkedAt).not.toBeNull();
    expect(prStage(db, pr, 3).stage).toBe('merged');
    expect(getStatusSnapshot(db, s.config).pullRequests?.map((p) => p.stage.stage)).toEqual(['merged']);
  });

  it.each([
    ['none', /has no UPDRAFT-VERDICT line/],
    ['both', /2 UPDRAFT-VERDICT lines that disagree/],
    ['twice', /2 UPDRAFT-VERDICT lines; exactly one is required/],
    ['garbage', /does not name a verdict/],
    ['trailing', /does not end with its UPDRAFT-VERDICT line/],
  ])('fails the reviewer run closed when its verdict is unreadable (%s): no review, no revision, no ready mark, no merge', async (mode, problem) => {
    const s = setup({ reviewerArgs: ['--mode', 'review', '--verdict', mode] });
    const { db, gh, f, prBranch } = s;
    const worker = start(s);
    const reviewJob = () => jobsOf(db).find((j) => j.envelope.type === 'pull_request.review');
    await vi.waitFor(() => expect(reviewJob()?.status).toBe('failed'), { timeout: 150_000, interval: 100 });
    // Several polls later, still nothing.
    await new Promise((r) => setTimeout(r, 2_500));
    await worker.stop();

    const job = reviewJob()!;
    expect(job.statusReason).toMatch(problem);
    expect(job.statusReason).toMatch(/^no verdict: /);
    const run = latestRunOfJob(db, job.id)!;
    expect(run).toMatchObject({ outcome: 'failed', agent: 'codex', checkoutPath: null });
    expect(run.summary?.review).toBeUndefined();
    expect(existsSync(run.summary!.worktree)).toBe(false);
    expect(jobsOf(db).map((j) => j.envelope.type)).toEqual(['issue.labeled', 'pull_request.review']);
    expect(db.prepare('SELECT count(*) AS n FROM pr_reviews').get()).toEqual({ n: 0 });
    expect(gh.writes).toEqual([`open draft PR ${prBranch} -> main`, `comment #${ISSUE}`]);
    expect(gh.pull).toMatchObject({ state: 'open', draft: true });
    expect(gh.merges).toEqual([]);
    const pr = getLoopPr(db, REPO_ID, PR)!;
    expect(pr).toMatchObject({ verdict: null, mergeState: null, headSha: remoteHead(f, prBranch) });
    expect(prStage(db, pr, 3)).toMatchObject({ stage: 'needs-human', detail: expect.stringMatching(/did not finish/) });
  });

  it('keeps the verdict when the findings count is broken: no count is recorded, and run.log says why', async () => {
    const s = setup({ repo: { autoMerge: undefined }, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge', '--findings', 'lots'] });
    const { db, gh } = s;
    const worker = start(s);
    await vi.waitFor(() => expect(gh.writes.some((w) => w.startsWith('ready '))).toBe(true), { timeout: 150_000, interval: 100 });
    await worker.stop();

    const job = jobsOf(db).find((j) => j.envelope.type === 'pull_request.review')!;
    const run = latestRunOfJob(db, job.id)!;
    expect(run.outcome).toBe('succeeded');
    expect(getPrReview(db, run.id)).toMatchObject({ verdict: 'ready-to-merge', outcome: 'ready', findingsCount: null });
    const log = readFileSync(run.logPath!, 'utf8');
    expect(log).toContain('review verdict for');
    expect(log.match(/review findings count: none \(the reviewer's UPDRAFT-FINDINGS line is not a whole number from 0 to 999999\); the verdict is unaffected/g)).toHaveLength(1);
    expect(db.prepare("SELECT findings FROM metric_events WHERE kind = 'review.verdict'").all()).toEqual([{ findings: null }]);
  });

  it('with autoMerge off, stops at a PR that is ready for review and merges nothing', async () => {
    const s = setup({ repo: { autoMerge: undefined }, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge'] });
    const { db, gh } = s;
    const worker = start(s);
    await vi.waitFor(() => expect(gh.writes.some((w) => w.startsWith('ready '))).toBe(true), { timeout: 150_000, interval: 100 });
    // Long enough for several polls: nothing more may happen.
    await new Promise((r) => setTimeout(r, 2_500));
    await worker.stop();

    expect(jobsOf(db).map((j) => j.envelope.type)).toEqual(['issue.labeled', 'pull_request.review']);
    expect(gh.merges).toEqual([]);
    expect(gh.calls).not.toContain('mergePullRequest');
    expect(gh.calls.filter((c) => c.startsWith('getCommitChecks'))).toEqual([]);
    expect(gh.pull).toMatchObject({ state: 'open', draft: false });
    const pr = getLoopPr(db, REPO_ID, PR)!;
    expect(pr.mergeState).toBeNull();
    expect(prStage(db, pr, 3)).toMatchObject({ stage: 'ready-to-merge' });
  });

  // kiro-cli logs to stderr while answering on stdout. Through one shared descriptor a record can
  // land on either end of an unterminated verdict line (seen on a real Kiro review of PR #47).
  const stderrLogs = ['--mode', 'review', '--verdict', 'ready-to-merge', '--stderr-logs'];

  it('reads the verdict from stdout alone when the adapter asks for separate stderr, and keeps the stderr in run.log', async () => {
    restores.push(registerAdapter(fakeAdapter({ name: 'codex', separateStderr: true })));
    const s = setup({ repo: { autoMerge: undefined }, reviewerArgs: stderrLogs });
    const { db, gh } = s;
    const worker = start(s);
    await vi.waitFor(() => expect(gh.writes.some((w) => w.startsWith('ready '))).toBe(true), { timeout: 150_000, interval: 100 });
    await worker.stop();

    const job = jobsOf(db).find((j) => j.envelope.type === 'pull_request.review')!;
    const run = latestRunOfJob(db, job.id)!;
    expect(run.outcome).toBe('succeeded');
    expect(getPrReview(db, run.id)).toMatchObject({ verdict: 'ready-to-merge', outcome: 'ready' });
    const log = readFileSync(run.logPath!, 'utf8');
    expect(log).toContain('---- agent output (stdout; stderr follows once the agent has exited) ----');
    // The stdout ends with the bare verdict; both records follow, in a section of their own.
    const out = log.slice(log.indexOf('---- agent output'), log.indexOf('---- agent stderr ----'));
    expect(out).toMatch(/UPDRAFT-VERDICT: ready-to-merge\s*$/);
    expect(out).not.toContain('[KRS]');
    expect(log.slice(log.indexOf('---- agent stderr ----'))).toMatch(/totalEvents=139\[INFO\] \[KRS\] <-- GenerateAssistantResponseCommand done totalEvents=140/);
    expect(log.indexOf('---- agent stderr ----')).toBeLessThan(log.indexOf('---- end of agent output ----'));
  });

  it('without separate stderr the same output glues the records onto the verdict, which fails closed', async () => {
    const s = setup({ repo: { autoMerge: undefined }, reviewerArgs: stderrLogs });
    const { db, gh } = s;
    const worker = start(s);
    const reviewJob = () => jobsOf(db).find((j) => j.envelope.type === 'pull_request.review');
    await vi.waitFor(() => expect(reviewJob()?.status).toBe('failed'), { timeout: 150_000, interval: 100 });
    await worker.stop();

    expect(reviewJob()!.statusReason).toMatch(/^no verdict: /);
    expect(gh.writes.some((w) => w.startsWith('ready '))).toBe(false);
    const log = readFileSync(latestRunOfJob(db, reviewJob()!.id)!.logPath!, 'utf8');
    expect(log).toContain('totalEvents=139UPDRAFT-VERDICT: ready-to-merge[INFO] [KRS]');
  });
});
