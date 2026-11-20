import type { Store } from '../store/store.js';
import { isTerminated, unusedTime } from './quotas.js';

/**
 * Quota reconciliation (#68), every five minutes (CleanupFunction's Reconcile schedule): the
 * platform-side path that gives a job's capacity back once Lambda shows its microVM gone, whatever
 * the runner did or did not report.
 *
 * For each job holding a platform slot (every admitted job holds one), it asks Lambda for the
 * microVM's state. `TERMINATED`, or no such microVM, releases the job: its slots are freed and the
 * microVM time it did not use refunded, once (Store.releaseJob). Anything else, including
 * `TERMINATING` (Lambda runs the /terminate hook before it frees the microVM's resources), waits for
 * the next run. A job with no recorded microVM keeps its slots until they run out, which is no later
 * than its maximum duration, when Lambda stops any microVM it had.
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
    for (const { jobId } of await store.listPlatformSlots()) {
      try {
        const job = await store.getJob(jobId);
        // No record (it expired): the slot runs out on its own.
        if (!job) continue;
        if (job.releasedAt !== undefined) {
          // Released before, with a slot left over (a delete that failed): free it now.
          await store.releaseJobSlots(job);
          continue;
        }
        if (!job.microvmId) {
          held++;
          continue;
        }
        const state = await microvmState(job.microvmId);
        if (!isTerminated(state)) {
          held++;
          continue;
        }
        await store.releaseJob(job, unusedTime(job, now()));
        released.push(jobId);
      } catch (err) {
        failed++;
        log({ reconcile: 'error', jobId, name: (err as Error)?.name, message: (err as Error)?.message });
      }
    }
    if (released.length > 0 || failed > 0) log({ reconcile: 'done', released, held, failed });
    return { released, held, failed };
  };
}
