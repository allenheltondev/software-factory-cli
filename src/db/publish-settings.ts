// When publication was turned on for each repository (repositories.<repo>.publish). The config
// file has no history, so every time the CLI loads it with the state DB open, it compares each
// repository's publish mode with what it saw last and records the change. The worker's startup
// sweep (src/publish/publish.ts) uses enabled_at so that turning publish on never publishes runs
// that finished before then.
import { publishMode, type UpdraftConfig, type PublishMode } from '../config/schema.js';
import { nowIso } from '../util/ids.js';
import { transaction, type Db } from './database.js';

export interface PublishSetting {
  repoId: number;
  repoFullName: string;
  mode: PublishMode;
  /** When publish last went from none to draft-pr or pr. Null while it is none. */
  enabledAt: string | null;
  updatedAt: string;
}

interface PublishSettingRow {
  repo_id: number;
  repo_full_name: string;
  mode: PublishMode;
  enabled_at: string | null;
  updated_at: string;
}

const toSetting = (r: PublishSettingRow): PublishSetting => ({
  repoId: r.repo_id,
  repoFullName: r.repo_full_name,
  mode: r.mode,
  enabledAt: r.enabled_at,
  updatedAt: r.updated_at,
});

export function getPublishSetting(db: Db, repoId: number): PublishSetting | null {
  const row = db.prepare('SELECT * FROM publish_settings WHERE repo_id = ?').get(repoId) as PublishSettingRow | undefined;
  return row ? toSetting(row) : null;
}

export interface PublishSettingChange {
  repoId: number;
  repoFullName: string;
  from: PublishMode;
  to: PublishMode;
  enabledAt: string | null;
}

/**
 * Record each repository's current publish mode:
 * - off to on (none, or not seen before, to draft-pr/pr): enabled_at = now;
 * - on to off, or the repository is no longer configured: enabled_at cleared;
 * - draft-pr to pr or back: enabled_at kept.
 * Returns what changed. Repositories are matched by GitHub id, as jobs are.
 */
export function syncPublishSettings(db: Db, config: Pick<UpdraftConfig, 'repositories'>, now: () => number = Date.now): PublishSettingChange[] {
  const at = nowIso(now);
  return transaction(db, () => {
    const changes: PublishSettingChange[] = [];
    const seen = new Set<number>();
    const upsert = db.prepare(
      `INSERT INTO publish_settings (repo_id, repo_full_name, mode, enabled_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo_id) DO UPDATE SET repo_full_name = excluded.repo_full_name, mode = excluded.mode,
         enabled_at = excluded.enabled_at, updated_at = excluded.updated_at`,
    );
    const record = (repoId: number, fullName: string, to: PublishMode, prev: PublishSetting | null) => {
      const from = prev?.mode ?? 'none';
      const enabledAt = to === 'none' ? null : from === 'none' ? at : (prev?.enabledAt ?? at);
      if (prev && prev.mode === to && prev.enabledAt === enabledAt && prev.repoFullName === fullName) return;
      if (!prev && to === 'none') return; // nothing to remember yet
      upsert.run(repoId, fullName, to, enabledAt, at);
      if (from !== to) changes.push({ repoId, repoFullName: fullName, from, to, enabledAt });
    };
    for (const [fullName, repo] of Object.entries(config.repositories)) {
      if (seen.has(repo.id)) continue; // validation rejects duplicate ids; the first one wins, as in findRepoConfig
      seen.add(repo.id);
      record(repo.id, fullName, publishMode(repo), getPublishSetting(db, repo.id));
    }
    const stale = db.prepare("SELECT * FROM publish_settings WHERE mode != 'none'").all() as unknown as PublishSettingRow[];
    for (const row of stale) {
      if (!seen.has(row.repo_id)) record(row.repo_id, row.repo_full_name, 'none', toSetting(row));
    }
    return changes;
  });
}

/**
 * Succeeded runs with a summary and no publication record that ended at or after their
 * repository's enabled_at, oldest first. Only a first cut: the caller still applies publish.ts's
 * eligibility rules (live mode, local-branch action, publish on in the config, commits).
 */
export function listUnpublishedSinceEnabled(db: Db): string[] {
  return (
    db
      .prepare(
        `SELECT r.id
         FROM runs r
         JOIN jobs j ON j.id = r.job_id
         JOIN publish_settings s ON s.repo_id = j.repo_id
         LEFT JOIN publications p ON p.run_id = r.id
         WHERE r.outcome = 'succeeded'
           AND r.summary IS NOT NULL
           AND r.ended_at IS NOT NULL
           AND p.run_id IS NULL
           AND s.mode != 'none'
           AND s.enabled_at IS NOT NULL
           AND r.ended_at >= s.enabled_at
         ORDER BY r.ended_at, r.id`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}
