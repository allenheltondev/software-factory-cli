// The shared Updraft state database: one SQLite file in S3 that every job starts from and
// merges its changes back into.
//
// Before the job the runner downloads the object into the job's state directory and keeps a
// pristine copy that only root can read (the merge base). After the job it loops: download
// the latest object, let `updraft state merge` (as the job user) merge what this run changed
// into it, and write it back with an S3 conditional write that succeeds only if nobody else
// wrote in between. On a conflict it starts again from the newer object.
//
// The runner is root and holds the AWS credentials. The Updraft CLI runs as the job user,
// with an environment built from nothing, and never gets them. Everything that talks to AWS
// or starts a process comes in through `deps` (see ../../test/runner-state.test.mjs).
/* global AbortController */
import { spawn as nodeSpawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** The database's name inside an Updraft home ($UPDRAFT_HOME/state.db). */
export const STATE_DB_FILE = 'state.db';

/** How often the download, merge, upload loop runs before it gives up. */
export const STATE_SYNC_MAX_ATTEMPTS = 4;
/** The most time state sync may take after a job, when the microVM has that long left. */
export const STATE_SYNC_MAX_MS = 5 * 60 * 1000;
/** Time kept after state sync for the logs, the result document and TerminateMicrovm. */
export const REPORT_RESERVE_MS = 90 * 1000;
/** State sync's budget once Lambda has asked the microVM to terminate (the hook has 60 s). */
export const TERMINATING_SYNC_MS = 15 * 1000;
/** A snapshot larger than this is refused: it is held in memory while it is checked. */
export const MAX_STATE_BYTES = 256 * 1024 * 1024;
/** Smaller than one default SQLite page cannot be an Updraft database. */
export const MIN_STATE_BYTES = 4096;

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const MAX_TOOL_STDOUT_BYTES = 1024 * 1024;
const TOOL_STDERR_TAIL_BYTES = 2 * 1024;
const MAX_REPORT_JSON_BYTES = 16 * 1024;

/**
 * THE ONE PLACE that knows how `updraft state merge` is invoked:
 *
 *   updraft state merge --changed <db the run used> --into <latest shared db>
 *                       [--base <snapshot the run started from>] --json
 *
 * A three-way, row-level merge. --base omitted means the run started from nothing; --into
 * need not exist (it is created). It leaves --into as one self-contained SQLite file and
 * prints one JSON object. Exit 0 on success; any other exit means --into must not be
 * uploaded (one of them says that --into has a newer schema than this CLI).
 */
export function stateMergeInvocation({ changed, into, base }) {
  return ['state', 'merge', '--changed', changed, '--into', into, ...(base ? ['--base', base] : []), '--json'];
}

/**
 * THE ONE PLACE that reads `updraft state merge --json`'s output. Only `changed` decides
 * anything: exactly `false` means the run changed nothing and there is nothing to upload.
 * Anything else, a missing field included, is treated as "changed" (an unnecessary upload is
 * harmless, a skipped one loses history). The rest of the object is copied into the result
 * document unread, so new or renamed count fields show up there without a change here.
 */
export function readMergeReport(report) {
  return { changed: report?.changed !== false, report: clip(report) };
}

/**
 * THE ONE PLACE that knows how `updraft state info` is invoked:
 *
 *   updraft state info --db <file> --json
 *
 * Read-only; prints the schema version and row counts. The runner uses it as the check that
 * a file about to be uploaded opens as an Updraft database. Its exit code is what counts;
 * the JSON object is copied into the result document unread.
 */
export function stateInfoInvocation({ db }) {
  return ['state', 'info', '--db', db, '--json'];
}

/**
 * Why a merge that exited non-zero did not happen, for the result document. `updraft state
 * merge` exits 5 with `reason: "schema-too-new"` when a database is newer than the CLI; the
 * wording of its message is matched too, in case either of those changes.
 */
export function describeMergeFailure({ exitCode, signal, report, stderrTail }) {
  const said = [report?.error, report?.message, report?.reason].find((value) => typeof value === 'string' && value !== '') ?? stderrTail.trim();
  const newerSchema = exitCode === 5
    || report?.reason === 'schema-too-new'
    || /newer.{0,60}schema|schema.{0,60}newer/i.test(`${said} ${typeof report?.code === 'string' ? report.code : ''}`);
  const how = signal ? `was killed by ${signal}` : `exited ${exitCode}`;
  return {
    code: newerSchema ? 'newer-schema' : 'merge-failed',
    message: newerSchema
      ? `updraft state merge ${how}: the shared database has a newer schema than the Updraft in this image, so nothing was uploaded; rebuild the image with a newer Updraft (${oneLine(said)})`
      : `updraft state merge ${how}${said ? `: ${oneLine(said)}` : ''}`,
  };
}

/**
 * What can be read from a SQLite file's first 100 bytes without opening it: whether it is a
 * SQLite database at all, and PRAGMA user_version (offset 60, big-endian), which is where
 * Updraft keeps its schema version. For a file without a pending write-ahead log, which is
 * what the merge leaves and what S3 holds, the header is authoritative.
 */
export function sqliteHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) return { valid: false, schemaVersion: null };
  if (!buffer.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return { valid: false, schemaVersion: null };
  return { valid: true, schemaVersion: buffer.readUInt32BE(60) };
}

/** Why these bytes may not be uploaded as the shared database, or null. */
export function refuseUpload(buffer, replacedSchemaVersion) {
  if (buffer.length < MIN_STATE_BYTES) return `the merged file is only ${buffer.length} bytes`;
  if (buffer.length > MAX_STATE_BYTES) return `the merged file is ${buffer.length} bytes, over the limit of ${MAX_STATE_BYTES}`;
  const header = sqliteHeader(buffer);
  if (!header.valid) return 'the merged file is not a SQLite database';
  if (typeof replacedSchemaVersion === 'number' && header.schemaVersion < replacedSchemaVersion) {
    return `the merged file has schema version ${header.schemaVersion}, older than the ${replacedSchemaVersion} of the object it would replace`;
  }
  return null;
}

/**
 * Downloads the shared database into the job's state directory, before the job user owns it.
 * A missing object is the normal first run. Returns what the result document says about the
 * snapshot, and what the sync after the job needs.
 *
 * @returns {Promise<{ snapshot: object, baseFile: string | undefined, baseDir: string | undefined }>}
 */
export async function downloadState({ bucket, key, stateDir }, deps) {
  const snapshot = { found: false, bytes: null, etag: null, schemaVersion: null };
  const object = await deps.s3GetIfExists(bucket, key);
  if (object === undefined) {
    deps.log(`no shared state at s3://${bucket}/${key} yet; this run starts from nothing`);
    return { snapshot, baseFile: undefined, baseDir: undefined };
  }
  const body = object.body;
  const header = sqliteHeader(body);
  if (!header.valid || body.length > MAX_STATE_BYTES) {
    // Do not run an agent against a database that will then be merged into nothing sensible.
    throw new Error(
      `the shared state at s3://${bucket}/${key} is ${!header.valid ? 'not a SQLite database' : `larger than ${MAX_STATE_BYTES} bytes`}; restore an earlier version of the object (README, "Shared state")`,
    );
  }
  await fs.writeFile(path.join(stateDir, STATE_DB_FILE), body, { mode: 0o600, flag: 'wx' });
  // The merge base: what this run started from, where the job user cannot change it.
  const baseDir = await fs.mkdtemp(path.join(deps.stateRoot, 'base-'));
  await fs.chmod(baseDir, 0o700);
  const baseFile = path.join(baseDir, STATE_DB_FILE);
  await fs.writeFile(baseFile, body, { mode: 0o600, flag: 'wx' });
  Object.assign(snapshot, { found: true, bytes: body.length, etag: object.etag ?? null, schemaVersion: header.schemaVersion });
  deps.log(`shared state: ${body.length} bytes, schema version ${header.schemaVersion}, from s3://${bucket}/${key}`);
  return { snapshot, baseFile, baseDir };
}

/** How long state sync may take, given when the microVM ends. 0 means there is no time. */
export function stateSyncBudgetMs(payload, nowMs, { terminating = false } = {}) {
  const hardEnd = Date.parse(payload.launchedAt) + payload.maximumDurationSeconds * 1000;
  const untilReport = hardEnd - REPORT_RESERVE_MS - nowMs;
  return Math.max(0, Math.min(untilReport, terminating ? TERMINATING_SYNC_MS : STATE_SYNC_MAX_MS));
}

/**
 * Merges what the run changed into the latest shared database and uploads it. Never throws:
 * the returned report says what happened, and `notSavedReason` is null only when the state
 * was saved or the run changed nothing.
 *
 * @param {object} context
 * @param {string} context.bucket
 * @param {string} context.key
 * @param {string} context.stateDir the job's Updraft home; its state.db is what the run used
 * @param {string} [context.baseFile] the pristine snapshot the run started from, if there was one
 * @param {number} context.budgetMs everything here stops after this long
 * @param {object} deps
 * @param {(bucket: string, key: string, options?: { signal?: AbortSignal }) => Promise<{ body: Buffer, etag?: string } | undefined>} deps.s3GetIfExists
 * @param {(bucket: string, key: string, body: Buffer, condition: { ifMatch?: string, ifNoneMatch?: string }, options?: { signal?: AbortSignal }) => Promise<{ written: boolean, status?: number, etag?: string }>} deps.s3PutIf
 *   resolves `{ written: false }` when S3 refused the precondition (412, 409, 404); rejects on anything else
 * @param {(register: () => void) => void} [context.onHurry] called with a function that cuts
 *   the remaining budget to TERMINATING_SYNC_MS (the microVM is being terminated)
 */
export async function syncState(context, deps) {
  const report = {
    attempted: true,
    saved: false,
    changed: null,
    attempts: 0,
    conflicts: 0,
    merge: null,
    info: null,
    uploadedBytes: null,
    schemaVersion: null,
    etag: null,
    notSavedReason: null,
    notSavedCode: null,
    durationMs: null,
  };
  const started = Date.now();
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), context.budgetMs);
  const hurriedMs = deps.terminatingSyncMs ?? TERMINATING_SYNC_MS;
  context.onHurry?.(() => {
    const left = context.budgetMs - (Date.now() - started);
    if (left <= hurriedMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), hurriedMs);
  });
  const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
  const setReason = (code, message) => {
    report.notSavedCode = code;
    report.notSavedReason = message;
  };
  // The loop can outlive the race below when a dependency ignores the abort signal; what it
  // concludes after that must not replace "timed out".
  const fail = (code, message) => {
    if (!controller.signal.aborted) setReason(code, message);
  };

  const workDirs = [];
  try {
    if (context.budgetMs <= 0) {
      setReason('no-time', 'no time left before the microVM reaches its maximum duration');
    } else {
      // The race is what guarantees an end: a dependency that ignores the abort signal cannot
      // keep the runner from reporting and terminating the microVM.
      const outcome = await Promise.race([syncLoop(context, deps, report, controller.signal, workDirs, fail), aborted]);
      if (outcome === 'aborted') {
        setReason('timed-out', `state sync was stopped after ${Math.round((Date.now() - started) / 1000)} s (attempt ${report.attempts}); the shared database was left as it was unless an upload already under way completed`);
      }
    }
  } catch (error) {
    if (controller.signal.aborted) setReason('timed-out', `state sync was stopped after ${Math.round((Date.now() - started) / 1000)} s (attempt ${report.attempts})`);
    else setReason('error', `state sync failed: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const dir of workDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  report.durationMs = Date.now() - started;
  if (report.notSavedReason) deps.log(`STATE NOT SAVED (${report.notSavedCode}): ${report.notSavedReason}`);
  else if (report.saved) deps.log(`shared state saved: ${report.uploadedBytes} bytes, schema version ${report.schemaVersion}, attempt ${report.attempts}`);
  else deps.log('shared state unchanged by this run; nothing uploaded');
  return report;
}

async function syncLoop(context, deps, report, signal, workDirs, fail) {
  const { bucket, key, stateDir, baseFile } = context;
  const changed = path.join(stateDir, STATE_DB_FILE);
  try {
    const stat = await fs.lstat(changed);
    if (!stat.isFile()) throw new Error('not a regular file');
  } catch (error) {
    // run-event creates the database before anything else; without one there is nothing to merge.
    return fail('no-run-database', `the run left no ${STATE_DB_FILE} in its state directory (${error?.code ?? error?.message ?? error})`);
  }

  let lastProblem = '';
  for (let attempt = 1; attempt <= (deps.stateSyncMaxAttempts ?? STATE_SYNC_MAX_ATTEMPTS); attempt += 1) {
    if (signal.aborted) return undefined;
    report.attempts = attempt;

    // 1. The latest shared database and its ETag.
    let latest;
    try {
      latest = await deps.s3GetIfExists(bucket, key, { signal });
    } catch (error) {
      lastProblem = `could not download the shared database: ${error?.message ?? error}`;
      deps.log(`state sync attempt ${attempt}: ${lastProblem}`);
      await pause(deps, attempt, signal);
      continue;
    }
    if (signal.aborted) return undefined;
    const replaced = latest ? sqliteHeader(latest.body) : undefined;
    if (latest && !replaced.valid) {
      return fail('shared-database-unreadable', `the object at s3://${bucket}/${key} is not a SQLite database; nothing was merged into it. Restore an earlier version`);
    }

    // 2. A directory for this attempt. Root fills it while only root can enter it, then
    //    hands it to the job user, so nothing the job left running can plant a link there.
    const workDir = await fs.mkdtemp(path.join(deps.stateRoot, 'merge-'));
    workDirs.push(workDir);
    await fs.chmod(workDir, 0o700);
    const into = path.join(workDir, 'into.db');
    const base = baseFile ? path.join(workDir, 'base.db') : undefined;
    if (latest) await fs.writeFile(into, latest.body, { mode: 0o600, flag: 'wx' });
    if (base) await fs.copyFile(baseFile, base, fsConstants.COPYFILE_EXCL);
    await handOver(workDir, [latest ? into : undefined, base], deps.jobUser);

    // 3. The merge, as the job user.
    const merge = await runTool(stateMergeInvocation({ changed, into, base }), stateDir, deps, signal);
    if (signal.aborted) return undefined;
    const mergeReport = parseJsonOutput(merge.stdout);
    if (merge.exitCode !== 0) {
      report.merge = clip(mergeReport);
      const failure = describeMergeFailure({ ...merge, report: mergeReport });
      return fail(failure.code, failure.message);
    }
    if (mergeReport === null) {
      return fail('merge-report-missing', 'updraft state merge exited 0 without printing a JSON object, so whether anything changed is unknown; nothing was uploaded');
    }
    const read = readMergeReport(mergeReport);
    report.merge = read.report;
    report.changed = read.changed;
    if (!read.changed) return undefined;

    // 4. Is the result a database? `state info` must open it, and the bytes must look right.
    const info = await runTool(stateInfoInvocation({ db: into }), stateDir, deps, signal);
    if (signal.aborted) return undefined;
    if (info.exitCode !== 0) {
      return fail('merged-database-unreadable', `updraft state info ${info.signal ? `was killed by ${info.signal}` : `exited ${info.exitCode}`} on the merged database; nothing was uploaded${info.stderrTail.trim() ? `: ${oneLine(info.stderrTail)}` : ''}`);
    }
    report.info = clip(parseJsonOutput(info.stdout));
    let candidate;
    try {
      candidate = await readCandidate(into);
    } catch (error) {
      return fail('merged-database-unreadable', `the merged database cannot be read: ${error?.message ?? error}`);
    }
    const refusal = refuseUpload(candidate, replaced?.schemaVersion);
    if (refusal) return fail('merged-database-refused', `${refusal}; nothing was uploaded`);

    // 5. Write it back only if the object is still the one that was merged into.
    let put;
    try {
      put = await deps.s3PutIf(bucket, key, candidate, latest ? { ifMatch: latest.etag } : { ifNoneMatch: '*' }, { signal });
    } catch (error) {
      lastProblem = `the upload failed: ${error?.message ?? error}`;
      deps.log(`state sync attempt ${attempt}: ${lastProblem}`);
      await pause(deps, attempt, signal);
      continue;
    }
    if (signal.aborted) return undefined;
    if (put.written) {
      report.saved = true;
      report.uploadedBytes = candidate.length;
      report.schemaVersion = sqliteHeader(candidate).schemaVersion;
      report.etag = put.etag ?? null;
      return undefined;
    }
    report.conflicts += 1;
    lastProblem = `another run wrote the shared database first (HTTP ${put.status ?? '412'})`;
    deps.log(`state sync attempt ${attempt}: ${lastProblem}; merging again into the newer object`);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  return fail('attempts-exhausted', `gave up after ${report.attempts} attempts; the last one: ${lastProblem}`);
}

/** Gives the attempt's directory and the files root put there to the job user, owner-only. */
async function handOver(workDir, files, jobUser) {
  if (jobUser.uid === undefined || jobUser.gid === undefined) return;
  for (const file of files) if (file) await fs.lchown(file, jobUser.uid, jobUser.gid);
  await fs.lchown(workDir, jobUser.uid, jobUser.gid);
}

/**
 * Reads the merged file as root from a directory the job user owns: a regular file only,
 * never through a link, and not if a write-ahead log with content sits next to it (the
 * file alone would then not be the whole database).
 */
async function readCandidate(file) {
  const wal = await fs.lstat(`${file}-wal`).catch(() => undefined);
  if (wal && wal.size > 0) throw new Error('the merge left a write-ahead log next to it, so the file is not self-contained');
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('it is not a regular file');
    if (stat.size > MAX_STATE_BYTES) throw new Error(`it is ${stat.size} bytes, over the limit of ${MAX_STATE_BYTES}`);
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(body, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return body.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** The environment of `updraft state ...`: built from nothing, like the job's, minus the agent's keys. */
export function toolEnvironment(stateDir, deps) {
  const { baseEnv, jobUser } = deps;
  const env = {
    PATH: baseEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: jobUser.home,
    USER: jobUser.name,
    LOGNAME: jobUser.name,
    LANG: baseEnv.LANG ?? 'C.UTF-8',
    // So that what the command logs lands in the job's updraft.log, which is uploaded.
    UPDRAFT_HOME: stateDir,
  };
  if (baseEnv.TZ) env.TZ = baseEnv.TZ;
  // Deliberately absent: AWS_* and every agent credential. A merge needs neither.
  return env;
}

/** Runs one short `updraft` command as the job user and collects its output. Never rejects. */
function runTool(args, stateDir, deps, signal) {
  const spawn = deps.spawn ?? nodeSpawn;
  const [command, ...leading] = deps.updraftCommand;
  const options = {
    cwd: stateDir,
    env: toolEnvironment(stateDir, deps),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  };
  if (deps.jobUser.uid !== undefined) options.uid = deps.jobUser.uid;
  if (deps.jobUser.gid !== undefined) options.gid = deps.jobUser.gid;
  return new Promise((resolve) => {
    let stdout = '';
    let stderrTail = '';
    let child;
    try {
      child = spawn(command, [...leading, ...args], options);
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout, stderrTail: `cannot start ${command}: ${error.message}` });
      return;
    }
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    };
    signal.addEventListener('abort', kill, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_TOOL_STDOUT_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      deps.logStream?.write(chunk);
      stderrTail = (stderrTail + chunk).slice(-TOOL_STDERR_TAIL_BYTES);
    });
    child.on('error', (error) => {
      signal.removeEventListener('abort', kill);
      resolve({ exitCode: null, signal: null, stdout, stderrTail: `cannot start ${command}: ${error.message}` });
    });
    child.on('close', (exitCode, killedBy) => {
      signal.removeEventListener('abort', kill);
      resolve({ exitCode, signal: killedBy, stdout, stderrTail });
    });
  });
}

/** The JSON object a command printed: its whole stdout, or failing that its last line. */
function parseJsonOutput(stdout) {
  const text = stdout.trim();
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  for (const candidate of [text, lines.at(-1) ?? '']) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next reading.
    }
  }
  return null;
}

/** A command's JSON object for the result document, unless it is unreasonably large. */
function clip(report) {
  if (report === null || report === undefined) return null;
  const size = Buffer.byteLength(JSON.stringify(report), 'utf8');
  return size <= MAX_REPORT_JSON_BYTES ? report : { truncated: true, bytes: size };
}

function oneLine(text) {
  return String(text).trim().replace(/\s+/g, ' ').slice(-500);
}

function pause(deps, attempt, signal) {
  const delayMs = (deps.retryDelayMs ?? 2000) * attempt;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
