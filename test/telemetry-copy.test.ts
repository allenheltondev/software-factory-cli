import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The local CLI's tracer is the microVM runner's (scripts/copy-telemetry.mjs): a change to one
// that is not made to the other would make a local trace differ from a cloud one.
const root = path.resolve(import.meta.dirname, '..');

describe("the CLI's copy of the runner's tracer", () => {
  it.each(['telemetry.mjs', 'telemetry-detail.mjs', 'redact.mjs'])('%s is the runner file, byte for byte (node scripts/copy-telemetry.mjs --sync)', (name) => {
    const runner = fs.readFileSync(path.join(root, 'deploy/aws-microvm/image/runner', name), 'utf8');
    const copy = fs.readFileSync(path.join(root, 'src/telemetry/runner', name), 'utf8');
    expect(copy === runner, `src/telemetry/runner/${name} differs from the runner's; run node scripts/copy-telemetry.mjs --sync`).toBe(true);
  });
});
