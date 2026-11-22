#!/usr/bin/env node
// The local CLI's agent telemetry (src/telemetry/local.ts) uses the microVM runner's tracer, so
// a trace from `updraft start` has exactly the spans of one from Updraft Cloud. The runner's
// files (deploy/aws-microvm/image/runner/) are the source; src/telemetry/runner/ holds copies,
// kept identical by test/telemetry-copy.test.ts.
//
//   node scripts/copy-telemetry.mjs          copy src/telemetry/runner/ into dist/ (after tsc, which does not)
//   node scripts/copy-telemetry.mjs --sync   refresh src/telemetry/runner/ from the runner's files
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED = ['telemetry.mjs', 'telemetry-detail.mjs', 'redact.mjs'];
const runner = path.join(root, 'deploy/aws-microvm/image/runner');
const copies = path.join(root, 'src/telemetry/runner');
const dist = path.join(root, 'dist/telemetry/runner');

if (process.argv.includes('--sync')) {
  for (const name of SHARED) fs.copyFileSync(path.join(runner, name), path.join(copies, name));
  console.log(`copied ${SHARED.join(', ')} into src/telemetry/runner/`);
} else {
  fs.mkdirSync(dist, { recursive: true });
  for (const name of fs.readdirSync(copies).filter((n) => n.endsWith('.mjs') || n.endsWith('.d.mts'))) fs.copyFileSync(path.join(copies, name), path.join(dist, name));
}
