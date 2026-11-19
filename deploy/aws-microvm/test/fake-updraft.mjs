// Stand-in for the `updraft` CLI, used by runner-job.test.mjs and runner-state.test.mjs.
//
//   run-event     FAKE_UPDRAFT_MODE picks the behaviour; FAKE_UPDRAFT_RECORD names a file that
//                 receives what the process was given; FAKE_UPDRAFT_STATE_ROWS (a JSON array
//                 of strings) are "rows" the run adds to $UPDRAFT_HOME/state.db.
//   state merge   a deterministic three-way merge of fake-state-db.mjs files (--live is
//                 recorded and otherwise the same merge)
//   state info    schema version and row count of such a file
//   state copy    a copy of such a file
//
// The state commands get an environment built from nothing, so the test cannot steer them
// through variables. They read $UPDRAFT_HOME/fake-state-control.json instead (a test puts it
// there as a config object): { "record": <file to append one JSON line per call to>,
// "merge": ok | fail | newer-schema | hang | garbage | tiny | no-json | wal, "info": ok | fail,
// "copy": ok | fail, "failFinalMerge": true (a merge without --live fails; checkpoints work) }.
import fs from 'node:fs';
import path from 'node:path';
import { decodeStateDb, encodeStateDb } from './fake-state-db.mjs';

const mode = process.env.FAKE_UPDRAFT_MODE ?? 'success';
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const home = process.env.UPDRAFT_HOME ?? '';
/** The schema version this "CLI" supports; a database with a higher one is refused. */
const SCHEMA_VERSION = 3;

if (args[0] === 'state') {
  let control = {};
  try {
    control = JSON.parse(fs.readFileSync(path.join(home, 'fake-state-control.json'), 'utf8'));
  } catch {
    // No control file: default behaviour, nothing recorded.
  }
  const read = (file) => (file !== undefined && fs.existsSync(file) ? decodeStateDb(fs.readFileSync(file)) : undefined);
  const record = (extra) => {
    if (!control.record) return;
    fs.appendFileSync(control.record, `${JSON.stringify({ command: args[1], args, env: process.env, uid: process.getuid?.(), ...extra })}\n`);
  };

  if (args[1] === 'merge') {
    const intoFile = option('--into');
    const changed = read(option('--changed'));
    const base = read(option('--base'));
    const into = read(intoFile);
    const live = args.includes('--live');
    record({ live, changedRows: changed?.rows, baseRows: base?.rows ?? null, intoRows: into?.rows ?? null, intoExisted: into !== undefined });
    switch (control.failFinalMerge && !live ? 'fail' : (control.merge ?? 'ok')) {
      case 'fail':
        console.error('fake-updraft: database disk image is malformed');
        process.exit(1);
        break;
      case 'hang':
        setInterval(() => {}, 1000);
        break;
      case 'garbage':
        fs.writeFileSync(intoFile, Buffer.alloc(8192, 0x41));
        console.log(JSON.stringify({ changed: true }));
        break;
      case 'tiny':
        fs.writeFileSync(intoFile, encodeStateDb(['x']).subarray(0, 512));
        console.log(JSON.stringify({ changed: true }));
        break;
      case 'no-json':
        fs.writeFileSync(intoFile, encodeStateDb(changed.rows));
        console.log('merged');
        break;
      default: {
        if ((control.merge === 'newer-schema') || (into && into.schemaVersion > SCHEMA_VERSION)) {
          console.error(`fake-updraft: the shared database has a newer schema (${into?.schemaVersion ?? 9}) than this CLI supports (${SCHEMA_VERSION})`);
          console.log(JSON.stringify({ changed: false, error: 'newer schema than this CLI supports' }));
          process.exit(4);
        }
        // Three-way, rows only ever added: what the run added on top of its base goes into
        // the latest database.
        const added = changed.rows.filter((row) => !(base?.rows ?? []).includes(row));
        const merged = [...new Set([...(into?.rows ?? []), ...added])];
        const isChange = into === undefined || merged.length !== into.rows.length;
        if (isChange) fs.writeFileSync(intoFile, encodeStateDb(merged, SCHEMA_VERSION));
        if (control.merge === 'wal') fs.writeFileSync(`${intoFile}-wal`, 'pending frames');
        // An unknown field on purpose: the runner must tolerate what it has never heard of.
        console.log(JSON.stringify({ changed: isChange, tables: { rows: { inserted: isChange ? added.length : 0 } }, somethingNew: true }));
      }
    }
  } else if (args[1] === 'info') {
    record({});
    try {
      if (control.info === 'fail') throw new Error('refused by the test');
      const db = decodeStateDb(fs.readFileSync(option('--db')));
      console.log(JSON.stringify({ schemaVersion: db.schemaVersion, tables: { rows: db.rows.length } }));
    } catch (error) {
      console.error(`fake-updraft: ${error.message}`);
      process.exit(1);
    }
  } else if (args[1] === 'copy') {
    record({});
    if (control.copy === 'fail') {
      console.error('fake-updraft: database disk image is malformed');
      process.exit(1);
    }
    fs.writeFileSync(option('--out'), fs.readFileSync(option('--db')), { flag: 'wx' });
    console.log(JSON.stringify({ ok: true, out: option('--out') }));
  } else {
    console.error(`fake-updraft: unknown state command ${args[1]}`);
    process.exit(64);
  }
} else {
  runEvent();
}

function runEvent() {
if (process.env.FAKE_UPDRAFT_STATE_ROWS) {
  // What a run does to its state database: open the one in $UPDRAFT_HOME (the snapshot the
  // runner put there, or none) and add to it.
  const file = path.join(home, 'state.db');
  const existing = fs.existsSync(file) ? decodeStateDb(fs.readFileSync(file)).rows : [];
  fs.writeFileSync(file, encodeStateDb([...existing, ...JSON.parse(process.env.FAKE_UPDRAFT_STATE_ROWS)], SCHEMA_VERSION));
}

if (process.env.FAKE_UPDRAFT_RECORD) {
  const keyPath = path.join(home, 'github-app.pem');
  fs.writeFileSync(
    process.env.FAKE_UPDRAFT_RECORD,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      env: process.env,
      event: fs.readFileSync(option('--event-file'), 'utf8'),
      config: fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'),
      prompt: fs.readFileSync(path.join(home, 'prompts', 'implement-issue.md'), 'utf8'),
      time: Date.now(),
      keyMode: fs.statSync(keyPath).mode & 0o777,
      stateDirMode: fs.statSync(home).mode & 0o777,
    }),
  );
}

const interrupted = { outcome: 'failed', drain: 'stopped', exitCode: 1 };
// What the real command leaves behind: its own log, and a run log named by the summary.
const writeLogs = () => {
  // Where the real CLI writes it: $UPDRAFT_HOME/logs/updraft.log.
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'updraft.log'), 'updraft.log contents\n');
  fs.mkdirSync(path.join(home, 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runs', 'r1', 'run.log'), 'agent transcript\n');
  return path.join(home, 'runs', 'r1', 'run.log');
};

console.error('fake-updraft: starting');
console.log('progress line that is not the summary');

/** Adds a row to the run's database the way SQLite would: readers see the old file or the new one. */
const addRow = (row) => {
  const file = path.join(home, 'state.db');
  const rows = fs.existsSync(file) ? decodeStateDb(fs.readFileSync(file)).rows : [];
  fs.writeFileSync(`${file}.tmp`, encodeStateDb([...rows, row], SCHEMA_VERSION));
  fs.renameSync(`${file}.tmp`, file);
};

switch (mode) {
  case 'slow-state': {
    // A run that records things as it goes: one row now, one later, then it ends.
    const rows = JSON.parse(process.env.FAKE_UPDRAFT_SLOW_ROWS ?? '[]');
    const pauseMs = Number(process.env.FAKE_UPDRAFT_SLOW_MS ?? 400);
    const logPath = writeLogs();
    const step = () => {
      if (rows.length === 0) {
        console.log(JSON.stringify({ outcome: 'succeeded', logPath, exitCode: 0 }));
        return;
      }
      addRow(rows.shift());
      setTimeout(step, pauseMs);
    };
    step();
    break;
  }
  case 'state-pending': {
    // A pull request event: its pull request is known once the shared state has the row "pr-known".
    const file = path.join(home, 'state.db');
    const known = fs.existsSync(file) && decodeStateDb(fs.readFileSync(file)).rows.includes('pr-known');
    if (process.env.FAKE_UPDRAFT_TRIES) fs.appendFileSync(process.env.FAKE_UPDRAFT_TRIES, `${known ? 'known' : 'pending'}\n`);
    if (known) {
      addRow('revision-1');
      console.log(JSON.stringify({ outcome: 'succeeded', logPath: writeLogs(), exitCode: 0 }));
    } else {
      console.log(JSON.stringify({ outcome: 'state-pending', reason: 'state-pending', exitCode: 6 }));
      process.exitCode = 6;
    }
    break;
  }
  case 'success':
    console.log(JSON.stringify({ outcome: 'succeeded', prUrl: 'https://github.com/o/r/pull/7', logPath: writeLogs(), exitCode: 0 }));
    break;
  case 'log-outside':
    writeLogs();
    console.log(JSON.stringify({ outcome: 'succeeded', logPath: process.env.FAKE_OUTSIDE_FILE, exitCode: 0 }));
    break;
  case 'log-symlink':
    writeLogs();
    fs.symlinkSync(process.env.FAKE_OUTSIDE_FILE, path.join(home, 'link.log'));
    console.log(JSON.stringify({ outcome: 'succeeded', logPath: path.join(home, 'link.log'), exitCode: 0 }));
    break;
  case 'fail':
    console.error('fake-updraft: verification failed');
    console.log(JSON.stringify({ outcome: 'failed', message: 'verify command failed', exitCode: 1 }));
    process.exitCode = 1;
    break;
  case 'no-summary':
    console.log('done, but this is not JSON');
    break;
  case 'silent':
    break;
  case 'hang':
    // Stops when asked to.
    process.on('SIGTERM', () => {
      console.error('fake-updraft: interrupted');
      console.log(JSON.stringify(interrupted));
      process.exit(1);
    });
    setInterval(() => {}, 1000);
    break;
  case 'hang-ignoring-sigterm':
    process.on('SIGTERM', () => console.error('fake-updraft: ignoring SIGTERM'));
    setInterval(() => {}, 1000);
    break;
  default:
    console.error(`fake-updraft: unknown mode ${mode}`);
    process.exitCode = 64;
}
}
