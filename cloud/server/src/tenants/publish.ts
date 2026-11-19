import type { Store } from '../store/store.js';
import { compileTenantConfig, type CompileResult, type ConfigIssue, type PlatformSettings, type TenantSubmission } from './config.js';

/**
 * Publishing a tenant's config (#68): compile and validate it (config.ts), store the bundle
 * immutably, and only then make it the version jobs start with.
 *
 *   tenants/<installationId>/config/<version>/config.yaml
 *   tenants/<installationId>/config/<version>/prompts/<name>.md
 *
 * 1. allocate the next version (pending): versions only grow, and none is ever rewritten
 * 2. upload every file of the bundle
 * 3. mark the version ready
 * 4. activate it: one conditional write, refused for a version that is not ready or a tenant
 *    being uninstalled
 *
 * A failure anywhere leaves the previous active version active: a pending version is never
 * started. A job pins the version that was active when it was dispatched (the launcher, PR 4),
 * so publishing never changes a job already running.
 */

export const configPrefix = (installationId: number, version: number) => `tenants/${installationId}/config/${version}/`;

export interface PublishDeps {
  store: Store;
  /** Writes one object to the tenant bucket. */
  putObject: (key: string, body: string, contentType: string) => Promise<void>;
  now?: () => number;
}

export type PublishResult =
  | { ok: true; version: number; sha256: string; warnings: ConfigIssue[] }
  | { ok: false; reason: 'invalid'; errors: ConfigIssue[] }
  | { ok: false; reason: 'no_tenant' | 'uninstalled' | 'superseded' | 'not_activated'; message: string };

export async function publishTenantConfig(
  input: { installationId: number; submission: TenantSubmission; platform: PlatformSettings; repositoryIds: ReadonlyMap<string, number>; publishedBy: string },
  deps: PublishDeps,
): Promise<PublishResult> {
  const compiled: CompileResult = compileTenantConfig(input.submission, input.platform, input.repositoryIds);
  if (!compiled.ok) return { ok: false, reason: 'invalid', errors: compiled.errors };

  const id = input.installationId;
  const version = await deps.store.createConfigVersion(id, {
    sha256: compiled.sha256,
    files: Object.keys(compiled.files).sort(),
    publishedBy: input.publishedBy,
    publishedAt: new Date((deps.now ?? Date.now)()).toISOString(),
  });
  if (version === 'no_tenant') return { ok: false, reason: 'no_tenant', message: `there is no tenant for installation ${id}` };
  if (version === 'uninstalled') return { ok: false, reason: 'uninstalled', message: `installation ${id} was uninstalled` };

  const prefix = configPrefix(id, version);
  for (const [path, body] of Object.entries(compiled.files)) {
    await deps.putObject(`${prefix}${path}`, body, path.endsWith('.yaml') ? 'application/yaml' : 'text/markdown; charset=utf-8');
  }
  await deps.store.markConfigReady(id, version);

  const activated = await deps.store.activateConfig(id, version);
  if (activated === 'superseded') {
    // A later publish finished first; activation only moves forward, so that one stays active.
    return { ok: false, reason: 'superseded', message: `version ${version} was stored, but a newer version was activated meanwhile and stays active` };
  }
  if (activated !== 'activated') {
    return { ok: false, reason: 'not_activated', message: `version ${version} was stored but not activated (${activated}); the previous version stays active` };
  }
  return { ok: true, version, sha256: compiled.sha256, warnings: compiled.warnings };
}
