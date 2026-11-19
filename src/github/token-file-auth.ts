// A GitHub App identity without the App's private key: the worker reads an installation token
// that somebody else minted from a file, and reads the file again whenever it needs a token, so
// whoever wrote it can replace the token before it expires (installation tokens last an hour).
//
// This is how a job that must not hold the key runs as the App: Updraft Cloud's runner gets a
// token scoped to the job's one repository from its job broker, writes it here, and refreshes it
// while the job runs (#68). Anyone holding the private key could mint a token for every
// installation of the App; a token file only ever reaches what its token reaches.
//
// The file (JSON, mode 600, owned by the user the worker runs as):
//
//   {
//     "app": { "id": 123456, "slug": "updraft", "name": "Updraft" },   name optional
//     "installationId": 55,
//     "token": "ghs_...",
//     "expiresAt": "2026-11-19T21:00:00Z",
//     "permissions": { "contents": "write", ... },                    optional
//     "repositories": ["acme/web"],                                   optional: what the token covers
//     "bot": { "id": 98765, "login": "updraft[bot]" }                  optional: else looked up
//   }
import { readFileSync } from 'node:fs';
import type { Logger } from '../util/log.js';
import { GitHubError } from './api.js';
import {
  APP_DOC,
  APP_TOKEN_FILE_ENV,
  GitHubAppError,
  TOKEN_REFRESH_MARGIN_SECONDS,
  type AppAuth,
  type AppInstallation,
  type AppPermissions,
  type GitHubApp,
  type InstallationToken,
} from './app-auth.js';

export interface TokenFile {
  /** `clientId` is needed when github.app.appId is the App's client ID rather than its number. */
  app: { id: number; slug: string; name?: string; clientId?: string };
  installationId: number;
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  permissions?: AppPermissions;
  /** OWNER/REPO names the token covers, lower-cased. Absent: not stated (the token decides). */
  repositories?: string[];
  bot?: { id: number; login: string };
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLIENT_ID = /^[A-Za-z0-9._-]+$/;
/**
 * The characters a GitHub token is made of: letters, digits and `_`, plus the `.` and `-` of the
 * base64url JWT in a stateless installation token (`ghs_<app id>_<JWT>`, about 520 characters).
 * Anything else, a line break above all, is refused before it can reach an Authorization header,
 * whose validation error would otherwise repeat the value. No length is assumed: GitHub has
 * changed it before.
 */
const TOKEN = /^[A-Za-z0-9_.-]+$/;

function fail(path: string, what: string): never {
  throw new GitHubAppError(`the GitHub App token file ${path} ${what}. See ${APP_DOC} ("A token file instead of the key").`, 'token-file');
}

/**
 * Reads and checks a token file. Throws GitHubAppError('token-file') with what is wrong; the token
 * itself never appears in a message.
 */
export function loadTokenFile(path: string): TokenFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') fail(path, 'does not exist');
    if (code === 'EACCES' || code === 'EPERM') fail(path, `cannot be read by the user the worker runs as (${code})`);
    fail(path, `cannot be read (${code ?? 'unknown error'})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(path, 'is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(path, 'is not a JSON object');
  const r = raw as Record<string, unknown>;
  const app = r.app as Record<string, unknown> | undefined;
  if (typeof app !== 'object' || app === null || !Number.isSafeInteger(app.id) || (app.id as number) <= 0) fail(path, 'has no app.id');
  if (typeof app.slug !== 'string' || !SLUG.test(app.slug)) fail(path, 'has no usable app.slug');
  if (!Number.isSafeInteger(r.installationId) || (r.installationId as number) <= 0) fail(path, 'has no installationId');
  if (typeof r.token !== 'string' || r.token.trim() === '') fail(path, 'has no token');
  // Generic on purpose: nothing about the value is repeated.
  if (!TOKEN.test(r.token.trim())) fail(path, 'has a token that is not a GitHub token (letters, digits, "_", "." and "-" only)');
  if (app.clientId !== undefined && (typeof app.clientId !== 'string' || !CLIENT_ID.test(app.clientId))) fail(path, 'has an app.clientId that is not a client ID');
  const expiresAt = typeof r.expiresAt === 'string' ? Date.parse(r.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt)) fail(path, 'has no expiresAt (an ISO time)');

  const out: TokenFile = {
    app: {
      id: app.id as number,
      slug: app.slug,
      ...(typeof app.name === 'string' && app.name ? { name: app.name } : {}),
      ...(typeof app.clientId === 'string' ? { clientId: app.clientId } : {}),
    },
    installationId: r.installationId as number,
    token: r.token.trim(),
    expiresAt,
  };
  if (r.permissions !== undefined) {
    const p = r.permissions;
    if (typeof p !== 'object' || p === null || Array.isArray(p) || !Object.values(p).every((v) => typeof v === 'string')) {
      fail(path, 'has permissions that are not an object of strings');
    }
    out.permissions = p as AppPermissions;
  }
  if (r.repositories !== undefined) {
    if (!Array.isArray(r.repositories) || !r.repositories.every((x) => typeof x === 'string' && REPO.test(x))) {
      fail(path, 'has repositories that are not a list of OWNER/REPO names');
    }
    out.repositories = (r.repositories as string[]).map((x) => x.toLowerCase());
  }
  if (r.bot !== undefined) {
    const b = r.bot as Record<string, unknown>;
    if (typeof b !== 'object' || b === null || !Number.isSafeInteger(b.id) || typeof b.login !== 'string' || !b.login) {
      fail(path, 'has a bot that is not { id, login }');
    }
    out.bot = { id: b.id as number, login: b.login };
  }
  return out;
}

export interface TokenFileAuthOptions {
  /** The token file. */
  path: string;
  /**
   * github.app.appId: the file must be for this App. A number (or a string of digits) is compared
   * with `app.id`; a client ID with `app.clientId`, which the file must then state.
   */
  appId: number | string;
  /** github.app.installationId: when set, the file must be for this installation. */
  installationId?: number;
  /** For the bot lookup when the file has no `bot`. Defaults to https://api.github.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Logger;
  /** Injectable for tests. */
  read?: (path: string) => TokenFile;
}

/**
 * AppAuth over a token file. The file is read again on every request for a token, so a token
 * the writer replaced is picked up at once; nothing is cached but the bot user.
 *
 * - A token with less than TOKEN_REFRESH_MARGIN_SECONDS left is still handed out (the writer is
 *   expected to replace it well before then), with one warning per token; an expired one is not.
 * - A token GitHub answered 401 to (`reject`) is not handed out again until the file holds another.
 * - With `repositories` in the file, a token is handed out only for those repositories.
 */
export function createTokenFileAuth(opts: TokenFileAuthOptions): AppAuth {
  const read = opts.read ?? loadTokenFile;
  const now = opts.now ?? Date.now;
  const baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const rejected = new Set<string>();
  const warned = new Set<string>();
  let bot: Promise<{ id: number; login: string }> | undefined;

  const numericAppId = typeof opts.appId === 'number' ? opts.appId : /^\d+$/.test(opts.appId) ? Number(opts.appId) : null;

  /**
   * The file, checked against the configured App and installation on every read: a refresh that
   * wrote another App's or another installation's token must not switch who the worker acts as.
   */
  function current(): TokenFile {
    const file = read(opts.path);
    if (numericAppId !== null) {
      if (file.app.id !== numericAppId) {
        throw new GitHubAppError(`the GitHub App token file ${opts.path} is for App ${file.app.id}, but github.app.appId is ${numericAppId}`, 'token-file');
      }
    } else if (file.app.clientId !== opts.appId) {
      throw new GitHubAppError(
        file.app.clientId === undefined
          ? `github.app.appId is the client ID ${String(opts.appId)}, but the GitHub App token file ${opts.path} has no app.clientId to compare it with; ` +
              "add it to the file, or set github.app.appId to the App's numeric ID"
          : `the GitHub App token file ${opts.path} is for the App with client ID ${file.app.clientId}, but github.app.appId is ${String(opts.appId)}`,
        'token-file',
      );
    }
    if (opts.installationId !== undefined && file.installationId !== opts.installationId) {
      throw new GitHubAppError(
        `the GitHub App token file ${opts.path} is for installation ${file.installationId}, but github.app.installationId is ${opts.installationId}`,
        'token-file',
      );
    }
    return file;
  }

  function token(repoFullName: string): InstallationToken {
    const file = current();
    if (file.repositories && !file.repositories.includes(repoFullName.toLowerCase())) {
      throw new GitHubAppError(
        `the GitHub App token in ${opts.path} does not cover ${repoFullName} (it covers ${file.repositories.join(', ')})`,
        'not-installed',
      );
    }
    if (rejected.has(file.token)) {
      throw new GitHubAppError(`GitHub rejected the token in ${opts.path}, and it has not been replaced yet`, 'token-rejected');
    }
    const left = file.expiresAt - now();
    if (left <= 0) {
      throw new GitHubAppError(
        `the GitHub App token in ${opts.path} expired at ${new Date(file.expiresAt).toISOString()} and was not replaced (${APP_TOKEN_FILE_ENV})`,
        'token-file',
      );
    }
    if (left < TOKEN_REFRESH_MARGIN_SECONDS * 1000 && !warned.has(file.token)) {
      warned.add(file.token);
      opts.log?.warn('GitHub App token file: the token expires soon and has not been replaced', {
        path: opts.path,
        expiresAt: new Date(file.expiresAt).toISOString(),
      });
    }
    return {
      token: file.token,
      installationId: file.installationId,
      expiresAt: file.expiresAt,
      permissions: file.permissions ?? {},
      // Omitted is unknown, not "none": doctor then says it cannot check them instead of failing.
      ...(file.permissions === undefined ? { permissionsUnknown: true } : {}),
      repositorySelection: file.repositories ? 'selected' : null,
    };
  }

  const auth: AppAuth = {
    appId: opts.appId,
    tokenFile: opts.path,
    async app(): Promise<GitHubApp> {
      const file = current();
      return { id: file.app.id, slug: file.app.slug, name: file.app.name ?? file.app.slug, permissions: file.permissions ?? {} };
    },
    async installation(repoFullName): Promise<AppInstallation> {
      const t = token(repoFullName);
      return { id: t.installationId, suspendedAt: null, permissions: t.permissions, repositorySelection: t.repositorySelection };
    },
    async installationToken(repoFullName) {
      // `fresh` changes nothing: a new token is whatever the writer puts in the file.
      return token(repoFullName);
    },
    reject(t) {
      rejected.add(t);
    },
    botUser(repoFullName) {
      const file = current();
      if (file.bot) return Promise.resolve(file.bot);
      if (bot) return bot;
      const p = (async () => {
        const login = `${file.app.slug}[bot]`;
        const { token: t } = token(repoFullName);
        const res = await doFetch(`${baseUrl}/users/${encodeURIComponent(login)}`, {
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${t}`, 'x-github-api-version': '2022-11-28' },
        });
        if (!res.ok) throw new GitHubError(`GET /users/${login} failed (${res.status})`, res.status);
        const u = (await res.json()) as { id: number; login?: string };
        return { id: u.id, login: u.login ?? login };
      })();
      bot = p;
      void p.catch(() => {
        if (bot === p) bot = undefined;
      });
      return p;
    },
  };
  return auth;
}
