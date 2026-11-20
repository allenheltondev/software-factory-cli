import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'job-image-paths.sh');
const matched = (paths) =>
  execFileSync('bash', [script], { input: paths.join('\n'), encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

test('what the job image is built from rebuilds it', () => {
  const paths = [
    'deploy/aws-microvm/image/Dockerfile',
    'deploy/aws-microvm/image/runner/job.mjs',
    'deploy/aws-microvm/image/build.env',
    'cloud/server/scripts/build-job-image.ts',
    'cloud/server/scripts/job-image-context.ts',
    'cloud/server/scripts/zip.ts',
    'src/config/schema.ts',
    'package.json',
    'package-lock.json',
  ];
  assert.deepEqual(matched(paths), paths);
});

test('everything else does not: app, server and CLI code, tests, docs, the self-hosted stack', () => {
  assert.deepEqual(
    matched([
      'cloud/app/src/App.tsx',
      'cloud/server/src/jobs/launch.ts',
      'cloud/server/scripts/tenant-admin.ts',
      'cloud/server/scripts/zip.test.ts',
      'cloud/package.json',
      'cloud/infra/template.yaml',
      'src/commands/run-event.ts',
      'src/agents/claude.ts',
      'deploy/aws-microvm/test/runner-job.test.mjs',
      'deploy/aws-microvm/template.yaml',
      'deploy/aws-microvm/README.md',
      'docs/config.md',
      '.github/workflows/cloud-deploy-env.yaml',
    ]),
    [],
  );
});

test('reads Windows line endings and a last line without a newline', () => {
  assert.deepEqual(
    execFileSync('bash', [script], { input: 'README.md\r\npackage.json\r\ndeploy/aws-microvm/image/build.env', encoding: 'utf8' }).split('\n').filter(Boolean),
    ['package.json', 'deploy/aws-microvm/image/build.env'],
  );
});
