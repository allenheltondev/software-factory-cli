import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configRelativePath,
  deadlineMinutes,
  describeExitCode,
  parseAgentEnv,
  runJob,
  updraftInvocation,
  watchdogBudgetMs,
} from '../image/runner/job.mjs';

const FAKE_UPDRAFT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-updraft.mjs');
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----';
const KEY_ARN = 'arn:aws:secretsmanager:eu-test-1:000000000000:secret:key';
const ENV_ARN = 'arn:aws:secretsmanager:eu-test-1:000000000000:secret:env';
const START = Date.parse('2026-01-02T03:04:05.000Z');

let root;
let recordFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-runner-test-'));
  recordFile = path.join(root, 'record.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function request(overrides = {}) {
  return {
    microvmId: 'mvm-01234567-abcd-ef01-2345-6789abcdef01',
    payload: {
      version: 1,
      deliveryId: 'delivery-1',
      eventName: 'issues',
      region: 'eu-test-1',
      bucket: 'job-bucket',
      eventKey: 'events/delivery-1/event.json',
      resultKeyPrefix: 'results/delivery-1/',
      configPrefix: 'config/',
      secrets: { githubAppPrivateKey: KEY_ARN, agentEnv: ENV_ARN },
      maximumDurationSeconds: 7200,
      watchdogReserveSeconds: 300,
      launchedAt: new Date(START).toISOString(),
      // These suites are about the job and its state as they were before isolation existed;
      // runner-isolation.test.mjs covers `enforced`, which is what an absent value means.
      agentIsolation: 'disabled',
      ...overrides,
    },
  };
}

/** Stand-ins for S3, Secrets Manager and TerminateMicrovm, recording every call in order. */
function fakeDeps(mode, overrides = {}) {
  const calls = [];
  const logs = [];
  const output = [];
  const objects = {
    'events/delivery-1/event.json': '{"action":"labeled","issue":{"number":12}}',
    'config/': '',
    'config/config.yaml': 'version: 1\n',
    'config/prompts/implement-issue.md': '# Implement the issue\n',
    ...overrides.objects,
  };
  for (const key of Object.keys(objects)) if (objects[key] === undefined) delete objects[key];
  const secrets = {
    [KEY_ARN]: PEM,
    [ENV_ARN]: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-test-value', FAKE_UPDRAFT_MODE: mode, FAKE_UPDRAFT_RECORD: recordFile }),
    ...overrides.secrets,
  };
  const stopListeners = [];
  const deps = {
    s3Get: async (bucket, key) => {
      calls.push(['s3Get', bucket, key]);
      if (!(key in objects)) throw new Error(`NoSuchKey: ${key}`);
      return Buffer.from(objects[key]);
    },
    s3List: async (bucket, prefix) => {
      calls.push(['s3List', bucket, prefix]);
      return Object.keys(objects)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, size: objects[key].length }));
    },
    s3Put: async (bucket, key, body, contentType) => {
      calls.push(['s3Put', bucket, key, body, contentType]);
    },
    getSecret: async (id) => {
      calls.push(['getSecret', id]);
      if (!(id in secrets)) throw new Error('ResourceNotFoundException');
      return secrets[id];
    },
    terminate: async (id) => {
      calls.push(['terminate', id]);
    },
    stateRoot: path.join(root, 'state'),
    updraftCommand: [process.execPath, FAKE_UPDRAFT],
    // No uid/gid: the test process is not necessarily root. The image sets both.
    jobUser: { home: path.join(root, 'home'), name: 'updraft' },
    baseEnv: {
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'runner-secret-key',
      AWS_SESSION_TOKEN: 'runner-session-token',
      AWS_REGION: 'eu-test-1',
      UPDRAFT_RUN_REQUEST: '{"should":"not leak"}',
      UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH: '/somewhere/else.pem',
      GH_TOKEN: 'ghs_runner',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright',
    },
    log: (message) => logs.push(message),
    logStream: { write: (chunk) => output.push(String(chunk)) },
    onStop: (listener) => stopListeners.push(listener),
    now: () => START + 1000,
    releaseDelivery: async (table, id) => {
      calls.push(['releaseDelivery', table, id]);
    },
    killGraceMs: 300,
    retryDelayMs: 1,
    ...overrides.deps,
  };
  return { deps, calls, logs, output, stop: () => stopListeners.forEach((listener) => listener()) };
}

const names = (calls) => calls.map(([name]) => name);
const written = (calls) => {
  const put = calls.find(([name, , key]) => name === 's3Put' && key.endsWith('.json'));
  return put ? { bucket: put[1], key: put[2], document: JSON.parse(put[3]) } : undefined;
};

// The runner only ever runs in the Linux image: it relies on POSIX file modes, signals and
// process groups, none of which behave this way on Windows. These suites start real child
// processes, so they are left out there; the pure helpers below still run everywhere.
const onLinuxLikeHost = process.platform !== 'win32';

describe.runIf(onLinuxLikeHost)('runJob', () => {
  it('prepares a private state directory, runs updraft run-event, reports and terminates', async () => {
    const { deps, calls, output } = fakeDeps('success');
    const result = await runJob(request(), deps);

    expect(result).toMatchObject({
      deliveryId: 'delivery-1',
      eventName: 'issues',
      microvmId: 'mvm-01234567-abcd-ef01-2345-6789abcdef01',
      outcome: 'succeeded',
      exitCode: 0,
      signal: null,
      summary: { outcome: 'succeeded', prUrl: 'https://github.com/o/r/pull/7', logPath: expect.any(String), exitCode: 0 },
      summaryMissing: false,
      updraftOutcome: 'succeeded',
      error: null,
    });

    // The summary is in S3 next to the event, keyed by microVM, and then the microVM is terminated.
    const report = written(calls);
    expect(report.bucket).toBe('job-bucket');
    expect(report.key).toBe('results/delivery-1/mvm-01234567-abcd-ef01-2345-6789abcdef01.json');
    expect(report.document).toEqual(result);
    expect(names(calls).slice(-2)).toEqual(['s3Put', 'terminate']);

    // Updraft's log and the run log named by the summary are uploaded before the result.
    const uploads = calls.filter(([name]) => name === 's3Put').map(([, , key, body, type]) => ({ key, body: String(body), type }));
    expect(uploads.slice(0, 2)).toEqual([
      { key: 'results/delivery-1/mvm-01234567-abcd-ef01-2345-6789abcdef01/updraft.log', body: 'updraft.log contents\n', type: 'text/plain; charset=utf-8' },
      { key: 'results/delivery-1/mvm-01234567-abcd-ef01-2345-6789abcdef01/run.log', body: 'agent transcript\n', type: 'text/plain; charset=utf-8' },
    ]);
    expect(result.logs).toEqual(uploads.slice(0, 2).map((upload) => upload.key));
    expect(calls.at(-1)).toEqual(['terminate', 'mvm-01234567-abcd-ef01-2345-6789abcdef01']);

    // What the stand-in for updraft saw.
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const stateDir = record.env.UPDRAFT_HOME;
    expect(path.dirname(stateDir)).toBe(deps.stateRoot);
    expect(record.cwd).toBe(fs.realpathSync(stateDir));
    expect(record.args).toEqual([
      'run-event',
      '--event-file',
      path.join(stateDir, 'event.json'),
      '--event-name',
      'issues',
      '--delivery-id',
      'delivery-1',
      '--json',
      '--deadline-minutes',
      '111',
    ]);
    expect(record.event).toBe('{"action":"labeled","issue":{"number":12}}');
    expect(record.config).toBe('version: 1\n');
    expect(record.prompt).toBe('# Implement the issue\n');
    expect(record.keyMode).toBe(0o600);
    expect(record.stateDirMode).toBe(0o700);
    expect(fs.readFileSync(path.join(stateDir, 'github-app.pem'), 'utf8')).toBe(`${PEM}\n`);

    // Its stdout and stderr reach the microVM's log.
    const log = output.join('');
    expect(log).toContain('fake-updraft: starting');
    expect(log).toContain('progress line that is not the summary');
  });

  it('builds the job environment from nothing: no AWS credentials, no key path, no run request', async () => {
    const { deps } = fakeDeps('success');
    await runJob(request(), deps);
    const { env } = JSON.parse(fs.readFileSync(recordFile, 'utf8'));

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-value');
    expect(env.HOME).toBe(deps.jobUser.home);
    expect(env.USER).toBe('updraft');
    expect(env.PATH).toBe(process.env.PATH);
    // The one image setting a job needs besides PATH: where the headless browser was installed.
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/opt/ms-playwright');
    for (const name of Object.keys(env)) {
      expect(name, name).not.toMatch(/^AWS_/);
    }
    expect(env).not.toHaveProperty('UPDRAFT_RUN_REQUEST');
    expect(env).not.toHaveProperty('UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH');
    expect(env).not.toHaveProperty('UPDRAFT_CONFIG');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(JSON.stringify(env)).not.toContain('runner-secret-key');
    expect(JSON.stringify(env)).not.toContain('PRIVATE KEY');
  });

  it('reports a failed run with its summary and still terminates', async () => {
    const { deps, calls } = fakeDeps('fail');
    const result = await runJob(request(), deps);
    expect(result).toMatchObject({
      outcome: 'failed',
      exitCode: 1,
      summary: { outcome: 'failed', message: 'verify command failed', exitCode: 1 },
      summaryMissing: false,
      updraftOutcome: 'failed',
    });
    expect(result.error).toContain('updraft exited 1');
    expect(result.stderrTail).toContain('fake-updraft: verification failed');
    expect(written(calls).document.outcome).toBe('failed');
    expect(names(calls).at(-1)).toBe('terminate');
  });

  it('flags a run that prints no JSON summary', async () => {
    const noJson = fakeDeps('no-summary');
    const result = await runJob(request(), noJson.deps);
    expect(result).toMatchObject({ outcome: 'succeeded', exitCode: 0, summary: null, summaryMissing: true });
    expect(result.error).toContain('without a JSON summary');
    expect(result.error).toContain('not JSON');
    expect(names(noJson.calls).slice(-2)).toEqual(['s3Put', 'terminate']);
  });

  it('reports a failure that comes without a summary', async () => {
    const { deps, calls } = fakeDeps('unknown-mode');
    const result = await runJob(request(), deps);
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 64, summary: null, summaryMissing: true, updraftOutcome: null, error: 'updraft exited with code 64' });
    expect(names(calls).at(-1)).toBe('terminate');
  });

  it('stops a run that outlives the watchdog, keeps what it reported, and terminates', async () => {
    // 7200 s maximum, 300 s reserve, and 6898 s already gone: two seconds are left, enough for
    // the stand-in to start and install its SIGTERM handler on a slow CI runner.
    const { deps, calls, logs } = fakeDeps('hang', { deps: { now: () => START + 6_898_000, deadlineMinutes: 1 } });
    const result = await runJob(request(), deps);
    expect(result.outcome).toBe('timed_out');
    expect(result.error).toContain('watchdog');
    // The stand-in exits on SIGTERM and prints a summary on the way out.
    expect(result.exitCode).toBe(1);
    expect(result.summary).toEqual({ outcome: 'failed', drain: 'stopped', exitCode: 1 });
    expect(logs.join('\n')).toContain('watchdog: updraft outlived its own deadline');
    expect(written(calls).document.outcome).toBe('timed_out');
    expect(names(calls).slice(-2)).toEqual(['s3Put', 'terminate']);
  });

  it('kills a run that ignores the watchdog\'s SIGTERM', async () => {
    const { deps, calls } = fakeDeps('hang-ignoring-sigterm', { deps: { now: () => START + 6_899_500, deadlineMinutes: 1 } });
    const result = await runJob(request(), deps);
    expect(result).toMatchObject({ outcome: 'timed_out', exitCode: null, signal: 'SIGKILL', summaryMissing: true });
    expect(names(calls).slice(-2)).toEqual(['s3Put', 'terminate']);
  });

  it('refuses to start when the microVM has no time left', async () => {
    const { deps, calls } = fakeDeps('success', { deps: { now: () => START + 6_900_000 - 4 * 60_000 + 1 } });
    const result = await runJob(request(), deps);
    expect(result.outcome).toBe('runner_error');
    expect(result.error).toContain('no time left');
    expect(fs.existsSync(recordFile)).toBe(false);
    expect(names(calls).slice(-2)).toEqual(['s3Put', 'terminate']);
  });

  it('stops the run and reports "terminated" when the microVM is being terminated', async () => {
    const harness = fakeDeps('hang');
    const running = runJob(request(), harness.deps);
    // Wait until the stand-in is up, then deliver what the /terminate hook delivers.
    await expect.poll(() => fs.existsSync(recordFile), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => harness.output.join('').includes('fake-updraft: waiting for SIGTERM'), { timeout: 10_000 }).toBe(true);
    harness.stop();
    const result = await running;
    expect(result.outcome).toBe('terminated');
    expect(result.summary).toEqual({ outcome: 'failed', drain: 'stopped', exitCode: 1 });
    expect(written(harness.calls).document.outcome).toBe('terminated');
  });

  it('reports a runner error, without starting updraft, when a secret or the config is unusable', async () => {
    const cases = [
      [{ secrets: { [KEY_ARN]: '' } }, 'private key secret is empty or not a PEM'],
      [{ secrets: { [KEY_ARN]: 'ghp_not_a_key' } }, 'private key secret is empty or not a PEM'],
      [{ secrets: { [ENV_ARN]: '' } }, 'agent environment secret is empty'],
      [{ secrets: { [ENV_ARN]: '{"AWS_ACCESS_KEY_ID":"x"}' } }, 'may not set AWS_ACCESS_KEY_ID'],
      [{ objects: { 'events/delivery-1/event.json': undefined } }, 'NoSuchKey'],
      [{ objects: { 'config/../escape.yaml': 'x' } }, 'unusable path'],
      [{ objects: { 'config/github-app.pem': 'x' } }, 'reserved by the runner'],
    ];
    for (const [overrides, message] of cases) {
      const { deps, calls } = fakeDeps('success', overrides);
      const result = await runJob(request(), deps);
      expect(result.outcome, message).toBe('runner_error');
      expect(result.error, message).toContain(message);
      expect(fs.existsSync(recordFile), message).toBe(false);
      expect(names(calls).slice(-2), message).toEqual(['s3Put', 'terminate']);
      // No secret value in the report.
      expect(JSON.stringify(result)).not.toContain('ghp_not_a_key');
    }
  });

  it('says so when there is no config.yaml under the prefix', async () => {
    const { deps } = fakeDeps('success');
    deps.s3List = async () => [{ key: 'config/prompts/implement-issue.md', size: 1 }];
    const result = await runJob(request(), deps);
    expect(result.outcome).toBe('runner_error');
    expect(result.error).toBe('no config.yaml at s3://job-bucket/config/config.yaml');
  });

  it('reports a runner error when updraft cannot be started', async () => {
    const { deps, calls } = fakeDeps('success', { deps: { updraftCommand: [path.join(root, 'no-such-updraft')] } });
    const result = await runJob(request(), deps);
    expect(result.outcome).toBe('runner_error');
    expect(result.error).toContain('cannot start');
    expect(names(calls).slice(-2)).toEqual(['s3Put', 'terminate']);
  });

  it('retries the report and the termination, and terminates even if the report is lost', async () => {
    const flaky = fakeDeps('success');
    let puts = 0;
    let terminations = 0;
    flaky.deps.s3Put = async (bucket, key) => {
      if (!key.endsWith('.json')) return;
      puts += 1;
      if (puts < 3) throw new Error('SlowDown');
    };
    flaky.deps.terminate = async () => {
      terminations += 1;
      if (terminations < 2) throw new Error('ThrottlingException');
    };
    await runJob(request(), flaky.deps);
    expect(puts).toBe(3);
    expect(terminations).toBe(2);

    const lost = fakeDeps('success');
    let terminated = false;
    lost.deps.s3Put = async () => {
      throw new Error('AccessDenied');
    };
    lost.deps.terminate = async () => {
      terminated = true;
    };
    const result = await runJob(request(), lost.deps);
    expect(result.outcome).toBe('succeeded');
    expect(terminated).toBe(true);
    // The outcome is in the log even though the upload failed.
    expect(lost.logs.join('\n')).toContain('RESULT {');
    expect(lost.logs.join('\n')).toContain('could not write the result to S3');
  });
});

describe.runIf(onLinuxLikeHost)('runJob: logs and deduplication record', () => {
  it('reads a log only when it really lies inside the state directory', async () => {
    const outside = path.join(root, 'outside.log');
    fs.writeFileSync(outside, 'not for upload');
    for (const mode of ['log-outside', 'log-symlink']) {
      const { deps, calls, logs } = fakeDeps(mode, { secrets: { [ENV_ARN]: JSON.stringify({ FAKE_UPDRAFT_MODE: mode, FAKE_OUTSIDE_FILE: outside }) } });
      const result = await runJob(request(), deps);
      expect(result.outcome, mode).toBe('succeeded');
      expect(result.logs, mode).toEqual(['results/delivery-1/mvm-01234567-abcd-ef01-2345-6789abcdef01/updraft.log']);
      expect(calls.some(([name, , , body]) => name === 's3Put' && String(body).includes('not for upload')), mode).toBe(false);
      expect(logs.join('\n'), mode).toContain('could not upload run.log: it is outside the state directory');
    }
  });

  it('redacts the job\'s keys from the log stream, the uploaded logs and the result (#70)', async () => {
    const { deps, calls, logs, output } = fakeDeps('leak', {
      secrets: { [ENV_ARN]: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-test-value', CUSTOM_TOKEN: 'plainsecretvalue123', FAKE_UPDRAFT_MODE: 'leak', FAKE_UPDRAFT_RECORD: recordFile }) },
    });
    const result = await runJob(request(), deps);
    const kept = [
      output.join(''),
      logs.join('\n'),
      ...calls.filter(([name]) => name === 's3Put').map(([, , , body]) => String(body)),
      JSON.stringify(result),
    ];
    for (const text of kept) {
      expect(text).not.toContain('sk-ant-test-value');
      expect(text).not.toContain('plainsecretvalue123');
    }
    expect(output.join('')).toContain('provider said: invalid x-api-key [redacted]');
    expect(result.stderrTail).toContain('error with [redacted] and [redacted]');
    expect(result.summary.message).toBe('rejected [redacted]');
    const uploads = calls.filter(([name, , key]) => name === 's3Put' && /\.log$/.test(key)).map(([, , , body]) => String(body));
    expect(uploads).toEqual(['updraft.log contents\nkey [redacted]\n', 'agent transcript\ntoken [redacted]\n']);
  });

  it('uploads only the end of a very large log', async () => {
    const { deps, calls } = fakeDeps('success', { deps: { maxLogBytes: 8 } });
    await runJob(request(), deps);
    const upload = calls.find(([name, , key]) => name === 's3Put' && key.endsWith('/run.log'));
    expect(String(upload[3])).toBe('nscript\n');
  });

  it('keeps the deduplication record after a clean run and removes it otherwise', async () => {
    const clean = fakeDeps('success');
    await runJob(request({ dedupeTable: 'deliveries' }), clean.deps);
    expect(names(clean.calls)).not.toContain('releaseDelivery');

    for (const mode of ['fail', 'no-summary']) {
      const { deps, calls } = fakeDeps(mode);
      await runJob(request({ dedupeTable: 'deliveries' }), deps);
      expect(calls.filter(([name]) => name === 'releaseDelivery'), mode).toEqual([['releaseDelivery', 'deliveries', 'delivery-1']]);
      expect(names(calls).at(-1), mode).toBe('terminate');
    }

    const broken = fakeDeps('success', { secrets: { [KEY_ARN]: '' } });
    await runJob(request({ dedupeTable: 'deliveries' }), broken.deps);
    expect(names(broken.calls)).toContain('releaseDelivery');

    // Without a table in the payload (deduplication off) nothing is released.
    const off = fakeDeps('fail');
    await runJob(request(), off.deps);
    expect(names(off.calls)).not.toContain('releaseDelivery');
  });
});

/** A version 2 (Updraft Cloud) job as startBrokerJob hands it to runJob: the descriptor filled in. */
function brokerRequest(overrides = {}) {
  const { payload, microvmId } = request();
  const rest = { ...payload };
  delete rest.secrets;
  return {
    microvmId,
    payload: {
      ...rest,
      version: 2,
      broker: { functionName: 'broker', jobId: 'job_abc12345', jobToken: 'x'.repeat(43) },
      agentKeySecrets: {
        ANTHROPIC_API_KEY: 'updraft/tenants/55/agent-keys/ANTHROPIC_API_KEY',
        OPENAI_API_KEY: 'updraft/tenants/55/agent-keys/OPENAI_API_KEY',
        FAKE_UPDRAFT_MODE: 'updraft/tenants/55/agent-keys/FAKE_UPDRAFT_MODE',
        FAKE_UPDRAFT_RECORD: 'updraft/tenants/55/agent-keys/FAKE_UPDRAFT_RECORD',
      },
      ...overrides,
    },
  };
}

const tokenFile = (n) => ({
  app: { id: 1, slug: 'updraft-cloud' },
  installationId: 55,
  token: `ghs_job_token_${n}`,
  expiresAt: new Date(START + 3_600_000).toISOString(),
  permissions: { contents: 'write' },
  repositories: ['o/r'],
  bot: { id: 777, login: 'updraft-cloud[bot]' },
});

function brokerDeps(mode, overrides = {}) {
  const harness = fakeDeps(mode, {
    ...overrides,
    secrets: {
      // The tenant set no OpenAI key: that secret does not exist.
      'updraft/tenants/55/agent-keys/ANTHROPIC_API_KEY': 'sk-ant-tenant',
      'updraft/tenants/55/agent-keys/FAKE_UPDRAFT_MODE': mode,
      'updraft/tenants/55/agent-keys/FAKE_UPDRAFT_RECORD': recordFile,
      ...overrides.secrets,
    },
  });
  let issued = 0;
  harness.deps.githubToken = async () => {
    harness.calls.push(['githubToken']);
    issued += 1;
    return tokenFile(issued);
  };
  harness.deps.finishJob = async (outcome, detail) => {
    harness.calls.push(['finishJob', outcome]);
    harness.finishDetails = [...(harness.finishDetails ?? []), detail];
  };
  return harness;
}

describe.runIf(onLinuxLikeHost)('runJob, version 2 (job broker)', () => {
  it('gives the job an installation token instead of the key, the tenant\'s keys as its environment, and finishes the job', async () => {
    const harness = brokerDeps('success');
    const { deps, calls } = harness;
    const result = await runJob(brokerRequest(), deps);
    expect(result.outcome).toBe('succeeded');
    // What the console shows of the job (#71): the pull request and the logs, as names.
    expect(harness.finishDetails).toEqual([{ updraftOutcome: 'succeeded', prUrl: 'https://github.com/o/r/pull/7', logs: ['updraft.log', 'run.log'] }]);

    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(record.keyMode).toBeNull();
    expect(record.token).toEqual(tokenFile(1));
    expect(record.tokenMode).toBe(0o600);
    expect(record.env.ANTHROPIC_API_KEY).toBe('sk-ant-tenant');
    expect(record.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(JSON.stringify(record.env)).not.toContain('ghs_job_token');

    // No key secret is read at all; the job is finished with the broker before the microVM goes.
    expect(calls.filter(([name, id]) => name === 'getSecret' && !id.startsWith('updraft/tenants/55/'))).toEqual([]);
    expect(names(calls).slice(-3)).toEqual(['s3Put', 'finishJob', 'terminate']);
    expect(calls.find(([name]) => name === 'finishJob')).toEqual(['finishJob', 'succeeded']);
  });

  it('replaces the token file while the job runs', async () => {
    const { deps, calls } = brokerDeps('slow-state', {
      deps: { tokenRefreshMs: 40 },
      secrets: { 'updraft/tenants/55/agent-keys/FAKE_UPDRAFT_SLOW_ROWS': '["a","b","c"]' },
    });
    const req = brokerRequest();
    req.payload.agentKeySecrets.FAKE_UPDRAFT_SLOW_ROWS = 'updraft/tenants/55/agent-keys/FAKE_UPDRAFT_SLOW_ROWS';
    const result = await runJob(req, deps);
    expect(result.outcome).toBe('succeeded');
    expect(calls.filter(([name]) => name === 'githubToken').length).toBeGreaterThan(2);
  });

  it('reports a runner error, without starting updraft, when the broker gives no token', async () => {
    const { deps, calls } = brokerDeps('success');
    deps.githubToken = async () => ({ token: 42 });
    const result = await runJob(brokerRequest(), deps);
    expect(result.outcome).toBe('runner_error');
    expect(result.error).toMatch(/no usable GitHub token/);
    expect(fs.existsSync(recordFile)).toBe(false);
    expect(names(calls).slice(-2)).toEqual(['finishJob', 'terminate']);
  });

  it('reports a success without a summary as unconfirmed, so the broker lets a redelivery run it again', async () => {
    const { deps, calls } = brokerDeps('no-summary');
    const result = await runJob(brokerRequest(), deps);
    expect(result).toMatchObject({ outcome: 'succeeded', summaryMissing: true });
    expect(calls.find(([name]) => name === 'finishJob')).toEqual(['finishJob', 'unconfirmed']);
  });

  it('still terminates when the broker cannot be told the job is over', async () => {
    const { deps, calls, logs } = brokerDeps('success');
    deps.finishJob = async () => {
      calls.push(['finishJob']);
      throw new Error('the job broker refused finish (refused)');
    };
    const result = await runJob(brokerRequest(), deps);
    expect(result.outcome).toBe('succeeded');
    expect(calls.at(-1)[0]).toBe('terminate');
    expect(logs.join('\n')).toMatch(/refused finish/);
  });
});

describe('deadlineMinutes', () => {
  it('leaves the margin between run-event\'s deadline and the watchdog', () => {
    expect(deadlineMinutes(6_900_000)).toBe(112);
    expect(deadlineMinutes(6_899_000)).toBe(111);
    expect(deadlineMinutes(4 * 60_000)).toBe(1);
    expect(deadlineMinutes(4 * 60_000 - 1)).toBe(0);
    expect(deadlineMinutes(0)).toBe(0);
  });
});

describe('describeExitCode', () => {
  it('explains run-event\'s exit codes', () => {
    expect(describeExitCode(0)).toBeNull();
    expect(describeExitCode(1)).toContain('see summary.outcome');
    expect(describeExitCode(2)).toContain('event file');
    expect(describeExitCode(3)).toContain('worker lock');
    expect(describeExitCode(4)).toContain('cooldown');
    expect(describeExitCode(5)).toContain('newer Updraft');
    expect(describeExitCode(6)).toContain('does not know it yet');
    expect(describeExitCode(64)).toBe('updraft exited with code 64');
  });
});

describe('updraftInvocation', () => {
  it('is the run-event contract', () => {
    expect(updraftInvocation({ eventFile: '/s/event.json', eventName: 'issues', deliveryId: 'd', deadlineMinutes: 42 }).slice(0, 8)).toEqual([
      'run-event', '--event-file', '/s/event.json', '--event-name', 'issues', '--delivery-id', 'd', '--json',
    ]);
    expect(updraftInvocation({ eventFile: '/s/event.json', eventName: 'issues', deliveryId: 'd', deadlineMinutes: 42 }).slice(-2)).toEqual(['--deadline-minutes', '42']);
  });
});

describe('watchdogBudgetMs', () => {
  const payload = request().payload;
  it('counts from the launch and keeps the reserve', () => {
    expect(watchdogBudgetMs(payload, START)).toBe(6_900_000);
    expect(watchdogBudgetMs(payload, START + 60_000)).toBe(6_840_000);
    expect(watchdogBudgetMs(payload, START + 8_000_000)).toBe(0);
    // A clock behind the launcher's never extends the budget.
    expect(watchdogBudgetMs(payload, START - 60_000)).toBe(6_900_000);
  });
});

describe('parseAgentEnv', () => {
  it('takes a bare string as ANTHROPIC_API_KEY', () => {
    expect(parseAgentEnv(' sk-ant-abc \n')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-abc' });
  });

  it('takes a JSON object as environment variables', () => {
    expect(parseAgentEnv('{"ANTHROPIC_API_KEY":"a","CODEX_API_KEY":"b"}')).toEqual({ ANTHROPIC_API_KEY: 'a', CODEX_API_KEY: 'b' });
  });

  it('refuses names that would change the job process or carry credentials', () => {
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_REGION', 'PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'UPDRAFT_HOME', 'UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT']) {
      expect(() => parseAgentEnv(JSON.stringify({ [name]: 'x' })), name).toThrow(`may not set ${name}`);
    }
    expect(() => parseAgentEnv('{"bad name":"x"}')).toThrow('not a variable name');
    expect(() => parseAgentEnv('{"KEY":1}')).toThrow('not a string');
    expect(() => parseAgentEnv('{"KEY":')).toThrow('not JSON');
    expect(() => parseAgentEnv('')).toThrow('empty');
  });

  it('does not echo values in its errors', () => {
    try {
      parseAgentEnv('{"KEY": "sk-secret-value", "PATH": "sk-other-value"}');
      expect.unreachable();
    } catch (error) {
      expect(error.message).not.toContain('sk-');
    }
  });
});

describe('configRelativePath', () => {
  it('maps objects under the prefix to relative paths', () => {
    expect(configRelativePath('config/config.yaml', 'config/')).toBe('config.yaml');
    expect(configRelativePath('config/prompts/implement-issue.md', 'config/')).toBe(path.join('prompts', 'implement-issue.md'));
    expect(configRelativePath('config/', 'config/')).toBeUndefined();
    expect(configRelativePath('config/prompts/', 'config/')).toBeUndefined();
  });

  it('refuses paths that leave the state directory or collide with runner files', () => {
    for (const key of ['config/../x', 'config/a/../../x', 'config//x', 'config/./x', 'config/a\\b', 'config/github-app.pem', 'config/event.json', 'other/config.yaml']) {
      expect(() => configRelativePath(key, 'config/'), key).toThrow();
    }
    // Only the top-level names are reserved.
    expect(configRelativePath('config/prompts/event.json', 'config/')).toBe(path.join('prompts', 'event.json'));
  });
});

describe('finishDetail (#71)', () => {
  it('reports a failed verification from whichever job failed it, and run-event\'s own outcome', async () => {
    const { finishDetail } = await import('../image/runner/job.mjs');
    const revisionFailed = {
      updraftOutcome: 'failed',
      summary: { verification: { passed: true, commands: [] }, followOnJobs: [{ kind: 'revision', verification: { passed: false, commands: [] } }] },
      logs: ['results/d/m/updraft.log'],
    };
    expect(finishDetail(revisionFailed)).toEqual({
      updraftOutcome: 'failed',
      verificationPassed: false,
      logs: ['updraft.log'],
      steps: [{ kind: 'revision', verificationPassed: false }],
    });
    expect(finishDetail({ updraftOutcome: 'canceled', summary: {}, logs: [] })).toEqual({ updraftOutcome: 'canceled' });
    expect(finishDetail({ updraftOutcome: 'succeeded', summary: { verification: { passed: true }, jobs: [{ verification: { passed: true } }] }, logs: [] })).toEqual({ updraftOutcome: 'succeeded', verificationPassed: true });
  });

  it('reports the lifecycle: where the review loop ended and each step in order', async () => {
    const { finishDetail } = await import('../image/runner/job.mjs');
    const summary = {
      event: { name: 'issues' },
      jobId: 'job_1',
      agent: 'claude',
      outcome: 'succeeded',
      runOutcome: 'succeeded',
      verification: { passed: true },
      publication: 'published',
      prUrl: 'https://github.com/o/r/pull/7',
      loop: { pullRequest: 7, rounds: 1, maxRevisions: 3, reviews: 2, verdict: 'ready-to-merge', stage: 'merged', merged: true, detail: 'text not kept' },
      followOnJobs: [
        { kind: 'review', agent: 'codex', outcome: 'succeeded', publication: 'published' },
        { kind: 'revision', agent: 'claude', outcome: 'succeeded', verification: { passed: true }, publication: 'published' },
        { kind: 'review', agent: 'codex', outcome: 'succeeded', publication: 'published' },
        { kind: 'other', agent: 'x' },
      ],
    };
    const detail = finishDetail({ updraftOutcome: 'succeeded', summary, logs: [] });
    expect(detail.loop).toEqual({ rounds: 1, maxRevisions: 3, reviews: 2, verdict: 'ready-to-merge', stage: 'merged', merged: true });
    expect(detail.steps.map((s) => [s.kind, s.agent])).toEqual([['implement', 'claude'], ['review', 'codex'], ['revision', 'claude'], ['review', 'codex']]);
    expect(detail.steps[0]).toMatchObject({ outcome: 'succeeded', verificationPassed: true, publication: 'published' });
  });
});
