// "A run is working on this right now": a note `updraft run-event` leaves in the state database
// for the other machines that share it (docs/shared-state.md, "Checkpoints").
//
// A run's database reaches the shared copy while the run is still going (a checkpoint merge,
// `updraft state merge --live`), so another machine can start from a snapshot that shows this
// run's work in flight: a queued reviewer job, a review posting scheduled for a retry, a merge
// waiting for checks. A hold says whose that is. It is one `meta` row per job of the event (or
// per pull request, for a pull request event); everything the review loop hangs off a held job's
// pull request is held with it. Another run leaves held work alone until the hold is released
// (the holder's last write, or the final merge of its database) or has expired.
import type { Db } from './database.js';

export const HOLD_PREFIX = 'run-event:hold:';

export interface Hold {
  key: string;
  /** The process that holds it: unique per run of `run-event`. */
  holder: string;
  delivery: string | null;
  /** ISO time after which the hold no longer counts, whatever else happened. */
  until: string;
  /** ISO time at which the holder (or the merge of its database) let go; null while held. */
  releasedAt: string | null;
}

export type HoldSubject = { job: string } | { pr: { repoId: number; prNumber: number } };

export function holdKey(subject: HoldSubject): string {
  return 'job' in subject ? `${HOLD_PREFIX}job:${subject.job}` : `${HOLD_PREFIX}pr:${subject.pr.repoId}#${subject.pr.prNumber}`;
}

/** What a hold's key is about; null for a key of another shape. */
export function holdSubject(key: string): HoldSubject | null {
  if (!key.startsWith(HOLD_PREFIX)) return null;
  const rest = key.slice(HOLD_PREFIX.length);
  if (rest.startsWith('job:') && rest.length > 4) return { job: rest.slice(4) };
  const pr = /^pr:(\d+)#(\d+)$/.exec(rest);
  return pr ? { pr: { repoId: Number(pr[1]), prNumber: Number(pr[2]) } } : null;
}

function parse(key: string, value: string): Hold | null {
  try {
    const v = JSON.parse(value) as Partial<Hold> | null;
    if (!v || typeof v.holder !== 'string' || typeof v.until !== 'string') return null;
    return { key, holder: v.holder, delivery: typeof v.delivery === 'string' ? v.delivery : null, until: v.until, releasedAt: typeof v.releasedAt === 'string' ? v.releasedAt : null };
  } catch {
    return null;
  }
}

const serialize = (h: Omit<Hold, 'key'>) => JSON.stringify({ holder: h.holder, delivery: h.delivery, until: h.until, releasedAt: h.releasedAt });

export function listHolds(db: Db): Hold[] {
  const rows = db.prepare('SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?').all(HOLD_PREFIX.length, HOLD_PREFIX) as Array<{ key: string; value: string }>;
  return rows.flatMap((r) => parse(r.key, r.value) ?? []);
}

/** Holds of other runs that count at `nowMs`: not released and not expired. */
export function activeForeignHolds(db: Db, holder: string, nowMs: number): Hold[] {
  return listHolds(db).filter((h) => h.holder !== holder && h.releasedAt === null && Date.parse(h.until) > nowMs);
}

export function putHold(db: Db, subject: HoldSubject, hold: { holder: string; delivery: string | null; until: string }): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(holdKey(subject), serialize({ ...hold, releasedAt: null }));
}

/** Let go of everything `holder` holds. Returns how many holds that was. */
export function releaseHolds(db: Db, holder: string, at: string): number {
  let released = 0;
  for (const h of listHolds(db)) {
    if (h.holder !== holder || h.releasedAt !== null) continue;
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(serialize({ ...h, releasedAt: at }), h.key);
    released++;
  }
  return released;
}

/** The released form of a hold's value, or null when it is released already or is not a hold. For the merge. */
export function releasedHoldValue(key: string, value: string, at: string): string | null {
  const h = parse(key, value);
  return h && h.releasedAt === null ? serialize({ ...h, releasedAt: at }) : null;
}
