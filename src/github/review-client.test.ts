// The review loop's requests (docs/review-loop.md): what is sent, and how the answers are read.
// None of this could be tried against GitHub; the shapes are the documented ones.
import { describe, expect, it } from 'vitest';
import { GitHubError } from './api.js';
import { createGitHubApi } from './client.js';
import { sameLogin, workerLogin } from './identity.js';

interface Call {
  url: string;
  method: string | undefined;
  body: string | undefined;
}

function fakeFetch(handler: (url: URL, call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    return handler(new URL(String(input)), call);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });

const repo = { id: 42, fullName: 'o/r' };
const SHA = 'a'.repeat(40);

describe('createGitHubApi: the review loop', () => {
  it('reads one pull request with its head, base, draft flag and mergeability', async () => {
    const raw = { number: 5, node_id: 'PR_x', html_url: 'https://github.com/o/r/pull/5', state: 'open', merged: false, draft: true, head: { ref: 'b', sha: SHA }, base: { ref: 'main' }, mergeable: null, mergeable_state: 'unknown' };
    const { fn, calls } = fakeFetch(() => json(raw));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    expect(await api.getPullRequest(repo, 5)).toEqual({ number: 5, nodeId: 'PR_x', htmlUrl: 'https://github.com/o/r/pull/5', state: 'open', merged: false, draft: true, headRef: 'b', headSha: SHA, baseRef: 'main', mergeable: null, mergeableState: 'unknown', author: null, body: '', headRepoId: null, title: '', mergedAt: null, mergeCommitSha: null });
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.github.com/repositories/42/pulls/5' });

    const merged = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ ...raw, state: 'closed', merged: true, draft: false, mergeable: true, mergeable_state: 'clean' })).fn });
    expect(await merged.getPullRequest(repo, 5)).toMatchObject({ state: 'closed', merged: true, draft: false, mergeable: true });

    // When and as which commit it was merged, and its title: what a wait on it (docs/dependencies.md) needs.
    const landed = await createGitHubApi({
      token: 't',
      fetch: fakeFetch(() => json({ ...raw, state: 'closed', merged: true, merged_at: '2026-11-18T10:00:00Z', merge_commit_sha: 'b'.repeat(40), title: 'Add the hook' })).fn,
    });
    expect(await landed.getPullRequest(repo, 5)).toMatchObject({ merged: true, mergedAt: '2026-11-18T10:00:00Z', mergeCommitSha: 'b'.repeat(40), title: 'Add the hook' });

    // Who opened it, its body and the repository of its head: what tells one of Updraft's own pull requests from any other.
    const own = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ ...raw, user: { login: 'updraft[bot]' }, body: 'Closes #1', head: { ref: 'b', sha: SHA, repo: { id: 42 } } })).fn });
    expect(await own.getPullRequest(repo, 5)).toMatchObject({ author: 'updraft[bot]', body: 'Closes #1', headRepoId: 42 });
  });

  it('lists reviews and only ever submits a COMMENT review', async () => {
    const rawReview = { id: 9, state: 'COMMENTED', user: { login: 'bot' }, body: 'x', html_url: 'u', submitted_at: 't', commit_id: SHA };
    const { fn, calls } = fakeFetch((_url, call) => (call.method === 'POST' ? json(rawReview) : json([rawReview, { id: 10, state: 'CHANGES_REQUESTED', user: null, body: null }])));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    expect(await api.listPullRequestReviews(repo, 5)).toEqual([
      { id: 9, state: 'COMMENTED', user: 'bot', body: 'x', htmlUrl: 'u', submittedAt: 't', commitId: SHA },
      { id: 10, state: 'CHANGES_REQUESTED', user: null, body: '', htmlUrl: '', submittedAt: null, commitId: null },
    ]);
    expect(calls[0]!.url).toBe('https://api.github.com/repositories/42/pulls/5/reviews?per_page=100');

    expect(await api.createPullRequestReview(repo, 5, { body: 'findings', commitId: SHA })).toMatchObject({ id: 9, state: 'COMMENTED' });
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repositories/42/pulls/5/reviews' });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ event: 'COMMENT', body: 'findings', commit_id: SHA });
    await api.createPullRequestReview(repo, 5, { body: 'findings' });
    expect(JSON.parse(calls[2]!.body!)).toEqual({ event: 'COMMENT', body: 'findings' });
  });

  it('marks a draft ready through GraphQL and turns GraphQL errors into failures', async () => {
    const { fn, calls } = fakeFetch(() => json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    await api.markPullRequestReady(repo, 'PR_x');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.github.com/graphql' });
    const sent = JSON.parse(calls[0]!.body!) as { query: string; variables: unknown };
    expect(sent.query).toContain('markPullRequestReadyForReview(input: { pullRequestId: $id })');
    expect(sent.variables).toEqual({ id: 'PR_x' });

    const denied = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] })).fn });
    await expect(denied.markPullRequestReady(repo, 'PR_x')).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/Resource not accessible/) });
    const limited = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] })).fn });
    await expect(limited.markPullRequestReady(repo, 'PR_x')).rejects.toMatchObject({ status: 429, isRateLimit: true });
  });

  it('reads statuses and check runs of a commit together; none at all is not pending', async () => {
    const answer = (statuses: unknown[], runs: unknown[]) =>
      fakeFetch((url) => (url.pathname.endsWith('/status') ? json({ state: 'pending', total_count: statuses.length, statuses }) : json({ total_count: runs.length, check_runs: runs })));
    const none = answer([], []);
    const api = await createGitHubApi({ token: 't', fetch: none.fn });
    expect(await api.getCommitChecks(repo, SHA)).toEqual({ total: 0, failing: [], pending: [], succeeded: [], complete: true });
    expect(none.calls.map((c) => c.url)).toEqual([
      `https://api.github.com/repositories/42/commits/${SHA}/status?per_page=100`,
      `https://api.github.com/repositories/42/commits/${SHA}/check-runs?per_page=100`,
    ]);

    const mixed = answer(
      [
        { context: 'ci/ok', state: 'success' },
        { context: 'ci/red', state: 'failure' },
        { context: 'ci/err', state: 'error' },
        { context: 'ci/wait', state: 'pending' },
      ],
      [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'docs', status: 'completed', conclusion: 'skipped' },
        { name: 'lint', status: 'completed', conclusion: 'neutral' },
        { name: 'test', status: 'completed', conclusion: 'failure' },
        { name: 'e2e', status: 'completed', conclusion: 'cancelled' },
        { name: 'slow', status: 'completed', conclusion: 'timed_out' },
        { name: 'gate', status: 'completed', conclusion: 'action_required' },
        { name: 'deploy', status: 'in_progress', conclusion: null },
        { name: 'later', status: 'queued', conclusion: null },
      ],
    );
    expect(await (await createGitHubApi({ token: 't', fetch: mixed.fn })).getCommitChecks(repo, SHA)).toEqual({
      total: 13,
      failing: ['ci/red', 'ci/err', 'test', 'e2e', 'slow', 'gate'],
      pending: ['ci/wait', 'deploy', 'later'],
      // Skipped and neutral runs (docs, lint) are in no list: they neither failed nor passed.
      succeeded: ['ci/ok', 'build'],
      complete: true,
    });
  });

  it('reads every page of statuses and check runs, so a failure on a later page is seen', async () => {
    const base = `https://api.github.com/repositories/42/commits/${SHA}`;
    const link = (url: string) => ({ headers: { link: `<${url}>; rel="next"` } });
    const { fn, calls } = fakeFetch((url) => {
      const page = url.searchParams.get('page') ?? '1';
      if (url.pathname.endsWith('/status')) {
        return page === '1'
          ? json({ state: 'success', total_count: 2, statuses: [{ context: 'ci/ok', state: 'success' }] }, link(`${base}/status?per_page=100&page=2`))
          : json({ state: 'success', total_count: 2, statuses: [{ context: 'ci/late-red', state: 'failure' }] });
      }
      return page === '1'
        ? json({ total_count: 2, check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }, link(`${base}/check-runs?per_page=100&page=2`))
        : json({ total_count: 2, check_runs: [{ name: 'late', status: 'in_progress', conclusion: null }] });
    });
    const api = await createGitHubApi({ token: 't', fetch: fn });
    expect(await api.getCommitChecks(repo, SHA)).toEqual({ total: 4, failing: ['ci/late-red'], pending: ['late'], succeeded: ['ci/ok', 'build'], complete: true });
    expect(calls.map((c) => new URL(c.url).pathname.split('/').pop() + new URL(c.url).search)).toEqual([
      'status?per_page=100',
      'status?per_page=100&page=2',
      'check-runs?per_page=100',
      'check-runs?per_page=100&page=2',
    ]);
  });

  it('reports a listing it could not read to the end as incomplete, never as passing', async () => {
    // GitHub counts more statuses than it returned and offers no further page.
    const short = fakeFetch((url) =>
      url.pathname.endsWith('/status') ? json({ total_count: 3, statuses: [{ context: 'ci/ok', state: 'success' }] }) : json({ total_count: 0, check_runs: [] }),
    );
    expect(await (await createGitHubApi({ token: 't', fetch: short.fn })).getCommitChecks(repo, SHA)).toEqual({ total: 1, failing: [], pending: [], succeeded: ['ci/ok'], complete: false });

    const fewerRuns = fakeFetch((url) =>
      url.pathname.endsWith('/status') ? json({ total_count: 0, statuses: [] }) : json({ total_count: 5, check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }),
    );
    expect(await (await createGitHubApi({ token: 't', fetch: fewerRuns.fn })).getCommitChecks(repo, SHA)).toMatchObject({ complete: false });
  });

  it('asks for a token for the repository when marking a pull request ready, though the mutation names only a node id', async () => {
    const asked: Array<string | null> = [];
    const { fn } = fakeFetch(() => json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }));
    const api = await createGitHubApi({
      fetch: fn,
      // Like a GitHub App: a token exists only for a repository.
      credentials: {
        kind: 'app',
        token: async (repoFullName) => {
          asked.push(repoFullName);
          if (!repoFullName) throw new GitHubError('this request is not about one repository', 403);
          return 'installation-token';
        },
        reject: () => undefined,
      },
    });
    await api.markPullRequestReady(repo, 'PR_x');
    expect(asked).toEqual(['o/r']);
  });

  it('merges with the head pinned, and reports a refusal with its status', async () => {
    const { fn, calls } = fakeFetch(() => json({ merged: true, sha: 'm'.repeat(40), message: 'Pull Request successfully merged' }));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    expect(await api.mergePullRequest(repo, 5, { sha: SHA, method: 'squash' })).toEqual({ merged: true, sha: 'm'.repeat(40), message: 'Pull Request successfully merged' });
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.github.com/repositories/42/pulls/5/merge' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ sha: SHA, merge_method: 'squash' });

    for (const [status, message] of [
      [405, 'Pull Request is not mergeable'],
      [409, 'Head branch was modified. Review and try the merge again.'],
    ] as const) {
      const refused = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ message }, { status })).fn });
      const err = await refused.mergePullRequest(repo, 5, { sha: SHA, method: 'merge' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect(err).toMatchObject({ status, message: expect.stringContaining(message) });
    }
  });

  it('reports which merge methods a repository allows when GitHub says', async () => {
    const raw = { id: 42, full_name: 'o/r', name: 'r', owner: { login: 'o' }, private: false, archived: false, default_branch: 'main', description: null };
    const api = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ ...raw, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false })).fn });
    expect((await api.getRepo('o/r')).mergeMethods).toEqual({ squash: true, merge: false, rebase: false });
    expect((await (await createGitHubApi({ token: 't', fetch: fakeFetch(() => json(raw)).fn })).getRepo('o/r')).mergeMethods).toBeNull();
  });
});

describe('workerLogin', () => {
  it('asks once per client and compares logins without regard to case', async () => {
    let asked = 0;
    const api = {
      getWorkerIdentity: async () => {
        asked++;
        return { kind: 'app' as const, login: 'Updraft-Bot', id: 1 };
      },
    };
    expect(await workerLogin(api)).toBe('Updraft-Bot');
    expect(await workerLogin(api)).toBe('Updraft-Bot');
    expect(asked).toBe(1);
    expect(sameLogin('updraft-bot', 'Updraft-Bot')).toBe(true);
    expect(sameLogin(null, 'x')).toBe(false);

    // A failed lookup is not remembered.
    let fail = true;
    const flaky = {
      getWorkerIdentity: async () => {
        if (fail) throw new GitHubError('down', 502);
        return { kind: 'user' as const, login: 'me', id: 2 };
      },
    };
    await expect(workerLogin(flaky)).rejects.toThrow('down');
    fail = false;
    expect(await workerLogin(flaky)).toBe('me');
  });
});
