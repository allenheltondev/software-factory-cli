// Builds the job MicroVM image for one Updraft Cloud stack and turns jobs on with it.
//
// Run with AWS credentials for the stack's account (as tenant-admin):
//   npm run build-job-image --workspace=server -- [--stack updraft-cloud] [--region us-east-1]
//     [--tarball path/to/updraft.tgz] [--no-activate]
//
//   1. packs this repository's Updraft CLI (`npm pack` at the root), unless --tarball names one
//   2. zips deploy/aws-microvm/image/ (the same image the self-hosted stack builds) with it
//   3. uploads the zip to the stack's JobImageBucket and creates or updates the image
//   4. waits for the version to build, and reports the reason if it fails
//   5. writes the version to the stack's JobImageVersionParameter: the launcher starts jobs with
//      it within a minute (--no-activate leaves the running version alone)
//
// Until step 5 has run once, the launcher starts no jobs at all.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ResourceNotFoundException,
  UpdateMicrovmImageCommand,
  type UpdateMicrovmImageCommandInput,
} from '@aws-sdk/client-lambda-microvms';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { createAdminClients } from './admin-clients.js';
import { buildContext, IMAGE_DIR, repoRoot } from './job-image-context.js';
import { zip } from './zip.js';

const ARCHITECTURE = 'ARM_64';
const MEMORY_MIB = 4096;
const HOOK_PORT = 9000;
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;

/** `npm pack` at the repository root (its prepack builds the CLI); returns the tarball's path. */
function packCli(dest: string): string {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const out = execFileSync(npm, ['pack', '--json', '--pack-destination', dest], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
  const parsed = JSON.parse(out.slice(out.indexOf('['))) as { filename: string }[];
  return join(dest, basename(parsed[0]!.filename));
}

async function main() {
  const { values } = parseArgs({
    options: {
      stack: { type: 'string', default: 'updraft-cloud' },
      region: { type: 'string' },
      tarball: { type: 'string' },
      'no-activate': { type: 'boolean', default: false },
    },
  });
  const clients = createAdminClients(values.region);
  const region = await clients.s3.config.region();
  const microvms = new LambdaMicrovmsClient({ region });
  const stack = await clients.cloudFormation.send(new DescribeStacksCommand({ StackName: values.stack }));
  const outputs = Object.fromEntries((stack.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
  for (const name of ['JobImageName', 'JobImageBucket', 'JobImageBuildRoleArn', 'JobImageVersionParameter', 'MicrovmLogGroup']) {
    if (!outputs[name]) throw new Error(`stack ${values.stack} has no ${name} output; deploy it first`);
  }
  const imageName = outputs.JobImageName!;

  const scratch = mkdtempSync(join(tmpdir(), 'updraft-job-image-'));
  try {
    const tarballPath = values.tarball ?? packCli(scratch);
    console.log(`==> Updraft from ${basename(tarballPath)}`);
    const archive = zip(buildContext(IMAGE_DIR, { name: basename(tarballPath), data: readFileSync(tarballPath) }));

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const key = `image/context-${stamp}.zip`;
    console.log(`==> uploading the build context (${(archive.length / 1024 / 1024).toFixed(1)} MB) to s3://${outputs.JobImageBucket}/${key}`);
    await clients.s3.send(new PutObjectCommand({ Bucket: outputs.JobImageBucket, Key: key, Body: archive, ContentType: 'application/zip' }));

    const common: Omit<UpdateMicrovmImageCommandInput, 'imageIdentifier'> = {
      baseImageArn: `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
      buildRoleArn: outputs.JobImageBuildRoleArn,
      codeArtifact: { uri: `s3://${outputs.JobImageBucket}/${key}` },
      description: `Updraft Cloud job runner, built ${stamp}`,
      cpuConfigurations: [{ architecture: ARCHITECTURE }],
      resources: [{ minimumMemoryInMiB: MEMORY_MIB }],
      logging: { cloudWatch: { logGroup: outputs.MicrovmLogGroup } },
      hooks: {
        port: HOOK_PORT,
        microvmImageHooks: { ready: 'ENABLED', readyTimeoutInSeconds: 300 },
        microvmHooks: { run: 'ENABLED', runTimeoutInSeconds: 60, terminate: 'ENABLED', terminateTimeoutInSeconds: 60, suspend: 'ENABLED', suspendTimeoutInSeconds: 30 },
      },
    };

    let exists = true;
    try {
      await microvms.send(new GetMicrovmImageCommand({ imageIdentifier: imageName }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
      exists = false;
    }
    const version = exists
      ? (await microvms.send(new UpdateMicrovmImageCommand({ imageIdentifier: imageName, ...common }))).imageVersion
      : (await microvms.send(new CreateMicrovmImageCommand({ name: imageName, tags: { 'updraft:stack': values.stack! }, ...common }))).imageVersion;
    if (!version) throw new Error('the API returned no image version');
    console.log(`==> ${exists ? 'updated' : 'created'} ${imageName}; waiting for version ${version} to build (logs: ${outputs.MicrovmLogGroup})`);

    const started = Date.now();
    for (;;) {
      const v = await microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: imageName, imageVersion: version }));
      if (v.state === 'SUCCESSFUL') break;
      if (v.state === 'FAILED') {
        const reason = (v as { stateReason?: string }).stateReason ?? 'no reason given';
        throw new Error(`version ${version} failed to build: ${reason}; see ${outputs.MicrovmLogGroup}`);
      }
      if (Date.now() - started > BUILD_TIMEOUT_MS) throw new Error(`version ${version} is still ${v.state} after ${BUILD_TIMEOUT_MS / 60000} minutes`);
      console.log(`    ${v.state} (${Math.round((Date.now() - started) / 1000)} s)`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
    console.log(`==> version ${version} is built`);

    if (values['no-activate']) {
      console.log(`--no-activate: jobs keep their current version. To switch: aws ssm put-parameter --overwrite --type String --name ${outputs.JobImageVersionParameter} --value ${version}`);
      return;
    }
    await clients.ssm.send(new PutParameterCommand({ Name: outputs.JobImageVersionParameter, Value: version, Type: 'String', Overwrite: true }));
    console.log(`==> jobs now start with version ${version} (${outputs.JobImageVersionParameter}; the launcher picks it up within a minute)`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(`build-job-image: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
