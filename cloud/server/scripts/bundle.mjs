// Bundles the Lambda handlers (src/lambda.ts -> dist/index.mjs, src/webhook-lambda.ts ->
// dist/webhook.mjs), which the SAM template's ApiFunction and WebhookFunction deploy as-is
// (CodeUri: ../server/dist). `sam deploy` zips that directory itself, so there is no `sam build`
// step and no artifact bucket.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');
rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints: { index: join(root, 'src', 'lambda.ts'), webhook: join(root, 'src', 'webhook-lambda.ts'), cleanup: join(root, 'src', 'cleanup-lambda.ts') },
  // The Node.js 22 runtime ships AWS SDK v3; use it rather than bundling a copy.
  external: ['@aws-sdk/*'],
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
