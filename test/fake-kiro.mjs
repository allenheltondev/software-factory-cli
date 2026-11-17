#!/usr/bin/env node
// Test-only stand-in for `kiro-cli chat --no-interactive`, run by the real Kiro adapter in live
// tests. Never used at runtime.
//
// It reads the instruction from stdin (as `kiro-cli chat --no-interactive` does with no
// positional argument) and then:
//   FAKE_KIRO_RECORD  path: write {argv, prompt, hasApiKey} as JSON there
//   FAKE_KIRO_COMMIT  "1": write KIRO_WAS_HERE.md in the working directory and commit it
//   FAKE_KIRO_STDOUT  text to print on stdout (the response)
//   FAKE_KIRO_STDERR  text to write to stderr after it
//   FAKE_KIRO_EXIT    exit code (default 0)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] !== 'chat' || !argv.includes('--no-interactive')) {
  process.stderr.write('fake kiro-cli: expected chat --no-interactive\n');
  process.exit(2);
}
const prompt = readFileSync(0, 'utf8');
const env = process.env;
if (env.FAKE_KIRO_RECORD) writeFileSync(env.FAKE_KIRO_RECORD, JSON.stringify({ argv, prompt, hasApiKey: Boolean(env.KIRO_API_KEY) }));
if (env.FAKE_KIRO_COMMIT === '1') {
  writeFileSync('KIRO_WAS_HERE.md', '# Roster\n');
  execFileSync('git', ['add', 'KIRO_WAS_HERE.md'], { stdio: 'ignore' });
  execFileSync('git', ['commit', '--quiet', '-m', 'Add the roster page with Kiro'], { stdio: 'ignore' });
}
if (env.FAKE_KIRO_STDOUT) process.stdout.write(`${env.FAKE_KIRO_STDOUT}\n`);
if (env.FAKE_KIRO_STDERR) process.stderr.write(`${env.FAKE_KIRO_STDERR}\n`);
process.exit(Number(env.FAKE_KIRO_EXIT ?? 0));
