// Validation of the review loop's options: review, reviewPrompt, reviewPool, autoMerge.
import { describe, expect, it } from 'vitest';
import { autoMergeMethod, configSchema, reviewActive, reviewSettings } from './schema.js';
import { validateConfig } from './validate.js';

const REPO = 'octo/widgets';

function base(over: { repo?: Record<string, unknown>; workflow?: Record<string, unknown>; action?: Record<string, unknown>; pools?: Record<string, { agents: string[] }>; mode?: string; agents?: Record<string, unknown> } = {}) {
  return {
    version: 1,
    execution: { mode: over.mode ?? 'live' },
    agents: over.agents ?? { claude: {}, codex: {} },
    pools: over.pools ?? { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
    actions: { 'implement-issue': { prompt: './p.md', revisePrompt: './r.md', reviewPrompt: './v.md', ...over.action } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [REPO]: {
        id: 42,
        checkoutPath: './clone',
        publish: 'draft-pr',
        revise: true,
        review: true,
        ...over.repo,
        workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general', reviewPool: 'reviewers', ...over.workflow }],
      },
    },
  };
}

const errorsOf = (raw: unknown) => {
  const r = validateConfig(raw);
  return r.ok ? [] : r.errors;
};

describe('review loop options', () => {
  it('are off by default and accepted when complete', () => {
    const plain = configSchema.parse(base({ repo: { review: undefined } }));
    expect(reviewSettings(plain.repositories[REPO]!)).toEqual({ enabled: false, allowSameAgent: false });
    expect(reviewActive(plain, plain.repositories[REPO]!)).toBe(false);
    expect(autoMergeMethod(plain, plain.repositories[REPO]!)).toBeNull();

    const r = validateConfig(base({ repo: { autoMerge: 'squash', autoMergeWaitMinutes: 30 } }));
    expect(r).toMatchObject({ ok: true, warnings: [] });
    if (!r.ok) return;
    const repo = r.config.repositories[REPO]!;
    expect(reviewSettings(repo)).toEqual({ enabled: true, allowSameAgent: false });
    expect(autoMergeMethod(r.config, repo)).toBe('squash');
    expect(reviewSettings(configSchema.parse(base({ repo: { review: { allowSameAgent: true } } })).repositories[REPO]!)).toEqual({ enabled: true, allowSameAgent: true });
    expect(reviewSettings(configSchema.parse(base({ repo: { review: {} } })).repositories[REPO]!)).toEqual({ enabled: true, allowSameAgent: false });

    expect(errorsOf(base({ repo: { autoMerge: 'fast-forward' } }))).not.toEqual([]);
    expect(errorsOf(base({ repo: { review: { allowOwnAgent: true } } }))).not.toEqual([]);
  });

  it('requires a reviewPrompt for every action a reviewing repository runs', () => {
    expect(errorsOf(base({ action: { reviewPrompt: undefined } }))).toEqual([
      { path: 'actions.implement-issue.reviewPrompt', message: expect.stringMatching(/required because repositories\.octo\/widgets\.review is on/) },
    ]);
    expect(validateConfig(base({ action: { reviewPrompt: undefined }, repo: { review: false } })).ok).toBe(true);
  });

  it('warns where review or autoMerge would do nothing, or nothing would act on a verdict', () => {
    const warningsOf = (raw: unknown) => validateConfig(raw).warnings.map((w) => `${w.path}: ${w.message}`);
    expect(warningsOf(base({ mode: 'prepare-only' }))).toContainEqual(expect.stringMatching(/review: only applies in live mode/));
    expect(warningsOf(base({ repo: { publish: undefined, revise: undefined } }))).toContainEqual(expect.stringMatching(/review: only applies together with publish/));
    expect(warningsOf(base({ repo: { revise: false } }))).toEqual([expect.stringMatching(/review: revise is off, so nothing acts on a "changes requested" verdict/)]);
    expect(warningsOf(base({ repo: { review: false, autoMerge: 'merge', autoMergeWaitMinutes: 5 } }))).toEqual([
      expect.stringMatching(/autoMerge: has no effect without review/),
      expect.stringMatching(/autoMergeWaitMinutes: has no effect without review and autoMerge/),
      expect.stringMatching(/reviewPool: has no effect without repositories\.octo\/widgets\.review/),
    ]);
    expect(warningsOf(base({ repo: { autoMergeWaitMinutes: 5 } }))).toEqual([expect.stringMatching(/autoMergeWaitMinutes: has no effect without autoMerge/)]);
    const off = configSchema.parse(base({ repo: { review: false, autoMerge: 'merge' } }));
    expect(autoMergeMethod(off, off.repositories[REPO]!)).toBeNull();
  });

  it('rejects an unknown reviewPool', () => {
    expect(errorsOf(base({ workflow: { reviewPool: 'nobody' } }))).toContainEqual({ path: `repositories.${REPO}.workflows.0.reviewPool`, message: 'unknown pool "nobody"' });
  });

  it('rejects a configuration in which the reviewer could only be the author, unless allowSameAgent is set', () => {
    // The coding pool and the review pool are the same single agent.
    const single = { workflow: { reviewPool: undefined }, pools: { general: { agents: ['claude'] } } };
    expect(errorsOf(base(single))).toEqual([
      { path: `repositories.${REPO}.workflows.0.pool`, message: expect.stringMatching(/"claude" is the only enabled agent in pool "general" and also writes code in pool "general".*allowSameAgent: true/) },
    ]);
    expect(validateConfig(base({ ...single, repo: { review: { allowSameAgent: true } } })).ok).toBe(true);
    // A separate review pool that holds only the coding agent is no better.
    expect(errorsOf(base({ pools: { general: { agents: ['claude'] }, reviewers: { agents: ['claude'] } } }))).toEqual([
      { path: `repositories.${REPO}.workflows.0.reviewPool`, message: expect.stringMatching(/only enabled agent in pool "reviewers"/) },
    ]);
    // Two agents on paper, one of them disabled.
    expect(
      errorsOf(base({ workflow: { reviewPool: undefined }, pools: { general: { agents: ['claude', 'codex'] } }, agents: { claude: {}, codex: { enabled: false } } })),
    ).toHaveLength(1);
    // Fine: two enabled agents share one pool; or the reviewer is someone else altogether.
    expect(validateConfig(base({ workflow: { reviewPool: undefined }, pools: { general: { agents: ['claude', 'codex'] } } })).ok).toBe(true);
    expect(validateConfig(base()).ok).toBe(true);
    // A routed pool is checked too.
    const routed = base({
      workflow: { reviewPool: undefined, pool: { rules: [{ hasLabel: 'art', use: 'art' }], default: 'general' } },
      pools: { general: { agents: ['claude', 'codex'] }, art: { agents: ['codex'] } },
    });
    expect(errorsOf(routed)).toEqual([{ path: `repositories.${REPO}.workflows.0.pool`, message: expect.stringMatching(/"codex" is the only enabled agent in pool "art"/) }]);
    // Not checked where no reviewer runs happen.
    expect(validateConfig(base({ ...single, repo: { review: false } })).ok).toBe(true);
  });
});
