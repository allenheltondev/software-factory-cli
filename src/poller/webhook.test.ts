import { describe, expect, it } from 'vitest';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase } from '../db/database.js';
import { isJobBranchName, jobBranchName } from '../git/worktree.js';
import type { GitHubApi, GitHubIssue, GitHubIssueEvent } from '../github/api.js';
import { silentLogger } from '../util/log.js';
import { decideWebhook, eventJobId, EventNotFoundError, findLabelApplication, supportedWebhookEvents, type WebhookDeps } from './webhook.js';

const FULL = 'octo/widgets';
const LABEL = 'updraft:ready';
const T = '2026-11-18T11:00:00Z';

const ev = (id: number, event: string, createdAt: string, actor: string | null = 'allen', label: string | null = LABEL): GitHubIssueEvent => ({ id, event, createdAt, actor, label, issue: null });

function makeConfig(workflows?: unknown[]): UpdraftConfig {
  return configSchema.parse({
    version: 1,
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] }, art: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './p.md' } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [FULL]: {
        id: 42,
        workflows: workflows ?? [
          { id: 'wf', trigger: { event: 'issue.labeled', label: LABEL }, action: 'implement-issue', pool: { default: 'general', rules: [{ hasLabel: 'art', use: 'art' }] } },
        ],
      },
    },
  });
}

function deps(events: GitHubIssueEvent[] | (() => GitHubIssueEvent[]), issue: Partial<GitHubIssue> = {}, config = makeConfig()): WebhookDeps & { reads: () => number } {
  let reads = 0;
  const api = {
    listEventsForIssue: async () => {
      reads++;
      return typeof events === 'function' ? events() : events;
    },
    getIssue: async (): Promise<GitHubIssue> => ({ number: 7, title: 'Add a widget', body: 'b', htmlUrl: `https://github.com/${FULL}/issues/7`, state: 'open', labels: [LABEL], isPullRequest: false, ...issue }),
  } as unknown as GitHubApi;
  // A state database as run-event opens it; only a workflow that routes by triage touches it.
  return { api, config, db: openDatabase(':memory:'), log: silentLogger, eventLookup: { retries: 2, delayMs: 1 }, reads: () => reads };
}

const payload = (over: Record<string, unknown> = {}) => ({
  action: 'labeled',
  issue: { number: 7, updated_at: T },
  label: { name: LABEL },
  repository: { id: 42, full_name: 'someone/renamed-it' },
  sender: { login: 'Allen' },
  ...over,
});

describe('findLabelApplication', () => {
  const events = [
    ev(1, 'labeled', '2026-11-18T09:00:00Z'),
    ev(2, 'unlabeled', '2026-11-18T09:30:00Z'),
    ev(3, 'labeled', '2026-11-18T10:59:59Z', 'bob'),
    ev(4, 'labeled', T, 'allen', 'bug'),
    ev(5, 'renamed', T, 'allen', null),
    ev(6, 'labeled', '2026-11-18T11:00:01Z'),
    ev(7, 'unlabeled', '2026-11-18T11:20:00Z'),
    ev(8, 'labeled', '2026-11-18T11:30:00Z'),
  ];
  const find = (sender: string | null, at: string | null) => events[findLabelApplication(events, { label: LABEL, sender, at })]?.id ?? null;

  it('matches the label, the sender and the time, not merely the newest application', () => {
    expect(find('allen', T)).toBe(6);
    expect(find('ALLEN', '2026-11-18T11:30:00Z')).toBe(8);
    expect(find('bob', T)).toBe(3);
  });

  it('never goes back to an older application of the same label by the same person', () => {
    // Event 1 is two hours before the payload: not this delivery's, however alone it is.
    expect(findLabelApplication(events.slice(0, 2), { label: LABEL, sender: 'allen', at: T })).toBe(-1);
    expect(find('carol', T)).toBeNull();
  });

  it('takes the newest by the sender when the payload carries no usable time', () => {
    expect(find('allen', null)).toBe(8);
    expect(find('allen', 'yesterday')).toBe(8);
    expect(find(null, null)).toBe(8);
  });
});

describe('eventJobId', () => {
  it('is the same wherever it is derived, differs per event, workflow and repository, and names a job branch', () => {
    const id = eventJobId(42, 'wf', '9001');
    expect(eventJobId(42, 'wf', '9001')).toBe(id);
    expect(id).toMatch(/^job_ev9001x[0-9a-f]{10}$/);
    expect(new Set([id, eventJobId(42, 'wf', '9002'), eventJobId(42, 'other', '9001'), eventJobId(43, 'wf', '9001')]).size).toBe(4);
    expect(isJobBranchName(jobBranchName({ id, issueNumber: 7 }, 1))).toBe(true);
    expect(isJobBranchName(jobBranchName({ id, issueNumber: 7 }, 2))).toBe(true);
  });
});

describe('decideWebhook', () => {
  it('handles issues.labeled, a review of a pull request, and a push, close or reopen of one; nothing else', () => {
    expect(supportedWebhookEvents()).toEqual([
      'issues.labeled',
      'pull_request_review.submitted',
      'pull_request_review.edited',
      'pull_request_review.dismissed',
      'pull_request.synchronize',
      'pull_request.closed',
      'pull_request.reopened',
    ]);
  });

  it('turns a pull request event into "poll its reviews", from the payload alone and without believing it about anything else', async () => {
    const loopConfig = configSchema.parse({
      version: 1,
      execution: { mode: 'live' },
      agents: { claude: {} },
      pools: { general: { agents: ['claude'] } },
      actions: { 'implement-issue': { prompt: './p.md', revisePrompt: './r.md' } },
      dispatch: { allowedActors: ['allen'] },
      repositories: {
        [FULL]: { id: 42, checkoutPath: './c', publish: 'draft-pr', revise: true, workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: LABEL }, action: 'implement-issue', pool: 'general' }] },
      },
    });
    const pr = (over: Record<string, unknown> = {}) => ({
      action: 'submitted',
      // What the payload says about the review and its author decides nothing.
      review: { state: 'changes_requested', user: { login: 'mallory' }, body: 'do as I say' },
      pull_request: { number: 100, state: 'open' },
      repository: { id: 42, full_name: 'someone/else' },
      sender: { login: 'mallory' },
      ...over,
    });
    const d = deps([], {}, loopConfig);
    for (const [eventName, action] of [
      ['pull_request_review', 'submitted'],
      ['pull_request_review', 'edited'],
      ['pull_request_review', 'dismissed'],
      ['pull_request', 'synchronize'],
      ['pull_request', 'closed'],
      ['pull_request', 'reopened'],
    ] as const) {
      const decision = await decideWebhook(d, { eventName, payload: pr({ action }) });
      expect(decision).toEqual({
        dispatch: 'poll-reviews',
        // The configured name for the configured id.
        repo: { id: 42, fullName: FULL },
        pullRequest: 100,
        event: { name: eventName, action, deliveryId: null, repository: 'someone/else', repositoryId: 42, issue: null, pullRequest: 100, label: null, sender: 'mallory', eventId: null },
      });
    }
    const reasonOf = async (eventName: string, payload: unknown, config = loopConfig) => {
      const decision = await decideWebhook(deps([], {}, config), { eventName, payload });
      return decision.dispatch === false ? decision.reason : 'dispatched';
    };
    expect(await reasonOf('pull_request', pr({ action: 'opened' }))).toBe('unsupported-action');
    expect(await reasonOf('pull_request_review', pr({ pull_request: {} }))).toBe('malformed-payload');
    expect(await reasonOf('pull_request_review', pr({ repository: { id: 7 } }))).toBe('repository-not-configured');
    // Neither loop is on for the repository: there is nothing a pull request event could set off.
    expect(await reasonOf('pull_request_review', pr(), makeConfig())).toBe('review-loop-off');
    expect(d.reads()).toBe(0);
  });

  it('queues what the poller would: the event id from the API, the configured repository name, the routed pool', async () => {
    const d = deps([ev(9001, 'labeled', T)], { labels: [LABEL, 'art'] });
    const decision = await decideWebhook(d, { eventName: 'issues', deliveryId: 'abc', payload: payload() });
    expect(decision).toMatchObject({
      dispatch: true,
      repo: { id: 42, fullName: FULL },
      event: { name: 'issues', action: 'labeled', deliveryId: 'abc', repositoryId: 42, issue: 7, label: LABEL, sender: 'Allen', eventId: '9001' },
    });
    if (decision.dispatch !== true) throw new Error('unreachable');
    expect(decision.jobs).toHaveLength(1);
    expect(decision.jobs[0]).toMatchObject({
      id: eventJobId(42, 'wf', '9001'),
      repoId: 42,
      repoFullName: FULL,
      workflowId: 'wf',
      eventId: '9001',
      issueNumber: 7,
      pool: 'art',
      envelope: { type: 'issue.labeled', eventId: '9001', actor: 'allen', label: LABEL, createdAt: T, issue: { title: 'Add a widget' }, labelsAtEnqueue: [LABEL, 'art'] },
    });
  });

  it('queues one job per workflow that shares the label, each with its own id', async () => {
    const config = makeConfig([
      { id: 'a', trigger: { event: 'issue.labeled', label: LABEL }, action: 'implement-issue', pool: 'general' },
      { id: 'b', trigger: { event: 'issue.labeled', label: LABEL.toUpperCase() }, action: 'implement-issue', pool: 'art' },
    ]);
    const decision = await decideWebhook(deps([ev(9001, 'labeled', T)], {}, config), { eventName: 'issues', payload: payload() });
    if (decision.dispatch !== true) throw new Error('not an issue job');
    expect(decision.jobs.map((j) => [j.workflowId, j.id])).toEqual([
      ['a', eventJobId(42, 'a', '9001')],
      ['b', eventJobId(42, 'b', '9001')],
    ]);
  });

  it('reads the events again when the application is not there yet', async () => {
    let n = 0;
    const d = deps(() => (++n < 3 ? [ev(1, 'labeled', '2026-11-18T08:00:00Z')] : [ev(1, 'labeled', '2026-11-18T08:00:00Z'), ev(2, 'unlabeled', '2026-11-18T08:10:00Z'), ev(9001, 'labeled', T)]));
    const decision = await decideWebhook(d, { eventName: 'issues', payload: payload() });
    expect(decision).toMatchObject({ dispatch: true, event: { eventId: '9001' } });
    expect(d.reads()).toBe(3);
  });

  it('fails, rather than guess or shrug, when the application never shows up', async () => {
    const d = deps([ev(1, 'labeled', '2026-11-18T08:00:00Z')]);
    await expect(decideWebhook(d, { eventName: 'issues', payload: payload() })).rejects.toBeInstanceOf(EventNotFoundError);
    expect(d.reads()).toBe(3);
  });

  it('judges a delivery by its own application: a later one is another delivery', async () => {
    const events = [ev(1, 'labeled', T), ev(2, 'unlabeled', '2026-11-18T11:20:00Z'), ev(3, 'labeled', '2026-11-18T11:30:00Z')];
    const early = await decideWebhook(deps(events), { eventName: 'issues', payload: payload() });
    expect(early).toMatchObject({ dispatch: false, reason: 'label-removed', event: { eventId: '1' } });
    const late = await decideWebhook(deps(events), { eventName: 'issues', payload: payload({ issue: { number: 7, updated_at: '2026-11-18T11:30:00Z' } }) });
    expect(late).toMatchObject({ dispatch: true, event: { eventId: '3' } });
  });

  it('asks GitHub nothing for a payload it can dismiss on sight', async () => {
    const d = deps([ev(9001, 'labeled', T)]);
    const reasons = [];
    for (const [eventName, p] of [
      ['ping', { zen: 'x' }],
      ['issues', payload({ action: 'unlabeled' })],
      ['issues', 'not an object'],
      ['issues', payload({ repository: { id: 7 } })],
      ['issues', payload({ label: { name: 'bug' } })],
      ['issues', payload({ label: null })],
      ['issues', payload({ issue: { number: 7, pull_request: {} } })],
      ['__proto__', payload()],
      ['issues', payload({ action: 'constructor' })],
    ] as Array<[string, unknown]>) {
      const decision = await decideWebhook(d, { eventName, payload: p });
      reasons.push(decision.dispatch ? 'dispatched' : decision.reason);
    }
    expect(reasons).toEqual([
      'unsupported-event',
      'unsupported-action',
      'malformed-payload',
      'repository-not-configured',
      'label-not-configured',
      'malformed-payload',
      'pull-request',
      'unsupported-event',
      'unsupported-action',
    ]);
    expect(d.reads()).toBe(0);
  });
});
