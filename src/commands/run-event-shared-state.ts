// `updraft run-event --shared-state <file>`: a copy of the shared state database that the caller
// keeps fresher than the snapshot this run started from (its checkpoints download the shared
// copy anyway). It is only ever read. docs/run-event.md, "The last look".
//
// What a run takes from it is knowledge it would otherwise only get at its final merge: which
// reviews of its pull requests another run has already decided. The rows are copied as they
// are, so the merge finds them identical in the shared copy and has nothing to resolve.
import { existsSync } from 'node:fs';
import { openDatabaseReadOnly, SCHEMA_VERSION, schemaVersion, transaction, type Db } from '../db/database.js';

export interface AdoptedReviews {
  /** Reviews of the pull request that the fresher copy has on record and this database did not. */
  adopted: number;
  /** Why the copy was not read (missing, another schema version, unreadable); null when it was. */
  skipped: string | null;
}

/**
 * Copy into `db` the review decisions (`review_requests`) that `file` has for one pull request
 * and `db` does not. A review on record is never evaluated again (src/poller/reviews.ts), so
 * this is what keeps the last look from queuing a revision another machine has queued already.
 * Never throws: a copy that cannot be read is the same as none.
 */
export function adoptReviewRequests(db: Db, file: string, repoId: number, prNumber: number): AdoptedReviews {
  if (!existsSync(file)) return { adopted: 0, skipped: 'the file does not exist' };
  let other: Db;
  try {
    other = openDatabaseReadOnly(file);
  } catch (err) {
    return { adopted: 0, skipped: err instanceof Error ? err.message : String(err) };
  }
  try {
    const version = schemaVersion(other);
    if (version !== SCHEMA_VERSION) return { adopted: 0, skipped: `it is at state schema v${version}, not v${SCHEMA_VERSION}` };
    const rows = other.prepare('SELECT * FROM review_requests WHERE repo_id = ? AND pr_number = ?').all(repoId, prNumber) as Array<Record<string, string | number | null>>;
    if (!rows.length) return { adopted: 0, skipped: null };
    const columns = Object.keys(rows[0]!);
    const insert = db.prepare(`INSERT INTO review_requests (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT (repo_id, review_id) DO NOTHING`);
    const adopted = transaction(db, () => rows.reduce((n, r) => n + Number(insert.run(...columns.map((c) => r[c] ?? null)).changes), 0));
    return { adopted, skipped: null };
  } catch (err) {
    return { adopted: 0, skipped: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      other.close();
    } catch {
      // already closed
    }
  }
}
