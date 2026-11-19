// Public library entry point (`@allenheltondev/updraft/config`). Exposes the exact schema and
// validator the worker uses, so other consumers validate configs identically.
export { configSchema, CONFIG_VERSION } from './schema.js';
export type { UpdraftConfig, UpdraftConfigInput } from './schema.js';
export { validateConfig } from './validate.js';
export type { ValidationResult } from './validate.js';
