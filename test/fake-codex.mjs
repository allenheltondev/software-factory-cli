#!/usr/bin/env node
// Test-only stand-in for `codex exec --json`, run by the real Codex adapter in live tests.
// Never used at runtime.
//
// It reads the prompt from stdin (as `codex exec` does with no prompt argument) and then:
//   FAKE_CODEX_RECORD  path: write {argv, prompt} as JSON there
//   FAKE_CODEX_COMMIT  "1": write CODEX_WAS_HERE.md in the working directory and commit it
//   FAKE_CODEX_EDIT    "1": write half-done.txt (uncommitted)
//   FAKE_CODEX_EVENTS  path: a JSON array of events to print, one JSON object per line
//   FAKE_CODEX_STDERR  text to write to stderr after the events
//   FAKE_CODEX_EXIT    exit code (default 0)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] !== 'exec') {
  process.stderr.write('fake codex: expected the exec subcommand\n');
  process.exit(2);
}
const prompt = readFileSync(0, 'utf8');
const env = process.env;
if (env.FAKE_CODEX_RECORD) writeFileSync(env.FAKE_CODEX_RECORD, JSON.stringify({ argv, prompt }));
if (env.FAKE_CODEX_COMMIT === '1') {
  writeFileSync('CODEX_WAS_HERE.md', '# Art\n');
  execFileSync('git', ['add', 'CODEX_WAS_HERE.md'], { stdio: 'ignore' });
  execFileSync('git', ['commit', '--quiet', '-m', 'Add the dragon art page (#7)'], { stdio: 'ignore' });
}
if (env.FAKE_CODEX_EDIT === '1') writeFileSync('half-done.txt', 'partial\n');
const events = env.FAKE_CODEX_EVENTS ? JSON.parse(readFileSync(env.FAKE_CODEX_EVENTS, 'utf8')) : [];
for (const e of events) process.stdout.write(`${JSON.stringify(e)}\n`);
if (env.FAKE_CODEX_STDERR) process.stderr.write(`${env.FAKE_CODEX_STDERR}\n`);
process.exit(Number(env.FAKE_CODEX_EXIT ?? 0));
