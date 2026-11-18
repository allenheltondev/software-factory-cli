// Publication (repositories.<repo>.publish): after a live run succeeded and left commits on its
// job branch, the worker (never the agent) pushes that branch, opens a PR as the active gh
// account, and comments on the issue. Merging stays a human decision: nothing here merges,
// approves or marks a PR ready.
//
// Every step is idempotent, keyed by the run id, so a retry (automatic or `factory publish`)
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
import { recordError, type Db } from '../db/database.js';
import { publishMode, type FactoryConfig } from '../config/schema.js';
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
import type { FactoryPaths } from '../paths.js';
import type { Job, Publication, Run, RunSummary } from '../types.js';
import type { Logger } from '../util/log.js';
import { findRepoConfig } from '../worker/executor.js';
import { verificationLines, verificationNotes } from '../worker/verify.js';

/** How long a publication may hold its lease before another process may take it over. */
export const PUBLISH_LEASE_SECONDS = 10 * 60;
/**
 * How long one attempt may run. Shorter than the lease, and checked (with ownership) right
 * before every write, so an attempt held up by slow requests stops instead of writing late.
 */
export const PUBLISH_ATTEMPT_SECONDS = 8 * 60;
/** Attempts (first try included) before the worker stops retrying a transient failure on its own. */
export const MAX_AUTO_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 60 * 60;
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const MAX_FINAL_MESSAGE = 6_000;
const MAX_BODY = 60_000;
const MAX_TITLE = 256;

/** The scopes publication needs, for permission errors. */
export const TOKEN_SCOPES_HINT =
  'Publication needs push access to the repository and a token with the classic "repo" scope, or a fine-grained ' +
  'token with Contents, Pull requests and Issues set to read and write. With gh: gh auth refresh -h github.com -s repo';

export type RunGit = (args: readonly string[], opts: GitOptions) => Promise<GitOutput>;

export interface PublishDeps {
  db: Db;
  config: FactoryConfig;
  paths: FactoryPaths;
  api: GitHubApi;
  log: Logger;
  /** The active gh account's token (GH_TOKEN / GITHUB_TOKEN, else `gh auth token`). Read only for https remotes. */
  token: () => Promise<string>;
  git?: string;
  /** Injected in tests to record what reaches git. */
  runGit?: RunGit;
  /** Base environment for git; defaults to the worker's. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
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
  return `<!-- factory-run: ${runId} -->`;
}

/** Raised for conditions a retry alone cannot fix. */
export class PublishRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishRefusal';
  }
}

class TransientError extends Error {
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

/** Replace the token (and its encoded header form) wherever it might appear. */
export function redactSecret(text: string, token: string | null): string {
  if (!token) return text;
  let out = text.split(token).join('***');
  const b = basicAuth(token);
  out = out.split(b).join('***');
  return out;
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

function classifyGitHub(err: GitHubError, repoFullName: string, runId: string): { error: string; retryable: boolean; retryAfter: number | null } {
  if (err.status === 0 || err.status >= 500 || err.isRateLimit) {
    return { error: `GitHub is unavailable for now: ${err.message}`, retryable: true, retryAfter: err.retryAfterSeconds };
  }
  if (err.status === 422 && /draft/i.test(err.message)) {
    return {
      error:
        `GitHub refused a draft PR for ${repoFullName} (${err.message}). Draft PRs are not available for private ` +
        `repositories on some plans. Set repositories.${repoFullName}.publish: pr to open ready-for-review PRs ` +
        `instead, then run "factory publish ${runId}".`,
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

function classifyGit(err: GitError, what: string, remote: string, repoFullName: string): Error {
  const detail = err.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('; ') || err.message;
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

// ---------------------------------------------------------------------------
// PR and comment text
// ---------------------------------------------------------------------------

/** A Markdown code fence that the text cannot close, so mentions, links and closing keywords in it stay inert. */
function fenced(text: string, lang = 'text'): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-line text for places Markdown is not fenced: no newlines, mentions or HTML comments. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/@/g, '@​').replace(/<!--|-->/g, '').trim();
}

export function renderPrBody(o: {
  runId: string;
  issueNumber: number;
  agent: string;
  summary: RunSummary;
  commitCount: number;
  mode: 'draft-pr' | 'pr';
}): string {
  const s = o.summary;
  const commits = s.commits.length ? s.commits.join('\n') : '(none listed)';
  const more = o.commitCount > s.commits.length ? `\n… ${o.commitCount - s.commits.length} more` : '';
  const finalMessage = cap(s.lastOutput.join('\n').trim() || '(no output)', MAX_FINAL_MESSAGE);
  const body = [
    `Closes #${o.issueNumber}`,
    '',
    `Opened by software-factory from run \`${o.runId}\` (agent ${inline(o.agent)})${o.mode === 'draft-pr' ? ' as a draft' : ''}. ` +
      'Review it before merging; merging is up to a person.',
    '',
    `**Commits** (${o.commitCount})`,
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
    fenced(finalMessage),
    '',
    `Run id: \`${o.runId}\``,
  ].join('\n');
  const marker = publicationMarker(o.runId);
  return `${cap(body, MAX_BODY - marker.length - 2)}\n\n${marker}`;
}

export function renderIssueComment(o: { runId: string; pr: GitHubPullRequest; commitCount: number; summary: RunSummary }): string {
  const kind = o.pr.draft ? 'Draft PR' : 'PR';
  return [
    `${kind} #${o.pr.number} has the changes for this issue: ${o.pr.htmlUrl}`,
    '',
    `From run \`${o.runId}\`: ${o.commitCount} commit(s), ${inline(o.summary.diffStat)}. Merging is up to a person.`,
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
// The publication itself
// ---------------------------------------------------------------------------

/**
 * Publish one run, or resume its publication. Never throws for publication problems: the result
 * (and the publications table) says what happened. A run that is not eligible is left untouched.
 */
export async function publishRun(deps: PublishDeps, runId: string, opts: { signal?: AbortSignal } = {}): Promise<PublishResult> {
  const now = deps.now ?? Date.now;
  const check = eligibility(deps, runId);
  if (!check.ok) return { status: 'not-eligible', reason: check.reason };
  const { run, job, repoFullName, repo, mode, checkoutPath } = check.e;
  const repoRef = { id: job.repoId, fullName: repoFullName };
  const branch = run.summary.branch;
  const log = deps.log.child({ runId, repo: repoFullName, issue: job.issueNumber });

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

  await runLog([`attempt ${pub.attempts} (${mode}) at ${new Date(now()).toISOString()}`]);
  const hooksDir = mkdtempSync(join(tmpdir(), 'factory-publish-nohooks-'));
  try {
    const run1 = deps.runGit ?? defaultRunGit;
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(NETWORK_TIMEOUT_MS)]) : AbortSignal.timeout(NETWORK_TIMEOUT_MS);
    const local: GitOptions = { cwd: checkoutPath, git: deps.git };

    // 1. The clone, its remote, the base branch and the job branch's commit.
    const { remote, pushUrl, net, localSha, commitCount } = await withCheckoutLock(checkoutPath, async () => {
      const selection = selectRepoRemote(await listRemotes(local), repoFullName, repo.remote);
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
      const matches = repo.remote !== undefined ? remoteOwnerNameMatches(pushUrlRaw, repoFullName) : isGitHubRemoteFor(pushUrlRaw, repoFullName);
      if (!matches) {
        throw new PublishRefusal(`the push URL of remote "${remoteName}" (${redactRemoteUrl(pushUrlRaw)}) does not point at ${repoFullName}`);
      }
      if (isHttpsGitHub(pushUrlRaw)) token = await deps.token();
      const emptyGlobalConfig = join(hooksDir, 'empty-gitconfig');
      writeFileSync(emptyGlobalConfig, '');
      const env = publishGitEnv({
        base: deps.env ?? process.env,
        pushUrl: pushUrlRaw,
        token,
        hooksPath: join(hooksDir, 'none'),
        isolateWith: { emptyGlobalConfig },
      });
      // Network commands run in a throwaway bare repository that borrows the clone's objects
      // (alternates) and nothing else: no remotes, no url.*.insteadOf rules, no hooks. They name
      // the validated URL itself, so Git can't resolve it to a different destination later.
      const pushRepo = join(hooksDir, 'push.git');
      const netOpts: GitOptions = { cwd: hooksDir, git: deps.git, env, signal };
      await run1(['init', '--bare', '--quiet', pushRepo], netOpts);
      // Relative to the clone on older Git; resolve() leaves an absolute one as it is.
      const commonDir = resolve(checkoutPath, (await run1(['rev-parse', '--git-common-dir'], local)).stdout.trim());
      const objects = join(commonDir, 'objects');
      writeFileSync(join(pushRepo, 'objects', 'info', 'alternates'), `${objects}\n`);

      const expected = jobBranchName(job, run.attempt);
      if (branch !== expected) throw new PublishRefusal(`run ${runId} recorded branch ${branch}, not the job branch ${expected}; refusing to push it`);
      await assertValidBranchName(branch, local);
      const sha = (await run1(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], local).catch(() => null))?.stdout.trim();
      if (!sha) throw new PublishRefusal(`the job branch ${branch} no longer exists in ${checkoutPath}`);
      const count = Number((await run1(['rev-list', '--count', `${run.summary.baseSha}..${sha}`], local)).stdout.trim()) || 0;
      return { remote: remoteName, pushUrl: pushUrlRaw, net: { ...netOpts, cwd: pushRepo }, localSha: sha, commitCount: count };
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
          `"factory publish ${runId}"`,
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
          body: renderPrBody({ runId, issueNumber: job.issueNumber, agent: run.agent, summary: run.summary, commitCount, mode }),
        });
        await runLog([`opened ${pr.draft ? 'draft ' : ''}PR #${pr.number}: ${pr.htmlUrl}`]);
      }
      progress({ prNumber: pr.number, prUrl: pr.htmlUrl });
    }

    // 4. The issue comment: recorded, found by marker, or new.
    if (!pub.commentId) {
      hold();
      const marker = publicationMarker(runId);
      const found = (await deps.api.listIssueComments(repoRef, job.issueNumber)).find((c) => c.body.includes(marker));
      let comment = found;
      if (!comment) {
        hold(); // the lookup may have outlived the lease
        comment = await deps.api.createIssueComment(repoRef, job.issueNumber, renderIssueComment({ runId, pr, commitCount, summary: run.summary }));
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
    let error: string;
    let retryable: boolean;
    let retryAfter: number | null = null;
    if (err instanceof GitHubError) {
      ({ error, retryable, retryAfter } = classifyGitHub(err, repoFullName, runId));
    } else if (err instanceof TransientError) {
      error = err.message;
      retryable = true;
      retryAfter = err.retryAfterSeconds;
    } else if (err instanceof PublishRefusal) {
      error = err.message;
      retryable = false;
    } else if (err instanceof GitError) {
      // ls-remote and friends: network trouble is worth retrying, anything else is not.
      const e = classifyGit(err, 'git', 'the remote', repoFullName);
      error = e.message;
      retryable = e instanceof TransientError;
    } else if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      error = 'publication was stopped before it finished';
      retryable = true;
    } else {
      error = message(err);
      retryable = false;
    }
    error = redactSecret(error, token);
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
      ? `the worker retries at ${nextAttemptAt}; "factory publish ${runId}" retries now`
      : `fix the cause, then run "factory publish ${runId}"`;
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
}

export function createPublisher(deps: PublishDeps): Publisher {
  const run = async (runId: string, signal?: AbortSignal) => {
    try {
      const r = await publishRun(deps, runId, { signal });
      if (r.status === 'not-eligible') deps.log.debug('run not published', { runId, reason: r.reason });
    } catch (err) {
      deps.log.error('publication crashed', { runId, error: message(err) });
    }
  };
  return {
    afterRun: run,
    async retryDue(signal) {
      let due: string[];
      try {
        due = listDuePublications(deps.db, { maxAttempts: MAX_AUTO_ATTEMPTS, now: deps.now });
      } catch (err) {
        deps.log.error('could not list publications to retry', { error: message(err) });
        return;
      }
      for (const runId of due) {
        if (signal?.aborted) return;
        await run(runId, signal);
      }
    },
  };
}

/** True when any repository opts in to publication and the mode runs agents. */
export function publicationEnabled(config: FactoryConfig): boolean {
  return config.execution.mode === 'live' && Object.values(config.repositories).some((r) => publishMode(r) !== 'none');
}
