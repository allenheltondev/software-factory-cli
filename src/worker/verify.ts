// The worker-run verification step (actions.<name>.verify): how a configured command becomes a
// process to spawn, and how its result reads in run.log, `updraft status` and the PR body.
// The commands are run by the live executor (live.ts), with the agent's process handling.
//
// A string command needs a shell (`npm test` is a shell-resolved shim plus arguments, and people
// write `&&`). That is acceptable here, and only here, because the text comes from the user's own
// config file: nothing from the issue, the agent's output or the repository is ever put on the
// command line. The commands do run code the agent just wrote, which is why they get the agent's
// environment rule (no GitHub tokens) and process containment.
import { win32 } from 'node:path';
import type { VerifyCommand } from '../config/schema.js';
import type { VerificationCommandResult, VerificationSummary } from '../types.js';

export interface VerifyInvocation {
  file: string;
  args: string[];
  /** Windows: pass `args` to the process as written (cmd.exe has its own quoting rules). */
  verbatim: boolean;
}

/**
 * The process to spawn for one verify command.
 *
 * - argv form: the executable and its arguments, no shell on any OS.
 * - string, POSIX: `/bin/sh -c <command>`.
 * - string, Windows: `cmd.exe /d /s /c "<command>"`, passed verbatim. cmd.exe rather than
 *   PowerShell because it is what `npm run` uses for package.json scripts (so a command behaves
 *   here as it does there), it resolves the `.cmd` shims npm installs, and its exit code is the
 *   command's own. /d skips AutoRun commands from the registry; /s makes cmd strip exactly the
 *   outer quotes and take the rest as written. This is the command line Node builds for
 *   `shell: true`, spelled out so cmd.exe is taken from SystemRoot instead of ComSpec.
 */
export function verifyInvocation(
  command: VerifyCommand,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): VerifyInvocation {
  if (typeof command !== 'string') return { file: command[0]!, args: command.slice(1), verbatim: false };
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT;
    return { file: root ? win32.join(root, 'System32', 'cmd.exe') : 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
  }
  return { file: '/bin/sh', args: ['-c', command], verbatim: false };
}

/** A verify command on one line, as configured; argv elements that need it are quoted. */
export function displayVerifyCommand(command: VerifyCommand): string {
  if (typeof command === 'string') return command.trim();
  // Quoted without escaping where that is unambiguous, so a Windows path keeps its single backslashes.
  const quote = (a: string) => (a.includes('"') ? JSON.stringify(a) : `"${a}"`);
  return command.map((a) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : quote(a))).join(' ');
}

/** "passed in 42s", "exited 1 after 3s", ... */
export function describeVerifyResult(c: VerificationCommandResult): string {
  switch (c.status) {
    case 'passed':
      return `passed in ${c.seconds}s`;
    case 'failed':
      return c.exitCode !== null ? `exited ${c.exitCode} after ${c.seconds}s` : `failed after ${c.seconds}s`;
    case 'timed_out':
      return `timed out after ${c.seconds}s`;
    case 'interrupted':
      return `stopped with the worker after ${c.seconds}s`;
    case 'not_run':
      return 'not run';
  }
}

/** One line per command: "npm test: passed in 42s". */
export function verificationLines(v: VerificationSummary): string[] {
  return v.commands.map((c) => `${c.command}: ${describeVerifyResult(c)}`);
}

/**
 * What the uncommitted-change counts mean for the reader, if anything. The worker never commits
 * for the agent, so files the commands saw or produced can differ from what gets published.
 */
export function verificationNotes(v: VerificationSummary): string[] {
  const notes: string[] = [];
  const { uncommittedBefore: before, uncommittedAfter: after } = v;
  if (before === null || after === null) {
    notes.push('git status could not be read around verification, so it is unknown whether the commands ran on exactly the committed files');
    return notes;
  }
  if (before > 0) {
    notes.push(
      `${before} uncommitted change(s) were in the worktree when verification ran: the commands saw them, but only commits are published`,
    );
  }
  if (after !== before) {
    notes.push(
      `uncommitted changes in the worktree went from ${before} to ${after} during verification; ` +
        'they are not committed or published, and updraft clean keeps a worktree that has them',
    );
  }
  return notes;
}
