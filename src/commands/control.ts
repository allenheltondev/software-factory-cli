// `updraft control OWNER/REPO#N COMMAND [TEXT...]`: the mention commands (docs/controls.md) from
// the worker's own terminal. The same state machine as `@<handle> COMMAND` in a comment
// (src/control/local.ts); whoever can run this owns the state database, so no GitHub permission is
// asked for, but the command is recorded with who ran it, like any other.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { loadConfig } from '../config/io.js';
import { CONTROL_COMMANDS, controlHelp, type ControlCommand } from '../control/commands.js';
import { applyLocalControl, LOCAL_UNSUPPORTED, workflowPullRequest } from '../control/local.js';
import { transaction } from '../db/database.js';
import { recordControlCommand } from '../db/control.js';
import { getLoopPr } from '../db/pr-reviews.js';
import { createLogger } from '../util/log.js';
import { nowIso } from '../util/ids.js';
import { println, type CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';

export async function controlCommand(ctx: CommandContext, ref: string, command: string, words: string[], fileExists: (p: string) => boolean = existsSync): Promise<number> {
  const m = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(ref);
  if (!m) throw new CliError(`"${ref}" is not OWNER/REPO#NUMBER`);
  const cmd = command.toLowerCase();
  if (!(CONTROL_COMMANDS as readonly string[]).includes(cmd)) throw new CliError(`"${command}" is not a command; one of: ${CONTROL_COMMANDS.join(', ')}`);
  if (cmd === 'help') {
    println(ctx.out, controlHelp('updraft', { unsupported: LOCAL_UNSUPPORTED }));
    return EXIT.OK;
  }
  if (!fileExists(ctx.paths.dbFile)) throw new CliError(`No state database at ${ctx.paths.dbFile}; nothing has run yet.`);
  const { config } = loadConfig(ctx.paths.configFile);
  const entry = Object.entries(config.repositories).find(([name]) => name.toLowerCase() === m[1]!.toLowerCase());
  if (!entry) throw new CliError(`${m[1]} is not a configured repository`);
  const [fullName, cfg] = entry;
  const repo = { id: cfg.id, fullName };
  const n = Number(m[2]);
  const db = ctx.openDb(ctx.paths.dbFile);
  try {
    const loopPr = getLoopPr(db, repo.id, n);
    const issue = loopPr?.issueNumber ?? n;
    const pr = workflowPullRequest(db, repo.id, issue, loopPr ? n : null);
    const api = await ctx.createApi({ log: createLogger({ stream: null }), credentials: ctx.createCredentials(config) });
    let headSha: string | null = null;
    let subjectState: 'open' | 'closed' | 'merged';
    if (pr) {
      const details = await api.getPullRequest(repo, pr.prNumber);
      headSha = details.state === 'open' ? details.headSha : null;
    }
    if (loopPr) {
      const details = await api.getPullRequest(repo, n);
      subjectState = details.merged ? 'merged' : details.state;
    } else subjectState = (await api.getIssue(repo, n)).state;
    let actor = 'local operator';
    try {
      actor = `${userInfo().username} (local CLI)`;
    } catch {
      // no user name: the default stands
    }
    const source = `cli-${randomUUID()}`;
    const text = words.join(' ');
    const result = transaction(db, () => {
      const r = applyLocalControl(db, config, {
        command: cmd as ControlCommand, repo, cfg, issue, pullRequest: pr?.prNumber ?? (loopPr ? n : null), headSha, subjectState,
        actor, source, url: '', text, target: cmd === 'stop' && words[0] ? words[0] : null,
      }, ctx.now);
      recordControlCommand(db, { source, repoId: repo.id, issue, pullRequest: loopPr ? n : null, actor, command: cmd, receivedAt: nowIso(ctx.now), headSha, outcome: r.outcome, message: r.message });
      return r;
    });
    println(ctx.out, result.message);
    return result.outcome === 'refused' || result.outcome === 'ambiguous' || result.outcome === 'unsupported' ? EXIT.FAILURE : EXIT.OK;
  } finally {
    db.close();
  }
}
