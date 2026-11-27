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
import type { NativeAuthRunner } from '../agents/native-claude-auth.js';
import { FakeLoopGitHub, laggingHead } from '../../test/fake-loop-github.js';
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
import { checkPublisherForJob } from '../publish/publisher-role.js';
import { createUserPublisher } from '../github/publisher.js';
import { runGit, type GitOptions } from '../git/git.js';
import { getPublication } from '../db/publications.js';
import { createRevisionPublisher } from '../publish/revision.js';
import { createAssignmentCommenter } from '../publish/assignment-comment.js';
import { parseStatusMarker } from '../publish/status-marker.js';
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

/** The consenting person of github.publisher in the publishAs user tests, and their gh token. */
const ALICE = { login: 'alice', id: 7 };
const ALICE_TOKEN = 'gho_aliceUserToken0123456789';

function setup(
  over: {
    repo?: Record<string, unknown>;
    reviewerArgs?: string[];
    coderArgs?: string[];
    /** publishAs user, with github.app and github.publisher (alice). */
    person?: boolean;
    /** One agent profile (claude) codes and reviews: the review pool is the coding agent's, and allowSameAgent is on. */
    sameProfile?: boolean;
    allowedActors?: string[];
  } = {},
) {
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
      claude: { command: process.execPath, args: over.coderArgs ?? ['--mode', 'success'], env },
      codex: { command: process.execPath, args: over.reviewerArgs ?? ['--mode', 'review'], env },
    },
    pools: { general: { agents: ['claude'] }, reviewers: { agents: [over.sameProfile ? 'claude' : 'codex'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement.md', revisePrompt: './prompts/revise.md', reviewPrompt: './prompts/review.md', timeoutMinutes: 2 } },
    dispatch: { allowedActors: over.allowedActors ?? ['allen'] },
    ...(over.person ? { github: { app: { appId: 1, privateKeyPath: './app.pem' }, publisher: ALICE } } : {}),
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: relative(paths.configDir, f.clone),
        remote: 'origin',
        baseBranch: 'main',
        publish: 'draft-pr',
        notifications: 'verbose',
        revise: true,
        review: true,
        autoMerge: 'squash',
        ...(over.person ? { publishAs: 'user' } : {}),
        ...(over.sameProfile ? { review: { allowSameAgent: true } } : {}),
        ...over.repo,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general', reviewPool: 'reviewers' }],
      },
    },
  };
  if (over.person) writeFileSync(join(paths.configDir, 'app.pem'), 'not a key: the tests never sign as the App\n');
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

/** Every git command publication ran, with its environment (where a push's credentials are). */
type GitCall = { args: string[]; env: NodeJS.ProcessEnv | undefined };

function start(
  s: ReturnType<typeof setup>,
  executorOptions: { nativeClaudeAuth?: NativeAuthRunner } = {},
  withStatus = false,
  person: { calls?: GitCall[]; tokenReads?: { n: number }; signedInAs?: { login: string; id: number } } = {},
) {
  const { db, config, paths, gh, f } = s;
  const api = gh.api;
  const controller = new AbortController();
  // As the person of github.publisher, a push goes over HTTPS to GitHub with their checked token:
  // here, that URL is the fixture's remote.
  const https = `https://github.com/${FULL}.git`;
  const deps: PublishDeps = {
    db,
    config,
    paths,
    api,
    log: silentLogger,
    token: async () => {
      throw new Error('a local remote needs no token, and the App is never asked for a push token here');
    },
    ...(config.github?.publisher
      ? {
          publisher: createUserPublisher({
            expected: config.github.publisher,
            readToken: async () => (person.tokenReads && person.tokenReads.n++, ALICE_TOKEN),
            apiFor: async (token) => {
              expect(token).toBe(ALICE_TOKEN);
              return gh.as(person.signedInAs ?? ALICE);
            },
          }),
          runGit: async (args: readonly string[], opts: GitOptions) => {
            person.calls?.push({ args: [...args], env: opts.env });
            return runGit(args.map((a) => (a === https ? f.remoteDir : a)), opts);
          },
        }
      : {}),
  };
  const done = runDaemon({
    db,
    config,
    paths,
    log: silentLogger,
    signal: controller.signal,
    executor: createExecutor(config, executorOptions),
    poll: () => pollOnce({ db, api, config, log: silentLogger }),
    checkDispatchable: async (job) => {
      const check = await checkJobDispatchable({ api, config, db }, job);
      // As `updraft start` wires it: a job to be published as the person waits while they can't be.
      if (check.ok) await checkPublisherForJob(deps, job);
      return check;
    },
    publisher: createReviewLoopPublisher(deps, createRevisionPublisher(deps, createPublisher(deps))),
    ...(withStatus ? { assignmentCommenter: createAssignmentCommenter({ db, config, api, log: silentLogger, sleep: async () => {} }) } : {}),
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
  it('checks native subscription auth before starting a review job', async () => {
    const s = setup({ repo: { autoMerge: undefined } });
    // A reviewer profile can use any supported adapter. Route it through the same
    // Claude native subscription guard without changing the GitHub review workflow.
    s.config.agents.codex!.adapter = 'claude';
    s.config.agents.codex!.authentication = 'native-claude';
    const check = vi.fn(async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) }));
    const worker = start(s, { nativeClaudeAuth: check });
    try {
      await vi.waitFor(() => {
        const review = jobsOf(s.db).find((j) => j.envelope.type === 'pull_request.review');
        expect(review?.status).toBe('failed');
      }, { timeout: 150_000, interval: 100 });
    } finally {
      await worker.stop();
    }
    const review = jobsOf(s.db).find((j) => j.envelope.type === 'pull_request.review')!;
    expect(check).toHaveBeenCalled();
    expect(review.statusReason).toContain('sign_in_required');
    expect(s.gh.merges).toEqual([]);
  });

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
    // The findings are inert: the mention is broken up.
    expect(posted[0]!.body).toContain('@\u200Boctocat says this closes \u200B#1');
    expect(posted[0]!.body).not.toContain('@octocat');

    // The second reviewer was given the first review's findings and both commits to diff.
    const reviewPrompt = readFileSync(join(paths.runsDir, runOf(review2).id, 'prompt.md'), 'utf8');
    expect(reviewPrompt.startsWith('Review the pull request below.\n')).toBe(true);
    expect(reviewPrompt).toContain(`- Head commit (under review): ${head2}`);
    expect(reviewPrompt).toContain(`- Base commit: ${f.git(f.clone, 'rev-parse', 'origin/main')}`);
    // ...and a clean copy of that base commit to run a failing test on (base-check.ts).
    expect(reviewPrompt).toContain(`# Checking a failure against the base commit\n\nThe files of commit ${f.git(f.clone, 'rev-parse', 'origin/main')} (the base of the pull request`);
    expect(readFileSync(runOf(review2).logPath!, 'utf8')).toMatch(/base checkout: .* was removed/);
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

  it('holds a ready verdict back until every acceptance criterion is independently verified, revising the one that is not met', async () => {
    const s = setup({ coderArgs: ['--mode', 'success', '--acceptance'], reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge', '--acceptance'] });
    const { db, gh, paths } = s;
    gh.issueBody = ['Please add a widget.', '', '## Acceptance', '- [ ] The widget exists', '- [ ] The widget is documented', '- [ ] The widget has a test', '- [ ] The widget is in the changelog'].join('\n');
    const worker = start(s);
    await vi.waitFor(() => expect(gh.merges).toHaveLength(1), { timeout: 150_000, interval: 100 });
    await worker.stop();

    const jobs = jobsOf(db);
    expect(jobs.map((j) => j.envelope.type)).toEqual(['issue.labeled', 'pull_request.review', 'pull_request.changes_requested', 'pull_request.review']);
    const [code, review1, revision, review2] = jobs as [Job, Job, Job, Job];
    const runOf = (j: Job) => latestRunOfJob(db, j.id)!;
    const criteria = runOf(review1).summary!.review!.acceptance!.criteria;
    expect(criteria.map((c) => c.text)).toEqual(['The widget exists', 'The widget is documented', 'The widget has a test', 'The widget is in the changelog']);
    const last = criteria[3]!.id;

    // The coding agent's report is recorded as its claim, and given to the reviewer as one.
    expect(runOf(code).summary!.acceptanceReport!.claims).toHaveLength(4);
    expect(reviewOf(review1)!.acceptanceClaims).toMatchObject({ runId: runOf(code).id });
    const prompt1 = readFileSync(join(paths.runsDir, runOf(review1).id, 'prompt.md'), 'utf8');
    expect(prompt1).toContain(`## Criterion 4 of 4: ${last}`);
    expect(prompt1).toContain("- Coding agent's report (a claim, not evidence): implemented");

    // Round 1: the reviewer wrote ready, but the fourth criterion is not met: a revision, given it.
    expect(getPrReview(db, runOf(review1).id)).toMatchObject({ verdict: 'changes-requested', outcome: 'revision-queued' });
    expect(revisionOf(revision)!.acceptance).toEqual([{ id: last, text: 'The widget is in the changelog', status: 'unmet', gate: 'code', note: 'not done yet' }]);
    expect(readFileSync(join(paths.runsDir, runOf(revision).id, 'prompt.md'), 'utf8')).toContain('The reviewer of the current head found it: unmet');

    // Round 2: all four verified on the new head, which is what was merged.
    expect(getPrReview(db, runOf(review2).id)).toMatchObject({ verdict: 'ready-to-merge', outcome: 'ready' });
    const posted = gh.reviews.filter((r) => r.user === 'updraft-bot');
    expect(posted[0]!.body).toContain(`- **Not met** · \`${last}\``);
    expect(posted[1]!.body).toContain('4 of 4 mandatory criteria verified');
    expect(posted[1]!.body).toContain(`\`${last}\` not met → verified`);
    expect(gh.merges).toEqual([{ sha: runOf(review2).summary!.review!.headSha, method: 'squash' }]);
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

  it('quiet notifications: from label to merge, one Updraft comment on the issue, edited through its stages, and nothing on the PR but its body and the reviews', async () => {
    const s = setup({ repo: { notifications: 'quiet' }, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge'] });
    const { db, gh } = s;
    const worker = start(s, {}, true);
    await vi.waitFor(() => expect(gh.merges).toHaveLength(1), { timeout: 150_000, interval: 100 });
    await vi.waitFor(() => expect(gh.comments.find((c) => c.issue === ISSUE)?.body ?? '').toContain('**Updraft · Merged**'), { timeout: 10_000, interval: 50 });
    await worker.stop();

    expect(jobsOf(db).map((j) => j.envelope.type)).toEqual(['issue.labeled', 'pull_request.review']);
    // One comment on the issue: posted once at assignment, and only edited after that.
    const onIssue = gh.comments.filter((c) => c.issue === ISSUE);
    expect(onIssue).toHaveLength(1);
    expect(gh.writes.filter((w) => w === `comment #${ISSUE}`)).toHaveLength(1);
    expect(gh.writes.indexOf(`comment #${ISSUE}`)).toBeLessThan(gh.writes.indexOf(`open draft PR ${s.prBranch} -> main`));
    expect(parseStatusMarker(onIssue[0]!.body)).toMatchObject({ stage: 90, pr: PR });
    expect(onIssue[0]!.body).toContain(`PR #${PR} was merged.`);
    expect(onIssue[0]!.body).toContain('| Worker | `claude` |');
    // On the pull request: the review, and no comment at all.
    expect(gh.comments.filter((c) => c.issue === PR)).toEqual([]);
    expect(gh.writes.filter((w) => w.startsWith('review #'))).toHaveLength(1);
    // Its body names the merge that actually happened.
    expect(gh.pullBody).toContain('Updraft merges this (`squash`) once review and required checks pass.');
    expect(gh.pullBody).not.toContain('Merging is up to a person');
  });

  it.each([['quiet'], ['verbose']] as const)(
    'suggestions (%s): a ready review with a suggestion gets one suggestion revision, its head is reviewed and merged, and the thread is resolved',
    async (notifications) => {
      const s = setup({ repo: { notifications }, reviewerArgs: ['--mode', 'review', '--suggest'], coderArgs: ['--mode', 'success', '--resolve'] });
      const { db, gh, f, prBranch } = s;
      // FAKE_AGENT.md is in the diff, so the suggestion on its first line is an inline thread.
      gh.files = [{ path: 'FAKE_AGENT.md', status: 'added', patch: '@@ -0,0 +1,3 @@\n+# Done\n+\n+Implement the issue below.' }];
      const worker = start(s, {}, notifications === 'quiet');
      await vi.waitFor(() => expect(gh.merges).toHaveLength(1), { timeout: 150_000, interval: 100 });
      await worker.stop();

      const jobs = jobsOf(db);
      expect(jobs.map((j) => [j.envelope.type, j.status])).toEqual([
        ['issue.labeled', 'succeeded'],
        ['pull_request.review', 'succeeded'],
        ['pull_request.changes_requested', 'succeeded'],
        ['pull_request.review', 'succeeded'],
      ]);
      const [, review1, revision, review2] = jobs as [Job, Job, Job, Job];
      const head1 = reviewOf(review1)!.headSha;
      const head2 = remoteHead(f, prBranch);
      expect(revisionOf(revision)).toMatchObject({ trigger: 'suggestions', reviewedSha: head1, findings: [expect.objectContaining({ severity: 'suggestion', title: 'Say what was done' })] });
      expect(reviewOf(review2)!.headSha).toBe(head2);
      // Only the head after the suggestion revision was merged, never the one it revised.
      expect(gh.merges).toEqual([{ sha: head2, method: 'squash' }]);
      // The thread: the coding agent's reply names the commit, and it is resolved.
      const root = gh.reviewComments.find((c) => c.inReplyToId === null && c.user === 'updraft-bot')!;
      expect(gh.thread(root.id).map((c) => c.body).join('\n')).toContain(`Fixed in [${head2.slice(0, 12)}]`);
      expect(gh.resolved.has(root.id)).toBe(true);
      expect(gh.issues).toEqual([]);
      if (notifications === 'quiet') {
        // Nothing on the pull request but the reviews and the thread; one status comment on the issue.
        expect(gh.comments.filter((c) => c.issue === PR)).toEqual([]);
        expect(gh.comments.filter((c) => c.issue === ISSUE)).toHaveLength(1);
      } else {
        // Verbose: the revision's reply, as for every revision; nothing else from the suggestion step.
        expect(gh.comments.filter((c) => c.issue === PR)).toHaveLength(1);
      }
    },
  );

  it('suggestions, GitHub slow to show a push (#197): the head the suggestion revision pushed is reviewed, goes through CI and is merged; the status ends at "Merged"', async () => {
    const s = setup({ repo: { notifications: 'quiet', ciFix: true }, reviewerArgs: ['--mode', 'review', '--suggest'], coderArgs: ['--mode', 'success', '--resolve'] });
    const { db, gh, f, prBranch } = s;
    gh.files = [{ path: 'FAKE_AGENT.md', status: 'added', patch: '@@ -0,0 +1,3 @@\n+# Done\n+\n+Implement the issue below.' }];
    // Right after each push, GitHub's pull request still names the commit it replaced.
    gh.headSha = laggingHead(() => remoteHead(f, prBranch));
    gh.branchSha = () => remoteHead(f, prBranch);
    const worker = start(s, {}, true);
    const status = () => gh.comments.find((c) => c.issue === ISSUE)?.body ?? '';
    try {
      await vi.waitFor(() => expect(gh.merges).toHaveLength(1), { timeout: 150_000, interval: 100 });
      await vi.waitFor(() => expect(status()).toContain('**Updraft · Merged**'), { timeout: 10_000, interval: 50 });
    } finally {
      await worker.stop();
    }
    const jobs = jobsOf(db);
    expect(jobs.map((j) => [j.envelope.type, j.status])).toEqual([
      ['issue.labeled', 'succeeded'],
      ['pull_request.review', 'succeeded'],
      ['pull_request.changes_requested', 'succeeded'],
      ['pull_request.review', 'succeeded'],
    ]);
    const [, review1, revision, review2] = jobs as [Job, Job, Job, Job];
    const head2 = remoteHead(f, prBranch);
    expect(revisionOf(revision)).toMatchObject({ trigger: 'suggestions', reviewedSha: reviewOf(review1)!.headSha });
    expect(reviewOf(review2)!.headSha).toBe(head2);
    expect(gh.merges).toEqual([{ sha: head2, method: 'squash' }]);
    expect(status()).not.toContain('Addressing suggestions');
    expect(prStage(db, getLoopPr(db, REPO_ID, PR)!, 3, { ci: true, suggestions: true }).stage).toBe('merged');
  });

  it('quiet notifications, autoMerge off: the status rests on "Ready for a person to merge", and a person\'s merge is its last word', async () => {
    const s = setup({ repo: { notifications: 'quiet', autoMerge: undefined }, reviewerArgs: ['--mode', 'review', '--verdict', 'ready-to-merge'] });
    const { gh } = s;
    const worker = start(s, {}, true);
    const status = () => gh.comments.find((c) => c.issue === ISSUE)?.body ?? '';
    try {
      await vi.waitFor(() => expect(status()).toContain('**Updraft · Ready for a person to merge**'), { timeout: 150_000, interval: 100 });
      expect(parseStatusMarker(status())).toMatchObject({ stage: 60, pr: PR });
      // A person merges it on GitHub: the review loop sees it, and says so last.
      gh.pull!.state = 'closed';
      gh.pull!.merged = true;
      gh.touch();
      await vi.waitFor(() => expect(status()).toContain('**Updraft · Merged**'), { timeout: 30_000, interval: 100 });
    } finally {
      await worker.stop();
    }
    expect(gh.comments.filter((c) => c.issue === ISSUE)).toHaveLength(1);
    expect(gh.comments.filter((c) => c.issue === PR)).toEqual([]);
    expect(gh.pullBody).toContain('Merging is up to a person.');
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

/** The person-published loop's GitHub, as a person would read it: who wrote what. */
function personLoopChecks(s: ReturnType<typeof setup>, calls: GitCall[]) {
  const { gh } = s;
  // The pull request is the person's, and so are the pushes: HTTPS with their token, in the
  // environment and never in argv, and never the clone's own remote.
  expect(gh.pullAuthor).toBe('alice');
  expect(gh.writesOf('alice')[0]).toBe(`open draft PR ${s.prBranch} -> main`);
  const pushes = calls.filter((c) => c.args[0] === 'push');
  expect(pushes.length).toBeGreaterThan(0);
  for (const push of pushes) {
    expect(push.args).toContain(`https://github.com/${FULL}.git`);
    const header = Object.values(push.env ?? {}).find((v) => typeof v === 'string' && v.startsWith('AUTHORIZATION: basic '))!;
    expect(Buffer.from(header.slice('AUTHORIZATION: basic '.length), 'base64').toString()).toBe(`x-access-token:${ALICE_TOKEN}`);
  }
  for (const c of calls) expect(c.args.join(' ')).not.toContain(ALICE_TOKEN);
  // Everything that is not the coding agent's is the App's: reviews, notices, ready, merge.
  for (const w of gh.writesOf('alice')) expect(w).toMatch(/^(open draft PR|comment #100$|reply #100)/);
  for (const w of gh.writes.filter((x) => /^(review|ready|merge|dismiss)/.test(x))) expect(gh.writesOf('updraft-bot')).toContain(w);
  expect(gh.writesOf('updraft-bot')).toContain(`comment #${ISSUE}`);
  // Provenance: who published, never the token.
  expect(getPublication(s.db, latestRunOfJob(s.db, s.jobId)!.id)!.publisher).toEqual({ kind: 'user', ...ALICE });
  expect(JSON.stringify(s.db.prepare('SELECT * FROM publications').all())).not.toContain(ALICE_TOKEN);
  expect(gh.pullBody).toContain("Pushed and opened by Updraft's coding agent with the GitHub sign-in of `alice`");
  expect(gh.pullBody).toContain('they do not replace a review a person or code owner must give');
}

/** The native subscription path: every agent is the Claude adapter, signed in to a subscription, checked before each run. */
function nativeSubscription(s: ReturnType<typeof setup>) {
  for (const name of ['claude', 'codex']) {
    const a = s.config.agents[name];
    if (!a) continue;
    a.adapter = 'claude';
    a.authentication = 'native-claude';
  }
  return vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }));
}

describe('the loop of a pull request a person published (publishAs user), end to end', { timeout: 180_000 }, () => {
  it.each([['standard'], ['native subscription']] as const)(
    '%s worker path: the person pushes and opens it, the App formally requests changes and then approves the exact heads, one revision, merged',
    async (path) => {
      // The App is in the allowlist, and GitHub lists its formal reviews where the poller reads
      // reviews: its own change request still queues nothing (the verdict did).
      const s = setup({ person: true, allowedActors: ['allen', 'updraft-bot'] });
      const { f, db, gh, prBranch } = s;
      gh.listFormalReviews = true;
      const check = path === 'native subscription' ? nativeSubscription(s) : null;
      const calls: GitCall[] = [];
      const reads = { n: 0 };
      const worker = start(s, check ? { nativeClaudeAuth: check } : {}, false, { calls, tokenReads: reads });
      try {
        await vi.waitFor(() => expect(gh.merges).toHaveLength(1), { timeout: 150_000, interval: 100 });
        await vi.waitFor(() => expect(getLoopPr(db, REPO_ID, PR)?.mergeState).toBe('merged'), { timeout: 10_000, interval: 50 });
        // Several more polls: nothing more is queued, by the App's reviews or anything else.
        await new Promise((r) => setTimeout(r, 2_500));
      } finally {
        await worker.stop();
      }
      if (check) expect(check).toHaveBeenCalled();

      const jobs = jobsOf(db);
      expect(jobs.map((j) => [j.envelope.type, j.status])).toEqual([
        ['issue.labeled', 'succeeded'],
        ['pull_request.review', 'succeeded'],
        ['pull_request.changes_requested', 'succeeded'],
        ['pull_request.review', 'succeeded'],
      ]);
      const [, review1, revision] = jobs as [Job, Job, Job, Job];
      const head2 = remoteHead(f, prBranch);
      const head1 = reviewOf(review1)!.headSha;
      expect(head1).not.toBe(head2);
      expect(revisionOf(revision)).toMatchObject({ trigger: 'updraft_review', reviewedSha: head1 });

      // GitHub's review state: a change request on the first head, an approval of the merged one.
      expect(gh.writesOf('updraft-bot').filter((w) => w.startsWith('review '))).toEqual([`review #${PR} REQUEST_CHANGES at ${head1}`, `review #${PR} APPROVE at ${head2}`]);
      expect(gh.reviews.filter((r) => r.user === 'updraft-bot').map((r) => [r.state, r.commitId])).toEqual([
        ['CHANGES_REQUESTED', head1],
        ['APPROVED', head2],
      ]);
      // The App's formal change request was seen and set aside (ignored); the one revision was
      // queued from the verdict the worker recorded (updraft_review).
      expect(db.prepare('SELECT trigger_kind AS trigger, state FROM review_requests ORDER BY trigger_kind').all()).toEqual([
        { trigger: 'changes_requested', state: 'ignored' },
        { trigger: 'updraft_review', state: 'queued' },
      ]);
      expect(gh.merges).toEqual([{ sha: head2, method: 'squash' }]);
      // The revision's push was the person's too, checked again (publish, revision: one read each at least).
      expect(calls.filter((c) => c.args[0] === 'push')).toHaveLength(2);
      expect(reads.n).toBeGreaterThanOrEqual(2);
      personLoopChecks(s, calls);
    },
  );

  it.each([['standard'], ['native subscription']] as const)(
    '%s worker path, one agent profile in both roles, manual merge policy: reviewed, revised and approved, then left for a person, with nothing queued twice',
    async (path) => {
      const s = setup({ person: true, sameProfile: true, coderArgs: ['--mode', 'by-prompt'], repo: { autoMerge: undefined }, allowedActors: ['allen', 'updraft-bot'] });
      const { f, db, gh, prBranch } = s;
      gh.listFormalReviews = true;
      const check = path === 'native subscription' ? nativeSubscription(s) : null;
      const calls: GitCall[] = [];
      const worker = start(s, check ? { nativeClaudeAuth: check } : {}, false, { calls });
      try {
        await vi.waitFor(() => expect(gh.writes.some((w) => w.startsWith('ready '))).toBe(true), { timeout: 150_000, interval: 100 });
        await new Promise((r) => setTimeout(r, 2_500));
      } finally {
        await worker.stop();
      }
      if (check) expect(check).toHaveBeenCalled();

      const jobs = jobsOf(db);
      expect(jobs.map((j) => [j.envelope.type, j.status])).toEqual([
        ['issue.labeled', 'succeeded'],
        ['pull_request.review', 'succeeded'],
        ['pull_request.changes_requested', 'succeeded'],
        ['pull_request.review', 'succeeded'],
      ]);
      // The same profile wrote and reviewed: the identities are still separate.
      expect(jobs.map((j) => latestRunOfJob(db, j.id)!.agent)).toEqual(['claude', 'claude', 'claude', 'claude']);
      const head2 = remoteHead(f, prBranch);
      const head1 = reviewOf(jobs[1]!)!.headSha;
      expect(gh.writesOf('updraft-bot').filter((w) => w.startsWith('review '))).toEqual([`review #${PR} REQUEST_CHANGES at ${head1}`, `review #${PR} APPROVE at ${head2}`]);
      // Manual merge: ready for review, never merged, no merge gate read.
      expect(gh.merges).toEqual([]);
      expect(gh.calls).not.toContain('mergePullRequest');
      expect(gh.pull).toMatchObject({ state: 'open', draft: false });
      expect(gh.pullBody).toContain('Merging is up to a person.');
      expect(prStage(db, getLoopPr(db, REPO_ID, PR)!, 3)).toMatchObject({ stage: 'ready-to-merge' });
      expect(db.prepare('SELECT trigger_kind AS trigger, state FROM review_requests ORDER BY trigger_kind').all()).toEqual([
        { trigger: 'changes_requested', state: 'ignored' },
        { trigger: 'updraft_review', state: 'queued' },
      ]);
      personLoopChecks(s, calls);
    },
  );

  it('holds the issue job, and publishes nothing as the App, while the sign-in is another account', async () => {
    const s = setup({ person: true });
    const { db, gh } = s;
    // The gh sign-in is mallory's, not alice's whom github.publisher names.
    const worker = start(s, {}, false, { signedInAs: { login: 'mallory', id: 8 } });
    try {
      await vi.waitFor(() => expect(getJob(db, s.jobId)!.statusReason ?? '').toMatch(/the gh sign-in is mallory .*github\.publisher names alice/), { timeout: 30_000, interval: 100 });
      await new Promise((r) => setTimeout(r, 1_500));
    } finally {
      await worker.stop();
    }
    expect(getJob(db, s.jobId)!.status).toBe('queued');
    expect(jobsOf(db)).toHaveLength(1);
    expect(gh.writes.filter((w) => w.startsWith('open'))).toEqual([]);
    expect(gh.pull).toBeNull();
  });
});
