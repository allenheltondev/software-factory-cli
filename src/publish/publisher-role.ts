// Which identity the coding agent's side of a pull request is written as (docs/github-app.md,
// "Publishing as a person"): the push of the job branch, the pull request, revision and CI-fix
// pushes, and the coding agent's replies. Everything else Updraft writes (the reviewer's review
// and threads, the issue's status comment, CI and merge notices, the merge itself) keeps the
// worker's own identity, deps.api: with github.app, the App.
//
// A pull request keeps the publisher it was opened with. A new publication takes
// repositories.<repo>.publishAs; one that already pushed or opened its pull request, and every
// revision of it, takes what was recorded (publications.publisher_*). A publication from before
// that was recorded is the worker's. So turning publishAs on or off never moves a pull request to
// another identity half way through its loop, and a recorded person who is no longer configured,
// or whose sign-in is now another account's, stops the step: it is never written as the App instead.
import { publishMode, type RepositoryConfig } from '../config/schema.js';
import { getPublication } from '../db/publications.js';
import { getRevisionPr } from '../db/revisions.js';
import { findRepoConfig } from '../worker/executor.js';
import type { GitHubApi } from '../github/api.js';
import type { WorkerKind } from '../github/credentials.js';
import { workerLogin } from '../github/identity.js';
import { describeExpected, PublisherError } from '../github/publisher.js';
import { reviewOf, revisionOf, type Job, type PublisherRecord, type RepoRef } from '../types.js';
import { PublishRefusal, type PublishDeps } from './publish.js';

export interface CodingRole {
  /** Who it is: the recorded or checked person, or the recorded worker; null for the worker when nothing was recorded (whoRecord fills it in). */
  record: PublisherRecord | null;
  /** For the pull request and the coding agent's comments and replies. */
  api: GitHubApi;
  /** The push token for exactly the role's repository. */
  token: (repoFullName: string) => Promise<string>;
  workerKind: WorkerKind;
  /** Push over HTTPS with the token, never with the clone's SSH key: a key's account can't be checked. */
  httpsPush: boolean;
}

/** Which publisher a step takes: what was recorded, else (nothing done yet) the config's. */
export function publisherKindFor(repo: Pick<RepositoryConfig, 'publishAs'>, recorded: PublisherRecord | null, started: boolean): PublisherRecord['kind'] {
  if (recorded) return recorded.kind;
  if (started) return 'worker';
  return repo.publishAs === 'user' ? 'user' : 'worker';
}

/**
 * The coding role for one step on `repo`. `recorded` is the publication's publisher (null when
 * none was recorded); `started` says whether the publication already pushed or opened its PR.
 * Throws PublishRefusal when the person can't be published as, and never returns the worker's
 * identity in their place.
 */
export async function codingRole(
  deps: Pick<PublishDeps, 'api' | 'token' | 'workerKind' | 'publisher'>,
  o: { repo: RepoRef; config: Pick<RepositoryConfig, 'publishAs'>; recorded: PublisherRecord | null; started: boolean },
): Promise<CodingRole> {
  const kind = publisherKindFor(o.config, o.recorded, o.started);
  if (kind === 'worker') {
    return {
      record: o.recorded,
      api: deps.api,
      token: deps.token,
      workerKind: deps.workerKind ?? 'user',
      httpsPush: false,
    };
  }
  const who = o.recorded ? describeExpected({ login: o.recorded.login, ...(o.recorded.id !== null ? { id: o.recorded.id } : {}) }) : 'the person of github.publisher';
  if (!deps.publisher) {
    throw new PublishRefusal(
      `this pull request is published as ${who}, but github.publisher is not configured (or this command was started without it); ` +
        'Updraft does not switch it to the GitHub App. Configure github.publisher again, or close the pull request',
    );
  }
  const expected = deps.publisher.expected;
  if (o.recorded && (o.recorded.login.toLowerCase() !== expected.login.toLowerCase() || (o.recorded.id !== null && expected.id !== undefined && o.recorded.id !== expected.id))) {
    throw new PublishRefusal(
      `this pull request is published as ${who}, but github.publisher now names ${describeExpected(expected)}; a pull request keeps its publisher, ` +
        'so Updraft does not continue it as another account. Name the original account again, or close the pull request',
    );
  }
  let verified;
  try {
    verified = await deps.publisher.verify(o.repo);
  } catch (err) {
    if (err instanceof PublisherError) throw new PublishRefusal(`cannot publish as ${describeExpected(expected)}: ${err.message}`);
    throw err;
  }
  if (o.recorded?.id !== null && o.recorded?.id !== undefined && o.recorded.id !== verified.id) {
    throw new PublishRefusal(`this pull request is published as ${who}, but the sign-in is account ${verified.id}; refusing to continue it as another account`);
  }
  const token = verified.token;
  const only = o.repo.fullName.toLowerCase();
  return {
    record: { kind: 'user', login: verified.login, id: verified.id },
    api: verified.api,
    token: async (repoFullName) => {
      if (repoFullName.toLowerCase() !== only) throw new PublishRefusal(`the publication token of ${verified.login} is for ${o.repo.fullName}, not ${repoFullName}`);
      return token;
    },
    workerKind: 'user',
    httpsPush: true,
  };
}

/**
 * Before a job starts (the worker's pre-start check): a job whose result is to be published as the
 * person (an issue job of a repository with publishAs user, or a revision or CI fix of a pull
 * request recorded as theirs) is held while their sign-in can't be: it throws, and the job stays
 * queued with the reason recorded, instead of running an agent whose work could not be pushed.
 * Reviewer jobs never act as the publisher and are not checked.
 */
export async function checkPublisherForJob(deps: Pick<PublishDeps, 'db' | 'config' | 'api' | 'token' | 'workerKind' | 'publisher'>, job: Job): Promise<void> {
  if (reviewOf(job)) return;
  const found = findRepoConfig(deps.config, job);
  if (!found || publishMode(found.repo) === 'none') return;
  const revision = revisionOf(job);
  let recorded: PublisherRecord | null = null;
  if (revision) {
    const watched = getRevisionPr(deps.db, job.repoId, revision.pullRequest.number);
    recorded = watched ? (getPublication(deps.db, watched.sourceRunId)?.publisher ?? null) : null;
  }
  if (publisherKindFor(found.repo, recorded, Boolean(revision)) !== 'user') return;
  await codingRole(deps, { repo: { id: job.repoId, fullName: found.fullName }, config: found.repo, recorded, started: Boolean(revision) });
}

/** The repositories that publish as the person of github.publisher. */
export function publishingAsPerson(config: { repositories: Record<string, Pick<RepositoryConfig, 'publishAs'>> }): string[] {
  return Object.entries(config.repositories)
    .filter(([, r]) => r.publishAs === 'user')
    .map(([name]) => name);
}

/** The role's record, with the worker's own login when nothing was recorded (one cached lookup). */
export async function whoRecord(api: Pick<GitHubApi, 'getWorkerIdentity'>, role: CodingRole): Promise<PublisherRecord> {
  return role.record ?? { kind: 'worker', login: await workerLogin(api), id: null };
}
