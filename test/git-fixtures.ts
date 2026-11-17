// Real git repositories for tests: a bare "remote" laid out as <dir>/OWNER/NAME.git and a
// clone of it, both under a temp directory whose path contains spaces.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isolatedEnv = (root: string): NodeJS.ProcessEnv => {
  const globalConfig = join(root, 'empty gitconfig');
  writeFileSync(globalConfig, '');
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: 'Factory Test',
    GIT_AUTHOR_EMAIL: 'factory@example.com',
    GIT_COMMITTER_NAME: 'Factory Test',
    GIT_COMMITTER_EMAIL: 'factory@example.com',
  };
};

export interface GitFixture {
  root: string;
  remoteDir: string;
  clone: string;
  /** Run git in `cwd` with an isolated identity/config; returns trimmed stdout. */
  git(cwd: string, ...args: string[]): string;
  /** Commit a file directly in the bare remote's branch (via a scratch clone) and return its SHA. */
  pushCommit(branch: string, file: string, content: string): string;
  cleanup(): void;
}

export function createGitFixture(fullName = 'octo/widgets', defaultBranch = 'main'): GitFixture {
  const root = mkdtempSync(join(tmpdir(), 'factory git '));
  const env = isolatedEnv(root);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const remoteDir = join(root, 'remote repos', `${fullName}.git`);
  mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, 'init', '--bare', '--quiet', '-b', defaultBranch);

  const seed = join(root, 'seed work');
  mkdirSync(seed);
  git(seed, 'init', '--quiet', '-b', defaultBranch);
  writeFileSync(join(seed, 'README.md'), '# widgets\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '--quiet', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remoteDir);
  git(seed, 'push', '--quiet', 'origin', defaultBranch);

  const clone = join(root, 'my clone');
  git(root, 'clone', '--quiet', remoteDir, clone);

  let n = 0;
  return {
    root,
    remoteDir,
    clone,
    git,
    pushCommit(branch, file, content) {
      n++;
      const scratch = join(root, `scratch ${n}`);
      git(root, 'clone', '--quiet', remoteDir, scratch);
      const exists = git(scratch, 'ls-remote', '--heads', 'origin', branch) !== '';
      if (exists) git(scratch, 'checkout', '--quiet', branch);
      else git(scratch, 'checkout', '--quiet', '-b', branch);
      writeFileSync(join(scratch, file), content);
      git(scratch, 'add', file);
      git(scratch, 'commit', '--quiet', '-m', `update ${file}`);
      git(scratch, 'push', '--quiet', 'origin', branch);
      return git(scratch, 'rev-parse', 'HEAD');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
