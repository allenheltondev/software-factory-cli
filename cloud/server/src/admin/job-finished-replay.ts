import { FlowError } from '../flows/github.js';
import type { Store } from '../store/store.js';
import { EVENT_DETAIL_TYPE, EVENT_SOURCE, PUT_BATCH, jobFinishedDetail, type JobFinishedDetail, type SummaryItem } from '../jobs/job-finished-event.js';

/**
 * Replaying Job Finished events (cloud/README.md, "Replaying Job Finished events"): an admin sends
 * the events of a tenant's jobs that finished before it opted in (or before the publisher was
 * deployed), from the summaries the table keeps for 30 days.
 *
 * Each event is the live path's detail (jobs/job-finished-event.ts) plus `replayed: true`, on the
 * same bus with the same source and detail type. Consumers deduplicate on stack, tenantId and
 * jobId, so replaying a job that was already delivered is harmless.
 *
 * One replay per tenant per 15 minutes, held by a conditional write on a lock item. The lock is
 * given back only when the replay is refused before it sends anything (an invalid window, an
 * unknown or opted-out tenant); a replay that ran, fully or partly, keeps it.
 */

export const REPLAY_LOCK_MS = 15 * 60_000;
export const REPLAY_MAX_WINDOW_MS = 30 * 24 * 3_600_000;

/** A full ISO 8601 timestamp with its zone: a date alone, or a local time, is ambiguous. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;

export type ReplayDetail = JobFinishedDetail & { replayed: true };
export type ReplayEntry = { Source: string; DetailType: string; Detail: string };
/** PutEvents: `Entries` answers each entry in order, an `ErrorCode` on those that failed. */
export type ReplayPut = (entries: ReplayEntry[]) => Promise<{ FailedEntryCount?: number; Entries?: { ErrorCode?: string }[] }>;

export interface ReplayLock {
  /** Taken if there is no lock or it has expired: `{ ok: false, expiresAt }` is the holder's expiry. */
  acquire(installationId: number, now: number, expiresAt: number): Promise<{ ok: true } | { ok: false; expiresAt?: number }>;
  /** Gives back the lock this replay took (expiring at `expiresAt`), never a later one. */
  release(installationId: number, expiresAt: number): Promise<void>;
}

/** A second replay inside the 15 minutes: 429, with Retry-After. */
export class ReplayRateLimitedError extends FlowError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('replay_rate_limited', 429, `A replay of this tenant's Job Finished events ran in the last 15 minutes. Try again in ${retryAfterSeconds} seconds.`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ReplayResult {
  /** Events PutEvents accepted. */
  replayed: number;
  /** Events still rejected after one retry: more than 0 is a 502. */
  failed: number;
  since: string;
  until: string;
}

/** The detail a replay sends for a summary: the live path's, marked. */
export function replayedDetail(row: SummaryItem, stack: string): ReplayDetail | undefined {
  const detail = jobFinishedDetail(row, stack);
  return detail && { ...detail, replayed: true };
}

/** The window, or the reason it is refused. `until` in the future is clamped to now. */
export function replayWindow(body: { since?: unknown; until?: unknown }, now: number): { since: number; until: number } | string {
  const at = (raw: unknown) => (typeof raw === 'string' && ISO_TIMESTAMP.test(raw) ? Date.parse(raw) : NaN);
  const since = at(body.since);
  const requested = at(body.until);
  if (Number.isNaN(since) || Number.isNaN(requested)) return 'since and until must both be ISO 8601 timestamps with a time zone, such as 2026-11-01T00:00:00Z';
  const until = Math.min(requested, now);
  if (since >= until) return 'since must be before until (and before now)';
  if (until - since > REPLAY_MAX_WINDOW_MS) return 'The window may be at most 30 days';
  return { since, until };
}

export function createJobFinishedReplay({
  store,
  stack,
  lock,
  summaries,
  put,
  now = Date.now,
  log = (entry) => console.log(JSON.stringify(entry)),
}: {
  store: Pick<Store, 'getTenant'>;
  /** The stack name the live publisher sends as (its STACK_NAME). */
  stack: string;
  lock: ReplayLock;
  /** The tenant's finished job summaries, in DynamoDB's format, page by page. */
  summaries: (installationId: number) => AsyncIterable<SummaryItem>;
  put: ReplayPut;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  /** Sends one batch, then its failed entries once more: how many are still rejected. */
  async function send(entries: ReplayEntry[]): Promise<number> {
    let pending = entries;
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      let out: Awaited<ReturnType<ReplayPut>>;
      try {
        out = await put(pending);
      } catch (err) {
        // Nothing in the call was accepted: all of it is retried (or counted as failed).
        log({ warning: 'PutEvents failed for a Job Finished replay batch', error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (!out.FailedEntryCount) return 0;
      // Without per-entry answers nothing tells which failed, so the whole call is retried.
      pending = out.Entries?.length === pending.length ? pending.filter((_, i) => out.Entries![i]?.ErrorCode) : pending;
    }
    return pending.length;
  }

  return {
    async replay(installationId: number, by: string, body: { since?: unknown; until?: unknown }): Promise<ReplayResult> {
      const at = now();
      const expiresAt = at + REPLAY_LOCK_MS;
      const taken = await lock.acquire(installationId, at, expiresAt);
      if (!taken.ok) {
        const left = taken.expiresAt !== undefined ? taken.expiresAt - at : REPLAY_LOCK_MS;
        throw new ReplayRateLimitedError(Math.max(1, Math.ceil(left / 1000)));
      }
      const refuse = async (error: FlowError) => {
        await lock.release(installationId, expiresAt);
        return error;
      };
      const window = replayWindow(body, at);
      if (typeof window === 'string') throw await refuse(new FlowError('invalid_window', 400, window));
      const tenant = await store.getTenant(installationId, { consistent: true });
      if (!tenant) throw await refuse(new FlowError('not_found', 404, `There is no tenant for installation ${installationId}`));
      // The live publisher's opt-in check (job-finished-lambda.ts).
      if (tenant.publishJobFinishedEvents !== true || tenant.disabledReason === 'uninstalled') {
        throw await refuse(new FlowError('not_opted_in', 409,
          'This tenant has not opted in to Job Finished events. Turn them on with PUT /api/v1/admin/tenants/:id/job-finished-events first.'));
      }

      // From here the lock is kept, whatever happens.
      const details: ReplayDetail[] = [];
      const seconds = Math.floor(at / 1000);
      for await (const row of summaries(installationId)) {
        // A summary past its TTL is gone, whether or not DynamoDB has deleted it yet.
        if (row.ttl?.N !== undefined && Number(row.ttl.N) <= seconds) continue;
        const detail = replayedDetail(row, stack);
        if (!detail || detail.tenantId !== String(installationId)) continue;
        const finished = Date.parse(detail.finishedAt);
        if (!(finished >= window.since && finished < window.until)) continue;
        details.push(detail);
      }
      let failed = 0;
      for (let i = 0; i < details.length; i += PUT_BATCH) {
        failed += await send(details.slice(i, i + PUT_BATCH).map((detail) => ({
          Source: EVENT_SOURCE,
          DetailType: EVENT_DETAIL_TYPE,
          Detail: JSON.stringify(detail),
        })));
      }
      const result = {
        replayed: details.length - failed,
        failed,
        since: new Date(window.since).toISOString(),
        until: new Date(window.until).toISOString(),
      };
      log({ admin: by, installationId, action: 'job-finished-events-replay', ...result });
      return result;
    },
  };
}

export type JobFinishedReplay = ReturnType<typeof createJobFinishedReplay>;
