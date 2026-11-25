import type { Store } from '../store/store.js';
import { isTerminated, unusedTime } from './quotas.js';

/**
 * A `reserved` entry older than this is a launch that stopped before it asked for a microVM (the
 * webhook Lambda's timeout is 20 seconds): reclaimed. Matches the launcher's delivery claim.
 */
export const RESERVATION_RECLAIM_MS = 5 * 60 * 1000;

/**
 * Quota reconciliation (#68), every five minutes (CleanupFunction's Reconcile schedule): the
 * platform-side path that keeps a launched job's capacity held while its microVM may run, and gives
 * it back once Lambda shows the microVM gone, whatever the runner did or did not report.
 *
 * It goes through the platform's active entries (written with the reservation, removed on
 * release), not the slots, so a reservation is found whatever else its launch managed to write:
 *
 *   reserved, older than five minutes          reclaimed: no microVM was ever asked for, so the
 *                                              slots and the day's and month's count go back, and
 *                                              any job record is retired (launch_failed)
 *   launching: microVM TERMINATED, or none     released: its slots freed and the microVM time it
 *                                              did not use refunded, once (Store.releaseJob)
 *   launching, past its maximum duration with  released: Lambda has stopped any microVM it had
 *     no microVM id
 *   anything else (RUNNING, TERMINATING...)    its slots held again until its maximum duration
 *
 * `TERMINATING` waits: Lambda runs the /terminate hook before it frees the microVM's resources.
 */
/** The outcome of a job whose microVM ended without the job's finish. */
export const MICROVM_GONE_OUTCOME = 'microvm_gone';

export function createReconciler({
  store,
  microvmState,
  native,
  stop,
  now = Date.now,
  log = (entry) => console.log(JSON.stringify(entry)),
}: {
  store: Store;
  stop?: { advance(job: import('../store/store.js').Job): Promise<import('./stop.js').StopResult> };
  native?: { reconcile(job: import('../store/store.js').Job): Promise<boolean> };
  /** lambda:GetMicrovm: the state, or null when Lambda has no such microVM. */
  microvmState: (microvmId: string) => Promise<string | null>;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  return async function reconcile(): Promise<{ released: string[]; held: number; failed: number }> {
    const released: string[] = [];
    let held = 0;
    let failed = 0;
    for (const entry of await store.listActiveJobs()) {
      const { jobId } = entry;
      try {
        const nativeJob = await store.getJob(jobId);
        if (nativeJob?.stop) {
          if (!stop) throw new Error('job cancellation reconciliation is not configured');
          const result = await stop.advance(nativeJob);
          if (result.state === 'stopping') { held++; if (result.stop?.error) failed++; }
          else released.push(jobId);
          continue;
        }
        if (nativeJob?.native) {
          if (!native) throw new Error('native worker reconciliation is not configured');
          if (await native.reconcile(nativeJob)) released.push(jobId); else held++;
          continue;
        }
        if (entry.phase === 'reserved') {
          // The launch may still be under way; past this, it stopped before RunMicrovm.
          if (now() - entry.reservedAt < RESERVATION_RECLAIM_MS) continue;
          // The guarded cancel goes first, and wins the reservation or touches nothing: this run's
          // list may be stale, and the launch may have moved the entry on to launching since
          // (mismatch). Once only, even with another run reclaiming it at the same time (gone).
          if ((await store.cancelReservation(entry, 'reserved')) !== 'cancelled') continue;
          const job = await store.getJob(jobId);
          if (job) {
            await store.markStopping(jobId);
            await store.finishJob(jobId, 'launch_failed');
            await store.releaseJob(job);
          }
          released.push(jobId);
          continue;
        }
        const job = await store.getJob(jobId);
        if (!job) {
          // Launching with no record (it expired, a week after the job could last).
          if (now() > entry.expiresAt) await store.forgetActiveJob(entry);
          continue;
        }
        if (job.releasedAt !== undefined) {
          // Released before, with something left over (a delete that failed): finish it now.
          await store.releaseJob(job);
          continue;
        }
        const gone = job.microvmId ? isTerminated(await microvmState(job.microvmId)) : now() > job.expiresAt;
        if (gone) {
          // A microVM that ended without the job's finish (stopped, crashed, out of time): the job
          // is over for the console too. finishJob keeps a finish that won the race.
          if (job.status !== 'finished') await store.finishJob(jobId, MICROVM_GONE_OUTCOME, { at: now() });
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
