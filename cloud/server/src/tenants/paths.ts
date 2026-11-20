/** Where a tenant's config bundles are: tenants/<installationId>/config/<version>/ in the tenant bucket. */
export const configPrefix = (installationId: number, version: number) => `tenants/${installationId}/config/${version}/`;
/** Beside each bundle: what the version was written as (tenants/publish.ts ConfigSource). A job downloads it with the bundle, but nothing in the job uses it. */
export const SOURCE_FILE = 'source.json';
