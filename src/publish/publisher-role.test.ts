import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { createUserPublisher, type UserPublisher } from '../github/publisher.js';
import type { Job } from '../types.js';
import { checkPublisherForJob, codingRole, publisherKindFor, publishingAsPerson, whoRecord } from './publisher-role.js';
import { PublishRefusal } from './publish.js';

const REPO = { id: 42, fullName: 'octo/widgets' };
const appApi = { getWorkerIdentity: async () => ({ kind: 'app', login: 'updraft[bot]', id: 9, appSlug: 'updraft' }) } as unknown as GitHubApi;

function person(o: { login?: string; id?: number; push?: boolean; fail?: Error } = {}): { publisher: UserPublisher; verified: () => number; api: GitHubApi } {
  let n = 0;
  const api = {
    async getWorkerIdentity() {
      if (o.fail) throw o.fail;
      return { kind: 'user', login: o.login ?? 'alice', id: o.id ?? 7 };
    },
    async getRepo(fullName: string) {
      return { id: 42, fullName, permissions: { admin: false, push: o.push ?? true, pull: true } };
    },
  } as unknown as GitHubApi;
  const publisher = createUserPublisher({ expected: { login: 'alice' }, readToken: async () => (n++, 'gho_person'), apiFor: async () => api });
  return { publisher, verified: () => n, api };
}

const base = { api: appApi, token: async () => 'ghs_app', workerKind: 'app' as const };

describe('publisherKindFor', () => {
  it('takes what was recorded; else the worker once anything was done; else the config', () => {
    expect(publisherKindFor({ publishAs: 'user' }, { kind: 'worker', login: 'updraft[bot]', id: null }, true)).toBe('worker');
    expect(publisherKindFor({}, { kind: 'user', login: 'alice', id: 7 }, true)).toBe('user');
    expect(publisherKindFor({ publishAs: 'user' }, null, true)).toBe('worker');
    expect(publisherKindFor({ publishAs: 'user' }, null, false)).toBe('user');
    expect(publisherKindFor({}, null, false)).toBe('worker');
  });
});

describe('codingRole', () => {
  it('is the worker itself by default: its API, its token, unchanged', async () => {
    const p = person();
    const role = await codingRole({ ...base, publisher: p.publisher }, { repo: REPO, config: {}, recorded: null, started: false });
    expect(role).toMatchObject({ record: null, workerKind: 'app', httpsPush: false });
    expect(await whoRecord(appApi, role)).toEqual({ kind: 'worker', login: 'updraft[bot]', id: null });
    expect(role.api).toBe(appApi);
    expect(await role.token(REPO.fullName)).toBe('ghs_app');
    expect(p.verified()).toBe(0);
  });

  it('is the checked person for publishAs user: their API, their token for exactly this repository, over HTTPS', async () => {
    const p = person();
    const role = await codingRole({ ...base, publisher: p.publisher }, { repo: REPO, config: { publishAs: 'user' }, recorded: null, started: false });
    expect(role).toMatchObject({ record: { kind: 'user', login: 'alice', id: 7 }, workerKind: 'user', httpsPush: true });
    expect(role.api).toBe(p.api);
    expect(await role.token('OCTO/widgets')).toBe('gho_person');
    await expect(role.token('octo/other')).rejects.toBeInstanceOf(PublishRefusal);
    expect(p.verified()).toBe(1);
  });

  it('never returns the worker in place of a person who cannot be published as', async () => {
    for (const o of [{ login: 'mallory' }, { push: false }, { fail: new GitHubError('Bad credentials', 401) }]) {
      const p = person(o);
      await expect(codingRole({ ...base, publisher: p.publisher }, { repo: REPO, config: { publishAs: 'user' }, recorded: null, started: false })).rejects.toBeInstanceOf(PublishRefusal);
    }
    await expect(codingRole(base, { repo: REPO, config: { publishAs: 'user' }, recorded: null, started: false })).rejects.toBeInstanceOf(PublishRefusal);
  });

  it('keeps a recorded person: refused when unconfigured, renamed to someone else, or another account by id', async () => {
    const recorded = { kind: 'user' as const, login: 'alice', id: 7 };
    await expect(codingRole(base, { repo: REPO, config: {}, recorded, started: true })).rejects.toThrow(/does not switch it to the GitHub App/);
    const bob = createUserPublisher({ expected: { login: 'bob' }, readToken: async () => 'x', apiFor: async () => person().api });
    await expect(codingRole({ ...base, publisher: bob }, { repo: REPO, config: {}, recorded, started: true })).rejects.toThrow(/now names bob/);
    const sameNameOtherAccount = person({ id: 8 });
    await expect(codingRole({ ...base, publisher: sameNameOtherAccount.publisher }, { repo: REPO, config: {}, recorded, started: true })).rejects.toThrow(/account 8/);
  });

  it('lets a transient failure through to be retried', async () => {
    const p = person({ fail: new GitHubError('Bad Gateway', 502) });
    const err = await codingRole({ ...base, publisher: p.publisher }, { repo: REPO, config: { publishAs: 'user' }, recorded: null, started: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
  });
});

describe('checkPublisherForJob', () => {
  const dbs: Db[] = [];
  afterEach(() => {
    for (const d of dbs.splice(0)) d.close();
  });
  const config = (publishAs?: 'user' | 'app'): UpdraftConfig =>
    configSchema.parse({
      version: 1,
      execution: { mode: 'live' },
      github: { app: { appId: 1, privateKeyPath: './k.pem' }, publisher: { login: 'alice' } },
      agents: { claude: {} },
      pools: { general: { agents: ['claude'] } },
      actions: { implement: { prompt: './p.md', output: 'local-branch' } },
      repositories: {
        [REPO.fullName]: { id: REPO.id, checkoutPath: './c', publish: 'pr', review: true, ...(publishAs ? { publishAs } : {}), workflows: [{ trigger: { event: 'issue.labeled', label: 'go' }, action: 'implement', pool: 'general' }] },
      },
    });
  const job = (type: string, extra: Record<string, unknown> = {}) => ({ repoId: REPO.id, repoFullName: REPO.fullName, envelope: { type, ...extra } }) as unknown as Job;

  it('checks the person before an issue job of a repository that publishes as them, and holds it while it fails', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const ok = person();
    await checkPublisherForJob({ ...base, db, config: config('user'), publisher: ok.publisher }, job('issue.labeled'));
    expect(ok.verified()).toBe(1);
    const bad = person({ login: 'mallory' });
    await expect(checkPublisherForJob({ ...base, db, config: config('user'), publisher: bad.publisher }, job('issue.labeled'))).rejects.toThrow(/mallory/);
  });

  it('never reads the person\'s sign-in for a reviewer job, or for a repository that publishes as the App', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const p = person();
    await checkPublisherForJob({ ...base, db, config: config('user'), publisher: p.publisher }, job('pull_request.review', { review: { pullRequest: { number: 5 } } }));
    await checkPublisherForJob({ ...base, db, config: config('app'), publisher: p.publisher }, job('issue.labeled'));
    // A revision of a pull request with no publisher on record is the worker's, as before.
    await checkPublisherForJob({ ...base, db, config: config('user'), publisher: p.publisher }, job('pull_request.changes_requested', { revision: { pullRequest: { number: 5 } } }));
    expect(p.verified()).toBe(0);
  });

  it('lists the repositories that publish as the person', () => {
    expect(publishingAsPerson(config('user'))).toEqual([REPO.fullName]);
    expect(publishingAsPerson(config())).toEqual([]);
  });
});
