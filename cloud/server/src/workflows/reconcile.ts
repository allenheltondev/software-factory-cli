/**
 * Workflow reconciliation (#136): every five minutes (WebhookFunction's ReconcileWorkflows
 * schedule, which has the launcher's and the App's permissions), the workflows due a look are
 * checked against GitHub, so a missed webhook cannot strand work that can go on, and work that
 * cannot is said to be blocked, with why and what to do.
 *
 *   the pull request was merged or closed     finished
 *   waiting for CI, checks still running      looked at again later, nothing held; blocked once
 *                                             they have run for CI_WAIT_LIMIT_MS
 *   waiting for CI, every check finished      the check event was missed (or never sent: CI that
 *     (or the head has none)                  only reports commit statuses): the same job a
 *                                             `check_suite.completed` delivery would start is
 *                                             launched, at most MAX_CI_RECOVERIES times per head,
 *                                             under a delivery id derived from the head, so a
 *                                             redelivery or a second run starts nothing twice
 *   waiting for the next loop event           blocked after STALL_LIMIT_MS: no job has run
 *
 * It decides from GitHub's own answers (the pull request's state and head, the head's check runs
 * and statuses), never from elapsed time alone, and changes a workflow only through its versioned
 * save, so a job starting meanwhile wins. A ready-to-merge pull request waits for a person and is
 * never looked at. The kill switch stops the whole run.
 */
import { createHash } from 'node:crypto';
import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { LoadSettings } from '../github/settings.js';
import type { LaunchRequest, LaunchResult } from '../jobs/launch.js';
import { OFF_SWITCH, type KillSwitch } from '../jobs/kill-switch.js';
import type { Store } from '../store/store.js';
import { workflowPause } from '../jobs/stop.js';
import { saveChange, updateWorkflow } from './recorder.js';
import type { WorkflowStore } from './store.js';
import { CI_RECHECK_MS, CI_WAIT_LIMIT_MS, MAX_CI_RECOVERIES, onJobFinished, PR_POLL_MS, SIGN_IN_LIMIT_MS, STALL_LIMIT_MS, type Workflow, type WorkflowEvent } from './workflow.js';

export interface WorkflowReconcilerDeps {
  store: WorkflowStore;
  controls: Pick<Store, 'getWorkflowPause'>;
  /** The jobs' own records, for a workflow whose job's finish was never recorded on it. */
  jobs?: Pick<Store, 'getJob' | 'getJobSummary'>;
  github: Pick<GitHubApi, 'createInstallationToken' | 'pullRequestHead' | 'commitChecks'>;
  loadSettings: LoadSettings;
  /** The launcher (jobs/launch.ts); absent: jobs are off, and a missed check event is only reported. */
  launch?: (req: LaunchRequest) => Promise<LaunchResult>;
  appBot?: () => Promise<string | undefined>;
  killSwitch?: KillSwitch;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** Workflows looked at per run, at most. */
  limit?: number;
}

export interface ReconcileReport {
  checked: number;
  recovered: number;
  /** Workflows whose job had finished without the finish reaching them: brought up to date from the job's record. */
  repaired: number;
  blocked: number;
  finished: number;
  failed: number;
  /** Workflows still due a look once the run ended (at most 1000 counted), and how long the oldest has been due. */
  backlog: number;
  oldestDueSeconds: number;
}

const short = (sha: string) => sha.slice(0, 12);
const TRANSIENT = new Set(['throttled', 'launch_failed', 'kill_switch', 'jobs_off', 'coalesce_unconfirmed', 'cancelled']);
const iso = (ms: number) => new Date(ms).toISOString();

/** The delivery id of a CI recovery: one per workflow head and attempt, so it is claimed once. */
export function recoveryDeliveryId(w: Pick<Workflow, 'installationId' | 'repositoryId' | 'pullRequest'>, headSha: string, attempt: number): string {
  return `reconcile-${createHash('sha256').update(`${w.installationId}:${w.repositoryId}:${w.pullRequest}:${headSha}:${attempt}`).digest('hex').slice(0, 32)}`;
}

export function createWorkflowReconciler(deps: WorkflowReconcilerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const killSwitch = deps.killSwitch ?? OFF_SWITCH;
  const limit = deps.limit ?? 25;

  /** Change the workflow, unless it moved on since it was read (a job started, another run changed it). */
  const change = (w: Workflow, f: (cur: Workflow) => { workflow: Workflow; event?: WorkflowEvent } | null) =>
    updateWorkflow(deps.store, w.installationId, w.workflowId, (cur) => (cur && cur.version === w.version ? f(cur) : null));

  const without = (w: Workflow, ...keys: (keyof Workflow)[]): Workflow => {
    const out = { ...w };
    for (const k of keys) delete out[k];
    return out;
  };

  async function one(first: Workflow, at: number, report: ReconcileReport): Promise<void> {
    let w = first;
    report.checked++;
    const blockedEvent = (id: string, message: string): WorkflowEvent => ({ id, at: iso(at), kind: 'blocked', generation: w.generation, message });
    const block = (reason: string, message: string, nextAction: string, id: string) =>
      change(w, (cur) => ({ workflow: { ...without(cur, 'nextCheckAt'), status: 'blocked', reason, message, nextAction, updatedAt: iso(at) }, event: blockedEvent(id, message) })).then(() => {
        report.blocked++;
      });
    const later = (ms: number) => change(w, (cur) => ({ workflow: { ...cur, nextCheckAt: iso(at + ms), updatedAt: iso(at) } }));

    const pause = await workflowPause(deps.controls, w);
    if (pause) {
      const repeated = w.controlPause?.jobId === pause.jobId;
      await change(w, (cur) => ({ workflow: {
        ...cur, status: 'blocked', reason: 'workflow_paused', message: `Automation was paused by ${pause.by}. The stopped job and existing pull request are preserved.`,
        nextAction: `Resume automation or retry from job ${pause.jobId}.`, nextCheckAt: iso(at + CI_RECHECK_MS), updatedAt: iso(at),
        controlPause: { ...pause, previous: cur.controlPause?.previous ?? { status: cur.status, reason: cur.reason, message: cur.message, nextAction: cur.nextAction } },
      }, ...(!repeated ? { event: blockedEvent(`control-pause:${pause.jobId}:${pause.at}`, 'An authorized stop paused automatic recovery.') } : {}) }));
      report.blocked++;
      return;
    }
    if (w.controlPause) {
      const restored = await change(w, (cur) => ({ workflow: { ...without(cur, 'controlPause', 'reason', 'message', 'nextAction'), ...cur.controlPause!.previous, updatedAt: iso(at) } }));
      if (!restored) return;
      w = restored;
    }

    // A job was running, and by now it cannot be: its finish never reached the workflow (a lost
    // response, a write that failed). The job's own record says how it ended.
    if (w.status === 'active') {
      const jobId = w.lastJobId;
      if (!jobId || !deps.jobs) return void (await change(w, (cur) => ({ workflow: { ...without(cur, 'nextCheckAt'), updatedAt: iso(at) } })));
      const [job, summary] = await Promise.all([deps.jobs.getJob(jobId), deps.jobs.getJobSummary(w.installationId, jobId)]);
      const outcome = job?.status === 'finished' ? job.outcome : summary?.status === 'finished' ? summary.outcome : undefined;
      if (outcome) {
        const ref = { jobId, eventName: job?.eventName ?? 'unknown' };
        await change(w, (cur) => {
          const next = onJobFinished(cur, ref, outcome, summary?.detail, at);
          return { workflow: next.workflow, event: { ...next.event, kind: 'finish_recovered', message: 'The job had finished without its result reaching this workflow; recorded from the job\'s own record.' } };
        });
        report.repaired++;
        return;
      }
      // Still running past its maximum duration: the quota reconciliation ends it (microvm_gone), which records it here.
      if (job) return void (await later(CI_RECHECK_MS));
      return block('job_lost', 'The last job is gone without a recorded end (its record has expired).', 'Retry the job from its page, or apply the label again on GitHub.', `job-gone:${jobId}`);
    }

    // A job that waits for a Claude sign-in: blocked once no one has signed in for a day.
    if (w.stage === 'awaiting-sign-in') {
      const waitedFor = at - Date.parse(w.waitingSince ?? w.updatedAt);
      if (waitedFor < SIGN_IN_LIMIT_MS) return void (await later(SIGN_IN_LIMIT_MS - waitedFor));
      return block(
        'sign_in_expired',
        `The job waited ${Math.round(SIGN_IN_LIMIT_MS / 3_600_000)} hours for a Claude subscription sign-in that did not happen.`,
        'Sign in on the Claude page of this installation, then apply the label again on GitHub.',
        `sign-in-expired:${w.lastJobId ?? w.waitingSince}`,
      );
    }

    if (w.pullRequest === undefined || !deps.github.pullRequestHead) {
      await change(w, (cur) => ({ workflow: { ...without(cur, 'nextCheckAt'), updatedAt: iso(at) } }));
      return;
    }
    const settings = await deps.loadSettings();
    if (!settings) throw new Error('the App settings are unavailable');
    const { token } = await deps.github.createInstallationToken(appJwt(settings.appId, settings.privateKey, at), w.installationId, {
      repositoryIds: [w.repositoryId],
      permissions: { pull_requests: 'read', checks: 'read', statuses: 'read' },
    });
    const pr = await deps.github.pullRequestHead(token, w.repository, w.pullRequest);
    if (pr.state !== 'open') {
      const message = pr.merged ? `Pull request #${w.pullRequest} was merged.` : `Pull request #${w.pullRequest} was closed.`;
      await change(w, (cur) => ({
        workflow: { ...without(cur, 'nextCheckAt', 'reason', 'nextAction', 'waitingSince'), status: 'finished', stage: pr.merged ? 'merged' : 'closed', message, updatedAt: iso(at) },
        event: { id: `pr-${pr.merged ? 'merged' : 'closed'}:${w.pullRequest}`, at: iso(at), kind: 'finished', generation: w.generation, prNumber: w.pullRequest, message },
      }));
      report.finished++;
      return;
    }
    const waited = at - Date.parse(w.waitingSince ?? w.updatedAt);

    // Waiting for a person (to merge, or to act on what stopped the loop): only a merge or close
    // ends it, looked for now and then, never blocked for taking time.
    if (w.stage === 'ready-to-merge' || w.stage === 'needs-human') return void (await later(PR_POLL_MS));

    if (w.stage !== 'waiting-for-ci') {
      if (waited < STALL_LIMIT_MS) return void (await later(STALL_LIMIT_MS - waited));
      const hours = Math.round(STALL_LIMIT_MS / 3_600_000);
      return block(
        'stalled',
        `No job has worked on pull request #${w.pullRequest} for ${hours} hours, in stage ${w.stage}.`,
        'Look at the pull request: a review, a push or a retry of the last job from its page starts the next step.',
        `stalled:${w.pullRequest}:${w.waitingSince ?? w.updatedAt}`,
      );
    }

    if (!deps.github.commitChecks) return void (await later(CI_RECHECK_MS));
    const checks = await deps.github.commitChecks(token, w.repository, pr.headSha);
    const finished = checks.complete && checks.pending === 0;
    if (!finished) {
      if (waited < CI_WAIT_LIMIT_MS) return void (await later(CI_RECHECK_MS));
      return block(
        'ci_stuck',
        `The checks on ${short(pr.headSha)} have not finished in ${Math.round(CI_WAIT_LIMIT_MS / 3_600_000)} hours (${checks.pending} still running).`,
        'Re-run or fix the stuck check on GitHub; its result restarts the review loop.',
        `ci-stuck:${pr.headSha}`,
      );
    }
    // Every check finished, yet no job took the result: the check event was missed.
    const attempts = w.recoveredSha === pr.headSha ? (w.recoveries ?? 0) : 0;
    if (attempts >= MAX_CI_RECOVERIES) {
      return block(
        'ci_event_missed',
        `The checks on ${short(pr.headSha)} finished, but no job picked their result up, after ${attempts} recover${attempts === 1 ? 'y' : 'ies'}.`,
        'Retry the last job from its page, or push to the pull request.',
        `ci-missed:${pr.headSha}`,
      );
    }
    if (!deps.launch) {
      return block('ci_event_missed', `The checks on ${short(pr.headSha)} finished, but no job picked their result up.`, 'Retry the last job from its page.', `ci-missed:${pr.headSha}`);
    }
    const payload = {
      action: 'completed',
      repository: { id: w.repositoryId, full_name: w.repository },
      sender: { login: (await deps.appBot?.()) ?? 'updraft' },
      check_suite: {
        head_branch: pr.headRef,
        head_sha: pr.headSha,
        status: 'completed',
        pull_requests: [{ number: w.pullRequest, head: { ref: pr.headRef, sha: pr.headSha } }],
      },
      installation: { id: w.installationId },
    };
    const deliveryId = recoveryDeliveryId(w, pr.headSha, attempts + 1);
    // The recovery is reserved on the workflow first, against the version it was decided on: if
    // anything changed meanwhile (a job started or finished, another run got here), nothing is
    // launched. The reservation counts the attempt, so a crash after it cannot launch a third.
    const message = `The checks on ${short(pr.headSha)} finished (${checks.failed} failed, ${checks.passed} passed${checks.total === 0 ? ', none reported' : ''}) without a check event reaching Updraft: queued the step that event would have started.`;
    const reservation = await saveChange(deps.store, w.installationId, w.workflowId, (cur) => cur && cur.version === w.version ? ({
      workflow: { ...cur, recoveries: attempts + 1, recoveredSha: pr.headSha, nextCheckAt: iso(at + CI_RECHECK_MS), updatedAt: iso(at) },
      event: { id: `ci-recovered:${pr.headSha}:${attempts + 1}`, at: iso(at), kind: 'ci_recovered', generation: w.generation, prNumber: w.pullRequest, headSha: pr.headSha, message },
    }) : null);
    const reserved = reservation.workflow;
    // Only the run whose save made the reservation launches.
    if (!reservation.saved || !reserved) {
      log({ workflow: w.workflowId, installationId: w.installationId, skipped: 'the workflow changed while it was looked at; nothing launched' });
      return;
    }
    const appBot = await deps.appBot?.();
    // A pause may have landed while GitHub or the reservation write was in flight.
    // Do not consume recovery attempts for intentional stops; the launch/start/assignment
    // transactions are still the authority if a stop races this final read.
    if (await workflowPause(deps.controls, w)) {
      await change(reserved, (cur) => ({ workflow: { ...cur, recoveries: attempts, nextCheckAt: iso(at + CI_RECHECK_MS), updatedAt: iso(at) } }));
      return;
    }
    const result = await deps.launch({
      installationId: w.installationId,
      ...(w.issue !== undefined ? { workflowIssue: w.issue } : {}),
      deliveryId,
      eventName: 'check_suite',
      ...(appBot ? { appBot } : {}),
      body: JSON.stringify(payload),
      payload: payload as unknown as LaunchRequest['payload'],
    });
    if (result.disposition === 'launched' || result.disposition === 'duplicate' || result.disposition === 'coalesced') {
      report.recovered++;
      log({ workflow: w.workflowId, installationId: w.installationId, recovered: deliveryId, disposition: result.disposition, ...(result.jobId ? { jobId: result.jobId } : {}) });
      return;
    }
    // Every outcome below acts on the reserved workflow, not the one first read.
    w = reserved;
    if (result.reason === 'workflow_paused') {
      await change(w, (cur) => ({ workflow: { ...cur, recoveries: attempts, nextCheckAt: iso(at + CI_RECHECK_MS), updatedAt: iso(at) } }));
      return;
    }
    // Not now (a quota, a failed launch, jobs paused): the attempt is given back, and the head looked at again later.
    if (TRANSIENT.has(result.disposition)) {
      await change(w, (cur) => ({ workflow: { ...cur, recoveries: attempts, nextCheckAt: iso(at + CI_RECHECK_MS), updatedAt: iso(at) } }));
      return;
    }
    return block(
      'ci_not_dispatched',
      `The checks on ${short(pr.headSha)} finished, but Updraft could not start the next step: ${result.message ?? result.reason ?? result.disposition}.`,
      'Check the repository\'s configuration (CI repair needs review), then retry the last job from its page.',
      `ci-refused:${pr.headSha}:${result.reason ?? result.disposition}`,
    );
  }

  return async function reconcileWorkflows(): Promise<ReconcileReport> {
    const report: ReconcileReport = { checked: 0, recovered: 0, repaired: 0, blocked: 0, finished: 0, failed: 0, backlog: 0, oldestDueSeconds: 0 };
    if (await killSwitch.engaged()) return report;
    const at = now();
    for (const due of await deps.store.listDueWorkflows(at, limit)) {
      const w = await deps.store.getWorkflow(due.installationId, due.workflowId);
      // Gone, or no longer due (a job started, another run changed it): the index entry is stale.
      if (!w?.nextCheckAt || Date.parse(w.nextCheckAt) > at) continue;
      try {
        await one(w, at, report);
      } catch (err) {
        report.failed++;
        log({ workflow: w.workflowId, installationId: w.installationId, error: 'workflow reconciliation failed', name: (err as Error)?.name, message: (err as Error)?.message });
        // Not looked at again at once: the next try is later, so one broken workflow cannot hold up the rest.
        await updateWorkflow(deps.store, w.installationId, w.workflowId, (cur) => (cur && cur.version === w.version ? { workflow: { ...cur, nextCheckAt: iso(at + CI_RECHECK_MS) } } : null)).catch(() => {});
      }
    }
    // What is left: a backlog that grows, or a look that stays due, means the reconciler is behind or stuck.
    const left = await deps.store.listDueWorkflows(now(), 1000);
    report.backlog = left.length;
    if (left[0]) {
      const oldest = await deps.store.getWorkflow(left[0].installationId, left[0].workflowId);
      if (oldest?.nextCheckAt) report.oldestDueSeconds = Math.max(0, Math.round((now() - Date.parse(oldest.nextCheckAt)) / 1000));
    }
    return report;
  };
}
