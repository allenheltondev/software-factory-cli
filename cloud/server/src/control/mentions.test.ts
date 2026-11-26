import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RepoPermission } from '../../../../src/control/commands.js';
import { createJobStopper, workflowIsPaused } from '../jobs/stop.js';
import { createMemoryStore, type Job, type Tenant } from '../store/store.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createMentionHandler, type MentionDeps, type MentionEvent } from './mentions.js';

const INSTALLATION = 55;
const REPO = { id: 9, full_name: 'acme/web' };
const ISSUE = 12;
const PR = 40;

const tenant: Tenant = { installationId: INSTALLATION, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '2026-11-19T00:00:00.000Z', createdBy: 's' };
const rules = dispatchRules({
  dispatch: { allowedActors: ['pat', 'olive'] },
  repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
}, { keysFor: () => [] });

describe('GitHub mention commands (Cloud)', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let clock: number;
  let replies: Array<{ number: number; body: string }>;
  let permissions: Record<string, RepoPermission | null>;
  let pr: { state: 'open' | 'closed'; merged: boolean; headRef: string; headSha: string; headRepoId: number | null };
  let githubCalls: string[];
  let managed: Set<number>;
  let managedPrs: Set<number>;
  /** While set, the permission lookup for this login waits for `release`. */
  let hold: { login: string; until: Promise<void> } | null;
  let issueOpen: boolean;
  let retry: ReturnType<typeof vi.fn>;
  let queueCancel: Mock<(installationId: number, jobId: string, by: string) => Promise<{ ok: boolean; state: string }>>;
  let terminate: Mock<(id: string) => Promise<void>>;
  let vmState: string | null;
  let handle: ReturnType<typeof createMentionHandler>;
  let commentSeq: number;
  let stopper: ReturnType<typeof createJobStopper>;

  beforeEach(async () => {
    clock = Date.now();
    store = createMemoryStore();
    await store.putTenantWithMember(tenant, { installationId: INSTALLATION, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    const version = await store.createConfigVersion(INSTALLATION, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: rules });
    await store.markConfigReady(INSTALLATION, version as number);
    await store.activateConfig(INSTALLATION, version as number);
    replies = [];
    permissions = { pat: 'write', olive: 'admin', mallory: 'admin' };
    pr = { state: 'open', merged: false, headRef: 'updraft/issue-12-job_x', headSha: 'a'.repeat(40), headRepoId: REPO.id };
    githubCalls = [];
    managed = new Set([ISSUE]);
    managedPrs = new Set();
    hold = null;
    issueOpen = true;
    retry = vi.fn(async () => ({ ok: true, jobId: 'job_retried000001' }));
    queueCancel = vi.fn(async (_i: number, _j: string, _b: string) => ({ ok: true, state: 'canceled' }));
    terminate = vi.fn(async (_id: string) => undefined);
    vmState = 'RUNNING';
    commentSeq = 0;
    stopper = createJobStopper({ store, terminateMicrovm: terminate, microvmState: async () => vmState, now: () => clock, log: () => {} });
    const deps: MentionDeps = {
      store,
      slug: async () => 'updraft-app',
      github: {
        permission: async (_i, _r, _n, login) => {
          githubCalls.push(`permission ${login}`);
          if (hold?.login === login) await hold.until;
          const p = permissions[login];
          if (p === undefined) throw new Error('unavailable');
          return p;
        },
        pullRequest: async () => { githubCalls.push('pullRequest'); return pr; },
        issueOpen: async () => { githubCalls.push('issueOpen'); return issueOpen; },
        reply: async (_i, _r, _n, number, body) => { githubCalls.push('reply'); replies.push({ number, body }); },
      },
      stopJob: (i, jobId, by, reason) => stopper.request(i, jobId, by, reason),
      queue: { waitingFor: async (_i, _r, s) => (s.issue === ISSUE ? ({ jobId: 'job_queued00000001' } as never) : null), cancel: queueCancel as never },
      retry: retry as never,
      issueOfPullRequest: async (_i, _r, n) => (n === PR ? ISSUE : undefined),
      managedPullRequest: async (_i, _r, n) => managedPrs.has(n),
      managedIssue: async (_i, _r, n) => managed.has(n),
      consoleOrigin: 'https://updraft.example',
      now: () => clock,
      log: () => {},
    };
    handle = createMentionHandler(deps);
  });

  const comment = (login: string, body: string, o: { onPr?: boolean; id?: number; type?: string; event?: string } = {}): MentionEvent => ({
    installationId: INSTALLATION,
    deliveryId: `delivery-${++commentSeq}`,
    eventName: o.event ?? 'issue_comment',
    payload: {
      action: 'created',
      repository: REPO,
      sender: { login, type: o.type ?? 'User' },
      issue: { number: o.onPr ? PR : ISSUE, ...(o.onPr ? { pull_request: { url: 'x' } } : {}) },
      comment: { id: o.id ?? 7000 + commentSeq, body, user: { login, type: o.type ?? 'User' }, html_url: 'https://github.com/acme/web/issues/12#c' },
    },
  });

  /** A running standard job of the workflow, on a VM. */
  async function runningJob(id = 'job_running000001', o: Partial<Job> = {}): Promise<Job> {
    const reservation = await store.reserveJob({ installationId: INSTALLATION, jobId: id, holdUntil: clock + 3_600_000, day: '2026-11-25', month: '2026-11',
      quotas: { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100000, platformConcurrentJobs: 10 } });
    if (!reservation.ok) throw new Error('reservation failed');
    const job: Job = { jobId: id, installationId: INSTALLATION, repositoryId: REPO.id, repository: REPO.full_name, issue: ISSUE, tokenHash: 'h', configVersion: 1,
      eventName: 'issues', deliveryId: `d-${id}`, status: 'launched', createdAt: new Date(clock).toISOString(), expiresAt: clock + 3_600_000,
      tenantSlot: reservation.tenantSlot, platformSlot: reservation.platformSlot, reservedSeconds: 3600, ...o };
    await store.putJob(job);
    await store.markLaunching(id);
    await store.attachMicrovm(id, `mvm-${id}`);
    return job;
  }

  it('does nothing at all for a comment that is not a command', async () => {
    expect(await handle(comment('pat', 'Looks good. cc @updraft-app'))).toMatchObject({ disposition: 'ignored', reason: 'no_command' });
    expect(replies).toEqual([]);
  });

  it('ignores bots and Updraft’s own replies, without answering', async () => {
    expect(await handle(comment('dependabot[bot]', '@updraft-app stop', { type: 'Bot' }))).toMatchObject({ reason: 'automated' });
    expect(await handle(comment('pat', '<!-- updraft-control:1 -->\n@updraft-app stop'))).toMatchObject({ reason: 'automated' });
    expect(replies).toEqual([]);
  });

  it('ignores an actor who is not allowed: no GitHub call, no write, no reply', async () => {
    // On an issue Updraft does not manage, and on one it does.
    managed = new Set();
    const unmanaged = comment('mallory', '@updraft-app pause', { id: 501 });
    unmanaged.payload.issue = { number: 99 };
    expect(await handle(unmanaged)).toMatchObject({ disposition: 'filtered', reason: 'actor_not_allowed' });
    managed = new Set([ISSUE]);
    const event = comment('mallory', '@updraft-app cancel', { id: 502 });
    expect(await handle(event)).toMatchObject({ disposition: 'filtered', reason: 'actor_not_allowed' });
    expect(await handle(comment('mallory', '@updraft-app stop', { onPr: true, id: 503 }))).toMatchObject({ reason: 'actor_not_allowed' });
    expect(githubCalls).toEqual([]);
    expect(replies).toEqual([]);
    for (const id of [501, 502, 503]) expect(await store.getControlCommand(INSTALLATION, REPO.id, id)).toBeNull();
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toBeNull();
  });

  it('leaves an unmanaged issue or pull request alone before any GitHub call, even for an allowed actor', async () => {
    const other = comment('pat', '@updraft-app pause', { id: 504 });
    other.payload.issue = { number: 99 };
    expect(await handle(other)).toMatchObject({ disposition: 'filtered', reason: 'not_managed' });
    const otherPr = comment('pat', '@updraft-app pause', { id: 505, onPr: true });
    otherPr.payload.issue = { number: 77, pull_request: { url: 'x' } };
    expect(await handle(otherPr)).toMatchObject({ disposition: 'filtered', reason: 'not_managed' });
    expect(githubCalls).toEqual([]);
    expect(await store.getControlCommand(INSTALLATION, REPO.id, 504)).toBeNull();
  });

  it('ignores a fork’s pull request whose branch merely looks like Updraft’s', async () => {
    pr = { ...pr, headRepoId: 12345 };
    expect(await handle(comment('olive', '@updraft-app pause', { onPr: true }))).toMatchObject({ disposition: 'filtered', reason: 'not_updraft_pr' });
    pr = { ...pr, headRepoId: null };
    expect(await handle(comment('olive', '@updraft-app pause', { onPr: true }))).toMatchObject({ reason: 'not_updraft_pr' });
    expect(replies).toEqual([]);
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toBeNull();
  });

  it('a write-only actor cannot undo a maintainer’s cancel that took over their pause', async () => {
    expect(await handle(comment('pat', '@updraft-app pause'))).toMatchObject({ reason: 'control_applied' });
    expect(await handle(comment('olive', '@updraft-app cancel'))).toMatchObject({ reason: 'control_applied' });
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ control: { kind: 'cancel' } });
    expect(await handle(comment('pat', '@updraft-app resume'))).toMatchObject({ reason: 'control_refused' });
    expect(replies.at(-1)!.body).toContain('needs maintain or admin');
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).not.toBeNull();
    expect(await handle(comment('olive', '@updraft-app resume'))).toMatchObject({ reason: 'control_applied' });
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toBeNull();
  });

  it('a write-only resume racing a maintainer’s cancel cannot lift it', async () => {
    await handle(comment('pat', '@updraft-app pause'));
    let release!: () => void;
    hold = { login: 'pat', until: new Promise((r) => { release = r; }) };
    // The resume reads the pause (a plain pause: write is enough), then waits on its permission lookup...
    const resuming = handle(comment('pat', '@updraft-app resume'));
    await new Promise((r) => setTimeout(r, 0));
    // ...while a maintainer cancels.
    expect(await handle(comment('olive', '@updraft-app cancel'))).toMatchObject({ reason: 'control_applied' });
    release();
    expect(await resuming).toMatchObject({ reason: 'control_refused' });
    expect(replies.at(-1)!.body).toContain('paused again in the meantime');
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ control: { kind: 'cancel' } });
  });

  it('a GitHub pause landing between the cancel’s read and its write still becomes the cancel', async () => {
    const original = store.pauseWorkflowSubjects.bind(store);
    let injected = false;
    store.pauseWorkflowSubjects = async (id, repo, pause, subjects) => {
      if (!injected && pause.control?.kind === 'cancel') {
        injected = true;
        // pat's pause commits first.
        await original(id, repo, { jobId: 'control-999', at: clock - 1, by: 'github:pat', confirmedAt: clock - 1, control: { kind: 'pause', source: '999' } }, [ISSUE]);
      }
      return original(id, repo, pause, subjects);
    };
    expect(await handle(comment('olive', '@updraft-app cancel'))).toMatchObject({ reason: 'control_applied' });
    expect(injected).toBe(true);
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ jobId: 'control-999', control: { kind: 'cancel' } });
    expect(await handle(comment('pat', '@updraft-app resume'))).toMatchObject({ reason: 'control_refused' });
    expect(replies.at(-1)!.body).toContain('needs maintain or admin');
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).not.toBeNull();
  });

  it('a takeover never overwrites a confirmation written since it read the pause', async () => {
    await handle(comment('pat', '@updraft-app pause'));
    const read = (await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE))!;
    await store.confirmWorkflowPause({ jobId: read.jobId, installationId: INSTALLATION, repositoryId: REPO.id }, [ISSUE], read.at); // already confirmed: unchanged
    const stale = { ...read, confirmedAt: undefined };
    expect(await store.takeOverPause(INSTALLATION, REPO.id, stale, { ...read, at: read.at + 1, control: { kind: 'cancel', source: 'x' } }, [ISSUE], [])).toBe(false);
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ at: read.at, confirmedAt: read.confirmedAt });
  });

  it('a cancel on the pull request takes over a pause given on the issue, and holds both', async () => {
    expect(await handle(comment('pat', '@updraft-app pause'))).toMatchObject({ reason: 'control_applied' });
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, PR)).toBeNull();
    expect(await handle(comment('olive', '@updraft-app cancel', { onPr: true }))).toMatchObject({ reason: 'control_applied' });
    for (const n of [ISSUE, PR]) expect(await store.getWorkflowPause(INSTALLATION, REPO.id, n)).toMatchObject({ control: { kind: 'cancel' }, subjects: [ISSUE, PR] });
    expect(queueCancel).toHaveBeenCalledWith(INSTALLATION, 'job_queued00000001', 'github:olive');
    expect(await handle(comment('pat', '@updraft-app resume', { onPr: true }))).toMatchObject({ reason: 'control_refused' });
    expect(replies.at(-1)!.body).toContain('needs maintain or admin');
    expect(await handle(comment('olive', '@updraft-app resume', { onPr: true }))).toMatchObject({ reason: 'control_applied' });
    for (const n of [ISSUE, PR]) expect(await store.getWorkflowPause(INSTALLATION, REPO.id, n)).toBeNull();
  });

  it('says so, truthfully, when the stopped jobs could not be recorded for resume', async () => {
    await runningJob();
    // Every attempt to record the stopped jobs loses a race.
    const original = store.takeOverPause.bind(store);
    store.takeOverPause = async (...a) => (a[3].control?.stopped ? false : original(...a));
    expect(await handle(comment('olive', '@updraft-app cancel'))).toMatchObject({ reason: 'control_applied' });
    expect(replies.at(-1)!.body).toContain('run job_running000001 again with Retry job in the console');
    // It was still held: the stop's own pause.
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ jobId: 'job_running000001' });
  });

  it('accepts a pull request with no linked issue when its workflow or a pause says it is Updraft’s', async () => {
    const lonely = 41;
    const event = (id: number) => {
      const c = comment('pat', '@updraft-app pause', { onPr: true, id });
      c.payload.issue = { number: lonely, pull_request: { url: 'x' } };
      return c;
    };
    expect(await handle(event(601))).toMatchObject({ reason: 'not_managed' });
    managedPrs.add(lonely);
    expect(await handle(event(602))).toMatchObject({ reason: 'control_applied' });
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, lonely)).toMatchObject({ control: { kind: 'pause' }, subjects: [lonely] });
  });

  it('cancel holds first, then ends queued and every active job; resume runs each stopped job again', async () => {
    await runningJob('job_running000001');
    await runningJob('job_running000002', { pullRequest: PR, issue: undefined, workflowIssue: ISSUE });
    const order: string[] = [];
    queueCancel.mockImplementation(() => store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE).then((p) => {
      order.push(`queue:${p ? 'held' : 'open'}`);
      return { ok: true, state: 'canceled' };
    }));
    expect(await handle(comment('olive', '@updraft-app cancel', { onPr: true }))).toMatchObject({ reason: 'control_applied' });
    expect(order).toEqual(['queue:held']);
    expect(terminate).toHaveBeenCalledTimes(2);
    const pause = (await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE))!;
    expect(pause.control).toMatchObject({ kind: 'cancel', stopped: ['job_running000001', 'job_running000002'] });
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, PR)).toMatchObject({ control: { kind: 'cancel' } });
    vmState = 'TERMINATED';
    await stopper.request(INSTALLATION, 'job_running000001', 'x', 'confirm');
    await stopper.request(INSTALLATION, 'job_running000002', 'x', 'confirm');
    expect(await handle(comment('pat', '@updraft-app resume'))).toMatchObject({ reason: 'control_refused' });
    expect(await handle(comment('olive', '@updraft-app resume'))).toMatchObject({ reason: 'control_applied' });
    expect(retry.mock.calls.map((c) => (c[0] as { updraftRetry: { jobId: string } }).updraftRetry.jobId)).toEqual(['job_running000001', 'job_running000002']);
  });

  it('pauses without cutting off a job already running, and names it', async () => {
    const job = await runningJob();
    await store.startJob(job, clock + 3_600_000);
    clock += 1000;
    expect(await handle(comment('pat', '@updraft-app pause — waiting on design'))).toMatchObject({ reason: 'control_applied' });
    expect(replies[0]!.body).toContain('Still running: job job_running000001');
    expect(replies[0]!.body).toContain('https://updraft.example/installations/55/workflows/9-i12');
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ control: { kind: 'pause' }, by: 'github:pat' });
    // The running job is still served; a new launch for the workflow is not.
    expect(await workflowIsPaused(store, (await store.getJob(job.jobId))!)).toBe(false);
    expect(await workflowIsPaused(store, { installationId: INSTALLATION, repositoryId: REPO.id, issue: ISSUE })).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('stops the exact active job, needs maintain to do it, and a duplicate does not stop twice', async () => {
    await runningJob();
    expect(await handle(comment('pat', '@updraft-app stop'))).toMatchObject({ reason: 'control_refused' });
    expect(replies[0]!.body).toContain('needs maintain or admin');
    expect(terminate).not.toHaveBeenCalled();

    const event = comment('olive', '@updraft-app stop', { onPr: true });
    expect(await handle(event)).toMatchObject({ reason: 'control_applied' });
    expect(terminate).toHaveBeenCalledWith('mvm-job_running000001');
    expect(replies[1]!.body).toContain('is stopping: termination is not confirmed yet');
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ jobId: 'job_running000001' });
    expect(await handle(event)).toMatchObject({ disposition: 'deduped' });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('reports no active job and ambiguous targets instead of guessing', async () => {
    expect(await handle(comment('olive', '@updraft-app stop'))).toMatchObject({ reason: 'control_noop' });
    await runningJob('job_running000001');
    await runningJob('job_running000002', { pullRequest: PR, issue: undefined, workflowIssue: ISSUE });
    expect(await handle(comment('olive', '@updraft-app stop', { onPr: true }))).toMatchObject({ reason: 'control_ambiguous' });
    expect(terminate).not.toHaveBeenCalled();
    expect(await handle(comment('olive', '@updraft-app stop job_running000002', { onPr: true }))).toMatchObject({ reason: 'control_applied' });
    expect(terminate).toHaveBeenCalledWith('mvm-job_running000002');
  });

  it('a human stop wins: resume waits for confirmation, needs maintain, then retries the stopped job once', async () => {
    await runningJob();
    await handle(comment('olive', '@updraft-app stop'));
    // Not confirmed yet: nothing resumes.
    expect(await handle(comment('olive', '@updraft-app resume'))).toMatchObject({ reason: 'control_refused' });
    expect(replies.at(-1)!.body).toContain('still stopping');
    vmState = 'TERMINATED';
    // The reconciler (or the console) confirms the termination.
    await stopper.request(INSTALLATION, 'job_running000001', 'github:olive', 'again');
    // A write-only actor may not lift a stop.
    expect(await handle(comment('pat', '@updraft-app resume'))).toMatchObject({ reason: 'control_refused' });
    expect(replies.at(-1)!.body).toContain('needs maintain or admin');
    const resume = comment('olive', '@updraft-app resume — fixed the test, look again', { onPr: true });
    expect(await handle(resume)).toMatchObject({ reason: 'control_applied' });
    expect(retry).toHaveBeenCalledWith({ updraftRetry: { installationId: INSTALLATION, jobId: 'job_running000001', by: 'github:olive' } });
    expect(replies.at(-1)!.body).toContain('job job_retried000001 runs the stopped job job_running000001 again');
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toBeNull();
    // Duplicate resume (redelivery, or a second comment): no second job.
    expect(await handle(resume)).toMatchObject({ disposition: 'deduped' });
    expect(await handle(comment('olive', '@updraft-app resume'))).toMatchObject({ reason: 'control_noop' });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a stop given after a resume was decided is not lifted by it', async () => {
    await handle(comment('pat', '@updraft-app pause'));
    const paused = (await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE))!;
    // Someone else's newer stop replaces the pause before the resume commits.
    await store.resumeWorkflowPause(INSTALLATION, REPO.id, paused, [ISSUE], 'x', clock);
    await runningJob();
    await createJobStopper({ store, terminateMicrovm: terminate, microvmState: async () => 'TERMINATED', now: () => clock, log: () => {} }).request(INSTALLATION, 'job_running000001', 'owner', 'console stop');
    expect(await handle(comment('pat', '@updraft-app resume'))).toMatchObject({ reason: 'control_refused' });
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ jobId: 'job_running000001' });
  });

  it('cancel ends queued and active work and holds the workflow; its resume needs maintain', async () => {
    await runningJob();
    expect(await handle(comment('olive', '@updraft-app cancel'))).toMatchObject({ reason: 'control_applied' });
    expect(queueCancel).toHaveBeenCalledWith(INSTALLATION, 'job_queued00000001', 'github:olive');
    expect(terminate).toHaveBeenCalled();
    expect(await workflowIsPaused(store, { installationId: INSTALLATION, repositoryId: REPO.id, issue: ISSUE })).toBe(true);
  });

  it('cancel with nothing running still pauses, and only a maintainer resumes it', async () => {
    await handle(comment('olive', '@updraft-app cancel'));
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toMatchObject({ control: { kind: 'cancel' } });
    expect(await handle(comment('pat', '@updraft-app resume'))).toMatchObject({ reason: 'control_refused' });
    expect(await handle(comment('olive', '@updraft-app resume'))).toMatchObject({ reason: 'control_applied' });
    expect(retry).not.toHaveBeenCalled();
  });

  it('will not resume a merged pull request or a closed issue', async () => {
    await handle(comment('pat', '@updraft-app pause', { onPr: true }));
    pr = { ...pr, state: 'closed', merged: true };
    expect(await handle(comment('pat', '@updraft-app resume', { onPr: true }))).toMatchObject({ reason: 'control_refused' });
    expect(replies.at(-1)!.body).toContain('is merged');
    issueOpen = false;
    expect(await handle(comment('pat', '@updraft-app resume'))).toMatchObject({ reason: 'control_refused' });
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).not.toBeNull();
  });

  it('leaves pull requests that are not Updraft’s, and unconfigured repositories, alone', async () => {
    pr = { ...pr, headRef: 'feature/theirs' };
    expect(await handle(comment('pat', '@updraft-app pause', { onPr: true }))).toMatchObject({ disposition: 'filtered', reason: 'not_updraft_pr' });
    const other = comment('pat', '@updraft-app pause');
    other.payload.repository = { id: 10, full_name: 'acme/other' };
    expect(await handle(other)).toMatchObject({ disposition: 'filtered', reason: 'unknown_repo' });
    expect(replies).toEqual([]);
  });

  it('answers help, and says what Cloud cannot do yet, without side effects', async () => {
    await handle(comment('pat', '@updraft-app'));
    expect(replies[0]!.body).toContain('`@updraft-app resume`');
    await handle(comment('pat', '@updraft-app review', { onPr: true }));
    expect(replies[1]!.body).toContain('not available on Updraft Cloud yet');
    expect(await store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE)).toBeNull();
  });

  it('reads review comments on a pull request too, and ignores edits', async () => {
    const review = comment('pat', '@updraft-app pause', { event: 'pull_request_review_comment' });
    review.payload.pull_request = { number: PR, head: { ref: pr.headRef } };
    expect(await handle(review)).toMatchObject({ reason: 'control_applied' });
    const edited = comment('pat', '@updraft-app resume');
    edited.payload.action = 'edited';
    expect(await handle(edited)).toMatchObject({ disposition: 'ignored' });
  });

  it('fails closed when the permission cannot be read', async () => {
    delete permissions.pat;
    expect(await handle(comment('pat', '@updraft-app pause'))).toMatchObject({ reason: 'control_refused' });
    expect(replies[0]!.body).toContain('could not confirm your access');
  });
});
