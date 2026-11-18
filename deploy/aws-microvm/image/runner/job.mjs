// One job: prepare a fresh state directory, run `updraft run-event` as the unprivileged job
// user, report the outcome to S3, terminate the microVM. Everything that talks to AWS or the
// operating system's process table comes in through `deps`, so this file is tested with
// stand-ins (see ../../test/runner-job.test.mjs).
import { spawn as nodeSpawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** File names the runner writes into the state directory. Config objects may not use them. */
const KEY_FILE = 'github-app.pem';
const EVENT_FILE = 'event.json';
const CONFIG_FILE = 'config.yaml';

const MAX_CONFIG_FILES = 200;
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const MAX_LOG_BYTES = 20 * 1024 * 1024;

// Names an agent-environment secret may not set: they would change how the job process itself
// runs, or hand it credentials this design keeps away from it.
const FORBIDDEN_ENV = /^(AWS_|UPDRAFT_|NODE_|LD_|GIT_CONFIG|GH_TOKEN$|GITHUB_TOKEN$|PATH$|HOME$|USER$|LOGNAME$|SHELL$|IFS$)/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * THE ONE PLACE that knows how Updraft is invoked for a webhook event (docs/run-event.md in
 * the Updraft repository):
 *
 *   updraft run-event --event-file <path> [--event-name issues] [--delivery-id <id>] [--json]
 *                     [--deadline-minutes <n>] [--worker-git-credentials]
 *
 * It reads the normal config ($UPDRAFT_HOME/config.yaml), creates the clone when
 * checkoutPath does not exist, and with --json prints one JSON object as its last stdout
 * line, on errors too. --deadline-minutes makes it stop everything (a running agent
 * included) and still print that summary. --worker-git-credentials is not needed here.
 */
export function updraftInvocation({ eventFile, eventName, deliveryId, deadlineMinutes }) {
  return [
    'run-event',
    '--event-file', eventFile,
    '--event-name', eventName,
    '--delivery-id', deliveryId,
    '--json',
    '--deadline-minutes', String(deadlineMinutes),
  ];
}

/** What run-event's exit codes mean, for the result document. */
export function describeExitCode(code) {
  switch (code) {
    case 0:
      return null;
    case 1:
      return 'updraft exited 1: the job failed, could not start, was interrupted or was not published, or the command itself failed (config, GitHub, event not matched); see summary.outcome and summary.message';
    case 2:
      return 'updraft exited 2: the event file is missing or not JSON, or --deadline-minutes was rejected';
    case 3:
      return "updraft exited 3: the state directory's worker lock is held";
    default:
      return `updraft exited with code ${code}`;
  }
}

/**
 * Minutes to give run-event as its own deadline: the watchdog's budget minus a margin, so
 * that run-event stops the agent itself and prints its summary before the watchdog would
 * have to kill it. 0 means there is not enough time to start.
 */
export const DEADLINE_MARGIN_MS = 3 * 60 * 1000;
export function deadlineMinutes(budgetMs) {
  return Math.max(0, Math.floor((budgetMs - DEADLINE_MARGIN_MS) / 60000));
}

/**
 * The agent-environment secret is either a JSON object of environment variables
 * (`{"ANTHROPIC_API_KEY": "...", "CODEX_API_KEY": "..."}`) or a bare string, which is taken
 * as ANTHROPIC_API_KEY. Throws without echoing any value.
 */
export function parseAgentEnv(secretString) {
  const text = (secretString ?? '').trim();
  if (text === '') throw new Error('the agent environment secret is empty');
  if (!text.startsWith('{')) return { ANTHROPIC_API_KEY: text };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the agent environment secret starts with "{" but is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the agent environment secret is not a JSON object');
  }
  const env = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!ENV_NAME.test(name)) throw new Error('the agent environment secret has a key that is not a variable name');
    if (FORBIDDEN_ENV.test(name)) throw new Error(`the agent environment secret may not set ${name}`);
    if (typeof value !== 'string') throw new Error(`the agent environment secret's ${name} is not a string`);
    env[name] = value;
  }
  return env;
}

/**
 * The relative path a config object is written to, or undefined for keys to skip ("folder"
 * placeholders). Throws for keys that would land outside the state directory or on a file
 * the runner writes itself.
 */
export function configRelativePath(key, prefix) {
  if (!key.startsWith(prefix)) throw new Error(`config object ${JSON.stringify(key)} is outside ${prefix}`);
  const relative = key.slice(prefix.length);
  if (relative === '' || relative.endsWith('/')) return undefined;
  const segments = relative.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\\\0]/.test(segment)) {
      throw new Error(`config object ${JSON.stringify(key)} has an unusable path`);
    }
  }
  if (segments.length === 1 && (relative === KEY_FILE || relative === EVENT_FILE)) {
    throw new Error(`config object ${JSON.stringify(key)} uses a name reserved by the runner`);
  }
  return segments.join(path.sep);
}

/**
 * How long `updraft run-event` may run: until `watchdogReserveSeconds` before the microVM's
 * maximum duration, counted from the moment the launcher asked for the microVM (which is
 * earlier than the microVM's own start, so the estimate errs on the safe side).
 */
export function watchdogBudgetMs(payload, nowMs) {
  const total = (payload.maximumDurationSeconds - payload.watchdogReserveSeconds) * 1000;
  const elapsed = Math.max(0, nowMs - Date.parse(payload.launchedAt));
  return Math.max(0, total - elapsed);
}

/**
 * @param {{ microvmId: string, payload: object }} request a validated /run request (hooks.mjs)
 * @param {object} deps
 * @param {(bucket: string, key: string) => Promise<Buffer>} deps.s3Get
 * @param {(bucket: string, prefix: string) => Promise<{ key: string, size: number }[]>} deps.s3List
 * @param {(bucket: string, key: string, body: string | Buffer, contentType?: string) => Promise<void>} deps.s3Put
 * @param {(secretId: string) => Promise<string>} deps.getSecret
 * @param {(microvmId: string) => Promise<void>} deps.terminate
 * @param {(table: string, deliveryId: string) => Promise<void>} [deps.releaseDelivery] removes
 *   the launcher's deduplication record, so that a redelivery can retry a run that did not end well
 * @param {number} [deps.deadlineMinutes] overrides the computed --deadline-minutes (tests)
 * @param {string} deps.stateRoot directory under which the per-run state directory is made
 * @param {string[]} deps.updraftCommand the Updraft executable (and leading arguments)
 * @param {{ uid?: number, gid?: number, home: string, name: string }} deps.jobUser
 * @param {Record<string, string | undefined>} deps.baseEnv the runner's environment; only
 *   PATH, LANG, TZ and PLAYWRIGHT_BROWSERS_PATH are copied from it
 * @param {(message: string) => void} deps.log
 * @param {NodeJS.WritableStream} deps.logStream where the job's stdout and stderr are copied
 * @param {(listener: () => void) => void} [deps.onStop] registers a listener for "the microVM
 *   is terminating" (the runner's SIGTERM)
 * @param {() => number} [deps.now]
 * @param {number} [deps.killGraceMs] SIGTERM to SIGKILL
 * @param {number} [deps.retryDelayMs]
 * @param {typeof nodeSpawn} [deps.spawn]
 * @returns {Promise<object>} the result document that was written to S3
 */
export async function runJob(request, deps) {
  const { microvmId, payload } = request;
  const now = deps.now ?? Date.now;
  const log = deps.log;
  const startedAt = now();
  const result = {
    deliveryId: payload.deliveryId,
    eventName: payload.eventName,
    microvmId,
    outcome: 'runner_error',
    exitCode: null,
    signal: null,
    summary: null,
    summaryMissing: true,
    // summary.outcome, copied up: nothing-to-do | succeeded | canceled | superseded | failed |
    // publish-failed | not-started | error
    updraftOutcome: null,
    logs: [],
    error: null,
    stderrTail: '',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationSeconds: null,
  };

  // Registered first, so that a /terminate during preparation is not lost.
  let stopRequested = false;
  let stopChild = () => {};
  deps.onStop?.(() => {
    stopRequested = true;
    stopChild();
  });

  let stateDirForLogs;
  try {
    const stateDir = await prepare(payload, deps);
    if (stopRequested) throw new Error('the microVM was terminated before the job started');
    const budgetMs = watchdogBudgetMs(payload, now());
    const deadline = deps.deadlineMinutes ?? deadlineMinutes(budgetMs);
    if (budgetMs <= 0 || deadline < 1) throw new Error('no time left before the microVM reaches its maximum duration');
    log(`running updraft run-event for delivery ${payload.deliveryId}; its deadline is ${deadline} min, the watchdog fires in ${Math.round(budgetMs / 1000)} s`);

    stateDirForLogs = stateDir;
    const run = await runUpdraft(payload, stateDir, budgetMs, deadline, deps, (stop) => {
      stopChild = stop;
      if (stopRequested) stop();
    });
    result.exitCode = run.exitCode;
    result.signal = run.signal;
    result.stderrTail = run.stderrTail;
    result.summary = run.summary;
    result.summaryMissing = run.summary === null;
    result.updraftOutcome = typeof run.summary?.outcome === 'string' ? run.summary.outcome : null;
    if (run.timedOut) {
      result.outcome = 'timed_out';
      result.error = `stopped by the watchdog after ${Math.round(budgetMs / 1000)} s, before the microVM's maximum duration`;
    } else if (stopRequested) {
      result.outcome = 'terminated';
      result.error = 'the microVM was terminated while the job was running';
    } else if (run.exitCode === 0) {
      result.outcome = 'succeeded';
      if (run.summary === null) result.error = `updraft exited 0 without a JSON summary on its last stdout line${run.summaryProblem}`;
    } else {
      result.outcome = 'failed';
      result.error = run.signal ? `updraft was killed by ${run.signal}` : describeExitCode(run.exitCode);
    }
  } catch (error) {
    result.outcome = stopRequested ? 'terminated' : 'runner_error';
    result.error = error instanceof Error ? error.message : String(error);
    log(`job could not run: ${result.error}`);
  }

  const finishedAt = now();
  result.finishedAt = new Date(finishedAt).toISOString();
  result.durationSeconds = Math.round((finishedAt - startedAt) / 1000);
  const resultKey = `${payload.resultKeyPrefix}${microvmId}.json`;
  // The microVM's disk is gone after termination: keep Updraft's own log and the run log
  // (the agent's transcript) next to the result.
  if (stateDirForLogs) {
    result.logs = await uploadLogs(stateDirForLogs, result.summary, `${payload.resultKeyPrefix}${microvmId}/`, payload.bucket, deps);
  }
  // One line in the log as well, so the outcome survives a failed upload.
  log(`RESULT ${JSON.stringify({ ...result, stderrTail: undefined })}`);
  try {
    await retry(() => deps.s3Put(payload.bucket, resultKey, `${JSON.stringify(result, null, 2)}\n`), deps);
    log(`result written to s3://${payload.bucket}/${resultKey}`);
  } catch (error) {
    log(`could not write the result to S3: ${error?.message ?? error}`);
  }
  // The launcher refuses a redelivery while its record of this delivery exists. Keep the
  // record after a clean exit (a redelivery would find the work done), remove it otherwise:
  // redelivering the webhook is how a failed run is retried.
  if (payload.dedupeTable && deps.releaseDelivery && !(result.outcome === 'succeeded' && !result.summaryMissing)) {
    try {
      await retry(() => deps.releaseDelivery(payload.dedupeTable, payload.deliveryId), deps);
      log('the delivery can be redelivered to retry this run');
    } catch (error) {
      log(`could not remove the deduplication record; a redelivery is refused until it expires: ${error?.message ?? error}`);
    }
  }
  // Whatever happened, do not leave the microVM running (and billed) until its maximum
  // duration. If this fails too, the maximum duration is the backstop.
  try {
    await retry(() => deps.terminate(microvmId), deps);
    log(`asked Lambda to terminate microVM ${microvmId}`);
  } catch (error) {
    log(`could not terminate microVM ${microvmId}: ${error?.message ?? error}`);
  }
  return result;
}

/** Creates the state directory and fills it: event, config tree, App key. Returns its path. */
async function prepare(payload, deps) {
  const { jobUser } = deps;
  await fs.mkdir(deps.stateRoot, { recursive: true });
  // mkdtemp's suffix is generated now, inside this microVM, not at image build.
  const stateDir = await fs.mkdtemp(path.join(deps.stateRoot, 'job-'));
  await fs.chmod(stateDir, 0o700);

  const event = await deps.s3Get(payload.bucket, payload.eventKey);
  await fs.writeFile(path.join(stateDir, EVENT_FILE), event, { mode: 0o600 });

  const objects = await deps.s3List(payload.bucket, payload.configPrefix);
  if (objects.length > MAX_CONFIG_FILES) throw new Error(`more than ${MAX_CONFIG_FILES} objects under s3://${payload.bucket}/${payload.configPrefix}`);
  let total = 0;
  let sawConfig = false;
  for (const object of objects) {
    const relative = configRelativePath(object.key, payload.configPrefix);
    if (relative === undefined) continue;
    total += object.size ?? 0;
    if (total > MAX_CONFIG_BYTES) throw new Error(`the config under s3://${payload.bucket}/${payload.configPrefix} is larger than ${MAX_CONFIG_BYTES} bytes`);
    const target = path.join(stateDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await deps.s3Get(payload.bucket, object.key), { mode: 0o600 });
    if (relative === CONFIG_FILE) sawConfig = true;
  }
  if (!sawConfig) throw new Error(`no ${CONFIG_FILE} at s3://${payload.bucket}/${payload.configPrefix}${CONFIG_FILE}`);

  const privateKey = await deps.getSecret(payload.secrets.githubAppPrivateKey);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey ?? '')) {
    throw new Error('the GitHub App private key secret is empty or not a PEM private key');
  }
  await fs.writeFile(path.join(stateDir, KEY_FILE), privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });

  if (jobUser.uid !== undefined && jobUser.gid !== undefined) await chownTree(stateDir, jobUser.uid, jobUser.gid);
  return stateDir;
}

async function chownTree(target, uid, gid) {
  await fs.lchown(target, uid, gid);
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(target)) await chownTree(path.join(target, entry), uid, gid);
}

/** The job process's environment: built from nothing, not inherited. */
function jobEnvironment(payload, stateDir, agentEnv, deps) {
  const { baseEnv, jobUser } = deps;
  const env = {
    PATH: baseEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: jobUser.home,
    USER: jobUser.name,
    LOGNAME: jobUser.name,
    LANG: baseEnv.LANG ?? 'C.UTF-8',
    // Updraft reads its config from $UPDRAFT_HOME/config.yaml and keeps its state there.
    UPDRAFT_HOME: stateDir,
    ...agentEnv,
  };
  if (baseEnv.TZ) env.TZ = baseEnv.TZ;
  // Where the image keeps its headless browser; without it Playwright looks in the job
  // user's empty cache and reports the browser as not installed.
  if (baseEnv.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = baseEnv.PLAYWRIGHT_BROWSERS_PATH;
  // Deliberately absent: AWS_* (the runner's credentials and region), anything naming the
  // key file, and the run request. See "Security model" in the README for what this does
  // and does not achieve.
  return env;
}

/**
 * Uploads updraft.log and the run log named by the summary's logPath. The path comes from
 * the job's output, and this process is root, so only a regular file that really lies inside
 * the state directory is read. Returns the keys written.
 */
async function uploadLogs(stateDir, summary, keyPrefix, bucket, deps) {
  const maxBytes = deps.maxLogBytes ?? MAX_LOG_BYTES;
  // With UPDRAFT_HOME set, Updraft keeps its worker log under logs/ (src/paths.ts).
  const candidates = [['updraft.log', path.join(stateDir, 'logs', 'updraft.log')]];
  if (typeof summary?.logPath === 'string' && summary.logPath !== '') {
    candidates.push(['run.log', path.resolve(stateDir, summary.logPath)]);
  }
  const uploaded = [];
  let root;
  try {
    root = await fs.realpath(stateDir);
  } catch {
    return uploaded;
  }
  for (const [name, file] of candidates) {
    try {
      const real = await fs.realpath(file);
      if (!real.startsWith(`${root}${path.sep}`)) throw new Error('it is outside the state directory');
      const stat = await fs.lstat(real);
      if (!stat.isFile()) throw new Error('it is not a regular file');
      const handle = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let body;
      try {
        // A log larger than the limit is cut to its end, which is where a failure shows.
        const length = Math.min(stat.size, maxBytes);
        body = Buffer.alloc(length);
        await handle.read(body, 0, length, stat.size - length);
      } finally {
        await handle.close();
      }
      const key = `${keyPrefix}${name}`;
      await retry(() => deps.s3Put(bucket, key, body, 'text/plain; charset=utf-8'), deps);
      uploaded.push(key);
    } catch (error) {
      if (error?.code !== 'ENOENT') deps.log(`could not upload ${name}: ${error?.message ?? error}`);
    }
  }
  return uploaded;
}

async function runUpdraft(payload, stateDir, budgetMs, deadline, deps, registerStop) {
  const spawn = deps.spawn ?? nodeSpawn;
  const killGraceMs = deps.killGraceMs ?? 20_000;
  const agentEnv = parseAgentEnv(await deps.getSecret(payload.secrets.agentEnv));
  const [command, ...leading] = deps.updraftCommand;
  const args = [
    ...leading,
    ...updraftInvocation({
      eventFile: path.join(stateDir, EVENT_FILE),
      eventName: payload.eventName,
      deliveryId: payload.deliveryId,
      deadlineMinutes: deadline,
    }),
  ];
  const options = {
    cwd: stateDir,
    env: jobEnvironment(payload, stateDir, agentEnv, deps),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the watchdog can stop Updraft and everything it started.
    detached: true,
  };
  if (deps.jobUser.uid !== undefined) options.uid = deps.jobUser.uid;
  if (deps.jobUser.gid !== undefined) options.gid = deps.jobUser.gid;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let timedOut = false;
    let killTimer;
    let lastLine = '';
    let pending = '';
    let pendingOversized = false;
    let stderrTail = '';

    const stop = () => {
      signalGroup(child, 'SIGTERM');
      killTimer ??= setTimeout(() => signalGroup(child, 'SIGKILL'), killGraceMs);
    };
    registerStop(stop);
    const watchdog = setTimeout(() => {
      timedOut = true;
      deps.log('watchdog: updraft outlived its own deadline; stopping it, the microVM is close to its maximum duration');
      stop();
    }, budgetMs);

    const takeLine = (line) => {
      deps.logStream.write(`${line}\n`);
      if (line.trim() !== '') lastLine = line;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (pendingOversized) pendingOversized = false;
        else takeLine(line);
      }
      if (pending.length > MAX_STDOUT_LINE_BYTES) {
        // Not a summary line; drop it instead of holding it in memory.
        pending = '';
        pendingOversized = true;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      deps.logStream.write(chunk);
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', (error) => {
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      reject(new Error(`cannot start ${command}: ${error.message}`));
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      if (pending !== '' && !pendingOversized) takeLine(pending);
      const { summary, problem } = parseSummary(lastLine);
      resolve({ exitCode, signal, timedOut, summary, summaryProblem: problem, stderrTail });
    });
  });
}

function parseSummary(line) {
  if (line.trim() === '') return { summary: null, problem: ' (stdout was empty)' };
  try {
    const parsed = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { summary: parsed, problem: '' };
    return { summary: null, problem: ' (the last line is JSON but not an object)' };
  } catch {
    return { summary: null, problem: ' (the last line is not JSON)' };
  }
}

function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is gone already.
  }
}

async function retry(operation, deps, attempts = 3) {
  const delayMs = deps.retryDelayMs ?? 2000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
