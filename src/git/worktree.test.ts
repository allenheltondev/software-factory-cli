import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { isGitHubRemoteFor, parseRemoteUrl, redactRemoteUrl, selectRepoRemote, type Remote } from './git.js';
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
  const paths = { dataDir: join(f.root, 'updraft data') };
  return {
    checkoutPath: f.clone,
    repoFullName: 'octo/widgets',
    // The fixture's remote is a local path, so it has to be named explicitly.
    remote: 'origin',
    branch: jobBranchName(job, 1),
    worktreePath: jobWorktreePath(paths, job, 1),
    ...over,
  };
}

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/octo/widgets.git', 'github.com', 'octo/widgets'],
    ['https://GitHub.com/Octo/Widgets', 'github.com', 'Octo/Widgets'],
    ['http://github.com/octo/widgets/', 'github.com', 'octo/widgets'],
    ['https://x-access-token:t@github.com/octo/widgets.git', 'github.com', 'octo/widgets'],
    ['git@github.com:octo/widgets.git', 'github.com', 'octo/widgets'],
    ['ssh://git@github.com/octo/widgets.git', 'github.com', 'octo/widgets'],
    ['ssh://git@github.com:22/octo/widgets', 'github.com', 'octo/widgets'],
    ['git@github-work:octo/widgets.git', 'github-work', 'octo/widgets'],
    ['https://gitlab.example.com/octo/widgets.git', 'gitlab.example.com', 'octo/widgets'],
    ['C:\\Users\\me\\remote repos\\octo\\widgets.git', null, 'octo/widgets'],
    ['/srv/git/octo/widgets.git', null, 'octo/widgets'],
    ['file:///srv/git/octo/widgets.git', null, 'octo/widgets'],
  ])('%s', (url, host, repo) => {
    const r = parseRemoteUrl(url);
    expect(r && { host: r.host, repo: `${r.owner}/${r.name}` }).toEqual({ host, repo });
  });

  it('treats only github.com URLs whose path is exactly OWNER/NAME as GitHub remotes for the repo', () => {
    expect(isGitHubRemoteFor('git@github.com:Octo/Widgets.git', 'octo/widgets')).toBe(true);
    expect(isGitHubRemoteFor('https://github.com/octo/widgets', 'octo/widgets')).toBe(true);
    expect(isGitHubRemoteFor('https://github.com/octo/gadgets', 'octo/widgets')).toBe(false);
    expect(isGitHubRemoteFor('https://github.com.evil.example/octo/widgets', 'octo/widgets')).toBe(false);
    expect(isGitHubRemoteFor('https://gitlab.example.com/octo/widgets', 'octo/widgets')).toBe(false);
    expect(isGitHubRemoteFor('https://example.com/github.com/octo/widgets', 'octo/widgets')).toBe(false);
    expect(isGitHubRemoteFor('https://github.com/x/octo/widgets', 'octo/widgets')).toBe(false);
    expect(isGitHubRemoteFor('git@github-work:octo/widgets.git', 'octo/widgets')).toBe(false);
    expect(isGitHubRemoteFor('/srv/octo/widgets.git', 'octo/widgets')).toBe(false);
  });

  it('redacts credentials in https remote URLs only', () => {
    expect(redactRemoteUrl('https://x-access-token:ghp_secret@github.com/octo/widgets.git')).toBe('https://***@github.com/octo/widgets.git');
    expect(redactRemoteUrl('git@github.com:octo/widgets.git')).toBe('git@github.com:octo/widgets.git');
    expect(redactRemoteUrl('C:\\remote repos\\octo\\widgets.git')).toBe('C:\\remote repos\\octo\\widgets.git');
  });

  it('rejects URLs without an owner and name', () => {
    expect(parseRemoteUrl('widgets')).toBeNull();
  });
});

describe('selectRepoRemote', () => {
  const r = (name: string, url: string): Remote => ({ name, url });

  it('prefers a github.com upstream over a non-GitHub origin with the same OWNER/NAME', () => {
    const sel = selectRepoRemote(
      [r('origin', 'https://gitlab.example.com/octo/widgets.git'), r('upstream', 'git@github.com:octo/widgets.git')],
      'octo/widgets',
    );
    expect(sel).toMatchObject({
      ok: true,
      remote: { name: 'upstream' },
      reason: expect.stringMatching(/github\.com URL.*origin is not one/),
    });
  });

  it('prefers origin among GitHub remotes', () => {
    const sel = selectRepoRemote(
      [r('mirror', 'https://github.com/octo/widgets'), r('origin', 'git@github.com:octo/widgets.git')],
      'octo/widgets',
    );
    expect(sel).toMatchObject({ ok: true, remote: { name: 'origin' } });
  });

  it('rejects a clone whose only match is on another host and suggests remote:', () => {
    const sel = selectRepoRemote([r('origin', 'git@github-work:octo/widgets.git')], 'octo/widgets');
    expect(sel.ok).toBe(false);
    if (sel.ok) return;
    expect(sel.error).toMatch(/no github\.com remote points at octo\/widgets/);
    expect(sel.error).toContain('set repositories.octo/widgets.remote: origin');
  });

  it('rejects when nothing matches', () => {
    const sel = selectRepoRemote([r('origin', 'https://github.com/someone/fork.git')], 'octo/widgets');
    expect(sel).toEqual({
      ok: false,
      error: 'no github.com remote points at octo/widgets (remotes: origin -> https://github.com/someone/fork.git)',
    });
  });

  it('accepts an explicitly named remote on any host when OWNER/NAME match', () => {
    const remotes = [r('origin', 'https://github.com/octo/widgets'), r('work', 'git@github-work:Octo/Widgets.git')];
    expect(selectRepoRemote(remotes, 'octo/widgets', 'work')).toMatchObject({
      ok: true,
      remote: { name: 'work' },
      reason: 'set in repositories.octo/widgets.remote',
    });
  });

  it('rejects an explicitly named remote that is missing or points at another repo', () => {
    const remotes = [r('origin', 'https://github.com/octo/widgets'), r('work', 'git@github-work:octo/gadgets.git')];
    expect(selectRepoRemote(remotes, 'octo/widgets', 'work')).toEqual({
      ok: false,
      error: 'remote "work" set in repositories.octo/widgets.remote points at git@github-work:octo/gadgets.git, not octo/widgets',
    });
    expect(selectRepoRemote(remotes, 'octo/widgets', 'nope')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^remote "nope" set in repositories\.octo\/widgets\.remote does not exist \(remotes: origin -> /),
    });
  });
});

describe('job naming', () => {
  it('derives the branch and worktree from the job ID, suffixing later attempts', () => {
    const job = { id: 'job_123', issueNumber: 9, repoId: 77 };
    const paths = { dataDir: join('data dir') };
    expect(jobBranchName(job, 1)).toBe('updraft/issue-9-job_123');
    expect(jobBranchName(job, 2)).toBe('updraft/issue-9-job_123-2');
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

    expect(prepared).toMatchObject({ remote: 'origin', baseBranch: 'main', baseSha: sha, branch: 'updraft/issue-7-job_aaa' });
    expect(prepared.worktreePath).toBe(req.worktreePath);
    expect(readFileSync(join(req.worktreePath, 'later.txt'), 'utf8').trim()).toBe('later'); // autocrlf may apply
    expect(f.git(req.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('updraft/issue-7-job_aaa');
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

  it('uses the configured remote, and without one refuses a remote that is not on github.com', async () => {
    const f = fixture();
    f.git(f.clone, 'remote', 'rename', 'origin', 'upstream');
    f.git(f.clone, 'remote', 'add', 'origin', 'https://github.com/someone/fork.git');
    const prepared = await prepareJobWorktree(request(f, { remote: 'upstream' }));
    expect(prepared.remote).toBe('upstream');

    const auto = request(f, { jobId: 'job_auto', remote: undefined });
    await expect(prepareJobWorktree(auto)).rejects.toThrow(
      /no github\.com remote points at octo\/widgets.*set repositories\.octo\/widgets\.remote: upstream/,
    );
    expect(existsSync(auto.worktreePath)).toBe(false);
  });

  it('refuses to reuse an existing branch or worktree path', async () => {
    const f = fixture();
    const req = request(f);
    f.git(f.clone, 'branch', req.branch);
    await expect(prepareJobWorktree(req)).rejects.toThrow(/branch updraft\/issue-7-job_aaa already exists.*refusing to reuse it/);
    expect(existsSync(req.worktreePath)).toBe(false);

    const other = request(f, { jobId: 'job_bbb' });
    mkdirSync(other.worktreePath, { recursive: true });
    await expect(prepareJobWorktree(other)).rejects.toThrow(/already exists; refusing to reuse it/);
    expect(f.git(f.clone, 'branch', '--list', other.branch)).toBe('');
  });

  it('reports a worktree that git created before failing, so the run can keep it', async () => {
    const f = fixture();
    f.failPostCheckout();
    const req = request(f);
    const seen: string[] = [];
    await expect(prepareJobWorktree({ ...req, onCheckout: (p) => seen.push(p) })).rejects.toThrow(
      /git worktree add .*failed.*was created and is kept for inspection/,
    );
    expect(seen).toEqual([req.worktreePath]);
    expect(existsSync(req.worktreePath)).toBe(true);
    expect(f.git(f.clone, 'branch', '--list', req.branch)).toContain(req.branch);
  });

  it('calls onCheckout once the worktree exists, and not when nothing was created', async () => {
    const f = fixture();
    const ok: string[] = [];
    const req = request(f);
    await prepareJobWorktree({ ...req, onCheckout: (p) => ok.push(p) });
    expect(ok).toEqual([req.worktreePath]);

    const none: string[] = [];
    const again = request(f); // same branch: refused before anything is created
    await expect(prepareJobWorktree({ ...again, onCheckout: (p) => none.push(p) })).rejects.toThrow(/already exists/);
    expect(none).toEqual([]);
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
      /remote "origin" set in repositories\.octo\/gadgets\.remote points at .*, not octo\/gadgets/,
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
