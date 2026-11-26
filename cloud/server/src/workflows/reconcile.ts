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
 *     (or the head has none)                  only reports commit statuses). With recovery
 *                                             configured, the CI step is started for exactly that
 *                                             head (recovery.ts: fenced, once per head); without
 *                                             it, or where recovery is refused, blocked, saying
 *                                             how to restart it
 *   the latest job's worker was lost          with recovery configured, an implementation that
 *                                             published nothing is retried once (recovery.ts);
 *                                             otherwise it stays blocked, saying why
 *   waiting for the next loop event           blocked after STALL_LIMIT_MS: no job has run
 *
 * It decides from GitHub's own answers (the pull request's state and head, the head's check runs
 * and statuses), never from elapsed time alone, and changes a workflow only through its versioned
 * save, so a job starting meanwhile wins. It starts a job only through recovery.ts, and only
 * through the launcher's and the console retry's own fences. A pull request waiting for a person
 * is looked at only for a merge or close. The kill switch stops the whole run, and a stop's pause
 * is reported before anything else is looked at.
 */
import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { LoadSettings } from '../github/settings.js';
import { OFF_SWITCH, type KillSwitch } from '../jobs/kill-switch.js';
import type { Store } from '../store/store.js';
import { workflowPause } from '../jobs/stop.js';
import { updateWorkflow } from './recorder.js';
import { pauseControlOf, pausedWorkflow, pauseNoticedMessage, resumedWorkflow } from './timeline.js';
import { createRecovery, type RecoveryDeps } from './recovery.js';
import type { WorkflowStore } from './store.js';
import { CI_RECHECK_MS, CI_WAIT_LIMIT_MS, onJobFinished, PR_POLL_MS, SIGN_IN_LIMIT_MS, STALL_LIMIT_MS, type Workflow, type WorkflowEvent } from './workflow.js';

export interface WorkflowReconcilerDeps {
  store: WorkflowStore;
  controls: Pick<Store, 'getWorkflowPause'>;
  /** The jobs' own records, for a workflow whose job's finish was never recorded on it. */
  jobs?: Pick<Store, 'getJob' | 'getJobSummary'>;
  github: Pick<GitHubApi, 'createInstallationToken' | 'pullRequestHead' | 'commitChecks' | 'issueState' | 'matchingBranches' | 'pullRequestsByHeadPrefix'>;
  /**
   * Fenced automatic recovery (recovery.ts): the launcher and the console retry it may start work
   * through. Absent: report only, as before. It also needs `jobs`.
   */
  recovery?: RecoveryDeps;
  loadSettings: LoadSettings;
  killSwitch?: KillSwitch;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** Workflows looked at per run, at most. */
  limit?: number;
  /**
   * Recovery actions one run takes at most, and how far into the run it still starts one: a launch
   * can take seconds (a pull request's coalescing wait), all within the function's 20 s. A workflow
   * left for later stays due, and is the first one looked at by the next run.
   */
  maxRecoveries?: number;
  recoveryBudgetMs?: number;
}

export const MAX_RECOVERIES_PER_RECONCILE = 2;
export const RECOVERY_BUDGET_MS = 5 * 1000;

export interface ReconcileReport {
  checked: number;
  /** Workflows whose job had finished without the finish reaching them: brought up to date from the job's record. */
  repaired: number;
  blocked: number;
  finished: number;
  failed: number;
  /** Recoveries that started (or queued) a job: a missed check event's CI step, a lost job's retry. */
  recovered: number;
  /** Workflows still due a look once the run ended (at most 1000 counted), and how long the oldest has been due. */
  backlog: number;
  oldestDueSeconds: number;
}

const short = (sha: string) => sha.slice(0, 12);
/** A PAUSE record's command descriptor (PR #168), when it has a well-formed one. */
const withControl = (raw: unknown) => {
  const control = pauseControlOf(raw);
  return control ? { control } : {};
};
const iso = (ms: number) => new Date(ms).toISOString();

export function createWorkflowReconciler(deps: WorkflowReconcilerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const killSwitch = deps.killSwitch ?? OFF_SWITCH;
  const limit = deps.limit ?? 25;

  const token = async (w: Workflow, permissions: Record<string, 'read'>, at: number) => {
    const settings = await deps.loadSettings();
    if (!settings) throw new Error('the App settings are unavailable');
    return (await deps.github.createInstallationToken(appJwt(settings.appId, settings.privateKey, at), w.installationId, { repositoryIds: [w.repositoryId], permissions })).token;
  };
  const recovery = deps.recovery && deps.jobs
    ? createRecovery({ store: deps.store, controls: deps.controls, jobs: deps.jobs, github: deps.github, token: (w, p) => token(w, p, now()), recovery: deps.recovery, log })
    : undefined;

  /** Change the workflow, unless it moved on since it was read (a job started, another run changed it). */
  const change = (w: Workflow, f: (cur: Workflow) => { workflow: Workflow; event?: WorkflowEvent } | null) =>
    updateWorkflow(deps.store, w.installationId, w.workflowId, (cur) => (cur && cur.version === w.version ? f(cur) : null));

  const without = (w: Workflow, ...keys: (keyof Workflow)[]): Workflow => {
    const out = { ...w };
    for (const k of keys) delete out[k];
    return out;
  };

  async function one(first: Workflow, at: number, report: ReconcileReport, canAct: () => boolean): Promise<void> {
    let w = first;
    report.checked++;
    // The reconciler's own events are named for the record they were decided on: each decision is
    // made once (its save is version-checked), and a later one is a new event, never a replay.
    const blockedEvent = (id: string, message: string): WorkflowEvent => ({ id: `${id}@${w.version}`, at: iso(at), kind: 'blocked', generation: w.generation, message });
    const block = (reason: string, message: string, nextAction: string, id: string, on: Workflow = w) =>
      change(on, (cur) => ({ workflow: { ...without(cur, 'nextCheckAt'), status: 'blocked', reason, message, nextAction, updatedAt: iso(at) }, event: { ...blockedEvent(id, message), id: `${id}@${on.version}`, reason } })).then(() => {
        report.blocked++;
      });
    const later = (ms: number) => change(w, (cur) => ({ workflow: { ...cur, nextCheckAt: iso(at + ms), updatedAt: iso(at) } }));

    // An authorized stop paused the workflow's subjects: reported, and nothing else is looked at
    // until it is resumed. What it said before is kept, and comes back on resume.
    const pause = await workflowPause(deps.controls, w);
    if (pause) {
      const repeated = w.controlPause?.jobId === pause.jobId && w.controlPause.at === pause.at;
      const ref = { jobId: pause.jobId, at: pause.at, by: pause.by, ...withControl((pause as { control?: unknown }).control) };
      await change(w, (cur) => ({
        workflow: pausedWorkflow(cur, ref, at),
        ...(!repeated ? { event: { ...blockedEvent(`control-pause:${pause.jobId}:${pause.at}`, pauseNoticedMessage(ref)), reason: 'workflow_paused' } } : {}),
      }));
      if (!repeated) report.blocked++;
      return;
    }
    if (w.controlPause) {
      // Resumed where this workflow was not told (an older console, a job's own retry): back to
      // what it said before. A lost job's retry is never carried on after a resume (timeline.ts).
      const restored = await change(w, (cur) => ({ workflow: resumedWorkflow(cur, at) }));
      if (!restored || restored.version === w.version) return;
      w = restored;
      // Back to what it was. Only a workflow that was due a look then is looked at now; a
      // blocked or finished one stays as it was, and is not diagnosed again.
      if (!w.nextCheckAt || Date.parse(w.nextCheckAt) > at || (w.status !== 'waiting' && w.status !== 'active')) return;
    }

    // The latest job was lost with its worker: retried where that is safe (recovery.ts), else left blocked.
    if ((w.status === 'blocked' && w.reason === 'job_lost') || (w.reason === 'recovering' && w.recovery?.kind === 'lost_job')) {
      if (recovery) {
        const out = await recovery.lostJob(w, at, canAct);
        if (out.kind === 'recovered') report.recovered++;
        if (out.kind === 'blocked') report.blocked++;
        return;
      }
      return void (await change(w, (cur) => ({ workflow: { ...without(cur, 'nextCheckAt'), updatedAt: iso(at) } })));
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
          const occurredAt = summary?.finishedAt && Date.parse(summary.finishedAt) < at ? summary.finishedAt : undefined;
          return { workflow: next.workflow, event: { ...next.event, kind: 'finish_recovered', ...(occurredAt ? { occurredAt } : {}), message: 'The job had finished without its result reaching this workflow; recorded from the job\'s own record.' } };
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
        event: { id: `pr-${pr.merged ? 'merged' : 'closed'}:${w.pullRequest}@${w.version}`, at: iso(at), kind: 'finished', generation: w.generation, prNumber: w.pullRequest, message },
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
    // Every check finished, yet no job took the result: the check event was missed (or never
    // sent: CI that only reports commit statuses). With recovery, the CI step is started for this
    // head, fenced against a real check event, a push, a close or a stop meanwhile (recovery.ts).
    // Without it, or where it is refused or spent, a person starts the next step.
    let on = w;
    let note: string | undefined;
    if (recovery) {
      const out = await recovery.missedCheckEvent(w, pr, checks, at, canAct);
      if (out.kind === 'recovered') report.recovered++;
      if (out.kind !== 'report') return;
      on = out.workflow;
      note = out.note;
    }
    return block(
      'ci_event_missed',
      `The checks on ${short(pr.headSha)} finished (${checks.failed} failed, ${checks.passed} passed${checks.total === 0 ? ', none reported' : ''}), but no job picked their result up: the check event never reached Updraft.${note ? ` ${note}` : ''}`,
      'Re-run a check on GitHub (its result restarts the review loop), or retry the last job from its page.',
      `ci-missed:${pr.headSha}`,
      on,
    );
  }

  return async function reconcileWorkflows(): Promise<ReconcileReport> {
    const report: ReconcileReport = { checked: 0, repaired: 0, blocked: 0, finished: 0, failed: 0, recovered: 0, backlog: 0, oldestDueSeconds: 0 };
    if (await killSwitch.engaged()) return report;
    const at = now();
    let acted = 0;
    const canAct = () => {
      if (acted >= (deps.maxRecoveries ?? MAX_RECOVERIES_PER_RECONCILE) || now() - at > (deps.recoveryBudgetMs ?? RECOVERY_BUDGET_MS)) return false;
      acted++;
      return true;
    };
    for (const due of await deps.store.listDueWorkflows(at, limit)) {
      const w = await deps.store.getWorkflow(due.installationId, due.workflowId);
      // Gone, or no longer due (a job started, another run changed it): the index entry is stale.
      if (!w?.nextCheckAt || Date.parse(w.nextCheckAt) > at) continue;
      try {
        await one(w, at, report, canAct);
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
