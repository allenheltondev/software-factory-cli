// Publication (repositories.<repo>.publish): after a live run succeeded and left commits on its
// job branch, the worker (never the agent) pushes that branch, opens a PR as the active gh
// account, and comments on the issue. Merging stays a human decision: nothing here merges,
// approves or marks a PR ready.
//
// Every step is idempotent, keyed by the run id, so a retry (automatic or `updraft publish`)
// never creates a duplicate:
// - push: the remote branch is checked first. Absent: a create-only push, which Git refuses if
//   the branch appeared meanwhile. Same SHA: already pushed. Different SHA (before or during the
//   push): refuse; an existing branch is never moved.
// - PR: the recorded PR, else any PR (open, closed or merged) whose head is the job branch, else
//   a new one.
// - comment: the recorded comment, else an issue comment carrying the run's marker, else a new one.
//
// The push authenticates as the same gh account as the API calls: for an https://github.com
// remote the token goes to git through GIT_CONFIG_* environment variables as an extra header
// scoped to https://github.com/ (never in argv, a URL or a file); other remotes (SSH, host
// aliases) use git's own credentials. Hooks are disabled for these git commands, since the agent
// could have written them.
//
// With a GitHub App configured (github.app), "the gh account" above is the App's installation:
// the token is an installation token issued for the push, and the push always goes over HTTPS to
// https://github.com/OWNER/REPO.git, whatever protocol the clone's remote uses, because an SSH
// push would be made with the person's key and so as the person (docs/github-app.md).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ownEntry, getJob, getRun } from '../db/queue.js';
import {
  beginPublication,
  finishPublication,
  getPublication,
  listDuePublications,
  holdPublication,
  PublicationSupersededError,
  recordPublicationProgress,
} from '../db/publications.js';
import { listUnpublishedSinceEnabled } from '../db/publish-settings.js';
import { dependencyRef, getDependencyWait } from '../db/dependency-waits.js';
import { recordError, type Db } from '../db/database.js';
import { autoMergeMethod, publishMode, type MergeMethod, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import {
  assertValidBranchName,
  GitError,
  isGitHubRemoteFor,
  listRemotes,
  redactRemoteUrl,
  remoteDefaultBranch,
  remoteOwnerNameMatches,
  runGit as defaultRunGit,
  selectRepoRemote,
  type GitOptions,
  type GitOutput,
} from '../git/git.js';
import { jobBranchName, withCheckoutLock } from '../git/worktree.js';
import { GitHubError, type GitHubApi, type GitHubPullRequest } from '../github/api.js';
import { APP_PERMISSIONS_HINT, GitHubAppError, redactGitHubSecrets } from '../github/app-auth.js';
import type { WorkerKind } from '../github/credentials.js';
import type { UpdraftPaths } from '../paths.js';
import { reviewOf, revisionOf, type Job, type Publication, type Run, type RunSummary } from '../types.js';
import type { Logger } from '../util/log.js';
import { findRepoConfig } from '../worker/executor.js';
import { verificationLines, verificationNotes } from '../worker/verify.js';
import { capWholeBlocks, safeMarkdown, stripMachineBlocks } from './markdown.js';
import { renderStatusTable, statusKeys, statusLinkFor } from './assignment-comment.js';
import { consoleWorkflowUrl, type ConsoleContext } from './console-link.js';
import { quietFor, writeStatusComment } from './status-comment.js';
import { STATUS_STAGE } from './status-marker.js';
import { code } from './failure-comment.js';
import { detailLines, runDetails, type RunDetails } from './run-details.js';

/** How long a publication may hold its lease before another process may take it over. */
export const PUBLISH_LEASE_SECONDS = 10 * 60;
/**
 * How long one attempt may run. Shorter than the lease, and checked (with ownership) right
 * before every write, so an attempt held up by slow requests stops instead of writing late.
 */
export const PUBLISH_ATTEMPT_SECONDS = 8 * 60;
/** Attempts (first try included) before the worker stops retrying a transient failure on its own. */
export const MAX_AUTO_ATTEMPTS = 5;
/** Runs the startup sweep publishes at most, oldest first; the rest wait for the next start or `updraft publish`. */
export const STARTUP_SWEEP_LIMIT = 10;
const BASE_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 60 * 60;
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const MAX_FINAL_MESSAGE = 6_000;
const MAX_BODY = 60_000;
const MAX_TITLE = 256;

/** The scopes publication needs, for permission errors. */
export const TOKEN_SCOPES_HINT =
  'Publication needs push access to the repository and a token with the classic "repo" scope, or a fine-grained ' +
  'token with Contents, Pull requests and Issues set to read and write. With gh: gh auth refresh -h github.com -s repo. ' +
  `With a GitHub App (github.app) instead: ${APP_PERMISSIONS_HINT}`;

export type RunGit = (args: readonly string[], opts: GitOptions) => Promise<GitOutput>;

export interface PublishDeps {
  db: Db;
  config: UpdraftConfig;
  paths: UpdraftPaths;
  api: GitHubApi;
  log: Logger;
  /**
   * A newly read token for a push to `repoFullName`, from the worker's credentials
   * (src/github/credentials.ts): the gh account's (GH_TOKEN / GITHUB_TOKEN, else `gh auth token`),
   * or an installation token of the GitHub App. Read only for pushes over https.
   */
  token: (repoFullName: string) => Promise<string>;
  /**
   * 'app' when the worker acts as a GitHub App: pushes then always go over HTTPS with the
   * installation token, never with the SSH key of the clone's remote. Default 'user'.
   */
  workerKind?: WorkerKind;
  git?: string;
  /** Injected in tests to record what reaches git. */
  runGit?: RunGit;
  /** Base environment for git; defaults to the worker's. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Single-event runs on a state database shared between machines (src/worker/scope.ts): what a
   * publisher does on its own after a poll (retries, reviewer jobs, auto-merge, notices) is
   * limited to these runs and pull requests. Absent: everything in the database, as for the worker.
   */
  scope?: PublishScope;
  /**
   * Single-event runs again: another machine may be revising for the same review, from a state
   * database this one cannot see. With this set, a revision announces its push on the pull
   * request before making it, and gives way to one that got there first (src/publish/revision.ts,
   * "One revision per review"). Absent: the worker's own database is the only one, and says.
   */
  claimReviews?: boolean;
  /** Hosted console context (runner-provided), for links in what is posted; absent for standalone workers. */
  console?: ConsoleContext | null;
}

/** Which runs and pull requests a publisher may act on by itself (PublishDeps.scope). */
export interface PublishScope {
  run(runId: string): boolean;
  pr(repoId: number, prNumber: number): boolean;
}

export type PublishResult =
  | { status: 'published'; publication: Publication; already: boolean }
  /** Publication applies but there was nothing to publish (no commits). Recorded. */
  | { status: 'skipped'; reason: string; publication: Publication }
  /** Publication does not apply to this run (publish off, run failed, not a live run...). Nothing recorded. */
  | { status: 'not-eligible'; reason: string }
  /** Another process is publishing this run right now. */
  | { status: 'busy'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean; publication: Publication };

/** Hidden marker on the PR body and the issue comment; finds them again on a retry. */
export function publicationMarker(runId: string): string {
  return `<!-- updraft-run: ${runId} -->`;
}

/** Raised for conditions a retry alone cannot fix. */
export class PublishRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishRefusal';
  }
}

export class TransientError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'TransientError';
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

/**
 * Replace the token (and its encoded header form) wherever it might appear, and anything shaped
 * like a GitHub token, a JWT or a private key, whether or not this attempt held it.
 */
export function redactSecret(text: string, token: string | null): string {
  if (!token) return redactGitHubSecrets(text);
  let out = text.split(token).join('***');
  const b = basicAuth(token);
  out = out.split(b).join('***');
  return redactGitHubSecrets(out);
}

const DEBUG_ENV = /^(GIT_TRACE.*|GIT_CURL_VERBOSE|GIT_REDACT_COOKIES|GIT_TRACE2.*)$/i;
/** Inherited variables that carry Git config or point Git at another repository. */
const ISOLATED_DROP_ENV =
  /^(GIT_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_SYSTEM|GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES)$/i;

/**
 * Environment for publication's git commands: no tracing (which could print headers), hooks
 * disabled, and for an https://github.com remote the token as an Authorization header scoped to
 * https://github.com/, passed through GIT_CONFIG_COUNT/KEY/VALUE so it never appears in argv.
 * An empty extraheader first clears any configured for the clone.
 */
export function publishGitEnv(o: {
  base: NodeJS.ProcessEnv;
  pushUrl: string;
  token: string | null;
  hooksPath: string;
  /**
   * Ignore every Git config file and inherited config: no system or global config (the global
   * path is pointed at this empty file), no `-c`/GIT_CONFIG_* from the environment, and no
   * repository-location overrides. With a throwaway repository as the working directory, the
   * only settings in effect are the ones set here, so nothing can rewrite or redirect the URL.
   */
  isolateWith?: { emptyGlobalConfig: string };
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(o.base)) {
    if (DEBUG_ENV.test(k)) continue;
    if (o.isolateWith && ISOLATED_DROP_ENV.test(k)) continue;
    env[k] = v;
  }
  if (o.isolateWith) {
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = o.isolateWith.emptyGlobalConfig;
  }
  const pairs: Array<[string, string]> = [['core.hooksPath', o.hooksPath]];
  if (o.token && isHttpsGitHub(o.pushUrl)) {
    pairs.push(['http.https://github.com/.extraheader', '']);
    pairs.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basicAuth(o.token)}`]);
  }
  const countKey = Object.keys(env).find((k) => k.toUpperCase() === 'GIT_CONFIG_COUNT') ?? 'GIT_CONFIG_COUNT';
  let n = Number(env[countKey] ?? 0);
  if (!Number.isInteger(n) || n < 0) n = 0;
  for (const [key, value] of pairs) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  delete env[countKey];
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

export function isHttpsGitHub(url: string): boolean {
  return /^https:\/\/(?:[^@/]*@)?github\.com\//i.test(url.trim());
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyGitHub(err: GitHubError, repoFullName: string, runId: string): { error: string; retryable: boolean; retryAfter: number | null } {
  // A GitHub App problem that waiting does not fix; its message already says what to change.
  if (err instanceof GitHubAppError) return { error: err.message, retryable: false, retryAfter: null };
  if (err.status === 0 || err.status >= 500 || err.isRateLimit) {
    return { error: `GitHub is unavailable for now: ${err.message}`, retryable: true, retryAfter: err.retryAfterSeconds };
  }
  if (err.status === 422 && /draft/i.test(err.message)) {
    return {
      error:
        `GitHub refused a draft PR for ${repoFullName} (${err.message}). Draft PRs are not available for private ` +
        `repositories on some plans. Set repositories.${repoFullName}.publish: pr to open ready-for-review PRs ` +
        `instead, then run "updraft publish ${runId}".`,
      retryable: false,
      retryAfter: null,
    };
  }
  if (err.status === 401) {
    return { error: `GitHub rejected the token (401). Run "gh auth login" or set GH_TOKEN. ${TOKEN_SCOPES_HINT}.`, retryable: false, retryAfter: null };
  }
  if (err.status === 403 || err.status === 404) {
    return {
      error: `the active GitHub account cannot write to ${repoFullName} (${err.message}). ${TOKEN_SCOPES_HINT}.`,
      retryable: false,
      retryAfter: null,
    };
  }
  return { error: err.message, retryable: false, retryAfter: null };
}

const GIT_AUTH = /authentication failed|permission to .* denied|permission denied|could not read (username|password)|terminal prompts disabled|invalid username or password|returned error: 40[13]|repository not found|write access to repository not granted/i;
const GIT_NETWORK = /could not resolve host|failed to connect|connection (timed out|reset|refused)|operation timed out|the remote end hung up|early eof|returned error: 5\d\d|ssl_|gnutls|tls connection|network is unreachable|rpc failed/i;

export function classifyGit(err: GitError, what: string, remote: string, repoFullName: string): Error {
  // Redacted before it is cut down to its last lines: a secret cut in half no longer looks like one.
  const detail = redactGitHubSecrets(err.stderr).trim().split(/\r?\n/).filter(Boolean).slice(-3).join('; ') || err.message;
  if (/without `?workflows?`? permission/i.test(err.stderr)) {
    return new PublishRefusal(
      `${what} to ${remote} was rejected (${detail}): the commits change files under .github/workflows, which a GitHub App may ` +
        'push only with the "Workflows" repository permission (read and write). Grant it to the App and accept it on the installation, ' +
        'then publish the run again',
    );
  }
  if (GIT_AUTH.test(err.stderr)) {
    return new PublishRefusal(
      `${what} to ${remote} was refused for lack of access (${detail}). For an https remote the worker uses the gh ` +
        `account's token; for SSH, your SSH key. ${TOKEN_SCOPES_HINT}.`,
    );
  }
  if (GIT_NETWORK.test(err.stderr) || err.exitCode === null) {
    return new TransientError(`${what} to ${remote} failed (${detail})`);
  }
  if (/\[rejected\]|non-fast-forward|fetch first|protected branch|declined/i.test(err.stderr)) {
    return new PublishRefusal(`${what} to ${remote} was rejected (${detail}); the remote branch for ${repoFullName} was not changed`);
  }
  return new PublishRefusal(`${what} to ${remote} failed (${detail})`);
}

/** What went wrong in a publication or revision attempt, and whether trying again can help. */
export function classifyFailure(
  err: unknown,
  o: { repoFullName: string; runId: string; aborted: boolean },
): { error: string; retryable: boolean; retryAfter: number | null } {
  if (err instanceof GitHubError) return classifyGitHub(err, o.repoFullName, o.runId);
  if (err instanceof TransientError) return { error: err.message, retryable: true, retryAfter: err.retryAfterSeconds };
  if (err instanceof PublishRefusal) return { error: err.message, retryable: false, retryAfter: null };
  if (err instanceof GitError) {
    // ls-remote and friends: network trouble is worth retrying, anything else is not.
    const e = classifyGit(err, 'git', 'the remote', o.repoFullName);
    return { error: e.message, retryable: e instanceof TransientError, retryAfter: null };
  }
  if (o.aborted || (err instanceof Error && err.name === 'AbortError')) {
    return { error: 'publication was stopped before it finished', retryable: true, retryAfter: null };
  }
  return { error: message(err), retryable: false, retryAfter: null };
}

// ---------------------------------------------------------------------------
// PR and comment text
// ---------------------------------------------------------------------------

/** A Markdown code fence that the text cannot close, so mentions, links and closing keywords in it stay inert. */
export function fenced(text: string, lang = 'text'): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

export function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-line text for places Markdown is not fenced: no newlines, mentions or HTML comments. */
export function inline(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/@/g, '@​').replace(/<!--|-->/g, '').trim();
}

/**
 * What a run left, for a PR body or a PR comment: its commits, the diff stat, the verification
 * result and the agent's final message. Machine-generated output is fenced or flattened; the
 * agent's prose is rendered as sanitized Markdown (see markdown.ts).
 */
export function renderRunResult(s: RunSummary, commitCount: number): string[] {
  const commits = s.commits.length ? s.commits.join('\n') : '(none listed)';
  const more = commitCount > s.commits.length ? `\n… ${commitCount - s.commits.length} more` : '';
  // The agents' machine-readable blocks are for the worker, and a block is kept whole or not at
  // all: a cap never leaves half a fence behind.
  const { text, cut } = capWholeBlocks(stripMachineBlocks(s.lastOutput.join('\n').trim()), MAX_FINAL_MESSAGE);
  const finalMessage = safeMarkdown(text || '(no output)', MAX_FINAL_MESSAGE + 1) + (cut ? `\n\n_The rest of the agent's message is in the run log._` : '');
  return [
    `**Commits** (${commitCount})`,
    '',
    fenced(cap(commits + more, 8_000)),
    '',
    `**Changes:** ${inline(s.diffStat)}`,
    '',
    ...(s.verification
      ? [
          `**Verification** (${s.verification.passed ? 'passed' : 'did not pass'}; commands run by the worker after the agent finished)`,
          '',
          fenced(cap(verificationLines(s.verification).join('\n') || '(no commands)', 4_000)),
          '',
          ...verificationNotes(s.verification).flatMap((n) => [`Note: ${inline(n)}.`, '']),
        ]
      : []),
    "**The agent's final message**",
    '',
    finalMessage,
  ];
}

/**
 * The merge Updraft will attempt for a pull request it opens, as its body states it: what
 * merge.ts will do with this pull request, given the repository's autoMerge and the gates that
 * can already be read when it is opened. Never more than Updraft will try.
 */
export type MergePolicy = { auto: true; method: MergeMethod } | { auto: false; reason: string | null };

export function mergePolicy(
  config: UpdraftConfig,
  repo: RepositoryConfig,
  o: { mode: 'draft-pr' | 'pr'; verifies: boolean; summary: Pick<RunSummary, 'verification' | 'headSha'> },
): MergePolicy {
  const method = autoMergeMethod(config, repo);
  if (!method) return { auto: false, reason: null };
  // A draft is no gate here: a ready-to-merge verdict marks it ready (review.ts), or, with the CI
  // step, its passing checks do (ci.ts). Gate 1 (merge.ts): the action's verify commands must have passed on exactly this commit.
  const v = o.summary.verification;
  if (o.verifies && !(v?.passed === true && v.exact === true && (!o.summary.headSha || v.sha === o.summary.headSha))) {
    return { auto: false, reason: "the worker's verify commands did not pass on this commit" };
  }
  return { auto: true, method };
}

export function mergeSentence(p: MergePolicy): string {
  // Branch protection and the required checks still decide: Updraft only ever asks GitHub to merge.
  if (p.auto) return `Updraft merges this (${code(p.method)}) once review and required checks pass.`;
  return p.reason ? `Merging is up to a person: ${p.reason}.` : 'Merging is up to a person.';
}

export function renderPrBody(o: {
  runId: string;
  issueNumber: number;
  agent: string;
  summary: RunSummary;
  commitCount: number;
  mode: 'draft-pr' | 'pr';
  /** What merge.ts will do with it; absent: up to a person. */
  merge?: MergePolicy;
  /** The run's console timeline, when hosted. */
  link?: string | null;
}): string {
  const markable = /^[A-Za-z0-9_.-]{1,64}$/.test(o.agent);
  // An agent name the hidden marker cannot carry keeps the line a lost-state restore reads instead.
  const where = o.link
    ? `[View this work in Updraft](${o.link})${markable ? '' : ` Opened by updraft from run ${code(o.runId)} (agent ${inline(o.agent)}).`}`
    : markable ? `Run ${code(o.runId)}, agent ${code(inline(o.agent))}.` : `Opened by updraft from run ${code(o.runId)} (agent ${inline(o.agent)}).`;
  const body = [
    `Closes #${o.issueNumber}`,
    '',
    `${mergeSection(o.merge ?? { auto: false, reason: null }, o.mode)} ${where}`,
    '',
    ...renderRunResult(o.summary, o.commitCount),
  ].join('\n');
  // The agent beside the run's marker: what a run that lost its state reads back (run-event-restore.ts).
  const agent = markable ? `\n${prAgentMarker(o.runId, o.agent)}` : '';
  const marker = `${publicationMarker(o.runId)}${agent}`;
  return `${cap(body, MAX_BODY - marker.length - 2)}\n\n${marker}`;
}

const MERGE_OPEN = '<!-- updraft-merge -->';
const MERGE_CLOSE = '<!-- /updraft-merge -->';

/** The PR body's merge sentence, between markers so a later verified head can restate it. */
function mergeSection(p: MergePolicy, mode: 'draft-pr' | 'pr'): string {
  return `${MERGE_OPEN}${mergeSentence(p)}${mode === 'draft-pr' ? ' Opened as a draft.' : ''}${MERGE_CLOSE}`;
}

/**
 * `body` with its merge sentence restated for `p` (a revision or CI fix pushed a new head, which
 * its own verification is about). Null when the body has no merge section (opened before #173),
 * or nothing changes.
 */
export function withMergeSentence(body: string, p: MergePolicy): string | null {
  const start = body.indexOf(MERGE_OPEN);
  const end = body.indexOf(MERGE_CLOSE, start);
  if (start < 0 || end < 0) return null;
  const draft = body.slice(start, end).includes(' Opened as a draft.') ? ' Opened as a draft.' : '';
  const next = `${body.slice(0, start)}${MERGE_OPEN}${mergeSentence(p)}${draft}${body.slice(end)}`;
  return next === body ? null : next;
}

/** Hidden marker naming the agent of the run that opened a pull request. */
export function prAgentMarker(runId: string, agent: string): string {
  return `<!-- updraft-agent: ${runId} ${agent} -->`;
}

export function renderIssueComment(o: { runId: string; pr: GitHubPullRequest; commitCount: number; summary: RunSummary; details?: RunDetails }): string {
  const kind = o.pr.draft ? 'Draft PR' : 'PR';
  return [
    `${kind} #${o.pr.number} has the changes for this issue: ${o.pr.htmlUrl}`,
    '',
    `From run \`${o.runId}\`: ${o.commitCount} commit(s), ${inline(o.summary.diffStat)}. Merging is up to a person.`,
    ...(o.details ? ['', `- **Worker** ${code(o.details.worker)}`, ...detailLines(o.details)] : []),
    '',
    publicationMarker(o.runId),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

interface Eligible {
  run: Run & { summary: RunSummary };
  job: Job;
  repoFullName: string;
  repo: NonNullable<ReturnType<typeof findRepoConfig>>['repo'];
  mode: 'draft-pr' | 'pr';
  checkoutPath: string;
}

function eligibility(deps: PublishDeps, runId: string): { ok: true; e: Eligible } | { ok: false; reason: string } {
  const run = getRun(deps.db, runId);
  if (!run) return { ok: false, reason: `run ${runId} not found` };
  const job = getJob(deps.db, run.jobId);
  if (!job) return { ok: false, reason: `job ${run.jobId} of run ${runId} not found` };
  // A revision run never opens a PR: its commits go to the PR that exists (src/publish/revision.ts).
  if (revisionOf(job)) return { ok: false, reason: `run ${runId} is a revision of an existing pull request, not a publication` };
  // A reviewer run publishes nothing at all: its result is a verdict (src/publish/review.ts).
  if (reviewOf(job)) return { ok: false, reason: `run ${runId} is a review of an existing pull request, not a publication` };
  if (deps.config.execution.mode !== 'live') {
    return { ok: false, reason: `publication applies only in live mode (execution.mode is ${deps.config.execution.mode})` };
  }
  const found = findRepoConfig(deps.config, job);
  if (!found) return { ok: false, reason: `${job.repoFullName} is no longer configured` };
  const mode = publishMode(found.repo);
  if (mode === 'none') return { ok: false, reason: `publication is off for ${found.fullName} (set repositories.${found.fullName}.publish)` };
  const action = ownEntry(deps.config.actions, job.action);
  if (!action || action.output !== 'local-branch') {
    return { ok: false, reason: `action "${job.action}" ${action ? `has output ${action.output}` : 'is no longer configured'}; only local-branch actions are published` };
  }
  if (run.outcome !== 'succeeded') {
    return { ok: false, reason: `run ${runId} ${run.outcome ? `ended ${run.outcome}` : 'has not finished'}; only succeeded runs are published` };
  }
  if (!run.summary) return { ok: false, reason: `run ${runId} has no agent summary; only live agent runs are published` };
  // A run that waits on another repository's pull request publishes nothing (docs/dependencies.md).
  const wait = getDependencyWait(deps.db, runId);
  if (wait) return { ok: false, reason: `run ${runId} waits on ${dependencyRef(wait)}; a waiting run publishes nothing, its follow-up does` };
  if (!found.repo.checkoutPath) return { ok: false, reason: `repositories.${found.fullName}.checkoutPath is not set` };
  return {
    ok: true,
    e: {
      run: run as Run & { summary: RunSummary },
      job,
      repoFullName: found.fullName,
      repo: found.repo,
      mode,
      checkoutPath: resolve(deps.paths.configDir, found.repo.checkoutPath),
    },
  };
}

// ---------------------------------------------------------------------------
// Where a push goes
// ---------------------------------------------------------------------------

/** The one validated destination of a push, and the isolated repository to run it from. */
export interface PushTarget {
  /** Name of the clone's remote, for messages. */
  remote: string;
  /** The remote's single push URL; network commands name it directly. */
  pushUrl: string;
  /** Options for network commands: the throwaway repository as cwd, hooks off, no config files, the token if any. */
  net: GitOptions;
}

/**
 * Validate where a push for `repoFullName` would go and set up the isolated repository it runs
 * from. Shared by publication and the revision push, so both hold to the same rules. Call it
 * inside withCheckoutLock. `scratchDir` is a fresh temporary directory the caller removes.
 * `onToken` receives the token as soon as it is read, so the caller can redact it from any error.
 */
export async function openPushTarget(
  deps: Pick<PublishDeps, 'token' | 'workerKind' | 'env' | 'git' | 'runGit'>,
  o: { checkoutPath: string; repoFullName: string; remote: string | undefined; scratchDir: string; signal: AbortSignal; onToken: (token: string) => void },
): Promise<PushTarget> {
  const { checkoutPath, repoFullName, scratchDir } = o;
  const run1 = deps.runGit ?? defaultRunGit;
  const local: GitOptions = { cwd: checkoutPath, git: deps.git };
  const selection = selectRepoRemote(await listRemotes(local), repoFullName, o.remote);
  if (!selection.ok) throw new PublishRefusal(`${checkoutPath}: ${selection.error}`);
  const remoteName = selection.remote.name;
  // Push to exactly the repository the run was for, even if a push URL was configured since.
  // `git push <remote>` pushes to every pushurl the remote has, so all of them are listed
  // (after insteadOf rewriting, as push applies it) and exactly one is allowed.
  const pushUrls = (await run1(['remote', 'get-url', '--push', '--all', remoteName], local)).stdout
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter(Boolean);
  if (pushUrls.length !== 1) {
    throw new PublishRefusal(
      `remote "${remoteName}" has ${pushUrls.length} push URLs (${pushUrls.map(redactRemoteUrl).join(', ') || 'none'}); ` +
        'publication pushes to exactly one destination. Leave the remote with a single push URL, or set ' +
        `repositories.${repoFullName}.remote to a remote that has one`,
    );
  }
  const pushUrlRaw = pushUrls[0]!;
  const matches = o.remote !== undefined ? remoteOwnerNameMatches(pushUrlRaw, repoFullName) : isGitHubRemoteFor(pushUrlRaw, repoFullName);
  if (!matches) {
    throw new PublishRefusal(`the push URL of remote "${remoteName}" (${redactRemoteUrl(pushUrlRaw)}) does not point at ${repoFullName}`);
  }
  // As a GitHub App the push must carry the installation token, so it goes over HTTPS to the
  // repository the remote was just validated to be, never over SSH with the person's key (and
  // never with credentials embedded in the remote's URL).
  const pushUrl = deps.workerKind === 'app' ? `https://github.com/${repoFullName}.git` : pushUrlRaw;
  let token: string | null = null;
  if (isHttpsGitHub(pushUrl)) {
    token = await deps.token(repoFullName);
    o.onToken(token);
  }
  const emptyGlobalConfig = join(scratchDir, 'empty-gitconfig');
  writeFileSync(emptyGlobalConfig, '');
  const env = publishGitEnv({
    base: deps.env ?? process.env,
    pushUrl,
    token,
    hooksPath: join(scratchDir, 'none'),
    isolateWith: { emptyGlobalConfig },
  });
  // Network commands run in a throwaway bare repository that borrows the clone's objects
  // (alternates) and nothing else: no remotes, no url.*.insteadOf rules, no hooks. They name
  // the validated URL itself, so Git can't resolve it to a different destination later.
  const pushRepo = join(scratchDir, 'push.git');
  const netOpts: GitOptions = { cwd: scratchDir, git: deps.git, env, signal: o.signal };
  await run1(['init', '--bare', '--quiet', pushRepo], netOpts);
  // Relative to the clone on older Git; resolve() leaves an absolute one as it is.
  const commonDir = resolve(checkoutPath, (await run1(['rev-parse', '--git-common-dir'], local)).stdout.trim());
  const objects = join(commonDir, 'objects');
  writeFileSync(join(pushRepo, 'objects', 'info', 'alternates'), `${objects}\n`);
  return { remote: remoteName, pushUrl, net: { ...netOpts, cwd: pushRepo } };
}

// ---------------------------------------------------------------------------
// The publication itself
// ---------------------------------------------------------------------------

/**
 * Publish one run, or resume its publication. Never throws for publication problems: the result
 * (and the publications table) says what happened. A run that is not eligible is left untouched.
 */
export async function publishRun(
  deps: PublishDeps,
  runId: string,
  /** `source` names what started this publication (e.g. "startup sweep") in the logs and run.log. */
  opts: { signal?: AbortSignal; source?: string } = {},
): Promise<PublishResult> {
  const now = deps.now ?? Date.now;
  const check = eligibility(deps, runId);
  if (!check.ok) return { status: 'not-eligible', reason: check.reason };
  const { run, job, repoFullName, repo, mode, checkoutPath } = check.e;
  const repoRef = { id: job.repoId, fullName: repoFullName };
  const branch = run.summary.branch;
  const log = deps.log.child({ runId, repo: repoFullName, issue: job.issueNumber, ...(opts.source ? { source: opts.source } : {}) });

  const begun = beginPublication(deps.db, {
    runId,
    jobId: job.id,
    repoId: job.repoId,
    repoFullName,
    issueNumber: job.issueNumber,
    mode,
    branch,
    leaseSeconds: PUBLISH_LEASE_SECONDS,
    now,
  });
  if (!begun.ok) {
    if (begun.reason === 'published') return { status: 'published', publication: begun.publication, already: true };
    return { status: 'busy', reason: `run ${runId} is being published by another process (lease until ${begun.publication.leaseExpiresAt})` };
  }
  let pub = begun.publication;
  // This attempt's fence: every state write and every external write checks it still owns the
  // publication, so an attempt that outlived its lease can't act after a newer one took over.
  const fence = { attempt: pub.attempts, leaseSeconds: PUBLISH_LEASE_SECONDS, now };
  const attemptStarted = now();
  /** Before each write to GitHub: still the owner (renewing the lease) and within the deadline. */
  const hold = () => {
    holdPublication(deps.db, runId, fence);
    if (now() - attemptStarted > PUBLISH_ATTEMPT_SECONDS * 1000) {
      throw new TransientError(`publication attempt ${fence.attempt} ran past its ${PUBLISH_ATTEMPT_SECONDS / 60}-minute deadline`);
    }
  };

  let token: string | null = null;
  const runLog = async (lines: string[]) => {
    if (!run.logPath) return;
    try {
      await appendFile(run.logPath, `${lines.map((l) => redactSecret(`publication: ${l}`, token)).join('\n')}\n`, 'utf8');
    } catch (err) {
      log.warn('could not write to run.log', { error: message(err) });
    }
  };
  const progress = (p: Parameters<typeof recordPublicationProgress>[3]) => {
    recordPublicationProgress(deps.db, runId, fence, p);
    pub = getPublication(deps.db, runId)!;
  };

  await runLog([`attempt ${pub.attempts} (${mode}${opts.source ? `, ${opts.source}` : ''}) at ${new Date(now()).toISOString()}`]);
  const hooksDir = mkdtempSync(join(tmpdir(), 'updraft-publish-nohooks-'));
  try {
    const run1 = deps.runGit ?? defaultRunGit;
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(NETWORK_TIMEOUT_MS)]) : AbortSignal.timeout(NETWORK_TIMEOUT_MS);
    const local: GitOptions = { cwd: checkoutPath, git: deps.git };

    // 1. The clone, its remote, the base branch and the job branch's commit.
    const { remote, pushUrl, net, localSha, commitCount } = await withCheckoutLock(checkoutPath, async () => {
      const target = await openPushTarget(deps, {
        checkoutPath,
        repoFullName,
        remote: repo.remote,
        scratchDir: hooksDir,
        signal,
        onToken: (t) => (token = t),
      });
      const { remote: remoteName, pushUrl: pushUrlRaw, net: netOpts } = target;

      const expected = jobBranchName(job, run.attempt);
      if (branch !== expected) throw new PublishRefusal(`run ${runId} recorded branch ${branch}, not the job branch ${expected}; refusing to push it`);
      await assertValidBranchName(branch, local);
      const sha = (await run1(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], local).catch(() => null))?.stdout.trim();
      if (!sha) throw new PublishRefusal(`the job branch ${branch} no longer exists in ${checkoutPath}`);
      // Publish the commit the run ended on, or nothing: the run's summary and verification are
      // about that commit, and a retry long after must not attach them to whatever is there now.
      const ended = run.summary.headSha;
      if (ended && sha !== ended) {
        throw new PublishRefusal(
          `the job branch ${branch} is at ${sha.slice(0, 12)}, not at ${ended.slice(0, 12)} where run ${runId} ended; ` +
            'the branch was changed after the run, so its result and verification do not describe this commit. Nothing was pushed',
        );
      }
      const count = Number((await run1(['rev-list', '--count', `${run.summary.baseSha}..${sha}`], local)).stdout.trim()) || 0;
      return { remote: remoteName, pushUrl: pushUrlRaw, net: netOpts, localSha: sha, commitCount: count };
    });

    if (commitCount === 0) {
      const reason = `the job branch ${branch} has no commits since the base ${run.summary.baseSha.slice(0, 12)}; nothing to publish`;
      if (!finishPublication(deps.db, runId, fence.attempt, { state: 'skipped', error: reason, now })) throw new PublicationSupersededError(runId, fence.attempt);
      await runLog([`skipped: ${reason}`]);
      log.info('publication skipped', { reason });
      return { status: 'skipped', reason, publication: getPublication(deps.db, runId)! };
    }

    const baseBranch = pub.baseBranch ?? repo.baseBranch ?? (await remoteDefaultBranch(pushUrl, net));
    if (baseBranch !== pub.baseBranch) progress({ baseBranch });
    if (branch === baseBranch) throw new PublishRefusal(`the job branch ${branch} is the base branch; refusing to push to it`);

    // 2. Create the branch on the remote, unless it already has exactly this commit. The push
    // only ever creates it: anything already there is left alone.
    const remoteRef = `refs/heads/${branch}`;
    const readRemoteSha = async (): Promise<string | null> => {
      const listed = (await run1(['ls-remote', pushUrl, remoteRef], net)).stdout;
      return (
        listed
          .split(/\r?\n/)
          .map((l) => l.trim().split(/\s+/))
          .find(([, ref]) => ref === remoteRef)?.[0] ?? null
      );
    };
    const refuseOther = (sha: string) =>
      new PublishRefusal(
        `${remoteRef} on ${remote} is at ${sha.slice(0, 12)}, but the job branch is at ${localSha.slice(0, 12)}; ` +
          'refusing to overwrite it. Inspect the remote branch; delete it there if it should be replaced, then run ' +
          `"updraft publish ${runId}"`,
      );
    hold();
    const remoteSha = await readRemoteSha();
    if (remoteSha && remoteSha !== localSha) throw refuseOther(remoteSha);
    if (remoteSha === localSha) {
      await runLog([`${remoteRef} is already on ${remote} at ${localSha.slice(0, 12)}`]);
    } else {
      await runLog([`pushing ${branch} (${localSha.slice(0, 12)}, ${commitCount} commit(s)) to ${remote} (${redactRemoteUrl(pushUrl)})`]);
      hold();
      try {
        // To the validated URL, from the isolated repository. --force-with-lease=<ref>: with an
        // empty expected value makes this create-only: Git refuses the update unless the branch
        // is still absent when the push runs, so a branch someone created after the check above
        // is never moved, not even fast-forwarded. It cannot overwrite anything.
        await run1(
          ['push', '--no-verify', '--recurse-submodules=no', '--porcelain', `--force-with-lease=${remoteRef}:`, pushUrl, `${localSha}:${remoteRef}`],
          net,
        );
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        // Rejected, or the outcome is unknown: look again. Our exact commit there means an earlier
        // or concurrent push of this run already landed it; any other commit is left alone.
        const after = await readRemoteSha().catch(() => undefined);
        if (after === localSha) {
          await runLog([`${remoteRef} is already on ${remote} at ${localSha.slice(0, 12)} (pushed concurrently)`]);
        } else if (after) {
          throw refuseOther(after);
        } else {
          throw classifyGit(err, 'push', remote, repoFullName);
        }
      }
    }
    if (pub.headSha !== localSha || !pub.pushedAt) progress({ headSha: localSha, pushedAt: pub.pushedAt ?? new Date(now()).toISOString() });

    // 3. The PR: recorded, found by head, or new.
    let pr: GitHubPullRequest | null = null;
    if (!pub.prNumber || !pub.prUrl) hold();
    if (pub.prNumber && pub.prUrl) {
      pr = { number: pub.prNumber, htmlUrl: pub.prUrl, state: 'open', draft: mode === 'draft-pr', merged: false, headRef: branch, headRepoId: job.repoId, baseRef: baseBranch, body: '' };
    } else {
      const owner = repoFullName.split('/')[0]!;
      const existing = (await deps.api.listPullRequestsForHead(repoRef, { headOwner: owner, head: branch })).filter(
        (p) => p.headRef === branch && (p.headRepoId === null || p.headRepoId === job.repoId),
      );
      pr = existing.find((p) => p.state === 'open') ?? existing[0] ?? null;
      if (pr) {
        await runLog([`reusing PR #${pr.number} (${pr.state}${pr.merged ? ', merged' : ''}): ${pr.htmlUrl}`]);
      } else {
        const title = cap(job.envelope.issue.title.replace(/\s+/g, ' ').trim() || `Issue #${job.issueNumber}`, MAX_TITLE);
        hold(); // the lookup may have outlived the lease
        pr = await deps.api.createPullRequest(repoRef, {
          title,
          head: branch,
          base: baseBranch,
          draft: mode === 'draft-pr',
          body: renderPrBody({
            runId,
            issueNumber: job.issueNumber,
            agent: run.agent,
            summary: run.summary,
            commitCount,
            mode,
            merge: mergePolicy(deps.config, repo, { mode, verifies: Boolean(ownEntry(deps.config.actions, job.action)?.verify?.length), summary: run.summary }),
            link: consoleWorkflowUrl(deps.console, job.repoId, job.issueNumber),
          }),
        });
        await runLog([`opened ${pr.draft ? 'draft ' : ''}PR #${pr.number}: ${pr.htmlUrl}`]);
      }
      progress({ prNumber: pr.number, prUrl: pr.htmlUrl });
    }

    // 4. The issue comment: recorded, found by marker, or new. Quiet notifications: the issue's
    // live status comment moves to "PR opened" instead (posted, if nothing posted it before).
    if (!pub.commentId && quietFor(deps.config, job)) {
      hold();
      const r = await writeStatusComment(
        { api: deps.api, log },
        {
          repo: repoRef,
          issue: job.issueNumber,
          target: { keys: statusKeys(job, deps.console), create: true },
          stage: STATUS_STAGE.published,
          title: 'PR opened',
          text: `${pr.draft ? 'Draft PR' : 'PR'} #${pr.number} opened: ${pr.htmlUrl}`,
          details: renderStatusTable({ details: runDetails(deps.db, job, run), jobId: job.id, console: deps.console }),
          link: statusLinkFor(deps.console, job.repoId, job.issueNumber),
          pr: pr.number,
        },
      );
      if (r.status !== 'none') {
        progress({ commentId: r.comment.id, commentUrl: r.comment.htmlUrl });
        await runLog([`status comment ${r.status} on issue #${job.issueNumber}: ${r.comment.htmlUrl}`]);
      }
    } else if (!pub.commentId) {
      hold();
      const marker = publicationMarker(runId);
      const found = (await deps.api.listIssueComments(repoRef, job.issueNumber)).find((c) => c.body.includes(marker));
      let comment = found;
      if (!comment) {
        hold(); // the lookup may have outlived the lease
        comment = await deps.api.createIssueComment(repoRef, job.issueNumber, renderIssueComment({ runId, pr, commitCount, summary: run.summary, details: runDetails(deps.db, job, run) }));
      }
      progress({ commentId: comment.id, commentUrl: comment.htmlUrl });
      await runLog([found ? `issue comment already there: ${comment.htmlUrl}` : `commented on issue #${job.issueNumber}: ${comment.htmlUrl}`]);
    }

    if (!finishPublication(deps.db, runId, fence.attempt, { state: 'published', now })) throw new PublicationSupersededError(runId, fence.attempt);
    log.info('published', { pr: pub.prUrl });
    return { status: 'published', publication: getPublication(deps.db, runId)!, already: false };
  } catch (err) {
    if (err instanceof PublicationSupersededError) {
      // A newer attempt owns the row now; leave it, and GitHub, to that attempt.
      log.warn('publication attempt superseded', { attempt: fence.attempt });
      await runLog([`attempt ${fence.attempt} stopped: a newer attempt took over`]);
      return { status: 'busy', reason: err.message };
    }
    const classified = classifyFailure(err, { repoFullName, runId, aborted: Boolean(opts.signal?.aborted) });
    const { retryable, retryAfter } = classified;
    const error = redactSecret(classified.error, token);
    const attempts = pub.attempts;
    let nextAttemptAt: string | null = null;
    if (retryable && attempts < MAX_AUTO_ATTEMPTS) {
      const backoff = retryAfter ?? Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** (attempts - 1));
      nextAttemptAt = new Date(now() + backoff * 1000).toISOString();
    }
    if (!finishPublication(deps.db, runId, fence.attempt, { state: 'failed', error, retryable, nextAttemptAt, now })) {
      log.warn('publication attempt superseded', { attempt: fence.attempt, error });
      return { status: 'busy', reason: new PublicationSupersededError(runId, fence.attempt).message };
    }
    const hint = nextAttemptAt
      ? `the worker retries at ${nextAttemptAt}; "updraft publish ${runId}" retries now`
      : `fix the cause, then run "updraft publish ${runId}"`;
    await runLog([`failed: ${error}`, hint]);
    log.warn('publication failed', { error, retryable, attempts });
    try {
      recordError(deps.db, { scope: 'publish', repoFullName, jobId: job.id, message: `run ${runId}: ${error} (${hint})`, at: new Date(now()).toISOString() });
    } catch {
      // the publications row already holds the error
    }
    return { status: 'failed', error, retryable, publication: getPublication(deps.db, runId)! };
  } finally {
    rmSync(hooksDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------

export interface Publisher {
  /** After a succeeded run is recorded. Never throws. */
  afterRun(runId: string, signal?: AbortSignal): Promise<void>;
  /** Retry transient failures whose time has come, and publications a stopped worker left. Never throws. */
  retryDue(signal?: AbortSignal): Promise<void>;
  /**
   * At worker start: publish succeeded runs that have no publication record at all (the worker
   * stopped between recording the run and publishing it), but only runs that ended at or after
   * publish was turned on for their repository (publish_settings.enabled_at; call
   * syncPublishSettings first). At most STARTUP_SWEEP_LIMIT, oldest first. Never throws.
   */
  sweepUnpublished(signal?: AbortSignal, opts?: { limit?: number }): Promise<void>;
}

export function createPublisher(deps: PublishDeps): Publisher {
  const run = async (runId: string, signal?: AbortSignal, source?: string) => {
    try {
      const r = await publishRun(deps, runId, { signal, ...(source ? { source } : {}) });
      if (r.status === 'not-eligible') deps.log.debug('run not published', { runId, reason: r.reason });
      return r;
    } catch (err) {
      deps.log.error('publication crashed', { runId, error: message(err) });
      return null;
    }
  };
  return {
    async afterRun(runId, signal) {
      await run(runId, signal);
    },
    async retryDue(signal) {
      let due: string[];
      try {
        due = listDuePublications(deps.db, { maxAttempts: MAX_AUTO_ATTEMPTS, now: deps.now }).filter((id) => deps.scope?.run(id) ?? true);
      } catch (err) {
        deps.log.error('could not list publications to retry', { error: message(err) });
        return;
      }
      for (const runId of due) {
        if (signal?.aborted) return;
        await run(runId, signal);
      }
    },
    async sweepUnpublished(signal, opts = {}) {
      const source = 'startup sweep';
      const limit = opts.limit ?? STARTUP_SWEEP_LIMIT;
      let candidates: string[];
      try {
        candidates = listUnpublishedSinceEnabled(deps.db);
      } catch (err) {
        deps.log.error('startup sweep: could not list unpublished runs', { error: message(err) });
        return;
      }
      let attempted = 0;
      for (const [i, runId] of candidates.entries()) {
        if (signal?.aborted) return;
        if (attempted >= limit) {
          deps.log.info('startup sweep: limit reached; the rest wait for the next start or "updraft publish RUN_ID"', {
            limit,
            unchecked: candidates.length - i,
          });
          return;
        }
        // The same rules as every other publication (which also leave out revision and reviewer
        // runs: those never open a PR); the query above only narrows by time.
        let check: ReturnType<typeof eligibility>;
        try {
          check = eligibility(deps, runId);
        } catch (err) {
          deps.log.error('startup sweep: could not check run', { runId, error: message(err) });
          continue;
        }
        if (!check.ok) {
          deps.log.debug('startup sweep: run not published', { runId, reason: check.reason });
          continue;
        }
        if (check.e.run.summary.commitCount === 0) {
          deps.log.debug('startup sweep: run not published', { runId, reason: 'the run left no commits' });
          continue;
        }
        // Nobody asked for this publication, so it happens only when the worker can tell which
        // commit the run produced. publishRun pushes that commit or nothing; a run from before
        // the commit was recorded has no such guard, and is left for "updraft publish RUN_ID".
        if (!check.e.run.summary.headSha) {
          deps.log.info('startup sweep: run not published; it does not record the commit it ended on, so publish it with "updraft publish RUN_ID" if it is wanted', { runId });
          continue;
        }
        attempted++;
        deps.log.info('startup sweep: publishing a succeeded run that has no publication record', {
          runId,
          repo: check.e.repoFullName,
          issue: check.e.job.issueNumber,
          endedAt: check.e.run.endedAt,
        });
        const r = await run(runId, signal, source);
        if (r) deps.log.info('startup sweep: done', { runId, status: r.status });
      }
    },
  };
}

/** True when any repository opts in to publication and the mode runs agents. */
export function publicationEnabled(config: UpdraftConfig): boolean {
  return config.execution.mode === 'live' && Object.values(config.repositories).some((r) => publishMode(r) !== 'none');
}
