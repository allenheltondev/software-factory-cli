// GitHub App authentication (github.app in the config), with node:crypto and fetch only.
//
// The worker signs a short-lived RS256 JWT as the App with the App's private key, and exchanges
// it for an installation access token, which is what every API call and push then uses. Tokens
// last an hour; they are cached per installation and replaced ahead of expiry.
//
// Checked against api.github.com (2026-11-18) with a throwaway key, so without a real App: a JWT
// with current timestamps and a signature GitHub cannot verify gets 401 "A JSON web token could
// not be decoded" from `GET /app` and `GET /repos/{owner}/{repo}/installation`; the same JWT with
// `exp` in the past or `iat` in the future gets a bare 401 "Bad credentials". A wrong clock is
// therefore recognised by comparing this machine's time with the response's Date header, not
// only by GitHub naming a claim.
//
// Nothing else here could be checked against GitHub; it is written from the REST documentation
// as remembered (docs/github-app.md says so to its readers too):
// - `GET /app` with the JWT returns the App (`id`, `slug`, `name`, `permissions`).
// - `GET /repos/{owner}/{repo}/installation` with the JWT returns the installation covering the
//   repository (`id`, `suspended_at`, `permissions`, `repository_selection`), 404 when the App is
//   not installed there.
// - `POST /app/installations/{id}/access_tokens` with the JWT returns `token`, `expires_at`,
//   `permissions` and `repository_selection`; 404 for an unknown installation, 403 for a
//   suspended one, 401 for a JWT GitHub does not accept.
// - A JWT may claim at most ten minutes of validity, and GitHub rejects one whose `iat` is in the
//   future or whose `exp` is in the past with a 401 naming the claim.
// - `GET /users/<slug>[bot]` returns the bot's user id, which GitHub uses in the App's noreply
//   commit address `<id>+<slug>[bot]@users.noreply.github.com`.
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Logger } from '../util/log.js';
import { GitHubError } from './api.js';

/** Environment variable naming a PEM file to use instead of github.app.privateKeyPath. Never passed to an agent. */
export const APP_KEY_PATH_ENV = 'UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH';

/** A JWT's `iat` is set this far in the past, so a clock that runs a little fast is still accepted. */
export const JWT_BACKDATE_SECONDS = 60;
/** A JWT's `exp`, from now. GitHub allows at most ten minutes. */
export const JWT_LIFETIME_SECONDS = 9 * 60;
/** An installation token is replaced once it has less than this left. Longer than a publication attempt may run. */
export const TOKEN_REFRESH_MARGIN_SECONDS = 10 * 60;
/** After a refresh failed for a passing reason, the token in hand is used this long before the next try. */
const REFRESH_RETRY_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_URL = 'https://api.github.com';

/** Where the setup and the permission list are written down, for error messages. */
export const APP_DOC = 'docs/github-app.md';
export const APP_PERMISSIONS_HINT =
  'A GitHub App identity needs these repository permissions: Metadata read; Contents, Pull requests and Issues read ' +
  `and write (see ${APP_DOC}). After changing them, the installation's owner must accept the new permissions`;

export type GitHubAppProblem =
  /** The private key file is missing, unreadable or not an RSA private key. */
  | 'key'
  /** GitHub does not accept the JWT: wrong appId, or a key that is not this App's. */
  | 'jwt-rejected'
  /** GitHub rejected the JWT's timestamps: this machine's clock is wrong. */
  | 'clock'
  /** The App is not installed on the repository (or the configured installation does not exist). */
  | 'not-installed'
  | 'suspended'
  /** The installation lacks a permission the request needs. */
  | 'permissions'
  /** GitHub answered 401 to an installation token it issued. */
  | 'token-rejected'
  /** The request is one only a user account can make. */
  | 'not-for-apps'
  /** github.app.tokenFile (or UPDRAFT_GITHUB_APP_TOKEN_FILE) is missing, unreadable, malformed or expired. */
  | 'token-file';

/**
 * Environment variable naming a token file (token-file-auth.ts) to use instead of
 * github.app.tokenFile or the private key. Never passed to an agent.
 */
export const APP_TOKEN_FILE_ENV = 'UPDRAFT_GITHUB_APP_TOKEN_FILE';

/**
 * A GitHub App problem that waiting does not fix; the message says what to change. It is a
 * GitHubError so callers that handle those keep working, with a status that is neither "gone"
 * (301/404/410, which cancels jobs) nor transient (0, 5xx, rate limit): the poller backs off,
 * and publication stops retrying and shows the message. Passing failures while authenticating
 * (network, 5xx, rate limits) stay plain GitHubErrors and are retried as usual.
 */
export class GitHubAppError extends GitHubError {
  constructor(
    message: string,
    readonly problem: GitHubAppProblem,
  ) {
    super(message, problem === 'not-installed' || problem === 'suspended' || problem === 'permissions' || problem === 'not-for-apps' ? 403 : 401);
    this.name = 'GitHubAppError';
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** header.payload.signature, each base64url; a JWT header always starts with `{"` (eyJ). */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g;
/** GitHub's token formats: ghs_ (installation), ghp_/gho_/ghu_/ghr_ and fine-grained github_pat_. */
// Stateless installation tokens (GitHub, 2026-10) are `ghs_<app id>_<JWT>`: base64url parts joined
// by dots, about 520 characters. The whole of one is matched, not just what comes before its first dot.
const GITHUB_TOKEN = /\b(?:gh[a-z]_[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)*|github_pat_[A-Za-z0-9_]{20,})/g;
/** The basic-auth header publication gives git: base64 of `x-access-token:<token>`, whose first 20 characters are fixed. */
const BASIC_ACCESS_TOKEN = /eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/=]*/g;

/**
 * Remove anything shaped like a credential the worker handles: a PEM private key, a JWT, a GitHub
 * token, and the header form a token takes for git. By shape, so it also covers a secret this
 * process never held (a token minted by another attempt, say).
 */
export function redactGitHubSecrets(text: string): string {
  return text.replace(PEM_BLOCK, '***').replace(JWT, '***').replace(BASIC_ACCESS_TOKEN, '***').replace(GITHUB_TOKEN, '***');
}

// ---------------------------------------------------------------------------
// The key and the JWT
// ---------------------------------------------------------------------------

/**
 * Read and parse the App's private key. Throws GitHubAppError('key') with what to change; the
 * message names the file, never its content.
 */
export function loadAppPrivateKey(path: string): KeyObject {
  const where = `the GitHub App private key ${path}`;
  const fix = `Set github.app.privateKeyPath (or ${APP_KEY_PATH_ENV}) to the .pem file downloaded from the App's settings page`;
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new GitHubAppError(`${where} does not exist. ${fix}.`, 'key');
    if (code === 'EACCES' || code === 'EPERM') {
      throw new GitHubAppError(`${where} cannot be read by the user the worker runs as (${code}). Make that user its owner, with mode 600.`, 'key');
    }
    throw new GitHubAppError(`${where} cannot be read (${code ?? 'unknown error'}). ${fix}.`, 'key');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    // The parser's own message is left out on purpose: nothing derived from the file is repeated.
    throw new GitHubAppError(
      `${where} is not a PEM private key this Node.js can read (a passphrase-protected key is not supported). ${fix}.`,
      'key',
    );
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new GitHubAppError(`${where} is a ${key.asymmetricKeyType ?? 'non-RSA'} key; GitHub Apps sign with an RSA key. ${fix}.`, 'key');
  }
  return key;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** An RS256 JWT that authenticates as the App itself: backdated `iat`, short `exp`, `iss` the App. */
export function createAppJwt(o: { appId: number | string; key: KeyObject; now: number }): string {
  const seconds = Math.floor(o.now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: seconds - JWT_BACKDATE_SECONDS, exp: seconds + JWT_LIFETIME_SECONDS, iss: o.appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(o.key);
  return `${header}.${payload}.${b64url(signature)}`;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionLevel = 'read' | 'write';
/** Repository permissions by their API names (`contents`, `pull_requests`, `issues`, `metadata`...). */
export type AppPermissions = Record<string, string>;

const PERMISSION_LABEL: Record<string, string> = {
  metadata: 'Metadata',
  contents: 'Contents',
  pull_requests: 'Pull requests',
  issues: 'Issues',
  checks: 'Checks',
  statuses: 'Commit statuses',
  actions: 'Actions',
  workflows: 'Workflows',
};

const covers = (granted: string | undefined, needed: PermissionLevel) => granted === 'admin' || granted === 'write' || (needed === 'read' && granted === 'read');

/**
 * The repository permissions an installation needs for what one repository's configuration does.
 * Polling reads issues, their events and labels; publication pushes a branch, opens a PR and
 * comments, and a revision (which only exists with publication) reads reviews, pushes and comments
 * on the pull request; a failure comment is an issue comment.
 */
export function requiredAppPermissions(o: { publish: boolean; commentOnFailure: boolean; autoMerge?: boolean; ciFix?: boolean }): Record<string, PermissionLevel> {
  return {
    metadata: 'read',
    ...(o.publish ? { contents: 'write' as const, pull_requests: 'write' as const } : {}),
    issues: o.publish || o.commentOnFailure ? 'write' : 'read',
    // Auto-merge and the CI step read the head commit's check runs and statuses.
    ...(o.autoMerge || o.ciFix ? { checks: 'read' as const, statuses: 'read' as const } : {}),
    // The CI step reads the logs of failed GitHub Actions jobs for the revision's diagnostics.
    ...(o.ciFix ? { actions: 'read' as const } : {}),
  };
}

/** One line per permission the installation lacks, each saying what to set. Empty when all are covered. */
export function missingAppPermissions(granted: AppPermissions, required: Record<string, PermissionLevel>): string[] {
  const out: string[] = [];
  for (const [name, level] of Object.entries(required)) {
    if (covers(granted[name], level)) continue;
    const label = PERMISSION_LABEL[name] ?? name;
    const wanted = level === 'write' ? 'Read and write' : 'Read-only';
    out.push(`${label}: needs "${wanted}", the installation has ${granted[name] ? `"${granted[name]}"` : 'no access'}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface GitHubApp {
  id: number;
  /** The App's URL name; its bot account is `<slug>[bot]`. */
  slug: string;
  name: string;
  /** The permissions the App asks for (an installation may still be on an older, smaller set). */
  permissions: AppPermissions;
}

export interface AppInstallation {
  id: number;
  /** ISO time the installation was suspended; null when it is active. */
  suspendedAt: string | null;
  permissions: AppPermissions;
  /** `all` or `selected`. */
  repositorySelection: string | null;
}

export interface InstallationToken {
  token: string;
  installationId: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** What the installation grants, as GitHub listed it with the token. */
  permissions: AppPermissions;
  /**
   * True when nobody stated the permissions (a token file without `permissions`): `permissions`
   * is then empty because it is unknown, not because nothing is granted.
   */
  permissionsUnknown?: boolean;
  repositorySelection: string | null;
}

export interface AppAuthOptions {
  /** The App's numeric ID or its client ID. */
  appId: number | string;
  /** Absolute path of the PEM private key. Read each time a JWT is signed, so a replaced key is picked up. */
  privateKeyPath: string;
  /** Use this installation for every repository instead of looking one up per repository. */
  installationId?: number;
  /** Defaults to https://api.github.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Logger;
  requestTimeoutMs?: number;
}

export interface AppAuth {
  readonly appId: number | string;
  /** The key file (createAppAuth). */
  readonly privateKeyPath?: string;
  /** The token file, when the identity comes from one instead of the key (token-file-auth.ts). */
  readonly tokenFile?: string;
  /** The App behind the key (`GET /app`). Cached once it succeeded. */
  app(): Promise<GitHubApp>;
  /** The installation that covers `repoFullName`, as GitHub reports it now (not cached). */
  installation(repoFullName: string): Promise<AppInstallation>;
  /**
   * An installation access token for `repoFullName` with at least ten minutes left. Cached per
   * installation; concurrent callers share one request. `fresh` asks GitHub for a new one.
   */
  installationToken(repoFullName: string, opts?: { fresh?: boolean }): Promise<InstallationToken>;
  /** Forget a token GitHub answered 401 to, so the next call mints another. */
  reject(token: string): void;
  /** The bot account of the App (`<slug>[bot]`) and its user id, read with a token for `repoFullName`. Cached. */
  botUser(repoFullName: string): Promise<{ id: number; login: string }>;
}

interface TokenState {
  current?: InstallationToken;
  inflight?: Promise<InstallationToken>;
  /** Do not try to refresh `current` again before this time. */
  retryAt?: number;
}

function isPassing(err: unknown): boolean {
  return err instanceof GitHubError && !(err instanceof GitHubAppError) && (err.status === 0 || err.status >= 500 || err.isRateLimit);
}

/** Seconds from Retry-After, or from the rate-limit reset when the budget is used up. */
function retryAfter(headers: Headers, now: number): number | null {
  const ra = Number(headers.get('retry-after'));
  if (headers.get('retry-after') && Number.isFinite(ra)) return Math.max(0, Math.ceil(ra));
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - now / 1000));
  }
  return null;
}

export function createAppAuth(opts: AppAuthOptions): AppAuth {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const log = opts.log;
  const keyPath = opts.privateKeyPath;

  let appInfo: Promise<GitHubApp> | undefined;
  let knownSlug: string | null = null;
  const installationIds = new Map<string, Promise<number>>();
  const tokens = new Map<number, TokenState>();
  const bots = new Map<string, Promise<{ id: number; login: string }>>();
  /** GitHub's own time (the Date header) on a failed response, to tell a wrong clock from a wrong key. */
  const serverTimes = new WeakMap<GitHubError, number>();

  const jwt = () => createAppJwt({ appId: opts.appId, key: loadAppPrivateKey(keyPath), now: now() });
  const appName = () => (knownSlug ? `the GitHub App ${knownSlug}` : `the GitHub App (github.app.appId ${opts.appId})`);

  /** One request with the given Authorization value; non-2xx becomes a GitHubError with GitHub's message. */
  async function call<T>(method: 'GET' | 'POST', path: string, authorization: string): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'updraft',
          Authorization: authorization,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      const why = e?.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e?.message ?? String(err));
      throw new GitHubError(`${method} ${path}: network error: ${redactGitHubSecrets(why)}`, 0);
    }
    log?.debug('github app request', { method, url: path, status: res.status });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // an empty or non-JSON body
    }
    if (!res.ok) {
      const detail = redactGitHubSecrets(String((body as { message?: unknown } | null)?.message ?? ''));
      const err = new GitHubError(`${method} ${path} failed: ${res.status}${detail ? ` ${detail}` : ''}`, res.status, retryAfter(res.headers, now()));
      const serverTime = Date.parse(res.headers.get('date') ?? '');
      if (Number.isFinite(serverTime)) serverTimes.set(err, serverTime);
      throw err;
    }
    if (body === null || typeof body !== 'object') throw new GitHubError(`${method} ${path} returned no JSON object`, 502);
    return body as T;
  }

  /**
   * What a 401 to the JWT means: a wrong clock when GitHub names a time claim or its own time
   * shows that the JWT's `iat` was in the future or its `exp` in the past, else a wrong appId or key.
   */
  function jwtProblem(err: GitHubError): GitHubAppError {
    const serverTime = serverTimes.get(err);
    const ahead = serverTime === undefined ? null : Math.round((now() - serverTime) / 1000);
    const outOfRange = ahead !== null && (ahead > JWT_BACKDATE_SECONDS - 5 || ahead < -(JWT_LIFETIME_SECONDS - 5));
    if (outOfRange || /\b(?:exp|iat)\b|expiration time|issued at/i.test(err.message)) {
      const theirs =
        serverTime !== undefined && ahead !== null
          ? `, GitHub's reads ${new Date(serverTime).toISOString()} (this machine is about ${Math.abs(ahead)} seconds ${ahead > 0 ? 'ahead' : 'behind'})`
          : '';
      return new GitHubAppError(
        `GitHub rejected the App's JWT because of its timestamps (${err.message}). This machine's clock reads ` +
          `${new Date(now()).toISOString()}${theirs}; correct it (turn on time synchronization). The JWT already allows for a minute of drift.`,
        'clock',
      );
    }
    return new GitHubAppError(
      `GitHub did not accept the App's JWT (${err.message}). Check that github.app.appId (${opts.appId}) is the App's ID ` +
        `or client ID, and that ${keyPath} is one of the private keys listed on that App's settings page.`,
      'jwt-rejected',
    );
  }

  async function asApp<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    try {
      return await call<T>(method, path, `Bearer ${jwt()}`);
    } catch (err) {
      if (err instanceof GitHubError && !(err instanceof GitHubAppError) && err.status === 401) throw jwtProblem(err);
      throw err;
    }
  }

  function app(): Promise<GitHubApp> {
    if (!appInfo) {
      const p = asApp<{ id: number; slug: string; name?: string; permissions?: AppPermissions }>('GET', '/app').then(
        (a) => {
          knownSlug = a.slug;
          return { id: a.id, slug: a.slug, name: a.name ?? a.slug, permissions: a.permissions ?? {} };
        },
        (err: unknown) => {
          if (appInfo === p) appInfo = undefined; // not cached: the next caller asks again
          if (err instanceof GitHubError && !(err instanceof GitHubAppError) && err.status === 404) throw jwtProblem(err);
          throw err;
        },
      );
      appInfo = p;
    }
    return appInfo;
  }

  const splitRepo = (repoFullName: string): [string, string] => {
    const [owner, name, ...rest] = repoFullName.split('/');
    if (!owner || !name || rest.length) throw new GitHubError(`invalid repository name "${repoFullName}"`, 422);
    return [owner, name];
  };

  const notInstalled = (repoFullName: string) =>
    new GitHubAppError(
      `${appName()} is not installed on ${repoFullName}. Install it there (the App's settings page, "Install App"), or add ` +
        `${repoFullName} to the repositories its existing installation may access; then run "updraft doctor". See ${APP_DOC}.`,
      'not-installed',
    );
  const suspended = (what: string) =>
    new GitHubAppError(
      `${appName()}'s installation ${what} is suspended, so GitHub issues no tokens for it. Unsuspend it under the ` +
        "account's Settings, GitHub Apps, Configure.",
      'suspended',
    );

  async function installation(repoFullName: string): Promise<AppInstallation> {
    const [owner, name] = splitRepo(repoFullName);
    let raw: { id: number; suspended_at?: string | null; permissions?: AppPermissions; repository_selection?: string | null };
    try {
      raw = await asApp('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`);
    } catch (err) {
      if (err instanceof GitHubError && !(err instanceof GitHubAppError) && err.status === 404) throw notInstalled(repoFullName);
      throw err;
    }
    return { id: raw.id, suspendedAt: raw.suspended_at ?? null, permissions: raw.permissions ?? {}, repositorySelection: raw.repository_selection ?? null };
  }

  function installationIdFor(repoFullName: string): Promise<number> {
    if (opts.installationId !== undefined) return Promise.resolve(opts.installationId);
    const key = repoFullName.toLowerCase();
    let p = installationIds.get(key);
    if (!p) {
      p = installation(repoFullName).then((i) => {
        if (i.suspendedAt) throw suspended(`on ${repoFullName}`);
        return i.id;
      });
      installationIds.set(key, p);
      // Only a found installation is remembered; a failure is asked again next time.
      void p.catch(() => {
        if (installationIds.get(key) === p) installationIds.delete(key);
      });
    }
    return p;
  }

  async function mint(installationId: number, repoFullName: string): Promise<InstallationToken> {
    let raw: { token?: string; expires_at?: string; permissions?: AppPermissions; repository_selection?: string | null };
    try {
      raw = await asApp('POST', `/app/installations/${installationId}/access_tokens`);
    } catch (err) {
      if (err instanceof GitHubError && !(err instanceof GitHubAppError)) {
        if (err.status === 404) {
          // The installation is gone: forget which repositories pointed at it.
          for (const [key, p] of installationIds) {
            void p.then(
              (id) => {
                if (id === installationId && installationIds.get(key) === p) installationIds.delete(key);
              },
              () => {},
            );
          }
          tokens.delete(installationId);
          if (opts.installationId !== undefined) {
            throw new GitHubAppError(
              `${appName()} has no installation ${installationId} (${err.message}). github.app.installationId is wrong, or the App was ` +
                `uninstalled; correct it, or remove it to have the installation looked up per repository. See ${APP_DOC}.`,
              'not-installed',
            );
          }
          throw notInstalled(repoFullName);
        }
        if (err.status === 403 && !err.isRateLimit) {
          if (/suspend/i.test(err.message)) throw suspended(`${installationId} (used for ${repoFullName})`);
          throw new GitHubAppError(`GitHub refused an installation token for ${appName()} on ${repoFullName} (${err.message}). See ${APP_DOC}.`, 'permissions');
        }
      }
      throw err;
    }
    if (typeof raw.token !== 'string' || !raw.token) throw new GitHubError(`POST /app/installations/${installationId}/access_tokens returned no token`, 502);
    const parsed = Date.parse(raw.expires_at ?? '');
    return {
      token: raw.token,
      installationId,
      // GitHub's tokens last an hour; without a readable expiry, assume less.
      expiresAt: Number.isFinite(parsed) ? parsed : now() + 30 * 60_000,
      permissions: raw.permissions ?? {},
      repositorySelection: raw.repository_selection ?? null,
    };
  }

  async function installationToken(repoFullName: string, o: { fresh?: boolean } = {}): Promise<InstallationToken> {
    const installationId = await installationIdFor(repoFullName);
    let state = tokens.get(installationId);
    if (!state) tokens.set(installationId, (state = {}));
    const s = state;
    const held = s.current;
    const left = held ? held.expiresAt - now() : 0;
    if (!o.fresh && held) {
      if (left > TOKEN_REFRESH_MARGIN_SECONDS * 1000) return held;
      if (left > REFRESH_RETRY_SECONDS * 1000 && s.retryAt !== undefined && now() < s.retryAt) return held;
    }
    if (!s.inflight) {
      // One request per installation however many callers wait; each of them gets its result.
      const p = mint(installationId, repoFullName).then((t) => {
        s.current = t;
        s.retryAt = undefined;
        return t;
      });
      s.inflight = p;
      const done = () => {
        if (s.inflight === p) s.inflight = undefined;
      };
      void p.then(done, done);
    }
    try {
      return await s.inflight;
    } catch (err) {
      // A refresh that failed because GitHub could not be reached does not make the token in hand
      // invalid: keep using it while it lasts, and try again shortly.
      if (!o.fresh && held && s.current === held && held.expiresAt - now() > REFRESH_RETRY_SECONDS * 1000 && isPassing(err)) {
        s.retryAt = now() + REFRESH_RETRY_SECONDS * 1000;
        log?.warn('could not refresh the GitHub App installation token; using the current one until it expires', {
          installationId,
          expiresAt: new Date(held.expiresAt).toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
        return held;
      }
      throw err;
    }
  }

  return {
    appId: opts.appId,
    privateKeyPath: keyPath,
    app,
    installation,
    installationToken,
    reject(token) {
      for (const s of tokens.values()) if (s.current?.token === token) s.current = undefined;
    },
    botUser(repoFullName) {
      const cached = bots.get('bot');
      if (cached) return cached;
      const p = (async () => {
        const { slug } = await app();
        const { token } = await installationToken(repoFullName);
        const login = `${slug}[bot]`;
        const u = await call<{ id: number; login?: string }>('GET', `/users/${encodeURIComponent(login)}`, `Bearer ${token}`);
        return { id: u.id, login: u.login ?? login };
      })();
      bots.set('bot', p);
      void p.catch(() => {
        if (bots.get('bot') === p) bots.delete('bot');
      });
      return p;
    },
  };
}

/**
 * What a failed API request means when it was made as an App installation, where GitHub's own
 * message does not say what to change. Null when the generic error is right.
 */
export function appRequestProblem(o: { method: string; path: string; status: number; detail: string; repoFullName: string | null }): GitHubAppError | null {
  const where = o.repoFullName ? ` on ${o.repoFullName}` : '';
  if (o.status === 401) {
    return new GitHubAppError(
      `${o.method} ${o.path} failed: 401${o.detail ? ` ${o.detail}` : ''}: GitHub rejected the GitHub App's installation token${where}. ` +
        'The installation may have been suspended or removed; run "updraft doctor".',
      'token-rejected',
    );
  }
  if (o.status === 403 && /not accessible by integration/i.test(o.detail)) {
    return new GitHubAppError(
      `${o.method} ${o.path} failed: 403 ${o.detail}: the GitHub App's installation${where} lacks a permission this request needs. ` +
        `${APP_PERMISSIONS_HINT}. "updraft doctor" lists what is missing.`,
      'permissions',
    );
  }
  return null;
}
