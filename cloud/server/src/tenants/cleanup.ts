import type { CleanupEntry, Store } from '../store/store.js';
import { ALL_AGENT_KEY_NAMES, agentKeySecretName, type SecretsPort } from './agent-keys.js';

/**
 * The uninstall retention deadline (#64: "uninstalling disables the tenant, and its data is
 * deleted after retention"). The table's own rows expire by DynamoDB TTL (#73); this deletes what
 * TTL cannot reach, and any row an interrupted uninstall sweep left without a TTL:
 *
 *   s3://<TenantBucket>/tenants/<installationId>/   config bundles (and, later, state and results)
 *   updraft/tenants/<installationId>/agent-keys/*   the agent key secrets
 *   TENANT#<installationId> in the table             every row still there
 *
 * markUninstalled records a cleanup entry without a TTL, in the same transaction that disables
 * the tenant (or records its tombstone), so no uninstall exists without one. A daily run takes
 * every entry whose deadline has passed, deletes all three, and forgets the entry only once they
 * are gone: a run that fails (or times out) part-way leaves the entry, and the next run does it
 * again. Every step is safe to repeat.
 */

export const tenantPrefix = (installationId: number) => `tenants/${installationId}/`;

export interface CleanupDeps {
  store: Store;
  /** Keys under a prefix of the tenant bucket. */
  listObjects(prefix: string): Promise<string[]>;
  /** Deletes these keys (at most 1000 per call). */
  deleteObjects(keys: string[]): Promise<void>;
  secrets: Pick<SecretsPort, 'remove'>;
  routineSecretNames?: (installationId: number) => Promise<string[]>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface CleanupReport {
  cleaned: number[];
  failed: { installationId: number; error: string }[];
}

export async function runCleanup(deps: CleanupDeps): Promise<CleanupReport> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((m: string) => console.log(m));
  const report: CleanupReport = { cleaned: [], failed: [] };
  for (const entry of await deps.store.listDueCleanups(now)) {
    try {
      await cleanTenant(entry, deps);
      await deps.store.completeCleanup(entry);
      report.cleaned.push(entry.installationId);
      log(JSON.stringify({ cleanup: 'done', installationId: entry.installationId }));
    } catch (err) {
      // Left for the next run.
      report.failed.push({ installationId: entry.installationId, error: err instanceof Error ? err.message : String(err) });
      log(JSON.stringify({ cleanup: 'failed', installationId: entry.installationId, error: String(err) }));
    }
  }
  return report;
}

async function cleanTenant(entry: CleanupEntry, deps: CleanupDeps): Promise<void> {
  const keys = await deps.listObjects(tenantPrefix(entry.installationId));
  for (let i = 0; i < keys.length; i += 1000) await deps.deleteObjects(keys.slice(i, i + 1000));
  for (const name of ALL_AGENT_KEY_NAMES) await deps.secrets.remove(agentKeySecretName(entry.installationId, name));
  for (const name of (await deps.routineSecretNames?.(entry.installationId)) ?? []) await deps.secrets.remove(name);
  // And any table row an interrupted uninstall sweep left without a TTL.
  await deps.store.purgeTenantPartition(entry.installationId);
}
