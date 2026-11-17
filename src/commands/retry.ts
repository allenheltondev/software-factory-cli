import { existsSync } from 'node:fs';
import { retryJob } from '../db/queue.js';
import { println, type CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';

export async function retryCommand(
  ctx: CommandContext,
  jobId: string,
  fileExists: (p: string) => boolean = existsSync,
): Promise<number> {
  if (!fileExists(ctx.paths.dbFile)) {
    throw new CliError(`No state database at ${ctx.paths.dbFile}; there are no jobs to retry.`);
  }
  const db = ctx.openDb(ctx.paths.dbFile);
  try {
    const job = retryJob(db, jobId, ctx.now);
    println(ctx.out, `Requeued ${job.id} (${job.repoFullName}#${job.issueNumber}, ${job.workflowId}); status ${job.status}.`);
    println(ctx.out, 'A running worker picks it up on its next cycle.');
    return EXIT.OK;
  } finally {
    db.close();
  }
}
