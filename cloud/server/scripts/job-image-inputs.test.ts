import { describe, expect, it } from 'vitest';
import { describeInputs, fingerprintOf, imageInputFiles, imageInputFingerprint, inputsFromDescription, isImageInput } from './job-image-inputs.js';

describe('the job image inputs', () => {
  it('are what the image is built from, and what validation the server shares with its CLI', () => {
    for (const path of [
      'deploy/aws-microvm/image/Dockerfile',
      'deploy/aws-microvm/image/runner/job.mjs',
      'deploy/aws-microvm/image/build.env',
      'cloud/server/scripts/build-job-image.ts',
      'cloud/server/scripts/job-image-check.ts',
      'cloud/server/scripts/job-image-context.ts',
      'cloud/server/scripts/job-image-inputs.ts',
      'cloud/server/scripts/zip.ts',
      'src/config/schema.ts',
      // validate.ts checks models and effort against these (review fix on #80).
      'src/agents/profile.ts',
      'src/agents/adapters/registry.ts',
      'src/agents/adapters/claude.ts',
      'package.json',
      'package-lock.json',
    ]) {
      expect(isImageInput(path), path).toBe(true);
    }
  });

  it('leave out app, server and the rest of the CLI, tests elsewhere, docs and the self-hosted stack', () => {
    for (const path of [
      'cloud/app/src/App.tsx',
      'cloud/server/src/jobs/launch.ts',
      'cloud/server/scripts/tenant-admin.ts',
      'cloud/server/scripts/zip.test.ts',
      'cloud/package.json',
      'cloud/infra/template.yaml',
      'src/commands/run-event.ts',
      'src/agentsfoo.ts',
      'deploy/aws-microvm/test/runner-job.test.mjs',
      'deploy/aws-microvm/template.yaml',
      'docs/config.md',
      '.github/workflows/cloud-deploy-env.yaml',
    ]) {
      expect(isImageInput(path), path).toBe(false);
    }
  });

  it('fingerprint paths and contents, whatever the order or line endings', () => {
    const files = [
      { path: 'src/config/schema.ts', data: Buffer.from('a\nb\n') },
      { path: 'src/agents/profile.ts', data: Buffer.from('effort: high\n') },
    ];
    const fingerprint = fingerprintOf(files);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf([...files].reverse())).toBe(fingerprint);
    expect(fingerprintOf([{ ...files[0]!, data: Buffer.from('a\r\nb\r\n') }, files[1]!])).toBe(fingerprint);

    // A change to an agent profile alone is a new image.
    expect(fingerprintOf([files[0]!, { ...files[1]!, data: Buffer.from('effort: low\n') }])).not.toBe(fingerprint);
    expect(fingerprintOf([files[0]!, { ...files[1]!, path: 'src/agents/profile2.ts' }])).not.toBe(fingerprint);
    expect(fingerprintOf([files[0]!])).not.toBe(fingerprint);
  });

  it("finds this checkout's inputs, agent profiles among them", () => {
    const paths = imageInputFiles().map((f) => f.path);
    expect(paths).toContain('deploy/aws-microvm/image/Dockerfile');
    expect(paths).toContain('src/agents/profile.ts');
    expect(paths).toContain('package-lock.json');
    expect(paths.every(isImageInput)).toBe(true);
    expect(paths.some((p) => p.includes('node_modules/'))).toBe(false);
    expect(imageInputFingerprint()).toBe(imageInputFingerprint());
  });

  it('round-trips through an image version description', () => {
    const fingerprint = 'ab'.repeat(32);
    expect(inputsFromDescription(`Updraft Cloud job runner, built 20261120T091700Z, ${describeInputs(fingerprint)}`)).toBe(fingerprint);
    expect(inputsFromDescription('Updraft Cloud job runner, built 20261120T091700Z')).toBeNull();
    expect(inputsFromDescription(undefined)).toBeNull();
  });
});
