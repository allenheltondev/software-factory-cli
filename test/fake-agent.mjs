#!/usr/bin/env node
// Test-only stand-in for a coding-agent CLI, driven by the fake adapter (test/fake-adapter.ts).
// Never used at runtime.
//
//   node fake-agent.mjs --mode <mode> [--prompt-file <path>] [--received <path>] [--pids-file <path>]
//
// The prompt comes from --prompt-file, or stdin when that is absent. --received copies the
// prompt it got to a file so tests can compare it with the rendered prompt.
//
// Modes:
//   success   write FAKE_AGENT.md in the working directory and commit it; exit 0
//   fail      write partial.txt (uncommitted) and modify README.md; exit 3
//   hang      start a child process, write both pids to --pids-file, and wait forever
//   stubborn  like hang, but both processes ignore SIGTERM and SIGINT (POSIX escalation to SIGKILL)
//   orphan    start a child process, write both pids to --pids-file, and exit 0 leaving the child
//   env       print selected environment variables; exit 0
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = opt('--mode') ?? 'success';
const promptFile = opt('--prompt-file');
const prompt = promptFile ? readFileSync(promptFile, 'utf8') : readFileSync(0, 'utf8');
const received = opt('--received');
if (received) writeFileSync(received, prompt);

const say = (line) => process.stdout.write(`${line}\n`);
say(`fake agent: mode ${mode} in ${process.cwd()}`);
say(`fake agent: prompt has ${prompt.length} characters`);

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function startChild(stubborn, then) {
  const childCode = stubborn
    ? "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"
    : 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore', windowsHide: true });
  const pidsFile = opt('--pids-file');
  child.once('spawn', () => {
    if (pidsFile) writeFileSync(pidsFile, JSON.stringify({ agent: process.pid, child: child.pid }));
    say(`fake agent: working (pid ${process.pid}, child ${child.pid})`);
    then?.(child);
  });
}

function hang(stubborn) {
  if (stubborn) {
    process.on('SIGTERM', () => say('fake agent: ignoring SIGTERM'));
    process.on('SIGINT', () => say('fake agent: ignoring SIGINT'));
  }
  startChild(stubborn);
  setInterval(() => {}, 1000);
}

switch (mode) {
  case 'success': {
    writeFileSync('FAKE_AGENT.md', `# Done\n\n${prompt.split('\n')[0]}\n`);
    git('add', 'FAKE_AGENT.md');
    git('commit', '--quiet', '-m', 'fake agent: implement the issue');
    say(`fake agent: committed ${git('rev-parse', '--short', 'HEAD')}`);
    say('fake agent: all done');
    process.exit(0);
    break;
  }
  case 'fail': {
    writeFileSync('partial.txt', 'half-finished work\n');
    writeFileSync('README.md', '# widgets\n\nedited by the fake agent\n');
    process.stderr.write('fake agent: could not finish; giving up\n');
    process.exit(3);
    break;
  }
  case 'hang':
    hang(false);
    break;
  case 'stubborn':
    hang(true);
    break;
  case 'orphan':
    startChild(false, (child) => {
      child.unref();
      say('fake agent: done, leaving a background process');
      process.exit(0);
    });
    break;
  case 'env':
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'FAKE_ADAPTER_ENV', 'FAKE_CONFIG_ENV']) say(`env ${k}=${process.env[k] ?? '(unset)'}`);
    process.exit(0);
    break;
  default:
    process.stderr.write(`fake agent: unknown mode ${mode}\n`);
    process.exit(64);
}
