import { describe, expect, it, vi } from 'vitest';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase } from '../db/database.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope, type Job, type Run } from '../types.js';
import { silentLogger } from '../util/log.js';
import { assignmentCommentMarker, createAssignmentCommenter, renderAssignmentComment } from './assignment-comment.js';

const config = (mode: 'live' | 'log-only' | 'prepare-only' = 'live'): UpdraftConfig =>
  configSchema.parse({
    version: 1,
    agents: { codex: {}, claude: {} },
    pools: { general: { agents: ['codex', 'claude'] } },
    actions: { 'implement-issue': { prompt: './p.md' } },
    dispatch: { allowedActors: ['allen'] },
    execution: { mode },
  });

const envelope = (type = 'issue.labeled'): EventEnvelope =>
  ({
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    type,
    repo: { id: 1, fullName: 'owner/repo' },
    issue: { number: 7, title: 't', url: 'https://github.com/owner/repo/issues/7' },
    eventId: '1',
    url: 'https://github.com/owner/repo/issues/7',
    actor: 'allen',
    label: 'ready',
    labelsAtEnqueue: ['ready'],
    createdAt: '2026-11-17T10:00:00.000Z',
  }) as unknown as EventEnvelope;

const job = (env = envelope()): Job => ({ id: 'job_1', repoId: 1, repoFullName: 'owner/repo', issueNumber: 7, envelope: env }) as unknown as Job;
const run = (id: string, agent: string): Run => ({ id, jobId: 'job_1', agent, pool: 'general' }) as unknown as Run;

class FakeApi {
  comments: { body: string; htmlUrl: string; id: number }[] = [];
  failCreate: GitHubError[] = [];
  /** Create the comment, then throw as if the response was lost. */
  loseResponse = 0;
  async listIssueComments() {
    return this.comments;
  }
  async createIssueComment(_r: unknown, _n: number, body: string) {
    const err = this.failCreate.shift();
    if (err) throw err;
    const c = { body, htmlUrl: `https://x/c/${this.comments.length + 1}`, id: this.comments.length + 1 };
    this.comments.push(c);
    if (this.loseResponse-- > 0) throw new GitHubError('timeout', 0);
    return c;
  }
}

function setup(mode: 'live' | 'log-only' | 'prepare-only' = 'live') {
  const api = new FakeApi();
  const commenter = createAssignmentCommenter({
    db: openDatabase(':memory:'),
    config: config(mode),
    api: api as unknown as GitHubApi,
    log: silentLogger,
    sleep: async () => {},
  });
  return { api, commenter };
}

describe('assignment comment', () => {
  it('posts the agent, job, run and pool with a marker, and nothing else', async () => {
    const { api, commenter } = setup();
    await commenter.announce(job(), run('run_1', 'codex'));
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toBe(renderAssignmentComment({ agent: 'codex', jobId: 'job_1', runId: 'run_1', pool: 'general' }));
    expect(api.comments[0]!.body).toContain('Updraft assigned **codex** to work on this issue.');
    expect(api.comments[0]!.body).toContain('`job_1`');
    expect(api.comments[0]!.body).toContain('`run_1`');
    expect(api.comments[0]!.body).toContain('`general`');
    expect(api.comments[0]!.body).toContain(assignmentCommentMarker('run_1'));
  });

  it('skips log-only, prepare-only, reviewer and revision jobs', async () => {
    for (const mode of ['log-only', 'prepare-only'] as const) {
      const { api, commenter } = setup(mode);
      await commenter.announce(job(), run('run_1', 'codex'));
      expect(api.comments).toHaveLength(0);
    }
    const { api, commenter } = setup();
    await commenter.announce(job(envelope('pull_request.changes_requested')), run('run_2', 'codex'));
    await commenter.announce(job(envelope('pull_request.review')), run('run_3', 'codex'));
    expect(api.comments).toHaveLength(0);
  });

  it('retries a transient write and leaves one comment, including when the response was lost', async () => {
    const { api, commenter } = setup();
    api.failCreate.push(new GitHubError('unavailable', 503));
    await commenter.announce(job(), run('run_1', 'codex'));
    expect(api.comments).toHaveLength(1);

    api.loseResponse = 1;
    await commenter.announce(job(), run('run_2', 'codex'));
    expect(api.comments.filter((c) => c.body.includes(assignmentCommentMarker('run_2')))).toHaveLength(1);

    // A repeated announcement of the same run (restart) adds nothing.
    await commenter.announce(job(), run('run_2', 'codex'));
    expect(api.comments).toHaveLength(2);
  });

  it('a second attempt gets its own comment naming its actual agent', async () => {
    const { api, commenter } = setup();
    await commenter.announce(job(), run('run_1', 'codex'));
    await commenter.announce(job(), run('run_2', 'claude'));
    expect(api.comments).toHaveLength(2);
    expect(api.comments[1]!.body).toContain('**claude**');
    expect(api.comments[1]!.body).toContain('`run_2`');
  });

  it('records a permanent failure instead of throwing, without retrying it', async () => {
    const { api, commenter } = setup();
    api.failCreate.push(new GitHubError('forbidden', 403));
    const create = vi.spyOn(api, 'createIssueComment');
    await expect(commenter.announce(job(), run('run_1', 'codex'))).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
