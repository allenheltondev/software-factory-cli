import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { parseRemoteRepo, redactRemoteUrl, remoteMatchesRepo } from './git.js';
import {
  isInside,
  jobBranchName,
  jobWorktreePath,
  prepareJobWorktree,
  withCheckoutLock,
  worktreesRoot,
  type PrepareRequest,
} from './worktree.js';

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
function fixture(fullName?: string, defaultBranch?: string): GitFixture {
  const f = createGitFixture(fullName, defaultBranch);
  fixtures.push(f);
  return f;
}

function request(f: GitFixture, over: Partial<PrepareRequest> & { jobId?: string; issue?: number } = {}): PrepareRequest {
  const job = { id: over.jobId ?? 'job_aaa', issueNumber: over.issue ?? 7, repoId: 42 };
  const paths = { dataDir: join(f.root, 'factory data') };
  return {
    checkoutPath: f.clone,
    repoFullName: 'octo/widgets',
    branch: jobBranchName(job, 1),
    worktreePath: jobWorktreePath(paths, job, 1),
    ...over,
  };
}

describe('parseRemoteRepo', () => {
  it.each([
    ['https://github.com/octo/widgets.git', 'octo/widgets'],
    ['https://github.com/octo/widgets', 'octo/widgets'],
    ['https://github.com/octo/widgets/', 'octo/widgets'],
    ['git@github.com:octo/widgets.git', 'octo/widgets'],
    ['ssh://git@github.com/octo/widgets.git', 'octo/widgets'],
    ['git@github-work:octo/widgets.git', 'octo/widgets'],
    ['C:\\Users\\me\\remote repos\\octo\\widgets.git', 'octo/widgets'],
    ['/srv/git/octo/widgets.git', 'octo/widgets'],
  ])('%s -> %s', (url, expected) => {
    const r = parseRemoteRepo(url);
    expect(r && `${r.owner}/${r.name}`).toBe(expected);
    expect(remoteMatchesRepo(url, 'OCTO/Widgets')).toBe(true);
    expect(remoteMatchesRepo(url, 'octo/gadgets')).toBe(false);
  });

  it('redacts credentials in https remote URLs only', () => {
    expect(redactRemoteUrl('https://x-access-token:ghp_secret@github.com/octo/widgets.git')).toBe('https://***@github.com/octo/widgets.git');
    expect(redactRemoteUrl('git@github.com:octo/widgets.git')).toBe('git@github.com:octo/widgets.git');
    expect(redactRemoteUrl('C:\\remote repos\\octo\\widgets.git')).toBe('C:\\remote repos\\octo\\widgets.git');
  });

  it('rejects URLs without an owner and name', () => {
    expect(parseRemoteRepo('widgets')).toBeNull();
  });
});

describe('job naming', () => {
  it('derives the branch and worktree from the job ID, suffixing later attempts', () => {
    const job = { id: 'job_123', issueNumber: 9, repoId: 77 };
    const paths = { dataDir: join('data dir') };
    expect(jobBranchName(job, 1)).toBe('factory/issue-9-job_123');
    expect(jobBranchName(job, 2)).toBe('factory/issue-9-job_123-2');
    expect(jobWorktreePath(paths, job, 1)).toBe(join('data dir', 'worktrees', '77', 'job_123'));
    expect(jobWorktreePath(paths, job, 3)).toBe(join('data dir', 'worktrees', '77', 'job_123-3'));
    expect(isInside(worktreesRoot(paths), jobWorktreePath(paths, job, 1))).toBe(true);
    expect(isInside(worktreesRoot(paths), worktreesRoot(paths))).toBe(false);
    expect(isInside(worktreesRoot(paths), join('data dir', 'other'))).toBe(false);
  });
});

// Real git is slow to spawn on Windows runners.
describe('prepareJobWorktree', { timeout: 60_000 }, () => {
  it('fetches the default branch and branches the worktree from the fetched commit', async () => {
    const f = fixture();
    // The remote moves on after the clone; the job must start from the new commit.
    const sha = f.pushCommit('main', 'later.txt', 'later\n');
    const req = request(f);
    const prepared = await prepareJobWorktree(req);

    expect(prepared).toMatchObject({ remote: 'origin', baseBranch: 'main', baseSha: sha, branch: 'factory/issue-7-job_aaa' });
    expect(prepared.worktreePath).toBe(req.worktreePath);
    expect(readFileSync(join(req.worktreePath, 'later.txt'), 'utf8').trim()).toBe('later'); // autocrlf may apply
    expect(f.git(req.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('factory/issue-7-job_aaa');
    expect(f.git(req.worktreePath, 'rev-parse', 'HEAD')).toBe(sha);
    // The user's clone keeps its own checkout untouched.
    expect(f.git(f.clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(existsSync(join(f.clone, 'later.txt'))).toBe(false);
  });

  it('uses the remote default branch when it is not main, and baseBranch when set', async () => {
    const f = fixture('octo/widgets', 'trunk');
    const dev = f.pushCommit('develop', 'dev.txt', 'dev\n');
    const a = await prepareJobWorktree(request(f, { jobId: 'job_a' }));
    expect(a.baseBranch).toBe('trunk');
    const b = await prepareJobWorktree({
      ...request(f, { jobId: 'job_b', issue: 8 }),
      baseBranch: 'develop',
    });
    expect(b).toMatchObject({ baseBranch: 'develop', baseSha: dev });
  });

  it('finds a matching remote other than origin', async () => {
    const f = fixture();
    f.git(f.clone, 'remote', 'rename', 'origin', 'upstream');
    f.git(f.clone, 'remote', 'add', 'origin', 'https://github.com/someone/fork.git');
    const prepared = await prepareJobWorktree(request(f));
    expect(prepared.remote).toBe('upstream');
  });

  it('refuses to reuse an existing branch or worktree path', async () => {
    const f = fixture();
    const req = request(f);
    f.git(f.clone, 'branch', req.branch);
    await expect(prepareJobWorktree(req)).rejects.toThrow(/branch factory\/issue-7-job_aaa already exists.*refusing to reuse it/);
    expect(existsSync(req.worktreePath)).toBe(false);

    const other = request(f, { jobId: 'job_bbb' });
    mkdirSync(other.worktreePath, { recursive: true });
    await expect(prepareJobWorktree(other)).rejects.toThrow(/already exists; refusing to reuse it/);
    expect(f.git(f.clone, 'branch', '--list', other.branch)).toBe('');
  });

  it('rejects a missing checkout, a non-repo, and a clone of another repo', async () => {
    const f = fixture();
    await expect(prepareJobWorktree(request(f, { checkoutPath: join(f.root, 'nope') }))).rejects.toThrow(/does not exist/);
    const plain = join(f.root, 'plain dir');
    mkdirSync(plain);
    // GIT_CEILING_DIRECTORIES keeps git from walking up into an enclosing repo.
    process.env.GIT_CEILING_DIRECTORIES = f.root;
    try {
      await expect(prepareJobWorktree(request(f, { checkoutPath: plain }))).rejects.toThrow(/is not a git repository/);
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
    await expect(prepareJobWorktree(request(f, { repoFullName: 'octo/gadgets' }))).rejects.toThrow(
      /no remote .* points at octo\/gadgets \(remotes: origin -> /,
    );
  });

  it('prepares concurrent jobs on one clone without racing', async () => {
    const f = fixture();
    const reqs = [1, 2, 3, 4].map((i) => request(f, { jobId: `job_${i}`, issue: i }));
    const results = await Promise.all(reqs.map((r) => prepareJobWorktree(r)));
    expect(new Set(results.map((r) => r.worktreePath)).size).toBe(4);
    expect(new Set(results.map((r) => r.branch)).size).toBe(4);
    for (const r of results) expect(f.git(r.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(r.branch);
  });
});

describe('withCheckoutLock', () => {
  it('runs operations on one checkout one at a time, in order, even after a failure', async () => {
    const order: string[] = [];
    const step = (name: string, fail = false) => async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([
      withCheckoutLock('/same/clone', step('a', true)),
      withCheckoutLock('/same/clone', step('b')),
      withCheckoutLock('/same/clone/', step('c')),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });
});
