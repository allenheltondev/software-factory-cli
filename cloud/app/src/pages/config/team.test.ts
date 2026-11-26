import { describe, expect, it } from 'vitest';
import type { AgentAdapter, ConsoleConfig } from '../../api/client';
import {
  addLabel,
  connectionOf,
  customSettings,
  customize,
  customizeRepo,
  describeChanges,
  effective,
  labelGroups,
  removeLabel,
  resetRepo,
  resetToDefaults,
  selfReviewing,
  setDefaultCoding,
  setDefaultReview,
  setOverride,
  setPool,
  setRepoLabel,
  teamOf,
} from './team';

const PROMPTS = { implement: '# Implement', review: '# Review', revise: '# Revise' };
const ADAPTERS: AgentAdapter[] = ['claude', 'codex', 'kiro', 'vibe'];
const repo = (workflows: string[]) => ({ enabled: true, workflows, publish: 'draft-pr' as const, commentOnFailure: true, verify: [] });

/** Two connected providers: both code, both review (independently), on "ready", in two repositories. */
const base = (): ConsoleConfig => ({
  version: 2,
  agents: { claude: { adapter: 'claude', enabled: true }, codex: { adapter: 'codex', enabled: true }, kiro: { adapter: 'kiro', enabled: false } },
  pools: { builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['claude', 'codex'] } },
  allowedActors: ['pat'],
  workflows: {
    implement: {
      label: 'ready',
      pool: 'builders',
      prompt: PROMPTS.implement,
      review: { enabled: true, pool: 'reviewers', prompt: PROMPTS.review, allowSameAgent: false },
      revise: { enabled: true, prompt: PROMPTS.revise, maxRevisions: 2 },
    },
  },
  repositories: { 'acme/web': { ...repo(['implement']), ci: {} }, 'acme/api': repo(['implement']) },
});
const clone = (c: ConsoleConfig) => JSON.parse(JSON.stringify(c)) as ConsoleConfig;

describe('what the main page can show', () => {
  it('shows the defaults, several labels and exceptions; names what needs the full editor', () => {
    expect(customSettings(base())).toEqual([]);
    let c = addLabel(base(), 'art', PROMPTS);
    c = setOverride(c, 'art', 'coding', ['codex'], ADAPTERS);
    c = customizeRepo(c, 'acme/api', labelGroups(c)[0]!, ADAPTERS);
    expect(customSettings(c)).toEqual([]);

    const pools = base();
    pools.pools.fast = { agents: ['claude'] };
    expect(customSettings(pools)).toEqual(['Pool "fast" is not used by any workflow.']);
    const profiles = base();
    profiles.agents['claude-2'] = { adapter: 'claude', model: 'claude-haiku-5-5', enabled: true };
    expect(customSettings(profiles)[0]).toMatch(/Agent profile "claude-2" \(Claude Code\) has a name of its own/);
    const shared = setOverride(addLabel(base(), 'art', PROMPTS), 'art', 'coding', ['codex'], ADAPTERS);
    shared.workflows.implement!.pool = 'art-coding';
    expect(customSettings(shared)).toEqual([expect.stringMatching(/Pool "art-coding" is shared/)]);
    const policy = addLabel(base(), 'docs', PROMPTS);
    policy.workflows.docs!.revise.enabled = false;
    expect(customSettings(policy)).toEqual([expect.stringMatching(/review or revise pull requests differently/)]);
  });
});

describe('the default team and overrides', () => {
  it('a label override is its own pool; changing the default only changes workflows that inherit it; reset restores inheritance exactly', () => {
    const start = addLabel(base(), 'art', PROMPTS);
    const art = setOverride(start, 'art', 'coding', ['codex'], ADAPTERS);
    expect(art.workflows.art!.pool).toBe('art-coding');
    expect(art.pools['art-coding']).toEqual({ agents: ['codex'] });
    expect(art.pools.builders).toEqual(start.pools.builders);
    expect(teamOf(art, 'art')).toEqual({ coding: ['codex'], review: ['claude', 'codex'], inherits: { coding: false, review: true } });

    const changed = setDefaultCoding(art, ['claude'], ADAPTERS);
    expect(teamOf(changed, 'implement').coding).toEqual(['claude']);
    expect(teamOf(changed, 'art').coding).toEqual(['codex']);

    expect(resetToDefaults(art, 'art')).toEqual(start);
    // Customizing starts from the current team: nothing runs differently until an agent is ticked.
    const same = customize(start, 'art', ADAPTERS);
    expect(effective(same).map((r) => [r.coding, r.review])).toEqual(effective(start).map((r) => [r.coding, r.review]));
    expect(resetToDefaults(same, 'art')).toEqual(start);
  });

  it('a repository exception is a workflow of its own on the same label, and resetting removes it', () => {
    const start = base();
    const g = labelGroups(start)[0]!;
    const c = customizeRepo(start, 'acme/api', g, ADAPTERS);
    const variant = c.repositories['acme/api']!.workflows[0]!;
    expect(variant).toBe('implement-api');
    expect(c.workflows[variant]).toMatchObject({ label: 'ready', prompt: PROMPTS.implement, pool: 'implement-api-coding', review: { pool: 'implement-api-review', allowSameAgent: false }, revise: { maxRevisions: 2 } });
    // acme/web keeps its workflow, and so its workflow id for work in flight.
    expect(c.repositories['acme/web']!.workflows).toEqual(['implement']);
    const claudeOnly = setOverride(c, variant, 'coding', ['claude'], ADAPTERS);
    expect(effective(claudeOnly).map((r) => [r.repository, r.label, r.coding.join(), r.source])).toEqual([
      ['acme/web', 'ready', 'Claude Code,Codex', 'default'],
      ['acme/api', 'ready', 'Claude Code', 'repository'],
    ]);
    expect(resetRepo(claudeOnly, 'acme/api', labelGroups(claudeOnly)[0]!)).toEqual(start);
  });

  it('labels: added to every repository on the shared policy, toggled per repository, removed with their pools', () => {
    const start = base();
    const c = addLabel(start, 'Art work', PROMPTS);
    expect(c.workflows['art-work']).toMatchObject({ label: 'Art work', pool: 'builders', review: { enabled: true, pool: 'reviewers', allowSameAgent: false }, revise: { enabled: true, maxRevisions: 2 } });
    expect(c.repositories['acme/web']!.workflows).toEqual(['implement', 'art-work']);
    const art = labelGroups(c)[1]!;
    const off = setRepoLabel(c, 'acme/api', art, false);
    expect(off.repositories['acme/api']!.workflows).toEqual(['implement']);
    expect(setRepoLabel(off, 'acme/api', art, true)).toEqual(c);
    expect(removeLabel(setOverride(c, 'art-work', 'coding', ['codex'], ADAPTERS), art)).toEqual(start);
  });

  it('two providers both code, a distinct one reviews; turning an agent on drops it from pools it sat in while off', () => {
    let c = base();
    c.pools.builders = { agents: ['claude', 'codex', 'kiro'] };
    c = setDefaultReview(c, ['kiro'], ADAPTERS);
    expect(c.agents.kiro!.enabled).toBe(true);
    // Kiro was in builders while off: turning it on to review does not start it coding.
    expect(c.pools.builders).toEqual({ agents: ['claude', 'codex'] });
    expect(teamOf(c, 'implement')).toMatchObject({ coding: ['claude', 'codex'], review: ['kiro'] });
    expect(selfReviewing(c)).toEqual([]);
    expect(effective(c)[0]).toMatchObject({ coding: ['Claude Code', 'Codex'], review: ['Kiro'], source: 'default' });
  });

  it('no automated review turns review off everywhere without touching self-review consent, and drops CI repair', () => {
    const c = setDefaultReview(base(), [], ADAPTERS);
    expect(c.pools.reviewers).toBeUndefined();
    expect(c.workflows.implement!.review).toMatchObject({ enabled: false, allowSameAgent: false });
    expect(c.repositories['acme/web']!.ci).toBeUndefined();
    const back = setDefaultReview(c, ['codex'], ADAPTERS);
    expect(back.workflows.implement!.review).toMatchObject({ enabled: true, pool: 'reviewers', allowSameAgent: false });
    // Codex would review its own work: the page asks for consent instead of granting it.
    expect(selfReviewing(back)).toEqual([{ workflow: 'implement', label: 'ready', agents: ['codex'] }]);
  });

  it('an agent no team chooses is turned off (its key is not needed), and kept on the roster', () => {
    const c = setPool(base(), 'builders', ['claude'], ADAPTERS);
    expect(c.agents.codex!.enabled).toBe(true); // still reviews
    const d = setDefaultReview(c, ['claude'], ADAPTERS);
    expect(d.agents.codex).toEqual({ adapter: 'codex', enabled: false });
  });

  it('every edit leaves the input as it was (no hidden normalization on load)', () => {
    const c = base();
    const before = clone(c);
    customize(c, 'implement', ADAPTERS);
    customizeRepo(c, 'acme/web', labelGroups(c)[0]!, ADAPTERS);
    setDefaultReview(c, [], ADAPTERS);
    expect(c).toEqual(before);
  });
});

describe('describing changes and connections', () => {
  it('says what publishing changes, per repository and label', () => {
    const start = base();
    const next = setOverride(addLabel(start, 'art', PROMPTS), 'art', 'coding', ['codex'], ADAPTERS);
    expect(describeChanges(start, start)).toEqual([]);
    expect(describeChanges(start, next)).toEqual(['acme/web · art: starts work (coding Codex; review Claude Code, Codex).', 'acme/api · art: starts work (coding Codex; review Claude Code, Codex).']);
    expect(describeChanges(start, setDefaultCoding(start, ['claude'], ADAPTERS))).toEqual(['acme/web · ready: coding Claude Code, Codex → Claude Code.', 'acme/api · ready: coding Claude Code, Codex → Claude Code.']);
  });

  it('derives readiness from the key the server holds and its last use, not from the key alone', () => {
    const view = { agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: false, KIRO_API_KEY: true }, agents: ['claude', 'codex', 'kiro'] as AgentAdapter[] };
    const offered = view.agents;
    expect(connectionOf('claude', view, offered)).toBe('connected');
    expect(connectionOf('claude', view, offered, { configured: true, lastUsed: { at: '2026-11-01T00:00:00Z', ok: false } })).toBe('failing');
    expect(connectionOf('codex', view, offered)).toBe('missing');
    expect(connectionOf('kiro', view, offered)).toBe('unverified');
    expect(connectionOf('kiro', view, offered, { configured: true, lastUsed: { at: '2026-11-01T00:00:00Z', ok: true } })).toBe('connected');
    expect(connectionOf('vibe', view, offered)).toBe('unavailable');
  });
});
