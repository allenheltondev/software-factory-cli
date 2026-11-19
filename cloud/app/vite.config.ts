import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Behind CloudFront the SPA and the API share one origin (`/api/*` goes to API Gateway), so the
 * app only ever calls relative `/api/v1/...` paths. Locally the same paths are proxied to the API
 * dev server (`server/src/local.ts`, port 8787): no CORS anywhere and no base URL to configure.
 */
const API_DEV_SERVER = process.env.UPDRAFT_API_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: API_DEV_SERVER, changeOrigin: true } },
  },
  preview: { port: 4173 },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
