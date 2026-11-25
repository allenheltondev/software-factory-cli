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

  it('reads an installation with its permissions and the events it is subscribed to', async () => {
    const api = createGitHubApi(async () => new Response(JSON.stringify({ id: 7, account: { id: 1, login: 'acme', type: 'Organization' }, suspended_at: null,
      permissions: { contents: 'write', bogus: 3 }, events: ['issues', 'check_suite', 4] }), { status: 200 }));
    expect(await api.getInstallation('jwt', 7)).toEqual({ id: 7, account: { id: 1, login: 'acme', type: 'Organization' }, suspendedAt: null,
      permissions: { contents: 'write' }, events: ['issues', 'check_suite'] });
    const silent = createGitHubApi(async () => new Response(JSON.stringify({ id: 7, account: { id: 1, login: 'acme', type: 'User' }, suspended_at: null }), { status: 200 }));
    expect(await silent.getInstallation('jwt', 7)).not.toHaveProperty('events');
  });

  it('says when the installation reaches more repositories than it lists', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, full_name: `acme/r${i}`, private: false, html_url: '' }));
    const many = createGitHubApi(async () => new Response(JSON.stringify({ repositories: full }), { status: 200 }));
    const listed = await many.listInstallationRepositories('ghs_x');
    expect(listed).toHaveLength(1000);
    expect(listed.truncated).toBe(true);
    const few = createGitHubApi(async () => new Response(JSON.stringify({ repositories: full.slice(0, 3) }), { status: 200 }));
    expect((await few.listInstallationRepositories('ghs_x')).truncated).toBeUndefined();
  });

  it('fails on a refused comment', async () => {
    const api = createGitHubApi(async () => new Response('{}', { status: 403 }));
    await expect(api.createIssueComment('ghs_x', 'acme/web', 12, 'x')).rejects.toBeInstanceOf(GitHubError);
  });

  it('posts a comment it can edit later, finds it again by its marker, and edits it in place', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createGitHubApi(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('/comments?')) {
        return new Response(JSON.stringify([{ id: 5, body: 'someone else <!-- updraft-queue: job_a -->', user: { login: 'mallory' } }, { id: 6, body: 'x <!-- updraft-queue: job_a -->', user: { login: 'updraft[bot]' } }]), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 77 }), { status: 201 });
    });
    expect(await api.postIssueComment!('ghs_x', 'acme/web', 12, 'queued')).toBe(77);
    // Only the App's own comment counts: anyone can paste a marker.
    expect(await api.findIssueComment!('ghs_x', 'acme/web', 12, '<!-- updraft-queue: job_a -->', 'updraft[bot]')).toBe(6);
    expect(await api.findIssueComment!('ghs_x', 'acme/web', 12, '<!-- updraft-queue: job_b -->', 'updraft[bot]')).toBeNull();
    await api.updateIssueComment!('ghs_x', 'acme/web', 77, 'started');
    expect(calls.at(-1)!.url).toBe('https://api.github.com/repos/acme/web/issues/comments/77');
    expect(calls.at(-1)!.init.method).toBe('PATCH');
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

  it('lists open labeled issues without pull requests, and finds the newest application of a label', async () => {
    const urls: string[] = [];
    const api = createGitHubApi(async (url) => {
      urls.push(String(url));
      if (String(url).includes('/events')) {
        return new Response(JSON.stringify([
          { id: 1, event: 'labeled', label: { name: 'Updraft' }, actor: { login: 'old' }, created_at: '2026-11-20T00:00:00Z' },
          { id: 2, event: 'unlabeled', label: { name: 'updraft' }, actor: { login: 'x' }, created_at: '2026-11-21T00:00:00Z' },
          { id: 3, event: 'labeled', label: { name: 'updraft' }, actor: { login: 'pat' }, created_at: '2026-11-22T00:00:00Z' },
          { id: 4, event: 'labeled', label: { name: 'other' }, actor: { login: 'y' }, created_at: '2026-11-23T00:00:00Z' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([
        { number: 7, title: 'a', html_url: 'u7', labels: [{ name: 'updraft' }] },
        { number: 8, title: 'pr', html_url: 'u8', labels: [], pull_request: {} },
      ]), { status: 200 });
    });
    expect(await api.labeledIssues!('ghs_x', 'acme/web', 'updraft', '2026-11-24T00:00:00Z', 20)).toEqual([{ number: 7, title: 'a', htmlUrl: 'u7', labels: ['updraft'] }]);
    expect(urls[0]).toContain('/repos/acme/web/issues?state=open&labels=updraft&since=2026-11-24T00%3A00%3A00Z');
    expect(await api.latestLabelEvent!('ghs_x', 'acme/web', 7, 'UPDRAFT')).toEqual({ id: 3, actor: 'pat', createdAt: '2026-11-22T00:00:00Z', label: 'updraft' });
  });
});
