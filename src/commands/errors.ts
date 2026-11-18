import { ConfigError } from '../config/io.js';
import { GitHubError } from '../github/api.js';
import { WorkerLockedError } from '../worker/daemon.js';

export const EXIT = {
  OK: 0,
  /** Command failed: invalid config, GitHub error, failed doctor check, etc. */
  FAILURE: 1,
  /** Bad arguments or wrong environment (e.g. configure without a TTY). */
  USAGE: 2,
  /** Another worker holds the lock. Launchers can treat this as "already running". */
  LOCKED: 3,
} as const;

/** Raised for user-facing failures whose message is already friendly. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.FAILURE,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** The user cancelled an interactive prompt. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled; nothing was saved.');
    this.name = 'CancelledError';
  }
}

export function describeGitHubError(err: GitHubError): string {
  if (err.isRateLimit) {
    const wait = err.retryAfterSeconds !== null ? ` Try again in ${err.retryAfterSeconds}s.` : '';
    return `GitHub rate limit reached.${wait}`;
  }
  switch (err.status) {
    case 401:
      return 'GitHub rejected the token (401). Run "gh auth login" or set GH_TOKEN.';
    case 403:
      return `GitHub denied access (403): ${err.message}`;
    case 404:
      return `${err.message} (not found, or the active GitHub account cannot access it)`;
    default:
      return `GitHub API error (${err.status}): ${err.message}`;
  }
}

/** Map an error to a short message and an exit code. */
export function describeError(err: unknown): { message: string; exitCode: number } {
  if (err instanceof CliError) return { message: err.message, exitCode: err.exitCode };
  if (err instanceof CancelledError) return { message: err.message, exitCode: EXIT.FAILURE };
  if (err instanceof ConfigError) return { message: err.message, exitCode: EXIT.FAILURE };
  if (err instanceof GitHubError) return { message: describeGitHubError(err), exitCode: EXIT.FAILURE };
  if (err instanceof WorkerLockedError) {
    return { message: `${err.message}. Stop it first, or check "updraft status".`, exitCode: EXIT.LOCKED };
  }
  if (err instanceof Error) return { message: err.message, exitCode: EXIT.FAILURE };
  return { message: String(err), exitCode: EXIT.FAILURE };
}
