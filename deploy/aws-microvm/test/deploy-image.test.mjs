// `deploy.sh activate <version>`, run for real with a stand-in `aws` on PATH (fake-aws.mjs,
// with the stack, the launcher, the image and the check microVM in a JSON file). What is tested
// is the script's own decisions: a version reaches jobs (the stack's ImageVersion) only after its
// isolation check passed, the check microVM is started as a job's would be and is terminated,
// and a failed or missing check changes nothing. The real AWS CLI and CloudFormation are not
// involved (README.md, "What is not verified").
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.join(HERE, '..', 'deploy.sh');
const FAKE_AWS = path.join(HERE, 'fake-aws.mjs');
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;

const EGRESS = 'arn:aws:lambda:eu-test-1:000000000000:network-connector:vpc-egress';
const passed = '[runner] ISOLATION CHECK {"ok":true,"failedStep":null,"problems":[],"checks":{}}';
const failed = '[runner] ISOLATION CHECK {"ok":false,"failedStep":"packet filter","problems":["the packet filter could not be installed: nft exited 1 (the runner has no CAP_NET_ADMIN)"],"checks":{}}';

describe.runIf(hasBash)('deploy.sh activate', () => {
  let root;
  let env;
  let stateFile;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-deploy-image-test-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'aws'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AWS}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'zip'), '#!/bin/sh\n: > "$3"\n', { mode: 0o755 });
    stateFile = path.join(root, 'aws-state.json');
    env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AWS_REGION: 'eu-test-1', FAKE_AWS_STATE: stateFile, CHECK_POLL_SECONDS: '0', CHECK_TIMEOUT_SECONDS: '0' };
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const setup = (overrides = {}) =>
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        parameters: { ImageName: 'updraft-job', ImageVersion: '1.0', AgentIsolation: 'enforced' },
        launcherEnv: {
          IMAGE_ARN: 'arn:aws:lambda:eu-test-1:000000000000:microvm-image:updraft-job',
          EXECUTION_ROLE_ARN: 'arn:aws:iam::000000000000:role/updraft-microvm-MicrovmExecutionRole-x',
          EGRESS_CONNECTOR_ARN: EGRESS,
          MICROVM_LOG_GROUP: '/aws/lambda-microvms/updraft-job',
          AGENT_ISOLATION: 'enforced',
        },
        latestActive: '2.0',
        versions: { '1.0': 'SUCCESSFUL', '2.0': 'SUCCESSFUL', '3.0': 'IN_PROGRESS' },
        checkLines: {},
        ...overrides,
      }),
    );
  const aws = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const activate = (version) => spawnSync('bash', [DEPLOY, 'activate', version], { env, encoding: 'utf8' });

  it('points jobs at the version only after its isolation check passed in a microVM started like a job', () => {
    setup({ checkLines: { '2.0': passed } });
    const run = activate('2.0');
    expect(run.status, run.stderr).toBe(0);
    const after = aws();
    expect(after.parameters).toEqual({ ImageName: 'updraft-job', ImageVersion: '2.0', AgentIsolation: 'enforced' });
    expect(after.runs).toHaveLength(1);
    const input = after.runs[0];
    expect(input).toMatchObject({
      imageIdentifier: 'arn:aws:lambda:eu-test-1:000000000000:microvm-image:updraft-job',
      imageVersion: '2.0',
      executionRoleArn: 'arn:aws:iam::000000000000:role/updraft-microvm-MicrovmExecutionRole-x',
      ingressNetworkConnectors: ['arn:aws:lambda:eu-test-1:aws:network-connector:aws-network-connector:NO_INGRESS'],
      egressNetworkConnectors: [EGRESS],
      maximumDurationInSeconds: 900,
    });
    expect(input.logging.cloudWatch.logStream).toMatch(/^isolation-check\/2\.0\/\d{8}T\d{6}Z$/);
    const payload = JSON.parse(input.runHookPayload);
    expect(payload).toEqual({ version: 3, checkId: expect.stringMatching(/^image-check-\d{8}t\d{6}z$/) });
    expect(after.terminated).toEqual(['microvm-check-1']);
    expect(run.stdout).toContain('jobs now run image version 2.0');
  });

  it('leaves jobs on their version when the check fails, and says why', () => {
    setup({ checkLines: { '2.0': failed } });
    const run = activate('2.0');
    expect(run.status).not.toBe(0);
    expect(aws().parameters.ImageVersion).toBe('1.0');
    expect(aws().terminated).toEqual(['microvm-check-1']);
    expect(run.stderr).toContain('CAP_NET_ADMIN');
    expect(run.stderr).toContain('image version 2.0 failed its isolation check');
    expect(run.stderr).toContain('jobs stay on version 1.0');
  });

  it('fails the check when the microVM ends, or nothing is logged in time', () => {
    setup({ checkState: 'TERMINATED' });
    let run = activate('2.0');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('the microVM ended (TERMINATED) before the check reported');
    expect(aws().parameters.ImageVersion).toBe('1.0');

    setup();
    run = activate('2.0');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('no ISOLATION CHECK line within 0s');
    expect(aws().parameters.ImageVersion).toBe('1.0');
    expect(aws().terminated).toEqual(['microvm-check-1']);
  });

  it('refuses a version that has not built, without starting anything', () => {
    setup();
    const run = activate('3.0');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('image version 3.0 is IN_PROGRESS, not SUCCESSFUL');
    expect(aws().runs).toBeUndefined();
    expect(aws().parameters.ImageVersion).toBe('1.0');
    expect(activate('../x').stderr).toContain('not an image version');
  });

  it('with AgentIsolation disabled, activates without a check', () => {
    setup({ launcherEnv: { IMAGE_ARN: 'x', EXECUTION_ROLE_ARN: 'y', EGRESS_CONNECTOR_ARN: 'z', MICROVM_LOG_GROUP: 'g', AGENT_ISOLATION: 'disabled' } });
    const run = activate('2.0');
    expect(run.status, run.stderr).toBe(0);
    expect(aws().runs).toBeUndefined();
    expect(aws().parameters.ImageVersion).toBe('2.0');
  });

  // `image` up to the upload, which the stand-in refuses: what it did before building anything.
  // A stand-in `zip` too: what it packs is not looked at.
  it('pins jobs to the version they run before it uploads or builds anything (ImageVersion empty: Lambda\'s latest active)', () => {
    setup({ parameters: { ImageName: 'updraft-job', ImageVersion: '', AgentIsolation: 'enforced' }, latestActive: '2.0' });
    let run = spawnSync('bash', [DEPLOY, 'image'], { env: { ...env, FAKE_AWS_BUCKET: 'job-bucket' }, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('pinning jobs to image version 2.0');
    expect(aws().parameters.ImageVersion).toBe('2.0');

    // No version yet: jobs are refused until one has passed its check.
    setup({ parameters: { ImageName: 'updraft-job', ImageVersion: '', AgentIsolation: 'enforced' }, latestActive: null });
    run = spawnSync('bash', [DEPLOY, 'image'], { env: { ...env, FAKE_AWS_BUCKET: 'job-bucket' }, encoding: 'utf8' });
    expect(aws().parameters.ImageVersion).toBe('none');

    // Already pinned: left alone.
    setup({ parameters: { ImageName: 'updraft-job', ImageVersion: '1.0', AgentIsolation: 'enforced' } });
    run = spawnSync('bash', [DEPLOY, 'image'], { env: { ...env, FAKE_AWS_BUCKET: 'job-bucket' }, encoding: 'utf8' });
    expect(run.stdout).toContain('jobs stay on image version 1.0');
    expect(aws().parameters.ImageVersion).toBe('1.0');
  });

  it('re-activating the version jobs already run is not an error', () => {
    setup({ parameters: { ImageName: 'updraft-job', ImageVersion: '2.0', AgentIsolation: 'enforced' }, checkLines: { '2.0': passed } });
    const run = activate('2.0');
    expect(run.status, run.stderr).toBe(0);
    expect(aws().parameters.ImageVersion).toBe('2.0');
  });
});
