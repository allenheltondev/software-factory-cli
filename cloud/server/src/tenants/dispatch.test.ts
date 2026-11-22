import { describe, expect, it } from 'vitest';
import { decideDispatch, decidePullRequestDispatch, dispatchRules } from './dispatch.js';

const compiled = {
  dispatch: { allowedActors: ['Pat', 'sam'] },
  repositories: {
    'Acme/Web': {
      id: 9,
      workflows: [
        { trigger: { event: 'issue.labeled', label: 'Updraft' }, action: 'implement', pool: 'p' },
        { trigger: { event: 'issue.labeled', label: 'docs' }, action: 'docs', pool: 'p', allowedActors: ['writer'] },
      ],
    },
    'acme/api': { id: 10, workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft' }, action: 'implement', pool: 'p' }] },
  },
};

describe('dispatchRules', () => {
  it('keeps each repository\'s id and triggers, lower-cased, with the actors each trigger allows', () => {
    expect(dispatchRules(compiled)).toEqual({
      repositories: {
        'acme/web': {
          id: 9,
          triggers: [
            { label: 'updraft', actors: ['pat', 'sam'] },
            { label: 'docs', actors: ['writer'] },
          ],
        },
        // One list for every trigger: stored once.
        'acme/api': { id: 10, actors: ['pat', 'sam'], triggers: [{ label: 'updraft' }] },
      },
      loop: true,
    });
  });

  it('records the review loop of each repository: review (true or its options) and revise', () => {
    const rules = dispatchRules({
      repositories: {
        'acme/a': { id: 1, review: true, revise: true, workflows: [] },
        'acme/b': { id: 2, review: { pool: 'reviewers' }, workflows: [] },
        'acme/c': { id: 3, review: false, revise: false, workflows: [] },
      },
    });
    expect(rules.repositories['acme/a']).toMatchObject({ review: true, revise: true });
    expect(rules.repositories['acme/b']).toMatchObject({ review: true });
    expect(rules.repositories['acme/b']).not.toHaveProperty('revise');
    expect(rules.repositories['acme/c']).not.toHaveProperty('review');
    expect(rules.loop).toBe(true);
  });
});

describe('decidePullRequestDispatch', () => {
  const rules = dispatchRules(
    {
      dispatch: { allowedActors: ['Pat'] },
      repositories: {
        'acme/web': { id: 9, review: true, revise: true, workflows: [{ trigger: { label: 'updraft' } }, { trigger: { label: 'docs' }, allowedActors: ['writer'] }] },
        'acme/review-only': { id: 10, review: true, workflows: [{ trigger: { label: 'updraft' } }] },
        'acme/off': { id: 11, workflows: [{ trigger: { label: 'updraft' } }] },
      },
    },
    { keysFor: (_repo, wf) => ((wf.trigger as { label: string }).label === 'docs' ? ['CODEX_API_KEY'] : ['ANTHROPIC_API_KEY']) },
  );
  const review = (over: Record<string, unknown> = {}) => ({
    eventName: 'pull_request_review',
    action: 'submitted',
    repositoryFullName: 'Acme/Web',
    repositoryId: 9,
    sender: 'PAT',
    number: 12,
    headRef: 'updraft/issue-3-abc',
    reviewState: 'changes_requested',
    ...over,
  });
  const decide = (over: Record<string, unknown> = {}) => decidePullRequestDispatch(rules, review(over), { appBot: 'updraft[bot]' });
  const code = (over: Record<string, unknown> = {}) => {
    const d = decide(over);
    return d.start ? 'start' : d.code;
  };

  it("starts a job for an allowed person's review on an Updraft pull request, with each workflow's keys by label to pick from", () => {
    expect(decide()).toEqual({ start: true, repository: 'Acme/Web', repositoryId: 9, pullRequest: 12, closing: false, keysByLabel: { updraft: ['ANTHROPIC_API_KEY'], docs: ['CODEX_API_KEY'] } });
    expect(decide({ eventName: 'pull_request', action: 'closed', reviewState: undefined })).toMatchObject({ start: true, closing: true });
    expect(code({ reviewState: 'approved' })).toBe('start');
    expect(code({ action: 'dismissed', sender: 'writer' })).toBe('start');
    expect(code({ eventName: 'pull_request', action: 'synchronize', reviewState: undefined })).toBe('start');
    // A close ends the loop, whoever closes it.
    expect(code({ eventName: 'pull_request', action: 'closed', sender: 'someone-else', reviewState: undefined })).toBe('start');
  });

  it('starts nothing for what leads to no work', () => {
    expect(code({ action: 'opened' })).toBe('event_not_accepted');
    expect(code({ eventName: 'pull_request', action: 'reopened' })).toBe('event_not_accepted');
    expect(code({ eventName: 'issue_comment' })).toBe('event_not_accepted');
    expect(code({ reviewState: 'commented' })).toBe('comment_review');
    expect(code({ headRef: 'feature/mine' })).toBe('not_updraft_pr');
    expect(code({ sender: 'Updraft[bot]' })).toBe('own_event');
    expect(code({ sender: 'stranger' })).toBe('actor_not_allowed');
    expect(code({ eventName: 'pull_request', action: 'synchronize', sender: 'stranger' })).toBe('actor_not_allowed');
    expect(code({ repositoryId: 99 })).toBe('unknown_repo');
    expect(code({ repositoryFullName: 'acme/gone' })).toBe('unknown_repo');
  });

  it('follows the repository loop: a review needs revisions, a push needs review, and neither starts anything with both off', () => {
    expect(code({ repositoryFullName: 'acme/review-only', repositoryId: 10 })).toBe('loop_off');
    expect(code({ repositoryFullName: 'acme/review-only', repositoryId: 10, eventName: 'pull_request', action: 'synchronize' })).toBe('start');
    expect(code({ repositoryFullName: 'acme/off', repositoryId: 11, eventName: 'pull_request', action: 'closed' })).toBe('loop_off');
  });

  it('asks for a publish when the rules predate the loop, and honors a pause', () => {
    const old = { repositories: { 'acme/web': { id: 9, actors: ['pat'], triggers: [{ label: 'updraft' }] } } };
    const d = decidePullRequestDispatch(old, review());
    expect(d).toMatchObject({ start: false, code: 'loop_off', reason: expect.stringMatching(/publish it again/) });
    const paused = { ...rules, repositories: { 'acme/web': { ...rules.repositories['acme/web']!, paused: true as const } } };
    expect(decidePullRequestDispatch(paused, review())).toMatchObject({ start: false, code: 'paused' });
  });
});

describe('decideDispatch', () => {
  const rules = dispatchRules(compiled);
  const event = (overrides: Record<string, unknown> = {}) => ({ repositoryFullName: 'acme/WEB', repositoryId: 9, label: 'UPDRAFT', sender: 'PAT', ...overrides });

  it('starts a job for a trigger label applied by an allowed actor, whatever the case', () => {
    expect(decideDispatch(rules, event())).toEqual({ start: true, repository: 'acme/WEB', repositoryId: 9, label: 'UPDRAFT', keys: null });
    expect(decideDispatch(rules, event({ label: 'docs', sender: 'writer' })).start).toBe(true);
  });

  it("returns the keys of the workflows the label and sender match, each workflow's own (#70 review)", () => {
    // One label, two workflows: only alice may start Claude, only bob Codex.
    const shared = dispatchRules(
      {
        repositories: {
          'acme/web': {
            id: 9,
            workflows: [
              { trigger: { label: 'updraft' }, allowedActors: ['alice'], agent: 'claude' },
              { trigger: { label: 'updraft' }, allowedActors: ['bob'], agent: 'codex' },
            ],
          },
        },
      },
      { keysFor: (_repo, wf) => (wf.agent === 'codex' ? ['CODEX_API_KEY'] : ['ANTHROPIC_API_KEY']) },
    );
    expect(decideDispatch(shared, event({ sender: 'alice' }))).toMatchObject({ start: true, keys: ['ANTHROPIC_API_KEY'] });
    expect(decideDispatch(shared, event({ sender: 'bob' }))).toMatchObject({ start: true, keys: ['CODEX_API_KEY'] });
  });

  it.each([
    ['an unknown repository', { repositoryFullName: 'acme/other' }, 'the repository is not in the active config'],
    ['a repository with the same name but another id (recreated)', { repositoryId: 99 }, 'the repository is not in the active config'],
    ['a label that is no trigger', { label: 'bug' }, 'the label is not a trigger'],
    ['an actor who may not dispatch', { sender: 'mallory' }, 'the sender may not dispatch work'],
    ['an actor allowed for another trigger only', { label: 'docs', sender: 'pat' }, 'the sender may not dispatch work'],
    ['no sender', { sender: undefined }, 'the sender may not dispatch work'],
  ])('starts nothing for %s', (_what, overrides, reason) => {
    expect(decideDispatch(rules, event(overrides))).toMatchObject({ start: false, reason });
  });

  it('starts nothing for a version published before dispatch rules existed', () => {
    expect(decideDispatch(undefined, event()).start).toBe(false);
  });
});

describe('paused repositories', () => {
  it('stay in the rules, and start nothing', () => {
    const rules = dispatchRules(compiled, { paused: new Set(['ACME/web']) });
    expect(rules.repositories['acme/web']?.paused).toBe(true);
    expect(rules.repositories['acme/api']?.paused).toBeUndefined();
    expect(decideDispatch(rules, { repositoryFullName: 'acme/web', repositoryId: 9, label: 'updraft', sender: 'pat' })).toMatchObject({ start: false, reason: 'the repository is paused' });
    expect(decideDispatch(rules, { repositoryFullName: 'acme/api', repositoryId: 10, label: 'updraft', sender: 'pat' })).toMatchObject({ start: true });
  });
});

describe('stored actor lists', () => {
  it('still decide on versions stored with the actors on every trigger', () => {
    const legacy = { repositories: { 'acme/web': { id: 9, triggers: [{ label: 'updraft', actors: ['pat'] }] } } };
    expect(decideDispatch(legacy, { repositoryFullName: 'acme/web', repositoryId: 9, label: 'updraft', sender: 'pat' })).toMatchObject({ start: true });
    expect(decideDispatch(legacy, { repositoryFullName: 'acme/web', repositoryId: 9, label: 'updraft', sender: 'eve' })).toMatchObject({ start: false });
  });

  it('a shared list is stored once, and decides for every trigger', () => {
    const rules = dispatchRules({
      dispatch: { allowedActors: [] },
      repositories: {
        'acme/web': {
          id: 9,
          workflows: [
            { trigger: { label: 'a' }, allowedActors: ['Pat', 'sam'] },
            { trigger: { label: 'b' }, allowedActors: ['pat', 'sam'] },
          ],
        },
      },
    });
    expect(rules.repositories['acme/web']).toEqual({ id: 9, actors: ['pat', 'sam'], triggers: [{ label: 'a' }, { label: 'b' }] });
    expect(decideDispatch(rules, { repositoryFullName: 'acme/web', repositoryId: 9, label: 'B', sender: 'sam' })).toMatchObject({ start: true });
    expect(decideDispatch(rules, { repositoryFullName: 'acme/web', repositoryId: 9, label: 'b', sender: 'eve' })).toMatchObject({ start: false });
  });
});
