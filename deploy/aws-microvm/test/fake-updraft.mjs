// Stand-in for the `updraft` CLI, used by runner-job.test.mjs and runner-state.test.mjs.
//
//   run-event     FAKE_UPDRAFT_MODE picks the behaviour; FAKE_UPDRAFT_RECORD names a file that
//                 receives what the process was given; FAKE_UPDRAFT_STATE_ROWS (a JSON array
//                 of strings) are "rows" the run adds to $UPDRAFT_HOME/state.db.
//   state merge   a deterministic three-way merge of fake-state-db.mjs files (--live is
//                 recorded and otherwise the same merge)
//   state info    schema version and row count of such a file
//   state copy    a copy of such a file
//   validate      with --json: prints $UPDRAFT_HOME/fake-validate.json when there is one (a
//                 test writes the report it wants the runner to see), else a valid report
//                 whose config has one agent contained by the sandbox runtime
//
// The state commands get an environment built from nothing, so the test cannot steer them
// through variables. They read $UPDRAFT_HOME/fake-state-control.json instead (a test puts it
// there as a config object): { "record": <file to append one JSON line per call to>,
// "merge": ok | fail | newer-schema | hang | garbage | tiny | no-json | wal, "info": ok | fail,
// "copy": ok | fail, "failFinalMerge": true (a merge without --live fails; checkpoints work) }.
/* global fetch */
import fs from 'node:fs';
import path from 'node:path';
import { decodeStateDb, encodeStateDb } from './fake-state-db.mjs';

const mode = process.env.FAKE_UPDRAFT_MODE ?? 'success';
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const home = process.env.UPDRAFT_HOME ?? '';
/** The schema version this "CLI" supports; a database with a higher one is refused. */
const SCHEMA_VERSION = 3;

if (args[0] === 'validate') {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(home, 'fake-validate.json'), 'utf8'));
  } catch {
    report = {
      ok: true,
      path: path.join(home, 'config.yaml'),
      state: 'ok',
      errors: [],
      warnings: [],
      config: { agents: { claude: { enabled: true, container: { image: 'microvm', runtime: '/opt/updraft/bin/updraft-sandbox', env: ['ANTHROPIC_API_KEY'] } } } },
    };
  }
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}

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
  // A v2 job (Updraft Cloud) has a token file instead of the key.
  const tokenPath = path.join(home, 'app-token.json');
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
      keyMode: fs.existsSync(keyPath) ? fs.statSync(keyPath).mode & 0o777 : null,
      token: fs.existsSync(tokenPath) ? JSON.parse(fs.readFileSync(tokenPath, 'utf8')) : null,
      tokenMode: fs.existsSync(tokenPath) ? fs.statSync(tokenPath).mode & 0o777 : null,
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
  case 'telemetry': {
    // An agent run as the real CLI logs it ($UPDRAFT_HOME/logs/runs/<run>/run.log): the worker's
    // header, Claude Code's stream-json written as it goes, the end marker. The agent echoes
    // the tenant's key, which must never reach the telemetry.
    const dir = path.join(home, 'logs', 'runs', 'run_t1');
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'run.log');
    const head = ['updraft run run_t1', 'job: job_t1 (attempt 1)', 'repository: o/r (id 1)', 'issue: #7 A title', 'agent: claude (adapter claude)', '---- agent output (stdout and stderr) ----'];
    const lines = [
      { type: 'assistant', message: { id: 'm1', model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${process.env.ANTHROPIC_API_KEY}` } }], usage: { input_tokens: 5, output_tokens: 2 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2 },
    ].map((e) => JSON.stringify(e));
    fs.writeFileSync(log, `${head.join('\n')}\n`);
    const pauseMs = Number(process.env.FAKE_UPDRAFT_SLOW_MS ?? 150);
    const step = () => {
      if (!lines.length) {
        fs.appendFileSync(log, '---- end of agent output ----\noutcome: succeeded\n');
        console.log(JSON.stringify({ outcome: 'succeeded', prUrl: 'https://github.com/o/r/pull/7', logPath: log, exitCode: 0 }));
        return;
      }
      fs.appendFileSync(log, `${lines.shift()}\n`);
      setTimeout(step, pauseMs);
    };
    setTimeout(step, pauseMs);
    break;
  }
  case 'telemetry-relay': {
    // A Claude Code run that also exports its own log events where its environment says
    // (the runner's relay), as Claude Code does with CLAUDE_CODE_ENABLE_TELEMETRY.
    const dir = path.join(home, 'logs', 'runs', 'run_r1');
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'run.log');
    const head = ['updraft run run_r1', 'job: job_r1 (attempt 1)', 'repository: o/r (id 1)', 'issue: #8 A title', 'agent: claude (adapter claude)', '---- agent output (stdout and stderr) ----'];
    fs.writeFileSync(log, `${head.join('\n')}\n${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-relay', model: 'claude-x' })}\n`);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } });
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [attr('service.name', 'claude-code')] },
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: `${BigInt(Date.now()) * 1000000n}`, body: { stringValue: 'claude_code.api_error' }, attributes: [attr('event.name', 'api_error'), attr('session.id', 'sess-relay'), attr('status_code', 529), attr('attempt', 2), attr('duration_ms', 40), attr('error', 'overloaded')] },
                { timeUnixNano: `${BigInt(Date.now()) * 1000000n}`, body: { stringValue: 'claude_code.api_request' }, attributes: [attr('event.name', 'api_request'), attr('session.id', 'sess-relay'), attr('model', 'claude-x'), attr('duration_ms', 900), attr('input_tokens', 5)] },
              ],
            },
          ],
        },
      ],
    };
    const post = endpoint
      ? fetch(`${endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
      : Promise.resolve();
    post.then(() => {
      fs.appendFileSync(log, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1 })}\n---- end of agent output ----\noutcome: succeeded\n`);
      console.log(JSON.stringify({ outcome: 'succeeded', logPath: log, exitCode: 0 }));
    });
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
  case 'leak': {
    // Prints the agent keys everywhere the runner forwards or keeps output (#70): stdout, stderr
    // (split across two writes), its own log, the run log, the summary's message.
    const secret = process.env.ANTHROPIC_API_KEY ?? '';
    const custom = process.env.CUSTOM_TOKEN ?? '';
    console.log(`provider said: invalid x-api-key ${secret}`);
    process.stderr.write(`error with ${secret.slice(0, 5)}`);
    process.stderr.write(`${secret.slice(5)} and ${custom}\n`);
    const logPath = writeLogs();
    fs.appendFileSync(path.join(home, 'logs', 'updraft.log'), `key ${secret}\n`);
    fs.appendFileSync(logPath, `token ${custom}\n`);
    console.log(JSON.stringify({ outcome: 'failed', message: `rejected ${secret}`, logPath, exitCode: 1 }));
    process.exitCode = 1;
    break;
  }
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
    // Stops when asked to. Says so only once the handler is in place, so that a test can
    // wait for it before it sends the signal.
    process.on('SIGTERM', () => {
      console.error('fake-updraft: interrupted');
      console.log(JSON.stringify(interrupted));
      process.exit(1);
    });
    console.error('fake-updraft: waiting for SIGTERM');
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
