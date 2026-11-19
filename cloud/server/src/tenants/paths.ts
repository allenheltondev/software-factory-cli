/** Where a tenant's config bundles are: tenants/<installationId>/config/<version>/ in the tenant bucket. */
export const configPrefix = (installationId: number, version: number) => `tenants/${installationId}/config/${version}/`;
