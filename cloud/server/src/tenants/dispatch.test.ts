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
        'acme/api': { id: 10, triggers: [{ label: 'updraft', actors: ['pat', 'sam'] }] },
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
