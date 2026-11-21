import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createBundleKeys, keysOfRules, rulesFromBundle, workflowKeys } from './key-needs.js';
import { configPrefix } from './paths.js';

// A compiled config as config.yaml holds it: two workflows on one label, for different actors.
const compiled = {
  agents: { claude: { adapter: 'claude' }, codex: { adapter: 'codex' } },
  pools: { c: { agents: ['claude'] }, x: { agents: ['codex'] } },
  repositories: {
    'acme/web': {
      id: 9,
      workflows: [
        { trigger: { label: 'updraft' }, pool: 'c', allowedActors: ['alice'] },
        { trigger: { label: 'updraft' }, pool: 'x', allowedActors: ['bob'] },
        // Labels are the tenant's own words: one named like an inherited property is just a label.
        { trigger: { label: 'constructor' }, pool: 'c', allowedActors: ['alice'] },
        { trigger: { label: '__proto__' }, pool: 'x', allowedActors: ['alice'] },
      ],
    },
  },
};
const event = (label: string, sender: string) => ({ repositoryFullName: 'acme/web', repositoryId: 9, label, sender });

describe('key needs (#70)', () => {
  it("are each workflow's own", () => {
    const repo = compiled.repositories['acme/web'];
    expect(repo.workflows.map((wf) => workflowKeys(compiled, repo, wf))).toEqual([['ANTHROPIC_API_KEY'], ['CODEX_API_KEY'], ['ANTHROPIC_API_KEY'], ['CODEX_API_KEY']]);
  });

  it('come from an older bundle per workflow, matched by label and actor, whatever the label', async () => {
    const reads: string[] = [];
    const keys = createBundleKeys(async (key) => (reads.push(key), stringify(compiled)), configPrefix);
    expect(await keys.forEvent(55, 3, event('updraft', 'alice'))).toEqual(['ANTHROPIC_API_KEY']);
    expect(await keys.forEvent(55, 3, event('updraft', 'bob'))).toEqual(['CODEX_API_KEY']);
    expect(await keys.forEvent(55, 3, event('constructor', 'alice'))).toEqual(['ANTHROPIC_API_KEY']);
    expect(await keys.forEvent(55, 3, event('__proto__', 'alice'))).toEqual(['CODEX_API_KEY']);
    expect(await keys.forVersion(55, 3)).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
    expect(await keys.forVersion(55, 3, new Set(['acme/web']))).toEqual([]);
    expect(reads).toEqual(['tenants/55/config/3/config.yaml']);
  });

  it('cannot tell from a missing or unreadable bundle', async () => {
    expect(await createBundleKeys(async () => null, configPrefix).forEvent(55, 3, event('updraft', 'alice'))).toBeNull();
    expect(await createBundleKeys(async () => '{ not yaml', configPrefix).forVersion(55, 3)).toBeNull();
    expect(rulesFromBundle('- a list')).toBeNull();
    expect(keysOfRules(rulesFromBundle(stringify(compiled))!)).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
  });
});
