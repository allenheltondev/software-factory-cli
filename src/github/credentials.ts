// The one place that answers "which credentials does the worker act with on GitHub, and who is
// it there". Two kinds:
// - user (the default): the person's own account, through GH_TOKEN / GITHUB_TOKEN or `gh auth token`.
// - app (github.app in the config): a GitHub App installation, `<app-slug>[bot]`, with tokens
//   that last an hour and reach only the repositories the App is installed on. Minted with the
//   App's private key (app-auth.ts), or read from a token file that something else keeps
//   current, so the worker never holds the key (token-file-auth.ts).
//
// The API client (client.ts) asks the provider for a token per request, and publication asks it
// for one per push; neither knows which kind it has. An installation token belongs to one
// installation, so a token is always asked for a repository.
//
// Who the worker is: `GitHubApi.getWorkerIdentity()` (WorkerIdentity below), and
// `isWorkerLogin(identity, login)` to recognise the worker's own comments, reviews and events.
import { isAbsolute, resolve } from 'node:path';
import type { UpdraftConfig } from '../config/schema.js';
import type { Logger } from '../util/log.js';
import { APP_KEY_PATH_ENV, APP_TOKEN_FILE_ENV, createAppAuth, GitHubAppError, loadAppPrivateKey, type AppAuth, type GitHubApp } from './app-auth.js';
import { createTokenFileAuth, loadTokenFile } from './token-file-auth.js';

export type WorkerKind = 'user' | 'app';

export interface GitHubCredentials {
  readonly kind: WorkerKind;
  /**
   * A token for a request about `repoFullName` (OWNER/REPO), or null for a request that is about
   * no repository (which only a user can make). `fresh` asks for a newly issued one instead of a
   * cached one: publication does, for each push.
   */
  token(repoFullName: string | null, opts?: { fresh?: boolean }): Promise<string>;
  /** GitHub answered 401 to this token: do not hand it out again. */
  reject(token: string): void;
  /** Set for kind 'app'. */
  readonly app?: AppAuth;
}

/** Who the worker is on GitHub: whose name its pull requests, comments and pushes carry. */
export interface WorkerIdentity {
  kind: WorkerKind;
  /**
   * The login as the REST API reports it: the account's login, or `<app-slug>[bot]` for an App.
   * Compare with isWorkerLogin, not with `===`: GraphQL names a bot without the `[bot]` suffix.
   */
  login: string;
  /** The user's account id, or the App's id (not its bot user's) for kind 'app'. */
  id: number;
  /** Kind 'app': the App's slug, as in https://github.com/apps/<slug>. */
  appSlug?: string;
}

export function userIdentity(viewer: { login: string; id: number }): WorkerIdentity {
  return { kind: 'user', login: viewer.login, id: viewer.id };
}

export function appIdentity(app: Pick<GitHubApp, 'id' | 'slug'>): WorkerIdentity {
  return { kind: 'app', login: `${app.slug}[bot]`, id: app.id, appSlug: app.slug };
}

/**
 * Is `login` (an author, actor or editor GitHub reported) the worker itself? Case-insensitive.
 * For an App, the REST API reports `<slug>[bot]` and GraphQL reports `<slug>` (with `__typename`
 * Bot), so both spellings match. A person's login can never contain `[`, so the REST form is
 * unambiguous; the GraphQL form could in principle be a user account of the same name, so a
 * decision that grants something should also check the GraphQL `__typename`.
 */
export function isWorkerLogin(identity: WorkerIdentity, login: string | null | undefined): boolean {
  if (!login) return false;
  const l = login.toLowerCase();
  if (l === identity.login.toLowerCase()) return true;
  return identity.kind === 'app' && identity.appSlug !== undefined && l === identity.appSlug.toLowerCase();
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * The person's own account. `read` finds the token (resolveGitHubToken); it is read once and kept,
 * as the API client always has, and read again for `fresh`.
 */
export function createUserCredentials(read: () => Promise<string>): GitHubCredentials {
  let cached: Promise<string> | undefined;
  return {
    kind: 'user',
    token(_repoFullName, opts) {
      if (opts?.fresh || !cached) {
        const p = read();
        cached = p;
        void p.catch(() => {
          if (cached === p) cached = undefined;
        });
      }
      return cached;
    },
    reject() {
      cached = undefined;
    },
  };
}

export function createAppCredentials(auth: AppAuth): GitHubCredentials {
  return {
    kind: 'app',
    app: auth,
    async token(repoFullName, opts) {
      if (!repoFullName) {
        throw new GitHubAppError(
          'this request is not about one repository, so it cannot be made as a GitHub App installation; it needs a ' +
            'person\'s GitHub sign-in ("updraft configure" and "updraft add" use `gh` for that reason)',
          'not-for-apps',
        );
      }
      return (await auth.installationToken(repoFullName, opts)).token;
    },
    reject: (token) => auth.reject(token),
  };
}

export type GitHubAppConfig = NonNullable<NonNullable<UpdraftConfig['github']>['app']>;

/**
 * Where the App's token file is (token-file-auth.ts), or null when the identity comes from the
 * private key: UPDRAFT_GITHUB_APP_TOKEN_FILE if set, else github.app.tokenFile; relative to the
 * config file's directory. A token file wins over a key.
 */
export function appTokenFilePath(app: Pick<GitHubAppConfig, 'tokenFile'>, o: { configDir: string; env: NodeJS.ProcessEnv }): string | null {
  const p = o.env[APP_TOKEN_FILE_ENV]?.trim() || app.tokenFile;
  if (!p) return null;
  return isAbsolute(p) ? p : resolve(o.configDir, p);
}

/** Where the App's private key is: the path in the environment variable if set, else the config's; relative to the config file's directory. */
export function appPrivateKeyPath(app: Pick<GitHubAppConfig, 'privateKeyPath'>, o: { configDir: string; env: NodeJS.ProcessEnv }): string {
  const p = o.env[APP_KEY_PATH_ENV]?.trim() || app.privateKeyPath;
  if (!p) {
    throw new GitHubAppError(`github.app has no privateKeyPath (and ${APP_KEY_PATH_ENV} is not set)`, 'key');
  }
  return isAbsolute(p) ? p : resolve(o.configDir, p);
}

export interface WorkerCredentialOptions {
  configDir: string;
  env: NodeJS.ProcessEnv;
  /** Finds the person's token (resolveGitHubToken); used only when no App is configured. */
  userToken: () => Promise<string>;
  log?: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The credentials the worker, `updraft publish` and `updraft doctor` act with: the configured
 * GitHub App, else the person's account. With an App, the key is read once here so a missing or
 * unusable key stops the command at once with what to change (GitHubAppError).
 */
export function createWorkerCredentials(config: Pick<UpdraftConfig, 'github'> | null, o: WorkerCredentialOptions): GitHubCredentials {
  const app = config?.github?.app;
  if (!app) return createUserCredentials(o.userToken);
  const tokenFile = appTokenFilePath(app, o);
  if (tokenFile) {
    // Read once here, like the key, so an unusable file stops the command at once.
    loadTokenFile(tokenFile);
    return createAppCredentials(
      createTokenFileAuth({
        path: tokenFile,
        appId: app.appId,
        ...(o.log ? { log: o.log } : {}),
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.now ? { now: o.now } : {}),
      }),
    );
  }
  const privateKeyPath = appPrivateKeyPath(app, o);
  loadAppPrivateKey(privateKeyPath);
  return createAppCredentials(
    createAppAuth({
      appId: app.appId,
      privateKeyPath,
      ...(app.installationId !== undefined ? { installationId: app.installationId } : {}),
      ...(o.log ? { log: o.log } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.now ? { now: o.now } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Requests and commits
// ---------------------------------------------------------------------------

/**
 * Which repository an API request is about, so the right installation's token is used:
 * `/repositories/<id>/...` (through `names`, the ids the client has been given names for),
 * `/repos/<owner>/<name>/...`, or a GraphQL query whose variables carry `owner` and `name`.
 * Null when it names none.
 */
export function repoOfRequest(path: string, body: unknown, names: ReadonlyMap<number, string>): string | null {
  const p = path.replace(/[?#].*$/, '');
  const byId = /^\/repositories\/(\d+)(?:\/|$)/.exec(p);
  if (byId) return names.get(Number(byId[1])) ?? null;
  const byName = /^\/repos\/([^/]+)\/([^/]+)/.exec(p);
  if (byName) return `${decodeURIComponent(byName[1]!)}/${decodeURIComponent(byName[2]!)}`;
  if (p === '/graphql') {
    const v = (body as { variables?: { owner?: unknown; name?: unknown } } | null | undefined)?.variables;
    if (typeof v?.owner === 'string' && typeof v.name === 'string') return `${v.owner}/${v.name}`;
  }
  return null;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

/** The name and noreply address GitHub attributes to an App's bot: `<slug>[bot]` and `<bot user id>+<slug>[bot]@users.noreply.github.com`. */
export async function appCommitIdentity(auth: AppAuth, repoFullName: string): Promise<CommitIdentity> {
  const bot = await auth.botUser(repoFullName);
  return { name: bot.login, email: `${bot.id}+${bot.login}@users.noreply.github.com` };
}

/** The variables that make git commit as `identity`, whatever user.name and user.email are configured. */
export function commitIdentityEnv(identity: CommitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
