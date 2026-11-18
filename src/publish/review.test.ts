// The review loop below the agents: scheduling reviewer jobs, who may review, what a verdict
// leads to, and every auto-merge gate, against a real state database and an in-memory GitHub.
// The runs themselves are written into the database as the worker would have left them; the
// end-to-end test with real agents and git is src/worker/review-loop.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLoopGitHub } from '../../test/fake-loop-github.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { renderStatus, buildStatusView } from '../commands/status.js';
import { configSchema, type UpdraftConfig, type UpdraftConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { getLoopPr, getPrReview, observeHead, prStage, reviewEventId, scheduleAllReviews } from '../db/pr-reviews.js';
import { pruneJob } from '../db/prune.js';
import { claimNextJob, finishRun, getJob, getStatusSnapshot, retryJob } from '../db/queue.js';
import { getReviewRequest } from '../db/revisions.js';
import { GitHubError } from '../github/api.js';
import { resolvePaths, type UpdraftPaths } from '../paths.js';
import { checkJobDispatchable, pollOnce } from '../poller/poller.js';
import { reviewOf, revisionOf, type Job, type ReviewVerdict, type RunSummary } from '../types.js';
import { silentLogger } from '../util/log.js';
import { postFailureComment } from './failure-comment.js';
import { evaluateAutoMerges, mergeBlockedMarker, outstandingChangeRequests, postMergeNotices } from './merge.js';
import { publishRun, type PublishDeps } from './publish.js';
import { createReviewLoopPublisher, postReview, reviewMarker } from './review.js';
import { postLimitNotices } from './revision.js';

const REPO_ID = 42;
const FULL = 'octo/widgets';
const PR = 100;
const ISSUE = 7;
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);

const dbs: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Options {
  repo?: Record<string, unknown>;
  action?: Record<string, unknown>;
  pools?: UpdraftConfigInput['pools'];
  agents?: UpdraftConfigInput['agents'];
  workflow?: Record<string, unknown>;
  /** Verification result recorded on the run that published the PR. */
  verified?: boolean;
  /** Overrides for what the verification record says it tested. */
  verifiedAs?: { sha?: string | null; exact?: boolean; uncommittedBefore?: number };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return { branch: 'b', baseSha: 'base', worktree: '/nowhere', commits: [], commitCount: 1, filesChanged: 1, diffStat: '1 file changed', untracked: 0, lastOutput: [], notes: [], ...over };
}

function setup(o: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'updraft-review-'));
  dirs.push(root);
  const paths: UpdraftPaths = resolvePaths({ env: { UPDRAFT_HOME: root } });
  const config: UpdraftConfig = configSchema.parse({
    version: 1,
    execution: { mode: 'live' },
    agents: o.agents ?? { claude: {}, codex: {} },
    pools: o.pools ?? { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
    actions: { 'implement-issue': { prompt: './p.md', revisePrompt: './r.md', reviewPrompt: './v.md', ...o.action } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: './clone',
        publish: 'draft-pr',
        revise: true,
        review: true,
        autoMerge: 'squash',
        ...o.repo,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general', reviewPool: 'reviewers', ...o.workflow }],
      },
    },
  } satisfies UpdraftConfigInput);
  const db = openDatabase(':memory:');
  dbs.push(db);
  const clock = { ms: Date.parse('2026-11-18T12:00:00.000Z') };
  const now = () => clock.ms;
  const iso = () => new Date(clock.ms).toISOString();

  // The issue job that ran on claude and was published as draft PR #100 at H1.
  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: ISSUE });
  const branch = `updraft/issue-${ISSUE}-${jobId}`;
  db.prepare("UPDATE jobs SET status = 'succeeded', attempts = 1 WHERE id = ?").run(jobId);
  // By default the commands tested exactly the published commit; `verifiedAs` overrides that record.
  const verification =
    o.verified === undefined
      ? {}
      : { verification: { passed: o.verified, commands: [], uncommittedBefore: 0, uncommittedAfter: 0, sha: H1, exact: true, ...o.verifiedAs } };
  db.prepare(
    `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome, summary)
     VALUES ('run_original', ?, 1, 'general', 'claude', 'wrk_0', ?, ?, ?, 'succeeded', ?)`,
  ).run(jobId, iso(), iso(), iso(), JSON.stringify(summary({ branch, ...verification })));
  db.prepare(
    `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, base_branch, head_sha, pushed_at, pr_number, pr_url,
                               attempts, created_at, updated_at, published_at)
     VALUES ('run_original', ?, ?, ?, ?, 'draft-pr', 'published', ?, 'main', ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(jobId, REPO_ID, FULL, ISSUE, branch, H1, iso(), PR, `https://github.com/${FULL}/pull/${PR}`, iso(), iso(), iso());

  const gh = new FakeLoopGitHub(FULL, ISSUE, PR);
  gh.pull = { number: PR, state: 'open', merged: false, draft: true, headRef: branch, baseRef: 'main', mergeable: true, mergeableState: 'clean' };
  let head = H1;
  gh.headSha = () => head;
  gh.issueEvents = [{ id: Number(getJob(db, jobId)!.eventId), event: 'labeled', createdAt: '2026-11-18T11:00:00.000Z', actor: 'allen', label: 'updraft:ready', issue: null }];
  const api = gh.api;
  const deps: PublishDeps = {
    db,
    config,
    paths,
    api,
    log: silentLogger,
    now,
    token: async () => {
      throw new Error('nothing is pushed in these tests');
    },
  };
  const tick = (ms = 1_000) => (clock.ms += ms);

  /** Queue the reviewer job for the PR's current head, as the worker does after a push or a poll. */
  const schedule = (): Job[] => {
    tick();
    return scheduleAllReviews(db, config, now);
  };
  /** A reviewer run of `job` that ended with `verdict`, recorded as the worker records it. */
  let runs = 0;
  const reviewed = (job: Job, verdict: ReviewVerdict, findings = 'Blockers:\n- a.ts:3 is wrong'): string => {
    tick();
    const runId = `run_review_${++runs}`;
    const review = reviewOf(job)!;
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome, summary)
       VALUES (?, ?, 1, ?, 'codex', 'wrk_0', ?, ?, ?, 'succeeded', ?)`,
    ).run(runId, job.id, job.pool, iso(), iso(), iso(), JSON.stringify(summary({ review: { headSha: review.headSha, baseSha: null, verdict, findings } })));
    db.prepare("UPDATE jobs SET status = 'succeeded', attempts = 1, updated_at = ? WHERE id = ?").run(iso(), job.id);
    return runId;
  };
  /** Schedule, review and post in one step; returns the reviewer run. */
  const round = async (verdict: ReviewVerdict) => {
    const [job] = schedule();
    expect(job, 'a reviewer job for the current head').toBeDefined();
    const runId = reviewed(job!, verdict);
    const result = await postReview(deps, runId);
    return { job: job!, runId, result };
  };
  /** Someone pushes to the PR: GitHub shows a new head. */
  const push = (sha: string) => {
    head = sha;
    gh.touch();
  };
  const pr = () => getLoopPr(db, REPO_ID, PR)!;
  const stage = () => prStage(db, pr(), config.repositories[FULL]!.maxRevisions ?? 3);
  const mergeStep = async () => {
    tick();
    await evaluateAutoMerges(deps);
    await postMergeNotices(deps);
  };
  return { db, config, paths, gh, api, deps, clock, tick, now, schedule, reviewed, round, push, pr, stage, mergeStep, jobId, branch };
}

const typesOf = (db: Db) => (db.prepare('SELECT envelope FROM jobs ORDER BY created_at, rowid').all() as { envelope: string }[]).map((r) => (JSON.parse(r.envelope) as { type: string }).type);

describe('reviewer jobs', () => {
  it('queues one reviewer job per pull request and head, across repeats, restarts and pruning', () => {
    const s = setup();
    const [job] = s.schedule();
    expect(job).toMatchObject({ eventId: reviewEventId(PR, H1), pool: 'reviewers', action: 'implement-issue', issueNumber: ISSUE, workflowId: 'wf', status: 'queued' });
    expect(reviewOf(job!)).toMatchObject({ headSha: H1, authorAgent: 'claude', pullRequest: { number: PR, branch: s.branch, baseBranch: 'main' }, sourceRunId: 'run_original', priorReviews: [], changeRequests: [] });
    expect(s.schedule()).toEqual([]);
    expect(s.schedule()).toEqual([]);

    // Pruned later: its dedupe key stays, so the same head is not reviewed again.
    s.reviewed(job!, 'ready-to-merge');
    s.tick(60_000);
    expect(pruneJob(s.db, job!.id, new Date(s.now()).toISOString())).toMatchObject({ pruned: true });
    expect(s.schedule()).toEqual([]);
    expect(typesOf(s.db)).toEqual(['issue.labeled']);

    // A new head is a new review.
    expect(observeHead(s.db, REPO_ID, PR, H2, new Date(s.tick()).toISOString())).toBe(true);
    expect(s.schedule().map((j) => j.eventId)).toEqual([reviewEventId(PR, H2)]);
  });

  it('queues nothing while review is off', () => {
    const s = setup({ repo: { review: false, autoMerge: undefined } });
    expect(s.schedule()).toEqual([]);
    expect(typesOf(s.db)).toEqual(['issue.labeled']);
  });

  it('routes to the job pool when the workflow has no reviewPool', () => {
    const s = setup({ workflow: { reviewPool: undefined }, pools: { general: { agents: ['claude', 'codex'] } } });
    expect(s.schedule()[0]).toMatchObject({ pool: 'general' });
  });

  it('never gives the review to the agent that wrote the code while another agent can take it', () => {
    const s = setup({ workflow: { reviewPool: undefined }, pools: { general: { agents: ['claude', 'codex'] } } });
    s.schedule();
    // The round-robin cursor of the pool's reviewer jobs points at the author.
    s.db.prepare("INSERT INTO pool_cursors (pool, next_index) VALUES ('review:general', 0)").run();
    const claim = claimNextJob(s.db, s.config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: s.paths.runsDir, now: s.now });
    expect(claim?.run.agent).toBe('codex');

    // The other agent is busy: the job waits for it instead of falling back to the author.
    const busy = setup({ workflow: { reviewPool: undefined }, pools: { general: { agents: ['claude', 'codex'] } } });
    const other = insertQueuedJob(busy.db, { repoId: REPO_ID, fullName: FULL, issue: 99 });
    busy.db.prepare("INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at) VALUES ('run_busy', ?, 1, 'general', 'codex', 'w', 't', 't')").run(other);
    busy.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(other);
    const [job] = busy.schedule();
    expect(claimNextJob(busy.db, busy.config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: busy.paths.runsDir, now: busy.now })).toBeNull();
    expect(getJob(busy.db, job!.id)?.status).toBe('queued');
  });

  it("routes to the repository's review.pool when the workflow names no reviewPool", () => {
    expect(setup({ workflow: { reviewPool: undefined }, repo: { review: { pool: 'reviewers' } } }).schedule()[0]).toMatchObject({ pool: 'reviewers' });
    const both = setup({ pools: { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] }, others: { agents: ['codex'] } }, repo: { review: { pool: 'others' } } });
    expect(both.schedule()[0]).toMatchObject({ pool: 'reviewers' });
  });

  it('routes a review queued under an old reviewPool to the current route when it is claimed, and again when retried', () => {
    // Queued under the workflow's reviewPool "old"...
    const s = setup({ pools: { general: { agents: ['claude'] }, old: { agents: ['codex'] }, reviewers: { agents: ['codex'] } }, workflow: { reviewPool: 'old' } });
    const [job] = s.schedule();
    expect(job).toMatchObject({ pool: 'old' });
    // ...then the config moves to a repository-wide review.pool and drops "old".
    const repo = s.config.repositories[FULL]!;
    const moved: UpdraftConfig = {
      ...s.config,
      pools: { general: s.config.pools.general!, reviewers: s.config.pools.reviewers! },
      repositories: { [FULL]: { ...repo, review: { pool: 'reviewers', allowSameAgent: false }, workflows: repo.workflows.map((w) => ({ ...w, reviewPool: undefined })) } },
    };
    // The head already has its job, so scheduling queues nothing new.
    expect(scheduleAllReviews(s.db, moved, s.now)).toEqual([]);
    const claimOpts = { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: s.paths.runsDir, now: s.now };
    const claim = claimNextJob(s.db, moved, claimOpts);
    expect(claim).toMatchObject({ job: { id: job!.id, pool: 'reviewers' }, run: { pool: 'reviewers', agent: 'codex' } });
    expect(getJob(s.db, job!.id)).toMatchObject({ status: 'running', pool: 'reviewers' });

    // A retry of a job recorded under a pool that is gone is rerouted the same way.
    finishRun(s.db, claim!.run.id, { outcome: 'failed', error: 'boom', now: s.now });
    s.db.prepare("UPDATE jobs SET status = 'failed', pool = 'old' WHERE id = ?").run(job!.id);
    retryJob(s.db, job!.id, s.now);
    expect(claimNextJob(s.db, moved, claimOpts)).toMatchObject({ job: { id: job!.id, pool: 'reviewers' }, run: { agent: 'codex' } });
  });

  it('takes reviewers in turn, skipping the author, on a rotation of their own', () => {
    // One pool both writes and reviews code. Claude wrote the PR.
    const s = setup({ workflow: { reviewPool: undefined }, agents: { claude: {}, codex: {}, kiro: {} }, pools: { general: { agents: ['claude', 'codex', 'kiro'] } } });
    const claim = () => claimNextJob(s.db, s.config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: s.paths.runsDir, now: s.now })!;
    const done = (runId: string) => {
      expect(finishRun(s.db, runId, { outcome: 'succeeded', now: s.now })).not.toBeNull();
    };
    const reviewers: string[] = [];
    const coders: string[] = [];
    for (const [i, head] of [H1, H2, H3, '4'.repeat(40)].entries()) {
      if (i > 0) expect(observeHead(s.db, REPO_ID, PR, head, new Date(s.tick()).toISOString())).toBe(true);
      // A coding job on another issue claims first and moves the pool's coding cursor.
      insertQueuedJob(s.db, { repoId: REPO_ID, fullName: FULL, issue: 200 + i });
      const coding = claim();
      coders.push(coding.run.agent);
      done(coding.run.id);
      const [job] = s.schedule();
      const review = claim();
      expect(review.job.id).toBe(job!.id);
      reviewers.push(review.run.agent);
      done(review.run.id);
    }
    expect(coders).toEqual(['claude', 'codex', 'kiro', 'claude']);
    expect(reviewers).toEqual(['codex', 'kiro', 'codex', 'kiro']);
  });

  it('fails the job rather than let the only agent review its own code, unless allowSameAgent says so', () => {
    const pools = { general: { agents: ['claude'] } };
    const strict = setup({ workflow: { reviewPool: undefined }, pools });
    const [job] = strict.schedule();
    expect(claimNextJob(strict.db, strict.config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: strict.paths.runsDir, now: strict.now })).toBeNull();
    expect(getJob(strict.db, job!.id)).toMatchObject({ status: 'failed', statusReason: expect.stringMatching(/no enabled agent other than "claude", which wrote the code under review/) });

    const lenient = setup({ workflow: { reviewPool: undefined }, pools, repo: { review: { allowSameAgent: true } } });
    lenient.schedule();
    expect(claimNextJob(lenient.db, lenient.config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: lenient.paths.runsDir, now: lenient.now })?.run.agent).toBe('claude');
  });

  it('is never published or pushed: publication refuses a reviewer run', async () => {
    const s = setup();
    const [job] = s.schedule();
    const runId = s.reviewed(job!, 'ready-to-merge');
    expect(await publishRun(s.deps, runId)).toMatchObject({ status: 'not-eligible', reason: expect.stringMatching(/is a review of an existing pull request/) });
    expect(s.db.prepare('SELECT count(*) AS n FROM publications').get()).toEqual({ n: 1 });
  });

  it('a failed reviewer run is announced on the pull request when commentOnFailure is on', async () => {
    const s = setup({ repo: { commentOnFailure: true } });
    const [job] = s.schedule();
    const claim = claimNextJob(s.db, s.config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: s.paths.runsDir, now: s.now })!;
    expect(claim.job.id).toBe(job!.id);
    finishRun(s.db, claim.run.id, { outcome: 'failed', error: "no verdict: the reviewer's final message has no UPDRAFT-VERDICT line", now: s.now });
    expect(await postFailureComment({ db: s.db, config: s.config, paths: s.paths, api: s.api, log: silentLogger, now: s.now }, claim.run.id)).toMatchObject({ status: 'posted' });
    expect(s.gh.writes).toEqual([`comment #${PR}`]);
    expect(s.gh.comments[0]!.body).toContain(`there is no verdict for commit \`${H1.slice(0, 12)}\``);
    expect(s.gh.comments[0]!.body).toContain('no verdict');
    expect(s.stage()).toMatchObject({ stage: 'needs-human', detail: expect.stringMatching(/did not finish .*updraft retry/) });
    expect(s.pr().verdict).toBeNull();
  });
});

describe('postReview', () => {
  it('posts a changes-requested verdict once and queues the revision from local state', async () => {
    const s = setup();
    const { job, runId, result } = await s.round('changes-requested');
    expect(result).toMatchObject({ status: 'published', already: false, review: { verdict: 'changes-requested', headSha: H1, outcome: 'revision-queued', agent: 'codex' } });
    expect(s.gh.writes).toEqual([`review #${PR} COMMENT at ${H1}`]);
    const body = s.gh.reviews[0]!.body;
    expect(body).toContain('**Updraft review: changes requested**');
    expect(body).toContain(`\`${H1.slice(0, 12)}\``);
    expect(body).toContain('agent codex');
    expect(body).toContain('```text\nBlockers:\n- a.ts:3 is wrong\n```');
    expect(body).toContain('revision 1 of at most 3');
    expect(body.endsWith(reviewMarker(runId))).toBe(true);
    // Decided without reading anything back: the poller's view of the PR was never asked for.
    expect(s.gh.calls).not.toContain('getPullRequestReviews');
    expect(s.gh.calls).not.toContain('getPullRequest');

    const revision = getJob(s.db, getPrReview(s.db, runId)!.revisionJobId!)!;
    expect(revision).toMatchObject({ status: 'queued', eventId: `review:updraft-review:${runId}`, pool: 'general', issueNumber: ISSUE });
    expect(revisionOf(revision)).toMatchObject({ trigger: 'updraft_review', reviewedSha: H1, review: { author: 'updraft-bot', body: 'Blockers:\n- a.ts:3 is wrong', comments: [] } });
    expect(getReviewRequest(s.db, REPO_ID, `updraft-review:${runId}`)).toMatchObject({ state: 'queued', trigger: 'updraft_review', jobId: revision.id });
    expect(s.pr()).toMatchObject({ verdict: 'changes-requested', verdictSha: H1, verdictRunId: runId });
    expect(s.stage()).toMatchObject({ stage: 'changes-requested', detail: expect.stringMatching(/^round 1 of 3/) });
    expect(reviewOf(job)?.headSha).toBe(H1);

    // Again, by the worker's retry or by hand: nothing new anywhere.
    expect(await postReview(s.deps, runId)).toMatchObject({ status: 'published', already: true });
    expect(s.gh.writes).toHaveLength(1);
    expect(typesOf(s.db)).toEqual(['issue.labeled', 'pull_request.review', 'pull_request.changes_requested']);
  });

  it('retries a failed posting without posting twice, also when the first response was lost', async () => {
    const s = setup();
    const [job] = s.schedule();
    const runId = s.reviewed(job!, 'changes-requested');
    s.gh.failNext.createPullRequestReview = new GitHubError('POST failed: 502', 502);
    expect(await postReview(s.deps, runId)).toMatchObject({ status: 'failed', retryable: true });
    // Nothing was decided while the review is not on the PR.
    expect(s.pr().verdict).toBeNull();
    expect(typesOf(s.db)).toEqual(['issue.labeled', 'pull_request.review']);
    expect(s.stage().stage).toBe('reviewing');

    // The review did land on GitHub; only the answer was lost.
    s.gh.reviews.push({ id: 900, state: 'COMMENTED', user: 'Updraft-Bot', body: `x\n\n${reviewMarker(runId)}`, htmlUrl: 'https://github.com/octo/widgets/pull/100#pullrequestreview-900', submittedAt: null, commitId: H1 });
    expect(await postReview(s.deps, runId)).toMatchObject({ status: 'published', review: { reviewId: 900, outcome: 'revision-queued' } });
    expect(s.gh.writes).toEqual([]);
  });

  it('does not take a marker in someone else\'s review for its own', async () => {
    const s = setup();
    const [job] = s.schedule();
    const runId = s.reviewed(job!, 'ready-to-merge');
    s.gh.reviews.push({ id: 901, state: 'COMMENTED', user: 'mallory', body: reviewMarker(runId), htmlUrl: 'u', submittedAt: null, commitId: H1 });
    expect(await postReview(s.deps, runId)).toMatchObject({ status: 'published', review: { reviewId: expect.not.stringMatching(/901/) } });
    expect(s.gh.writes[0]).toBe(`review #${PR} COMMENT at ${H1}`);
  });

  it('posts without a commit when GitHub no longer has the reviewed commit in the pull request', async () => {
    const s = setup();
    s.gh.refuseCommitId = true;
    const { result } = await s.round('changes-requested');
    expect(result.status).toBe('published');
    expect(s.gh.writes).toEqual([`review #${PR} COMMENT at (no commit)`]);
  });

  it('ignores a verdict for a head the pull request has moved on from', async () => {
    const s = setup();
    const [job] = s.schedule();
    const runId = s.reviewed(job!, 'changes-requested');
    // The head moved while the reviewer worked.
    observeHead(s.db, REPO_ID, PR, H2, new Date(s.tick()).toISOString());
    expect(await postReview(s.deps, runId)).toMatchObject({ status: 'published', review: { outcome: 'stale' } });
    // Posted for people to read, but nothing follows from it.
    expect(s.gh.writes).toEqual([`review #${PR} COMMENT at ${H1}`]);
    expect(typesOf(s.db)).toEqual(['issue.labeled', 'pull_request.review']);
    expect(s.stage()).toMatchObject({ stage: 'awaiting-review' });

    // A stale ready-to-merge is no better: not marked ready, never a merge candidate.
    const other = setup();
    const [job2] = other.schedule();
    const run2 = other.reviewed(job2!, 'ready-to-merge');
    other.push(H2); // GitHub has a new head the worker has not seen yet
    expect(await postReview(other.deps, run2)).toMatchObject({ status: 'published', review: { outcome: 'stale' } });
    expect(other.gh.writes).toEqual([`review #${PR} COMMENT at ${H1}`]);
    expect(other.gh.pull?.draft).toBe(true);
    expect(other.pr().headSha).toBe(H2);
    await other.mergeStep();
    expect(other.gh.merges).toEqual([]);
    expect(other.gh.calls).not.toContain('mergePullRequest');
    // The new head gets its own review.
    expect(other.schedule().map((j) => j.eventId)).toEqual([reviewEventId(PR, H2)]);
  });

  it('drops a queued revision whose verdict went stale before it started', async () => {
    const s = setup();
    const { runId } = await s.round('changes-requested');
    const revision = getJob(s.db, getPrReview(s.db, runId)!.revisionJobId!)!;
    expect(await checkJobDispatchable({ api: s.api, config: s.config }, revision)).toMatchObject({ ok: true });

    // Someone pushes before the revision starts: the pre-start check sees it on GitHub...
    s.push(H2);
    expect(await checkJobDispatchable({ api: s.api, config: s.config }, revision)).toEqual({
      ok: false,
      reason: `the reviewer's verdict was for ${H1.slice(0, 12)}, but the pull request is now at ${H2.slice(0, 12)}; the verdict is stale`,
    });
    // ...and the next poll cancels it, and queues the review of the new head.
    s.tick();
    const polled = await pollOnce({ db: s.db, api: s.api, config: s.config, log: silentLogger, now: s.now });
    expect(polled.jobsCanceled).toBe(1);
    expect(getJob(s.db, revision.id)).toMatchObject({ status: 'canceled', statusReason: expect.stringMatching(/verdict is stale/) });
    expect(polled.repos[0]).toMatchObject({ reviewsQueued: 1 });
    expect(s.db.prepare("SELECT event_id FROM jobs WHERE status = 'queued'").all()).toEqual([{ event_id: reviewEventId(PR, H2) }]);
    // A canceled revision does not use up a round.
    expect(s.stage()).toMatchObject({ stage: 'awaiting-review' });
  });

  it('cancels a queued reviewer job once its head is no longer the head', async () => {
    const s = setup();
    const [job] = s.schedule();
    expect(await checkJobDispatchable({ api: s.api, config: s.config }, job!)).toMatchObject({ ok: true, issue: { body: 'Please add a widget.' } });
    s.push(H2);
    expect(await checkJobDispatchable({ api: s.api, config: s.config }, job!)).toMatchObject({ ok: false, reason: expect.stringMatching(/moved from 111111111111 to 222222222222/) });
    s.tick();
    await pollOnce({ db: s.db, api: s.api, config: s.config, log: silentLogger, now: s.now });
    expect(getJob(s.db, job!.id)?.status).toBe('canceled');
    expect(s.db.prepare("SELECT event_id FROM jobs WHERE status = 'queued'").all()).toEqual([{ event_id: reviewEventId(PR, H2) }]);
    // One conditional listing and one read of the changed PR; nothing else was asked of GitHub.
    expect(s.gh.calls.filter((c) => c === 'getPullRequestReviews')).toHaveLength(3);
  });

  it('counts reviewer and human change requests in one maxRevisions, and ends in needs-a-human with one comment', async () => {
    const s = setup({ repo: { maxRevisions: 2 } });
    // Round 1: the reviewer asks for changes.
    const first = await s.round('changes-requested');
    expect(first.result).toMatchObject({ review: { outcome: 'revision-queued' } });
    // Round 2: a person does, on the same head (their review is ingested by the poller).
    s.gh.humanReview('allen', 'CHANGES_REQUESTED', 'Also rename it.');
    s.tick();
    expect((await pollOnce({ db: s.db, api: s.api, config: s.config, log: silentLogger, now: s.now })).repos[0]).toMatchObject({ revisionsQueued: 1 });
    // Both revisions ran and the second one pushed H2.
    s.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE status = 'queued'").run();
    observeHead(s.db, REPO_ID, PR, H2, new Date(s.tick()).toISOString());

    // Round 3 would be the reviewer again: over the limit.
    const third = await s.round('changes-requested');
    expect(third.result).toMatchObject({ status: 'published', review: { outcome: 'over-limit', revisionJobId: null } });
    expect(reviewOf(third.job)?.changeRequests.map((r) => r.body)).toEqual(['Also rename it.']);
    expect(reviewOf(third.job)?.priorReviews).toMatchObject([{ headSha: H1, verdict: 'changes-requested', agent: 'codex' }]);
    expect(s.gh.reviews.at(-1)!.body).toContain('has used its 2 automatic revision(s)');
    expect(s.db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'queued'").get()).toEqual({ n: 0 });
    expect(s.pr().limitReachedAt).not.toBeNull();
    expect(s.stage()).toEqual({ stage: 'needs-human', detail: `changes were requested for ${H2.slice(0, 12)}, but the pull request used its 2 revision(s) (maxRevisions)` });

    // The existing single comment says so, once.
    await postLimitNotices(s.deps);
    await postLimitNotices(s.deps);
    expect(s.gh.writes.filter((w) => w === `comment #${PR}`)).toHaveLength(1);
    expect(s.gh.comments.at(-1)!.body).toContain('limit of 2 automatic revision(s)');
    await s.mergeStep();
    expect(s.gh.merges).toEqual([]);
  });

  it('only posts when revise is off: nothing acts on a changes-requested verdict', async () => {
    const s = setup({ repo: { revise: false } });
    const { result } = await s.round('changes-requested');
    expect(result).toMatchObject({ status: 'published', review: { outcome: 'no-revise' } });
    expect(s.gh.reviews[0]!.body).toContain('Revisions are off for this repository');
    expect(typesOf(s.db)).toEqual(['issue.labeled', 'pull_request.review']);
    expect(s.stage()).toMatchObject({ stage: 'needs-human', detail: expect.stringMatching(/revise is off/) });
  });

  it('marks a draft ready for review on ready-to-merge, and leaves a PR that is not a draft alone', async () => {
    const s = setup({ repo: { autoMerge: undefined } });
    const { result } = await s.round('ready-to-merge');
    expect(result).toMatchObject({ status: 'published', review: { outcome: 'ready' } });
    expect(s.gh.writes).toEqual([`review #${PR} COMMENT at ${H1}`, `ready PR_node_${PR}`]);
    expect(s.gh.reviews[0]!.body).toContain('Merging is up to a person.');
    expect(s.pr().readyMarkedAt).not.toBeNull();
    expect(s.stage()).toMatchObject({ stage: 'ready-to-merge' });

    const open = setup({ repo: { autoMerge: undefined, publish: 'pr' } });
    open.gh.pull!.draft = false;
    await open.round('ready-to-merge');
    expect(open.gh.writes).toEqual([`review #${PR} COMMENT at ${H1}`]);
    expect(open.pr().readyMarkedAt).toBeNull();
  });

  it('does nothing for a run that is not a reviewer run with a verdict, or when review was turned off', async () => {
    const s = setup();
    expect(await postReview(s.deps, 'run_original')).toMatchObject({ status: 'not-eligible', reason: expect.stringMatching(/not a reviewer run/) });
    const [job] = s.schedule();
    const runId = s.reviewed(job!, 'ready-to-merge');
    s.db.prepare("UPDATE runs SET summary = ? WHERE id = ?").run(JSON.stringify(summary()), runId);
    expect(await postReview(s.deps, runId)).toMatchObject({ status: 'not-eligible', reason: expect.stringMatching(/recorded no verdict/) });
    s.db.prepare("UPDATE runs SET outcome = 'failed', summary = ? WHERE id = ?").run(JSON.stringify(summary({ review: { headSha: H1, baseSha: null, verdict: 'ready-to-merge', findings: '' } })), runId);
    expect(await postReview(s.deps, runId)).toMatchObject({ status: 'not-eligible', reason: expect.stringMatching(/ended failed/) });

    const off = setup();
    const [job2] = off.schedule();
    const run2 = off.reviewed(job2!, 'ready-to-merge');
    off.config.repositories[FULL]!.review = false;
    expect(await postReview(off.deps, run2)).toMatchObject({ status: 'not-eligible', reason: expect.stringMatching(/review is off/) });
    expect(off.gh.writes).toEqual([]);
    expect(s.gh.writes).toEqual([]);
  });

  it('as the worker\'s publisher: posts reviewer runs, leaves other runs to the inner publisher, and schedules what they pushed', async () => {
    const s = setup();
    const inner: string[] = [];
    const publisher = createReviewLoopPublisher(s.deps, {
      afterRun: async (runId) => void inner.push(runId),
      retryDue: async () => void inner.push('retryDue'),
      sweepUnpublished: async () => void inner.push('sweep'),
    });
    // After the code run's publication: the reviewer job is there without any request.
    await publisher.afterRun('run_original');
    expect(inner).toEqual(['run_original']);
    const job = getJob(s.db, (s.db.prepare("SELECT id FROM jobs WHERE status = 'queued'").get() as { id: string }).id)!;
    expect(job.eventId).toBe(reviewEventId(PR, H1));
    expect(s.gh.calls).toEqual([]);

    const runId = s.reviewed(job, 'ready-to-merge');
    await publisher.afterRun(runId);
    expect(inner).toEqual(['run_original']);
    expect(getPrReview(s.db, runId)).toMatchObject({ state: 'published', outcome: 'ready' });
    // After a poll: the merge step.
    s.tick();
    await publisher.retryDue();
    expect(inner).toEqual(['run_original', 'retryDue']);
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
  });
});

describe('auto-merge', () => {
  /** A PR whose current head H1 the reviewer found ready, marked ready for review. */
  async function ready(o: Options = {}) {
    const s = setup(o);
    expect((await s.round('ready-to-merge')).result).toMatchObject({ review: { outcome: 'ready' } });
    s.gh.writes.length = 0;
    s.gh.calls.length = 0;
    return s;
  }

  it('merges the reviewed head with the configured method when every gate holds', async () => {
    const s = await ready({ repo: { autoMerge: 'rebase' } });
    expect(s.stage()).toMatchObject({ stage: 'ready-to-merge' });
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'rebase' }]);
    expect(s.gh.calls).toEqual(['getPullRequest', 'listPullRequestReviews', `getCommitChecks ${H1}`, 'mergePullRequest']);
    expect(s.pr()).toMatchObject({ mergeState: 'merged', mergeSha: H1, mergeCommitSha: 'f'.repeat(40), state: 'closed' });
    expect(s.stage().stage).toBe('merged');
    // Settled: later cycles ask nothing.
    s.gh.calls.length = 0;
    await s.mergeStep();
    expect(s.gh.calls).toEqual([]);
  });

  it('is off unless autoMerge is set: no request, no merge', async () => {
    const s = await ready({ repo: { autoMerge: undefined } });
    await s.mergeStep();
    expect(s.gh.calls).toEqual([]);
    expect(s.pr().mergeState).toBeNull();
  });

  it('does not merge a head other than the reviewed one, and says nothing about it', async () => {
    const s = await ready();
    s.push(H2);
    await s.mergeStep();
    expect(s.gh.calls).toEqual(['getPullRequest']);
    expect(s.gh.merges).toEqual([]);
    expect(s.gh.writes).toEqual([]);
    expect(s.pr()).toMatchObject({ headSha: H2, verdictSha: H1, mergeState: null });
    expect(s.stage().stage).toBe('awaiting-review');
    // Even with a head that slips in between the gates and the merge, GitHub refuses the pinned SHA.
    const raced = await ready();
    const real = raced.gh.getCommitChecks.bind(raced.gh);
    raced.gh.getCommitChecks = async (repo, sha) => {
      const checks = await real(repo, sha);
      raced.push(H3);
      return checks;
    };
    await raced.mergeStep();
    expect(raced.gh.merges).toEqual([]);
    expect(raced.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/GitHub refused the merge \(409\)/) });
  });

  it('is blocked by a failing check, records why, comments once and never tries again for that head', async () => {
    const s = await ready();
    s.gh.checks = { total: 2, failing: ['ci / test'], pending: [], succeeded: [], complete: true };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([]);
    expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: `1 check(s) of ${H1.slice(0, 12)} did not pass: ci / test` });
    expect(s.gh.writes).toEqual([`comment #${PR}`]);
    const comment = s.gh.comments.at(-1)!.body;
    expect(comment).toContain('did not merge it');
    expect(comment).toContain('```text\n1 check(s) of 111111111111 did not pass: ci / test\n```');
    expect(comment).toContain(mergeBlockedMarker(H1));
    expect(s.stage()).toMatchObject({ stage: 'ready-to-merge', detail: expect.stringMatching(/not merged by Updraft: 1 check/) });

    // The check is fixed later: still a person's call for this head.
    s.gh.checks = { total: 2, failing: [], pending: [], succeeded: ['ci / build'], complete: true };
    s.gh.calls.length = 0;
    await s.mergeStep();
    await s.mergeStep();
    expect(s.gh.calls).toEqual([]);
    expect(s.gh.writes).toEqual([`comment #${PR}`]);
    expect(s.gh.merges).toEqual([]);
  });

  it('does not merge when the checks could not all be read, even though none seen failed', async () => {
    const s = await ready();
    s.gh.checks = { total: 100, failing: [], pending: [], succeeded: ['ci / build'], complete: false };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([]);
    expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/could not all be read \(100 seen\)/) });
  });

  it('waits for pending checks and merges when they pass', async () => {
    const s = await ready();
    s.gh.checks = { total: 1, failing: [], pending: ['ci / build'], succeeded: [], complete: true };
    await s.mergeStep();
    expect(s.pr()).toMatchObject({ mergeState: 'waiting', mergeReason: expect.stringMatching(/1 check\(s\) .* are pending: ci \/ build/) });
    expect(s.stage().stage).toBe('merging');
    expect(s.gh.writes).toEqual([]);
    s.tick(5 * 60_000);
    s.gh.checks = { total: 1, failing: [], pending: [], succeeded: ['ci / build'], complete: true };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
  });

  it('does not merge a commit no GitHub check has run on: the worker\'s own verify is not enough', async () => {
    // The verify commands ran in the worktree the agent left; only independent CI tests the commit alone.
    const s = await ready({ action: { verify: ['npm test'] }, verified: true, repo: { autoMergeWaitMinutes: 30 } });
    s.gh.checks = { total: 0, failing: [], pending: [], succeeded: [], complete: true };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([]);
    expect(s.pr()).toMatchObject({ mergeState: 'waiting', mergeReason: expect.stringMatching(/no check has reported success on 111111111111/) });
    // CI that registers a moment after the push is picked up.
    s.gh.checks = { total: 1, failing: [], pending: [], succeeded: ['ci / build'], complete: true };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);

    // A repository with no CI at all: given up on, and left for a person.
    const none = await ready({ repo: { autoMergeWaitMinutes: 30 } });
    none.gh.checks = { total: 0, failing: [], pending: [], succeeded: [], complete: true };
    await none.mergeStep();
    none.tick(31 * 60_000);
    await none.mergeStep();
    expect(none.gh.merges).toEqual([]);
    expect(none.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/^gave up after waiting 30 minute\(s\): no check has reported success/) });
  });

  it('does not count a skipped or neutral check as the independent pass', async () => {
    // One check run exists and nothing failed, but it was skipped by its workflow condition: no test ran.
    const s = await ready({ repo: { autoMergeWaitMinutes: 30 } });
    s.gh.checks = { total: 1, failing: [], pending: [], succeeded: [], complete: true };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([]);
    // Waiting, not blocked: a workflow that registers later may still pass on this commit.
    expect(s.pr()).toMatchObject({ mergeState: 'waiting', mergeReason: expect.stringMatching(/no check has reported success on 111111111111.*skipped and neutral results do not count as a pass/) });
    s.tick(60_000);
    s.gh.checks = { total: 2, failing: [], pending: [], succeeded: ['test'], complete: true };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);

    // Nothing ever passes: given up on after the wait, and left for a person.
    const never = await ready({ repo: { autoMergeWaitMinutes: 30 } });
    never.gh.checks = { total: 1, failing: [], pending: [], succeeded: [], complete: true };
    await never.mergeStep();
    never.tick(31 * 60_000);
    await never.mergeStep();
    expect(never.gh.merges).toEqual([]);
    expect(never.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/^gave up after waiting 30 minute\(s\): no check has reported success/) });
  });

  it('with autoMergeRequiredChecks, merges only when each named check reported success', async () => {
    const s = await ready({ repo: { autoMergeRequiredChecks: ['test'], autoMergeWaitMinutes: 30 } });
    // Another check passed; the one that matters has not reported success (skipped, or not registered yet).
    s.gh.checks = { total: 2, failing: [], pending: [], succeeded: ['lint'], complete: true };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([]);
    expect(s.pr()).toMatchObject({ mergeState: 'waiting', mergeReason: expect.stringMatching(/required check\(s\) have not reported success on 111111111111: test/) });
    s.gh.checks = { total: 2, failing: [], pending: [], succeeded: ['lint', 'test'], complete: true };
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);

    const never = await ready({ repo: { autoMergeRequiredChecks: ['test'], autoMergeWaitMinutes: 30 } });
    never.gh.checks = { total: 1, failing: [], pending: [], succeeded: ['lint'], complete: true };
    await never.mergeStep();
    never.tick(31 * 60_000);
    await never.mergeStep();
    expect(never.gh.merges).toEqual([]);
    expect(never.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/^gave up after waiting 30 minute\(s\): required check/) });
  });

  it('gives up on checks that stay pending past autoMergeWaitMinutes', async () => {
    const s = await ready({ repo: { autoMergeWaitMinutes: 30 } });
    s.gh.checks = { total: 1, failing: [], pending: ['ci / build'], succeeded: [], complete: true };
    await s.mergeStep();
    s.tick(29 * 60_000);
    await s.mergeStep();
    expect(s.pr().mergeState).toBe('waiting');
    s.tick(2 * 60_000);
    await s.mergeStep();
    expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/^gave up after waiting 30 minute\(s\): 1 check/) });
    expect(s.gh.writes).toEqual([`comment #${PR}`]);
    expect(s.gh.merges).toEqual([]);
  });

  it('is blocked by an outstanding "Request changes" review of an allowed actor, and by nobody else\'s', async () => {
    const s = await ready();
    s.gh.humanReview('Allen', 'CHANGES_REQUESTED', 'no');
    await s.mergeStep();
    expect(s.gh.merges).toEqual([]);
    expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/"Request changes" review by allen is outstanding/) });
    // No request about checks was needed to know.
    expect(s.gh.calls.filter((c) => c.startsWith('getCommitChecks'))).toEqual([]);

    const stranger = await ready({ repo: { revise: false } });
    stranger.gh.humanReview('mallory', 'CHANGES_REQUESTED', 'no');
    await stranger.mergeStep();
    expect(stranger.gh.merges).toHaveLength(1);

    const reviews = [
      { user: 'allen', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' },
      { user: 'allen', state: 'COMMENTED', submittedAt: '2026-01-02T00:00:00Z' },
      { user: 'bo', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' },
      { user: 'bo', state: 'APPROVED', submittedAt: '2026-01-03T00:00:00Z' },
      { user: 'cy', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' },
      { user: 'cy', state: 'DISMISSED', submittedAt: '2026-01-01T00:00:00Z' },
    ].map((r, id) => ({ id, body: '', htmlUrl: '', commitId: null, ...r }));
    expect(outstandingChangeRequests(reviews, ['allen', 'bo', 'cy', 'dee'])).toEqual(['allen']);
  });

  it('is blocked when GitHub says the PR cannot be merged, is a draft, or changed its base', async () => {
    const conflict = await ready();
    conflict.gh.pull!.mergeable = false;
    conflict.gh.pull!.mergeableState = 'dirty';
    await conflict.mergeStep();
    expect(conflict.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/cannot be merged as it is \(dirty\)/) });
    expect(conflict.gh.calls).toEqual(['getPullRequest', `listIssueComments #${PR}`]);
    expect(conflict.gh.merges).toEqual([]);

    const unknown = await ready();
    unknown.gh.pull!.mergeable = null;
    await unknown.mergeStep();
    expect(unknown.pr()).toMatchObject({ mergeState: 'waiting', mergeReason: expect.stringMatching(/has not finished working out/) });
    unknown.gh.pull!.mergeable = true;
    await unknown.mergeStep();
    expect(unknown.gh.merges).toHaveLength(1);

    const draft = await ready();
    draft.gh.pull!.draft = true;
    await draft.mergeStep();
    expect(draft.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: 'it is still a draft' });

    const rebased = await ready();
    rebased.gh.pull!.baseRef = 'release';
    await rebased.mergeStep();
    expect(rebased.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: 'its base branch is now release, not main, which it was opened against' });
    expect(rebased.gh.merges).toEqual([]);
  });

  it('requires that the run which pushed the head passed the verify commands, when the action has any', async () => {
    const passed = await ready({ action: { verify: ['npm test'] }, verified: true });
    await passed.mergeStep();
    expect(passed.gh.merges).toHaveLength(1);

    // A head someone else pushed was never verified by the worker, whatever the reviewer says.
    const s = setup({ action: { verify: ['npm test'] }, verified: true });
    s.schedule();
    s.push(H2);
    observeHead(s.db, REPO_ID, PR, H2, new Date(s.tick()).toISOString());
    expect((await s.round('ready-to-merge')).result).toMatchObject({ review: { outcome: 'ready', headSha: H2 } });
    s.gh.calls.length = 0;
    await s.mergeStep();
    expect(s.gh.merges).toEqual([]);
    expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/was not pushed by an Updraft run, so the verify commands .* never ran on it/) });
    // Decided locally, before anything was asked of GitHub about the merge.
    expect(s.gh.calls).toEqual([`listIssueComments #${PR}`]);

    // A pass that was not a test of exactly the commit to merge does not count.
    const dirty = await ready({ action: { verify: ['npm test'] }, verified: true, verifiedAs: { exact: false, uncommittedBefore: 2 } });
    await dirty.mergeStep();
    expect(dirty.gh.merges).toEqual([]);
    expect(dirty.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/passed, but not on exactly 111111111111: the worktree held uncommitted files/) });

    const otherCommit = await ready({ action: { verify: ['npm test'] }, verified: true, verifiedAs: { sha: H2 } });
    await otherCommit.mergeStep();
    expect(otherCommit.gh.merges).toEqual([]);
    expect(otherCommit.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/ran on 222222222222, not on 111111111111, the commit to merge/) });

    // A record from before the commit was stored says nothing about which commit was tested.
    const old = await ready({ action: { verify: ['npm test'] }, verified: true, verifiedAs: { sha: undefined, exact: undefined } });
    await old.mergeStep();
    expect(old.gh.merges).toEqual([]);
    expect(old.pr().mergeReason).toMatch(/ran on an unrecorded commit/);

    const unrecorded = await ready({ action: { verify: ['npm test'] } });
    await unrecorded.mergeStep();
    expect(unrecorded.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/no record that the verify commands passed in run run_original/) });
  });

  it('records a refused merge, comments once and does not ask again', async () => {
    const s = await ready();
    s.gh.failAlways.mergePullRequest = new GitHubError('PUT /repositories/42/pulls/100/merge failed: 405 At least 1 approving review is required by reviewers with write access.', 405);
    await s.mergeStep();
    expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeAttempts: 1, mergeReason: expect.stringMatching(/GitHub refused the merge \(405\): .*approving review is required/) });
    await s.mergeStep();
    await s.mergeStep();
    expect(s.gh.calls.filter((c) => c === 'mergePullRequest')).toHaveLength(1);
    expect(s.gh.writes).toEqual([`comment #${PR}`]);
    expect(s.gh.pull).toMatchObject({ state: 'open', merged: false });
    expect(getStatusSnapshot(s.db, s.config, s.now).pullRequests?.[0]).toMatchObject({ stage: { stage: 'ready-to-merge' }, pr: { mergeCommentUrl: expect.stringContaining('issuecomment') } });
  });

  it('posts the comment about a blocked merge once even when posting it fails at first', async () => {
    const s = await ready();
    s.gh.checks = { total: 1, failing: ['lint'], pending: [], succeeded: [], complete: true };
    s.gh.failNext.createIssueComment = new GitHubError('POST failed: 503', 503);
    await s.mergeStep();
    expect(s.gh.writes).toEqual([]);
    expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeCommentId: null, mergeCommentAttempts: 1 });
    await s.mergeStep();
    await s.mergeStep();
    expect(s.gh.writes).toEqual([`comment #${PR}`]);
  });

  it('finds out from GitHub what became of a merge request whose answer was lost, and gives up after three', async () => {
    const s = await ready();
    s.gh.failNext.mergePullRequest = new GitHubError('PUT failed: network error', 0);
    await s.mergeStep();
    expect(s.pr()).toMatchObject({ mergeState: 'merging', mergeAttempts: 1 });
    expect(s.stage().stage).toBe('merging');
    // It did merge.
    s.gh.pull!.state = 'closed';
    s.gh.pull!.merged = true;
    await s.mergeStep();
    expect(s.pr()).toMatchObject({ mergeState: 'merged' });
    expect(s.gh.calls.filter((c) => c === 'mergePullRequest')).toHaveLength(1);

    const down = await ready();
    down.gh.failAlways.mergePullRequest = new GitHubError('PUT failed: 502', 502);
    for (let i = 0; i < 6; i++) await down.mergeStep();
    expect(down.gh.calls.filter((c) => c === 'mergePullRequest')).toHaveLength(3);
    expect(down.pr()).toMatchObject({ mergeState: 'blocked', mergeReason: expect.stringMatching(/requested 3 times without an answer/) });
  });

  it('starts over for a new head: a new review, a new merge decision', async () => {
    const s = await ready();
    s.gh.checks = { total: 1, failing: ['lint'], pending: [], succeeded: [], complete: true };
    await s.mergeStep();
    expect(s.pr().mergeState).toBe('blocked');
    // A person pushes a fix; it is reviewed and found ready.
    s.push(H2);
    observeHead(s.db, REPO_ID, PR, H2, new Date(s.tick()).toISOString());
    expect(s.stage().stage).toBe('awaiting-review');
    s.gh.checks = { total: 1, failing: [], pending: [], succeeded: ['ci / build'], complete: true };
    await s.round('ready-to-merge');
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H2, method: 'squash' }]);
  });
});

describe('status', () => {
  it('lists each watched pull request with its stage, and each verdict', async () => {
    const s = setup();
    const view = () =>
      renderStatus(
        buildStatusView({ configPath: 'c', configState: 'ok', configMessage: null, config: s.config, dbFile: 'd', dbExists: true, snapshot: getStatusSnapshot(s.db, s.config, s.now) }),
      );
    const [job] = s.schedule();
    expect(view()).toMatch(/Pull requests \(review loop\):\n {2}octo\/widgets PR #100 {2}awaiting review {2}https:\/\/github\.com\/octo\/widgets\/pull\/100\n {4}reviewer job job_\w+ is queued/);
    expect(view()).toContain(`(review of PR #${PR} at ${H1.slice(0, 12)})`);
    s.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job!.id);
    expect(view()).toContain('PR #100  reviewing  ');
    const runId = s.reviewed(job!, 'changes-requested');
    await postReview(s.deps, runId);
    expect(view()).toContain('PR #100  changes requested  ');
    expect(view()).toMatch(/round 1 of 3; revision job job_\w+ is queued/);
    expect(view()).toContain(`changes-requested for ${H1.slice(0, 12)} by agent codex; revision job`);
    expect(view()).toContain("(Updraft's reviewer): revision job");
    s.db.prepare("UPDATE jobs SET status = 'running' WHERE status = 'queued'").run();
    expect(view()).toContain('PR #100  revising  ');

    // Not shown at all where the review loop is not configured.
    s.config.repositories[FULL]!.review = false;
    expect(view()).not.toContain('Pull requests (review loop)');
  });
});
