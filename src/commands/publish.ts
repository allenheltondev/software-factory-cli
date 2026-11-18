import { existsSync } from 'node:fs';
import { loadConfig } from '../config/io.js';
import { resolveGitHubToken } from '../github/client.js';
import { getJob, getRun } from '../db/queue.js';
import { publishRun, type PublishDeps } from '../publish/publish.js';
import { postReview } from '../publish/review.js';
import { reviseRun } from '../publish/revision.js';
import { reviewOf, revisionOf } from '../types.js';
import { createLogger } from '../util/log.js';
import { println, type CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';

export interface PublishCommandDeps {
  fileExists: (p: string) => boolean;
  token: (env: NodeJS.ProcessEnv) => Promise<string>;
  /** Injected in tests. */
  runGit?: PublishDeps['runGit'];
}

const defaultDeps: PublishCommandDeps = { fileExists: existsSync, token: (env) => resolveGitHubToken(env) };

/**
 * `updraft publish RUN_ID`: publish a succeeded live run now, or finish a publication that failed
 * part-way. Takes the same idempotent path as the worker, so it never opens a second PR or comment.
 */
export async function publishCommand(ctx: CommandContext, runId: string, deps: PublishCommandDeps = defaultDeps): Promise<number> {
  if (!deps.fileExists(ctx.paths.dbFile)) {
    throw new CliError(`No state database at ${ctx.paths.dbFile}; there are no runs to publish.`);
  }
  const { config } = loadConfig(ctx.paths.configFile);
  const db = ctx.openDb(ctx.paths.dbFile);
  try {
    const log = createLogger({ stream: null });
    const api = await ctx.createApi({ log });
    const publishDeps: PublishDeps = {
      db,
      config,
      paths: ctx.paths,
      api,
      log,
      token: () => deps.token(ctx.env),
      env: ctx.env,
      now: ctx.now,
      ...(deps.runGit ? { runGit: deps.runGit } : {}),
    };
    // A revision run has no PR to open: its commits go to the PR it revised, by the same path the worker takes.
    const run = getRun(db, runId);
    const job = run ? getJob(db, run.jobId) : null;
    if (job && revisionOf(job)) {
      const rev = await reviseRun(publishDeps, runId);
      switch (rev.status) {
        case 'published':
          println(ctx.out, `${rev.already ? 'Already pushed' : 'Pushed'} ${runId} to pull request #${rev.revision.prNumber}: branch ${rev.revision.branch} at ${rev.revision.headSha?.slice(0, 12) ?? '?'}; comment ${rev.revision.commentUrl ?? '(none)'}.`);
          return EXIT.OK;
        case 'skipped':
          println(ctx.out, `Nothing pushed for ${runId}: ${rev.reason}.`);
          return EXIT.OK;
        case 'not-eligible':
          throw new CliError(`Cannot push ${runId}: ${rev.reason}.`);
        case 'busy':
          throw new CliError(`${rev.reason}; try again later.`);
        case 'failed':
          throw new CliError(`Pushing the revision ${runId} failed: ${rev.error}`);
      }
    }
    // A reviewer run has nothing to push either: its verdict is posted on the PR as a comment review.
    if (job && reviewOf(job)) {
      const posted = await postReview(publishDeps, runId);
      switch (posted.status) {
        case 'published':
          println(
            ctx.out,
            `${posted.already ? 'Already posted' : 'Posted'} the review of ${runId} on pull request #${posted.review.prNumber}: ${posted.review.verdict} for ${posted.review.headSha.slice(0, 12)} (${posted.review.outcome ?? 'recorded'}); ${posted.review.reviewUrl ?? '(no link)'}.`,
          );
          return EXIT.OK;
        case 'skipped':
          println(ctx.out, `Nothing posted for ${runId}: ${posted.reason}.`);
          return EXIT.OK;
        case 'not-eligible':
          throw new CliError(`Cannot post the review of ${runId}: ${posted.reason}.`);
        case 'busy':
          throw new CliError(`${posted.reason}; try again later.`);
        case 'failed':
          throw new CliError(`Posting the review of ${runId} failed: ${posted.error}`);
      }
    }
    const r = await publishRun(publishDeps, runId);
    switch (r.status) {
      case 'published': {
        const p = r.publication;
        const kind = p.mode === 'draft-pr' ? 'draft PR' : 'PR';
        println(ctx.out, `${r.already ? 'Already published' : 'Published'} ${runId}: ${kind} #${p.prNumber} ${p.prUrl}`);
        println(ctx.out, `Branch ${p.branch} at ${p.headSha?.slice(0, 12) ?? '?'}; issue comment ${p.commentUrl ?? '(none)'}.`);
        return EXIT.OK;
      }
      case 'skipped':
        println(ctx.out, `Nothing to publish for ${runId}: ${r.reason}.`);
        return EXIT.OK;
      case 'not-eligible':
        throw new CliError(`Cannot publish ${runId}: ${r.reason}.`);
      case 'busy':
        throw new CliError(`${r.reason}; try again later.`);
      case 'failed':
        throw new CliError(`Publishing ${runId} failed: ${r.error}`);
    }
  } finally {
    db.close();
  }
}
