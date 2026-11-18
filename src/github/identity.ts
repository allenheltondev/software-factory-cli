// The worker's own GitHub login: the account its pull requests, comments and reviews are written
// as. Everything that needs "is this ours?" or "who are we?" asks here and nowhere else, so that
// another kind of identity (a GitHub App, whose login is "<app-slug>[bot]") has one place to plug in.
import type { GitHubApi } from './api.js';

const cache = new WeakMap<object, Promise<string>>();

/**
 * The login the worker acts as on GitHub. One request per API client, then remembered; a failed
 * lookup is not remembered.
 */
export function workerLogin(api: Pick<GitHubApi, 'getViewer'>): Promise<string> {
  let known = cache.get(api);
  if (!known) {
    known = api.getViewer().then((v) => v.login);
    cache.set(api, known);
    known.catch(() => cache.delete(api));
  }
  return known;
}

/** GitHub logins compare without regard to case. */
export function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}
