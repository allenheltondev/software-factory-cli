import { readinessAction, signInWait, waitingComment, type NativeLaunch, type NativeReadiness } from '../jobs/launch.js';
import type { Store } from '../store/store.js';
import type { WorkflowRecorder } from '../workflows/recorder.js';
import type { ClaudeSessions, WaitingClaudeJob } from './sessions.js';

/**
 * The late sign-in notice (#176). A job parked on a wait that ends by itself (a starting worker,
 * a heartbeat gap, an unreadable auth probe) gets no comment. If that wait then becomes one only a
 * person can end (cleanup sealed the session as `worker-lost` or `startup-failed`, the login
 * lapsed), nothing else would ever tell anyone, and the job would sit until its wait expires. So
 * on every workflow reconciliation run this looks at each installation's waiting jobs that have
 * had no notice yet, judges the installation's Claude environment as dispatch does, and when a
 * sign-in is now needed posts the one friendly comment on each job's issue and records the wait,
 * with its specific reason, on the workflow timeline.
 *
 * Exactly once per job: a notice is claimed on the waiting record before it is posted (the park
 * claims it too when it comments at once), and given back only when the comment fails, so the
 * next run tries again.
 */
export interface WaitingNoticeReport {
  tenants: number;
  noticed: number;
  /** Comments GitHub will never take (the issue or repository is gone, locked, archived, or out of the App's reach): ended, not retried. */
  unpostable: number;
  failed: number;
}

/**
 * Whether GitHub's refusal of the comment is final: 403 (a locked issue, an archived repository,
 * no access), 404, 410 (deleted) or 422. A rate limit (429, or a 403 that says so) and anything
 * else (5xx, the network, no token) may pass, so its claim is given back and retried.
 */
export function commentCanNeverPost(error: unknown): boolean {
  const e = error as { status?: unknown; rateLimited?: unknown } | null;
  if (!e || typeof e.status !== 'number' || e.rateLimited === true) return false;
  return [403, 404, 410, 422].includes(e.status);
}

export function createWaitingNotifier(deps: {
  tenants: Pick<Store, 'listTenants'>;
  sessions: Pick<ClaudeSessions, 'unnoticed' | 'claimNotice' | 'releaseNotice'>;
  resolveNative(installationId: number): Promise<NativeLaunch | undefined>;
  /** Posts the comment on the job's issue. */
  comment(job: WaitingClaudeJob & { subject: NonNullable<WaitingClaudeJob['subject']> }, body: string): Promise<void>;
  consoleOrigin?: string;
  workflows?: Pick<WorkflowRecorder, 'waiting'>;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));

  async function tenant(installationId: number, report: WaitingNoticeReport) {
    const jobs = (await deps.sessions.unnoticed(installationId, now())).filter((j): j is WaitingClaudeJob & { subject: NonNullable<WaitingClaudeJob['subject']> } => !!j.subject);
    if (!jobs.length) return;
    const native = await deps.resolveNative(installationId);
    if (!native?.readiness) return;
    const readiness: NativeReadiness = await native.readiness();
    const action = readinessAction(readiness);
    if (action !== 'sign-in' && action !== 'reconnect') return;
    const retirement = readiness === 'environment-retiring' ? await native.retirement?.().catch(() => undefined) : undefined;
    for (const job of jobs) {
      const link = deps.consoleOrigin ? new URL(`/installations/${installationId}/claude?request=${job.id}`, deps.consoleOrigin).href : undefined;
      const body = link ? waitingComment(link, readiness, retirement) : undefined;
      if (!body) continue;
      const at = now();
      if (!await deps.sessions.claimNotice(installationId, job.id, at)) continue;
      const wait = signInWait(action, { readiness, ...(retirement ? { retirement } : {}) });
      const record = (why: typeof wait) => deps.workflows?.waiting({
        installationId, repository: job.subject.repository, repositoryId: job.subject.repositoryId, issue: job.subject.issue,
        eventName: job.request.eventName ?? 'issues', deliveryId: job.request.deliveryId, jobId: job.id,
      }, why);
      try {
        await deps.comment(job, body);
      } catch (error) {
        if (commentCanNeverPost(error)) {
          // The claim stays: retrying every run for the wait's whole life cannot help. The wait
          // and why no comment was posted go on the timeline instead.
          report.unpostable++;
          log({ claudeWaiting: 'notice unpostable', installationId, jobId: job.id, status: (error as { status?: number }).status });
          await record({ ...wait, message: `${wait.message} No comment could be posted on the issue (GitHub refused it: ${(error as { status?: number }).status}).`,
            code: `${wait.code ?? 'claude_sign_in'}_uncommented` });
          continue;
        }
        await deps.sessions.releaseNotice(installationId, job.id, at).catch(() => undefined);
        report.failed++;
        log({ claudeWaiting: 'notice failed', installationId, jobId: job.id, name: (error as Error)?.name });
        continue;
      }
      report.noticed++;
      log({ claudeWaiting: 'noticed', installationId, jobId: job.id, readiness, ...(retirement ? { retirementReason: retirement } : {}) });
      await record(wait);
    }
  }

  return async function notify(): Promise<WaitingNoticeReport> {
    const report: WaitingNoticeReport = { tenants: 0, noticed: 0, unpostable: 0, failed: 0 };
    for (const t of await deps.tenants.listTenants()) {
      if (t.status !== 'active') continue;
      report.tenants++;
      try {
        await tenant(t.installationId, report);
      } catch (error) {
        report.failed++;
        log({ claudeWaiting: 'notice check failed', installationId: t.installationId, name: (error as Error)?.name });
      }
    }
    return report;
  };
}
