import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Every agent Updraft Cloud can run, as a deployment whose image ships all of them (agents.ts).
    env: { CLOUD_AGENTS: 'claude,codex,kiro' },
  },
});
