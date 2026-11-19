import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pub from './public.js';
import { configSchema, CONFIG_VERSION } from './schema.js';
import { validateConfig } from './validate.js';

describe('config public entry point', () => {
  it('re-exports the schema, version and validator the worker uses', () => {
    expect(pub.configSchema).toBe(configSchema);
    expect(pub.CONFIG_VERSION).toBe(CONFIG_VERSION);
    expect(pub.validateConfig).toBe(validateConfig);
  });

  it('is wired into package.json exports', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./config']).toEqual({
      types: './dist/config/public.d.ts',
      default: './dist/config/public.js',
    });
  });
});
