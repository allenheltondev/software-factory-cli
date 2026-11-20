// Bundles the Lambda handlers (src/lambda.ts -> dist/index.mjs, src/webhook-lambda.ts ->
// dist/webhook.mjs, cleanup, broker), which the SAM template's functions deploy as-is
// (CodeUri: ../server/dist). `sam deploy` zips that directory itself, so there is no `sam build`
// step and no artifact bucket.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');
rmSync(outdir, { recursive: true, force: true });

const common = {
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: { index: join(root, 'src', 'lambda.ts') },
  // The Node.js 22 runtime ships AWS SDK v3; use it rather than bundling a copy.
  external: ['@aws-sdk/*'],
});

// The broker, the webhook (the launcher) and cleanup (quota reconciliation) bundle their SDK
// clients: the MicroVMs client is newer than the runtime's SDK, and mixing a bundled client with
// the runtime's core packages would pair mismatched versions.
// The SDK's CommonJS parts require() Node's built-ins, which an ES module has no require for.
await build({
  ...common,
  entryPoints: {
    broker: join(root, 'src', 'broker-lambda.ts'),
    webhook: join(root, 'src', 'webhook-lambda.ts'),
    cleanup: join(root, 'src', 'cleanup-lambda.ts'),
  },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
