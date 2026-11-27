import { describe, expect, it } from 'vitest';
import { GitHubError, type GitHubApi } from './api.js';
import { createUserPublisher, PublisherError } from './publisher.js';

const REPO = { id: 42, fullName: 'octo/widgets' };

function api(o: { who?: { kind?: string; login: string; id: number } | GitHubError; repo?: { id: number; push: boolean } | GitHubError } = {}): GitHubApi {
  return {
    async getWorkerIdentity() {
      if (o.who instanceof GitHubError) throw o.who;
      return { kind: 'user', ...(o.who ?? { login: 'alice', id: 7 }) };
    },
    async getRepo(fullName: string) {
      if (o.repo instanceof GitHubError) throw o.repo;
      const r = o.repo ?? { id: 42, push: true };
      return { id: r.id, fullName, permissions: { admin: false, push: r.push, pull: true } };
    },
  } as unknown as GitHubApi;
}

const make = (a: GitHubApi, expected: { login: string; id?: number } = { login: 'alice' }, readToken: () => Promise<string> = async () => 'gho_tok') =>
  createUserPublisher({ expected, readToken, apiFor: async () => a });

async function problem(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PublisherError);
  return (err as PublisherError).problem;
}

describe('createUserPublisher', () => {
  it('hands back the token it checked, with the account it belongs to', async () => {
    const v = await make(api()).verify(REPO);
    expect(v).toMatchObject({ login: 'alice', id: 7, token: 'gho_tok' });
  });

  it('compares logins without regard to case, and checks the id when one is configured', async () => {
    expect((await make(api({ who: { login: 'Alice', id: 7 } })).verify(REPO)).login).toBe('Alice');
    expect(await problem(make(api({ who: { login: 'alice', id: 8 } }), { login: 'alice', id: 7 }).verify(REPO))).toBe('wrong-account');
  });

  it('refuses another account, a bot, a missing or revoked sign-in', async () => {
    expect(await problem(make(api({ who: { login: 'mallory', id: 66 } })).verify(REPO))).toBe('wrong-account');
    expect(await problem(make(api({ who: { kind: 'app', login: 'alice[bot]', id: 7 } })).verify(REPO))).toBe('not-a-person');
    expect(await problem(make(api(), undefined, async () => Promise.reject(new Error('gh is not signed in'))).verify(REPO))).toBe('signed-out');
    expect(await problem(make(api({ who: new GitHubError('Bad credentials', 401) })).verify(REPO))).toBe('signed-out');
  });

  it('refuses a repository the account cannot reach, cannot push to, or that is another one by id', async () => {
    expect(await problem(make(api({ repo: new GitHubError('Not Found', 404) })).verify(REPO))).toBe('no-access');
    expect(await problem(make(api({ repo: { id: 42, push: false } })).verify(REPO))).toBe('no-push');
    expect(await problem(make(api({ repo: { id: 43, push: true } })).verify(REPO))).toBe('no-access');
  });

  it('lets a transient GitHub failure through as it is, to be retried, not as a refusal', async () => {
    const err = await make(api({ who: new GitHubError('Bad Gateway', 502) })).verify(REPO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).not.toBeInstanceOf(PublisherError);
  });

  it('binds each check to its own token: a sign-in switched between two checks is checked again, never mixed', async () => {
    // Two concurrent checks; the sign-in changes in between (gh auth switch, a refreshed token).
    const tokens = ['gho_first', 'gho_second'];
    const whoFor: Record<string, { login: string; id: number }> = { gho_first: { login: 'alice', id: 7 }, gho_second: { login: 'mallory', id: 66 } };
    const publisher = createUserPublisher({
      expected: { login: 'alice' },
      readToken: async () => tokens.shift()!,
      apiFor: async (t) => api({ who: whoFor[t]! }),
    });
    const [a, b] = await Promise.allSettled([publisher.verify(REPO), publisher.verify(REPO)]);
    expect(a).toMatchObject({ status: 'fulfilled', value: { token: 'gho_first', login: 'alice' } });
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ problem: 'wrong-account' });
  });
});
