import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runJob } from '../image/runner/job.mjs';
import {
  MIN_STATE_BYTES,
  REPORT_RESERVE_MS,
  STATE_SYNC_MAX_MS,
  TERMINATING_SYNC_MS,
  describeMergeFailure,
  readMergeReport,
  refuseUpload,
  sqliteHeader,
  stateInfoInvocation,
  stateMergeInvocation,
  stateSyncBudgetMs,
  syncState,
} from '../image/runner/state.mjs';
import { decodeStateDb, encodeStateDb } from './fake-state-db.mjs';

const FAKE_UPDRAFT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-updraft.mjs');
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----';
const KEY_ARN = 'arn:aws:secretsmanager:eu-test-1:000000000000:secret:key';
const ENV_ARN = 'arn:aws:secretsmanager:eu-test-1:000000000000:secret:env';
const START = Date.parse('2026-01-02T03:04:05.000Z');
const BUCKET = 'job-bucket';
const KEY = 'state/state.db';

let root;
let recordFile;
let stateRecord;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-state-test-'));
  recordFile = path.join(root, 'record.json');
  stateRecord = path.join(root, 'state-calls.jsonl');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * S3 as far as the runner uses it for the state object: ETags, If-Match and If-None-Match on
 * writes (412 when the precondition does not hold), and every version kept, as in a bucket
 * with versioning. `beforePut` runs between a caller's GET and its PUT: a concurrent writer.
 */
function memoryS3(initial) {
  const etagOf = (body) => `"${crypto.createHash('md5').update(body).digest('hex')}"`;
  const s3 = {
    versions: initial ? [Buffer.from(initial)] : [],
    calls: [],
    beforePut: undefined,
    get current() {
      return s3.versions.at(-1);
    },
    rows: () => decodeStateDb(s3.current).rows,
    put: (body) => s3.versions.push(Buffer.from(body)),
    s3GetIfExists: async (bucket, key) => {
      s3.calls.push(['get', bucket, key]);
      return s3.current ? { body: Buffer.from(s3.current), etag: etagOf(s3.current) } : undefined;
    },
    s3PutIf: async (bucket, key, body, condition) => {
      const hook = s3.beforePut;
      s3.beforePut = undefined;
      await hook?.();
      s3.calls.push(['put', bucket, key, condition]);
      if ((condition.ifMatch === undefined) === (condition.ifNoneMatch === undefined)) throw new Error('one condition, please');
      if (condition.ifNoneMatch === '*' && s3.current) return { written: false, status: 412 };
      if (condition.ifMatch !== undefined && !s3.current) return { written: false, status: 404 };
      if (condition.ifMatch !== undefined && condition.ifMatch !== etagOf(s3.current)) return { written: false, status: 412 };
      s3.put(body);
      return { written: true, etag: etagOf(body) };
    },
  };
  return s3;
}

const stateCalls = () => (fs.existsSync(stateRecord) ? fs.readFileSync(stateRecord, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const merges = () => stateCalls().filter((call) => call.command === 'merge');

/** What syncState needs besides S3: a state directory holding the run's database. */
function syncSetup({ runRows, baseRows, control = {}, s3, depsOverrides = {} }) {
  const stateRoot = path.join(root, 'state');
  const stateDir = path.join(stateRoot, 'job-1');
  fs.mkdirSync(stateDir, { recursive: true });
  if (runRows) fs.writeFileSync(path.join(stateDir, 'state.db'), encodeStateDb(runRows));
  fs.writeFileSync(path.join(stateDir, 'fake-state-control.json'), JSON.stringify({ record: stateRecord, ...control }));
  let baseFile;
  if (baseRows) {
    baseFile = path.join(root, 'base.db');
    fs.writeFileSync(baseFile, encodeStateDb(baseRows));
  }
  const logs = [];
  const deps = {
    s3GetIfExists: s3.s3GetIfExists,
    s3PutIf: s3.s3PutIf,
    stateRoot,
    updraftCommand: [process.execPath, FAKE_UPDRAFT],
    jobUser: { home: path.join(root, 'home'), name: 'updraft' },
    baseEnv: {
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'runner-secret-key',
      AWS_SESSION_TOKEN: 'runner-session-token',
      AWS_REGION: 'eu-test-1',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/creds',
      ANTHROPIC_API_KEY: 'sk-ant-should-not-reach-the-merge',
    },
    log: (message) => logs.push(message),
    logStream: { write: () => {} },
    retryDelayMs: 1,
    ...depsOverrides,
  };
  return { context: { bucket: BUCKET, key: KEY, stateDir, baseFile, budgetMs: 20_000 }, deps, logs, stateDir, stateRoot };
}

// The runner only ever runs in the Linux image: it relies on POSIX file modes, signals and
// process groups, none of which behave this way on Windows. These suites start real child
// processes, so they are left out there; the pure helpers below still run everywhere.
const onLinuxLikeHost = process.platform !== 'win32';

describe.runIf(onLinuxLikeHost)('syncState', () => {
  it('creates the object on the first run, with If-None-Match', async () => {
    const s3 = memoryS3();
    const { context, deps, stateDir, stateRoot } = syncSetup({ runRows: ['job-a'], s3 });
    const report = await syncState(context, deps);

    expect(report).toMatchObject({ attempted: true, saved: true, changed: true, attempts: 1, conflicts: 0, notSavedReason: null, notSavedCode: null, schemaVersion: 3 });
    expect(report.uploadedBytes).toBe(s3.current.length);
    expect(report.merge).toMatchObject({ changed: true, somethingNew: true });
    expect(report.info).toEqual({ schemaVersion: 3, tables: { rows: 1 } });
    expect(s3.rows()).toEqual(['job-a']);
    expect(s3.calls).toEqual([
      ['get', BUCKET, KEY],
      ['put', BUCKET, KEY, { ifNoneMatch: '*' }],
    ]);

    // The merge was given the run's database in place, a scratch --into that did not exist,
    // and no --base.
    const [merge] = merges();
    expect(merge.args).toEqual(['state', 'merge', '--changed', path.join(stateDir, 'state.db'), '--into', expect.stringMatching(/merge-[^/]+\/into\.db$/), '--json']);
    expect(merge.intoExisted).toBe(false);
    expect(path.dirname(path.dirname(merge.args[5]))).toBe(stateRoot);
    // Scratch directories are removed afterwards.
    expect(fs.readdirSync(stateRoot)).toEqual(['job-1']);
  });

  it('updates an existing object with If-Match on the ETag it merged into, passing the base', async () => {
    const s3 = memoryS3(encodeStateDb(['old-1', 'old-2']));
    const { context, deps } = syncSetup({ runRows: ['old-1', 'old-2', 'job-a'], baseRows: ['old-1', 'old-2'], s3 });
    const etag = (await s3.s3GetIfExists(BUCKET, KEY)).etag;
    s3.calls.length = 0;
    const report = await syncState(context, deps);

    expect(report).toMatchObject({ saved: true, changed: true, attempts: 1, notSavedReason: null });
    expect(report.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(s3.rows()).toEqual(['job-a', 'old-1', 'old-2']);
    expect(s3.calls.at(-1)).toEqual(['put', BUCKET, KEY, { ifMatch: etag }]);
    // The earlier object is still there, as with bucket versioning.
    expect(s3.versions).toHaveLength(2);

    const [merge] = merges();
    expect(merge.args).toEqual(['state', 'merge', '--changed', expect.any(String), '--into', expect.stringMatching(/into\.db$/), '--base', expect.stringMatching(/base\.db$/), '--json']);
    expect(merge.baseRows).toEqual(['old-1', 'old-2']);
    expect(merge.intoRows).toEqual(['old-1', 'old-2']);
    // --base is a copy next to --into, not the pristine file itself.
    expect(merge.args[7]).not.toBe(context.baseFile);
    expect(path.dirname(merge.args[7])).toBe(path.dirname(merge.args[5]));
  });

  it('merges again when another run writes between its GET and its PUT, and keeps both runs\' changes', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps, logs } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], s3 });
    s3.beforePut = () => s3.put(encodeStateDb(['old', 'job-b']));
    const report = await syncState(context, deps);

    expect(report).toMatchObject({ saved: true, attempts: 2, conflicts: 1, notSavedReason: null });
    expect(s3.rows()).toEqual(['job-a', 'job-b', 'old']);
    expect(s3.calls.map(([name]) => name)).toEqual(['get', 'put', 'get', 'put']);
    // Two different ETags: the second PUT named the object the other run had written.
    expect(s3.calls[1][3].ifMatch).not.toBe(s3.calls[3][3].ifMatch);
    // The second merge started from the newer object, in a new scratch file.
    const [first, second] = merges();
    expect(first.intoRows).toEqual(['old']);
    expect(second.intoRows).toEqual(['job-b', 'old']);
    expect(second.args[5]).not.toBe(first.args[5]);
    expect(logs.some((line) => line.includes('another run wrote the shared database first'))).toBe(true);
  });

  it('retries when the object appears between "there is none" and the first write', async () => {
    const s3 = memoryS3();
    const { context, deps } = syncSetup({ runRows: ['job-a'], s3 });
    s3.beforePut = () => s3.put(encodeStateDb(['job-b']));
    const report = await syncState(context, deps);
    expect(report).toMatchObject({ saved: true, attempts: 2, conflicts: 1 });
    expect(s3.calls.filter(([name]) => name === 'put').map(([, , , condition]) => Object.keys(condition))).toEqual([['ifNoneMatch'], ['ifMatch']]);
    expect(s3.rows()).toEqual(['job-a', 'job-b']);
  });

  it('gives up after a bounded number of conflicts and says so', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps, logs } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], s3 });
    let n = 0;
    const put = s3.s3PutIf;
    deps.s3PutIf = async (...args) => {
      s3.put(encodeStateDb(['old', `other-${(n += 1)}`]));
      return put(...args);
    };
    const report = await syncState(context, deps);

    expect(report).toMatchObject({ saved: false, changed: true, attempts: 4, conflicts: 4, notSavedCode: 'attempts-exhausted' });
    expect(report.notSavedReason).toContain('gave up after 4 attempts');
    expect(s3.rows()).not.toContain('job-a');
    expect(logs.some((line) => line.startsWith('STATE NOT SAVED (attempts-exhausted)'))).toBe(true);
  });

  it('retries a failed download or upload within the same bound', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], s3 });
    let gets = 0;
    let puts = 0;
    const get = s3.s3GetIfExists;
    const put = s3.s3PutIf;
    deps.s3GetIfExists = async (...args) => {
      if ((gets += 1) === 1) throw new Error('SlowDown');
      return get(...args);
    };
    deps.s3PutIf = async (...args) => {
      if ((puts += 1) === 1) throw new Error('InternalError');
      return put(...args);
    };
    const report = await syncState(context, deps);
    expect(report).toMatchObject({ saved: true, attempts: 3, conflicts: 0 });
    expect(s3.rows()).toEqual(['job-a', 'old']);
  });

  it('uploads nothing when the merge fails', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], control: { merge: 'fail' }, s3 });
    const report = await syncState(context, deps);
    expect(report).toMatchObject({ saved: false, attempts: 1, notSavedCode: 'merge-failed' });
    expect(report.notSavedReason).toContain('updraft state merge exited 1');
    expect(report.notSavedReason).toContain('malformed');
    expect(s3.calls.map(([name]) => name)).toEqual(['get']);
    expect(s3.versions).toHaveLength(1);
  });

  it('uploads nothing when the shared database has a newer schema than the CLI in the image', async () => {
    const s3 = memoryS3(encodeStateDb(['old'], 9));
    const { context, deps } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], s3 });
    const report = await syncState(context, deps);
    expect(report).toMatchObject({ saved: false, attempts: 1, notSavedCode: 'newer-schema' });
    expect(report.notSavedReason).toContain('exited 4');
    expect(report.notSavedReason).toContain('rebuild the image');
    expect(report.merge).toMatchObject({ error: expect.any(String) });
    expect(s3.calls.map(([name]) => name)).toEqual(['get']);
    expect(decodeStateDb(s3.current).schemaVersion).toBe(9);
  });

  it('uploads nothing when the run changed nothing', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps, logs } = syncSetup({ runRows: ['old'], baseRows: ['old'], s3 });
    const report = await syncState(context, deps);
    expect(report).toMatchObject({ saved: false, changed: false, attempts: 1, notSavedReason: null, notSavedCode: null });
    expect(s3.calls.map(([name]) => name)).toEqual(['get']);
    expect(stateCalls().map((call) => call.command)).toEqual(['merge']);
    expect(logs.some((line) => line.includes('STATE NOT SAVED'))).toBe(false);
  });

  it('never uploads a file that is not a database of non-trivial size', async () => {
    for (const [control, code, text] of [
      [{ merge: 'garbage' }, 'merged-database-unreadable', 'updraft state info exited 1'],
      [{ merge: 'tiny' }, 'merged-database-unreadable', 'state info'],
      [{ merge: 'wal' }, 'merged-database-unreadable', 'write-ahead log'],
      [{ merge: 'no-json' }, 'merge-report-missing', 'without printing a JSON object'],
      [{ info: 'fail' }, 'merged-database-unreadable', 'refused by the test'],
    ]) {
      const s3 = memoryS3(encodeStateDb(['old']));
      const { context, deps } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], control, s3 });
      const report = await syncState(context, deps);
      expect(report, JSON.stringify(control)).toMatchObject({ saved: false, notSavedCode: code });
      expect(report.notSavedReason, JSON.stringify(control)).toContain(text);
      expect(s3.versions, JSON.stringify(control)).toHaveLength(1);
      fs.rmSync(path.join(root, 'state'), { recursive: true, force: true });
    }
  });

  it('says so when the run left no database', async () => {
    const s3 = memoryS3();
    const { context, deps } = syncSetup({ s3 });
    const report = await syncState(context, deps);
    expect(report).toMatchObject({ saved: false, attempts: 0, notSavedCode: 'no-run-database' });
    expect(s3.calls).toEqual([]);
  });

  it('refuses to merge into an object that is not a database', async () => {
    const s3 = memoryS3(Buffer.alloc(8192, 0x41));
    const { context, deps } = syncSetup({ runRows: ['job-a'], s3 });
    const report = await syncState(context, deps);
    expect(report).toMatchObject({ saved: false, notSavedCode: 'shared-database-unreadable' });
    expect(merges()).toEqual([]);
    expect(s3.versions).toHaveLength(1);
  });

  it('stops a merge that hangs when its budget is used up', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps, stateRoot } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], control: { merge: 'hang' }, s3 });
    const started = Date.now();
    const report = await syncState({ ...context, budgetMs: 400 }, deps);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(report).toMatchObject({ saved: false, attempts: 1, notSavedCode: 'timed-out' });
    expect(report.notSavedReason).toContain('state sync was stopped');
    expect(s3.versions).toHaveLength(1);
    expect(fs.readdirSync(stateRoot)).toEqual(['job-1']);
  });

  it('ends on time even when S3 never answers and ignores the abort signal', async () => {
    for (const hang of ['s3GetIfExists', 's3PutIf']) {
      const s3 = memoryS3(encodeStateDb(['old']));
      const { context, deps } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], s3, depsOverrides: {} });
      deps[hang] = () => new Promise(() => {});
      const started = Date.now();
      const report = await syncState({ ...context, budgetMs: 300 }, deps);
      expect(Date.now() - started, hang).toBeLessThan(5000);
      expect(report, hang).toMatchObject({ saved: false, notSavedCode: 'timed-out' });
      fs.rmSync(path.join(root, 'state'), { recursive: true, force: true });
    }
  });

  it('passes the abort signal to S3 and does nothing at all without a budget', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], s3 });
    const signals = [];
    const get = s3.s3GetIfExists;
    deps.s3GetIfExists = (bucket, key, options) => {
      signals.push(options?.signal);
      return get(bucket, key);
    };
    await syncState(context, deps);
    expect(signals[0].aborted).toBe(true); // aborted once the sync is over, so nothing lingers

    s3.calls.length = 0;
    const none = await syncState({ ...context, budgetMs: 0 }, deps);
    expect(none).toMatchObject({ saved: false, attempts: 0, notSavedCode: 'no-time' });
    expect(s3.calls).toEqual([]);
  });

  it('cuts its budget short when the microVM is being terminated', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], control: { merge: 'hang' }, s3, depsOverrides: { terminatingSyncMs: 200 } });
    let hurry;
    const started = Date.now();
    const pending = syncState({ ...context, budgetMs: 60_000, onHurry: (fn) => (hurry = fn) }, deps);
    expect(hurry).toBeTypeOf('function');
    hurry();
    expect(await pending).toMatchObject({ saved: false, notSavedCode: 'timed-out' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(TERMINATING_SYNC_MS).toBeLessThan(STATE_SYNC_MAX_MS);
  });

  it('gives the merge and the check an environment without AWS credentials or agent keys', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { context, deps, stateDir } = syncSetup({ runRows: ['old', 'job-a'], baseRows: ['old'], s3 });
    await syncState(context, deps);
    const calls = stateCalls();
    expect(calls.map((call) => call.command)).toEqual(['merge', 'info']);
    for (const call of calls) {
      expect(Object.keys(call.env).filter((name) => /^AWS_/i.test(name)), call.command).toEqual([]);
      expect(JSON.stringify(call.env), call.command).not.toMatch(/AKIAEXAMPLE|runner-secret-key|runner-session-token|sk-ant-|169\.254/);
      expect(call.env.UPDRAFT_HOME).toBe(stateDir);
      expect(call.env.HOME).toBe(deps.jobUser.home);
      expect(Object.keys(call.env).sort()).toEqual(expect.arrayContaining(['HOME', 'LANG', 'LOGNAME', 'PATH', 'UPDRAFT_HOME', 'USER']));
    }
    expect(calls[1].args).toEqual(['state', 'info', '--db', calls[0].args[5], '--json']);
  });
});

describe('state helpers', () => {
  it('builds the merge and info command lines', () => {
    expect(stateMergeInvocation({ changed: '/s/state.db', into: '/m/into.db', base: '/m/base.db' })).toEqual([
      'state', 'merge', '--changed', '/s/state.db', '--into', '/m/into.db', '--base', '/m/base.db', '--json',
    ]);
    expect(stateMergeInvocation({ changed: '/s/state.db', into: '/m/into.db' })).toEqual(['state', 'merge', '--changed', '/s/state.db', '--into', '/m/into.db', '--json']);
    expect(stateInfoInvocation({ db: '/m/into.db' })).toEqual(['state', 'info', '--db', '/m/into.db', '--json']);
  });

  it('treats only an explicit changed: false as "nothing to upload"', () => {
    expect(readMergeReport({ changed: false }).changed).toBe(false);
    expect(readMergeReport({ changed: true }).changed).toBe(true);
    expect(readMergeReport({ rows: 3 }).changed).toBe(true);
    expect(readMergeReport({ changed: 'no' }).changed).toBe(true);
    expect(readMergeReport({ changed: true, huge: 'x'.repeat(20000) }).report).toMatchObject({ truncated: true });
  });

  it('recognises a newer schema by what the command says, whatever its exit code', () => {
    expect(describeMergeFailure({ exitCode: 4, signal: null, report: null, stderrTail: 'the database has a newer schema (12) than this CLI (11)\n' }).code).toBe('newer-schema');
    expect(describeMergeFailure({ exitCode: 7, signal: null, report: { reason: 'schema is newer than supported' }, stderrTail: '' }).code).toBe('newer-schema');
    expect(describeMergeFailure({ exitCode: 3, signal: null, report: { code: 'newer-schema' }, stderrTail: 'refused' }).code).toBe('newer-schema');
    expect(describeMergeFailure({ exitCode: 3, signal: null, report: null, stderrTail: 'schema check failed' }).code).toBe('merge-failed');
    expect(describeMergeFailure({ exitCode: 1, signal: null, report: null, stderrTail: 'disk I/O error' })).toEqual({ code: 'merge-failed', message: 'updraft state merge exited 1: disk I/O error' });
    expect(describeMergeFailure({ exitCode: null, signal: 'SIGKILL', report: null, stderrTail: '' }).message).toBe('updraft state merge was killed by SIGKILL');
  });

  it('reads the schema version from a SQLite header and nothing from anything else', () => {
    expect(sqliteHeader(encodeStateDb(['a'], 7))).toEqual({ valid: true, schemaVersion: 7 });
    expect(sqliteHeader(Buffer.alloc(4096))).toEqual({ valid: false, schemaVersion: null });
    expect(sqliteHeader(Buffer.from('SQLite format 3\0'))).toEqual({ valid: false, schemaVersion: null });
    expect(sqliteHeader('SQLite format 3')).toEqual({ valid: false, schemaVersion: null });
  });

  it('refuses uploads that are too small, not SQLite, or a schema downgrade', () => {
    expect(refuseUpload(encodeStateDb(['a'], 3), 3)).toBeNull();
    expect(refuseUpload(encodeStateDb(['a'], 4), 3)).toBeNull();
    expect(refuseUpload(encodeStateDb(['a'], 3), undefined)).toBeNull();
    expect(refuseUpload(encodeStateDb(['a'], 3), 4)).toContain('older than');
    expect(refuseUpload(encodeStateDb(['a']).subarray(0, MIN_STATE_BYTES - 1), undefined)).toContain('only');
    expect(refuseUpload(Buffer.alloc(8192, 0x41), undefined)).toContain('not a SQLite database');
  });

  it('budgets state sync inside what is left of the microVM', () => {
    const payload = { launchedAt: new Date(START).toISOString(), maximumDurationSeconds: 3600 };
    const end = START + 3600_000;
    expect(stateSyncBudgetMs(payload, START + 60_000)).toBe(STATE_SYNC_MAX_MS);
    // The watchdog fired 600 s before the end: 20 s of kill grace later there are 580 s left.
    expect(stateSyncBudgetMs(payload, end - 580_000)).toBe(STATE_SYNC_MAX_MS);
    expect(stateSyncBudgetMs(payload, end - 200_000)).toBe(200_000 - REPORT_RESERVE_MS);
    expect(stateSyncBudgetMs(payload, end - 30_000)).toBe(0);
    expect(stateSyncBudgetMs(payload, START + 60_000, { terminating: true })).toBe(TERMINATING_SYNC_MS);
  });
});

// ------------------------------------------------------------------ through runJob

function request(overrides = {}) {
  return {
    microvmId: 'mvm-01234567-abcd-ef01-2345-6789abcdef01',
    payload: {
      version: 1,
      deliveryId: 'delivery-1',
      eventName: 'issues',
      region: 'eu-test-1',
      bucket: BUCKET,
      eventKey: 'events/delivery-1/event.json',
      resultKeyPrefix: 'results/delivery-1/',
      configPrefix: 'config/',
      secrets: { githubAppPrivateKey: KEY_ARN, agentEnv: ENV_ARN },
      maximumDurationSeconds: 14400,
      watchdogReserveSeconds: 600,
      launchedAt: new Date(START).toISOString(),
      stateKey: KEY,
      ...overrides,
    },
  };
}

function jobSetup(mode, { s3 = memoryS3(), rows = ['job-a'], control = {}, secrets = {}, deps: depsOverrides = {} } = {}) {
  const calls = [];
  const logs = [];
  const objects = {
    'events/delivery-1/event.json': '{"action":"labeled","issue":{"number":12}}',
    'config/config.yaml': 'version: 1\n',
    'config/prompts/implement-issue.md': '# Implement the issue\n',
    'config/fake-state-control.json': JSON.stringify({ record: stateRecord, ...control }),
  };
  const allSecrets = {
    [KEY_ARN]: PEM,
    [ENV_ARN]: JSON.stringify({
      ANTHROPIC_API_KEY: 'sk-ant-test-value',
      FAKE_UPDRAFT_MODE: mode,
      FAKE_UPDRAFT_RECORD: recordFile,
      ...(rows ? { FAKE_UPDRAFT_STATE_ROWS: JSON.stringify(rows) } : {}),
    }),
    ...secrets,
  };
  const stopListeners = [];
  const deps = {
    s3Get: async (bucket, key) => {
      calls.push(['s3Get', bucket, key]);
      if (!(key in objects)) throw new Error(`NoSuchKey: ${key}`);
      return Buffer.from(objects[key]);
    },
    s3List: async (bucket, prefix) =>
      Object.keys(objects)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, size: objects[key].length })),
    s3Put: async (bucket, key, body, contentType) => {
      calls.push(['s3Put', bucket, key, body, contentType]);
    },
    s3GetIfExists: async (...args) => {
      calls.push(['s3GetIfExists', args[0], args[1]]);
      return s3.s3GetIfExists(...args);
    },
    s3PutIf: async (...args) => {
      calls.push(['s3PutIf', args[0], args[1]]);
      return s3.s3PutIf(...args);
    },
    getSecret: async (id) => allSecrets[id],
    terminate: async (id) => {
      calls.push(['terminate', id]);
    },
    releaseDelivery: async (table, id) => {
      calls.push(['releaseDelivery', table, id]);
    },
    stateRoot: path.join(root, 'state'),
    updraftCommand: [process.execPath, FAKE_UPDRAFT],
    jobUser: { home: path.join(root, 'home'), name: 'updraft' },
    baseEnv: { PATH: process.env.PATH, AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE', AWS_SECRET_ACCESS_KEY: 'runner-secret-key', AWS_SESSION_TOKEN: 'runner-session-token' },
    log: (message) => logs.push(message),
    logStream: { write: () => {} },
    onStop: (listener) => stopListeners.push(listener),
    now: () => START + 1000,
    killGraceMs: 300,
    retryDelayMs: 1,
    ...depsOverrides,
  };
  const document = () => JSON.parse(calls.find(([name, , key]) => name === 's3Put' && key.endsWith('.json'))[3]);
  return { deps, calls, logs, s3, document, stop: () => stopListeners.forEach((listener) => listener()) };
}

const names = (calls) => calls.map(([name]) => name);

describe.runIf(onLinuxLikeHost)('runJob with shared state', () => {
  it('starts from nothing on the first run and creates the shared database', async () => {
    const { deps, calls, s3, document } = jobSetup('success');
    const result = await runJob(request(), deps);

    expect(result.outcome).toBe('succeeded');
    expect(result.state).toMatchObject({
      key: KEY,
      snapshot: { found: false, bytes: null, etag: null, schemaVersion: null },
      sync: { attempted: true, saved: true, changed: true, attempts: 1, notSavedReason: null, schemaVersion: 3 },
    });
    expect(document().state).toEqual(result.state);
    expect(s3.rows()).toEqual(['job-a']);
    expect(merges()[0].args).not.toContain('--base');
    // State is synced after the job and before the result is written and the microVM terminated.
    const order = names(calls);
    expect(order.indexOf('s3PutIf')).toBeGreaterThan(order.indexOf('s3GetIfExists'));
    expect(order.indexOf('s3PutIf')).toBeLessThan(order.lastIndexOf('s3Put'));
    expect(order.at(-1)).toBe('terminate');
  });

  it('gives the job the snapshot, keeps a pristine base out of its reach, and saves what the job added', async () => {
    const s3 = memoryS3(encodeStateDb(['old-1', 'old-2'], 3));
    const { deps, document } = jobSetup('success', { s3 });
    const result = await runJob(request(), deps);

    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const stateDir = record.env.UPDRAFT_HOME;
    // The run found the history in its own state directory, as a file only it can read.
    expect(decodeStateDb(fs.readFileSync(path.join(stateDir, 'state.db'))).rows).toEqual(['job-a', 'old-1', 'old-2']);
    expect(fs.statSync(path.join(stateDir, 'state.db')).mode & 0o777).toBe(0o600);

    expect(result.state.snapshot).toEqual({ found: true, bytes: 4096, etag: expect.stringMatching(/^"[0-9a-f]{32}"$/), schemaVersion: 3 });
    expect(result.state.sync).toMatchObject({ saved: true, changed: true, attempts: 1, uploadedBytes: 4096 });
    expect(result.state.sync.merge).toMatchObject({ changed: true, tables: { rows: { inserted: 1 } } });
    expect(document().state.sync.info).toEqual({ schemaVersion: 3, tables: { rows: 3 } });
    expect(s3.rows()).toEqual(['job-a', 'old-1', 'old-2']);

    // The base the merge got is the snapshot as downloaded, not the file the job wrote to;
    // the pristine copy lives in a directory of the runner's own, mode 0700.
    const [merge] = merges();
    expect(merge.baseRows).toEqual(['old-1', 'old-2']);
    expect(merge.changedRows).toEqual(['job-a', 'old-1', 'old-2']);
    const baseDirs = fs.readdirSync(deps.stateRoot).filter((name) => name.startsWith('base-'));
    expect(baseDirs).toHaveLength(1);
    expect(fs.statSync(path.join(deps.stateRoot, baseDirs[0])).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(deps.stateRoot, baseDirs[0], 'state.db')).mode & 0o777).toBe(0o600);
    expect(path.dirname(merge.args[7])).not.toBe(path.join(deps.stateRoot, baseDirs[0]));
  });

  it('saves state after a failed job too, and releases the delivery only because the job failed', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { deps, calls } = jobSetup('fail', { s3, rows: ['cooldown'] });
    const result = await runJob(request({ dedupeTable: 'deliveries' }), deps);
    expect(result.outcome).toBe('failed');
    expect(result.state.sync).toMatchObject({ saved: true });
    expect(s3.rows()).toEqual(['cooldown', 'old']);
    expect(names(calls)).toContain('releaseDelivery');
  });

  it('keeps a successful job successful when state cannot be saved, loudly, and keeps the delivery record', async () => {
    for (const control of [{ merge: 'fail' }, { merge: 'newer-schema' }]) {
      const s3 = memoryS3(encodeStateDb(['old']));
      const { deps, calls, logs, document } = jobSetup('success', { s3, control });
      const result = await runJob(request({ dedupeTable: 'deliveries' }), deps);
      expect(result.outcome).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeNull();
      expect(result.state.sync).toMatchObject({ attempted: true, saved: false });
      expect(result.state.sync.notSavedCode).toBe(control.merge === 'fail' ? 'merge-failed' : 'newer-schema');
      expect(document().state.sync.notSavedReason).toEqual(expect.any(String));
      expect(logs.some((line) => line.startsWith('STATE NOT SAVED'))).toBe(true);
      expect(logs.find((line) => line.startsWith('RESULT '))).toContain('notSavedReason');
      expect(names(calls)).not.toContain('s3PutIf');
      expect(names(calls)).not.toContain('releaseDelivery');
      expect(names(calls).at(-1)).toBe('terminate');
      expect(s3.versions).toHaveLength(1);
      fs.rmSync(stateRecord, { force: true });
    }
  });

  it('does not sync when the job never started', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { deps, calls } = jobSetup('success', { s3, secrets: { [ENV_ARN]: '' } });
    const result = await runJob(request(), deps);
    expect(result.outcome).toBe('runner_error');
    expect(result.state).toMatchObject({ snapshot: { found: true }, sync: { attempted: false, saved: false, notSavedCode: 'job-not-started' } });
    expect(names(calls).filter((name) => name === 's3GetIfExists')).toHaveLength(1);
    expect(names(calls)).not.toContain('s3PutIf');
    expect(merges()).toEqual([]);
  });

  it('does not start an agent on a snapshot that is not a database', async () => {
    const s3 = memoryS3(Buffer.alloc(8192, 0x41));
    const { deps, calls } = jobSetup('success', { s3 });
    const result = await runJob(request(), deps);
    expect(result.outcome).toBe('runner_error');
    expect(result.error).toContain('not a SQLite database');
    expect(fs.existsSync(recordFile)).toBe(false);
    expect(names(calls)).not.toContain('s3PutIf');
    expect(names(calls).at(-1)).toBe('terminate');
  });

  it('still reports and terminates when state sync hangs', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { deps, calls } = jobSetup('success', { s3, control: { merge: 'hang' }, deps: { stateSyncBudgetMs: 400 } });
    const started = Date.now();
    const result = await runJob(request(), deps);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(result.outcome).toBe('succeeded');
    expect(result.state.sync).toMatchObject({ saved: false, notSavedCode: 'timed-out' });
    expect(names(calls).slice(-2)).toEqual(['s3Put', 'terminate']);
  });

  it('syncs what a run stopped by the watchdog left behind', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { deps } = jobSetup('hang', { s3, rows: ['half-done'] });
    const result = await runJob(request({ maximumDurationSeconds: 1200, watchdogReserveSeconds: 600, launchedAt: new Date(START - 598_500).toISOString() }), { ...deps, deadlineMinutes: 1 });
    expect(result.outcome).toBe('timed_out');
    expect(result.state.sync).toMatchObject({ saved: true });
    expect(s3.rows()).toEqual(['half-done', 'old']);
  });

  it('leaves state alone when the launcher sent no stateKey', async () => {
    const s3 = memoryS3(encodeStateDb(['old']));
    const { deps, calls } = jobSetup('success', { s3 });
    const result = await runJob(request({ stateKey: undefined }), deps);
    expect(result.outcome).toBe('succeeded');
    expect(result.state).toBeNull();
    expect(names(calls)).not.toContain('s3GetIfExists');
    expect(s3.versions).toHaveLength(1);
  });

  it('refuses config objects that would land on the state database', async () => {
    const { deps } = jobSetup('success');
    const list = deps.s3List;
    deps.s3List = async (...args) => [...(await list(...args)), { key: 'config/state.db', size: 1 }];
    const result = await runJob(request(), deps);
    expect(result.outcome).toBe('runner_error');
    expect(result.error).toContain('reserved by the runner');
  });

  it('waits for the launcher\'s coalescing window before it starts the job', async () => {
    const { deps, logs } = jobSetup('success');
    const before = Date.now();
    await runJob(request({ eventName: 'pull_request_review', notBefore: new Date(START + 1000 + 700).toISOString() }), deps);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(record.time - before).toBeGreaterThanOrEqual(650);
    expect(record.args.slice(0, 5)).toEqual(['run-event', '--event-file', expect.any(String), '--event-name', 'pull_request_review']);
    expect(logs.some((line) => line.includes('coalescing window'))).toBe(true);

    // A time already past costs nothing.
    const quick = jobSetup('success');
    const start = Date.now();
    await runJob(request({ notBefore: new Date(START - 5000).toISOString() }), quick.deps);
    expect(quick.logs.some((line) => line.includes('coalescing window'))).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
