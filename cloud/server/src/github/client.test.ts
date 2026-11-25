import { describe, expect, it } from 'vitest';
import { createGitHubApi, GitHubError } from './client.js';

describe('the GitHub client', () => {
  it('comments on an issue with the installation token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createGitHubApi(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    });
    await api.createIssueComment('ghs_x', 'acme/web', 12, 'over quota');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/web/issues/12/comments');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ body: 'over quota' });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer ghs_x');
  });

  it('fails on a refused comment', async () => {
    const api = createGitHubApi(async () => new Response('{}', { status: 403 }));
    await expect(api.createIssueComment('ghs_x', 'acme/web', 12, 'x')).rejects.toBeInstanceOf(GitHubError);
  });

  it('reads a pull request\'s state and head', async () => {
    const api = createGitHubApi(async () => new Response(JSON.stringify({ state: 'closed', merged: true, head: { sha: 'abc', ref: 'updraft/x' } }), { status: 200 }));
    expect(await api.pullRequestHead!('ghs_x', 'acme/web', 12)).toEqual({ state: 'closed', merged: true, headSha: 'abc', headRef: 'updraft/x' });
  });

  it('counts a commit\'s check runs and statuses together, and says when a listing was not read to its end', async () => {
    const urls: string[] = [];
    const api = createGitHubApi(async (url) => {
      urls.push(String(url));
      if (String(url).includes('/check-runs')) {
        return new Response(JSON.stringify({ total_count: 3, check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }, { status: 'in_progress' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ total_count: 2, statuses: [{ state: 'success' }, { state: 'error' }] }), { status: 200 });
    });
    expect(await api.commitChecks!('ghs_x', 'acme/web', 'abc')).toEqual({ total: 5, pending: 1, failed: 2, passed: 2, complete: true });
    expect(urls[0]).toBe('https://api.github.com/repos/acme/web/commits/abc/check-runs?per_page=100&page=1');

    const partial = createGitHubApi(async (url) =>
      String(url).includes('/check-runs')
        ? new Response(JSON.stringify({ total_count: 5, check_runs: [{ status: 'completed', conclusion: 'success' }] }), { status: 200 })
        : new Response(JSON.stringify({ total_count: 0, statuses: [] }), { status: 200 }),
    );
    expect((await partial.commitChecks!('ghs_x', 'acme/web', 'abc')).complete).toBe(false);
  });
});
