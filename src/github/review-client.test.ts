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

  it('submits inline comments with a COMMENT review, a range with its start', async () => {
    const { fn, calls } = fakeFetch(() => json({ id: 9, state: 'COMMENTED', user: { login: 'bot' }, body: 'x', html_url: 'u', submitted_at: 't', commit_id: SHA }));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    await api.createPullRequestReview(repo, 5, {
      body: 'x',
      commitId: SHA,
      comments: [
        { path: 'a.ts', line: 4, side: 'RIGHT', body: 'one' },
        { path: 'b.ts', line: 9, side: 'LEFT', startLine: 7, body: 'range' },
      ],
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      event: 'COMMENT',
      body: 'x',
      commit_id: SHA,
      comments: [
        { path: 'a.ts', line: 4, side: 'RIGHT', body: 'one' },
        { path: 'b.ts', line: 9, side: 'LEFT', start_line: 7, start_side: 'LEFT', body: 'range' },
      ],
    });
  });

  it('lists diff files and review comments, and replies in a thread', async () => {
    const { fn, calls } = fakeFetch((url, call) => {
      if (url.pathname.endsWith('/files')) return json([{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }, { filename: 'img.png', status: 'added' }]);
      if (call.method === 'POST') return json({ id: 77, in_reply_to_id: 70, user: { login: 'bot' }, body: 'r', path: 'a.ts', html_url: 'h77' });
      return json([{ id: 70, pull_request_review_id: 9, user: { login: 'bot' }, body: 'c', path: 'a.ts', html_url: 'h70' }]);
    });
    const api = await createGitHubApi({ token: 't', fetch: fn });
    expect(await api.listPullRequestFiles!(repo, 5)).toEqual([
      { path: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'img.png', status: 'added', patch: null },
    ]);
    expect(await api.listPullRequestReviewComments!(repo, 5)).toEqual([{ id: 70, reviewId: 9, inReplyToId: null, user: 'bot', body: 'c', path: 'a.ts', htmlUrl: 'h70' }]);
    expect(await api.replyToReviewComment!(repo, 5, 70, 'r')).toMatchObject({ id: 77, inReplyToId: 70 });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://api.github.com/repositories/42/pulls/5/comments/70/replies' });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ body: 'r' });
  });

  it('reads review threads with the repository check, and resolves one', async () => {
    const threads = { data: { repository: { databaseId: 42, pullRequest: { reviewThreads: { nodes: [{ id: 'T1', isResolved: false, comments: { nodes: [{ databaseId: 70, author: { login: 'bot' } }] } }, null] } } } } };
    const { fn, calls } = fakeFetch((_url, call) => (call.body?.includes('esolveReviewThread') ? json({ data: { resolveReviewThread: { thread: { isResolved: true } } } }) : json(threads)));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    expect(await api.listReviewThreads!(repo, 5)).toEqual([{ id: 'T1', isResolved: false, rootCommentId: 70, rootAuthor: 'bot' }]);
    await api.resolveReviewThread!(repo, 'T1');
    expect(JSON.parse(calls.at(-1)!.body!).variables).toEqual({ id: 'T1' });
    await api.unresolveReviewThread!(repo, 'T1');
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ query: expect.stringContaining('unresolveReviewThread'), variables: { id: 'T1' } });

    // A thread on the second page is found.
    const paged = fakeFetch((_url, call) => {
      const vars = JSON.parse(call.body!).variables as { cursor: string | null };
      const page = (nodes: unknown[], next: string | null) => json({ data: { repository: { databaseId: 42, pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } } });
      return vars.cursor === null ? page([{ id: 'T1', isResolved: true, comments: { nodes: [{ databaseId: 1 }] } }], 'c1') : page([{ id: 'T2', isResolved: false, comments: { nodes: [{ databaseId: 2, author: { login: 'bot' } }] } }], null);
    });
    const pagedApi = await createGitHubApi({ token: 't', fetch: paged.fn });
    expect((await pagedApi.listReviewThreads!(repo, 5)).map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(JSON.parse(paged.calls[1]!.body!).variables.cursor).toBe('c1');
    // Never read to the end: an error, not a short list.
    const endless = await createGitHubApi({
      token: 't',
      fetch: fakeFetch(() => json({ data: { repository: { databaseId: 42, pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'more' }, nodes: [] } } } } })).fn,
    });
    await expect(endless.listReviewThreads!(repo, 5)).rejects.toThrow(/not all were read/);

    const renamed = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ data: { repository: { databaseId: 7, pullRequest: null } } })).fn });
    await expect(renamed.listReviewThreads!(repo, 5)).rejects.toThrow(/now names repository 7/);
    const refused = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ errors: [{ type: 'FORBIDDEN', message: 'no' }] })).fn });
    await expect(refused.resolveReviewThread!(repo, 'T1')).rejects.toMatchObject({ status: 403 });
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
    expect(await api.getCommitChecks(repo, SHA)).toEqual({ total: 0, failing: [], pending: [], succeeded: [], complete: true, details: [] });
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
    expect(await (await createGitHubApi({ token: 't', fetch: mixed.fn })).getCommitChecks(repo, SHA)).toMatchObject({
      total: 13,
      failing: ['ci/red', 'ci/err', 'test', 'e2e', 'slow', 'gate'],
      pending: ['ci/wait', 'deploy', 'later'],
      // Skipped and neutral runs (docs, lint) are in no list: they neither failed nor passed.
      succeeded: ['ci/ok', 'build'],
      complete: true,
    });
  });

  it('reports each check with its outcome, conclusion, link and check run id, for the CI step', async () => {
    const { fn } = fakeFetch((url) =>
      url.pathname.endsWith('/status')
        ? json({ total_count: 1, statuses: [{ context: 'ext/ci', state: 'error', target_url: 'https://ci.example/1', description: 'agent lost' }] })
        : json({
            total_count: 3,
            check_runs: [
              { id: 7, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/runs/7', app: { slug: 'github-actions' }, output: { title: '2 failed', summary: 'see log' } },
              { id: 8, name: 'docs', status: 'completed', conclusion: 'skipped', html_url: null, details_url: 'https://d/8' },
              { id: 9, name: 'e2e', status: 'in_progress', conclusion: null },
            ],
          }),
    );
    const checks = await (await createGitHubApi({ token: 't', fetch: fn })).getCommitChecks(repo, SHA);
    expect(checks.details).toEqual([
      { kind: 'status', name: 'ext/ci', outcome: 'failure', conclusion: 'error', url: 'https://ci.example/1', summary: 'agent lost' },
      { kind: 'check-run', name: 'test', outcome: 'failure', conclusion: 'failure', url: 'https://github.com/o/r/runs/7', checkRunId: 7, app: 'github-actions', summary: '2 failed\nsee log' },
      { kind: 'check-run', name: 'docs', outcome: 'skipped', conclusion: 'skipped', url: 'https://d/8', checkRunId: 8, app: null },
      { kind: 'check-run', name: 'e2e', outcome: 'pending', conclusion: null, url: null, checkRunId: 9, app: null },
    ]);
  });

  it('names the workflow run of a GitHub Actions check run, from its URL, and re-runs its failed jobs', async () => {
    const { fn, calls } = fakeFetch((url, call) => {
      if (call.method === 'POST') return new Response(null, { status: 201 });
      if (url.pathname.endsWith('/status')) return json({ total_count: 0, statuses: [] });
      return json({
        total_count: 2,
        check_runs: [
          { id: 71, name: 'windows-latest / node 22', status: 'completed', conclusion: 'failure', completed_at: '2026-11-18T12:00:00Z', html_url: 'https://github.com/o/r/actions/runs/555/job/71', app: { slug: 'github-actions' } },
          { id: 72, name: 'other', status: 'completed', conclusion: 'failure', html_url: 'https://ci.example/actions/runs/1', details_url: 'https://github.com/o/r/runs/72' },
        ],
      });
    });
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const checks = await api.getCommitChecks(repo, SHA);
    expect(checks.details?.[0]).toMatchObject({ checkRunId: 71, workflowRunId: 555, completedAt: '2026-11-18T12:00:00Z' });
    expect(checks.details?.[1]).not.toHaveProperty('workflowRunId');
    // 201 with no body is a re-run accepted.
    await api.rerunFailedJobs!(repo, 555);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://api.github.com/repositories/42/actions/runs/555/rerun-failed-jobs' });

    const refused = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ message: 'This workflow run cannot be retried' }, { status: 403 })).fn });
    await expect(refused.rerunFailedJobs!(repo, 555)).rejects.toMatchObject({ status: 403 });
  });

  it('reads a failed check run\'s annotations and the end of its job log, sending the token only to the API', async () => {
    const seen: Array<{ url: string; auth: string | null; redirect: string | undefined }> = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url: url.toString(), auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
      if (url.pathname.endsWith('/annotations')) return json([{ path: 'src/a.ts', start_line: 3, annotation_level: 'failure', message: 'expected 1 to be 2', title: 'a.test.ts' }]);
      if (url.pathname.endsWith('/logs')) return new Response(null, { status: 302, headers: { location: 'https://blob.example/log?sig=x' } });
      return new Response(`${'x\n'.repeat(10)}2026-01-01T00:00:00.0000000Z ##[error]Process completed with exit code 1.`, { status: 200 });
    }) as typeof fetch;
    const api = await createGitHubApi({ token: 'secret-token', fetch: fn });
    const d = await api.getCheckRunDiagnostics(repo, 7, { maxLogBytes: 70 });
    expect(d.annotations).toEqual([{ path: 'src/a.ts', line: 3, level: 'failure', message: 'expected 1 to be 2', title: 'a.test.ts' }]);
    expect(d.logTail).toMatch(/##\[error\]Process completed with exit code 1\.$/);
    expect(d.logTail!.length).toBeLessThanOrEqual(70);
    expect(d.problems).toEqual([]);
    expect(seen.map((c) => [c.url, c.auth])).toEqual([
      ['https://api.github.com/repositories/42/check-runs/7/annotations?per_page=50', 'Bearer secret-token'],
      ['https://api.github.com/repositories/42/actions/jobs/7/logs', 'Bearer secret-token'],
      ['https://blob.example/log?sig=x', null],
    ]);
    expect(seen[1]!.redirect).toBe('manual');

    // Not an Actions job (or its log expired), and annotations it may not read: said, not thrown.
    const none = await (
      await createGitHubApi({ token: 't', fetch: fakeFetch((url) => (url.pathname.endsWith('/annotations') ? json({ message: 'Forbidden' }, { status: 403 }) : json({ message: 'Not Found' }, { status: 404 }))).fn })
    ).getCheckRunDiagnostics(repo, 8);
    expect(none.annotations).toEqual([]);
    expect(none.logTail).toBeNull();
    expect(none.problems).toEqual([expect.stringMatching(/annotations could not be read/), expect.stringMatching(/no GitHub Actions log/)]);

    // An outage is not a missing diagnostic: it is thrown, and the step is taken again later.
    await expect(
      (await createGitHubApi({ token: 't', fetch: fakeFetch(() => json({ message: 'down' }, { status: 502 })).fn })).getCheckRunDiagnostics(repo, 9),
    ).rejects.toMatchObject({ status: 502 });
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
    expect(await api.getCommitChecks(repo, SHA)).toMatchObject({ total: 4, failing: ['ci/late-red'], pending: ['late'], succeeded: ['ci/ok', 'build'], complete: true });
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
    expect(await (await createGitHubApi({ token: 't', fetch: short.fn })).getCommitChecks(repo, SHA)).toMatchObject({ total: 1, failing: [], pending: [], succeeded: ['ci/ok'], complete: false });

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
