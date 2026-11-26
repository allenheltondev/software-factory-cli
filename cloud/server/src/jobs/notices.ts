import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { LoadSettings } from '../github/settings.js';
import type { Workflow } from '../workflows/workflow.js';
import { throttleCommentPermissions } from './quotas.js';

/**
 * The "please act" comments Updraft Cloud posts on GitHub when only a person can move the work on
 * (#173): one or two plain sentences, what to do, and the console link. Each carries a hidden
 * marker and is looked for before it is posted, so a retry or a redelivery never posts it twice.
 * They are posted in quiet and verbose notifications alike: a person has to act either way.
 */

/** A console page under the installation, or undefined without an https console origin. */
export function consolePage(consoleOrigin: string | undefined, installationId: number, path = ''): string | undefined {
  if (!consoleOrigin) return undefined;
  try {
    const u = new URL(consoleOrigin);
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    return new URL(`/installations/${installationId}${path}`, u.origin).href;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// A delivery refused for a missing agent key
// ---------------------------------------------------------------------------

export interface RefusalNotice {
  installationId: number;
  repository: string;
  repositoryId: number;
  /** The issue or pull request the delivery was for. */
  number: number;
  pullRequest: boolean;
  /** The refusal, as the launcher words it (names the keys, or what else to change). */
  message: string;
  /** The keys that are not set; empty when the refusal is about something else (an agent no longer run, an unknown set of keys). */
  missing: string[];
  configVersion: number;
  /** Not a key: the deployment's worker image cannot run Codex on the ChatGPT plan yet (#125). */
  kind?: 'codex_unsupported';
}

/** One per subject, configuration version and set of keys: a relabel or a redelivery finds it. */
export const refusalMarker = (n: Pick<RefusalNotice, 'configVersion' | 'missing' | 'kind'>) =>
  n.kind === 'codex_unsupported' ? `<!-- updraft-refused: codex_unsupported v${n.configVersion} -->`
    : `<!-- updraft-refused: missing_key v${n.configVersion} ${n.missing.length ? [...n.missing].sort().join(',') : 'config'} -->`;

export function refusalComment(n: RefusalNotice, consoleOrigin?: string): string {
  if (n.kind === 'codex_unsupported') {
    const again = n.pullRequest ? 'then submit the review again or push a commit.' : 'then remove the label and add it again.';
    return [`Updraft could not start work on this ${n.pullRequest ? 'pull request' : 'issue'}: it runs Codex on your ChatGPT plan, and this deployment's subscription worker image does not support Codex yet. It was not run on an API key. An Updraft operator needs to publish a worker image verified with Codex; ${again}`, '', refusalMarker(n)].join('\n');
  }
  const keys = consolePage(consoleOrigin, n.installationId, '/keys');
  const config = consolePage(consoleOrigin, n.installationId, '/config');
  const where = n.missing.length ? (keys ? ` Please [add ${n.missing.length > 1 ? 'them' : 'it'} under Agent keys](${keys}),` : ' Please add it under Agent keys in Updraft,') : config ? ` Please [fix the configuration](${config}),` : ' Please fix the configuration in Updraft,';
  const again = n.pullRequest ? 'then submit the review again or push a commit.' : 'then remove the label and add it again.';
  const why = n.message.replace(/[.\s]+$/, '');
  return [`Updraft could not start work on this ${n.pullRequest ? 'pull request' : 'issue'}: ${why}.${where} ${again}`, '', refusalMarker(n)].join('\n');
}

// ---------------------------------------------------------------------------
// A workflow blocked for a person (workflows/reconcile.ts, recovery.ts)
// ---------------------------------------------------------------------------

/** One per workflow run (generation) and reason: a block decided again for the same reason is not said again. */
export const blockMarker = (w: Pick<Workflow, 'workflowId' | 'generation'>, reason: string) =>
  `<!-- updraft-blocked: ${w.workflowId} g${w.generation} ${reason.replace(/[^A-Za-z0-9_.-]/g, '_')} -->`;

export function blockComment(w: Pick<Workflow, 'workflowId' | 'generation' | 'installationId' | 'pullRequest' | 'issue'>, why: { reason: string; message: string; nextAction: string }, consoleOrigin?: string): string {
  const link = consolePage(consoleOrigin, w.installationId, `/workflows/${encodeURIComponent(w.workflowId)}`);
  const what = w.pullRequest !== undefined ? 'this pull request' : 'this issue';
  const said = (t: string) => t.trim().replace(/([^.!?])$/, '$1.');
  return [`Updraft stopped working on ${what} and needs a person: ${said(why.message)} ${said(why.nextAction)}${link ? ` [Open it in Updraft](${link})` : ''}`, '', blockMarker(w, why.reason)].join('\n');
}

export type BlockNotifier = (w: Workflow, why: { reason: string; message: string; nextAction: string }) => Promise<void>;

/**
 * Posts a please-act comment as the App, with a token for that one repository allowed to write
 * issues (and a pull request's conversation), unless one with the same marker is there.
 */
export function createGitHubNotices(deps: {
  github: Pick<GitHubApi, 'createInstallationToken' | 'findIssueComment' | 'postIssueComment' | 'createIssueComment'>;
  loadSettings: LoadSettings;
  consoleOrigin?: string;
  log?: (entry: Record<string, unknown>) => void;
}) {
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  async function postOnce(installationId: number, repositoryId: number, repository: string, number: number, pullRequest: boolean, body: string, marker: string): Promise<boolean> {
    const settings = await deps.loadSettings();
    if (!settings) return false;
    // Fails closed: without the App's own login, a comment anyone wrote could pass for ours.
    if (!settings.slug) {
      log({ installationId, repository, warning: 'not posting a please-act comment: the App slug is unknown, so its own comments cannot be told apart' });
      return false;
    }
    const { token } = await deps.github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId, {
      repositoryIds: [repositoryId],
      permissions: throttleCommentPermissions(pullRequest),
    });
    const bot = `${settings.slug}[bot]`;
    if (!deps.github.findIssueComment) return false;
    if ((await deps.github.findIssueComment(token, repository, number, marker, bot)) !== null) return false;
    if (deps.github.postIssueComment) await deps.github.postIssueComment(token, repository, number, body);
    else await deps.github.createIssueComment(token, repository, number, body);
    return true;
  }
  return {
    async refused(n: RefusalNotice): Promise<void> {
      await postOnce(n.installationId, n.repositoryId, n.repository, n.number, n.pullRequest, refusalComment(n, deps.consoleOrigin), refusalMarker(n));
    },
    blocked: (async (w, why) => {
      const number = w.pullRequest ?? w.issue;
      if (number === undefined) return;
      try {
        await postOnce(w.installationId, w.repositoryId, w.repository, number, w.pullRequest !== undefined, blockComment(w, why, deps.consoleOrigin), blockMarker(w, why.reason));
      } catch (err) {
        log({ installationId: w.installationId, workflow: w.workflowId, warning: `could not post the blocked notice: ${(err as Error)?.name ?? 'error'}` });
      }
    }) as BlockNotifier,
  };
}
