import type { Store } from '../store/store.js';
import { compileTenantConfig, type CompileResult, type ConfigIssue, type PlatformSettings, type TenantSubmission } from './config.js';

/**
 * Publishing a tenant's config (#68): compile and validate it (config.ts), store the bundle
 * immutably, and only then make it the version jobs start with.
 *
 *   tenants/<installationId>/config/<version>/config.yaml
 *   tenants/<installationId>/config/<version>/prompts/<name>.md
 *   tenants/<installationId>/config/<version>/source.json   what it was written as (not run)
 *
 * 1. allocate the next version (pending): versions only grow, and none is ever rewritten
 * 2. upload every file of the bundle
 * 3. mark the version ready
 * 4. activate it: one conditional write, refused for a version that is not ready or a tenant
 *    being uninstalled
 *
 * A failure anywhere leaves the previous active version active: a pending version is never
 * started. A job pins the version that was active when it was dispatched (jobs/launch.ts),
 * so publishing never changes a job already running.
 */

import { configPrefix, SOURCE_FILE } from './paths.js';

export { configPrefix, SOURCE_FILE };

/**
 * What the version was written as, kept beside the bundle as `source.json` so it can be edited
 * again or re-activated: the console's settings (tenants/console.ts), or a tenant config document
 * (`tenant-admin config publish`), whose prompts are the bundle's own `prompts/`.
 */
export type ConfigSource = { format: 'console'; config: unknown } | { format: 'tenant'; config: unknown };

export interface PublishDeps {
  store: Store;
  /** Writes one object to the tenant bucket. */
  putObject: (key: string, body: string, contentType: string) => Promise<void>;
  now?: () => number;
}

export type PublishResult =
  | { ok: true; version: number; sha256: string; warnings: ConfigIssue[]; yaml: string }
  | { ok: false; reason: 'invalid'; errors: ConfigIssue[] }
  | { ok: false; reason: 'no_tenant' | 'uninstalled' | 'superseded' | 'changed' | 'not_activated'; message: string };

export async function publishTenantConfig(
  input: {
    installationId: number;
    submission: TenantSubmission;
    platform: PlatformSettings;
    repositoryIds: ReadonlyMap<string, number>;
    publishedBy: string;
    /** Stored as source.json. Absent: the submission's config document (format `tenant`). */
    source?: ConfigSource;
    /** Re-activating: the earlier version this one copies. */
    copiedFrom?: number;
    /**
     * The active version the caller checked this publish against (null: none). Activation is
     * refused (`changed`) unless that is still the active version, in the same conditional write.
     */
    expectedActive?: number | null;
  },
  deps: PublishDeps,
): Promise<PublishResult> {
  const compiled: CompileResult = compileTenantConfig(input.submission, input.platform, input.repositoryIds);
  if (!compiled.ok) return { ok: false, reason: 'invalid', errors: compiled.errors };

  const id = input.installationId;
  // Not part of the bundle's hash: what jobs run is config.yaml and the prompts.
  const source: ConfigSource = input.source ?? { format: 'tenant', config: input.submission.config };
  const files: Record<string, string> = { ...compiled.files, [SOURCE_FILE]: `${JSON.stringify(source, null, 2)}
` };
  const version = await deps.store.createConfigVersion(id, {
    sha256: compiled.sha256,
    files: Object.keys(files).sort(),
    dispatch: compiled.dispatch,
    publishedBy: input.publishedBy,
    publishedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    ...(input.copiedFrom !== undefined ? { copiedFrom: input.copiedFrom } : {}),
  });
  if (version === 'no_tenant') return { ok: false, reason: 'no_tenant', message: `there is no tenant for installation ${id}` };
  if (version === 'uninstalled') return { ok: false, reason: 'uninstalled', message: `installation ${id} was uninstalled` };

  const prefix = configPrefix(id, version);
  for (const [path, body] of Object.entries(files)) {
    await deps.putObject(`${prefix}${path}`, body, contentType(path));
  }
  await deps.store.markConfigReady(id, version);

  const activated = await deps.store.activateConfig(id, version, input.expectedActive !== undefined ? { expectedActive: input.expectedActive } : undefined);
  if (activated === 'changed') {
    return { ok: false, reason: 'changed', message: `version ${version} was stored but not activated: another version was activated after this one was checked` };
  }
  if (activated === 'superseded') {
    // A later publish finished first; activation only moves forward, so that one stays active.
    return { ok: false, reason: 'superseded', message: `version ${version} was stored, but a newer version was activated meanwhile and stays active` };
  }
  if (activated !== 'activated') {
    return { ok: false, reason: 'not_activated', message: `version ${version} was stored but not activated (${activated}); the previous version stays active` };
  }
  return { ok: true, version, sha256: compiled.sha256, warnings: compiled.warnings, yaml: compiled.files['config.yaml']! };
}

const contentType = (path: string) =>
  path.endsWith('.yaml') ? 'application/yaml' : path.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8';
