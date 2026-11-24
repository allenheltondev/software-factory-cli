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
    getSecret: async (id, version) => {
      calls.push(['getSecret', id, ...(version ? [version] : [])]);
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

describe.runIf(onLinuxLikeHost)('runJob, version 2: agent telemetry', () => {
  const telemetry = { region: 'us', secret: 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY', serviceName: 'updraft', captureContent: true };

  it('tails the run log while the job runs and sends GenAI spans, with the key redacted and never in the job environment', async () => {
    const harness = brokerDeps('telemetry', { secrets: { 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY': 'hcaik_01honeycombsecretvalue' } });
    const posts = [];
    harness.deps.fetch = async (url, init) => {
      posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    harness.deps.telemetryPollMs = 50;
    const result = await runJob(brokerRequest({ telemetry }), harness.deps);
    expect(result.outcome).toBe('succeeded');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0].url).toBe('https://api.honeycomb.io/v1/traces');
    expect(posts[0].headers['x-honeycomb-team']).toBe('hcaik_01honeycombsecretvalue');
    const spans = posts.flatMap((p) => p.body.resourceSpans[0].scopeSpans[0].spans);
    expect(spans.map((s) => s.name).filter((n) => !n.startsWith('runner ') && !n.startsWith('updraft ')).sort()).toEqual(['chat claude-x', 'execute_tool Bash', 'invoke_agent claude', 'invoke_workflow updraft']);
    // The runner's own steps, under the job's span, which starts with the job (before the tracer did).
    const root = spans.find((s) => s.name === 'invoke_workflow updraft');
    const runnerSteps = spans.filter((s) => s.name.startsWith('runner '));
    expect(runnerSteps.map((s) => s.name)).toEqual(expect.arrayContaining(['runner isolation', 'runner restore_state', 'runner verify_isolation', 'runner run_event']));
    for (const s of runnerSteps) expect(s.parentSpanId).toBe(root.spanId);
    expect(BigInt(root.startTimeUnixNano)).toBeLessThanOrEqual(BigInt(runnerSteps.find((s) => s.name === 'runner isolation').startTimeUnixNano));
    expect(runnerSteps.find((s) => s.name === 'runner run_event').attributes).toContainEqual({ key: 'updraft.run_event.exit_code', value: { intValue: '0' } });
    const resource = posts[0].body.resourceSpans[0].resource.attributes;
    expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'updraft' } });
    const bodies = JSON.stringify(posts.map((p) => p.body));
    expect(bodies).toContain('"gen_ai.conversation.id"');
    expect(bodies).toContain('echo [redacted]');
    expect(bodies).not.toContain('sk-ant-tenant');
    expect(bodies).not.toContain('hcaik_01honeycombsecretvalue');
    // The finish reports the trace, for the console's link to it.
    expect(harness.finishDetails[0].telemetry).toMatchObject({ traceId: expect.stringMatching(/^[0-9a-f]{32}$/), spans: spans.length, exported: spans.length, failed: 0 });
    // And the spans worth a link: here, the agent's, a span that was sent.
    const agentMark = harness.finishDetails[0].telemetry.marks.find((m) => m.kind === 'agent');
    expect(agentMark.spanId).toBe(spans.find((s) => s.name === 'invoke_agent claude').spanId);
    // The job process never had the telemetry key; it has the trace id, to record with its runs.
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(JSON.stringify(record)).not.toContain('hcaik_01honeycombsecretvalue');
    expect(JSON.stringify(record)).toContain(harness.finishDetails[0].telemetry.traceId);
  });

  it('traces a job that failed before any agent ran: its runner steps, the failed one marked', async () => {
    const harness = brokerDeps('telemetry', { objects: { 'events/delivery-1/event.json': undefined }, secrets: { 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY': 'hcaik_01honeycombsecretvalue' } });
    const posts = [];
    harness.deps.fetch = async (url, init) => {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    };
    const result = await runJob(brokerRequest({ telemetry }), harness.deps);
    expect(result.outcome).toBe('runner_error');
    const spans = posts.flatMap((p) => p.resourceSpans[0].scopeSpans[0].spans);
    const root = spans.find((s) => s.name === 'invoke_workflow updraft');
    expect(root.status.code).toBe(2);
    expect(root.attributes).toContainEqual({ key: 'gen_ai.conversation.id', value: { stringValue: expect.stringMatching(/^delivery\//) } });
    const restore = spans.find((s) => s.name === 'runner restore_state');
    expect(restore).toMatchObject({ parentSpanId: root.spanId, status: { code: 2, message: expect.stringContaining('NoSuchKey') } });
    expect(spans.map((s) => s.name)).toContain('runner isolation');
    expect(JSON.stringify(posts)).not.toContain('hcaik_01honeycombsecretvalue');
  });

  it("points the agents at the runner's loopback relay, and puts Claude Code's own events on the agent span", async () => {
    const harness = brokerDeps('telemetry-relay', { secrets: { 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY': 'hcaik_01honeycombsecretvalue' } });
    const posts = [];
    harness.deps.fetch = async (url, init) => {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    };
    harness.deps.telemetryPollMs = 50;
    expect((await runJob(brokerRequest({ telemetry }), harness.deps)).outcome).toBe('succeeded');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(record.env).toMatchObject({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_ENDPOINT: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
    expect(record.env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(record.env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    expect(record.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('hcaik_01honeycombsecretvalue');
    const spans = posts.flatMap((p) => p.resourceSpans[0].scopeSpans[0].spans);
    const agent = spans.find((s) => s.name === 'invoke_agent claude');
    expect(agent.events.map((e) => e.name)).toEqual(['claude_code.api_error', 'claude_code.api_request']);
    const attrs = Object.fromEntries(agent.attributes.map((a) => [a.key, a.value]));
    expect(attrs['updraft.agent.api_requests']).toEqual({ intValue: '1' });
    expect(attrs['updraft.agent.api_errors']).toEqual({ intValue: '1' });
    expect(attrs['updraft.agent.api_retries']).toEqual({ intValue: '1' });
    expect(attrs['updraft.agent.api_duration_ms_max']).toEqual({ intValue: '900' });
  });

  it('gives the job no telemetry variables when telemetry is off', async () => {
    const harness = brokerDeps('telemetry-relay');
    await runJob(brokerRequest(), harness.deps);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(Object.keys(record.env).filter((k) => k.startsWith('OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY')).toEqual([]);
  });

  it('sends to a custom OTLP endpoint with the key in its header, redacted, and never follows a redirect', async () => {
    const secret = 'Bearer otlp-secret-token-value-123';
    const harness = brokerDeps('telemetry', { secrets: { 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY': secret } });
    const posts = [];
    harness.deps.fetch = async (url, init) => {
      posts.push({ url, init });
      return { ok: true, status: 200 };
    };
    const resolved = [];
    harness.deps.resolvesPublic = async (host) => {
      resolved.push(host);
      return true;
    };
    const otlp = { ...telemetry, provider: 'otlp', endpoint: 'https://otlp.example.com/otlp', header: 'authorization' };
    expect((await runJob(brokerRequest({ telemetry: otlp }), harness.deps)).outcome).toBe('succeeded');
    expect(resolved).toEqual(['otlp.example.com']);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0].url).toBe('https://otlp.example.com/otlp/v1/traces');
    expect(posts[0].init.headers).toMatchObject({ authorization: secret });
    expect(posts[0].init.headers).not.toHaveProperty('x-honeycomb-team');
    expect(posts[0].init.redirect).toBe('manual');
    // Neither the whole value nor its token is in what was sent or logged.
    const out = JSON.stringify(posts.map((p) => p.init.body)) + JSON.stringify(harness.finishDetails);
    expect(out).not.toContain('otlp-secret-token-value-123');
    expect(harness.finishDetails[0].telemetry).toMatchObject({ exported: expect.any(Number) });
    expect(harness.finishDetails[0].telemetry.local).toBeUndefined();
  });

  it("sends to CloudWatch's X-Ray endpoint with the key as a bearer token", async () => {
    const harness = brokerDeps('telemetry', { secrets: { 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY': 'Bearer AbCdEfGhIjKlMnOpQrStUv0123' } });
    const posts = [];
    harness.deps.fetch = async (url, init) => {
      posts.push({ url, init });
      return { ok: true, status: 200 };
    };
    harness.deps.resolvesPublic = async () => true;
    const cloudwatch = { ...telemetry, provider: 'cloudwatch', endpoint: 'https://xray.us-west-2.amazonaws.com', header: 'authorization' };
    expect((await runJob(brokerRequest({ telemetry: cloudwatch }), harness.deps)).outcome).toBe('succeeded');
    expect(posts[0].url).toBe('https://xray.us-west-2.amazonaws.com/v1/traces');
    // Where it sent, for the broker to keep that destination's links with the job.
    expect(harness.finishDetails[0].telemetry.sentTo).toEqual({ provider: 'cloudwatch', host: 'xray.us-west-2.amazonaws.com' });
    expect(posts[0].init.headers).toMatchObject({ authorization: 'Bearer AbCdEfGhIjKlMnOpQrStUv0123' });
    expect(JSON.stringify(posts.map((p) => p.init.body))).not.toContain('AbCdEfGhIjKlMnOpQrStUv0123');
  });

  it('sends nothing to a custom endpoint that resolves to a private address, or that is not one it sends to, and still reads the job', async () => {
    for (const [endpoint, publicHost] of [
      ['https://otlp.example.com', false],
      ['http://otlp.example.com', true],
      ['https://10.0.0.5', true],
    ]) {
      const harness = brokerDeps('telemetry', { secrets: { 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY': 'Bearer otlp-secret-token-value-123' } });
      harness.deps.fetch = async () => {
        throw new Error('must not be called');
      };
      harness.deps.resolvesPublic = async () => publicHost;
      expect((await runJob(brokerRequest({ telemetry: { ...telemetry, provider: 'otlp', endpoint, header: 'authorization' } }), harness.deps)).outcome).toBe('succeeded');
      expect(harness.finishDetails[0].telemetry, endpoint).toMatchObject({ local: true });
    }
  });

  it('reads exactly the secret version the settings name', async () => {
    const harness = brokerDeps('telemetry', { secrets: { 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY': 'hcaik_01honeycombsecretvalue' } });
    harness.deps.fetch = async () => ({ ok: true, status: 200 });
    await runJob(brokerRequest({ telemetry: { ...telemetry, secretVersion: 'a1b2c3d4-0000-4000-8000-000000000001' } }), harness.deps);
    expect(harness.calls).toContainEqual(['getSecret', 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY', 'a1b2c3d4-0000-4000-8000-000000000001']);
  });

  it('runs the job without telemetry when the key is not set, and does not fail it when Honeycomb is down', async () => {
    const noKey = brokerDeps('telemetry');
    noKey.deps.fetch = async () => {
      throw new Error('must not be called');
    };
    expect((await runJob(brokerRequest({ telemetry }), noKey.deps)).outcome).toBe('succeeded');
    // Nothing sent, but the console still gets its own view of the job: marks and totals, marked local.
    expect(noKey.finishDetails[0].telemetry).toMatchObject({ local: true, exported: 0, totals: { runs: 1, toolCalls: expect.any(Number) } });
    // And the job has no trace id to record: there is no trace anywhere to link to.
    const env = fs.readFileSync(recordFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).env ?? {});
    expect(env.some((e) => 'UPDRAFT_TRACE_ID' in e)).toBe(false);

    const down = brokerDeps('telemetry', { secrets: { 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY': 'hcaik_01honeycombsecretvalue' } });
    down.deps.fetch = async () => ({ ok: false, status: 401 });
    down.deps.telemetryBudgetMs = 2000;
    const result = await runJob(brokerRequest({ telemetry }), down.deps);
    expect(result.outcome).toBe('succeeded');
    expect(down.finishDetails[0].telemetry).toMatchObject({ exported: 0, lastError: 'HTTP 401' });
  });
});

describe.runIf(onLinuxLikeHost)('runJob, version 2 (job broker)', () => {
  it('gives the job an installation token instead of the key, the tenant\'s keys as its environment, and finishes the job', async () => {
    const harness = brokerDeps('success');
    const { deps, calls } = harness;
    const result = await runJob(brokerRequest(), deps);
    expect(result.outcome).toBe('succeeded');
    // What the console shows of the job (#71): the pull request and the logs, as names.
    expect(harness.finishDetails).toEqual([{ updraftOutcome: 'succeeded', prUrl: 'https://github.com/o/r/pull/7', logs: ['updraft.log', 'run.log'], telemetry: expect.objectContaining({ local: true }) }]);

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
    expect(updraftInvocation({ eventFile: '/s/event.json', eventName: 'issues', deliveryId: 'd', deadlineMinutes: 42 })).not.toContain('--retry');
  });

  it('adds --retry for a retry from the console, and only then', () => {
    const args = updraftInvocation({ eventFile: '/s/event.json', eventName: 'issues', deliveryId: 'd', deadlineMinutes: 42, retry: true });
    expect(args.slice(-3)).toEqual(['--deadline-minutes', '42', '--retry']);
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
  it('matches model and usage to each step by run ID', async () => {
    const { finishDetail } = await import('../image/runner/job.mjs');
    const detail = finishDetail({
      summary: {
        event: { name: 'issues' }, jobId: 'job_build', runId: 'run_build', agent: 'builder',
        followOnJobs: [{ kind: 'review', runId: 'run_review', agent: 'reviewer' }],
      },
      telemetry: { runs: [
        { runId: 'run_review', adapter: 'codex', model: 'review-model', modelSource: 'configured', usage: { inputTokens: 5 } },
        { runId: 'run_build', adapter: 'claude', model: 'response-model', modelSource: 'response', usage: { inputTokens: 12 } },
      ] },
    });
    expect(detail.steps).toMatchObject([
      { kind: 'implement', model: 'response-model', modelSource: 'response', usage: { inputTokens: 12 } },
      { kind: 'review', model: 'review-model', modelSource: 'configured', usage: { inputTokens: 5 } },
    ]);
  });

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
    expect(finishDetail({ updraftOutcome: 'canceled', summary: {}, logs: [] })).toEqual({ updraftOutcome: 'canceled', adapters: [] });
    expect(finishDetail({ updraftOutcome: 'nothing-to-do', summary: {}, logs: [], telemetry: { traceId: 't', spans: 0, exported: 0, failed: 0 } })).toMatchObject({ adapters: [] });
    expect(finishDetail({ summary: {}, logs: [], telemetry: { traceId: 't', spans: 1, exported: 1, failed: 0, adapters: ['codex'] } })).toMatchObject({ adapters: ['codex'] });
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
