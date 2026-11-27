// The consenting person Updraft publishes as (github.publisher, docs/github-app.md "Publishing as a
// person"). With repositories.<repo>.publishAs user, the coding agent's side of the pull request
// (pushes, the pull request itself, the coding agent's replies) is written with that person's own
// `gh` sign-in, while everything else (reviews, notices, merges) stays the GitHub App's.
//
// The rules this file holds to:
// - Explicit. The account is the one named in the config; the token's account is checked against
//   it on every use. Nothing is ever taken from the issue's author, the label's actor or the
//   installation's owner.
// - One token per check. `verify` reads a token, asks GitHub whose it is and whether it may push
//   to the exact repository (by id), and hands back that token and an API bound to it, so a
//   `gh auth switch` between the check and the push cannot change who pushes.
// - No fallback. A token of another account, a revoked or missing sign-in, a repository the
//   account cannot push to: each is a PublisherError, and the caller stops. It never retries
//   with the App's credentials or any other.
// - Only for publication. Nothing here is handed to an agent, a reviewer or the review API: the
//   token lives in the worker process for one publication step and is redacted from what it logs.
import type { RepoRef } from '../types.js';
import { GitHubError, type GitHubApi } from './api.js';
import { sameLogin } from './identity.js';

export type PublisherProblem =
  /** The sign-in belongs to another account than github.publisher names. */
  | 'wrong-account'
  /** No token, or GitHub refused it (expired, revoked, signed out). */
  | 'signed-out'
  /** The account cannot see the repository, or it is another repository by now (renamed or replaced). */
  | 'no-access'
  /** The account can see the repository but not push to it. */
  | 'no-push'
  /** The token is not a person's (an App's or another bot's). */
  | 'not-a-person';

/** Why Updraft will not publish as the person. Never retried with another identity. */
export class PublisherError extends Error {
  constructor(
    message: string,
    readonly problem: PublisherProblem,
  ) {
    super(message);
    this.name = 'PublisherError';
  }
}

export interface ExpectedPublisher {
  login: string;
  id?: number;
}

/** One check's answer: who the token belongs to, the token, and an API that uses only it. */
export interface VerifiedPublisher {
  login: string;
  id: number;
  token: string;
  api: GitHubApi;
}

export interface UserPublisher {
  readonly expected: ExpectedPublisher;
  /** Check, now, that a fresh token is the expected account's and may push to `repo`. Throws PublisherError. */
  verify(repo: RepoRef): Promise<VerifiedPublisher>;
}

export interface UserPublisherOptions {
  expected: ExpectedPublisher;
  /** A newly read token of the person's sign-in (resolveGitHubToken). */
  readToken: () => Promise<string>;
  /** An API that acts with exactly this token. */
  apiFor: (token: string) => Promise<GitHubApi>;
}

const SETUP = 'docs/github-app.md, "Publishing as a person"';

export function describeExpected(e: ExpectedPublisher): string {
  return e.id !== undefined ? `${e.login} (id ${e.id})` : e.login;
}

export function createUserPublisher(o: UserPublisherOptions): UserPublisher {
  const want = describeExpected(o.expected);
  return {
    expected: o.expected,
    async verify(repo) {
      let token: string;
      try {
        token = await o.readToken();
      } catch (err) {
        throw new PublisherError(
          `no GitHub sign-in to publish as ${want} (${err instanceof Error ? err.message : String(err)}); sign in with \`gh auth login\` as ${o.expected.login}. Updraft does not publish as anyone else instead`,
          'signed-out',
        );
      }
      const api = await o.apiFor(token);
      let who: { login: string; id: number; kind: string };
      try {
        who = await api.getWorkerIdentity();
      } catch (err) {
        if (err instanceof GitHubError && (err.status === 401 || err.status === 403)) {
          throw new PublisherError(
            `GitHub refused the sign-in that is to publish as ${want} (${err.status}): it expired or was revoked. Sign in again with \`gh auth login\` as ${o.expected.login}`,
            'signed-out',
          );
        }
        throw err;
      }
      if (who.kind !== 'user' || who.login.endsWith('[bot]')) {
        throw new PublisherError(`the sign-in to publish with is ${who.login}, not a person's account; github.publisher must be a person (${SETUP})`, 'not-a-person');
      }
      if (!sameLogin(who.login, o.expected.login) || (o.expected.id !== undefined && who.id !== o.expected.id)) {
        throw new PublisherError(
          `the gh sign-in is ${who.login} (id ${who.id}), but github.publisher names ${want}. Updraft publishes only as the account that agreed to it: ` +
            `switch with \`gh auth switch --user ${o.expected.login}\`, or change github.publisher (${SETUP})`,
          'wrong-account',
        );
      }
      let found;
      try {
        found = await api.getRepo(repo.fullName);
      } catch (err) {
        if (err instanceof GitHubError && (err.status === 404 || err.status === 403)) {
          throw new PublisherError(`${who.login} cannot reach ${repo.fullName} (${err.status}); grant the account access, or set publishAs back to app`, 'no-access');
        }
        throw err;
      }
      if (found.id !== repo.id) {
        throw new PublisherError(
          `${repo.fullName} as ${who.login} sees it is repository ${found.id}, not the configured ${repo.id}; refusing to publish to another repository`,
          'no-access',
        );
      }
      if (!found.permissions?.push) {
        throw new PublisherError(`${who.login} cannot push to ${repo.fullName}; grant the account write access, or set publishAs back to app`, 'no-push');
      }
      return { login: who.login, id: who.id, token, api };
    },
  };
}
