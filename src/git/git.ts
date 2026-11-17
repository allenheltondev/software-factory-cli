// Thin wrapper around the git CLI. Every call goes through execFile with an argument
// array (never a shell), so paths with spaces and untrusted names are passed verbatim.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export interface GitOptions {
  /** Working directory for the command; must exist. */
  cwd: string;
  /** git executable; defaults to "git" on PATH. */
  git?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface GitOutput {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export function runGit(args: readonly string[], opts: GitOptions): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      opts.git ?? 'git',
      [...args],
      {
        cwd: opts.cwd,
        // Never wait on a credential or terminal prompt in a background worker.
        env: { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolvePromise({ stdout, stderr });
          return;
        }
        const code = typeof err.code === 'number' ? err.code : null;
        const detail = (stderr || err.message).trim().split(/\r?\n/).filter(Boolean).slice(-3).join('; ');
        reject(new GitError(`git ${args.join(' ')} failed${code !== null ? ` (exit ${code})` : ''}: ${detail}`, args, code, stderr));
      },
    );
  });
}

/** Like runGit, but returns null when git exits non-zero (e.g. a ref that does not exist). */
async function tryGit(args: readonly string[], opts: GitOptions): Promise<GitOutput | null> {
  try {
    return await runGit(args, opts);
  } catch (err) {
    if (err instanceof GitError && err.exitCode !== null) return null;
    throw err;
  }
}

/**
 * OWNER/NAME from a remote URL: https://host/o/r(.git), git@host:o/r.git, ssh://git@host/o/r.git,
 * or a local path ending in o/r(.git). The host is not checked (SSH host aliases are common);
 * `factory doctor` confirms the repository ID through the API.
 */
export function parseRemoteRepo(url: string): { owner: string; name: string } | null {
  const trimmed = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const parts = trimmed.split(/[\\/:]+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[parts.length - 2]!, name: parts[parts.length - 1]! };
}

export function remoteMatchesRepo(url: string, fullName: string): boolean {
  const r = parseRemoteRepo(url);
  return r !== null && `${r.owner}/${r.name}`.toLowerCase() === fullName.toLowerCase();
}

/** Hide credentials embedded in a remote URL (https://user:token@host/...) before logging it. */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@');
}

export interface Remote {
  name: string;
  url: string;
}

export async function isGitRepo(opts: GitOptions): Promise<boolean> {
  return (await tryGit(['rev-parse', '--git-dir'], opts)) !== null;
}

export async function listRemotes(opts: GitOptions): Promise<Remote[]> {
  const names = (await runGit(['remote'], opts)).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const remotes: Remote[] = [];
  for (const name of names) {
    const out = await tryGit(['remote', 'get-url', name], opts);
    if (out) remotes.push({ name, url: out.stdout.trim() });
  }
  return remotes;
}

/** The remote pointing at OWNER/NAME, preferring "origin" when several do. */
export function pickRemote(remotes: readonly Remote[], fullName: string): Remote | null {
  const matching = remotes.filter((r) => remoteMatchesRepo(r.url, fullName));
  return matching.find((r) => r.name === 'origin') ?? matching[0] ?? null;
}

/** The remote's default branch: asks the remote, then falls back to the local refs/remotes/<remote>/HEAD. */
export async function remoteDefaultBranch(remote: string, opts: GitOptions): Promise<string> {
  const live = await runGit(['ls-remote', '--symref', remote, 'HEAD'], opts);
  const m = /^ref:\s*refs\/heads\/(\S+)\s+HEAD$/m.exec(live.stdout);
  if (m) return m[1]!;
  const local = await tryGit(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], opts);
  const prefix = `refs/remotes/${remote}/`;
  const ref = local?.stdout.trim();
  if (ref?.startsWith(prefix)) return ref.slice(prefix.length);
  throw new Error(`could not determine the default branch of remote "${remote}"; set baseBranch in the config`);
}

export async function assertValidBranchName(branch: string, opts: GitOptions): Promise<void> {
  if (branch.startsWith('-') || (await tryGit(['check-ref-format', '--branch', branch], opts)) === null) {
    throw new Error(`"${branch}" is not a valid branch name`);
  }
}

/** Fetch one branch into refs/remotes/<remote>/<branch> and return the fetched commit. */
export async function fetchBranch(remote: string, branch: string, opts: GitOptions): Promise<string> {
  const tracking = `refs/remotes/${remote}/${branch}`;
  await runGit(['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:${tracking}`], opts);
  return (await runGit(['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`], opts)).stdout.trim();
}

export async function localBranchExists(branch: string, opts: GitOptions): Promise<boolean> {
  return (await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], opts)) !== null;
}

/** Create `branch` at `startPoint` and check it out in a new worktree at `path`. */
export async function addWorktree(path: string, branch: string, startPoint: string, opts: GitOptions): Promise<void> {
  await runGit(['worktree', 'add', '--quiet', '-b', branch, path, startPoint], opts);
}

/** The repository's shared .git directory, as an absolute path. Run with cwd inside any of its worktrees. */
export async function gitCommonDir(opts: GitOptions): Promise<string> {
  const out = (await runGit(['rev-parse', '--git-common-dir'], opts)).stdout.trim();
  return resolve(opts.cwd, out);
}

/** Remove a clean worktree (git refuses if it has uncommitted or untracked changes). */
export async function removeWorktree(path: string, opts: GitOptions): Promise<void> {
  await runGit(['worktree', 'remove', path], opts);
}

export async function pruneWorktrees(opts: GitOptions): Promise<void> {
  await runGit(['worktree', 'prune'], opts);
}
