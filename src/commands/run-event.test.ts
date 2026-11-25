// `updraft run-event` end to end: a webhook payload file, an in-memory GitHub, a real local git
// remote and the fake agent. The command creates its clone, runs the poller's rules, the worker,
// the live executor, verification and the publisher, prints one summary and returns an exit code.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { fakeAdapter } from '../../test/fake-adapter.js';
import { FakeLoopGitHub } from '../../test/fake-loop-github.js';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { registerAdapter } from '../agents/adapters/registry.js';
import { openDatabase, type Db } from '../db/database.js';
import { MANAGED_CLONE_KEY } from '../git/clone.js';
import { GitHubError, type GitHubIssue, type GitHubIssueBodyEdit, type GitHubPullRequest } from '../github/api.js';
import { createUserCredentials } from '../github/credentials.js';
import { eventJobId } from '../poller/webhook.js';
import { createLogger } from '../util/log.js';
import { fakeContext, type MemoryOutput } from './fakes.js';
import { buildProgram } from './program.js';
import { runEventCommand, type RunEventDeps, type RunEventOptions, type RunEventSummary } from './run-event.js';
import type { CommandContext } from './context.js';

const REPO_ID = 42;
const FULL = 'octo/widgets';
const ISSUE = 7;
const LABEL = 'updraft:ready';
const EVENT_ID = 9001;
const LABELED_AT = '2026-11-18T11:00:00Z';
/** Shaped like a real token, so both the exact-value and the pattern redaction would catch it. */
const TOKEN = `ghp_${'a1B2'.repeat(9)}`;

const fixtures: GitFixture[] = [];
const dbs: Db[] = [];
const restores: Array<() => void> = [];
beforeEach(() => {
  restores.push(registerAdapter(fakeAdapter({ name: 'claude' })));
});
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r();
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // the command closed it
    }
  }
  for (const f of fixtures.splice(0)) f.cleanup();
});

/** GitHub as run-event sees it: one issue with its events, and the pull requests opened for it. */
class FakeGitHub extends FakeLoopGitHub {
  issueState: Partial<GitHubIssue> = {};
  bodyEdit: GitHubIssueBodyEdit = { lastEditedAt: null, editor: null };
  pulls: GitHubPullRequest[] = [];
  eventsError: GitHubError | null = null;

  override async getIssue(): Promise<GitHubIssue> {
    this.calls.push('getIssue');
    return { ...(await super.getIssue()), labels: [LABEL], ...this.issueState };
  }
  override async listEventsForIssue() {
    this.calls.push('listEventsForIssue');
    if (this.eventsError) throw this.eventsError;
    return this.issueEvents;
  }
  override async getIssueBodyEdit(): Promise<never> {
    return this.bodyEdit as never;
  }
  override async listPullRequestsForHead(_repo?: unknown, opts?: { head: string }): Promise<GitHubPullRequest[]> {
    this.calls.push(`listPullRequestsForHead ${opts?.head}`);
    return this.pulls.filter((p) => p.headRef === opts?.head);
  }
  override async createPullRequest(...args: Parameters<FakeLoopGitHub['createPullRequest']>): Promise<GitHubPullRequest> {
    const pr = await super.createPullRequest(...args);
    this.pulls.push(pr);
    return pr;
  }
}

const payloadOf = (over: Record<string, unknown> = {}) => ({
  action: 'labeled',
  issue: { number: ISSUE, title: 'Add a widget', updated_at: LABELED_AT, state: 'open' },
  label: { name: LABEL },
  repository: { id: REPO_ID, full_name: FULL },
  sender: { login: 'allen' },
  ...over,
});

interface World {
  f: GitFixture;
  gh: FakeGitHub;
  /** Written by the fake agent each time it starts. */
  received: string;
  /** How often the worker's token was read. */
  tokenReads: number;
}

function world(): World {
  const f = createGitFixture(FULL);
  fixtures.push(f);
  const gh = new FakeGitHub(FULL, ISSUE);
  gh.issueEvents = [{ id: EVENT_ID, event: 'labeled', createdAt: LABELED_AT, actor: 'allen', label: LABEL, issue: null }];
  return { f, gh, received: join(f.root, 'agent received.md'), tokenReads: 0 };
}

/** One microVM: its own state directory, config and event file. */
function vm(w: World, name: string, o: { mode?: string; agentMode?: string; payload?: unknown; repo?: Record<string, unknown>; agent?: Record<string, unknown>; configure?: boolean } = {}) {
  const home = join(w.f.root, name);
  mkdirSync(join(home, 'prompts'), { recursive: true });
  writeFileSync(join(home, 'prompts', 'implement.md'), 'Implement the issue below.\n');
  const emptyGitConfig = join(home, 'agent gitconfig');
  writeFileSync(emptyGitConfig, '');
  const config = {
    version: 1,
    execution: { mode: o.mode ?? 'live' },
    agents: {
      claude: {
        command: process.execPath,
        args: ['--mode', o.agentMode ?? 'success', '--received', w.received],
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: emptyGitConfig,
          GIT_AUTHOR_NAME: 'Fake Agent',
          GIT_AUTHOR_EMAIL: 'agent@example.com',
          GIT_COMMITTER_NAME: 'Fake Agent',
          GIT_COMMITTER_EMAIL: 'agent@example.com',
        },
        ...o.agent,
      },
    },
    pools: { general: { agents: ['claude'] } },
    actions: {
      'implement-issue': {
        prompt: './prompts/implement.md',
        timeoutMinutes: 2,
        verify: [[process.execPath, '-e', "process.exit(require('node:fs').existsSync('FAKE_AGENT.md') ? 0 : 1)"]],
      },
    },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [FULL]: {
        id: REPO_ID,
        // Nothing is there: run-event makes the clone.
        checkoutPath: './checkouts/widgets',
        remote: 'origin',
        baseBranch: 'main',
        publish: 'draft-pr',
        commentOnFailure: true,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: LABEL }, action: 'implement-issue', pool: 'general' }],
        ...o.repo,
      },
    },
  };
  if (o.configure !== false) writeFileSync(join(home, 'config.yaml'), stringify(config));
  const eventFile = join(home, 'event.json');
  writeFileSync(eventFile, JSON.stringify(o.payload ?? payloadOf()));
  const ctx = fakeContext({ home, api: w.gh.api, env: { ...process.env, GH_TOKEN: TOKEN } });
  ctx.openDb = (file) => {
    const db = openDatabase(file);
    dbs.push(db);
    return db;
  };
  ctx.createCredentials = () =>
    createUserCredentials(async () => {
      w.tokenReads++;
      return TOKEN;
    });
  const deps: RunEventDeps = {
    createLogger,
    onShutdownSignal: () => () => {},
    cloneUrl: () => w.f.remoteDir,
    eventLookup: { retries: 1, delayMs: 1 },
    drain: { tickMs: 20, stallMs: 200 },
  };
  const run = async (opts: Partial<RunEventOptions> = {}) => {
    const code = await runEventCommand(ctx, { eventFile, json: true, ...opts }, deps);
    return { code, summary: lastJson(ctx.out), out: ctx.out.text, err: ctx.err.text };
  };
  return { home, ctx, deps, eventFile, run, clone: join(home, 'checkouts', 'widgets') };
}

function lastJson(out: MemoryOutput): RunEventSummary {
  const lines = out.text.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as RunEventSummary;
}

const remoteHead = (f: GitFixture, branch: string) => f.git(f.root, 'ls-remote', f.remoteDir, `refs/heads/${branch}`).split(/\s+/)[0] ?? '';

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

const JOB_ID = eventJobId(REPO_ID, 'wf', String(EVENT_ID));
const BRANCH = `updraft/issue-${ISSUE}-${JOB_ID}`;

describe('updraft run-event, end to end', { timeout: 120_000 }, () => {
  it('clones, runs the agent, verifies, publishes, prints one summary and exits 0; a second run of the event does nothing', async () => {
    const w = world();
    const first = vm(w, 'vm one');
    const r = await first.run({ deliveryId: 'delivery-1' });

    expect(r.err).not.toContain('ERROR');
    expect(r.code).toBe(0);
    // stdout is the summary and nothing else.
    expect(r.out.trim().split('\n')).toHaveLength(1);
    const s = r.summary;
    expect(s).toMatchObject({
      event: { name: 'issues', action: 'labeled', deliveryId: 'delivery-1', repository: FULL, repositoryId: REPO_ID, issue: ISSUE, label: LABEL, sender: 'allen', eventId: String(EVENT_ID) },
      dispatched: true,
      outcome: 'succeeded',
      reason: null,
      jobId: JOB_ID,
      workflowId: 'wf',
      status: 'succeeded',
      agent: 'claude',
      runOutcome: 'succeeded',
      error: null,
      branch: BRANCH,
      commitCount: 1,
      verification: { passed: true, commands: [{ status: 'passed' }] },
      publication: 'published',
      prNumber: 100,
      prUrl: `https://github.com/${FULL}/pull/100`,
      drain: 'idle',
      exitCode: 0,
    });
    expect(s.runId).toMatch(/^run_/);

    // The branch on the remote is the commit the run ended on, one commit on top of main.
    const head = remoteHead(w.f, BRANCH);
    expect(head).toBe(s.headSha);
    expect(s.baseSha).toBe(remoteHead(w.f, 'main'));
    // The assignment comment, then the pull request and the comment that links it.
    expect(w.gh.writes).toEqual([`comment #${ISSUE}`, `open draft PR ${BRANCH} -> main`, `comment #${ISSUE}`]);

    // The clone: created by the command, never shallow, only the base branch fetched, and the
    // token in none of its files. The agent ran in a worktree of it.
    expect(w.f.git(first.clone, 'config', '--get', MANAGED_CLONE_KEY)).toBe('true');
    expect(w.f.git(first.clone, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(w.f.git(first.clone, 'for-each-ref', '--format=%(refname)', 'refs/remotes')).toBe('refs/remotes/origin/main');
    expect(w.f.git(first.clone, 'config', '--get', 'remote.origin.url')).not.toContain('@');
    expect(readFileSync(w.received, 'utf8')).toContain('<untrusted-issue-body>\nPlease add a widget.\n</untrusted-issue-body>');
    // Nowhere under the state directory (config, database, logs, clone, worktree), nor in the output.
    for (const file of allFiles(first.home)) expect(readFileSync(file).includes(TOKEN), file).toBe(false);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(readFileSync(join(first.home, 'logs', 'updraft.log'), 'utf8')).toContain('"msg":"event handled"');

    // The same event again, redelivered to a new machine with an empty state directory.
    rmSync(w.received);
    const writes = w.gh.writes.length;
    const second = vm(w, 'vm two');
    const again = await second.run({ deliveryId: 'delivery-1' });
    expect(again.code).toBe(0);
    expect(again.summary).toMatchObject({ dispatched: false, outcome: 'nothing-to-do', reason: 'already-handled', jobId: null, runId: null, exitCode: 0 });
    expect(again.summary.message).toContain(`pull request #100 (https://github.com/${FULL}/pull/100) already exists for this event`);
    expect(existsSync(w.received)).toBe(false);
    expect(existsSync(join(second.home, 'state.db'))).toBe(false);
    expect(w.gh.writes).toHaveLength(writes);
    expect(remoteHead(w.f, BRANCH)).toBe(head);

    // And again, with the pull request gone from the listing: the branch alone stops it.
    w.gh.pulls = [];
    const third = await vm(w, 'vm three').run();
    expect(third.summary).toMatchObject({ outcome: 'nothing-to-do', reason: 'already-handled', exitCode: 0 });
    expect(third.summary.message).toContain(`the branch ${BRANCH} already exists on GitHub`);
    expect(existsSync(w.received)).toBe(false);
  });

  it("works from a person's existing clone as `updraft start` does: it is not marked, and no token is read for a remote that is not https://github.com", async () => {
    const w = world();
    const before = readFileSync(join(w.f.clone, '.git', 'config'), 'utf8');
    const r = await vm(w, 'vm', { repo: { checkoutPath: w.f.clone } }).run();
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ outcome: 'succeeded', publication: 'published', branch: BRANCH });
    expect(remoteHead(w.f, BRANCH)).toBe(r.summary.headSha);
    expect(readFileSync(join(w.f.clone, '.git', 'config'), 'utf8')).toBe(before);
    expect(w.tokenReads).toBe(0);
  });

  it('exits non-zero with the worker\'s reason when the agent fails, and comments on the issue', async () => {
    const w = world();
    const r = await vm(w, 'vm', { agentMode: 'fail' }).run();
    expect(r.code).toBe(1);
    expect(r.summary).toMatchObject({ dispatched: true, outcome: 'failed', status: 'failed', runOutcome: 'failed', publication: null, prUrl: null, exitCode: 1 });
    expect(r.summary.error).toMatch(/exit(ed)? (with )?(code )?3/);
    expect(r.summary.message).toContain(`job ${JOB_ID} failed`);
    expect(r.summary.failureCommentUrl).toContain(`/issues/${ISSUE}#issuecomment-`);
    // The assignment comment and the failure comment.
    expect(w.gh.writes).toEqual([`comment #${ISSUE}`, `comment #${ISSUE}`]);
    expect(remoteHead(w.f, BRANCH)).toBe('');
    // Nothing on GitHub marks the event as handled, so a redelivery tries again.
    rmSync(w.received);
    const again = await vm(w, 'vm retry').run();
    expect(again.summary.dispatched).toBe(true);
    expect(existsSync(w.received)).toBe(true);
  });

  it('cancels before the agent starts when the issue was edited after the label by someone not allowed', async () => {
    const w = world();
    w.gh.bodyEdit = { lastEditedAt: '2026-11-18T11:05:00Z', editor: 'mallory' };
    const r = await vm(w, 'vm').run();
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ dispatched: true, outcome: 'canceled', reason: 'canceled-before-start', status: 'canceled', runOutcome: null, exitCode: 0 });
    expect(r.summary.error).toContain("issue #7's body was edited by mallory after the \"updraft:ready\" label was applied");
    expect(existsSync(w.received)).toBe(false);
    expect(w.gh.writes).toEqual([]);
  });

  it('leaves a published branch alone when another run of the event got there first, and says so', async () => {
    const w = world();
    const one = vm(w, 'vm one');
    // The other run pushed between this run's check and its own push.
    let raced: string | null = null;
    const original = w.gh.listEventsForIssue.bind(w.gh);
    let reads = 0;
    w.gh.listEventsForIssue = async () => {
      // 1: matching the event. 2: the pre-start check, after the "already handled?" check.
      if (++reads === 2) raced = w.f.pushCommit(BRANCH, 'other.txt', 'the other run\n');
      return original();
    };
    const r = await one.run();
    expect(raced).not.toBeNull();
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ dispatched: true, outcome: 'superseded', reason: 'published-by-another-run', status: 'succeeded', publication: 'failed', exitCode: 0 });
    expect(r.summary.publicationError).toContain('refusing to overwrite it');
    expect(remoteHead(w.f, BRANCH)).toBe(raced);
    // Only the assignment comment: nothing was pushed or opened.
    expect(w.gh.writes).toEqual([`comment #${ISSUE}`]);
  });

  // #140: the hosted path (one event, one run-event) routes the issue, claims the run, and only then
  // posts the assignment: it carries the persisted decision, and the summary the runner hands
  // Cloud carries the same route.
  it('a tier-routed event posts the routing decision and the selection actually made', async () => {
    const w = world();
    w.gh.issueState = { labels: [LABEL, 'architecture'] };
    const one = vm(w, 'vm tiers', {
      agent: { model: 'opus', effort: 'high' },
      repo: {
        workflows: [
          {
            id: 'wf',
            trigger: { event: 'issue.labeled', label: LABEL },
            action: 'implement-issue',
            pool: 'general',
            tiers: { pools: { routine: 'general', standard: 'general', complex: 'general' } },
          },
        ],
      },
    });
    const r = await one.run();
    expect(r.summary).toMatchObject({ outcome: 'succeeded', routing: { source: 'tier', pool: 'general', tier: 'complex', requestedTier: 'complex', reason: 'confident', hops: 0 } });
    const assignment = w.gh.comments.find((c) => c.body.includes('<!-- updraft-run-assigned: '))!.body;
    expect(assignment).toContain(
      [
        '| Status | Assigned |',
        '| Complexity | `complex` |',
        '| Capability tier | `complex` |',
        '| Worker | `claude` |',
        '| Adapter | `claude` |',
        '| Model (configured) | `opus` |',
        '| Reasoning effort | `high` |',
        '| Pool | `general` |',
        '| Routing reason | local classifier |',
      ].join('\n'),
    );
    expect(assignment).not.toContain('observed');
    expect(w.gh.comments.filter((c) => c.body.includes('<!-- updraft-run-assigned: '))).toHaveLength(1);
  });

  it('without tiers it says routing is off instead of claiming a classification', async () => {
    const w = world();
    const r = await vm(w, 'vm untiered').run();
    expect(r.summary).toMatchObject({ outcome: 'succeeded', routing: { source: 'pool', pool: 'general' } });
    expect(r.summary.routing).not.toHaveProperty('tier');
    const assignment = w.gh.comments.find((c) => c.body.includes('<!-- updraft-run-assigned: '))!.body;
    expect(assignment).toContain('| Complexity | `Not classified (tier routing off)` |\n| Capability tier | `Not applicable (tier routing off)` |');
    expect(assignment).toContain('| Model | `CLI default` |\n| Reasoning effort | `CLI default` |');
  });
});

describe('updraft run-event: nothing to do', { timeout: 60_000 }, () => {
  const cases: Array<{ name: string; reason: string; message: RegExp; payload?: unknown; eventName?: string; arrange?: (w: World) => void; api?: boolean }> = [
    { name: 'another event name', reason: 'unsupported-event', message: /"push" events are not handled/, eventName: 'push', api: false },
    { name: 'another action', reason: 'unsupported-action', message: /action "opened" are not handled/, payload: payloadOf({ action: 'opened' }), api: false },
    { name: 'a payload that is not an event', reason: 'malformed-payload', message: /no action/, payload: { zen: 'Keep it logically awesome.' }, api: false },
    {
      name: 'a pull request',
      reason: 'pull-request',
      message: /#7 is a pull request/,
      payload: payloadOf({ issue: { number: ISSUE, updated_at: LABELED_AT, pull_request: { url: 'x' } } }),
      api: false,
    },
    {
      name: 'a repository that is not configured (by id, whatever its name)',
      reason: 'repository-not-configured',
      message: /no configured repository has id 43/,
      payload: payloadOf({ repository: { id: 43, full_name: FULL } }),
      api: false,
    },
    { name: 'a label no workflow triggers on', reason: 'label-not-configured', message: /label "bug" is not the trigger label/, payload: payloadOf({ label: { name: 'bug' } }), api: false },
    {
      name: 'an actor who is not allowed, as the API reports the event',
      reason: 'actor-not-allowed',
      message: /applied to #7 by mallory, who is not an allowed actor/,
      payload: payloadOf({ sender: { login: 'mallory' } }),
      arrange: (w) => (w.gh.issueEvents = [{ id: EVENT_ID, event: 'labeled', createdAt: LABELED_AT, actor: 'mallory', label: LABEL, issue: null }]),
    },
    { name: 'a closed issue', reason: 'issue-closed', message: /issue #7 is closed/, arrange: (w) => (w.gh.issueState = { state: 'closed' }) },
    { name: 'an issue that is a pull request according to the API', reason: 'pull-request', message: /pull request/, arrange: (w) => (w.gh.issueState = { isPullRequest: true }) },
    { name: 'an issue that lost the label', reason: 'label-missing', message: /no longer carries the label/, arrange: (w) => (w.gh.issueState = { labels: [] }) },
    {
      name: 'a label removed again since',
      reason: 'label-removed',
      message: /was removed from #7 again/,
      arrange: (w) => w.gh.issueEvents.push({ id: EVENT_ID + 1, event: 'unlabeled', createdAt: '2026-11-18T11:01:00Z', actor: 'allen', label: LABEL, issue: null }),
    },
    { name: 'an issue that is gone', reason: 'issue-gone', message: /deleted, transferred/, arrange: (w) => (w.gh.eventsError = new GitHubError('Not Found', 404)) },
  ];

  it.each(cases)('$name: says why, exits 0 and starts no agent', async (c) => {
    const w = world();
    c.arrange?.(w);
    const v = vm(w, 'vm', c.payload !== undefined ? { payload: c.payload } : {});
    const r = await v.run(c.eventName ? { eventName: c.eventName } : {});
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ dispatched: false, outcome: 'nothing-to-do', reason: c.reason, jobId: null, runId: null, drain: null, exitCode: 0 });
    expect(r.summary.message).toMatch(c.message);
    expect(r.summary.message).not.toContain('\n');
    expect(existsSync(w.received)).toBe(false);
    expect(existsSync(v.clone)).toBe(false);
    expect(existsSync(join(v.home, 'state.db'))).toBe(false);
    expect(w.gh.writes).toEqual([]);
    // Decided from the payload alone only where the answer is "no"; never a request for those.
    if (c.api === false) expect(w.gh.calls).toEqual([]);
  });

  it('does not trust the payload for the actor: an allowed sender in the payload does not make the real actor allowed', async () => {
    const w = world();
    // The payload says allen; GitHub says the label was applied by mallory.
    w.gh.issueEvents = [{ id: EVENT_ID, event: 'labeled', createdAt: LABELED_AT, actor: 'mallory', label: LABEL, issue: null }];
    const r = await vm(w, 'vm').run();
    // No event by allen exists, so the delivery matches nothing: an error, not a dispatch.
    expect(r.code).toBe(1);
    expect(r.summary).toMatchObject({ dispatched: false, outcome: 'error', exitCode: 1 });
    expect(r.summary.error).toContain('show no "updraft:ready" label applied by allen');
    expect(existsSync(w.received)).toBe(false);
  });

  it('prints a line for a person without --json', async () => {
    const w = world();
    const v = vm(w, 'vm', { payload: payloadOf({ action: 'closed' }) });
    expect(await runEventCommand(v.ctx, { eventFile: v.eventFile }, v.deps)).toBe(0);
    expect(v.ctx.out.text).toMatch(/^Nothing to do: issues events with action "closed" are not handled \(handled: issues\.labeled, pull_request_review\.submitted, .*\)\n$/);
  });
});

describe('updraft run-event: what the caller got wrong', () => {
  it('refuses to do anything unless execution.mode is live, and says so', async () => {
    const w = world();
    const r = await vm(w, 'vm', { mode: 'prepare-only' }).run();
    expect(r.code).toBe(1);
    expect(r.summary).toMatchObject({ dispatched: false, outcome: 'error', exitCode: 1 });
    expect(r.summary.error).toContain('needs execution.mode: live; it is prepare-only');
    expect(r.err).toContain('error: run-event starts an agent');
    expect(w.gh.calls).toEqual([]);
  });

  it('exits 2 for an event file that is missing or not JSON, and 1 without a config', async () => {
    const w = world();
    const v = vm(w, 'vm');
    const missing = await v.run({ eventFile: join(v.home, 'nope.json') });
    expect(missing.code).toBe(2);
    expect(missing.summary.error).toContain('could not read the event file');
    writeFileSync(v.eventFile, '{ not json');
    const bad = await v.run();
    expect(bad.code).toBe(2);
    expect(bad.summary.error).toContain('is not JSON');
    expect((await v.run({ deadlineMinutes: 'soon' })).code).toBe(2);

    const unconfigured = await vm(w, 'vm bare', { configure: false }).run();
    expect(unconfigured.code).toBe(1);
    expect(unconfigured.summary.outcome).toBe('error');
  });

  it('is wired into the program with its flags', async () => {
    const seen: Array<RunEventOptions> = [];
    const program = buildProgram({
      version: '0.0.0',
      context: () => ({}) as CommandContext,
      handlers: {
        runEvent: async (_ctx, o) => {
          seen.push(o);
          return 0;
        },
      },
      setExitCode: () => {},
    });
    await program.parseAsync(['node', 'updraft', 'run-event', '--event-file', 'e.json', '--delivery-id', 'd1', '--json']);
    expect(seen[0]).toMatchObject({ eventFile: 'e.json', eventName: 'issues', deliveryId: 'd1', json: true });
    await program.parseAsync(['node', 'updraft', 'run-event', '--event-file', 'e.json', '--event-name', 'pull_request_review', '--deadline-minutes', '30']);
    expect(seen[1]).toMatchObject({ eventName: 'pull_request_review', deadlineMinutes: '30' });
  });
});
