// Builds the job MicroVM image for one Updraft Cloud stack and turns jobs on with it.
//
// Run with AWS credentials for the stack's account (as tenant-admin):
//   npm run build-job-image --workspace=server -- [--stack updraft-cloud] [--region us-east-1]
//     [--tarball path/to/updraft.tgz] [--no-activate] [--check]
//
//   1. packs this repository's Updraft CLI (`npm pack` at the root), unless --tarball names one;
//      a version built from such a tarball records no fingerprint, so CI's next check rebuilds it
//   2. zips deploy/aws-microvm/image/ (the same image the self-hosted stack builds) with it
//   3. uploads the zip to the stack's JobImageBucket and creates or updates the image
//   4. waits for the version to build, and reports the reason if it fails
//   5. writes the version to the stack's JobImageVersionParameter: the launcher starts jobs with
//      it within a minute (--no-activate leaves the running version alone)
//
// Until step 5 has run once, the launcher starts no jobs at all.
//
// Each version records the fingerprint of what it was built from (job-image-inputs.ts) in its
// description. --check builds nothing: it says whether the active version's fingerprint differs
// from this checkout's (or no version is active), as `build=true|false` and `reason=...` in
// $GITHUB_OUTPUT when that is set. The deploy workflow builds only then.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { GetParameterCommand, ParameterNotFound, PutParameterCommand } from '@aws-sdk/client-ssm';
import { createAdminClients } from './admin-clients.js';
import { buildContext, IMAGE_DIR, repoRoot } from './job-image-context.js';
import { describeInputs, imageInputFingerprint, inputsFromDescription } from './job-image-inputs.js';
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
      check: { type: 'boolean', default: false },
    },
  });
  const clients = createAdminClients(values.region);
  const region = await clients.s3.config.region();
  const microvms = new LambdaMicrovmsClient({ region });
  const stack = await clients.cloudFormation.send(new DescribeStacksCommand({ StackName: values.stack }));
  const outputs = Object.fromEntries((stack.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
  for (const name of ['JobImageName', 'JobImageArn', 'JobImageBucket', 'JobImageBuildRoleArn', 'JobImageVersionParameter', 'MicrovmLogGroup']) {
    if (!outputs[name]) throw new Error(`stack ${values.stack} has no ${name} output; deploy it first`);
  }
  const imageName = outputs.JobImageName!;
  // Every call but Create identifies the image by its ARN: the API refuses the bare name.
  const imageArn = outputs.JobImageArn!;
  const fingerprint = imageInputFingerprint();

  if (values.check) {
    const { build, reason } = await compareWithActive(microvms, clients.ssm, imageArn, outputs.JobImageVersionParameter!, fingerprint);
    console.log(`==> ${build ? 'build' : 'no build'}: ${reason}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}
reason=${reason}
`);
    return;
  }

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
      // The fingerprint says this checkout's CLI is inside; a --tarball may be any other build.
      description: `Updraft Cloud job runner, built ${stamp}${values.tarball ? `, CLI from ${basename(values.tarball)}` : `, ${describeInputs(fingerprint)}`}`,
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
      await microvms.send(new GetMicrovmImageCommand({ imageIdentifier: imageArn }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
      exists = false;
    }
    const version = exists
      ? (await microvms.send(new UpdateMicrovmImageCommand({ imageIdentifier: imageArn, ...common }))).imageVersion
      : (await microvms.send(new CreateMicrovmImageCommand({ name: imageName, tags: { 'updraft:stack': values.stack! }, ...common }))).imageVersion;
    if (!version) throw new Error('the API returned no image version');
    console.log(`==> ${exists ? 'updated' : 'created'} ${imageName}; waiting for version ${version} to build (logs: ${outputs.MicrovmLogGroup})`);

    const started = Date.now();
    for (;;) {
      const v = await microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: version }));
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

/** Whether the active version was built from what this checkout would build (its fingerprint). */
async function compareWithActive(
  microvms: LambdaMicrovmsClient,
  ssm: ReturnType<typeof createAdminClients>['ssm'],
  imageArn: string,
  parameter: string,
  fingerprint: string,
): Promise<{ build: boolean; reason: string }> {
  let active: string | undefined;
  try {
    active = (await ssm.send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value;
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err;
  }
  if (!active) return { build: true, reason: 'no job image is active yet' };
  let description: string | undefined;
  try {
    description = (await microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: active }))).description;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    return { build: true, reason: `the active version ${active} does not exist` };
  }
  const built = inputsFromDescription(description);
  if (!built) return { build: true, reason: `the active version ${active} records no fingerprint of what it was built from` };
  if (built !== fingerprint) return { build: true, reason: `the active version ${active} was built from other inputs than this checkout` };
  return { build: false, reason: `the active version ${active} was built from this checkout's inputs` };
}

main().catch((err: unknown) => {
  console.error(`build-job-image: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
