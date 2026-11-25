// Human steering by mention, local path (#135, docs/controls.md): each poll cycle reads the
// repository's new issue and pull request comments, and carries out the commands addressed to the
// worker's handle.
//
// - Only comments created after the poller first looked are commands (older ones are history),
//   and only as first written: an edited comment is never acted on.
// - Each command is recorded once, by comment id, before its reply: a re-read, a restart or a
//   shared copy of the state never acts on it twice (src/db/control.ts).
// - The command must be on a managed issue (one Updraft has jobs for) or a pull request Updraft
//   opened; anything else is left alone, unanswered.
// - Who may give it is controlPolicy's (allowlist and current GitHub permission); a refusal says
//   nothing about the workflow.
import { allowedActorsFor, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import { controlHelp, controlPolicy, controlReply, isAutomatedComment, parseControlComment, refusalMessage, type RepoPermission } from '../control/commands.js';
import { applyLocalControl, LOCAL_UNSUPPORTED, resumeIsElevated, workflowPullRequest, type LocalControlResult } from '../control/local.js';
import { transaction, type Db } from '../db/database.js';
import { getControlCheckpoint, getControlCommand, recordControlCommand, saveControlCheckpoint, setControlReply, type ControlCommandRecord } from '../db/control.js';
import { getLoopPr } from '../db/pr-reviews.js';
import type { GitHubApi, RepoIssueComment } from '../github/api.js';
import type { WorkerIdentity } from '../github/credentials.js';
import type { RepoRef } from '../types.js';
import { nowIso } from '../util/ids.js';
import type { Logger } from '../util/log.js';

/** Pages of comments read per repository per cycle; the checkpoint carries the rest to the next. */
export const MAX_COMMENT_PAGES = 5;

export interface ControlPollDeps {
  db: Db;
  api: GitHubApi;
  config: UpdraftConfig;
  now?: () => number;
}

export function controlsEnabled(config: Pick<UpdraftConfig, 'controls' | 'execution'>): boolean {
  return config.controls?.enabled === true;
}

/** The handle people mention, and the logins that are the worker itself. */
export function controlHandles(config: Pick<UpdraftConfig, 'controls'>, identity: WorkerIdentity): { handle: string; own: string[] } {
  const own = [identity.login, ...(identity.kind === 'app' && identity.appSlug ? [identity.appSlug] : [])];
  const handle = config.controls?.handle ?? (identity.kind === 'app' && identity.appSlug ? identity.appSlug : identity.login);
  return { handle, own };
}

function issueHasJobs(db: Db, repoId: number, issue: number): boolean {
  return db.prepare('SELECT 1 AS x FROM jobs WHERE repo_id = ? AND issue_number = ? LIMIT 1').get(repoId, issue) !== undefined;
}

/** Everyone the repository's workflows let dispatch work: who may direct it. */
export function repositoryActors(config: UpdraftConfig, cfg: RepositoryConfig): string[] {
  return [...new Set(cfg.workflows.flatMap((wf) => allowedActorsFor(config, wf).map((a) => a.toLowerCase())))];
}

/**
 * Read one repository's new comments and act on the commands among them. Returns how many
 * commands were handled. Throws for API errors on the listing (the checkpoint stays).
 */
export async function pollRepoControls(deps: ControlPollDeps, repo: RepoRef, cfg: RepositoryConfig, identity: WorkerIdentity, log: Logger): Promise<number> {
  const { db, api } = deps;
  const now = deps.now ?? Date.now;
  if (!api.listRepoIssueComments) return 0;
  const cp = getControlCheckpoint(db, repo.id);
  if (!cp) {
    // First look: everything before now is history, never a command.
    const at = nowIso(now);
    saveControlCheckpoint(db, repo.id, { startedAt: at, since: at });
    return 0;
  }
  const { handle, own } = controlHandles(deps.config, identity);
  let since = cp.since;
  let handled = 0;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await api.listRepoIssueComments(repo, { since: cp.since, page });
    for (const c of res.comments) {
      if (c.updatedAt > since) since = c.updatedAt;
      if (Date.parse(c.createdAt) <= Date.parse(cp.startedAt) || c.updatedAt !== c.createdAt) continue;
      if (await handleComment(deps, repo, cfg, c, handle, own, log)) handled++;
    }
    if (res.nextPage === null) break;
  }
  saveControlCheckpoint(db, repo.id, { startedAt: cp.startedAt, since });
  return handled;
}

async function handleComment(deps: ControlPollDeps, repo: RepoRef, cfg: RepositoryConfig, c: RepoIssueComment, handle: string, own: string[], log: Logger): Promise<boolean> {
  const { db, api, config } = deps;
  const now = deps.now ?? Date.now;
  const parsed = parseControlComment(c.body, [handle]);
  if (parsed.kind === 'none') return false;
  const source = String(c.id);
  if (getControlCommand(db, repo.id, source)) return false;
  const command = parsed.kind === 'command' ? parsed.command : 'help';
  // Whose workflow: a pull request Updraft opened, or an issue it has worked on. Nothing else.
  const loopPr = c.onPullRequest ? getLoopPr(db, repo.id, c.issueNumber) : null;
  const issue = c.onPullRequest ? loopPr?.issueNumber ?? null : issueHasJobs(db, repo.id, c.issueNumber) ? c.issueNumber : null;
  const base: Omit<ControlCommandRecord, 'outcome' | 'message' | 'headSha'> = {
    source, repoId: repo.id, issue: issue ?? c.issueNumber, pullRequest: c.onPullRequest ? c.issueNumber : null, actor: c.user ?? '', command, receivedAt: nowIso(now),
  };
  const record = (outcome: ControlCommandRecord['outcome'], message: string, headSha: string | null = null) => recordControlCommand(db, { ...base, outcome, message, headSha });
  if (isAutomatedComment({ login: c.user, type: c.userType }, c.body, own)) {
    record('ignored', 'automated comment');
    return false;
  }
  if (issue === null) {
    record('ignored', c.onPullRequest ? 'not a pull request Updraft opened' : 'not an issue Updraft works on');
    return false;
  }
  let permission: RepoPermission | null = null;
  if (api.getRepoPermission && c.user) {
    try {
      permission = await api.getRepoPermission(repo, c.user);
    } catch (err) {
      log.warn('could not read a commenter’s permission; refusing their command', { comment: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const decision = controlPolicy({
    command, actor: { login: c.user, type: c.userType }, body: c.body, ownLogins: own, allowedActors: repositoryActors(config, cfg), permission,
    elevated: command === 'resume' && resumeIsElevated(db, repo.id, issue),
  });
  const reply = async (message: string) => {
    try {
      const posted = await api.createIssueComment(repo, c.issueNumber, controlReply(c.id, `@${c.user} ${message}`));
      setControlReply(db, repo.id, source, posted.id);
    } catch (err) {
      log.warn('could not reply to a command', { comment: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  };
  if (!decision.allowed) {
    record(decision.respond === 'ignore' ? 'ignored' : 'refused', decision.reason);
    if (decision.respond === 'refuse') await reply(refusalMessage(decision.reason, command));
    log.info('command refused', { comment: c.id, actor: c.user, command, reason: decision.reason });
    return true;
  }
  if (parsed.kind !== 'command' || parsed.command === 'help') {
    record('noop', parsed.kind === 'command' ? 'help' : parsed.reason);
    await reply(`${parsed.kind === 'command' ? '' : 'That is not a command I know. '}${controlHelp(handle, { unsupported: LOCAL_UNSUPPORTED })}`);
    return true;
  }

  // The subject as GitHub has it now: open or not, and the pull request's head.
  const pr = workflowPullRequest(db, repo.id, issue, c.onPullRequest ? c.issueNumber : null);
  let subjectState: 'open' | 'closed' | 'merged';
  let headSha: string | null = null;
  try {
    if (c.onPullRequest || pr) {
      const details = await api.getPullRequest(repo, pr?.prNumber ?? c.issueNumber);
      headSha = details.state === 'open' ? details.headSha : null;
      if (c.onPullRequest) subjectState = details.merged ? 'merged' : details.state;
    }
    if (!c.onPullRequest) subjectState = (await api.getIssue(repo, issue)).state;
  } catch (err) {
    // Not recorded: the next cycle reads the comment again (it is still the newest update).
    log.warn('could not read the subject of a command; trying again next cycle', { comment: c.id, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  let result: LocalControlResult | null = null;
  transaction(db, () => {
    result = applyLocalControl(db, config, {
      command: parsed.command, repo, cfg, issue, pullRequest: pr?.prNumber ?? (c.onPullRequest ? c.issueNumber : null), headSha,
      subjectState: subjectState!, actor: c.user!, source, url: c.htmlUrl, text: parsed.text, target: parsed.target,
    }, now);
    record(result.outcome, result.message, headSha);
  });
  const done = result as LocalControlResult | null;
  if (done) {
    log.info('command handled', { comment: c.id, actor: c.user, command: parsed.command, issue, outcome: done.outcome });
    await reply(done.message + (parsed.truncated ? ' (Only the first 2000 characters of the instructions were kept.)' : ''));
  }
  return true;
}
