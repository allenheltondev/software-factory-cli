// Stand-in for `updraft run-event`, used by runner-job.test.mjs. FAKE_UPDRAFT_MODE picks the
// behaviour; FAKE_UPDRAFT_RECORD names a file that receives what the process was given.
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_UPDRAFT_MODE ?? 'success';
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const home = process.env.UPDRAFT_HOME ?? '';

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

switch (mode) {
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
