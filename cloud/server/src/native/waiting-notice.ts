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
  failed: number;
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
      try {
        await deps.comment(job, body);
      } catch (error) {
        await deps.sessions.releaseNotice(installationId, job.id, at).catch(() => undefined);
        report.failed++;
        log({ claudeWaiting: 'notice failed', installationId, jobId: job.id, name: (error as Error)?.name });
        continue;
      }
      report.noticed++;
      log({ claudeWaiting: 'noticed', installationId, jobId: job.id, readiness, ...(retirement ? { retirementReason: retirement } : {}) });
      await deps.workflows?.waiting({
        installationId, repository: job.subject.repository, repositoryId: job.subject.repositoryId, issue: job.subject.issue,
        eventName: job.request.eventName ?? 'issues', deliveryId: job.request.deliveryId, jobId: job.id,
      }, signInWait(action, { readiness, ...(retirement ? { retirement } : {}) }));
    }
  }

  return async function notify(): Promise<WaitingNoticeReport> {
    const report: WaitingNoticeReport = { tenants: 0, noticed: 0, failed: 0 };
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
