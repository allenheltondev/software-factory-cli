import type { Store } from '../store/store.js';
import { isTerminated, unusedTime } from './quotas.js';

/**
 * Quota reconciliation (#68), every five minutes (CleanupFunction's Reconcile schedule): the
 * platform-side path that keeps a launched job's capacity held while its microVM may run, and gives
 * it back once Lambda shows the microVM gone, whatever the runner did or did not report.
 *
 * It goes through the platform's active jobs (recorded with the job, before its microVM starts,
 * until it is released), not their slots, so a job whose slots ran out is still found:
 *
 *   microVM TERMINATED, or no such microVM     released: its slots freed and the microVM time it
 *                                              did not use refunded, once (Store.releaseJob)
 *   past its maximum duration, no microVM id   released: Lambda has stopped any microVM it had
 *   anything else (RUNNING, TERMINATING...)    its slots held again until its maximum duration,
 *                                              which retries a hold that failed at launch
 *
 * `TERMINATING` waits: Lambda runs the /terminate hook before it frees the microVM's resources.
 */
export function createReconciler({
  store,
  microvmState,
  now = Date.now,
  log = (entry) => console.log(JSON.stringify(entry)),
}: {
  store: Store;
  /** lambda:GetMicrovm: the state, or null when Lambda has no such microVM. */
  microvmState: (microvmId: string) => Promise<string | null>;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  return async function reconcile(): Promise<{ released: string[]; held: number; failed: number }> {
    const released: string[] = [];
    let held = 0;
    let failed = 0;
    for (const jobId of await store.listActiveJobs()) {
      try {
        const job = await store.getJob(jobId);
        // No record (it expired a week after the job could last): the entry's TTL removes it.
        if (!job) continue;
        if (job.releasedAt !== undefined) {
          // Released before, with something left over (a delete that failed): finish it now.
          await store.releaseJob(job);
          continue;
        }
        const gone = job.microvmId ? isTerminated(await microvmState(job.microvmId)) : now() > job.expiresAt;
        if (gone) {
          await store.releaseJob(job, unusedTime(job, now()));
          released.push(jobId);
          continue;
        }
        held++;
        if (!(await store.holdSlots(job, job.expiresAt))) {
          log({ reconcile: 'warning', jobId, warning: "another job holds one of this running job's slots: it runs outside the quota" });
        }
      } catch (err) {
        failed++;
        log({ reconcile: 'error', jobId, name: (err as Error)?.name, message: (err as Error)?.message });
      }
    }
    if (released.length > 0 || failed > 0) log({ reconcile: 'done', released, held, failed });
    return { released, held, failed };
  };
}
