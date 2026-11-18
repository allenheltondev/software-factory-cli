// `factory cancel`: stop a job that is queued or running.
import { existsSync } from 'node:fs';
import { getRun, requestJobCancel } from '../db/queue.js';
import { println, type CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';

export async function cancelCommand(
  ctx: CommandContext,
  jobId: string,
  fileExists: (p: string) => boolean = existsSync,
): Promise<number> {
  if (!fileExists(ctx.paths.dbFile)) {
    throw new CliError(`No state database at ${ctx.paths.dbFile}; there are no jobs to cancel.`);
  }
  const db = ctx.openDb(ctx.paths.dbFile);
  try {
    const result = requestJobCancel(db, jobId, ctx.now);
    if (result.kind === 'not-found') {
      const run = getRun(db, jobId);
      throw new CliError(
        run
          ? `${jobId} is a run, not a job; cancel its job with "factory cancel ${run.jobId}".`
          : `job ${jobId} not found; "factory status" lists job ids.`,
      );
    }
    const { job } = result;
    const what = `${job.id} (${job.repoFullName}#${job.issueNumber}, ${job.workflowId})`;
    switch (result.kind) {
      case 'canceled':
        println(ctx.out, `Canceled ${what}; it was queued and will not run.`);
        println(ctx.out, `"factory retry ${job.id}" queues it again.`);
        break;
      case 'requested':
        println(
          ctx.out,
          result.alreadyRequested
            ? `Cancel was already requested for ${what}; run ${result.run.id} on ${result.run.agent} has not stopped yet.`
            : `Cancel requested for ${what}: run ${result.run.id} on ${result.run.agent}.`,
        );
        println(ctx.out, 'The worker stops the agent within a few seconds and marks the job canceled; "factory status" shows when.');
        println(ctx.out, 'Its worktree and branch are kept, and nothing is published.');
        break;
      case 'stale':
        // The CLI cannot stop the run itself, and no worker is there to do it. Say what will
        // happen instead of recording a request nobody reads.
        throw new CliError(
          `job ${job.id} is marked running${result.run ? ` (run ${result.run.id})` : ''}, but no worker is running, so there is nothing to stop. ` +
            'The next "factory start" stops any agent process left behind and marks the job interrupted ' +
            '(or queues it again if its agent had not started yet); cancel it then if it is queued. ' +
            'An interrupted job does not run again unless you "factory retry" it.',
        );
      case 'terminal':
        throw new CliError(`job ${job.id} is already ${job.status}; only queued or running jobs can be canceled`);
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}
