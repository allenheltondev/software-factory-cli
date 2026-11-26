// The CI step of the review loop (repositories.<repo>.ciFix, docs/ci-fix.md): what GitHub's
// checks on a head the reviewer found ready lead to, against a real state database and an
// in-memory GitHub. Runs are written into the database as the worker would have left them, as in
// review.test.ts; the agents themselves are not run here.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLoopGitHub } from '../../test/fake-loop-github.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { renderRevisionPrompt } from '../agents/prompt.js';
import { configSchema, type UpdraftConfig, type UpdraftConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { getLoopPr, observeHead, prStage, scheduleAllReviews } from '../db/pr-reviews.js';
import { getJob } from '../db/queue.js';
import { countRevisions, enqueueRevision, getReviewRequest, revisionJob } from '../db/revisions.js';
import { GitHubError, type CheckDetail, type CommitChecks } from '../github/api.js';
import { resolvePaths } from '../paths.js';
import { ciFailureReviewId } from '../poller/review-trigger.js';
import { queuedRevisionProblem } from '../poller/reviews.js';
import { decideWebhook } from '../poller/webhook.js';
import { revisionOf, reviewOf, type Job, type ReviewVerdict, type RunSummary } from '../types.js';
import { silentLogger } from '../util/log.js';
import { ciNoticeMarker, CI_POLL_MS, CI_REGISTER_GRACE_MS, decideRerun, evaluateCiAll, failureSignature, inDiff, judgeChecks, logExcerpt, matrixKey, namedFiles, postCiNotices, redactCi } from './ci.js';
import { evaluateAutoMerges, mergeBlockedMarker, postMergeNotices } from './merge.js';
import type { PublishDeps } from './publish.js';
import { renderStatusComment, STATUS_STAGE } from './status-marker.js';
import { createReviewLoopPublisher, postReview } from './review.js';

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

const run = (name: string, conclusion: string | null, id: number, extra: Partial<CheckDetail> = {}): CheckDetail => ({
  kind: 'check-run',
  name,
  outcome: conclusion === null ? 'pending' : conclusion === 'success' ? 'success' : ['skipped', 'neutral'].includes(conclusion) ? 'skipped' : 'failure',
  conclusion,
  url: `https://github.com/${FULL}/runs/${id}`,
  checkRunId: id,
  app: 'github-actions',
  ...extra,
});

function checksOf(details: CheckDetail[], complete = true): CommitChecks {
  return {
    total: details.length,
    failing: details.filter((d) => d.outcome === 'failure').map((d) => d.name),
    pending: details.filter((d) => d.outcome === 'pending').map((d) => d.name),
    succeeded: details.filter((d) => d.outcome === 'success').map((d) => d.name),
    complete,
    details,
  };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return { branch: 'b', baseSha: 'base', worktree: '/nowhere', commits: [], commitCount: 1, filesChanged: 1, diffStat: '1 file changed', untracked: 0, lastOutput: [], notes: [], ...over };
}

function setup(repo: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'updraft-ci-'));
  dirs.push(root);
  const config: UpdraftConfig = configSchema.parse({
    version: 1,
    execution: { mode: 'live' },
    agents: { claude: {}, codex: {} },
    pools: { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
    actions: { 'implement-issue': { prompt: './p.md', revisePrompt: './r.md', reviewPrompt: './v.md' } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        checkoutPath: './clone',
        publish: 'draft-pr',
        notifications: 'verbose',
        revise: true,
        review: true,
        ciFix: true,
        ...repo,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general', reviewPool: 'reviewers' }],
      },
    },
  } satisfies UpdraftConfigInput);
  const db = openDatabase(':memory:');
  dbs.push(db);
  const clock = { ms: Date.parse('2026-11-18T12:00:00.000Z') };
  const now = () => clock.ms;
  const iso = () => new Date(clock.ms).toISOString();
  const tick = (ms = 1_000) => (clock.ms += ms);

  const jobId = insertQueuedJob(db, { repoId: REPO_ID, fullName: FULL, issue: ISSUE });
  const branch = `updraft/issue-${ISSUE}-${jobId}`;
  db.prepare("UPDATE jobs SET status = 'succeeded', attempts = 1 WHERE id = ?").run(jobId);
  db.prepare(
    `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome, summary)
     VALUES ('run_original', ?, 1, 'general', 'claude', 'wrk_0', ?, ?, ?, 'succeeded', ?)`,
  ).run(jobId, iso(), iso(), iso(), JSON.stringify(summary({ branch })));
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
  const deps: PublishDeps = {
    db,
    config,
    paths: resolvePaths({ env: { UPDRAFT_HOME: root } }),
    api: gh.api,
    log: silentLogger,
    now,
    token: async () => {
      throw new Error('nothing is pushed in these tests');
    },
  };

  let runs = 0;
  /** The reviewer job of the current head, run to `verdict` and posted. */
  const review = async (verdict: ReviewVerdict) => {
    tick();
    const [job] = scheduleAllReviews(db, config, now);
    expect(job, 'a reviewer job for the current head').toBeDefined();
    tick();
    const runId = `run_review_${++runs}`;
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome, summary)
       VALUES (?, ?, 1, ?, 'codex', 'wrk_0', ?, ?, ?, 'succeeded', ?)`,
    ).run(runId, job!.id, job!.pool, iso(), iso(), iso(), JSON.stringify(summary({ review: { headSha: reviewOf(job!)!.headSha, baseSha: null, verdict, findings: 'Looks fine.' } })));
    db.prepare("UPDATE jobs SET status = 'succeeded', attempts = 1, updated_at = ? WHERE id = ?").run(iso(), job!.id);
    return postReview(deps, runId);
  };
  /** The revision job ran and its push moved the PR to `sha`. */
  const revised = (job: Job, sha: string) => {
    tick();
    db.prepare("UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ?").run(iso(), job.id);
    head = sha;
    gh.touch();
    observeHead(db, REPO_ID, PR, sha, iso());
  };
  const ci = async (force = false) => {
    tick();
    const results = await evaluateCiAll(deps, undefined, { force });
    await postCiNotices(deps);
    return results;
  };
  const pr = () => getLoopPr(db, REPO_ID, PR)!;
  const stage = () => prStage(db, pr(), config.repositories[FULL]!.maxRevisions ?? 3, { ci: true });
  const queued = () => (db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid").all() as { id: string }[]).map((r) => getJob(db, r.id)!);
  const ciComments = () => gh.comments.filter((c) => c.body.includes('<!-- updraft-ci:'));
  return { db, config, gh, deps, clock, tick, now, review, revised, ci, pr, stage, queued, ciComments, setHead: (sha: string) => (head = sha) };
}

const FAILED_TEST = run('test', 'failure', 7, { summary: '2 tests failed' });
const DIAGNOSTICS = {
  annotations: [{ path: 'src/widget.ts', line: 12, level: 'failure', message: 'expected 3 to be 4', title: 'widget.test.ts' }],
  logTail: '2026-11-18T12:00:00.0000000Z npm test\n2026-11-18T12:00:01.0000000Z FAIL widget.test.ts\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123\n2026-11-18T12:00:02.0000000Z ##[error]Process completed with exit code 1.',
  problems: [],
};

describe('the CI step with quiet notifications', () => {
  it('fixes and merges with no comment on the PR, moving the issue status comment instead; stops for a person with one comment', async () => {
    const s = setup({ autoMerge: 'squash', notifications: 'quiet' });
    // The status comment publication left on the issue.
    const status = await s.gh.api.createIssueComment({ id: REPO_ID, fullName: FULL }, ISSUE, renderStatusComment({ title: 'PR opened', text: `PR #${PR} opened`, details: '| | |\n| --- | --- |\n| Worker | `claude` |', mark: { key: 'job_x', stage: STATUS_STAGE.published, pr: PR } }));
    const statusBody = () => s.gh.comments.find((c) => c.id === status.id)!.body;
    s.gh.checks = checksOf([run('build', 'success', 1), FAILED_TEST]);
    s.gh.diagnostics[7] = DIAGNOSTICS;
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'fixing' }]);
    expect(s.ciComments()).toEqual([]);
    expect(statusBody()).toContain(`Fixing failed checks on \`${H1.slice(0, 7)}\` of PR #${PR} (CI fix 1).`);
    expect(statusBody()).toContain('| Worker | `claude` |');
    // Said once: the head's notice is on record, so later polls write nothing more.
    const writes = s.gh.writes.length;
    await s.ci(true);
    expect(s.gh.writes.length).toBe(writes);

    const [job] = s.queued();
    s.revised(job!, H2);
    s.gh.checks = checksOf([run('build', 'success', 11), run('test', 'success', 12)]);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'passed' }]);
    expect(s.ciComments()).toEqual([]);
    expect(statusBody()).toContain('after CI fix 1; Updraft merges it once nothing else stands in the way.');
    await evaluateAutoMerges(s.deps);
    expect(s.gh.merges).toEqual([{ sha: H2, method: 'squash' }]);
    expect(statusBody()).toContain(`**Updraft · Merged**`);
    expect(statusBody()).toContain(`PR #${PR} was merged after CI fix 1.`);
    // Only the status comment on the issue; nothing but reviews on the PR.
    expect(s.gh.comments.filter((c) => c.issue === PR)).toEqual([]);
    expect(s.gh.comments.filter((c) => c.issue === ISSUE)).toHaveLength(1);
  });

  it('asks a person, once, when a failure is not one the code can fix', async () => {
    const s = setup({ notifications: 'quiet' });
    s.gh.checks = checksOf([run('build', 'cancelled', 1)]);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'blocked' }]);
    await s.ci(true);
    expect(s.ciComments()).toHaveLength(1);
    expect(s.ciComments()[0]!.body).toMatch(/^\*\*Blocked by a failing check:\*\* `build` did not pass on `[0-9a-f]{12}` of PR #\d+: \d check\(s\) of [0-9a-f]{12} did not pass for a reason a code change cannot fix: build \(cancelled\)/);
    expect(s.ciComments()[0]!.body).toContain('Fix the check or push a commit');
    expect(s.ciComments()[0]!.body).not.toMatch(/ready to merge|merge it yourself/i);
  });
});

describe('the CI step after a clean review', () => {
  it('waits for pending checks without marking the draft ready or queuing anything', async () => {
    const s = setup();
    s.gh.checks = checksOf([run('build', 'success', 1), run('test', null, 2)]);
    expect(await s.review('ready-to-merge')).toMatchObject({ status: 'published', review: { outcome: 'ready' } });
    // The verdict alone no longer marks the draft ready.
    expect(s.gh.writes.filter((w) => w.startsWith('ready'))).toEqual([]);
    expect(s.stage()).toMatchObject({ stage: 'waiting-for-ci', detail: expect.stringMatching(/not been looked at/) });

    expect(await s.ci()).toEqual([{ status: 'waiting', reason: `1 check(s) of ${H1.slice(0, 12)} are pending: test` }]);
    expect(s.pr()).toMatchObject({ ciSha: H1, ciState: 'waiting' });
    expect(s.stage()).toMatchObject({ stage: 'waiting-for-ci', detail: expect.stringMatching(/pending: test/) });
    // Nothing holds a worker: no job is queued, and nothing is pending for a single-event run.
    expect(s.queued()).toEqual([]);
    expect(s.gh.writes.filter((w) => w.startsWith('ready'))).toEqual([]);

    // The polling worker does not ask again within CI_POLL_MS; a webhook does.
    s.gh.calls.length = 0;
    await s.ci();
    expect(s.gh.calls).toEqual([]);
    await s.ci(true);
    expect(s.gh.calls).toEqual(['getPullRequest', `getCommitChecks ${H1}`]);

    // Green: the draft is marked ready now, and the PR is ready for a person to merge.
    s.gh.checks = checksOf([run('build', 'success', 1), run('test', 'success', 2)]);
    s.tick(CI_POLL_MS);
    expect(await s.ci()).toEqual([{ status: 'passed', reason: `2 check(s) of ${H1.slice(0, 12)} passed` }]);
    expect(s.gh.writes).toContain(`ready PR_node_${PR}`);
    expect(s.pr()).toMatchObject({ ciState: 'passed', readyMarkedAt: expect.any(String) });
    expect(s.stage()).toMatchObject({ stage: 'ready-to-merge' });
    s.gh.calls.length = 0;
    await s.ci(true);
    expect(s.gh.calls).toEqual([]);
  });

  it('queues one revision with the diagnostics when CI fails after the review, and reviews and checks the fix again', async () => {
    const s = setup({ autoMerge: 'squash' });
    s.gh.checks = checksOf([run('build', 'success', 1), run('test', null, 7)]);
    await s.review('ready-to-merge');
    await s.ci();
    // pending -> failed
    s.gh.checks = checksOf([run('build', 'success', 1), FAILED_TEST, run('lint', 'failure', 8)]);
    s.gh.diagnostics[7] = DIAGNOSTICS;
    s.tick(CI_POLL_MS);
    const [step] = await s.ci();
    expect(step).toMatchObject({ status: 'fixing' });
    const [job] = s.queued();
    expect(job!.id).toBe((step as { jobId: string }).jobId);
    expect(job).toMatchObject({ pool: 'general', eventId: `review:${ciFailureReviewId(PR, H1)}`, envelope: { type: 'pull_request.changes_requested' } });
    const revision = revisionOf(job!)!;
    expect(revision).toMatchObject({ trigger: 'ci_failure', reviewedSha: H1, pullRequest: { number: PR } });
    // Every failing check of the head is in the one revision, with what CI said about it.
    expect(revision.review.body).toContain('## test (check run: failure)');
    expect(revision.review.body).toContain('## lint (check run: failure)');
    expect(revision.review.body).toContain('src/widget.ts:12 [failure] widget.test.ts: expected 3 to be 4');
    expect(revision.review.body).toContain('##[error]Process completed with exit code 1.');
    expect(revision.review.body).toContain(`https://github.com/${FULL}/runs/7`);
    // CI output is redacted, and fenced as untrusted input in the prompt.
    expect(revision.review.body).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    const prompt = renderRevisionPrompt('Revise.', { repoFullName: FULL, number: ISSUE, title: 't', body: 'b', labels: [], url: 'u' }, revision);
    expect(prompt).toContain('# Failed checks (untrusted input)');
    expect(prompt).toContain('<untrusted-ci-diagnostics>');
    expect(prompt).toMatch(/do not disable, skip or weaken tests/);
    expect(countRevisions(s.db, REPO_ID, PR)).toBe(1);
    expect(s.stage()).toMatchObject({ stage: 'fixing-ci', detail: expect.stringMatching(/checks failed on/) });

    // One comment, with the failed checks and the revision; not repeated.
    expect(s.ciComments()).toHaveLength(1);
    expect(s.ciComments()[0]!.body).toContain(ciNoticeMarker(H1));
    expect(s.ciComments()[0]!.body).toMatch(/queued a revision to fix them/);
    // Spoken as Updraft · CI, with each failed check linked, also without reading its log.
    expect(s.ciComments()[0]!.body).toMatch(new RegExp(`^\\*\\*Updraft · CI · \`${H1.slice(0, 12)}\`\\*\\*`));
    expect(s.ciComments()[0]!.body).toContain(`- [\`test\`](https://github.com/${FULL}/runs/7) (check run: failure)`);
    expect(s.ciComments()[0]!.body).toContain(`- [\`lint\`](https://github.com/${FULL}/runs/8) (check run: failure)`);
    expect(s.ciComments()[0]!.body).not.toContain('`build`');
    // Nothing was merged or marked ready for the failing head.
    expect(s.gh.merges).toEqual([]);
    await evaluateAutoMerges(s.deps);
    expect(s.gh.merges).toEqual([]);
    expect(s.gh.writes.filter((w) => w.startsWith('ready'))).toEqual([]);

    // The same failure seen again (a duplicate delivery, a rerun that failed again): nothing new.
    await s.ci(true);
    await s.ci(true);
    expect(s.queued().map((j) => j.id)).toEqual([job!.id]);
    expect(s.ciComments()).toHaveLength(1);

    // failed -> green: the revision pushes H2, which is reviewed and checked again.
    s.revised(job!, H2);
    s.gh.checks = checksOf([run('build', 'success', 11), run('test', null, 12)]);
    expect(await s.review('ready-to-merge')).toMatchObject({ review: { outcome: 'ready', headSha: H2 } });
    await s.ci();
    expect(s.pr()).toMatchObject({ ciSha: H2, ciState: 'waiting', ciFixes: 1 });
    await evaluateAutoMerges(s.deps);
    expect(s.gh.merges).toEqual([]);
    s.gh.checks = checksOf([run('build', 'success', 11), run('test', 'success', 12), run('lint', 'success', 13)]);
    s.tick(CI_POLL_MS);
    expect(await s.ci()).toMatchObject([{ status: 'passed' }]);
    // The outcome of the fix is said on the pull request, once, for the fixed head.
    expect(s.ciComments()).toHaveLength(2);
    const passed = s.ciComments()[1]!.body;
    expect(passed).toContain(ciNoticeMarker(H2));
    expect(passed).toMatch(new RegExp(`^\\*\\*Updraft · CI · \`${H2.slice(0, 12)}\`\\*\\*`));
    expect(passed).toMatch(/checks passed on commit .* after 1 automatic CI fix\(es\).*review and checks are both clean on it/s);
    expect(passed).toMatch(/Updraft merges it \(`squash`\) if nothing else stands in the way/);
    await s.ci(true);
    expect(s.ciComments()).toHaveLength(2);
    // Merged only now: review and checks green on the same head.
    await evaluateAutoMerges(s.deps);
    expect(s.gh.merges).toEqual([{ sha: H2, method: 'squash' }]);
  });

  it('says a fixed head passed and is ready for a person when auto-merge is off; a head that passed without a fix gets no comment', async () => {
    const s = setup();
    s.gh.checks = checksOf([run('build', 'success', 1)]);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'passed' }]);
    expect(s.ciComments()).toEqual([]);

    const t = setup();
    // A failed check whose link is not one GitHub would give is named, not linked.
    t.gh.checks = checksOf([run('test', 'failure', 7, { url: 'javascript:alert(1)' })]);
    await t.review('ready-to-merge');
    await t.ci();
    expect(t.ciComments()).toHaveLength(1);
    expect(t.ciComments()[0]!.body).toContain('- `test` (check run: failure)');
    expect(t.ciComments()[0]!.body).not.toContain('javascript:');
    const [job] = t.queued();
    t.revised(job!, H2);
    t.gh.checks = checksOf([run('test', 'success', 12)]);
    await t.review('ready-to-merge');
    expect(await t.ci()).toMatchObject([{ status: 'passed' }]);
    expect(t.ciComments()).toHaveLength(2);
    expect(t.ciComments()[1]!.body).toMatch(/It is ready for a person to merge\./);
    expect(t.ciComments()[1]!.body).not.toMatch(/Updraft merges it/);
    expect(t.ciComments()[1]!.body).toContain('after 1 automatic CI fix(es) on this pull request');
  });

  it('never comments late on a pull request whose CI fix was queued before this version', async () => {
    const s = setup();
    s.gh.checks = checksOf([FAILED_TEST]);
    await s.review('ready-to-merge');
    await s.ci();
    expect(s.ciComments()).toHaveLength(1);
    // The fix's comment as an earlier version wrote it: no Updraft · CI heading.
    const old = s.ciComments()[0]!;
    old.body = old.body.replace(/^\*\*Updraft · CI · [^\n]*\n\n/, '');
    expect(old.body).toMatch(/^The review passed, but GitHub's checks failed/);
    const [job] = s.queued();
    s.revised(job!, H2);
    s.gh.checks = checksOf([run('test', 'success', 12)]);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'passed' }]);
    // Nothing posted, and recorded as said: never looked for again.
    expect(s.ciComments()).toHaveLength(1);
    expect(s.pr()).toMatchObject({ ciSha: H2, ciState: 'passed', ciCommentSha: H2, ciCommentId: null });
    s.gh.calls.length = 0;
    await s.ci(true);
    expect(s.gh.calls.filter((c) => c.startsWith('listIssueComments') || c.startsWith('createIssueComment'))).toEqual([]);
    expect(s.ciComments()).toHaveLength(1);
  });

  it('never fixes a head the pull request moved on from, and drops a fix whose head moved', async () => {
    const s = setup();
    s.gh.checks = checksOf([FAILED_TEST]);
    await s.review('ready-to-merge');
    // GitHub already has a newer head: the old head's failure is not acted on.
    s.setHead(H2);
    expect(await s.ci()).toEqual([{ status: 'none' }]);
    expect(s.queued()).toEqual([]);
    expect(s.pr()).toMatchObject({ headSha: H2 });

    // A fix queued for H1 is canceled once the pull request is at H3.
    const t = setup();
    t.gh.checks = checksOf([FAILED_TEST]);
    await t.review('ready-to-merge');
    await t.ci();
    const [job] = t.queued();
    observeHead(t.db, REPO_ID, PR, H3, new Date(t.tick()).toISOString());
    expect(queuedRevisionProblem(t.config, t.db, job!)).toMatch(/failed checks were on 111111111111, but the pull request is now at 333333333333/);
  });

  it('passes a repository with no CI once the checks had time to register', async () => {
    const s = setup();
    s.gh.checks = checksOf([]);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'waiting', reason: expect.stringMatching(/no check has reported/) }]);
    s.tick(CI_REGISTER_GRACE_MS);
    expect(await s.ci()).toMatchObject([{ status: 'passed', reason: expect.stringMatching(/nothing to wait for/) }]);
    expect(s.gh.writes).toContain(`ready PR_node_${PR}`);
  });

  it('stops for a person on failures a code change cannot fix', async () => {
    const s = setup();
    s.gh.checks = checksOf([run('build', 'success', 1), run('deploy-gate', 'action_required', 2), run('e2e', 'cancelled', 3)]);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'blocked', reason: expect.stringMatching(/cannot fix: deploy-gate \(action_required\), e2e \(cancelled\).*approve/) }]);
    expect(s.queued()).toEqual([]);
    expect(s.stage()).toMatchObject({ stage: 'needs-human' });
    expect(s.ciComments()).toHaveLength(1);
    expect(s.ciComments()[0]!.body).toMatch(/^\*\*Updraft · CI · `[0-9a-f]{12}`\*\*\n\n\*\*Blocked by a failing check:\*\* `deploy-gate`, `e2e` did not pass on commit /m);
    expect(s.ciComments()[0]!.body).not.toMatch(/ready to merge|merge it yourself/i);
    // Final for that head, unless its checks pass there: a check event reads them, and nothing more happens.
    s.gh.calls.length = 0;
    const writes = s.gh.writes.length;
    expect(await s.ci(true)).toMatchObject([{ status: 'blocked' }]);
    expect(s.gh.calls).toEqual(['getPullRequest', `getCommitChecks ${H1}`]);
    expect(s.gh.writes.length).toBe(writes);
    expect(s.queued()).toEqual([]);
    // The polling worker reads them again only every CI_BLOCKED_POLL_MS.
    s.gh.calls.length = 0;
    await s.ci();
    expect(s.gh.calls).toEqual([]);
  });

  it('leaves out checks it is told to ignore, and decides by the configured ones', async () => {
    const s = setup({ ciFix: { ignore: ['preview-deploy'] } });
    s.gh.checks = checksOf([run('test', 'success', 1), run('preview-deploy', 'failure', 2)]);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'passed' }]);

    const t = setup({ ciFix: { checks: ['test'], waitMinutes: 10 } });
    t.gh.checks = checksOf([run('lint', 'failure', 1)]);
    await t.review('ready-to-merge');
    expect(await t.ci()).toMatchObject([{ status: 'waiting', reason: expect.stringMatching(/test have not reported/) }]);
    t.tick(10 * 60_000);
    expect(await t.ci()).toMatchObject([{ status: 'blocked', reason: expect.stringMatching(/test never reported/) }]);
  });

  it('gives up on checks that never finish, within waitMinutes', async () => {
    const s = setup({ ciFix: { waitMinutes: 5 } });
    s.gh.checks = checksOf([run('test', null, 1)]);
    await s.review('ready-to-merge');
    await s.ci();
    s.tick(5 * 60_000);
    expect(await s.ci()).toMatchObject([{ status: 'blocked', reason: expect.stringMatching(/gave up after waiting 5 minute\(s\).*still pending: test/) }]);
  });

  it('stops when the same failure comes back after a fix, and at maxRevisions', async () => {
    const s = setup();
    s.gh.checks = checksOf([FAILED_TEST]);
    s.gh.diagnostics[7] = DIAGNOSTICS;
    await s.review('ready-to-merge');
    await s.ci();
    const [job] = s.queued();
    s.revised(job!, H2);
    // The fix changed nothing about the failure (only the timing differs).
    s.gh.diagnostics[7] = { ...DIAGNOSTICS, logTail: DIAGNOSTICS.logTail.replace('12:00:02', '12:09:59') };
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'blocked', reason: expect.stringMatching(/in the same way as before the last automatic fix/) }]);
    expect(s.queued()).toEqual([]);

    const t = setup({ maxRevisions: 1 });
    t.gh.checks = checksOf([FAILED_TEST]);
    await t.review('ready-to-merge');
    await t.ci();
    t.revised(t.queued()[0]!, H2);
    t.gh.checks = checksOf([run('lint', 'failure', 9)]);
    await t.review('ready-to-merge');
    expect(await t.ci()).toMatchObject([{ status: 'blocked', reason: expect.stringMatching(/used its 1 revision\(s\) \(maxRevisions\)/) }]);
    expect(getReviewRequest(t.db, REPO_ID, ciFailureReviewId(PR, H2))).toMatchObject({ state: 'over-limit' });
    expect(t.stage()).toMatchObject({ stage: 'needs-human' });
  });

  it('keeps fixing when the same check fails in a new way, or when nothing of the failure was read', async () => {
    const generic = { path: '.github', line: null, level: 'failure', message: 'Process completed with exit code 1.', title: null };
    const logOf = (test: string) => `2026-11-18T12:00:00.0000000Z npm test\n2026-11-18T12:00:01.0000000Z FAIL ${test}\n2026-11-18T12:00:02.0000000Z ##[error]Process completed with exit code 1.`;
    const s = setup();
    s.gh.checks = checksOf([FAILED_TEST]);
    s.gh.diagnostics[7] = { annotations: [generic], logTail: logOf('widget.test.ts > adds'), problems: [] };
    await s.review('ready-to-merge');
    await s.ci();
    s.revised(s.queued()[0]!, H2);
    // Progress: the first test passes now and another one fails; only the runner's line is the same.
    s.gh.diagnostics[7] = { annotations: [generic], logTail: logOf('gadget.test.ts > removes'), problems: [] };
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'fixing' }]);
    s.revised(s.queued()[0]!, H3);
    // Nothing but the generic line was read: not taken for the same failure as the one before.
    s.gh.diagnostics[7] = { annotations: [generic], logTail: null, problems: [] };
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'fixing' }]);
  });

  it('only reports a failure when revise is off', async () => {
    const s = setup({ revise: false });
    s.gh.checks = checksOf([FAILED_TEST]);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'blocked', reason: expect.stringMatching(/Revisions are off/) }]);
    expect(s.queued()).toEqual([]);
  });

  it('waits for a revision that is already on its way instead of starting a second one', async () => {
    const s = setup();
    s.gh.checks = checksOf([FAILED_TEST]);
    await s.review('ready-to-merge');
    const pr = s.pr();
    const human = enqueueRevision(
      s.db,
      {
        repoId: REPO_ID,
        reviewId: 'PRR_human',
        prNumber: PR,
        reviewer: 'allen',
        trigger: 'changes_requested',
        reviewUrl: 'u',
        submittedAt: new Date(s.now()).toISOString(),
        job: revisionJob({ id: REPO_ID, fullName: FULL }, pr, {
          trigger: 'changes_requested',
          pullRequest: { number: PR, url: pr.prUrl, branch: pr.branch },
          sourceRunId: pr.sourceRunId,
          originalEventId: pr.originalEventId,
          review: { id: 'PRR_human', url: 'u', author: 'allen', submittedAt: '', body: 'rename it', comments: [], omittedComments: 0 },
        }),
        max: 3,
      },
      s.now,
    );
    expect(human.status).toBe('queued');
    expect(await s.ci()).toMatchObject([{ status: 'waiting', reason: expect.stringMatching(/is already on its way/) }]);
    expect(s.queued()).toHaveLength(1);
  });

  it('picks up where it left off after a restart, without a second revision', async () => {
    const s = setup();
    s.gh.checks = checksOf([FAILED_TEST]);
    await s.review('ready-to-merge');
    await s.ci();
    const [job] = s.queued();
    // A worker that died between queuing the revision and recording it on the PR.
    s.db.prepare('UPDATE revision_prs SET ci_state = NULL, ci_fix_job_id = NULL, ci_fixes = 0, ci_last_fix_signature = NULL').run();
    const restarted = { ...s.deps, api: s.gh.api };
    expect(await evaluateCiAll(restarted, undefined, { force: true })).toMatchObject([{ status: 'fixing', jobId: job!.id }]);
    expect(s.queued().map((j) => j.id)).toEqual([job!.id]);
    expect(s.pr()).toMatchObject({ ciState: 'fixing', ciFixJobId: job!.id });
  });

  it('tries again later when GitHub does not answer, and leaves nothing half done', async () => {
    const s = setup();
    s.gh.checks = checksOf([FAILED_TEST]);
    await s.review('ready-to-merge');
    s.gh.failNext.getCheckRunDiagnostics = new GitHubError('GET /check-runs/7/annotations failed: 502', 502);
    expect(await s.ci()).toEqual([{ status: 'none' }]);
    expect(s.queued()).toEqual([]);
    expect(await s.ci(true)).toMatchObject([{ status: 'fixing' }]);
  });

  it('runs after each poll as part of the review loop publisher', async () => {
    const s = setup();
    s.gh.checks = checksOf([FAILED_TEST]);
    await s.review('ready-to-merge');
    const publisher = createReviewLoopPublisher(s.deps);
    await publisher.retryDue();
    expect(s.queued()).toHaveLength(1);
    expect(s.ciComments()).toHaveLength(1);
  });

  it('is off unless ciFix is set: the verdict marks the draft ready as before', async () => {
    const s = setup({ ciFix: undefined });
    s.gh.checks = checksOf([FAILED_TEST]);
    await s.review('ready-to-merge');
    expect(s.gh.writes).toContain(`ready PR_node_${PR}`);
    s.gh.calls.length = 0;
    expect(await s.ci(true)).toEqual([]);
    expect(s.gh.calls).toEqual([]);
  });
});

describe('judgeChecks', () => {
  const settings = { checks: null, ignore: [], waitMs: 60 * 60_000 };
  it('counts skipped and neutral checks as not failing', () => {
    expect(judgeChecks(checksOf([run('a', 'success', 1), run('b', 'skipped', 2), run('c', 'neutral', 3)]), settings, H1, 0, 0)).toMatchObject({ action: 'pass' });
    expect(judgeChecks(checksOf([run('b', 'skipped', 2)]), settings, H1, 0, 0)).toMatchObject({ action: 'pass' });
  });
  it('treats commit statuses by state: failure is the code, error is not', () => {
    const status = (state: string): CheckDetail => ({ kind: 'status', name: 'ext', outcome: 'failure', conclusion: state, url: null });
    expect(judgeChecks(checksOf([status('failure')]), settings, H1, 0, 0)).toMatchObject({ action: 'fix' });
    expect(judgeChecks(checksOf([status('error')]), settings, H1, 0, 0)).toMatchObject({ action: 'block' });
  });
  it('never passes checks it could not read to the end', () => {
    expect(judgeChecks(checksOf([run('a', 'success', 1)], false), settings, H1, 0, 0)).toMatchObject({ action: 'wait' });
    expect(judgeChecks(checksOf([run('a', 'success', 1)], false), settings, H1, settings.waitMs, 0)).toMatchObject({ action: 'block' });
  });
  it('falls back to names when a client reports no details', () => {
    expect(judgeChecks({ total: 1, failing: ['t'], pending: [], succeeded: [], complete: true }, settings, H1, 0, 0)).toMatchObject({ action: 'fix', failures: [{ name: 't' }] });
  });
});

describe('diagnostics', () => {
  it('keeps the first error and the end of a long log, without timestamps', () => {
    const log = [
      ...Array.from({ length: 200 }, (_, i) => `2026-11-18T12:00:00.0000000Z setup ${i}`),
      '2026-11-18T12:00:01.0000000Z Error: cannot find module x',
      ...Array.from({ length: 200 }, (_, i) => `2026-11-18T12:00:02.0000000Z more ${i}`),
    ].join('\n');
    const out = logExcerpt(log);
    expect(out).toContain('Error: cannot find module x');
    expect(out).toContain('more 199');
    expect(out).not.toContain('setup 0');
    expect(out).not.toMatch(/2026-11-18T/);
    expect(logExcerpt('x'.repeat(10_000), 100)).toHaveLength(100);
  });
  it('redacts credential-shaped text', () => {
    expect(redactCi('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sk-abcdefghijklmnopqrstu')).not.toMatch(/ghp_abc|sk-abc/);
  });
  it('signs a failure by what failed, not by when or how long', () => {
    const a = [{ check: FAILED_TEST, diagnostics: DIAGNOSTICS }];
    const later = [{ check: FAILED_TEST, diagnostics: { ...DIAGNOSTICS, logTail: DIAGNOSTICS.logTail.replace(/12:00/g, '13:41') } }];
    const other = [{ check: FAILED_TEST, diagnostics: { ...DIAGNOSTICS, annotations: [{ ...DIAGNOSTICS.annotations[0]!, message: 'cannot read property x' }] } }];
    expect(failureSignature(later)).toBe(failureSignature(a));
    expect(failureSignature(other)).not.toBe(failureSignature(a));
  });
  it('signs a failure by its log, not by the runner\'s generic exit line', () => {
    const generic = { path: '.github', line: null, level: 'failure', message: 'Process completed with exit code 1.', title: null };
    const logOf = (body: string) => `2026-11-18T12:00:00.0000000Z npm test\n${body}\n2026-11-18T12:00:02.0000000Z ##[error]Process completed with exit code 1.`;
    const one = [{ check: FAILED_TEST, diagnostics: { annotations: [generic], logTail: logOf('FAIL a.test.ts > adds: expected 3 to be 4'), problems: [] } }];
    const two = [{ check: FAILED_TEST, diagnostics: { annotations: [generic], logTail: logOf('FAIL b.test.ts > removes: expected [] to be empty'), problems: [] } }];
    expect(failureSignature(one)).not.toBeNull();
    expect(failureSignature(two)).not.toBe(failureSignature(one));
    // Nothing read beyond the generic line, or nothing read at all: no fingerprint.
    expect(failureSignature([{ check: FAILED_TEST, diagnostics: { annotations: [generic], logTail: null, problems: [] } }])).toBeNull();
    expect(failureSignature([{ check: FAILED_TEST, diagnostics: null }])).toBeNull();
    expect(failureSignature([...one, { check: run('lint', 'failure', 8), diagnostics: null }])).toBeNull();
    expect(failureSignature([])).toBeNull();
  });
});

describe('check and status webhooks', () => {
  it('turn into a look at the pull request whose checks changed', async () => {
    const s = setup();
    await s.review('ready-to-merge');
    const deps = { api: s.gh.api, config: s.config, log: silentLogger, db: s.db };
    const repository = { id: REPO_ID, full_name: FULL };
    expect(
      await decideWebhook(deps, { eventName: 'check_suite', payload: { action: 'completed', repository, check_suite: { head_sha: H1, pull_requests: [{ number: 5 }, { number: PR }] } } }),
    ).toMatchObject({ dispatch: 'poll-reviews', pullRequest: PR });
    expect(await decideWebhook(deps, { eventName: 'check_run', payload: { action: 'completed', repository, check_run: { pull_requests: [{ number: PR }] } } })).toMatchObject({
      dispatch: 'poll-reviews',
      pullRequest: PR,
    });
    // A commit status names a commit only: the watched pull request with that head.
    expect(await decideWebhook(deps, { eventName: 'status', payload: { sha: H1, state: 'failure', repository } })).toMatchObject({ dispatch: 'poll-reviews', pullRequest: PR });
    expect(await decideWebhook(deps, { eventName: 'status', payload: { sha: H3, state: 'failure', repository } })).toMatchObject({ dispatch: false, reason: 'pull-request' });
    expect(await decideWebhook(deps, { eventName: 'check_suite', payload: { action: 'requested', repository, check_suite: {} } })).toMatchObject({ dispatch: false, reason: 'unsupported-action' });

    const off = setup({ ciFix: undefined });
    expect(
      await decideWebhook({ api: off.gh.api, config: off.config, log: silentLogger, db: off.db }, { eventName: 'check_suite', payload: { action: 'completed', repository, check_suite: { pull_requests: [{ number: PR }] } } }),
    ).toMatchObject({ dispatch: false, reason: 'review-loop-off' });
  });
});

describe('one re-run for a failure that cannot be the change\'s (docs/ci-fix.md, "One re-run")', () => {
  const RUN_ID = 900;
  /** A leg of a GitHub Actions matrix job: its check run is a job of workflow run RUN_ID. */
  const leg = (name: string, conclusion: string | null, id: number, runId = RUN_ID): CheckDetail =>
    run(name, conclusion, id, { url: `https://github.com/${FULL}/actions/runs/${runId}/job/${id}`, workflowRunId: runId });
  const FLAKY = {
    annotations: [],
    logTail: [
      '2026-11-18T12:00:00.0000000Z > vitest run',
      '2026-11-18T12:00:05.0000000Z  FAIL  src\\commands\\logs.test.ts > updraft logs > follows the newest run',
      '2026-11-18T12:00:05.0000000Z AssertionError: expected 1 to be 2',
      '2026-11-18T12:00:05.0000000Z  ❯ src/commands/logs.test.ts:88:21',
      '2026-11-18T12:00:06.0000000Z ##[error]Process completed with exit code 1.',
    ].join('\n'),
    problems: [],
  };
  const OUTSIDE = [{ path: 'cloud/server/src/app.ts', status: 'modified', patch: null }];
  const matrix = (windows22: string | null, windowsId = 2) =>
    checksOf([leg('ubuntu-latest / node 22', 'success', 1), leg('windows-latest / node 22', windows22, windowsId), leg('windows-latest / node 24', 'success', 3)]);
  const statusComment = async (s: ReturnType<typeof setup>) => {
    const c = await s.gh.api.createIssueComment({ id: REPO_ID, fullName: FULL }, ISSUE, renderStatusComment({ title: 'PR opened', text: `PR #${PR} opened`, mark: { key: 'job_x', stage: STATUS_STAGE.published, pr: PR } }));
    return () => s.gh.comments.find((x) => x.id === c.id)!.body;
  };

  for (const notifications of ['quiet', 'verbose'] as const) {
    it(`re-runs a flaky matrix leg once, and merges on its pass with no human step and no comment (${notifications})`, async () => {
      const s = setup({ autoMerge: 'squash', notifications });
      const status = await statusComment(s);
      s.gh.files = OUTSIDE;
      s.gh.checks = matrix('failure');
      s.gh.diagnostics[2] = FLAKY;
      await s.review('ready-to-merge');

      expect(await s.ci()).toMatchObject([{ status: 'waiting', reason: expect.stringMatching(/re-ran the failed jobs once/) }]);
      expect(s.gh.reruns).toEqual([RUN_ID]);
      expect(s.queued()).toEqual([]);
      // On record, per head: the timeline (`updraft status`, the run-event loop summary) and, quietly, the status comment.
      expect(s.pr()).toMatchObject({ ciRerunSha: H1, ciRerunAt: expect.any(String), ciRerunChecks: ['windows-latest / node 22'], ciRerunFiles: ['src/commands/logs.test.ts'] });
      expect(s.stage()).toMatchObject({ stage: 'waiting-for-ci', detail: expect.stringMatching(/re-ran the failed jobs once .*passed on another leg of its matrix \(ubuntu-latest \/ node 22\)/) });
      if (notifications === 'quiet') expect(status()).toContain('**Updraft · Re-running a failed check**');

      // The re-run is under way, then passes.
      s.gh.checks = matrix(null, 4);
      expect(await s.ci(true)).toMatchObject([{ status: 'waiting' }]);
      s.gh.checks = matrix('success', 4);
      expect(await s.ci(true)).toMatchObject([{ status: 'passed' }]);
      await evaluateAutoMerges(s.deps);
      expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
      expect(s.gh.reruns).toEqual([RUN_ID]);
      // Nothing posted on the pull request; quietly, the status comment says it merged.
      expect(s.gh.comments.filter((c) => c.issue === PR)).toEqual([]);
      if (notifications === 'quiet') expect(status()).toContain('**Updraft · Merged**');
    });
  }

  it('re-runs a failure whose log names only test files outside the diff, with no matrix leg to compare', async () => {
    const s = setup({ autoMerge: 'squash' });
    s.gh.files = OUTSIDE;
    s.gh.checks = checksOf([leg('test', 'failure', 2), leg('lint', 'success', 3)]);
    s.gh.diagnostics[2] = FLAKY;
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'waiting', reason: expect.stringMatching(/failed in src\/commands\/logs\.test\.ts, which this pull request does not touch/) }]);
    expect(s.gh.reruns).toEqual([RUN_ID]);
  });

  it('never re-runs a failure inside the diff: it goes to the CI fix', async () => {
    const s = setup({ autoMerge: 'squash' });
    s.gh.files = [...OUTSIDE, { path: 'src/commands/logs.test.ts', status: 'modified', patch: null }];
    s.gh.checks = matrix('failure');
    s.gh.diagnostics[2] = FLAKY;
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'fixing' }]);
    expect(s.gh.reruns).toEqual([]);
    expect(s.pr()).toMatchObject({ ciRerunSha: null, ciState: 'fixing' });
    expect(s.queued()).toHaveLength(1);
    expect(s.gh.writes).not.toContain(`rerun ${RUN_ID}`);
  });

  it('never re-runs when nothing shows the failure is not the change\'s, or the diff or the log cannot be read', async () => {
    // No matrix leg passed, and the log names no test file.
    const a = setup();
    a.gh.files = OUTSIDE;
    a.gh.checks = checksOf([leg('build', 'failure', 2)]);
    a.gh.diagnostics[2] = { annotations: [], logTail: 'error TS2345: Argument of type string\n##[error]Process completed with exit code 2.', problems: [] };
    await a.review('ready-to-merge');
    expect(await a.ci()).toMatchObject([{ status: 'fixing' }]);
    expect(a.gh.reruns).toEqual([]);

    // The diff could not be read.
    const b = setup();
    b.gh.files = OUTSIDE;
    b.gh.listPullRequestFiles = async () => {
      throw new GitHubError('GET /pulls/100/files failed: 403', 403);
    };
    b.gh.checks = matrix('failure');
    b.gh.diagnostics[2] = FLAKY;
    await b.review('ready-to-merge');
    expect(await b.ci()).toMatchObject([{ status: 'fixing' }]);
    expect(b.gh.reruns).toEqual([]);

    // Nothing of the failed job could be read.
    const c = setup();
    c.gh.files = OUTSIDE;
    c.gh.checks = matrix('failure');
    await c.review('ready-to-merge');
    expect(await c.ci()).toMatchObject([{ status: 'fixing' }]);
    expect(c.gh.reruns).toEqual([]);
  });

  it('re-runs at most once per head: a second failure goes to the CI fix', async () => {
    const s = setup({ autoMerge: 'squash' });
    s.gh.files = OUTSIDE;
    s.gh.checks = matrix('failure');
    s.gh.diagnostics[2] = FLAKY;
    await s.review('ready-to-merge');
    await s.ci();
    expect(s.gh.reruns).toEqual([RUN_ID]);
    s.gh.checks = matrix('failure', 4);
    s.gh.diagnostics[4] = FLAKY;
    expect(await s.ci(true)).toMatchObject([{ status: 'fixing' }]);
    expect(s.gh.reruns).toEqual([RUN_ID]);
    expect(s.queued()).toHaveLength(1);
  });

  it('asks for the re-run once even when GitHub refuses it, and then handles the failure as usual', async () => {
    const s = setup({ autoMerge: 'squash' });
    s.gh.files = OUTSIDE;
    s.gh.checks = matrix('failure');
    s.gh.diagnostics[2] = FLAKY;
    s.gh.failNext.rerunFailedJobs = new GitHubError('POST /actions/runs/900/rerun-failed-jobs failed: 403', 403);
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'fixing' }]);
    expect(s.gh.calls.filter((c) => c.startsWith('rerunFailedJobs'))).toEqual([`rerunFailedJobs ${RUN_ID}`]);
    expect(s.pr()).toMatchObject({ ciRerunSha: H1 });
  });

  it('reads the attempt it re-ran, still listed right after the re-run, as pending, not as the re-run failing', async () => {
    const s = setup({ autoMerge: 'squash' });
    s.gh.files = OUTSIDE;
    const failedAt = new Date(s.now() - 60_000).toISOString();
    const stale = () => checksOf([leg('ubuntu-latest / node 22', 'success', 1), { ...leg('windows-latest / node 22', 'failure', 2), completedAt: failedAt }, leg('windows-latest / node 24', 'success', 3)]);
    s.gh.checks = stale();
    s.gh.diagnostics[2] = FLAKY;
    await s.review('ready-to-merge');
    await s.ci();
    expect(s.gh.reruns).toEqual([RUN_ID]);

    // A webhook right after: GitHub has not created the new attempt yet.
    s.tick(5_000);
    expect(await s.ci(true)).toMatchObject([{ status: 'waiting', reason: expect.stringMatching(/waiting for the re-run of windows-latest \/ node 22/) }]);
    expect(s.queued()).toEqual([]);

    // The new attempt passes: merged as if it had passed the first time.
    s.gh.checks = matrix('success', 4);
    expect(await s.ci(true)).toMatchObject([{ status: 'passed' }]);
    await evaluateAutoMerges(s.deps);
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
    expect(s.gh.reruns).toEqual([RUN_ID]);
  });

  it('stops waiting for a re-run that never shows up, and handles the failure as usual', async () => {
    const s = setup({ autoMerge: 'squash' });
    s.gh.files = OUTSIDE;
    const failedAt = new Date(s.now() - 60_000).toISOString();
    s.gh.checks = checksOf([leg('ubuntu-latest / node 22', 'success', 1), { ...leg('windows-latest / node 22', 'failure', 2), completedAt: failedAt }, leg('windows-latest / node 24', 'success', 3)]);
    s.gh.diagnostics[2] = FLAKY;
    await s.review('ready-to-merge');
    await s.ci();
    s.tick(CI_REGISTER_GRACE_MS + 1_000);
    expect(await s.ci(true)).toMatchObject([{ status: 'fixing' }]);
    expect(s.gh.reruns).toEqual([RUN_ID]);
  });

  it('waits for the part of a re-run GitHub accepted when it refuses the rest', async () => {
    const s = setup({ autoMerge: 'squash' });
    s.gh.files = OUTSIDE;
    const OTHER_RUN = 901;
    s.gh.checks = checksOf([leg('test', 'failure', 2), leg('e2e', 'failure', 5, OTHER_RUN), leg('lint', 'success', 3)]);
    s.gh.diagnostics[2] = FLAKY;
    s.gh.diagnostics[5] = FLAKY;
    const original = s.gh.rerunFailedJobs.bind(s.gh);
    s.gh.rerunFailedJobs = async (repo, id) => {
      if (id === OTHER_RUN) throw new GitHubError(`POST /actions/runs/${id}/rerun-failed-jobs failed: 403`, 403);
      return original(repo, id);
    };
    await s.review('ready-to-merge');
    expect(await s.ci()).toMatchObject([{ status: 'waiting', reason: expect.stringMatching(/re-ran workflow run\(s\) 900 but refused 901/) }]);
    expect(s.gh.reruns).toEqual([RUN_ID]);
    expect(s.queued()).toEqual([]);
    expect(s.pr()).toMatchObject({ ciRerunSha: H1, ciState: 'waiting' });

    // The re-run's attempt fails again, with the refused run's failure still there: the CI fix, as usual.
    s.gh.checks = checksOf([leg('test', 'failure', 6), leg('e2e', 'failure', 5, OTHER_RUN), leg('lint', 'success', 3)]);
    s.gh.diagnostics[6] = FLAKY;
    expect(await s.ci(true)).toMatchObject([{ status: 'fixing' }]);
    expect(s.gh.reruns).toEqual([RUN_ID]);
  });

  for (const notifications of ['quiet', 'verbose'] as const) {
    it(`stops, after the re-run failed too, naming the check and why, never "ready to merge"; a re-run that passes later merges it (${notifications})`, async () => {
      const s = setup({ autoMerge: 'squash', notifications, revise: false });
      const status = await statusComment(s);
      s.gh.files = OUTSIDE;
      s.gh.checks = matrix('failure');
      s.gh.diagnostics[2] = FLAKY;
      await s.review('ready-to-merge');
      await s.ci();
      expect(s.gh.reruns).toEqual([RUN_ID]);
      s.gh.checks = matrix('failure', 4);
      s.gh.diagnostics[4] = FLAKY;
      expect(await s.ci(true)).toMatchObject([
        {
          status: 'blocked',
          reason: expect.stringMatching(
            /windows-latest \/ node 22 failed twice, before and after Updraft re-ran it in src\/commands\/logs\.test\.ts, which this pull request does not touch\. It looks unrelated to the change: re-run it or fix it on main, and Updraft merges once the checks pass on this commit$/,
          ),
        },
      ]);
      expect(s.gh.reruns).toEqual([RUN_ID]);
      const [notice] = s.ciComments();
      expect(notice).toBeDefined();
      expect(notice!.body).toContain('**Blocked by a failing check:** `windows-latest / node 22` did not pass');
      expect(notice!.body).toContain('which this pull request does not touch');
      for (const body of [notice!.body, status()]) expect(body).not.toMatch(/ready to merge|ready for a person to merge|merge it yourself/i);
      if (notifications === 'quiet') expect(status()).toContain('**Updraft · Blocked by a failing check**');
      expect(s.stage()).toMatchObject({ stage: 'needs-human' });

      // A person re-runs it on GitHub; the green check suite picks the merge up on the same head,
      // with the earlier notice for that commit on record and nothing posted again.
      s.gh.checks = matrix('success', 5);
      const comments = s.gh.comments.length;
      expect(await s.ci(true)).toMatchObject([{ status: 'passed' }]);
      await evaluateAutoMerges(s.deps);
      expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
      expect(s.gh.comments.length).toBe(comments);
      expect(s.gh.reruns).toEqual([RUN_ID]);
      if (notifications === 'quiet') expect(status()).toContain('**Updraft · Merged**');
    });
  }
});

describe('a merge blocked by a failing check, without the CI step', () => {
  for (const notifications of ['quiet', 'verbose'] as const) {
    it(`says it is blocked by the failing check, never "ready to merge", and merges once a re-run passes on the same head (${notifications})`, async () => {
      const s = setup({ autoMerge: 'squash', notifications, ciFix: undefined });
      const created = await s.gh.api.createIssueComment({ id: REPO_ID, fullName: FULL }, ISSUE, renderStatusComment({ title: 'PR opened', text: `PR #${PR} opened`, mark: { key: 'job_x', stage: STATUS_STAGE.published, pr: PR } }));
      const status = () => s.gh.comments.find((x) => x.id === created.id)!.body;
      s.gh.checks = checksOf([run('windows-latest / node 22', 'failure', 2), run('ubuntu-latest / node 22', 'success', 1)]);
      await s.review('ready-to-merge');
      s.tick();
      await evaluateAutoMerges(s.deps);
      await postMergeNotices(s.deps);
      expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeCode: 'checks-failed' });
      const notice = s.gh.comments.find((c) => c.issue === PR && c.body.includes(mergeBlockedMarker(H1)))!;
      expect(notice.body).toMatch(/^\*\*Blocked by a failing check:\*\* Updraft did not merge /);
      expect(notice.body).toContain('windows-latest / node 22');
      for (const body of [notice.body, status()]) expect(body).not.toMatch(/ready to merge|ready for a person to merge|merge it yourself/i);
      if (notifications === 'quiet') expect(status()).toContain('**Updraft · Blocked by a failing check**');

      // The check event of a re-run that passed: looked at now, merged, the blocked note not posted again.
      s.gh.checks = checksOf([run('windows-latest / node 22', 'success', 3), run('ubuntu-latest / node 22', 'success', 1)]);
      s.tick();
      await evaluateAutoMerges(s.deps, undefined, { only: { repoId: REPO_ID, prNumber: PR } });
      await postMergeNotices(s.deps);
      expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
      expect(s.gh.comments.filter((c) => c.body.includes(mergeBlockedMarker(H1)))).toHaveLength(1);
      if (notifications === 'quiet') expect(status()).toContain('**Updraft · Merged**');
    });
  }

  it('turns a check event into a look at a pull request whose merge is blocked on its checks, and at no other', async () => {
    const s = setup({ autoMerge: 'squash', ciFix: undefined });
    const deps = { api: s.gh.api, config: s.config, log: silentLogger, db: s.db };
    const event = { eventName: 'check_suite', payload: { action: 'completed', repository: { id: REPO_ID, full_name: FULL }, check_suite: { head_sha: H1, pull_requests: [{ number: PR }] } } };
    s.gh.checks = checksOf([run('test', 'failure', 2)]);
    await s.review('ready-to-merge');
    expect(await decideWebhook(deps, event)).toMatchObject({ dispatch: false, reason: 'review-loop-off' });
    s.tick();
    await evaluateAutoMerges(s.deps);
    expect(s.pr()).toMatchObject({ mergeState: 'blocked', mergeCode: 'checks-failed' });
    expect(await decideWebhook(deps, event)).toMatchObject({ dispatch: 'poll-reviews', pullRequest: PR });
  });
});

describe('telling a failure that cannot be the change\'s', () => {
  it('reads matrix legs by their names, and not shards', () => {
    expect(matrixKey('windows-latest / node 22')).toBe(matrixKey('ubuntu-latest / node 24'));
    expect(matrixKey('test (macos-14, 3.12)')).toBe(matrixKey('test (ubuntu-22.04, 3.11)'));
    expect(matrixKey('test (macos-14, 3.12)')).not.toBe(matrixKey('lint (macos-14, 3.12)'));
    expect(matrixKey('test')).toBeNull();
    expect(matrixKey('test (2/4)')).toBeNull();
  });

  it('reads the repository files a log and its annotations name, leaving dependencies and URLs out', () => {
    expect(
      namedFiles({
        annotations: [{ path: 'src/a.ts', line: 1, level: 'failure', message: 'x', title: null }],
        logTail: 'FAIL D:\\a\\repo\\repo\\src\\b.test.ts\n at node_modules/vitest/dist/x.js:1\n see https://example.com/c.ts\n at node:internal/process/task_queues:95\n##[error]failed',
        problems: [],
      }),
    ).toEqual(['src/a.ts', 'a/repo/repo/src/b.test.ts']);
    expect(namedFiles(null)).toEqual([]);
  });

  it('matches a named file against the diff by its repository path, or by name alone', () => {
    const diff = ['src/b.test.ts', 'cloud/x.ts'];
    expect(inDiff('/a/repo/repo/src/b.test.ts', diff)).toBe(true);
    expect(inDiff('b.test.ts', diff)).toBe(true);
    expect(inDiff('src\\b.test.ts', diff)).toBe(true);
    expect(inDiff('src/c.test.ts', diff)).toBe(false);
    expect(inDiff('lib/src/b.test.tsx', diff)).toBe(false);
  });

  it('decides a re-run only when every failure is re-runnable and outside the diff', () => {
    const a = { check: run('windows-latest / node 22', 'failure', 2, { workflowRunId: 1 }), diagnostics: { annotations: [], logTail: 'FAIL src/x.test.ts', problems: [] } };
    const other = run('windows-latest / node 24', 'success', 3, { workflowRunId: 1 });
    expect(decideRerun([a], [a.check, other], ['cloud/y.ts'])).toMatchObject({ rerun: true, runs: [1], checks: ['windows-latest / node 22'], files: ['src/x.test.ts'] });
    expect(decideRerun([a], [a.check, other], ['src/x.test.ts'])).toMatchObject({ rerun: false, why: expect.stringMatching(/which this pull request changes/) });
    expect(decideRerun([a], [a.check, other], null)).toMatchObject({ rerun: false });
    // A leg of another workflow run is not this job's leg; the log still names only a test outside the diff.
    expect(decideRerun([a], [a.check, { ...other, workflowRunId: 2 }], [])).toMatchObject({ rerun: true, why: expect.stringMatching(/does not touch/) });
    const status = { check: { kind: 'status' as const, name: 'ext', outcome: 'failure' as const, conclusion: 'failure', url: null }, diagnostics: null };
    expect(decideRerun([a, status], [a.check, other], [])).toMatchObject({ rerun: false, why: expect.stringMatching(/not a GitHub Actions job/) });
  });
});
