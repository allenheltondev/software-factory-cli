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
});
