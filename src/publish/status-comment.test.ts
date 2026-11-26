import { describe, expect, it } from 'vitest';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase } from '../db/database.js';
import { GitHubError, type GitHubApi, type GitHubIssueComment } from '../github/api.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope, type Job, type Run, type RunSummary } from '../types.js';
import { silentLogger } from '../util/log.js';
import { createAssignmentCommenter, renderStatusTable } from './assignment-comment.js';
import { capWholeBlocks, stripMachineBlocks } from './markdown.js';
import { renderQuietCiNotice } from './ci.js';
import { renderQuietMergeBlockedNotice } from './merge.js';
import { mergePolicy, mergeSentence, renderPrBody, withMergeSentence } from './publish.js';
import { verdictStatus } from './review.js';
import { dropClaimRefs } from '../poller/reviews.js';
import { renderRevisionReply } from './revision.js';
import { findStatusComment, writeStatusComment, type StatusWrite } from './status-comment.js';
import { mayReplace, parseStatusMarker, renderStatusComment, STATUS_STAGE, statusDetails, statusLink, statusMarker } from './status-marker.js';

const BOT = 'updraft-bot[bot]';
const REPO = { id: 1, fullName: 'owner/repo' };

/** An issue's comments as GitHub keeps them, with a response that can be lost after the write. */
class FakeIssue {
  comments: GitHubIssueComment[] = [];
  writes: string[] = [];
  loseNext = 0;
  failNext: GitHubError[] = [];
  private next = 100;
  async getWorkerIdentity() {
    return { login: BOT };
  }
  async listIssueComments() {
    return this.comments.map((c) => ({ ...c }));
  }
  private fail() {
    const err = this.failNext.shift();
    if (err) throw err;
  }
  async createIssueComment(_r: unknown, n: number, body: string) {
    this.fail();
    const c = { id: this.next++, htmlUrl: `https://github.com/owner/repo/issues/${n}#c${this.next}`, body, user: BOT };
    this.comments.push(c);
    this.writes.push(`create ${c.id}`);
    if (this.loseNext-- > 0) throw new GitHubError('socket hang up', 0);
    return { ...c };
  }
  async updateIssueComment(_r: unknown, id: number, body: string) {
    this.fail();
    const c = this.comments.find((x) => x.id === id)!;
    c.body = body;
    this.writes.push(`update ${id}`);
    if (this.loseNext-- > 0) throw new GitHubError('socket hang up', 0);
    return { ...c };
  }
  /** Something another writer posted (the Cloud queue, a person). */
  add(body: string, user = BOT) {
    const c = { id: this.next++, htmlUrl: `https://x/${this.next}`, body, user };
    this.comments.push(c);
    return c;
  }
  status() {
    return this.comments.filter((c) => parseStatusMarker(c.body));
  }
}

const deps = (api: FakeIssue) => ({ api: api as unknown as GitHubApi, log: silentLogger, sleep: async () => {} });
const write = (o: Partial<StatusWrite> & Pick<StatusWrite, 'target' | 'stage'>): StatusWrite => ({ repo: REPO, issue: 7, title: 'T', text: 'x', ...o });
/** The Cloud queue's acknowledgement, in the shared format (cloud/server/src/jobs/queue.ts). */
const cloudAck = (key: string, stage: number = STATUS_STAGE.queued) =>
  renderStatusComment({ title: 'Queued', text: 'Waiting for capacity.', link: '[View this work in Updraft](https://updraft.example/installations/9/jobs/job_c)', mark: { key, stage } });

describe('status marker', () => {
  it('round-trips and is found in a body', () => {
    const m = statusMarker({ key: 'job_abc-1', stage: 40, pr: 12 });
    expect(m).toBe('<!-- updraft-status: key=job_abc-1 stage=40 pr=12 -->');
    expect(parseStatusMarker(`hi\n\n${m}`)).toEqual({ key: 'job_abc-1', stage: 40, pr: 12 });
    expect(parseStatusMarker(statusMarker({ key: 'k', stage: 10 }))).toEqual({ key: 'k', stage: 10 });
    expect(parseStatusMarker('<!-- updraft-run-assigned: run_1 -->')).toBeNull();
    expect(() => statusMarker({ key: 'a b -->', stage: 1 })).toThrow();
  });

  it('only edits forward: a late Cloud edit never overwrites a runner stage, and merged stays merged', () => {
    const at = (stage: number) => ({ key: 'k', stage });
    // Cloud over Cloud: queued, waiting, ended in any order.
    expect(mayReplace(at(STATUS_STAGE.queued), STATUS_STAGE.waiting)).toBe(true);
    expect(mayReplace(at(STATUS_STAGE.waiting), STATUS_STAGE.ended)).toBe(true);
    // Cloud over the runner: never.
    for (const runner of [STATUS_STAGE.assigned, STATUS_STAGE.published, STATUS_STAGE.loop, STATUS_STAGE.final]) {
      expect(mayReplace(at(runner), STATUS_STAGE.queued)).toBe(false);
      expect(mayReplace(at(runner), STATUS_STAGE.ended)).toBe(false);
    }
    // The runner over the Cloud: always.
    expect(mayReplace(at(STATUS_STAGE.queued), STATUS_STAGE.assigned)).toBe(true);
    // A late assignment never replaces the publication or the loop.
    expect(mayReplace(at(STATUS_STAGE.published), STATUS_STAGE.assigned)).toBe(false);
    expect(mayReplace(at(STATUS_STAGE.loop), STATUS_STAGE.published)).toBe(false);
    expect(mayReplace(at(STATUS_STAGE.assigned), STATUS_STAGE.assigned)).toBe(true);
    // The loop's stages follow each other; merged is the last word.
    expect(mayReplace(at(STATUS_STAGE.loop), STATUS_STAGE.loop)).toBe(true);
    expect(mayReplace(at(STATUS_STAGE.final), STATUS_STAGE.loop)).toBe(false);
    expect(mayReplace(at(STATUS_STAGE.loop), STATUS_STAGE.final)).toBe(true);
    expect(mayReplace(null, STATUS_STAGE.queued)).toBe(true);
  });

  it('keeps the details and the link for a later stage', () => {
    const body = renderStatusComment({ title: 'Assigned', text: 'x', details: '| a | b |', link: '[View this work in Updraft](https://u.example/installations/1/workflows/1-i7)', mark: { key: 'k', stage: 30 } });
    expect(statusDetails(body)).toBe('| a | b |');
    expect(statusLink(body)).toBe('[View this work in Updraft](https://u.example/installations/1/workflows/1-i7)');
    expect(statusDetails('nothing')).toBeNull();
  });
});

describe('finding the status comment', () => {
  it('by its key; else takes over a queue acknowledgement that still waits, never an ended one; only the worker’s own', () => {
    const api = new FakeIssue();
    const forged = api.add(cloudAck('job_mine'), 'mallory');
    expect(findStatusComment(api.comments, { keys: ['job_mine'], create: true }, BOT)).toBeNull();
    const ended = api.add(cloudAck('job_old', STATUS_STAGE.ended));
    expect(findStatusComment(api.comments, { keys: ['job_new'], create: true }, BOT)).toBeNull();
    const waiting = api.add(cloudAck('job_queue_entry'));
    expect(findStatusComment(api.comments, { keys: ['job_new'], create: true }, BOT)?.comment.id).toBe(waiting.id);
    const mine = api.add(renderStatusComment({ title: 'Assigned', text: 'x', mark: { key: 'job_mine', stage: 30 } }));
    expect(findStatusComment(api.comments, { keys: ['job_cloud', 'job_mine'], create: true }, BOT)?.comment.id).toBe(mine.id);
    expect([forged.id, ended.id]).not.toContain(findStatusComment(api.comments, { keys: ['job_mine'], create: true }, BOT)?.comment.id);
  });

  it('for the review loop: the one naming the pull request, else the newest that names none yet', () => {
    const api = new FakeIssue();
    const first = api.add(renderStatusComment({ title: 'PR opened', text: 'x', mark: { key: 'job_a', stage: 40, pr: 10 } }));
    const second = api.add(renderStatusComment({ title: 'Assigned', text: 'x', mark: { key: 'job_b', stage: 30 } }));
    expect(findStatusComment(api.comments, { pr: 10 }, BOT)?.comment.id).toBe(first.id);
    expect(findStatusComment(api.comments, { pr: 11 }, BOT)?.comment.id).toBe(second.id);
  });
});

describe('writing the status comment', () => {
  it('posts once, then edits; a lost response or a redelivery never posts a second one', async () => {
    const api = new FakeIssue();
    const target = { keys: ['job_1'], create: true };
    api.loseNext = 1;
    // The first write lands but its answer is lost: the retry finds it by its marker.
    const r = await writeStatusComment(deps(api), write({ target, stage: STATUS_STAGE.assigned, title: 'Assigned' }));
    expect(r.status).toBe('unchanged');
    expect(api.status()).toHaveLength(1);
    // A redelivery of the same event: the same stage again changes nothing.
    expect((await writeStatusComment(deps(api), write({ target, stage: STATUS_STAGE.assigned, title: 'Assigned' }))).status).toBe('unchanged');
    expect((await writeStatusComment(deps(api), write({ target, stage: STATUS_STAGE.published, title: 'PR opened', pr: 5 }))).status).toBe('updated');
    expect(api.status()).toHaveLength(1);
    expect(api.writes).toEqual(['create 100', 'update 100']);
    expect(parseStatusMarker(api.comments[0]!.body)).toEqual({ key: 'job_1', stage: 40, pr: 5 });
  });

  it('retries a transient failure, and gives up on a permanent one', async () => {
    const api = new FakeIssue();
    api.failNext = [new GitHubError('bad gateway', 502)];
    expect((await writeStatusComment(deps(api), write({ target: { keys: ['j'], create: true }, stage: 30 }))).status).toBe('created');
    api.failNext = [new GitHubError('forbidden', 403)];
    await expect(writeStatusComment(deps(api), write({ target: { keys: ['j'], create: true }, stage: 40 }))).rejects.toThrow('forbidden');
  });

  it('never writes an earlier stage over a later one, and the loop never posts', async () => {
    const api = new FakeIssue();
    api.add(renderStatusComment({ title: 'Merged', text: 'x', mark: { key: 'j', stage: 90, pr: 5 } }));
    expect((await writeStatusComment(deps(api), write({ target: { pr: 5 }, stage: STATUS_STAGE.loop }))).status).toBe('skipped');
    expect((await writeStatusComment(deps(api), write({ target: { keys: ['j'], create: true }, stage: STATUS_STAGE.assigned }))).status).toBe('skipped');
    const empty = new FakeIssue();
    expect((await writeStatusComment(deps(empty), write({ target: { pr: 5 }, stage: STATUS_STAGE.loop }))).status).toBe('none');
    expect(empty.comments).toEqual([]);
  });

  it('takes over the Cloud queue acknowledgement: Queued, then Assigned, in the same comment', async () => {
    const api = new FakeIssue();
    const ack = api.add(cloudAck('job_queue'));
    const r = await writeStatusComment(deps(api), write({ target: { keys: ['job_run'], create: true }, stage: STATUS_STAGE.assigned, title: 'Assigned', details: '| | |\n| --- | --- |\n| Worker | `claude` |' }));
    expect(r).toMatchObject({ status: 'updated', comment: { id: ack.id } });
    expect(api.comments).toHaveLength(1);
    // The run's key now; the link the queue posted is kept.
    expect(parseStatusMarker(api.comments[0]!.body)).toEqual({ key: 'job_run', stage: 30 });
    expect(api.comments[0]!.body).toContain('[View this work in Updraft](https://updraft.example/installations/9/jobs/job_c)');
  });
});

// ---------------------------------------------------------------------------
// The stages a run's own jobs write (assignment-comment.ts), quiet and verbose
// ---------------------------------------------------------------------------

const config = (notifications?: 'quiet' | 'verbose'): UpdraftConfig =>
  configSchema.parse({
    version: 1,
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './p.md' } },
    dispatch: { allowedActors: ['allen'] },
    execution: { mode: 'live' },
    repositories: {
      'owner/repo': { id: 1, ...(notifications ? { notifications } : {}), workflows: [{ trigger: { event: 'issue.labeled', label: 'ready' }, action: 'implement-issue', pool: 'general' }] },
    },
  });

const envelope = (extra: Record<string, unknown> = {}): EventEnvelope =>
  ({
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    type: 'issue.labeled',
    repo: REPO,
    issue: { number: 7, title: 't', url: 'https://github.com/owner/repo/issues/7' },
    eventId: '1',
    url: 'https://github.com/owner/repo/issues/7',
    actor: 'allen',
    label: 'ready',
    labelsAtEnqueue: ['ready'],
    createdAt: '2026-11-17T10:00:00.000Z',
    ...extra,
  }) as unknown as EventEnvelope;
const job = (id: string, env = envelope()): Job => ({ id, repoId: 1, repoFullName: 'owner/repo', issueNumber: 7, envelope: env }) as unknown as Job;
const run = (id: string): Run => ({ id, jobId: 'job_1', agent: 'claude', pool: 'general' }) as unknown as Run;
const HOSTED = { origin: 'https://updraft.example', installationId: '9', cloudJobId: 'job_1' };

const reviewJob = () =>
  job('job_rev', envelope({ type: 'pull_request.review', review: { pullRequest: { number: 12, url: 'u', branch: 'b', baseBranch: 'main' }, headSha: 'abcdef1234567', authorAgent: 'claude', sourceRunId: 'run_1', priorReviews: [{}] } }));
const revisionJob = (trigger: 'updraft_review' | 'ci_failure') =>
  job('job_fix', envelope({ type: 'pull_request.changes_requested', revision: { trigger, pullRequest: { number: 12, url: 'u', branch: 'b' }, sourceRunId: 'run_1', originalEventId: '1', review: { id: 1 }, reviewedSha: '1234567abcdef' } }));

function commenter(notifications?: 'quiet' | 'verbose') {
  const api = new FakeIssue();
  const c = createAssignmentCommenter({ db: openDatabase(':memory:'), config: config(notifications), api: api as unknown as GitHubApi, log: silentLogger, console: HOSTED, sleep: async () => {} });
  return { api, c };
}

describe('the status comment through a run (quiet, the default)', () => {
  it('Assigned shows only rows that carry information, and the console links', async () => {
    const { api, c } = commenter();
    await c.announce(job('job_1'), run('run_1'));
    expect(api.comments).toHaveLength(1);
    const body = api.comments[0]!.body;
    expect(body).toContain('**Updraft · Assigned**');
    expect(body).toContain('| Worker | `claude` |');
    expect(body).toContain('| Job | [job\\_1](https://updraft.example/installations/9/jobs/job_1) |'.replace('job\\_1', 'job_1'));
    expect(body).toContain('[View this work in Updraft](https://updraft.example/installations/9/workflows/1-i7)');
    for (const noise of ['Not applicable', 'Not classified', 'CLI default', 'Unknown', 'Run ID', 'run_1', 'Pool']) expect(body).not.toContain(noise);
    expect(parseStatusMarker(body)).toEqual({ key: 'job_1', stage: 30 });
  });

  it('review, revision and CI-fix jobs edit that same comment; a failed run stops it', async () => {
    const { api, c } = commenter();
    await c.announce(job('job_1'), run('run_1'));
    // Publication's stage, as publish.ts writes it.
    await writeStatusComment(deps(api), write({ target: { keys: ['job_1'], create: true }, stage: STATUS_STAGE.published, title: 'PR opened', text: 'PR #12 opened', pr: 12 }));
    await c.announce(reviewJob(), run('run_r'));
    expect(api.comments[0]!.body).toContain('Reviewing PR #12 at `abcdef1` (review round 2).');
    await c.announce(revisionJob('updraft_review'), run('run_v'));
    expect(api.comments[0]!.body).toContain('Revising PR #12 for review round 1.');
    await c.announce(revisionJob('ci_failure'), run('run_f'));
    expect(api.comments[0]!.body).toContain('Fixing failed checks on `1234567` of PR #12.');
    // The table written at assignment is still there.
    expect(api.comments[0]!.body).toContain('| Worker | `claude` |');
    expect(api.comments).toHaveLength(1);

    const fresh = commenter();
    await fresh.c.announce(job('job_1'), run('run_1'));
    await fresh.c.ended!(job('job_1'), run('run_1'));
    expect(fresh.api.comments).toHaveLength(1);
    expect(fresh.api.comments[0]!.body).toContain('**Updraft · Stopped**');
    // A retry's assignment takes it back.
    await fresh.c.announce(job('job_1'), run('run_2'));
    expect(fresh.api.comments[0]!.body).toContain('**Updraft · Assigned**');
  });

  it('a review job with no status comment posts nothing', async () => {
    const { api, c } = commenter();
    await c.announce(reviewJob(), run('run_r'));
    expect(api.comments).toEqual([]);
  });
});

describe('verbose notifications', () => {
  it('keep the separate assignment table and post nothing for review runs', async () => {
    const { api, c } = commenter('verbose');
    await c.announce(job('job_1'), run('run_1'));
    await c.announce(reviewJob(), run('run_r'));
    await c.ended!(job('job_1'), run('run_1'));
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('Updraft assigned a worker to this issue.');
    expect(api.comments[0]!.body).toContain('<!-- updraft-run-assigned: run_1 -->');
    expect(parseStatusMarker(api.comments[0]!.body)).toBeNull();
  });
});

describe('the status table', () => {
  it('names a configured and an observed model, effort and tier only when known', () => {
    const t = renderStatusTable({
      details: { worker: 'claude', model: 'claude-opus', modelKind: 'configured', complexity: 'complex', tier: 'complex', effort: 'high', observedModel: 'claude-opus-5-5', attempt: 'retry 1' },
      jobId: 'job_1',
    });
    expect(t).toContain('| Model | `claude-opus` |');
    expect(t).toContain('| Model (observed) | `claude-opus-5-5` |');
    expect(t).toContain('| Reasoning effort | `high` |');
    expect(t).toContain('| Capability tier | `complex` |');
    expect(t).toContain('| Attempt | retry 1 |');
    expect(t).toContain('| Job | `job_1` |');
    const bare = renderStatusTable({ details: { worker: 'claude', model: 'CLI default', modelKind: null, complexity: 'Not classified (tier routing off)', tier: 'Not applicable (tier routing off)', effort: 'CLI default', observedModel: 'claude-opus-5-5' }, jobId: 'job_1' });
    expect(bare).toContain('| Model | `claude-opus-5-5` |');
    expect(bare).not.toMatch(/CLI default|Not applicable|Reasoning effort|Capability tier/);
  });
});

// ---------------------------------------------------------------------------
// The pull request body
// ---------------------------------------------------------------------------

const summary = (lastOutput: string[], over: Partial<RunSummary> = {}): RunSummary =>
  ({ branch: 'b', baseSha: 'abc', worktree: '/w', commits: ['abc1234 subject'], commitCount: 1, filesChanged: 1, diffStat: '1 file changed', untracked: 0, lastOutput, notes: [], ...over }) as RunSummary;
const ACCEPTANCE = ['```updraft-acceptance', '[{"criterion":"AC-1","status":"implemented"}]', '```'];

describe('the PR body', () => {
  it('strips the acceptance and findings blocks, and keeps other fences', () => {
    const text = ['Done.', ...ACCEPTANCE, '~~~~updraft-findings', '{}', '~~~~', '```ts', 'x()', '```', 'Bye.'].join('\n');
    const out = stripMachineBlocks(text);
    expect(out).not.toMatch(/updraft-acceptance|updraft-findings|criterion/);
    expect(out).toContain('```ts\nx()\n```');
    // One left open runs to the end, and goes.
    expect(stripMachineBlocks('a\n```updraft-acceptance\n[{"criterion"')).toBe('a');
  });

  it('never cuts a fenced block in half', () => {
    const text = ['intro', '```text', ...Array.from({ length: 50 }, (_, i) => `line ${i}`), '```', 'after'].join('\n');
    const { text: out, cut } = capWholeBlocks(text, 200);
    expect(cut).toBe(true);
    expect(out).toBe('intro');
    expect(capWholeBlocks('short', 200)).toEqual({ text: 'short', cut: false });

    // The #172 shape: a long message whose acceptance block the cap used to cut mid-way.
    const long = ['# What changed', ...Array.from({ length: 300 }, (_, i) => `- change ${i} with some words`), ...ACCEPTANCE.slice(0, 2), '{"criterion":"AC-2"…'];
    const body = renderPrBody({ runId: 'run_x', issueNumber: 3, agent: 'claude', commitCount: 1, mode: 'pr', summary: summary(long) });
    expect(body).not.toMatch(/updraft-acceptance|updraft-findings|criterion/);
    const fences = body.split('\n').filter((l) => /^(> )?```/.test(l));
    expect(fences.length % 2).toBe(0);
    expect(body).toContain("_The rest of the agent's message is in the run log._");
  });

  const repoCfg = (over: Record<string, unknown>) => {
    const c = configSchema.parse({
      version: 1,
      agents: { claude: {} },
      pools: { general: { agents: ['claude'] } },
      actions: { 'implement-issue': { prompt: './p.md', output: 'local-branch' } },
      dispatch: { allowedActors: ['allen'] },
      execution: { mode: 'live' },
      repositories: { 'owner/repo': { id: 1, publish: 'pr', review: true, workflows: [{ trigger: { event: 'issue.labeled', label: 'ready' }, action: 'implement-issue', pool: 'general' }], ...over } },
    });
    return { config: c, repo: c.repositories['owner/repo']! };
  };
  const passed = summary([], { headSha: 'h1', verification: { passed: true, exact: true, sha: 'h1', commands: [] } as unknown as RunSummary['verification'] });

  it('states the merge Updraft will attempt: auto-merge on, off, and blocked by a gate', () => {
    const on = repoCfg({ autoMerge: 'squash' });
    const auto = mergePolicy(on.config, on.repo, { mode: 'pr', verifies: true, summary: passed });
    expect(auto).toEqual({ auto: true, method: 'squash' });
    expect(mergeSentence(auto)).toBe('Updraft merges this (`squash`) once review and required checks pass.');

    const off = repoCfg({});
    expect(mergeSentence(mergePolicy(off.config, off.repo, { mode: 'pr', verifies: false, summary: passed }))).toBe('Merging is up to a person.');

    // A draft is marked ready by the ready verdict (review.ts), or by passing checks with the CI step (ci.ts).
    const draft = repoCfg({ autoMerge: 'squash', publish: 'draft-pr' });
    expect(mergePolicy(draft.config, draft.repo, { mode: 'draft-pr', verifies: false, summary: passed }).auto).toBe(true);
    // Verify commands that never ran on the commit (merge.ts gate 1).
    expect(mergeSentence(mergePolicy(on.config, on.repo, { mode: 'pr', verifies: true, summary: summary([]) }))).toMatch(/^Merging is up to a person: the worker's verify commands did not pass/);
    // Verify commands that did not pass on exactly this commit (merge.ts gate 1).
    const failed = summary([], { headSha: 'h1', verification: { passed: false, exact: true, sha: 'h1', commands: [] } as unknown as RunSummary['verification'] });
    expect(mergeSentence(mergePolicy(on.config, on.repo, { mode: 'pr', verifies: true, summary: failed }))).toMatch(/verify commands did not pass/);
    // No review loop: autoMerge does nothing.
    const noReview = repoCfg({ autoMerge: 'squash', review: false });
    expect(mergePolicy(noReview.config, noReview.repo, { mode: 'pr', verifies: false, summary: passed }).auto).toBe(false);

    const body = renderPrBody({ runId: 'run_x', issueNumber: 3, agent: 'claude', commitCount: 1, mode: 'pr', summary: passed, merge: auto, link: 'https://u.example/installations/9/workflows/1-i3' });
    expect(body).toMatch(/^Closes #3\n\n<!-- updraft-merge -->Updraft merges this \(`squash`\) once review and required checks pass\.<!-- \/updraft-merge --> \[View this work in Updraft\]\(https:\/\/u\.example\/installations\/9\/workflows\/1-i3\)/);
    expect(body).not.toContain('Merging is up to a person');
  });
});

describe('please-act comments (quiet)', () => {
  it('a blocked merge says what to do in one or two sentences, with the console link', () => {
    const body = renderQuietMergeBlockedNotice({ sha: 'a'.repeat(40), prNumber: 12, reason: 'a "Request changes" review by @bob is outstanding', link: 'https://u.example/w' });
    const prose = body.split('\n')[0]!;
    expect(prose.split(/(?<=\.) /).length).toBeLessThanOrEqual(3);
    expect(prose).toContain('Please merge it yourself');
    expect(prose).toContain('[View this work in Updraft](https://u.example/w)');
    expect(prose).not.toContain('@bob');
    expect(body).toContain('<!-- updraft-merge-blocked: ');
  });
});

describe('the CI step (quiet)', () => {
  const pr = (over: Record<string, unknown>) => ({ prNumber: 12, ciFixes: 1, ciReason: 'check(s) failed on abc: lint', ...over }) as unknown as Parameters<typeof renderQuietCiNotice>[0]['pr'];
  const sha = 'b'.repeat(40);
  it('posts nothing while it fixes a head, or when a fixed head passes and auto-merge takes it from there', () => {
    expect(renderQuietCiNotice({ pr: pr({ ciState: 'fixing' }), sha })).toBeNull();
    expect(renderQuietCiNotice({ pr: pr({ ciState: 'passed' }), sha, merge: 'squash' })).toBeNull();
  });
  it('asks a person when it stops, or when merging is left to a person after the fix', () => {
    const stop = renderQuietCiNotice({ pr: pr({ ciState: 'blocked', ciReason: 'the limit was reached @bob' }), sha, link: 'https://u.example/w' })!;
    expect(stop).toContain('needs a person: the limit was reached');
    expect(stop).toContain('Please fix the checks or push a commit');
    expect(stop).toContain('[View this work in Updraft](https://u.example/w)');
    expect(stop).not.toContain('@bob');
    expect(stop).toContain(`<!-- updraft-ci: ${sha} -->`);
    const merge = renderQuietCiNotice({ pr: pr({ ciState: 'passed' }), sha, merge: null })!;
    expect(merge).toContain('after CI fix 1');
    expect(merge).toContain('Please merge it');
  });
});

describe('the revision reply', () => {
  it('states the merge Updraft will attempt, like the PR body', () => {
    const base = { runId: 'run_v', agent: 'claude', review: { id: 1, author: 'bob', url: 'https://github.com/o/r/pull/1#r', body: '', state: 'CHANGES_REQUESTED', submittedAt: null, comments: [] } as never, summary: summary(['Fixed.']), commitCount: 1 };
    expect(renderRevisionReply({ ...base, merge: { auto: true, method: 'squash' } })).toContain('Updraft merges it (`squash`) once review and required checks pass.');
    expect(renderRevisionReply({ ...base, merge: { auto: true, method: 'squash' } })).not.toContain('up to a person');
    expect(renderRevisionReply(base)).toContain('Review it before merging; merging is up to a person.');
    expect(renderRevisionReply({ ...base, merge: { auto: false, reason: "the worker's verify commands did not pass on this commit" } })).toContain("merging is up to a person: the worker's verify commands did not pass on this commit.");
  });
});

describe('review of #181: truthful at every resting point', () => {
  it('a review-loop stage never replaces one about a newer head, and a late "at work" write never replaces a resting one', () => {
    const at = (stage: number, sha: string) => ({ key: 'k', stage, sha });
    const H1 = 'a'.repeat(40);
    const H2 = 'b'.repeat(40);
    // A late write about H1 after H2 was said: refused unless H1 is (still) the newest head.
    expect(mayReplace(at(STATUS_STAGE.loop, H2), STATUS_STAGE.loop, { sha: H1, latest: false })).toBe(false);
    expect(mayReplace(at(STATUS_STAGE.person, H2), STATUS_STAGE.person, { sha: H1, latest: false })).toBe(false);
    // A new head moves it on, resting or not.
    expect(mayReplace(at(STATUS_STAGE.person, H1), STATUS_STAGE.loop, { sha: H2, latest: true })).toBe(true);
    // On one head: resting wins over a late "at work"; a prefix is the same head.
    expect(mayReplace(at(STATUS_STAGE.person, H1), STATUS_STAGE.loop, { sha: H1.slice(0, 7), latest: true })).toBe(false);
    expect(mayReplace(at(STATUS_STAGE.loop, H1), STATUS_STAGE.person, { sha: H1, latest: true })).toBe(true);
    // Merged or closed by anyone is the last word.
    expect(mayReplace({ key: 'k', stage: STATUS_STAGE.final }, STATUS_STAGE.person, { sha: H2, latest: true })).toBe(false);
    expect(parseStatusMarker(statusMarker({ key: 'k', stage: 60, pr: 3, sha: H1 }))).toEqual({ key: 'k', stage: 60, pr: 3, sha: H1 });
  });

  it('after each verdict, the stage that is true', () => {
    const repo = (over: Record<string, unknown>) => {
      const c = configSchema.parse({ version: 1, agents: { claude: {} }, pools: { general: { agents: ['claude'] } }, actions: { 'implement-issue': { prompt: './p.md' } }, dispatch: { allowedActors: ['allen'] }, execution: { mode: 'live' }, repositories: { 'owner/repo': { id: 1, publish: 'pr', review: true, revise: true, workflows: [{ trigger: { event: 'issue.labeled', label: 'ready' }, action: 'implement-issue', pool: 'general' }], ...over } } });
      return [c, c.repositories['owner/repo']!] as const;
    };
    const [c, r] = repo({});
    const sha = 'c'.repeat(40);
    expect(verdictStatus(c, r, 'ready', 12, sha)).toMatchObject({ stage: STATUS_STAGE.person, title: 'Ready for a person to merge' });
    expect(verdictStatus(...repo({ autoMerge: 'squash' }), 'ready', 12, sha)).toMatchObject({ stage: STATUS_STAGE.loop, title: 'Ready to merge' });
    expect(verdictStatus(...repo({ autoMerge: 'squash', ciFix: true }), 'ready', 12, sha)).toMatchObject({ stage: STATUS_STAGE.loop, title: 'Waiting for checks' });
    expect(verdictStatus(c, r, 'revision-queued', 12, sha)).toMatchObject({ stage: STATUS_STAGE.loop, title: 'Changes requested' });
    expect(verdictStatus(c, r, 'no-revise', 12, sha)).toMatchObject({ stage: STATUS_STAGE.person, text: expect.stringMatching(/up to a person/) });
    expect(verdictStatus(c, r, 'over-limit', 12, sha)).toMatchObject({ stage: STATUS_STAGE.person, title: 'Revision limit reached' });
    expect(verdictStatus(c, r, 'needs-verification', 12, sha)).toMatchObject({ stage: STATUS_STAGE.person });
    expect(verdictStatus(c, r, 'stale', 12, sha)).toBeNull();
    expect(verdictStatus(c, r, 'closed', 12, sha)).toBeNull();
  });

  it('a succeeded run with no pull request, and a canceled one, do not stay "Assigned"', async () => {
    // publish is not set here: the work stays on its local branch.
    const { api, c } = commenter();
    await c.announce(job('job_1'), run('run_1'));
    await c.finished!(job('job_1'), { ...run('run_1'), summary: { commitCount: 2 } } as unknown as Run);
    expect(api.comments[0]!.body).toContain('**Updraft · Finished**');
    expect(api.comments[0]!.body).toContain('publishing is off for this repository');
    const other = commenter();
    await other.c.announce(job('job_1'), run('run_1'));
    await other.c.ended!(job('job_1'), run('run_1'), undefined, 'canceled');
    expect(other.api.comments[0]!.body).toContain('**Updraft · Stopped**');
    expect(other.api.comments[0]!.body).toContain('canceled');
  });

  it('a review job that fails rests the loop on a person', async () => {
    const { api, c } = commenter();
    await c.announce(job('job_1'), run('run_1'));
    await writeStatusComment(deps(api), write({ target: { keys: ['job_1'], create: true }, stage: STATUS_STAGE.published, pr: 12 }));
    await c.announce(reviewJob(), run('run_r'));
    await c.ended!(reviewJob(), run('run_r'));
    expect(api.comments[0]!.body).toContain('**Updraft · Waiting for a person**');
    expect(parseStatusMarker(api.comments[0]!.body)).toMatchObject({ stage: STATUS_STAGE.person, sha: 'abcdef1234567' });
  });

  it('fails closed when the worker login is unknown: no comment is taken for the status comment, and none is posted', async () => {
    const api = new FakeIssue();
    api.getWorkerIdentity = async () => {
      throw new GitHubError('forbidden', 403);
    };
    await expect(writeStatusComment(deps(api), write({ target: { keys: ['j'], create: true }, stage: 30 }))).rejects.toThrow();
    expect(api.comments).toEqual([]);
  });

  it('strips every block the readers read: any case, any indent, nested in another fence', () => {
    const text = ['Done.', '  ```UPDRAFT-ACCEPTANCE', '  [{"criterion":"AC-1"}]', '  ```', '````md', 'example:', '~~~updraft-findings', '{"x":1}', '~~~', '````', 'End.'].join('\n');
    const out = stripMachineBlocks(text);
    expect(out).not.toMatch(/criterion|updraft-findings|"x"/i);
    expect(out).toContain('````md\nexample:\n````');
  });

  it('restates the merge sentence of a PR body for a new head, and keeps the agent line for a name the marker cannot carry', () => {
    const body = renderPrBody({ runId: 'run_x', issueNumber: 3, agent: 'claude', commitCount: 1, mode: 'draft-pr', summary: summary([]) });
    expect(body).toContain('Merging is up to a person. Opened as a draft.');
    const next = withMergeSentence(body, { auto: true, method: 'squash' })!;
    expect(next).toContain('Updraft merges this (`squash`) once review and required checks pass. Opened as a draft.');
    expect(withMergeSentence(next, { auto: true, method: 'squash' })).toBeNull();
    expect(withMergeSentence('Closes #3\n\nold body', { auto: true, method: 'squash' })).toBeNull();
    const odd = renderPrBody({ runId: 'run_x', issueNumber: 3, agent: 'claude (opus)', commitCount: 1, mode: 'pr', summary: summary([]) });
    expect(odd).toContain('Opened by updraft from run `run_x` (agent claude (opus)).');
    expect(odd).not.toContain('updraft-agent:');
  });
});

describe('approval follow-ups of #181', () => {
  it('on one head, the newer job attempt wins whatever the stage; an older one never moves a newer one back', () => {
    const H = 'd'.repeat(40);
    const failed = { key: 'k', stage: STATUS_STAGE.person, sha: H, at: 1_000 };
    // A person retried the failed review on the same commit: its "Reviewing" is newer.
    expect(mayReplace(failed, STATUS_STAGE.loop, { sha: H, latest: true, at: 2_000 })).toBe(true);
    // A stale job of an older attempt does not undo a newer resting stage.
    expect(mayReplace({ ...failed, at: 3_000 }, STATUS_STAGE.loop, { sha: H, latest: true, at: 2_000 })).toBe(false);
    // Without both times, resting outranks at work, as before.
    expect(mayReplace({ key: 'k', stage: STATUS_STAGE.person, sha: H }, STATUS_STAGE.loop, { sha: H, latest: true, at: 2_000 })).toBe(false);
    expect(parseStatusMarker(statusMarker({ key: 'k', stage: 60, sha: H, at: 1_234 }))).toEqual({ key: 'k', stage: 60, sha: H, at: 1_234 });
  });

  it('a retry of a failed review on the same commit shows "Reviewing" again', async () => {
    const { api, c } = commenter();
    await c.announce(job('job_1'), run('run_1'));
    await writeStatusComment(deps(api), write({ target: { keys: ['job_1'], create: true }, stage: STATUS_STAGE.published, pr: 12 }));
    const first = { ...run('run_r1'), startedAt: '2026-11-26T10:00:00.000Z' } as Run;
    const retry = { ...run('run_r2'), startedAt: '2026-11-26T10:30:00.000Z' } as Run;
    await c.announce(reviewJob(), first);
    await c.ended!(reviewJob(), first);
    expect(api.comments[0]!.body).toContain('**Updraft · Waiting for a person**');
    await c.announce(reviewJob(), retry);
    expect(api.comments[0]!.body).toContain('**Updraft · Reviewing**');
    // The first attempt's late failure notice cannot put "retry it" back.
    await c.ended!(reviewJob(), first);
    expect(api.comments[0]!.body).toContain('**Updraft · Reviewing**');
  });

  it('deletes a closed pull request\'s CI-fix claim refs, and only those', async () => {
    const refs = [
      `refs/updraft/revision-claims/ci-failure-12-${'a'.repeat(40)}/run_1`,
      `refs/updraft/revision-claims/ci-failure-12-${'b'.repeat(40)}/run_2`,
      `refs/updraft/revision-claims/ci-failure-123-${'c'.repeat(40)}/run_3`,
    ];
    const deleted: string[] = [];
    const api = {
      listMatchingRefs: async (_r: unknown, prefix: string) => refs.filter((r) => r.startsWith(prefix)),
      deleteRef: async (_r: unknown, ref: string) => void deleted.push(ref),
    } as unknown as GitHubApi;
    await dropClaimRefs(api, REPO, 12, silentLogger);
    expect(deleted).toEqual(refs.slice(0, 2));
    // Best effort: a failure is only logged.
    await expect(dropClaimRefs({ listMatchingRefs: async () => { throw new GitHubError('nope', 403); }, deleteRef: async () => {} } as unknown as GitHubApi, REPO, 12, silentLogger)).resolves.toBeUndefined();
  });
});
