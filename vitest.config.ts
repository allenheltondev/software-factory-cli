import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // node:sqlite is a builtin; keep vitest from trying to bundle it.
    server: { deps: { external: [/^node:/] } },
  },
});
