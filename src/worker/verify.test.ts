import { describe, expect, it } from 'vitest';
import type { RunSummary, VerificationSummary } from '../types.js';
import { renderPrBody } from '../publish/publish.js';
import { renderSummary } from './run-summary.js';
import { displayVerifyCommand, verificationLines, verificationNotes, verifyInvocation } from './verify.js';

const passed: VerificationSummary = {
  passed: true,
  commands: [
    { command: 'npm ci', status: 'passed', exitCode: 0, seconds: 12 },
    { command: 'npm test', status: 'passed', exitCode: 0, seconds: 42 },
  ],
  uncommittedBefore: 0,
  uncommittedAfter: 0,
};

const summary: RunSummary = {
  branch: 'updraft/issue-7-job_x',
  baseSha: 'abc1234abc1234',
  worktree: '/w',
  commits: ['abc1234 add the widget'],
  commitCount: 1,
  filesChanged: 1,
  diffStat: '1 file changed',
  untracked: 0,
  lastOutput: ['done'],
  notes: [],
};

describe('verifyInvocation', () => {
  it('hands a string to sh -c on POSIX', () => {
    expect(verifyInvocation('npm ci && npm test', 'linux')).toEqual({ file: '/bin/sh', args: ['-c', 'npm ci && npm test'], verbatim: false });
    expect(verifyInvocation('npm test', 'darwin').file).toBe('/bin/sh');
  });

  it('hands a string to cmd.exe /d /s /c on Windows, quoted once and passed verbatim', () => {
    expect(verifyInvocation('"C:\\Program Files\\nodejs\\node.exe" -e "process.exit(0)"', 'win32', { SystemRoot: 'C:\\Windows' })).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\node.exe" -e "process.exit(0)""'],
      verbatim: true,
    });
    // ComSpec is not consulted; without SystemRoot the name is left to the OS lookup.
    expect(verifyInvocation('npm test', 'win32', { ComSpec: 'C:\\evil\\cmd.exe' }).file).toBe('cmd.exe');
  });

  it('runs an argv command directly on every OS', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(verifyInvocation(['node', '--test', 'a file.js'], platform)).toEqual({ file: 'node', args: ['--test', 'a file.js'], verbatim: false });
    }
  });
});

describe('verification rendering', () => {
  it('shows commands as configured', () => {
    expect(displayVerifyCommand('  npm test ')).toBe('npm test');
    expect(displayVerifyCommand(['node', '--test', 'a file.js', ''])).toBe('node --test "a file.js" ""');
  });

  it('lists each command with its result and duration', () => {
    expect(verificationLines(passed)).toEqual(['npm ci: passed in 12s', 'npm test: passed in 42s']);
    expect(verificationNotes(passed)).toEqual([]);

    const failed: VerificationSummary = {
      passed: false,
      commands: [
        { command: 'npm ci', status: 'passed', exitCode: 0, seconds: 12 },
        { command: 'npm test', status: 'failed', exitCode: 1, seconds: 30 },
        { command: 'npm run lint', status: 'not_run', exitCode: null, seconds: 0 },
      ],
      uncommittedBefore: 0,
      uncommittedAfter: 3,
    };
    expect(verificationLines(failed)).toEqual(['npm ci: passed in 12s', 'npm test: exited 1 after 30s', 'npm run lint: not run']);
    expect(verificationNotes(failed)).toEqual([expect.stringMatching(/went from 0 to 3 during verification; they are not committed or published/)]);

    const timedOut: VerificationSummary = { ...failed, commands: [{ command: 'npm test', status: 'timed_out', exitCode: null, seconds: 900 }], uncommittedAfter: null };
    expect(verificationLines(timedOut)).toEqual(['npm test: timed out after 900s']);
    expect(verificationNotes(timedOut)).toEqual([expect.stringMatching(/git status could not be read/)]);
  });

  it('adds a Verification section to run.log and the PR body, and leaves summaries without one as they were', () => {
    const withV = { ...summary, verification: passed };
    expect(renderSummary({ summary: withV, stat: [] })).toEqual(expect.arrayContaining(['verification: passed', '  npm ci: passed in 12s', '  npm test: passed in 42s']));
    expect(renderSummary({ summary, stat: [] }).join('\n')).not.toContain('verification');

    const pr = { runId: 'run_x', issueNumber: 7, agent: 'claude', commitCount: 1, mode: 'draft-pr' as const };
    const body = renderPrBody({ ...pr, summary: withV });
    expect(body).toContain(
      '**Verification** (passed; commands run by the worker after the agent finished)\n\n```text\nnpm ci: passed in 12s\nnpm test: passed in 42s\n```\n\n**The agent\'s final message**',
    );
    // A summary stored before verification existed has no such field.
    expect(renderPrBody({ ...pr, summary })).not.toContain('Verification');
  });
});
