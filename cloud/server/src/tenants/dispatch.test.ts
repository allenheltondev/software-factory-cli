import { describe, expect, it } from 'vitest';
import { decideDispatch, dispatchRules } from './dispatch.js';

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
    });
  });
});

describe('decideDispatch', () => {
  const rules = dispatchRules(compiled);
  const event = (overrides: Record<string, unknown> = {}) => ({ repositoryFullName: 'acme/WEB', repositoryId: 9, label: 'UPDRAFT', sender: 'PAT', ...overrides });

  it('starts a job for a trigger label applied by an allowed actor, whatever the case', () => {
    expect(decideDispatch(rules, event())).toEqual({ start: true, repository: 'acme/WEB', repositoryId: 9, label: 'UPDRAFT' });
    expect(decideDispatch(rules, event({ label: 'docs', sender: 'writer' })).start).toBe(true);
  });

  it.each([
    ['an unknown repository', { repositoryFullName: 'acme/other' }, 'the repository is not in the active config'],
    ['a repository with the same name but another id (recreated)', { repositoryId: 99 }, 'the repository is not in the active config'],
    ['a label that is no trigger', { label: 'bug' }, 'the label is not a trigger'],
    ['an actor who may not dispatch', { sender: 'mallory' }, 'the sender may not dispatch work'],
    ['an actor allowed for another trigger only', { label: 'docs', sender: 'pat' }, 'the sender may not dispatch work'],
    ['no sender', { sender: undefined }, 'the sender may not dispatch work'],
  ])('starts nothing for %s', (_what, overrides, reason) => {
    expect(decideDispatch(rules, event(overrides))).toEqual({ start: false, reason });
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
    expect(decideDispatch(rules, { repositoryFullName: 'acme/web', repositoryId: 9, label: 'updraft', sender: 'pat' })).toEqual({ start: false, reason: 'the repository is paused' });
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
