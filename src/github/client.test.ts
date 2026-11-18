import { describe, expect, it } from 'vitest';
import { GitHubError } from './api.js';
import { createGitHubApi, parseLinkHeader, resolveGitHubToken, retryAfterFrom, type GhRunner } from './client.js';

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
  method: string | undefined;
  body: string | undefined;
}

function fakeFetch(handler: (url: URL, call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      redirect: init?.redirect,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(new URL(String(input)), call);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });

const rawRepo = (id: number, full: string) => ({
  id,
  full_name: full,
  name: full.split('/')[1],
  owner: { login: full.split('/')[0] },
  private: false,
  archived: false,
  default_branch: 'main',
  description: null,
  permissions: { admin: true, push: true, pull: true },
});

describe('resolveGitHubToken', () => {
  const ghOk: GhRunner = async () => 'gho_from_gh\n';

  it('prefers GH_TOKEN, then GITHUB_TOKEN, then gh auth token', async () => {
    expect(await resolveGitHubToken({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }, ghOk)).toBe('a');
    expect(await resolveGitHubToken({ GH_TOKEN: '  ', GITHUB_TOKEN: 'b' }, ghOk)).toBe('b');
    let args: string[] = [];
    const gh: GhRunner = async (a) => {
      args = a;
      return 'gho_from_gh\n';
    };
    expect(await resolveGitHubToken({}, gh)).toBe('gho_from_gh');
    expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
  });

  it('explains how to fix a missing gh binary', async () => {
    const gh: GhRunner = async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    };
    await expect(resolveGitHubToken({}, gh)).rejects.toThrow(/not on PATH.*gh auth login|GH_TOKEN/s);
  });

  it('explains how to fix gh not being logged in', async () => {
    const gh: GhRunner = async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'no oauth token found for github.com' });
    };
    await expect(resolveGitHubToken({}, gh)).rejects.toThrow(/no oauth token found.*gh auth login/s);
    await expect(resolveGitHubToken({}, async () => '\n')).rejects.toThrow(/gh auth login/);
  });
});

describe('createGitHubApi', () => {
  it('sends the standard headers and paginates listUserRepos via Link', async () => {
    const { fn, calls } = fakeFetch((url) => {
      const page = url.searchParams.get('page') ?? '1';
      if (page === '1') {
        return json([rawRepo(1, 'a/one')], {
          headers: { link: '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next", <https://api.github.com/user/repos?per_page=100&page=2>; rel="last"' },
        });
      }
      return json([rawRepo(2, 'b/two')]);
    });
    const api = await createGitHubApi({ token: 't0k', fetch: fn });
    const repos = await api.listUserRepos();
    expect(repos.map((r) => r.fullName)).toEqual(['a/one', 'b/two']);
    expect(repos[0]).toMatchObject({ id: 1, owner: 'a', name: 'one', defaultBranch: 'main', permissions: { push: true } });
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe('/user/repos');
    expect(first.searchParams.get('per_page')).toBe('100');
    expect(first.searchParams.get('affiliation')).toBe('owner,collaborator,organization_member');
    expect(calls[0]!.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'software-factory-cli',
      Authorization: 'Bearer t0k',
    });
  });

  it('uses stable-ID routes for issue events and supports ETag 304', async () => {
    const { fn, calls } = fakeFetch((url, call) => {
      if (call.headers['If-None-Match'] === 'W/"abc"') return new Response(null, { status: 304 });
      return json(
        [
          {
            id: 99,
            event: 'labeled',
            created_at: '2026-01-01T00:00:00Z',
            actor: { login: 'allen' },
            label: { name: 'factory:ready', color: 'fff' },
            issue: { number: 7, title: 'T', html_url: 'https://github.com/o/r/issues/7' },
          },
          { id: 98, event: 'closed', created_at: '2026-01-01T00:00:00Z', actor: null, issue: { number: 8, title: 'P', html_url: 'u', pull_request: {} } },
        ],
        { headers: { etag: 'W/"abc"', link: `<https://api.github.com/repositories/42/issues/events?per_page=100&page=2>; rel="next"` } },
      );
    });
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const repo = { id: 42, fullName: 'o/r' };
    const p1 = await api.listIssueEvents(repo, { page: 1 });
    expect(new URL(calls[0]!.url).pathname).toBe('/repositories/42/issues/events');
    expect(p1).toMatchObject({ etag: 'W/"abc"', nextPage: 2, notModified: false });
    expect(p1.events[0]).toEqual({
      id: 99,
      event: 'labeled',
      createdAt: '2026-01-01T00:00:00Z',
      actor: 'allen',
      label: 'factory:ready',
      issue: { number: 7, title: 'T', htmlUrl: 'https://github.com/o/r/issues/7', isPullRequest: false },
    });
    expect(p1.events[1]).toMatchObject({ actor: null, label: null, issue: { isPullRequest: true } });

    const p1again = await api.listIssueEvents(repo, { page: 1, etag: 'W/"abc"' });
    expect(p1again).toEqual({ events: [], nextPage: null, etag: 'W/"abc"', notModified: true });
  });

  it('lists one issue\'s events through every page, oldest first', async () => {
    const ev = (id: number, event: string, actor: string) => ({
      id,
      event,
      created_at: '2026-01-01T00:00:00Z',
      actor: { login: actor },
      label: { name: 'ready', color: 'fff' },
    });
    const { fn, calls } = fakeFetch((url) =>
      url.searchParams.get('page') === '2'
        ? json([ev(3, 'labeled', 'mallory')])
        : json([ev(1, 'labeled', 'allen'), ev(2, 'unlabeled', 'mallory')], {
            headers: { link: '<https://api.github.com/repositories/42/issues/7/events?per_page=100&page=2>; rel="next"' },
          }),
    );
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const events = await api.listEventsForIssue({ id: 42, fullName: 'o/r' }, 7);
    expect(new URL(calls[0]!.url).pathname).toBe('/repositories/42/issues/7/events');
    expect(events.map((e) => [e.id, e.event, e.actor, e.label, e.issue])).toEqual([
      [1, 'labeled', 'allen', 'ready', null],
      [2, 'unlabeled', 'mallory', 'ready', null],
      [3, 'labeled', 'mallory', 'ready', null],
    ]);
  });

  it('maps rate limits to GitHubError with retryAfterSeconds', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const { fn } = fakeFetch((url) => {
      if (url.pathname === '/user') {
        return json({ message: 'API rate limit exceeded' }, {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        });
      }
      return json({ message: 'secondary rate limit' }, { status: 429, headers: { 'retry-after': '30' } });
    });
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const e1 = await api.getViewer().catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(GitHubError);
    expect((e1 as GitHubError).status).toBe(403);
    expect((e1 as GitHubError).isRateLimit).toBe(true);
    expect((e1 as GitHubError).retryAfterSeconds).toBeGreaterThanOrEqual(118);
    expect((e1 as GitHubError).retryAfterSeconds).toBeLessThanOrEqual(121);
    expect((e1 as GitHubError).message).toMatch(/API rate limit exceeded/);

    const e2 = (await api.getRepo('o/r').catch((e: unknown) => e)) as GitHubError;
    expect(e2.status).toBe(429);
    expect(e2.retryAfterSeconds).toBe(30);
    expect(e2.isRateLimit).toBe(true);
  });

  it('gives up on a request that hangs, as a retryable network error', async () => {
    // Never answers; only the client's deadline ends the request.
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const api = await createGitHubApi({ token: 't', fetch: hang, requestTimeoutMs: 50 });
    const err = (await api.createIssueComment({ id: 42, fullName: 'o/r' }, 7, 'hi').catch((e: unknown) => e)) as GitHubError;
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(0);
    expect(err.message).toBe('POST /repositories/42/issues/7/comments: network error: timed out after 0s');
  });

  it('maps plain errors without retry info and network failures to status 0', async () => {
    const { fn } = fakeFetch(() => json({ message: 'Not Found' }, { status: 404 }));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const e = (await api.getIssue({ id: 1, fullName: 'o/r' }, 5).catch((x: unknown) => x)) as GitHubError;
    expect(e.status).toBe(404);
    expect(e.retryAfterSeconds).toBeNull();
    expect(e.isRateLimit).toBe(false);

    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const api2 = await createGitHubApi({ token: 't', fetch: broken });
    const e2 = (await api2.getViewer().catch((x: unknown) => x)) as GitHubError;
    expect(e2).toBeInstanceOf(GitHubError);
    expect(e2.status).toBe(0);
  });

  it('getIssue does not follow transfer redirects and maps labels/PR flag', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith('/9')) return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/2/issues/1' } });
      return json({ number: 5, title: 'x', body: 'do it', html_url: 'h', state: 'open', labels: [{ name: 'art' }, 'factory:ready'] });
    });
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const repo = { id: 1, fullName: 'o/r' };
    expect(await api.getIssue(repo, 5)).toEqual({
      number: 5,
      title: 'x',
      body: 'do it',
      htmlUrl: 'h',
      state: 'open',
      labels: ['art', 'factory:ready'],
      isPullRequest: false,
    });
    expect(calls[0]!.redirect).toBe('manual');
    expect(new URL(calls[0]!.url).pathname).toBe('/repositories/1/issues/5');
    const e = (await api.getIssue(repo, 9).catch((x: unknown) => x)) as GitHubError;
    expect(e).toBeInstanceOf(GitHubError);
    expect(e.status).toBe(301);
  });
});

describe('createGitHubApi: publication writes', () => {
  const rawPull = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    html_url: `https://github.com/o/r/pull/${n}`,
    state: 'open',
    draft: true,
    merged_at: null,
    body: 'b',
    head: { ref: 'factory/issue-7-job_x', repo: { id: 42 } },
    base: { ref: 'main' },
    ...extra,
  });

  it('opens a PR with POST on the stable-ID route and maps the response', async () => {
    const { fn, calls } = fakeFetch(() => json(rawPull(5), { status: 201 }));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const pr = await api.createPullRequest({ id: 42, fullName: 'o/r' }, { title: 'T', head: 'factory/issue-7-job_x', base: 'main', body: 'B', draft: true });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repositories/42/pulls' });
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer t', 'Content-Type': 'application/json' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'T', head: 'factory/issue-7-job_x', base: 'main', body: 'B', draft: true });
    expect(pr).toEqual({
      number: 5,
      htmlUrl: 'https://github.com/o/r/pull/5',
      state: 'open',
      draft: true,
      merged: false,
      headRef: 'factory/issue-7-job_x',
      headRepoId: 42,
      baseRef: 'main',
      body: 'b',
    });
  });

  it('lists PRs for a head in every state, and comments', async () => {
    const { fn, calls } = fakeFetch((url, call) => {
      if (url.pathname.endsWith('/pulls')) {
        return json([rawPull(5, { state: 'closed', merged_at: '2026-01-01T00:00:00Z', head: { ref: 'x', repo: null } })]);
      }
      if (call.method === 'POST') return json({ id: 4, html_url: 'h4', body: 'hi', user: { login: 'allen' } }, { status: 201 });
      return json([{ id: 3, html_url: 'h', body: null, user: null }]);
    });
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const repo = { id: 42, fullName: 'o/r' };
    const pulls = await api.listPullRequestsForHead(repo, { headOwner: 'o', head: 'x' });
    const q = new URL(calls[0]!.url).searchParams;
    expect(calls[0]!.method).toBe('GET');
    expect([q.get('state'), q.get('head')]).toEqual(['all', 'o:x']);
    expect(pulls[0]).toMatchObject({ state: 'closed', merged: true, headRepoId: null });
    expect(await api.listIssueComments(repo, 7)).toEqual([{ id: 3, htmlUrl: 'h', body: '', user: null }]);
    expect(new URL(calls[1]!.url).pathname).toBe('/repositories/42/issues/7/comments');
    const c = await api.createIssueComment(repo, 7, 'hello');
    expect(calls[2]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repositories/42/issues/7/comments' });
    expect(JSON.parse(calls[2]!.body!)).toEqual({ body: 'hello' });
    expect(c).toEqual({ id: 4, htmlUrl: 'h4', body: 'hi', user: 'allen' });
  });

  it('keeps the error mapping for writes, including validation details and rate limits', async () => {
    const draft = fakeFetch(() =>
      json({ message: 'Validation Failed', errors: [{ message: 'Draft pull requests are not supported in this repository.' }] }, { status: 422 }),
    );
    const api = await createGitHubApi({ token: 't', fetch: draft.fn });
    const err = await api
      .createPullRequest({ id: 42, fullName: 'o/r' }, { title: 'T', head: 'h', base: 'main', body: '', draft: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(422);
    expect((err as GitHubError).message).toBe(
      'POST /repositories/42/pulls failed: 422 Validation Failed: Draft pull requests are not supported in this repository.',
    );

    const limited = fakeFetch(() => json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'retry-after': '30' } }));
    const api2 = await createGitHubApi({ token: 't', fetch: limited.fn });
    const e2 = (await api2.createIssueComment({ id: 42, fullName: 'o/r' }, 1, 'x').catch((e: unknown) => e)) as GitHubError;
    expect(e2.isRateLimit).toBe(true);
    expect(e2.retryAfterSeconds).toBe(30);

    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const api3 = await createGitHubApi({ token: 't', fetch: down });
    const e3 = (await api3.createIssueComment({ id: 42, fullName: 'o/r' }, 1, 'x').catch((e: unknown) => e)) as GitHubError;
    expect(e3.status).toBe(0);
    expect(e3.message).toMatch(/^POST .*network error: ECONNRESET/);
  });
});

describe('createGitHubApi: issue body edits (GraphQL)', () => {
  const repo = { id: 42, fullName: 'o/r' };
  const answer = (issue: unknown, databaseId: number | null = 42) => json({ data: { repository: { databaseId, issue } } });

  it('asks GraphQL for the last edit of the issue, with the query variables kept out of the query text', async () => {
    const { fn, calls } = fakeFetch(() => answer({ lastEditedAt: '2026-01-02T03:04:05Z', editor: { login: 'mallory' } }));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    expect(await api.getIssueBodyEdit(repo, 7)).toEqual({ lastEditedAt: '2026-01-02T03:04:05Z', editor: 'mallory' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(new URL(calls[0]!.url).pathname).toBe('/graphql');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer t');
    const sent = JSON.parse(calls[0]!.body!) as { query: string; variables: unknown };
    expect(sent.variables).toEqual({ owner: 'o', name: 'r', number: 7 });
    expect(sent.query).toMatch(/repository\(owner: \$owner, name: \$name\)/);
    expect(sent.query).toMatch(/databaseId[\s\S]*issue\(number: \$number\)[\s\S]*lastEditedAt[\s\S]*editor \{ login \}/);
  });

  it('maps a never-edited body and a deleted editor account to nulls', async () => {
    const never = await createGitHubApi({ token: 't', fetch: fakeFetch(() => answer({ lastEditedAt: null, editor: null })).fn });
    expect(await never.getIssueBodyEdit(repo, 7)).toEqual({ lastEditedAt: null, editor: null });
    const ghost = await createGitHubApi({
      token: 't',
      fetch: fakeFetch(() => answer({ lastEditedAt: '2026-01-02T03:04:05Z', editor: null })).fn,
    });
    expect(await ghost.getIssueBodyEdit(repo, 7)).toEqual({ lastEditedAt: '2026-01-02T03:04:05Z', editor: null });
  });

  it('refuses an answer about a different repository that now has the name', async () => {
    const { fn } = fakeFetch(() => answer({ lastEditedAt: null, editor: null }, 999));
    const api = await createGitHubApi({ token: 't', fetch: fn });
    const err = (await api.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError;
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/"o\/r" now names repository 999, not 42/);
  });

  it('reports a missing issue as 404, and nothing else as "gone"', async () => {
    const missingIssue = fakeFetch(() =>
      json({
        data: { repository: { databaseId: 42, issue: null } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], message: 'Could not resolve to an Issue with the number of 7.' }],
      }),
    );
    const api = await createGitHubApi({ token: 't', fetch: missingIssue.fn });
    expect(((await api.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError).status).toBe(404);

    const nullIssue = await createGitHubApi({ token: 't', fetch: fakeFetch(() => answer(null)).fn });
    expect(((await nullIssue.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError).status).toBe(404);

    // The repository not resolving by name says nothing about the issue: REST reaches it by ID.
    const missingRepo = fakeFetch(() =>
      json({
        data: { repository: null },
        errors: [{ type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'o/r'." }],
      }),
    );
    const api2 = await createGitHubApi({ token: 't', fetch: missingRepo.fn });
    const e2 = (await api2.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError;
    expect(e2.status).toBe(502);
    expect(e2.message).toMatch(/edit history of o\/r#7\) failed: Could not resolve to a Repository/);

    for (const body of [{}, { data: null }, { data: { repository: null } }]) {
      const odd = await createGitHubApi({ token: 't', fetch: fakeFetch(() => json(body)).fn });
      expect(((await odd.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError).status).toBe(502);
    }
  });

  it('turns GraphQL errors sent with 200 into GitHubErrors, even next to usable-looking data', async () => {
    const partial = fakeFetch(() =>
      json({
        data: { repository: { databaseId: 42, issue: { lastEditedAt: null, editor: null } } },
        errors: [{ type: 'FORBIDDEN', path: ['repository', 'issue', 'editor'], message: 'Resource not accessible by personal access token' }],
      }),
    );
    const api = await createGitHubApi({ token: 't', fetch: partial.fn });
    const err = (await api.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError;
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/Resource not accessible/);

    const limited = fakeFetch(() =>
      json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, { headers: { 'retry-after': '30' } }),
    );
    const api2 = await createGitHubApi({ token: 't', fetch: limited.fn });
    const e2 = (await api2.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError;
    expect(e2.isRateLimit).toBe(true);
    expect(e2.retryAfterSeconds).toBe(30);
  });

  it('keeps the HTTP error mapping (401, 5xx, network)', async () => {
    const unauthorized = await createGitHubApi({
      token: 't',
      fetch: fakeFetch(() => json({ message: 'Bad credentials' }, { status: 401 })).fn,
    });
    const e1 = (await unauthorized.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError;
    expect(e1.status).toBe(401);
    expect(e1.message).toMatch(/^POST \/graphql failed: 401 Bad credentials/);

    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const api = await createGitHubApi({ token: 't', fetch: down });
    expect(((await api.getIssueBodyEdit(repo, 7).catch((e: unknown) => e)) as GitHubError).status).toBe(0);
  });
});

describe('helpers', () => {
  it('parses Link headers', () => {
    expect(parseLinkHeader('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"')).toEqual({
      next: 'https://x/a?page=2',
      last: 'https://x/a?page=9',
    });
    expect(parseLinkHeader(null)).toEqual({});
  });

  it('computes retry-after from headers', () => {
    const now = 1_000_000_000_000;
    expect(retryAfterFrom(new Headers({ 'retry-after': '5' }), now)).toBe(5);
    expect(retryAfterFrom(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 60) }), now)).toBe(60);
    expect(retryAfterFrom(new Headers({ 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '1' }), now)).toBeNull();
  });
});
