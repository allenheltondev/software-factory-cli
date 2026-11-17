#!/usr/bin/env node
// Test-only stand-in for `claude -p --output-format stream-json`, run by the real Claude Code
// adapter in live tests. Never used at runtime.
//
// It reads the prompt from stdin (as `claude -p` does with no prompt argument) and then:
//   FAKE_CLAUDE_RECORD  path: write {argv, prompt} as JSON there
//   FAKE_CLAUDE_COMMIT  "1": write CLAUDE_WAS_HERE.md in the working directory and commit it
//   FAKE_CLAUDE_EDIT    "1": write half-done.txt (uncommitted)
//   FAKE_CLAUDE_EVENTS  path: a JSON array of events to print, one JSON object per line
//   FAKE_CLAUDE_EXIT    exit code (default 0)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (!argv.includes('-p')) {
  process.stderr.write('fake claude: expected -p\n');
  process.exit(2);
}
const prompt = readFileSync(0, 'utf8');
const env = process.env;
if (env.FAKE_CLAUDE_RECORD) writeFileSync(env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, prompt }));
if (env.FAKE_CLAUDE_COMMIT === '1') {
  writeFileSync('CLAUDE_WAS_HERE.md', '# Roster\n');
  execFileSync('git', ['add', 'CLAUDE_WAS_HERE.md'], { stdio: 'ignore' });
  execFileSync('git', ['commit', '--quiet', '-m', 'Add the roster page (#7)'], { stdio: 'ignore' });
}
if (env.FAKE_CLAUDE_EDIT === '1') writeFileSync('half-done.txt', 'partial\n');
const events = env.FAKE_CLAUDE_EVENTS ? JSON.parse(readFileSync(env.FAKE_CLAUDE_EVENTS, 'utf8')) : [];
for (const e of events) process.stdout.write(`${JSON.stringify(e)}\n`);
process.exit(Number(env.FAKE_CLAUDE_EXIT ?? 0));
