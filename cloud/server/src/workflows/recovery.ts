/**
 * Fenced automatic recovery (#136): what the workflow reconciler (reconcile.ts) does, where it is
 * safe, instead of only reporting a stall. Two recoveries, each through a path that already
 * exists, never a launch of its own:
 *
 *   missed check event   a workflow waits for CI, every check on the pull request's current head
 *                        has finished, and no job took the result. A `check_suite.completed` event
 *                        for exactly that head is synthesized and given to the launcher
 *                        (jobs/launch.ts), which checks it as it checks any delivery (the tenant,
 *                        the active rules and keys, ciFix, the pause, the kill switch, the route,
 *                        the pull request's coalescing lease) and queues it in the admission queue
 *                        (jobs/queue.ts) when capacity is taken, whose admission checks the head
 *                        again. The job it starts runs the CLI's review-loop poll, which reads the
 *                        pull request, its checks and the loop's own records as they are then: it
 *                        resumes the existing pull request, and a stale or repeated event finds
 *                        nothing to do.
 *   lost worker          the workflow's latest job is an issue's implementation whose worker was
 *                        lost (`microvm_gone`: Lambda shows its microVM terminated, or its lifetime
 *                        is over). It is retried once through the console retry (jobs/retry.ts),
 *                        whose claim allows one retry per job, ever, whoever asks: only when no
 *                        stop touched it, the issue is still open and labeled, and no Updraft
 *                        branch of the issue exists on GitHub (a retry publishes on a branch of its
 *                        own, so a lost run that pushed anything could be published twice).
 *
 * Fencing, in order, for every action:
 *   1. the decision is made from GitHub's answers now (the pull request's state and head, its
 *      checks; the issue's state and labels, its branches) and the job's own record;
 *   2. the action is claimed on the workflow with a versioned save, under an idempotency key (the
 *      run and head for a check event, the lost job for a retry) and with an event whose id names
 *      the key and the attempt: a job starting meanwhile, a real event, or another reconciler that
 *      got there first makes the save fail, and nothing is launched;
 *   3. a stop's pause is looked for again, and the pull request's head read again, right before;
 *   4. the launch itself is idempotent: the synthesized event has a delivery id and a job id derived
 *      from the key (the launcher's delivery claim, the queue's entry and the job record all dedupe
 *      on them), and a job record under that id means the action already ran: never a second time;
 *   5. budgets: MAX_RECOVERY_ATTEMPTS tries of one action (a transient refusal: the kill switch, a
 *      busy queue, a failed launch), with backoff; MAX_RECOVERIES_PER_RUN actions per run. Spent, or
 *      refused for good (ciFix off, a budget, a missing key, a changed route), the workflow is
 *      blocked with exactly why and what to do.
 *
 * A human stop always wins: a paused workflow is never recovered (the reconciler reports the pause
 * first), a stopped or canceled job is never retried, and a lost-job retry claimed before a pause
 * is not carried on after the resume. Nothing here posts on GitHub: the job it starts does, as any.
 */
import { createHash } from 'node:crypto';
import type { CommitCheckCounts, GitHubApi, PullRequestHead } from '../github/client.js';
import { GitHubError } from '../github/client.js';
import type { LaunchRequest, LaunchResult } from '../jobs/launch.js';
import type { RetryRequest, RetryResult } from '../jobs/retry.js';
import { workflowPause } from '../jobs/stop.js';
import type { Store } from '../store/store.js';
import { saveChange } from './recorder.js';
import type { WorkflowStore } from './store.js';
import { CI_RECHECK_MS, type RecoveryKind, type Workflow, type WorkflowEvent, type WorkflowRecovery } from './workflow.js';

/** Tries of one action, and distinct actions per run. */
export const MAX_RECOVERY_ATTEMPTS = 6;
export const MAX_RECOVERIES_PER_RUN = 3;
/** The first look after a try; doubled for each later try, at most RECOVERY_BACKOFF_MAX_MS. */
export const RECOVERY_RECHECK_MS = 5 * 60 * 1000;
export const RECOVERY_BACKOFF_MAX_MS = 60 * 60 * 1000;
export const recoveryBackoff = (attempts: number) => Math.min(RECOVERY_BACKOFF_MAX_MS, RECOVERY_RECHECK_MS * 2 ** Math.max(0, attempts - 1));
/**
 * A lost job whose microVM was not seen terminated (a subscription worker's, or one with no
 * microVM on record) may still hold a GitHub token for this long after its lifetime ended: no
 * retry before then, so the lost run can never push alongside the retry.
 */
export const LOST_TOKEN_GRACE_MS = 60 * 60 * 1000;
/** The Updraft branches of an issue (the CLI's jobBranchName): what a lost implementation may have pushed. */
export const issueBranchPrefix = (issue: number) => `updraft/issue-${issue}-`;

const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest();
/** The synthesized event's delivery id: the same for every look at the same action. */
export const recoveryDeliveryId = (installationId: number, workflowId: string, key: string) => `recover-${hash([installationId, workflowId, key, 'delivery']).toString('hex').slice(0, 32)}`;
/** The job id the synthesized event runs as (jobs/launch.ts JOB_ID): the same for every look, so a job record under it means the action ran. */
export const recoveryJobId = (installationId: number, workflowId: string, key: string) => `job_${hash([installationId, workflowId, key, 'job']).toString('base64url').slice(0, 16)}`;
export const missedCheckKey = (w: Pick<Workflow, 'generation'>, headSha: string) => `ci:${w.generation}:${headSha}`;
export const lostJobKey = (jobId: string) => `lost:${jobId}`;
/**
 * The ids of an action's n-th launch: the first is the key's own; a launch whose job record ended
 * `launch_failed` (its reservation reclaimed before any microVM was asked for) gives the next try
 * ids of its own, since a job record is written once.
 */
export const recoveryIds = (installationId: number, workflowId: string, key: string, n: number) => {
  const k = n === 0 ? key : `${key}#${n}`;
  return { jobId: recoveryJobId(installationId, workflowId, k), deliveryId: recoveryDeliveryId(installationId, workflowId, k) };
};

/**
 * The `check_suite.completed` event the missed one would have been, for one pull request and head.
 * It carries only where to look: the CLI reads the checks and the pull request from GitHub itself.
 */
export function missedCheckPayload(w: Pick<Workflow, 'installationId' | 'repository' | 'repositoryId' | 'workflowId' | 'generation'> & { pullRequest: number }, pr: Pick<PullRequestHead, 'headSha' | 'headRef'>, appBot?: string) {
  return {
    action: 'completed',
    check_suite: { head_sha: pr.headSha, head_branch: pr.headRef, status: 'completed', pull_requests: [{ number: w.pullRequest, head: { ref: pr.headRef, sha: pr.headSha } }] },
    repository: { id: w.repositoryId, full_name: w.repository },
    installation: { id: w.installationId },
    ...(appBot ? { sender: { login: appBot, type: 'Bot' } } : {}),
    // Provenance for whoever reads the stored event: not GitHub's, Updraft's own recovery.
    updraft_recovery: { workflowId: w.workflowId, generation: w.generation, reason: 'missed_check_event' },
  };
}

export interface RecoveryDeps {
  /** The launcher: the synthesized event gets every check a delivery gets, and the admission queue. */
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
  /** The console retry handler: one retry per job, ever. */
  retry: (req: RetryRequest) => Promise<RetryResult>;
  /** The platform App's own login (`<slug>[bot]`). */
  appBot?: () => Promise<string | undefined>;
}

/** What a recovery look came to, for the reconciler's report. */
export type RecoveryOutcome =
  /** A job was started or queued for it. */
  | { kind: 'recovered' }
  /** Blocked here, with why. */
  | { kind: 'blocked' }
  /** Nothing done now (waiting for a try, a job that moved the workflow on, a pause): looked at again later or never. */
  | { kind: 'none' }
  /** Not recoverable: the reconciler reports it as it did before, on this record, adding `note`. */
  | { kind: 'report'; workflow: Workflow; note?: string };

/** Launch dispositions that mean the event is in the hands of a job (started, queued, or folded into one). */
const STARTED = new Set(['launched', 'queued', 'queue_joined', 'coalesced']);
/** Launch dispositions worth another try later (bounded by MAX_RECOVERY_ATTEMPTS). */
const TRANSIENT = new Set(['duplicate', 'kill_switch', 'jobs_off', 'launch_failed', 'coalesce_unconfirmed', 'queue_busy', 'capacity_wait']);
/** Retry refusals worth another try later. */
const TRANSIENT_RETRY = new Set(['retry_pending', 'throttled', 'jobs_off', 'launch_failed', 'event_unavailable', 'retry_failed']);

const iso = (ms: number) => new Date(ms).toISOString();
const short = (sha: string) => sha.slice(0, 12);
const samePrefix = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

export function createRecovery(deps: {
  store: WorkflowStore;
  controls: Pick<Store, 'getWorkflowPause'>;
  jobs: Pick<Store, 'getJob' | 'getJobSummary'>;
  github: Pick<GitHubApi, 'pullRequestHead' | 'issueState' | 'matchingBranches' | 'pullRequestsByHeadPrefix'>;
  /** An installation token for the workflow's repository with these permissions. */
  token: (w: Workflow, permissions: Record<string, 'read'>) => Promise<string>;
  recovery: RecoveryDeps;
  log: (entry: Record<string, unknown>) => void;
}) {
  const { store } = deps;

  /**
   * Looked at again in `ms`, unchanged otherwise: every look that does not act moves the workflow's
   * next look on, so a workflow that cannot be acted on yet never stays first in line.
   */
  const defer = async (w: Workflow, at: number, ms: number): Promise<RecoveryOutcome> => {
    await saveChange(store, w.installationId, w.workflowId, (cur) =>
      cur && cur.version === w.version && (!cur.nextCheckAt || Date.parse(cur.nextCheckAt) <= at) ? { workflow: { ...cur, nextCheckAt: iso(at + ms), updatedAt: iso(at) } } : null,
    );
    return { kind: 'none' };
  };
  /** After a claim that did not save: the record moved on (its writer set its next look), or the try was a replay (moved on here). */
  const notClaimed = async (w: Workflow, at: number): Promise<RecoveryOutcome> => {
    const cur = await store.getWorkflow(w.installationId, w.workflowId);
    return cur ? defer(cur, at, RECOVERY_RECHECK_MS) : { kind: 'none' };
  };

  /** A versioned change: nothing if the workflow moved on since `w` was read. */
  const save = (w: Workflow, f: (cur: Workflow) => { workflow: Workflow; event?: WorkflowEvent } | null) =>
    saveChange(store, w.installationId, w.workflowId, (cur) => (cur && cur.version === w.version ? f(cur) : null));

  /** Notes what a try came to on the action's record, if it is still the one tried. */
  const note = (w: Workflow, key: string, attempts: number, result: string, startedJobId?: string) =>
    saveChange(store, w.installationId, w.workflowId, (cur) =>
      cur?.recovery && cur.recovery.key === key && cur.recovery.attempts === attempts
        ? { workflow: { ...cur, recovery: { ...cur.recovery, result, ...(startedJobId ? { startedJobId } : {}) } } }
        : null,
    ).catch((err: unknown) => deps.log({ workflow: w.workflowId, warning: `could not record the recovery's result: ${(err as Error)?.name}` }));

  /** Whether the run has room for this action (a new one) or this action has tries left. */
  function budget(w: Workflow, key: string): 'ok' | 'attempts' | 'actions' {
    const r = w.recovery?.generation === w.generation ? w.recovery : undefined;
    if (r?.key === key) return r.attempts >= MAX_RECOVERY_ATTEMPTS ? 'attempts' : 'ok';
    return (r?.used ?? 0) >= MAX_RECOVERIES_PER_RUN ? 'actions' : 'ok';
  }

  /**
   * Claims a try of the action with a versioned save, and the event that says so (its id names the
   * key and the attempt: a replay of the same try is refused by the store). Null: not claimed.
   */
  async function claim(
    w: Workflow,
    spec: { kind: RecoveryKind; key: string; jobId: string; deliveryId?: string; headSha?: string; message: string; state?: Partial<Workflow> },
    at: number,
  ): Promise<{ workflow: Workflow; recovery: WorkflowRecovery } | null> {
    const r = w.recovery?.generation === w.generation ? w.recovery : undefined;
    const same = r?.key === spec.key;
    const attempts = same ? r!.attempts + 1 : 1;
    const recovery: WorkflowRecovery = {
      generation: w.generation,
      used: same ? r!.used : (r?.used ?? 0) + 1,
      kind: spec.kind,
      key: spec.key,
      since: same ? r!.since : iso(at),
      at: iso(at),
      attempts,
      jobId: spec.jobId,
      ...(spec.deliveryId ? { deliveryId: spec.deliveryId } : {}),
      ...(spec.headSha ? { headSha: spec.headSha } : {}),
    };
    const out = await save(w, (cur) => ({
      workflow: { ...cur, ...spec.state, recovery, nextCheckAt: iso(at + recoveryBackoff(attempts)), updatedAt: iso(at) },
      event: {
        id: `recovery:${spec.key}:${recovery.used}:${attempts}`, at: iso(at), kind: 'recovery', generation: cur.generation, jobId: spec.jobId,
        ...(spec.headSha ? { headSha: spec.headSha } : {}), ...(cur.pullRequest !== undefined ? { prNumber: cur.pullRequest } : {}),
        message: `${spec.message}${attempts > 1 ? ` (try ${attempts} of ${MAX_RECOVERY_ATTEMPTS})` : ''}`,
      },
    }));
    if (!out.saved || !out.workflow) return null;
    deps.log({ workflow: w.workflowId, installationId: w.installationId, recovery: spec.kind, key: spec.key, attempt: attempts, jobId: spec.jobId });
    return { workflow: out.workflow, recovery };
  }

  /** Blocked for good, with why, looked at no more (on the record as read: a change meanwhile wins). */
  async function block(w: Workflow, at: number, why: { reason: string; message: string; nextAction: string; id: string }): Promise<RecoveryOutcome> {
    const out = await save(w, (cur) => {
      const { nextCheckAt: _n, ...rest } = cur;
      return {
        workflow: { ...rest, status: 'blocked', reason: why.reason, message: why.message, nextAction: why.nextAction, updatedAt: iso(at) },
        event: { id: `${why.id}@${cur.version}`, at: iso(at), kind: 'blocked', generation: cur.generation, message: why.message },
      };
    });
    return out.saved ? { kind: 'blocked' } : { kind: 'none' };
  }

  /** Not due any more, as it is (stop wins, or something else owns it now). */
  async function forget(w: Workflow, at: number): Promise<RecoveryOutcome> {
    await save(w, (cur) => {
      const { nextCheckAt: _n, ...rest } = cur;
      return { workflow: { ...rest, updatedAt: iso(at) } };
    });
    return { kind: 'none' };
  }

  /**
   * The workflow as stored, if it is still as this try left it (only its result noted since): a
   * job that started meanwhile, a real event, a stop, or another try owns it otherwise.
   */
  async function stillClaimed(cw: Workflow, recovery: WorkflowRecovery): Promise<Workflow | null> {
    const cur = await store.getWorkflow(cw.installationId, cw.workflowId);
    const same = cur && cur.status === cw.status && cur.stage === cw.stage && cur.reason === cw.reason && cur.lastJobId === cw.lastJobId &&
      cur.generation === cw.generation && cur.pendingJobId === cw.pendingJobId && cur.recovery?.key === recovery.key && cur.recovery.attempts === recovery.attempts;
    return same ? cur : null;
  }

  const paused = (w: Workflow) =>
    workflowPause(deps.controls, { installationId: w.installationId, repositoryId: w.repositoryId, issue: w.issue, pullRequest: w.pullRequest, workflowIssue: w.issue });

  /**
   * Every check on the pull request's head `pr.headSha` finished and no job took their result.
   * `w` is the record the reconciler decided on.
   */
  async function missedCheckEvent(w: Workflow, pr: PullRequestHead, checks: CommitCheckCounts, at: number, canAct: () => boolean): Promise<RecoveryOutcome> {
    if (w.pullRequest === undefined || !pr.headSha) return { kind: 'report', workflow: w };
    // A job queued behind the last one is on its way, and reads the pull request as it is.
    if (w.pendingJobId) return defer(w, at, CI_RECHECK_MS);
    const key = missedCheckKey(w, pr.headSha);
    const ran = (id: string, outcome: string | undefined): RecoveryOutcome => ({
      kind: 'report', workflow: w,
      note: `Updraft already ran the missed CI step once for this head (job ${id}, ${outcome ?? 'finished'}), and it did not move the loop on, so it is not run again.`,
    });

    // This head's event was synthesized before, and its job ran (or runs): never a second time.
    // A launch whose job ended launch_failed never ran anything: the next try has ids of its own.
    let ids: { jobId: string; deliveryId: string } | undefined;
    for (let n = 0; n <= MAX_RECOVERY_ATTEMPTS && !ids; n++) {
      const next = recoveryIds(w.installationId, w.workflowId, key, n);
      const earlier = await deps.jobs.getJob(next.jobId);
      if (!earlier) ids = next;
      else if (earlier.status === 'finished' && earlier.outcome === 'launch_failed') continue;
      else if (earlier.status !== 'finished') return defer(w, at, CI_RECHECK_MS);
      else return ran(next.jobId, earlier.outcome);
    }
    // A try that handed the event to another job (folded into one of the pull request's, or a
    // queued entry it joined): that job is this head's CI step. Never a second one.
    const handed = w.recovery?.generation === w.generation && w.recovery.key === key ? w.recovery.startedJobId : undefined;
    if (handed && handed !== ids?.jobId) {
      const holder = await deps.jobs.getJob(handed);
      if (holder && holder.status !== 'finished') return defer(w, at, CI_RECHECK_MS);
      // (A launch that never got a microVM ran nothing: it does not count as the head's CI step.)
      if (!(holder?.outcome === 'launch_failed')) return ran(handed, holder?.outcome ?? 'handed over');
    }
    if (!ids) return { kind: 'report', workflow: w, note: `Automatic recovery could not get a job for this head started in ${MAX_RECOVERY_ATTEMPTS + 1} launches.` };
    const { jobId, deliveryId } = ids;
    const room = budget(w, key);
    if (room !== 'ok') {
      return {
        kind: 'report', workflow: w,
        note: room === 'attempts'
          ? `Automatic recovery tried ${MAX_RECOVERY_ATTEMPTS} times to start the CI step for this head and could not (last: ${w.recovery?.result ?? 'no answer'}).`
          : `Automatic recovery already acted ${MAX_RECOVERIES_PER_RUN} times in this run, so it does not act again.`,
      };
    }
    // Left for the next run, unchanged and first in line, once this run has acted enough.
    if (!canAct()) return { kind: 'none' };
    const claimed = await claim(w, {
      kind: 'missed_check_event', key, jobId, deliveryId, headSha: pr.headSha,
      message: `The checks on ${short(pr.headSha)} finished (${checks.failed} failed, ${checks.passed} passed) but their event never reached Updraft: the CI step is started for this head.`,
      state: { reason: 'recovering', message: `The checks on ${short(pr.headSha)} finished without their event reaching Updraft; Updraft starts the CI step for this head itself.`, nextAction: 'No action is needed.' },
    }, at);
    if (!claimed) return notClaimed(w, at);
    const { workflow: cw, recovery } = claimed;

    // Right before: a stop wins, and a head that moved is the newer head's to drive.
    if (await paused(cw)) return { kind: 'none' };
    const token = await deps.token(cw, { pull_requests: 'read' });
    const now = await deps.github.pullRequestHead!(token, cw.repository, cw.pullRequest!);
    if (now.state !== 'open' || !samePrefix(now.headSha, pr.headSha)) {
      await note(cw, key, recovery.attempts, 'stale_head');
      return { kind: 'none' };
    }

    const bot = await deps.recovery.appBot?.();
    const payload = missedCheckPayload({ ...cw, pullRequest: cw.pullRequest! }, pr, bot);
    const result = await deps.recovery.launch({
      installationId: cw.installationId, deliveryId, eventName: 'check_suite', ...(bot ? { appBot: bot } : {}),
      body: JSON.stringify(payload), payload: payload as LaunchRequest['payload'], jobId,
      ...(cw.issue !== undefined ? { workflowIssue: cw.issue } : {}),
    });
    const disposition = result.reason ? `${result.disposition}:${result.reason}` : result.disposition;
    deps.log({ workflow: cw.workflowId, installationId: cw.installationId, recovery: 'missed_check_event', key, jobId, disposition });
    await note(cw, key, recovery.attempts, disposition, STARTED.has(result.disposition) ? (result.coveredBy ?? result.jobId ?? jobId) : undefined);
    if (STARTED.has(result.disposition)) return { kind: 'recovered' };
    if (TRANSIENT.has(result.disposition) || (result.disposition === 'not_dispatched' && result.reason === 'native_worker_unavailable')) return { kind: 'none' };
    // A stop that landed meanwhile: the pause is reported at the next look.
    if (result.disposition === 'cancelled' || (result.disposition === 'not_dispatched' && result.reason === 'workflow_paused')) return { kind: 'none' };
    const current = await stillClaimed(cw, recovery);
    if (!current) return { kind: 'none' };
    return {
      kind: 'report', workflow: current,
      note: `Automatic recovery could not start the CI step: ${result.message ?? (result.disposition === 'throttled' ? `a usage limit refused it (${result.reason ?? 'budget'})` : result.disposition)}.`,
    };
  }

  /** The workflow's latest job was lost with its worker. */
  async function lostJob(w: Workflow, at: number, canAct: () => boolean): Promise<RecoveryOutcome> {
    const jobId = w.lastJobId;
    if (!jobId) return forget(w, at);
    const [job, summary] = await Promise.all([deps.jobs.getJob(jobId), deps.jobs.getJobSummary(w.installationId, jobId)]);
    const final = (reason: string, message: string, nextAction: string) => block(w, at, { reason, message, nextAction, id: `recovery-refused:${jobId}:${reason}` });
    if (!job) return final('job_lost', 'The job stopped without reporting how it ended, and its record has expired, so it cannot be retried.', 'Apply the label again on GitHub to start a new run.');
    const outcome = job.status === 'finished' ? job.outcome : summary?.status === 'finished' ? summary.outcome : undefined;
    if (outcome !== 'microvm_gone') return forget(w, at);
    // A human stop always wins; a retry already asked for is the workflow's to follow.
    if (job.stop || summary?.stop || summary?.retriedAs || job.benchmark) return forget(w, at);
    if (job.eventName !== 'issues' || job.issue === undefined || w.issue === undefined || job.issue !== w.issue) {
      return final('job_lost', 'A review-loop job stopped without reporting how it ended: its worker is gone. Updraft does not run review-loop jobs again by itself; the loop\'s own records decide what is left to do.', 'Push to the pull request or review it again on GitHub to continue the loop.');
    }
    // The lost run can no longer act: its microVM was seen terminated, or its tokens have run out.
    const confirmed = job.microvmId !== undefined && job.native === undefined;
    const safeAt = job.expiresAt + LOST_TOKEN_GRACE_MS;
    if (!confirmed && at < safeAt) {
      await save(w, (cur) => ({ workflow: { ...cur, nextCheckAt: iso(safeAt), updatedAt: iso(at) } }));
      return { kind: 'none' };
    }
    const key = lostJobKey(jobId);
    const room = budget(w, key);
    if (room !== 'ok') {
      return final('recovery_exhausted',
        room === 'attempts' ? `Automatic recovery tried ${MAX_RECOVERY_ATTEMPTS} times to retry the lost job and could not (last: ${w.recovery?.result ?? 'no answer'}).` : `The job's worker was lost, and automatic recovery already acted ${MAX_RECOVERIES_PER_RUN} times in this run.`,
        'Open the job to see why, then retry it from its page, or apply the label again on GitHub.');
    }

    // A stop anywhere in this run since the lost job was created (a pause since resumed between
    // two looks included): nothing is run again automatically after a resume.
    const since = Date.parse(job.createdAt);
    for (const r of (w.jobRuns ?? []).filter((x) => x.generation === w.generation && x.jobId !== jobId)) {
      const other = await deps.jobs.getJobSummary(w.installationId, r.jobId);
      if (other?.stop && other.stop.requestedAt >= since) {
        return final('job_lost', `The job's worker was lost, and automation on this workflow was stopped (job ${r.jobId}) since, so it is not retried automatically.`, 'Retry the job from its page.');
      }
    }

    // GitHub's answer now: still wanted, and nothing published that a retry could duplicate.
    let branches: string[];
    let pulls: { numbers: number[]; complete: boolean };
    try {
      const token = await deps.token(w, { issues: 'read', contents: 'read', pull_requests: 'read' });
      const state = await deps.github.issueState!(token, w.repository, w.issue);
      if (!state.open) return final('job_lost', `The job's worker was lost, and issue #${w.issue} has been closed since, so it is not retried.`, 'Reopen the issue and apply the label again to start a new run.');
      if (job.label && !state.labels.some((l) => l.toLowerCase() === job.label!.toLowerCase())) {
        return final('job_lost', `The job's worker was lost, and the \`${job.label}\` label has been removed since, so it is not retried.`, 'Apply the label again on GitHub to start a new run.');
      }
      branches = await deps.github.matchingBranches!(token, w.repository, issueBranchPrefix(w.issue), 5);
      // A pull request the lost run opened, whose branch was deleted since (merged or closed).
      pulls = await deps.github.pullRequestsByHeadPrefix!(token, w.repository, issueBranchPrefix(w.issue), job.createdAt);
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 410)) return final('job_lost', 'The job\'s worker was lost, and the issue or repository is no longer accessible to the App.', 'Check the App\'s access to the repository, then apply the label again.');
      // GitHub could not answer (5xx, a rate limit, a refused token): looked at again later, not every run.
      await defer(w, at, CI_RECHECK_MS);
      throw err;
    }
    if (branches.length > 0 || pulls.numbers.length > 0 || !pulls.complete) {
      const found = [...branches.map((b) => `branch \`${b}\``), ...pulls.numbers.map((n) => `pull request #${n}`)];
      return final('publication_uncertain',
        `The job's worker was lost after it may have published its work (${found.length ? `${found.join(', ')} exists on GitHub` : 'the pull requests opened since it started could not all be read'}). A retry publishes on a branch of its own, so it is not retried automatically: that could open a second pull request.`,
        'Look at the branch or pull request: continue from it, or delete the branch and retry the job from its page.');
    }

    if (!canAct()) return { kind: 'none' };
    const claimed = await claim(w, {
      kind: 'lost_job', key, jobId,
      message: `The worker of job ${jobId} was lost before it reported how it ended, and nothing of it was published: it is retried.`,
      state: { status: 'waiting', reason: 'recovering', message: `The worker of job ${jobId} was lost before it reported how it ended; nothing of it was published, so Updraft retries it once.`, nextAction: 'No action is needed.', waitingSince: iso(at) },
    }, at);
    if (!claimed) return notClaimed(w, at);
    const { workflow: cw, recovery } = claimed;
    if (await paused(cw)) return { kind: 'none' };
    const result = await deps.recovery.retry({ updraftRetry: { installationId: cw.installationId, jobId, by: 'automatic recovery' } });
    deps.log({ workflow: cw.workflowId, installationId: cw.installationId, recovery: 'lost_job', key, jobId, result: result.ok ? 'started' : result.code });
    await note(cw, key, recovery.attempts, result.ok ? 'started' : result.code, result.ok ? result.jobId : undefined);
    if (result.ok) return { kind: 'recovered' };
    if (TRANSIENT_RETRY.has(result.code)) return { kind: 'none' };
    // A retry another caller started: that job's start is recorded on the workflow.
    if (result.code === 'already_retried') return { kind: 'none' };
    const current = await stillClaimed(cw, recovery);
    if (!current) return { kind: 'none' };
    return block(current, at, { reason: 'job_lost', message: `The job's worker was lost, and the automatic retry was refused: ${result.message}.`, nextAction: 'Fix what the refusal names, then retry the job from its page.', id: `recovery-refused:${jobId}:${result.code}` });
  }

  return { missedCheckEvent, lostJob };
}

export type Recovery = ReturnType<typeof createRecovery>;
