import type { Store } from '../store/store.js';

/**
 * Job results follow the stack's ResultRetentionDays (#71): every day, each tenant's
 * `tenants/<id>/results/` (the result documents and the logs the console serves) loses what is
 * older than that. A lifecycle rule cannot do it: the tenant's id is in the middle of the key.
 * What a run does not get to is done by the next one.
 */

export interface DatedObject {
  key: string;
  lastModified: number;
}

export interface ResultsRetentionDeps {
  store: Pick<Store, 'listTenants'>;
  /** Objects under a prefix, with when each was last written (epoch ms). */
  listDated(prefix: string): Promise<DatedObject[]>;
  /** Deletes these keys (at most 1000 per call). */
  deleteObjects(keys: string[]): Promise<void>;
  retentionDays: number;
  now?: () => number;
  log?: (message: string) => void;
}

export async function expireResults(deps: ResultsRetentionDeps): Promise<{ deleted: number; failed: number[] }> {
  const cutoff = (deps.now ?? Date.now)() - deps.retentionDays * 24 * 60 * 60 * 1000;
  const log = deps.log ?? ((m: string) => console.log(m));
  let deleted = 0;
  const failed: number[] = [];
  for (const tenant of await deps.store.listTenants()) {
    try {
      const old = (await deps.listDated(`tenants/${tenant.installationId}/results/`)).filter((o) => o.lastModified < cutoff).map((o) => o.key);
      for (let i = 0; i < old.length; i += 1000) await deps.deleteObjects(old.slice(i, i + 1000));
      deleted += old.length;
    } catch (err) {
      failed.push(tenant.installationId);
      log(JSON.stringify({ installationId: tenant.installationId, warning: `could not expire results: ${(err as Error)?.name}` }));
    }
  }
  return { deleted, failed };
}
