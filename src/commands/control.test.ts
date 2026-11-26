import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { activeControlPause, listControlCommands } from '../db/control.js';
import { openDatabase, type Db } from '../db/database.js';
import { getJob } from '../db/queue.js';
import type { GitHubApi } from '../github/api.js';
import { controlCommand } from './control.js';
import { CliError, EXIT } from './errors.js';
import { fakeContext } from './fakes.js';

const homes: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function setup(state: 'open' | 'closed' = 'open') {
  const api = { getIssue: async () => ({ number: 7, title: 't', body: '', htmlUrl: '', state, labels: [], isPullRequest: false }) } as unknown as GitHubApi;
  const ctx = fakeContext({ api });
  homes.push(ctx.paths.dataDir);
  ctx.openDb = (file) => openDatabase(file);
  mkdirSync(dirname(ctx.paths.configFile), { recursive: true });
  writeFileSync(ctx.paths.configFile, JSON.stringify({
    version: 1, agents: { claude: {} }, pools: { general: { agents: ['claude'] } }, actions: { 'implement-issue': {} },
    dispatch: { allowedActors: ['allen'] },
    repositories: { 'octo/widgets': { id: 42, workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }] } },
  }));
  const db = openDatabase(ctx.paths.dbFile);
  dbs.push(db);
  const jobId = insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 7 });
  return { ctx, db, jobId };
}

describe('updraft control', () => {
  it('pauses and resumes an issue from the terminal, with an audit record', async () => {
    const { ctx, db, jobId } = setup();
    expect(await controlCommand(ctx, 'octo/widgets#7', 'pause', ['waiting', 'on', 'design'])).toBe(EXIT.OK);
    expect(ctx.out.text).toContain('Paused #7');
    expect(getJob(db, jobId)!.status).toBe('canceled');
    expect(activeControlPause(db, 42, 7)).toMatchObject({ reason: 'waiting on design' });
    expect(await controlCommand(ctx, 'octo/widgets#7', 'resume', [])).toBe(EXIT.OK);
    expect(getJob(db, jobId)!.status).toBe('queued');
    expect(listControlCommands(db, 42, 7).map((c) => [c.command, c.outcome])).toEqual([['pause', 'applied'], ['resume', 'applied']]);
  });

  it('fails for a closed issue’s resume and for bad arguments', async () => {
    const { ctx } = setup('closed');
    await controlCommand(ctx, 'octo/widgets#7', 'pause', []);
    expect(await controlCommand(ctx, 'octo/widgets#7', 'resume', [])).toBe(EXIT.FAILURE);
    await expect(controlCommand(ctx, 'octo/widgets', 'pause', [])).rejects.toBeInstanceOf(CliError);
    await expect(controlCommand(ctx, 'octo/widgets#7', 'merge', [])).rejects.toThrow(/not a command/);
    await expect(controlCommand(ctx, 'other/repo#7', 'pause', [])).rejects.toThrow(/not a configured repository/);
  });
});
