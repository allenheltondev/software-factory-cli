// The suggestion step of the review loop (review.suggestions, docs/review-loop.md "Suggestions"),
// below the agents: what a ready verdict with suggestions queues, how the suggestion revision's end
// is taken, and how every suggestion thread is closed, against a real state database and an
// in-memory GitHub. The runs are written into the database as the worker would have left them.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLoopGitHub } from '../../test/fake-loop-github.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { putHold, releaseHolds } from '../db/holds.js';
import { configSchema, suggestionMode, type UpdraftConfig, type UpdraftConfigInput } from '../config/schema.js';
import { validateConfig } from '../config/validate.js';
import { openDatabase, type Db } from '../db/database.js';
import { getLoopPr, HEAD_LAG_GRACE_MS, HEAD_LAG_LIMIT_MS, listCiCandidates, listMergeCandidates, MAX_REVIEW_REQUEUES, observeHead, prStage, scheduleAllReviews } from '../db/pr-reviews.js';
import { getJob } from '../db/queue.js';
import { getFinding, recordFindings } from '../db/review-findings.js';
import { countRevisions } from '../db/revisions.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { observeLiveHead } from '../poller/head-lag.js';
import { resolvePaths, type UpdraftPaths } from '../paths.js';
import { checkJobDispatchable } from '../poller/poller.js';
import { LAG_STUCK, lagStuckMarker, queuedReviewProblem } from '../poller/review-jobs.js';
import { queuedRevisionProblem } from '../poller/reviews.js';
import { suggestionsReviewId } from '../poller/review-trigger.js';
import { loopWaits } from '../poller/webhook.js';
import { revisionOf, reviewOf, type Job, type ReviewVerdict, type RunSummary } from '../types.js';
import { silentLogger } from '../util/log.js';
import { pendingWork } from '../worker/scope.js';
import { evaluateAutoMerges } from './merge.js';
import type { PublishDeps } from './publish.js';
import { createReviewLoopPublisher, postReview } from './review.js';
import { renderStatusComment } from './status-marker.js';
import { classify, evaluateSuggestionsAll, followUpMarker, queueSuggestions, renderFollowUp, SUGGEST_PUSH_WAIT_MS } from './suggestions.js';
import { answerFindings } from './threads.js';

const REPO_ID = 42;
const FULL = 'octo/widgets';
const PR = 100;
const ISSUE = 7;
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const PATCH = ['@@ -1,3 +1,4 @@', ' line1', '-old2', '+new2', '+new3', ' line4'].join('\n');

const dbs: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return { branch: 'b', baseSha: 'base', worktree: '/nowhere', commits: [], commitCount: 1, filesChanged: 1, diffStat: '1 file changed', untracked: 0, lastOutput: [], notes: [], ...over };
}

const structured = (data: unknown, prose = 'Looks right.') => `${prose}\n\n\`\`\`updraft-findings\n${JSON.stringify(data)}\n\`\`\`\nUPDRAFT-FINDINGS: 2`;
/** The two suggestions of PR #172: one on a line of the diff (an inline thread), one with no file (in the summary). */
const TWO = {
  findings: [
    { id: 'S1', severity: 'suggestion', title: 'The --outcome help text hard-codes the outcome list', path: 'src/a.ts', line: 3, problem: 'The list is typed out by hand.', suggestion: 'Build it from OUTCOMES.' },
    { id: 'S2', severity: 'suggestion', title: 'The empty-result message names the resolved issue', problem: 'It should name the PR number the user typed.' },
  ],
};

function setup(o: { repo?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'updraft-suggestions-'));
  dirs.push(root);
  const paths: UpdraftPaths = resolvePaths({ env: { UPDRAFT_HOME: root } });
  const raw = {
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
        autoMerge: 'squash',
        ...o.repo,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general', reviewPool: 'reviewers' }],
      },
    },
  } satisfies UpdraftConfigInput;
  const config: UpdraftConfig = configSchema.parse(raw);
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
  gh.files = [{ path: 'src/a.ts', status: 'modified', patch: PATCH }];
  let head = H1;
  gh.headSha = () => head;
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
  // The issue's live status comment, as the run's assignment left it.
  gh.comments.push({ id: 9_000, issue: ISSUE, user: gh.login, htmlUrl: `https://github.com/${FULL}/issues/${ISSUE}#issuecomment-9000`, body: renderStatusComment({ title: 'Pull request opened', text: `PR #${PR} is open.`, mark: { key: jobId, stage: 40, pr: PR } }) });

  const schedule = (): Job[] => {
    tick();
    return scheduleAllReviews(db, config, now);
  };
  let runs = 0;
  /** A reviewer run of the current head's job that ended with `verdict`, posted as the worker posts it. */
  const review = async (verdict: ReviewVerdict, findings: string) => {
    const [job] = schedule();
    expect(job, 'a reviewer job for the current head').toBeDefined();
    tick();
    const runId = `run_review_${++runs}`;
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome, summary)
       VALUES (?, ?, 1, ?, 'codex', 'wrk_0', ?, ?, ?, 'succeeded', ?)`,
    ).run(runId, job!.id, job!.pool, iso(), iso(), iso(), JSON.stringify(summary({ review: { headSha: reviewOf(job!)!.headSha, baseSha: null, verdict, findings } })));
    db.prepare("UPDATE jobs SET status = 'succeeded', attempts = 1, updated_at = ? WHERE id = ?").run(iso(), job!.id);
    const result = await postReview(deps, runId);
    return { runId, result };
  };
  /** Someone (or the suggestion revision's push) moves the PR: GitHub shows a new head. */
  const push = (sha: string) => {
    head = sha;
    gh.touch();
  };
  /**
   * The suggestion revision `jobId` ran: `pushed` the head it moved the branch to (its replies in
   * the threads posted as reviseRun posts them), or null for a run that changed nothing;
   * `outcome` failed for a run that failed.
   */
  const revise = async (jobId: string, o: { pushed: string | null; outcome?: 'succeeded' | 'failed'; resolutions?: RunSummary['resolutions'] }) => {
    tick();
    const runId = `run_revise_${++runs}`;
    const outcome = o.outcome ?? 'succeeded';
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome, summary)
       VALUES (?, ?, 1, 'general', 'claude', 'wrk_0', ?, ?, ?, ?, ?)`,
    ).run(runId, jobId, iso(), iso(), iso(), outcome, JSON.stringify(summary({ branch: `b-${runId}`, resolutions: o.resolutions ?? [] })));
    db.prepare('UPDATE jobs SET status = ?, attempts = 1, updated_at = ? WHERE id = ?').run(outcome, iso(), jobId);
    if (outcome !== 'succeeded') return runId;
    db.prepare(
      `INSERT INTO revisions (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, review_id, trigger_kind, state, branch, base_sha, head_sha, pushed_at,
                              attempts, created_at, updated_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'suggestions', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(runId, jobId, REPO_ID, FULL, ISSUE, PR, suggestionsReviewId(PR), o.pushed ? 'published' : 'skipped', branch, H1, o.pushed, o.pushed ? iso() : null, iso(), iso(), o.pushed ? null : 'the agent made no commits');
    if (o.pushed) {
      const request = revisionOf(getJob(db, jobId)!)!;
      await answerFindings(
        { db, api, now, guard: () => {}, repoFullName: FULL, runId },
        { repo: { id: REPO_ID, fullName: FULL }, prNumber: PR, runId, sha: o.pushed, prUrl: request.pullRequest.url, login: gh.login, findings: request.findings ?? [], resolutions: o.resolutions ?? [] },
      );
      push(o.pushed);
    }
    return runId;
  };
  const step = async () => {
    tick();
    return evaluateSuggestionsAll(deps);
  };
  const mergeStep = async () => {
    tick();
    await evaluateAutoMerges(deps);
  };
  const pr = () => getLoopPr(db, REPO_ID, PR)!;
  const suggestionJobs = () => (db.prepare("SELECT job_id FROM review_requests WHERE trigger_kind = 'suggestions' AND state = 'queued'").all() as { job_id: string }[]).map((r) => r.job_id);
  const status = () => gh.comments.find((c) => c.issue === ISSUE)!.body;
  const thread = (key: string) => {
    const root = getFinding(db, REPO_ID, PR, key)!;
    return { root, replies: root.commentId ? gh.thread(root.commentId) : [], resolved: root.commentId ? gh.resolved.has(root.commentId) : false };
  };
  return { db, config, gh, deps, now, tick, schedule, review, push, revise, step, mergeStep, pr, suggestionJobs, status, thread, branch };
}

describe('review.suggestions', () => {
  it('defaults to address wherever review is on, and takes follow-up and ignore', () => {
    const repo = { publish: 'draft-pr', review: true } as const;
    expect(suggestionMode({ execution: { mode: 'live' } } as UpdraftConfig, repo)).toBe('address');
    expect(suggestionMode({ execution: { mode: 'live' } } as UpdraftConfig, { publish: 'draft-pr', review: { allowSameAgent: false, suggestions: 'follow-up' } })).toBe('follow-up');
    expect(suggestionMode({ execution: { mode: 'live' } } as UpdraftConfig, { publish: 'draft-pr', review: false })).toBeNull();
    expect(suggestionMode({ execution: { mode: 'log-only' } } as UpdraftConfig, repo)).toBeNull();
    const base = (suggestions: unknown, revise = true) => ({
      version: 1,
      execution: { mode: 'live' },
      agents: { claude: {}, codex: {} },
      pools: { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
      actions: { a: { prompt: './p.md', revisePrompt: './r.md', reviewPrompt: './v.md' } },
      dispatch: { allowedActors: ['allen'] },
      repositories: { [FULL]: { id: 1, checkoutPath: './c', publish: 'draft-pr', revise, review: { suggestions }, workflows: [{ trigger: { event: 'issue.labeled', label: 'x' }, action: 'a', pool: 'general', reviewPool: 'reviewers' }] } },
    });
    for (const mode of ['address', 'follow-up', 'ignore']) expect(validateConfig(base(mode))).toMatchObject({ ok: true });
    expect(validateConfig(base('sometimes'))).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: `repositories.${FULL}.review` })] });
    expect(validateConfig(base('address', false))).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.objectContaining({ path: `repositories.${FULL}.review.suggestions` })]) });
  });
});

describe('the suggestion step', () => {
  it.each([['verbose'], ['quiet']] as const)(
    'address (%s): a ready review with suggestions queues exactly one suggestion revision; the new head is reviewed, and only it is merged, with every thread resolved',
    async (notifications) => {
      const s = setup({ repo: { notifications } });
      // A person's own thread, which nothing here may touch.
      s.gh.reviewComments.push({ id: 7_000, reviewId: 1, inReplyToId: null, user: 'allen', body: 'nit: rename this', path: 'src/a.ts', htmlUrl: 'human' });
      const first = await s.review('ready-to-merge', structured(TWO));
      expect(first.result).toMatchObject({ status: 'published', review: { verdict: 'ready-to-merge', outcome: 'ready' } });
      const [jobId] = s.suggestionJobs();
      expect(s.suggestionJobs()).toHaveLength(1);
      const revision = revisionOf(getJob(s.db, jobId!)!)!;
      expect(revision).toMatchObject({ trigger: 'suggestions', reviewedSha: H1, review: { id: suggestionsReviewId(PR), headSha: H1 } });
      expect(revision.findings!.map((f) => [f.key, f.severity])).toEqual([
        [`${first.runId}#S1`, 'suggestion'],
        [`${first.runId}#S2`, 'suggestion'],
      ]);
      expect(first.result.status === 'published' && first.result.review.revisionJobId).toBe(jobId);
      // It counts against maxRevisions.
      expect(countRevisions(s.db, REPO_ID, PR)).toBe(1);
      expect(s.pr()).toMatchObject({ suggestState: 'fixing', suggestSha: H1, suggestJobId: jobId });
      expect(prStage(s.db, s.pr(), 3, { suggestions: true })).toMatchObject({ stage: 'revising', detail: expect.stringMatching(/queued for them/) });

      // Nothing merges, and no checks are read, while it is on its way; asking again queues nothing more.
      expect(listMergeCandidates(s.db, REPO_ID, { requireSuggestions: true })).toEqual([]);
      expect(listCiCandidates(s.db, REPO_ID, { requireSuggestions: true })).toEqual([]);
      await s.mergeStep();
      expect(s.gh.merges).toEqual([]);
      expect(await s.step()).toEqual([{ status: 'waiting', reason: expect.stringMatching(/is queued/) }]);
      expect(await postReview(s.deps, first.runId)).toMatchObject({ status: 'published', already: true });
      expect(s.suggestionJobs()).toEqual([jobId]);
      // A posting retried after it queued the revision finds that same job.
      expect(queueSuggestions(s.deps, { id: REPO_ID, fullName: FULL }, s.config.repositories[FULL]!, s.pr(), { reviewUrl: 'u', worker: 'updraft-bot' })).toMatchObject({ status: 'queued', jobId });
      expect(s.suggestionJobs()).toEqual([jobId]);
      // Quiet: the status comment says so; nothing on the pull request either way.
      if (notifications === 'quiet') expect(s.status()).toContain('**Updraft · Addressing suggestions**');
      else expect(s.status()).not.toContain('Addressing suggestions');

      // The revision applies S1 and declines S2, and pushes H2.
      await s.revise(jobId!, {
        pushed: H2,
        resolutions: [
          { finding: `${first.runId}#S1`, status: 'fixed', note: 'Built from OUTCOMES.', tests: 'npm test: ok' },
          { finding: `${first.runId}#S2`, status: 'disagreed', note: 'The resolved issue is what the user needs to see.', tests: null },
        ],
      });
      // The new head is reviewed: ready, S1 verified.
      const second = await s.review('ready-to-merge', structured({ findings: [], checks: [{ finding: `${first.runId}#S1`, status: 'verified', note: 'Built from the list now.' }] }));
      expect(second.result).toMatchObject({ status: 'published', review: { outcome: 'ready', headSha: H2 } });
      // No second suggestion revision, ever.
      expect(s.suggestionJobs()).toEqual([jobId]);
      // S1 was verified, and its thread resolved, by the review itself; S2 is what is left: declined.
      expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/^0 fixed, 1 declined, 0 deferred/) }]);
      await s.mergeStep();
      expect(s.gh.merges).toEqual([{ sha: H2, method: 'squash' }]);

      // fixed: its thread names the commit and is resolved. declined: the reason, resolved. No follow-up issue.
      const s1 = s.thread(`${first.runId}#S1`);
      expect(s1.replies.map((r) => r.body).join('\n')).toContain(`Fixed in [${H2.slice(0, 12)}]`);
      expect(s1.resolved).toBe(true);
      expect(s1.root).toMatchObject({ status: 'verified', statusSha: H2 });
      // S2 was in the summary only (no file): answered in the revision's comment, settled as declined.
      expect(s.thread(`${first.runId}#S2`).root).toMatchObject({ settledAs: 'declined', resolution: 'disagreed' });
      expect(s.gh.issues).toEqual([]);
      // The person's thread: no reply, not resolved.
      expect(s.gh.thread(7_000)).toEqual([]);
      expect(s.gh.resolved.has(7_000)).toBe(false);
      // No comment on the pull request from any of this.
      expect(s.gh.comments.filter((c) => c.issue === PR)).toEqual([]);
    },
  );

  it('budget spent: merges the ready head and files one follow-up issue that lists every suggestion with its file, line and thread, linked from each thread', async () => {
    const s = setup({ repo: { maxRevisions: 1, autoMerge: undefined } });
    // The one revision this pull request gets is used by a change request.
    await s.review('changes-requested', 'Blockers:\n- a.ts:3 is wrong');
    expect(countRevisions(s.db, REPO_ID, PR)).toBe(1);
    s.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE envelope LIKE '%changes_requested%'").run();
    s.push(H2);
    observeHead(s.db, REPO_ID, PR, H2, new Date(s.tick()).toISOString());
    const ready = await s.review('ready-to-merge', structured(TWO));
    expect(ready.result).toMatchObject({ review: { outcome: 'ready' } });
    expect(s.suggestionJobs()).toEqual([]);
    // Settled before anything else: no limit comment, no status comment on the PR.
    expect(listCiCandidates(s.db, REPO_ID, { requireSuggestions: true })).toEqual([]);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/2 deferred to #500 \(the pull request had used its 1 revision\(s\) \(maxRevisions\)\)/) }]);
    expect(s.gh.issues).toHaveLength(1);
    const issue = s.gh.issues[0]!;
    expect(issue.title).toBe(`Follow-up to #${PR}: review suggestions not applied`);
    const s1 = s.thread(`${ready.runId}#S1`);
    expect(issue.body).toContain(`- [ ] **The --outcome help text hard-codes the outcome list** · \`src/a.ts\` line 3 ([thread](${s1.root.commentUrl}))`);
    expect(issue.body).toContain('- [ ] **The empty-result message names the resolved issue**');
    expect(issue.body).toContain('## Acceptance criteria');
    expect(issue.body).toContain('add the label `updraft:ready` to this issue');
    expect(issue.body).toContain(followUpMarker(REPO_ID, PR));
    // Each thread the worker started links it and is resolved.
    expect(s1.replies.map((r) => r.body).join('\n')).toContain(`Deferred to the follow-up issue #500 (${issue.htmlUrl})`);
    expect(s1.resolved).toBe(true);
    expect(s.pr()).toMatchObject({ suggestState: 'settled', suggestIssueNumber: 500 });
    expect(s.gh.comments.filter((c) => c.issue === PR)).toEqual([]);
    expect(s.gh.writes.filter((w) => w.startsWith('comment #'))).toEqual([]);
    expect(prStage(s.db, s.pr(), 1, { suggestions: true })).toMatchObject({ stage: 'ready-to-merge' });

    // Asked again (a redelivered event, a restart): nothing more.
    expect(await s.step()).toEqual([]);
    expect(s.gh.issues).toHaveLength(1);
    expect(s.gh.thread(s1.root.commentId!)).toHaveLength(1);

    // A person pushes; the new head is ready with one more suggestion. The state database lost the
    // issue's number: the issue is found again by its marker, and lists all three. Still one issue.
    s.db.prepare('UPDATE revision_prs SET suggest_issue_number = NULL, suggest_issue_url = NULL').run();
    s.push(H3);
    observeHead(s.db, REPO_ID, PR, H3, new Date(s.tick()).toISOString());
    await s.review('ready-to-merge', structured({ findings: [{ id: 'S3', severity: 'suggestion', title: 'Name the flag in the error', problem: 'Say --outcome.' }] }));
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/1 deferred to #500/) }]);
    expect(s.gh.issues).toHaveLength(1);
    expect(s.gh.issues[0]!.body).toContain('Name the flag in the error');
    expect(s.gh.issues[0]!.body).toContain('The --outcome help text hard-codes the outcome list');
    expect(s.gh.writes.filter((w) => w.startsWith('open issue'))).toEqual(['open issue #500']);
  });

  it('follow-up: no revision; one follow-up issue, every thread resolved, and the merge goes on', async () => {
    const s = setup({ repo: { review: { suggestions: 'follow-up' } } });
    const ready = await s.review('ready-to-merge', structured(TWO));
    expect(s.suggestionJobs()).toEqual([]);
    await s.mergeStep();
    expect(s.gh.merges, 'not before the suggestions are settled').toEqual([]);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/0 fixed, 0 declined, 2 deferred to #500 \(review\.suggestions is follow-up/) }]);
    expect(s.thread(`${ready.runId}#S1`).resolved).toBe(true);
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
    expect(countRevisions(s.db, REPO_ID, PR)).toBe(0);
  });

  it('ignore: today\'s behaviour, threads left open, no issue, and the merge does not wait', async () => {
    const s = setup({ repo: { review: { suggestions: 'ignore' } } });
    const ready = await s.review('ready-to-merge', structured(TWO));
    expect(s.suggestionJobs()).toEqual([]);
    expect(await s.step()).toEqual([]);
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
    expect(s.thread(`${ready.runId}#S1`)).toMatchObject({ replies: [], resolved: false });
    expect(s.gh.issues).toEqual([]);
  });

  it('a suggestion revision that pushes nothing: the declined one gets the reason, the deferred one the follow-up, and the ready head merges', async () => {
    const s = setup({ repo: { notifications: 'quiet' } });
    const ready = await s.review('ready-to-merge', structured(TWO));
    const [jobId] = s.suggestionJobs();
    await s.revise(jobId!, {
      pushed: null,
      resolutions: [
        { finding: `${ready.runId}#S1`, status: 'disagreed', note: 'The list is generated at build time already.', tests: null },
        { finding: `${ready.runId}#S2`, status: 'deferred', note: 'It needs the CLI parser changed.', tests: null },
      ],
    });
    expect(pendingWork(s.db, s.config, null, s.now).notices).toBeGreaterThan(0);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/0 fixed, 1 declined, 1 deferred to #500 \(the revision for the suggestions .* ended without changing/) }]);
    const s1 = s.thread(`${ready.runId}#S1`);
    expect(s1.replies.map((r) => r.body)).toEqual([expect.stringContaining('**Coding agent:** Not changed: I disagree. The list is generated at build time already.')]);
    expect(s1.resolved).toBe(true);
    expect(s.gh.issues[0]!.body).toContain('Coding agent: It needs the CLI parser changed.');
    // Back to ready on the status comment, then the merge of the head the reviewer found ready.
    expect(s.status()).toContain('**Updraft · Ready to merge**');
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
    expect(s.gh.comments.filter((c) => c.issue === PR)).toEqual([]);
  });

  it('a suggestion revision that fails never holds the ready head back by more than that one attempt', async () => {
    const s = setup();
    const ready = await s.review('ready-to-merge', structured(TWO));
    const [jobId] = s.suggestionJobs();
    await s.revise(jobId!, { pushed: null, outcome: 'failed' });
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/2 deferred to #500/) }]);
    expect(s.thread(`${ready.runId}#S1`).resolved).toBe(true);
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
    expect(s.suggestionJobs()).toEqual([jobId]);
  });

  it('a stale head: a person\'s push drops the queued suggestion revision; the new head gets no second one and no second issue', async () => {
    const s = setup();
    const ready = await s.review('ready-to-merge', structured(TWO));
    const [jobId] = s.suggestionJobs();
    s.push(H3);
    observeHead(s.db, REPO_ID, PR, H3, new Date(s.tick()).toISOString());
    expect(queuedRevisionProblem(s.config, s.db, getJob(s.db, jobId!)!)).toMatch(/the suggestions were made on 111111111111, but the pull request is now at 333333333333; they are stale/);
    s.db.prepare("UPDATE jobs SET status = 'canceled', status_reason = 'stale' WHERE id = ?").run(jobId!);
    // The old head is not settled, filed or merged.
    expect(await s.step()).toEqual([]);
    expect(s.gh.issues).toEqual([]);
    await s.review('ready-to-merge', structured({ findings: [], checks: [] }));
    expect(s.suggestionJobs()).toEqual([jobId]);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/2 deferred to #500 \(this pull request already had its one revision for suggestions\)/) }]);
    expect(await s.step()).toEqual([]);
    expect(s.gh.issues).toHaveLength(1);
    expect(s.thread(`${ready.runId}#S1`).resolved).toBe(true);
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H3, method: 'squash' }]);
  });

  it('settles nothing on a head GitHub no longer shows', async () => {
    const s = setup({ repo: { review: { suggestions: 'follow-up' } } });
    await s.review('ready-to-merge', structured(TWO));
    // GitHub moved on before the step: nothing is filed or resolved for the old head.
    s.push(H2);
    expect(await s.step()).toEqual([{ status: 'none' }]);
    expect(s.gh.issues).toEqual([]);
    expect(s.pr().headSha).toBe(H2);
  });

  it('classifies a fixed claim the reviewer found unfixed on that same head as deferred, and an unchallenged one as fixed', () => {
    const f = { status: 'unresolved', statusSha: H2, resolution: 'fixed', resolutionSha: H2, resolutionNote: 'done' } as never;
    expect(classify(f, new Map())).toMatchObject({ as: 'deferred' });
    expect(classify({ ...(f as object), status: 'open' } as never, new Map())).toMatchObject({ as: 'fixed' });
    expect(classify({ ...(f as object), status: 'unresolved', statusSha: H1 } as never, new Map())).toMatchObject({ as: 'fixed' });
    expect(classify({ status: 'open', resolution: null, key: 'k' } as never, new Map([['k', { status: 'disagreed', note: 'no' }]]))).toMatchObject({ as: 'declined', note: 'no', unanswered: true });
  });

  it('a suggestion never blocks for good: a GitHub that keeps failing lets the head through after the attempts', async () => {
    const s = setup({ repo: { review: { suggestions: 'follow-up' } } });
    await s.review('ready-to-merge', structured(TWO));
    s.gh.failAlways.openIssue = new GitHubError('POST /issues failed: 502', 502);
    for (let i = 0; i < 4; i++) expect(await s.step()).toEqual([{ status: 'waiting', reason: expect.stringMatching(/502/) }]);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/502/) }]);
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
  });

  it('as the worker\'s publisher: the step runs after each poll, before the checks and the merge', async () => {
    const s = setup({ repo: { review: { suggestions: 'follow-up' } } });
    await s.review('ready-to-merge', structured(TWO));
    const publisher = createReviewLoopPublisher(s.deps);
    s.tick();
    await publisher.retryDue();
    expect(s.gh.issues).toHaveLength(1);
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
    expect(s.gh.writes.indexOf('open issue #500')).toBeLessThan(s.gh.writes.indexOf(`merge #${PR} squash at ${H1}`));
  });
});

describe('the suggestion step, when things go wrong', () => {
  it('releases the head when the suggestion revision\'s push was abandoned mid-attempt: an expired lease with no attempts left is not pending', async () => {
    const s = setup();
    await s.review('ready-to-merge', structured(TWO));
    const [jobId] = s.suggestionJobs();
    await s.revise(jobId!, { pushed: null });
    // The fifth attempt died mid-push: still "publishing", its lease long gone, and nothing retries it.
    s.db.prepare("UPDATE revisions SET state = 'publishing', attempts = 5, lease_expires_at = '2026-01-01T00:00:00.000Z' WHERE job_id = ?").run(jobId!);
    expect(pendingWork(s.db, s.config, null, s.now).notices).toBeGreaterThan(0);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/2 deferred to #500/) }]);
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
    // One the worker will still retry by itself is waited for.
    const t = setup();
    await t.review('ready-to-merge', structured(TWO));
    const [job2] = t.suggestionJobs();
    await t.revise(job2!, { pushed: null });
    t.db.prepare("UPDATE revisions SET state = 'publishing', attempts = 5, lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE job_id = ?").run(job2!);
    expect(await t.step()).toEqual([{ status: 'waiting', reason: 'the suggestion revision is being pushed' }]);
  });

  // #197: the suggestion revision pushed H2, and nothing ever reviewed it.
  const pushedUnseen = async (repo: Record<string, unknown> = {}) => {
    const s = setup({ repo });
    await s.review('ready-to-merge', structured(TWO));
    const [jobId] = s.suggestionJobs();
    await s.revise(jobId!, { pushed: H2 });
    // GitHub had not caught up with the push: its pull request still names H1.
    s.push(H1);
    return { s, jobId: jobId! };
  };
  const MOVED = (from: string, to: string) => `the head of pull request #${PR} moved from ${from.slice(0, 12)} to ${to.slice(0, 12)}; the new head gets its own review`;
  const reviewJobsOf = (s: ReturnType<typeof setup>, sha: string) =>
    s.db.prepare('SELECT id, status, event_id FROM jobs WHERE event_id LIKE ? ORDER BY created_at, rowid').all(`pr-review:${PR}:${sha}%`) as Array<{ id: string; status: string; event_id: string }>;

  /** The same client, unable to read a branch's git ref: the grace alone decides. */
  const withoutRefs = (api: GitHubApi) => new Proxy(api, { get: (target, prop) => (prop === 'getBranchSha' ? undefined : Reflect.get(target, prop)) });

  it('#197: a read of the pull request that has not caught up with the worker\'s own push neither moves the head back nor cancels the review of the pushed head; the branch ref tells it from a real move', async () => {
    const { s } = await pushedUnseen();
    const check = (api: GitHubApi = s.gh.api) => checkJobDispatchable({ api, config: s.config, db: s.db, now: s.now }, job!);
    // The push is the head on record, and its review is queued.
    const [job] = s.schedule();
    expect(reviewOf(job!)!.headSha).toBe(H2);
    expect(s.pr().headSha).toBe(H2);
    // The pull request still shows H1, its branch is at H2: GitHub has not caught up.
    s.gh.branchSha = () => H2;
    expect(observeHead(s.db, REPO_ID, PR, H1, new Date(s.tick()).toISOString())).toBe(false);
    expect(await observeLiveHead({ db: s.db, api: s.gh.api }, { id: REPO_ID, fullName: FULL }, s.pr(), H1, new Date(s.tick()).toISOString())).toBe(false);
    expect(s.pr().headSha).toBe(H2);
    expect(queuedReviewProblem(s.config, s.db, job!)).toBeNull();
    // The pre-start check leaves the job queued, as a wait, not an error; for as long as the ref says so.
    expect(await check()).toEqual({ ok: false, retry: true, reason: expect.stringMatching(/still shows 111111111111.*its branch is at 222222222222: GitHub has not caught up yet/) });
    s.tick(HEAD_LAG_GRACE_MS * 3);
    expect(await check()).toMatchObject({ ok: false, retry: true });

    // The branch is really at H1 (a person pushed it back): believed at once.
    const { s: t } = await pushedUnseen();
    const [job2] = t.schedule();
    expect(await checkJobDispatchable({ api: t.gh.api, config: t.config, db: t.db, now: t.now }, job2!)).toEqual({ ok: false, reason: MOVED(H2, H1) });
    expect(await observeLiveHead({ db: t.db, api: t.gh.api }, { id: REPO_ID, fullName: FULL }, t.pr(), H1, new Date(t.tick()).toISOString())).toBe(true);
    expect(t.pr().headSha).toBe(H1);

    // A client that cannot read the ref: a wait within HEAD_LAG_GRACE_MS of the push, a move after it.
    const { s: u } = await pushedUnseen();
    const [job3] = u.schedule();
    const bare = withoutRefs(u.gh.api);
    const check3 = () => checkJobDispatchable({ api: bare, config: u.config, db: u.db, now: u.now }, job3!);
    expect(await check3()).toMatchObject({ ok: false, retry: true, reason: expect.stringMatching(/less than 5 minutes ago/) });
    expect(await observeLiveHead({ db: u.db, api: bare }, { id: REPO_ID, fullName: FULL }, u.pr(), H1, new Date(u.tick()).toISOString())).toBe(false);
    u.tick(HEAD_LAG_GRACE_MS);
    expect(await check3()).toEqual({ ok: false, reason: MOVED(H2, H1) });
    expect(observeHead(u.db, REPO_ID, PR, H1, new Date(u.tick()).toISOString())).toBe(true);

    // A push dated after now (a clock that ran ahead) does not stretch the grace.
    const { s: v } = await pushedUnseen();
    const [job4] = v.schedule();
    v.db.prepare("UPDATE revisions SET pushed_at = '2099-01-01T00:00:00.000Z' WHERE head_sha = ?").run(H2);
    expect(await checkJobDispatchable({ api: withoutRefs(v.gh.api), config: v.config, db: v.db, now: v.now }, job4!)).toEqual({ ok: false, reason: MOVED(H2, H1) });
  });

  it('#199: a pull request whose GitHub head never catches up with the push stops waiting after HEAD_LAG_LIMIT_MS: one please-act comment, and the job is canceled as lag_stuck', async () => {
    const { s } = await pushedUnseen();
    const [job] = s.schedule();
    const check = () => checkJobDispatchable({ api: s.gh.api, config: s.config, db: s.db, now: s.now }, job!);
    // The branch is at the push for good; GitHub's pull request never shows it.
    s.gh.branchSha = () => H2;
    expect(await check()).toMatchObject({ ok: false, retry: true });
    // The poller does not take the lagging read for a move, however old the push is: the ref decides.
    s.tick(HEAD_LAG_GRACE_MS * 2);
    expect(await observeLiveHead({ db: s.db, api: s.gh.api }, { id: REPO_ID, fullName: FULL }, s.pr(), H1, new Date(s.tick()).toISOString())).toBe(false);
    expect(s.pr().headSha).toBe(H2);
    expect(queuedReviewProblem(s.config, s.db, job!)).toBeNull();
    // Still within the cap: waiting, and nothing said on GitHub.
    s.tick(HEAD_LAG_LIMIT_MS - HEAD_LAG_GRACE_MS * 2 - 60_000);
    expect(await check()).toMatchObject({ ok: false, retry: true });
    expect(s.gh.comments.filter((c) => c.body.includes(lagStuckMarker(H2)))).toEqual([]);

    // A transient failure to say so leaves the job queued (the check rejects), and it is tried again.
    s.tick(60_000);
    s.gh.failNext.createIssueComment = new GitHubError('unavailable', 503);
    await expect(check()).rejects.toThrow(/unavailable/);
    const stuck = await check();
    expect(stuck).toEqual({ ok: false, reason: expect.stringMatching(new RegExp(`^${LAG_STUCK}: .*did not catch up within ${HEAD_LAG_LIMIT_MS / 60_000} minutes`)) });
    expect(stuck).not.toHaveProperty('retry');
    const notices = s.gh.comments.filter((c) => c.body.includes(lagStuckMarker(H2)));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ issue: PR, body: expect.stringContaining("GitHub has not updated pull request #100 to the commit Updraft pushed") });
    expect(notices[0]!.body).toContain('re-run the review');
    expect(notices[0]!.body).toContain('push a commit');
    // Said once per pushed head, however often it is checked.
    expect(await check()).toMatchObject({ ok: false });
    expect(s.gh.comments.filter((c) => c.body.includes(lagStuckMarker(H2)))).toHaveLength(1);

    // Recorded: the job is canceled with that reason, the stage says a person is needed, and nothing queues it again.
    s.db.prepare("UPDATE jobs SET status = 'canceled', status_reason = ? WHERE id = ?").run((stuck as { reason: string }).reason, job!.id);
    expect(prStage(s.db, s.pr(), 3, { suggestions: true })).toMatchObject({ stage: 'needs-human', detail: expect.stringContaining(LAG_STUCK) });
    expect(s.schedule()).toEqual([]);

    // A push dated after now (a clock that ran ahead) is not waited for either.
    const { s: v } = await pushedUnseen();
    const [job2] = v.schedule();
    v.gh.branchSha = () => H2;
    v.db.prepare("UPDATE revisions SET pushed_at = '2099-01-01T00:00:00.000Z' WHERE head_sha = ?").run(H2);
    expect(await checkJobDispatchable({ api: v.gh.api, config: v.config, db: v.db, now: v.now }, job2!)).toEqual({ ok: false, reason: expect.stringMatching(new RegExp(`^${LAG_STUCK}: `)) });
  });

  it('#199: without ciFix, a check suite is worth a run only for a stuck shape: not while a run that is still going has the head\'s review or revision queued or running', async () => {
    const s = setup();
    await s.review('ready-to-merge', structured(TWO));
    const [jobId] = s.suggestionJobs();
    const live = () => putHold(s.db, { job: jobId! }, { holder: 'wrk_live', delivery: 'd-live', until: new Date(s.now() + 3_600_000).toISOString() });
    // The suggestion revision is queued: held by a live run, that run carries the loop on.
    expect(s.pr()).toMatchObject({ headSha: H1, suggestState: 'fixing', suggestJobId: jobId });
    live();
    expect(loopWaits(s.db, REPO_ID, PR, s.now())).toBe(false);
    s.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId!);
    expect(loopWaits(s.db, REPO_ID, PR, s.now())).toBe(false);
    // Its hold expired (the run is gone) with the job left queued: worth a run again.
    s.db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(jobId!);
    expect(loopWaits(s.db, REPO_ID, PR, s.now() + 2 * 3_600_000)).toBe(true);
    releaseHolds(s.db, 'wrk_live', new Date(s.now()).toISOString());
    expect(loopWaits(s.db, REPO_ID, PR, s.now())).toBe(true);
    // The revision ended with a push the pull request does not show: the head it was for is not reviewed again, and it waits.
    const { s: t } = await pushedUnseen();
    expect(t.pr()).toMatchObject({ headSha: H1, suggestState: 'fixing' });
    expect(loopWaits(t.db, REPO_ID, PR, t.now())).toBe(true);
    // The push's review queued by a run that is still going: nothing to start; once that run is over, a run again.
    const [review] = t.schedule();
    expect(reviewOf(review!)!.headSha).toBe(H2);
    putHold(t.db, { job: review!.id }, { holder: 'wrk_live', delivery: 'd-live', until: new Date(t.now() + 3_600_000).toISOString() });
    expect(loopWaits(t.db, REPO_ID, PR, t.now())).toBe(false);
    releaseHolds(t.db, 'wrk_live', new Date(t.now()).toISOString());
    expect(loopWaits(t.db, REPO_ID, PR, t.now())).toBe(true);
    // Canceled as "moved" (#197): a stuck shape, worth a run.
    t.db.prepare("UPDATE jobs SET status = 'canceled', status_reason = ? WHERE id = ?").run(MOVED(H2, H1), review!.id);
    expect(loopWaits(t.db, REPO_ID, PR, t.now())).toBe(true);
  });

  it('#197: a review of the pushed head that was canceled as "moved" while that head is the head is queued again, at most MAX_REVIEW_REQUEUES times; a cancel for any other reason is final', async () => {
    const { s } = await pushedUnseen();
    const [job] = s.schedule();
    // What happened on PR #195: the pre-start check read H1 and canceled the review of H2.
    const cancel = (id: string, reason: string) => s.db.prepare("UPDATE jobs SET status = 'canceled', status_reason = ? WHERE id = ?").run(reason, id);
    cancel(job!.id, MOVED(H2, H1));
    expect(prStage(s.db, s.pr(), 3, { suggestions: true })).toMatchObject({ stage: 'needs-human', detail: expect.stringContaining(job!.id) });
    for (let n = 1; n <= MAX_REVIEW_REQUEUES; n++) {
      const [again] = s.schedule();
      expect(again).toMatchObject({ eventId: `pr-review:${PR}:${H2}:requeue:${n}`, envelope: { review: { headSha: H2 } } });
      expect(prStage(s.db, s.pr(), 3, { suggestions: true })).toMatchObject({ stage: 'awaiting-review' });
      expect(s.schedule()).toEqual([]);
      cancel(again!.id, MOVED(H2, H1));
    }
    expect(s.schedule()).toEqual([]);
    expect(reviewJobsOf(s, H2)).toHaveLength(1 + MAX_REVIEW_REQUEUES);

    // A person's cancel, or a move that was real (the head on record is not that commit), is final.
    const { s: t } = await pushedUnseen();
    const [other] = t.schedule();
    t.db.prepare("UPDATE jobs SET status = 'canceled', status_reason = 'canceled by allen' WHERE id = ?").run(other!.id);
    expect(t.schedule()).toEqual([]);
    t.db.prepare('UPDATE jobs SET status_reason = ? WHERE id = ?').run(MOVED(H2, H3), other!.id);
    t.push(H3);
    observeHead(t.db, REPO_ID, PR, H3, new Date(t.tick(HEAD_LAG_GRACE_MS)).toISOString());
    expect(t.schedule().map((j) => reviewOf(j)!.headSha)).toEqual([H3]);
    expect(reviewJobsOf(t, H2)).toHaveLength(1);
  });

  it('#197: a suggestion revision whose push the pull request never shows is waited for at most SUGGEST_PUSH_WAIT_MS; then the branch ref decides: it moves on to the push, or releases the head', async () => {
    // The head on record never took the push (no schedule ran): the step waits, for a while.
    const { s } = await pushedUnseen({ notifications: 'quiet' });
    expect(s.pr()).toMatchObject({ headSha: H1, suggestState: 'fixing' });
    expect(await s.step()).toEqual([{ status: 'waiting', reason: `the suggestion revision pushed ${H2.slice(0, 12)}` }]);
    s.tick(SUGGEST_PUSH_WAIT_MS - 10_000);
    expect(await s.step()).toEqual([{ status: 'waiting', reason: `the suggestion revision pushed ${H2.slice(0, 12)}` }]);
    expect(s.status()).toContain('**Updraft · Addressing suggestions**');
    // Then the branch ref decides. It is at H1: the push is not there, so the suggestions are
    // settled on H1, which goes on to its merge.
    s.tick(10_000);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/pushed 222222222222, which is not on the pull request: its branch is still at 111111111111/) }]);
    expect(s.status()).not.toContain('Addressing suggestions');
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);

    // The pull request still shows H1 (it lags), its branch is at H2: it moves on to H2, which is reviewed; H1 is not merged.
    const t = (await pushedUnseen({ notifications: 'quiet' })).s;
    t.gh.branchSha = () => H2;
    t.tick(SUGGEST_PUSH_WAIT_MS);
    expect(await t.step()).toEqual([{ status: 'none' }]);
    expect(t.pr().headSha).toBe(H2);
    expect(t.schedule().map((j) => reviewOf(j)!.headSha)).toEqual([H2]);
    await t.mergeStep();
    expect(t.gh.merges).toEqual([]);
    expect(t.gh.issues).toEqual([]);

    // A push dated after now (a clock that ran ahead) is not waited for: the ref decides at once.
    const u = (await pushedUnseen({ notifications: 'quiet' })).s;
    u.db.prepare("UPDATE revisions SET pushed_at = '2099-01-01T00:00:00.000Z' WHERE head_sha = ?").run(H2);
    expect(await u.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/which is not on the pull request/) }]);
  });

  it('#197: released on the head the suggestion revision revised, a suggestion it reported fixed in its push that never landed is not "fixed": it is deferred to the follow-up issue', async () => {
    const s = setup({ repo: { notifications: 'quiet' } });
    const first = await s.review('ready-to-merge', structured(TWO));
    const [jobId] = s.suggestionJobs();
    // The revision fixes both and pushes H2; then the branch is pushed back to H1 (or H2 never shows).
    await s.revise(jobId!, {
      pushed: H2,
      resolutions: [
        { finding: `${first.runId}#S1`, status: 'fixed', note: 'Built from OUTCOMES.', tests: null },
        { finding: `${first.runId}#S2`, status: 'fixed', note: 'Names the PR.', tests: null },
      ],
    });
    s.push(H1);
    s.tick(SUGGEST_PUSH_WAIT_MS);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/^0 fixed, 0 declined, 2 deferred to #500 \(the revision for the suggestions .* pushed 222222222222, which is not on the pull request/) }]);
    expect(s.gh.issues).toHaveLength(1);
    expect(s.gh.issues[0]!.body).toContain('reported fixed in 222222222222, a commit that never reached the pull request');
    expect(s.gh.issues[0]!.body).toContain('The --outcome help text hard-codes the outcome list');
    expect(s.gh.issues[0]!.body).toContain('The empty-result message names the resolved issue');
    // The inline thread: after the revision's own "Fixed in" reply, the deferral to the issue, and resolved.
    const s1 = s.thread(`${first.runId}#S1`);
    expect(s1.replies.at(-1)!.body).toContain(`Deferred to the follow-up issue #500`);
    expect(s1.resolved).toBe(true);
    expect(s1.root).toMatchObject({ settledAs: 'deferred' });
    expect(s.thread(`${first.runId}#S2`).root).toMatchObject({ settledAs: 'deferred' });
    await s.mergeStep();
    expect(s.gh.merges).toEqual([{ sha: H1, method: 'squash' }]);
  });

  /** follow-up mode, H1 ready with TWO and settled into issue #500; then H2 ready with one more suggestion, not settled yet. */
  const secondHead = async () => {
    const s = setup({ repo: { review: { suggestions: 'follow-up' }, autoMerge: undefined } });
    await s.review('ready-to-merge', structured(TWO));
    await s.step();
    expect(s.gh.issues.map((i) => i.number)).toEqual([500]);
    s.push(H2);
    observeHead(s.db, REPO_ID, PR, H2, new Date(s.tick()).toISOString());
    await s.review('ready-to-merge', structured({ findings: [{ id: 'S3', severity: 'suggestion', title: 'Name the flag in the error', problem: 'Say --outcome.' }] }));
    return s;
  };

  it('never adopts an issue someone else opened, whatever marker it carries and whatever the listing returned', async () => {
    const s = await secondHead();
    s.db.prepare('UPDATE revision_prs SET suggest_issue_number = NULL, suggest_issue_url = NULL').run();
    s.gh.issues.length = 0;
    s.gh.issues.push({ number: 400, title: 'x', body: `bait ${followUpMarker(REPO_ID, PR)}`, htmlUrl: 'https://github.com/octo/widgets/issues/400', state: 'open', labels: [], isPullRequest: false, user: 'mallory' });
    s.gh.creatorFilterIgnored = true;
    await s.step();
    expect(s.gh.issues.find((i) => i.number === 400)!.body).toBe(`bait ${followUpMarker(REPO_ID, PR)}`);
    expect(s.gh.writes.filter((w) => w.startsWith('edit issue'))).toEqual([]);
    expect(s.pr().suggestIssueNumber).toBe(501);
    expect(s.gh.issues.find((i) => i.number === 501)!.body).toContain('Name the flag in the error');
  });

  it.each([
    ['closed', (s: Awaited<ReturnType<typeof secondHead>>) => void (s.gh.issues[0]!.state = 'closed')],
    ['deleted', (s: Awaited<ReturnType<typeof secondHead>>) => void (s.gh.issues[0]!.gone = 404)],
    ['taken up (it carries the trigger label)', (s: Awaited<ReturnType<typeof secondHead>>) => void s.gh.issues[0]!.labels.push('updraft:ready')],
  ])('opens a new follow-up issue when the recorded one is %s, and never edits it', async (_what, change) => {
    const s = await secondHead();
    const before = s.gh.issues[0]!.body;
    change(s);
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/1 deferred to #501/) }]);
    expect(s.gh.issues[0]!.body).toBe(before);
    expect(s.gh.writes.filter((w) => w.startsWith('edit issue'))).toEqual([]);
    // The new one lists what was deferred now, not what the first one already has.
    const fresh = s.gh.issues.find((i) => i.number === 501)!;
    expect(fresh.body).toContain('Name the flag in the error');
    expect(fresh.body).not.toContain('The --outcome help text');
    expect(s.pr()).toMatchObject({ suggestIssueNumber: 501, suggestState: 'settled' });
    expect(getFinding(s.db, REPO_ID, PR, 'run_review_2#S3')).toMatchObject({ settledAs: 'deferred', settledIssue: 501 });
  });

  it('opens a new one in the same attempt when the edit finds the issue gone', async () => {
    const s = await secondHead();
    s.gh.updateIssueBody = async () => {
      throw new GitHubError('PATCH /issues/500 failed: 410 Gone', 410);
    };
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/1 deferred to #501/) }]);
    expect(s.pr().suggestAttempts).toBe(0);
  });

  it('edits an open, untaken follow-up issue to list every suggestion deferred to it', async () => {
    const s = await secondHead();
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/1 deferred to #500/) }]);
    expect(s.gh.issues).toHaveLength(1);
    expect(s.gh.issues[0]!.body).toContain('The --outcome help text');
    expect(s.gh.issues[0]!.body).toContain('Name the flag in the error');
  });

  it('settles every suggestion past the 50 a reviewer is shown, into the follow-up issue', async () => {
    const s = setup({ repo: { review: { suggestions: 'follow-up' } } });
    // One review lists at most 50 findings: the rest were left by an earlier round.
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `S${from + i}`, severity: 'suggestion' as const, title: `Suggestion number ${from + i}`, problem: 'p', suggestion: null, path: null, location: null, sameAs: null, notes: [] }));
    recordFindings(s.db, { repoId: REPO_ID, prNumber: PR, runId: 'run_earlier', headSha: H1, reviewId: null, findings: many(41, 20) });
    await s.review('ready-to-merge', structured({ findings: many(1, 40) }));
    expect(await s.step()).toEqual([{ status: 'settled', reason: expect.stringMatching(/60 deferred to #500/) }]);
    expect(s.gh.issues[0]!.body).toContain('Suggestion number 60');
    await s.mergeStep();
    expect(s.gh.merges).toHaveLength(1);
  });
});

describe('the follow-up issue', () => {
  it('is inert: an agent\'s text cannot mention anyone or forge a marker', () => {
    const body = renderFollowUp({
      repoId: REPO_ID,
      prNumber: PR,
      prUrl: `https://github.com/${FULL}/pull/${PR}`,
      issueNumber: ISSUE,
      label: 'updraft:ready',
      reason: 'review.suggestions is follow-up for this repository',
      items: [
        {
          finding: { key: 'r#S1', title: '@octocat <!-- updraft-suggestions-followup: 1#2 -->', problem: 'Closes #1, cc @octocat', suggestion: null, path: null, line: null, commentUrl: null } as never,
          note: null,
        },
      ],
    });
    expect(body).not.toContain('@octocat');
    expect(body.match(/<!-- updraft-suggestions-followup/g)).toHaveLength(1);
    expect(body.endsWith(followUpMarker(REPO_ID, PR))).toBe(true);
  });
});
