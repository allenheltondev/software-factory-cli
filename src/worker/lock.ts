// OWNER: queue/worker workstream. Single-worker lock stored in the worker_lock table.
import { transaction, type Db } from '../db/database.js';
import { nowIso } from '../util/ids.js';

/** How often a running worker refreshes its lock heartbeat (and run leases). */
export const WORKER_HEARTBEAT_MS = 15_000;
/** A lock whose heartbeat is older than this is considered abandoned and can be taken over. */
export const WORKER_STALE_MS = 3 * WORKER_HEARTBEAT_MS;

export interface LockHolder {
  workerId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
}

export class WorkerLockedError extends Error {
  constructor(readonly holder: { workerId: string; pid: number; hostname: string; heartbeatAt: string }) {
    super(
      `another updraft worker is running (pid ${holder.pid} on ${holder.hostname}, last heartbeat ${holder.heartbeatAt})`,
    );
    this.name = 'WorkerLockedError';
  }
}

interface LockRow {
  worker_id: string;
  pid: number;
  hostname: string;
  started_at: string;
  heartbeat_at: string;
}

const toHolder = (r: LockRow): LockHolder => ({
  workerId: r.worker_id,
  pid: r.pid,
  hostname: r.hostname,
  startedAt: r.started_at,
  heartbeatAt: r.heartbeat_at,
});

export function readWorkerLock(db: Db): LockHolder | null {
  const row = db.prepare('SELECT * FROM worker_lock WHERE id = 1').get() as LockRow | undefined;
  return row ? toHolder(row) : null;
}

export type TakeoverReason = 'stale-heartbeat' | 'dead-pid';

export interface AcquireResult {
  /** The previous holder whose lock was taken over (its runs need reconciling), if any. */
  previous: LockHolder | null;
  takeover: TakeoverReason | null;
}

/**
 * Acquire the single-worker lock atomically. Takes over a lock whose heartbeat is
 * older than WORKER_STALE_MS, or whose holder is on this host with a dead pid.
 * Otherwise throws WorkerLockedError.
 */
export function acquireWorkerLock(
  db: Db,
  me: { workerId: string; pid: number; hostname: string },
  opts: { now?: () => number; isPidAlive: (pid: number) => boolean },
): AcquireResult {
  const clock = opts.now ?? Date.now;
  return transaction(db, () => {
    const at = nowIso(clock);
    const row = db.prepare('SELECT * FROM worker_lock WHERE id = 1').get() as LockRow | undefined;
    let result: AcquireResult = { previous: null, takeover: null };
    if (row) {
      const holder = toHolder(row);
      const age = clock() - Date.parse(row.heartbeat_at);
      if (age > WORKER_STALE_MS) {
        result = { previous: holder, takeover: 'stale-heartbeat' };
      } else if (row.hostname === me.hostname && row.pid !== me.pid && !opts.isPidAlive(row.pid)) {
        result = { previous: holder, takeover: 'dead-pid' };
      } else {
        throw new WorkerLockedError(holder);
      }
    }
    db.prepare(
      `INSERT INTO worker_lock (id, worker_id, pid, hostname, started_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET worker_id = excluded.worker_id, pid = excluded.pid, hostname = excluded.hostname,
         started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
    ).run(me.workerId, me.pid, me.hostname, at, at);
    return result;
  });
}

/** Refresh the heartbeat. Returns false if this worker no longer holds the lock. */
export function heartbeatWorkerLock(db: Db, workerId: string, now?: () => number): boolean {
  const res = db
    .prepare('UPDATE worker_lock SET heartbeat_at = ? WHERE id = 1 AND worker_id = ?')
    .run(nowIso(now ?? Date.now), workerId);
  return Number(res.changes) > 0;
}

/** Release the lock if this worker still holds it. */
export function releaseWorkerLock(db: Db, workerId: string): void {
  db.prepare('DELETE FROM worker_lock WHERE id = 1 AND worker_id = ?').run(workerId);
}
