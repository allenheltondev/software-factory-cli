// Doctor's checks for a GitHub App identity (github.app; docs/github-app.md): the private key
// file, and for each configured repository the App's installation and whether the permissions it
// grants cover what the configuration uses. That the App authenticates at all is the `github`
// check in doctor.ts, which asks who the worker is.
import { statSync } from 'node:fs';
import { publishMode, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import { APP_DOC, APP_KEY_PATH_ENV, loadAppPrivateKey, missingAppPermissions, requiredAppPermissions, type AppAuth } from '../github/app-auth.js';
import { appPrivateKeyPath, type GitHubAppConfig } from '../github/credentials.js';
import type { CheckResult, CheckStatus } from './doctor.js';

type Check = Omit<CheckResult, 'name'>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Why the configured private key cannot be used, or null. Offline: reads and parses the file. */
export function appKeyProblem(app: GitHubAppConfig, o: { configDir: string; env: NodeJS.ProcessEnv }): string | null {
  try {
    loadAppPrivateKey(appPrivateKeyPath(app, o));
    return null;
  } catch (err) {
    return message(err);
  }
}

/** Permission bits of a file, or null when it cannot be read. */
export function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * The key file: that it loads as an RSA private key, and on POSIX that only its owner can read
 * it. `ok` is false when the key cannot be used, in which case nothing else about the App can be
 * checked.
 */
export function appKeyChecks(
  app: GitHubAppConfig,
  o: { configDir: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; fileMode?: (path: string) => number | null },
): { ok: boolean; checks: Check[] } {
  const path = appPrivateKeyPath(app, o);
  const from = o.env[APP_KEY_PATH_ENV]?.trim() ? ` (from ${APP_KEY_PATH_ENV})` : '';
  const problem = appKeyProblem(app, o);
  if (problem) return { ok: false, checks: [{ status: 'fail', detail: problem }] };
  const checks: Check[] = [{ status: 'ok', detail: `private key loads: ${path}${from}` }];
  if (o.platform !== 'win32') {
    const mode = (o.fileMode ?? fileMode)(path);
    if (mode !== null && (mode & 0o077) !== 0) {
      checks.push({
        status: 'warn',
        detail:
          `${path} has mode ${mode.toString(8).padStart(3, '0')}, so other users on this machine can read the App's private key ` +
          `(anyone holding it can act as the App); run: chmod 600 ${path}`,
      });
    }
  }
  return { ok: true, checks };
}

/**
 * One repository under a GitHub App: is the App installed there (and not suspended), is that the
 * configured installation, and do the installation's permissions cover polling plus whatever of
 * publish, revise and commentOnFailure the repository has on. Never writes to GitHub.
 */
export async function appRepoChecks(
  auth: AppAuth,
  config: Pick<UpdraftConfig, 'execution' | 'github'>,
  fullName: string,
  repo: Pick<RepositoryConfig, 'publish' | 'commentOnFailure' | 'revise'>,
): Promise<Check[]> {
  const out: Check[] = [];
  let installationId: number;
  try {
    const inst = await auth.installation(fullName);
    installationId = inst.id;
    if (inst.suspendedAt) {
      return [
        {
          status: 'fail',
          detail:
            `the GitHub App's installation ${inst.id} is suspended (since ${inst.suspendedAt}), so GitHub issues no tokens for it; ` +
            "unsuspend it under the account's Settings, GitHub Apps, Configure",
        },
      ];
    }
    const pinned = config.github?.app?.installationId;
    if (pinned !== undefined && pinned !== inst.id) {
      return [
        {
          status: 'fail',
          detail:
            `github.app.installationId is ${pinned}, but the App's installation that covers ${fullName} is ${inst.id}; ` +
            'requests for this repository would be refused. Set it to that id, or remove it to have the installation looked up per repository',
        },
      ];
    }
  } catch (err) {
    return [{ status: 'fail', detail: message(err) }];
  }

  let granted: Record<string, string>;
  let selection: string | null;
  try {
    const token = await auth.installationToken(fullName);
    granted = token.permissions;
    selection = token.repositorySelection;
  } catch (err) {
    return [{ status: 'fail', detail: message(err) }];
  }

  const publish = publishMode(repo) !== 'none';
  const commentOnFailure = repo.commentOnFailure === true;
  // What the worker always does (reading issues, events and labels) fails outright when missing.
  // Writes happen only in live mode, so a gap there is a warning in the other modes, as it is for
  // a gh account without push access.
  const reads = missingAppPermissions(granted, requiredAppPermissions({ publish: false, commentOnFailure: false }));
  const all = missingAppPermissions(granted, requiredAppPermissions({ publish, commentOnFailure }));
  const writes = all.filter((m) => !reads.includes(m));
  const writeSeverity: CheckStatus = config.execution.mode === 'live' ? 'fail' : 'warn';
  const uses = [
    'polling',
    ...(publish ? [`publish: ${publishMode(repo)}`] : []),
    ...(publish && repo.revise ? ['revise'] : []),
    ...(commentOnFailure ? ['commentOnFailure'] : []),
  ].join(', ');
  const fix = `change it under the App's settings, "Permissions & events", then accept the new permissions on the installation (${APP_DOC})`;
  for (const m of reads) out.push({ status: 'fail', detail: `GitHub App permission missing for polling: ${m}; ${fix}` });
  for (const m of writes) out.push({ status: writeSeverity, detail: `GitHub App permission missing for ${uses}: ${m}; ${fix}` });
  if (!reads.length && !writes.length) {
    out.push({
      status: 'ok',
      detail: `GitHub App installation ${installationId}${selection ? ` (${selection} repositories)` : ''}: its permissions cover ${uses}`,
    });
  }
  return out;
}
