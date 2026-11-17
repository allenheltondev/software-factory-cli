import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
import { buildAgentChoices, buildRepoChoices, configureCommand, suggestedPools } from './configure.js';
import { EXIT } from './errors.js';
import { fakeAgentReport, fakeApi, fakeContext, fakeRepo, missingAgentReport } from './fakes.js';
import type { Prompter } from './prompter.js';

type Answer = { method: keyof Prompter; value: unknown; expect?: RegExp };

/** A prompter that replays scripted answers in order and records what it was shown. */
function scripted(answers: Answer[]) {
  const shown: string[] = [];
  const queue = [...answers];
  const next = (method: keyof Prompter, message: string, o?: unknown) => {
    shown.push(`${method}: ${message}`);
    const a = queue.shift();
    if (!a) throw new Error(`unexpected prompt ${method}: ${message}`);
    if (a.method !== method) throw new Error(`expected ${a.method}, got ${method}: ${message}`);
    if (a.expect && !a.expect.test(message)) throw new Error(`prompt "${message}" did not match ${a.expect}`);
    return typeof a.value === 'function' ? (a.value as (o: unknown) => unknown)(o) : a.value;
  };
  const p: Prompter = {
    intro: (m) => shown.push(`intro: ${m}`),
    outro: (m) => shown.push(`outro: ${m}`),
    note: (b, t) => shown.push(`note ${t ?? ''}: ${b}`),
    info: (m) => shown.push(`info: ${m}`),
    warn: (m) => shown.push(`warn: ${m}`),
    searchMultiselect: async (o) => next('searchMultiselect', o.message, o) as never,
    searchSelect: async (o) => next('searchSelect', o.message, o) as never,
    select: async (o) => next('select', o.message, o) as never,
    multiselect: async (o) => next('multiselect', o.message, o) as never,
    text: async (o) => next('text', o.message, o) as never,
    confirm: async (o) => next('confirm', o.message, o) as never,
    spin: async (_m, fn) => fn(),
  };
  return { p, shown, remaining: queue };
}

describe('buildRepoChoices', () => {
  it('preselects watched repos by ID, sorts them first, and deselects inaccessible ones', () => {
    const r = buildRepoChoices({
      listed: [fakeRepo('z/new', 3), fakeRepo('a/other', 4), fakeRepo('m/watched-renamed', 1, { private: true })],
      extra: [
        { fullName: 'pub/lic', id: 7, repo: fakeRepo('pub/lic', 7) },
        { fullName: 'gone/repo', id: 8, repo: null },
      ],
      watchedIds: new Set([1, 7, 8]),
    });
    expect(r.options.map((o) => o.label)).toEqual(['gone/repo', 'm/watched-renamed', 'pub/lic', 'a/other', 'z/new']);
    expect(r.initialValues.sort()).toEqual([1, 7]);
    expect(r.options[0]?.hint).toMatch(/NOT accessible/);
    expect(r.options[1]?.hint).toMatch(/watched · private/);
  });
});

describe('factory configure', () => {
  it('refuses to run without a TTY', async () => {
    const ctx = fakeContext({ isTTY: false });
    await expect(configureCommand(ctx)).rejects.toMatchObject({ exitCode: EXIT.USAGE, message: expect.stringMatching(/factory add/) });
  });

  it('first run: seeds defaults, picks a repo, label, routing and backfill, and saves', async () => {
    const api = fakeApi({
      login: 'allen',
      repos: [fakeRepo('o/a', 1), fakeRepo('o/b', 2)],
      labels: { 'o/a': ['bug', 'factory:ready', 'art'] },
    });
    const { p, shown, remaining } = scripted([
      { method: 'multiselect', expect: /Enabled agents/, value: (o: { initialValues: string[] }) => o.initialValues.filter((a) => a !== 'codex') },
      { method: 'searchMultiselect', expect: /Repositories/, value: [1] },
      { method: 'searchSelect', expect: /o\/a: trigger label/, value: (o: { initialValue: string }) => o.initialValue },
      { method: 'select', expect: /Action/, value: 'implement-issue' },
      { method: 'confirm', expect: /different pool/, value: true },
      { method: 'searchSelect', expect: /Issues with label/, value: 'art' },
      { method: 'select', expect: /go to pool/, value: '\u0000custom' },
      { method: 'text', expect: /Pool name/, value: 'art' },
      { method: 'multiselect', expect: /Agents in pool art/, value: ['claude'] },
      { method: 'confirm', expect: /another routing rule/, value: false },
      { method: 'select', expect: /Default pool/, value: 'general' },
      { method: 'confirm', expect: /another workflow/, value: false },
      { method: 'select', expect: /o\/a is new/, value: 'backfill' },
      { method: 'text', expect: /Backfill since/, value: '2025-03-01' },
      { method: 'confirm', expect: /Save to/, value: true },
    ]);
    const ctx = fakeContext({ isTTY: true, api, prompter: p });
    expect(await configureCommand(ctx)).toBe(EXIT.OK);
    expect(remaining).toEqual([]);

    const cfg = parse(readFileSync(ctx.paths.configFile, 'utf8'));
    expect(cfg.dispatch.allowedActors).toEqual(['allen']);
    expect(cfg.agents.codex.enabled).toBe(false);
    expect(cfg.pools.art).toEqual({ agents: ['claude'], strategy: 'round-robin' });
    expect(cfg.repositories).toEqual({
      'o/a': {
        id: 1,
        backfillSince: '2025-03-01T00:00:00.000Z',
        workflows: [
          {
            trigger: { event: 'issue.labeled', label: 'factory:ready' },
            action: 'implement-issue',
            pool: { rules: [{ hasLabel: 'art', use: 'art' }], default: 'general' },
          },
        ],
      },
    });
    const changes = shown.find((s) => s.startsWith('note Changes'));
    expect(changes).toContain('+ repo o/a (id 1)');
    expect(changes).toContain('pool art added');
    expect(shown.at(-1)).toMatch(/worker restarts/);
  });

  it('edit run: keeps an existing repo, removes a deselected one, and shows the diff', async () => {
    const api = fakeApi({ login: 'allen', repos: [fakeRepo('o/a', 1), fakeRepo('o/b', 2)] });
    const wf = buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' });
    let base = upsertRepoWorkflow(seedConfig('allen'), { id: 1, fullName: 'o/a' }, wf).config;
    base = upsertRepoWorkflow(base, { id: 2, fullName: 'o/b' }, wf).config;
    const ctx0 = fakeContext();
    writeFileSync(ctx0.paths.configFile, stringify(base));

    const { p, shown } = scripted([
      { method: 'multiselect', value: ['codex', 'claude', 'kiro'] },
      { method: 'searchMultiselect', value: (o: { initialValues: number[] }) => (expect(o.initialValues.sort()).toEqual([1, 2]), [1]) },
      { method: 'select', expect: /o\/a: workflows/, value: 'keep' },
      { method: 'confirm', expect: /Save to/, value: true },
    ]);
    const ctx = fakeContext({ home: ctx0.paths.configDir, isTTY: true, api, prompter: p });
    expect(await configureCommand(ctx)).toBe(EXIT.OK);
    const cfg = parse(readFileSync(ctx.paths.configFile, 'utf8'));
    expect(Object.keys(cfg.repositories)).toEqual(['o/a']);
    const changes = shown.find((s) => s.startsWith('note Changes'));
    expect(changes).toContain('- repo o/b (id 2)');
    expect(changes).toContain('- workflow o/b [implement-issue:go]');
  });

  it('reports no changes without prompting to save', async () => {
    const api = fakeApi({ repos: [fakeRepo('o/a', 1)] });
    const base = upsertRepoWorkflow(seedConfig('allen'), { id: 1, fullName: 'o/a' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config;
    const ctx0 = fakeContext();
    writeFileSync(ctx0.paths.configFile, stringify(base));
    const { p, shown } = scripted([
      { method: 'multiselect', value: ['codex', 'claude', 'kiro'] },
      { method: 'searchMultiselect', value: [1] },
      { method: 'select', value: 'keep' },
    ]);
    const ctx = fakeContext({ home: ctx0.paths.configDir, isTTY: true, api, prompter: p });
    expect(await configureCommand(ctx)).toBe(EXIT.OK);
    expect(shown.at(-1)).toBe('outro: No changes.');
  });

  it('pre-selects discovered agents, marks missing ones, and only offers pools with a usable agent', async () => {
    const api = fakeApi({ login: 'allen', repos: [fakeRepo('o/a', 1)], labels: { 'o/a': ['factory:ready'] } });
    const base = seedConfig('allen');
    base.pools.art = { agents: ['codex'], strategy: 'round-robin' };
    let agentPrompt: { initialValues: string[]; options: Array<{ value: string; hint?: string }> } | undefined;
    let poolOptions: string[] = [];
    const { p, shown, remaining } = scripted([
      {
        method: 'multiselect',
        expect: /Enabled agents/,
        value: (o: typeof agentPrompt) => {
          agentPrompt = o;
          return o!.initialValues;
        },
      },
      { method: 'searchMultiselect', value: [1] },
      { method: 'searchSelect', value: 'factory:ready' },
      { method: 'select', expect: /Action/, value: 'implement-issue' },
      { method: 'confirm', expect: /different pool/, value: false },
      {
        method: 'select',
        expect: /Pool/,
        value: (o: { options: Array<{ value: string }>; initialValue: string }) => {
          poolOptions = o.options.map((x) => x.value);
          return o.initialValue;
        },
      },
      { method: 'confirm', expect: /another workflow/, value: false },
      { method: 'select', expect: /is new/, value: 'now' },
      { method: 'confirm', expect: /Save to/, value: true },
    ]);
    const ctx = fakeContext({
      isTTY: true,
      api,
      prompter: p,
      agents: [missingAgentReport('codex'), fakeAgentReport('claude'), fakeAgentReport('kiro', { signedIn: 'no', usable: false })],
    });
    writeFileSync(ctx.paths.configFile, stringify(base));
    expect(await configureCommand(ctx)).toBe(EXIT.OK);
    expect(remaining).toEqual([]);
    expect(agentPrompt?.initialValues).toEqual(['claude']);
    expect(agentPrompt?.options.find((o) => o.value === 'codex')?.hint).toBe('codex · missing');
    expect(agentPrompt?.options.find((o) => o.value === 'kiro')?.hint).toBe('kiro-cli · not signed in · 1.0.0');
    expect(poolOptions).toEqual(['general', '\u0000custom']);
    expect(shown).toContain('info: Not offering pool(s) with no usable agent here: art');
    const cfg = parse(readFileSync(ctx.paths.configFile, 'utf8'));
    expect(cfg.agents.codex.enabled).toBe(false);
    expect(cfg.agents.kiro.enabled).toBe(false);
  });
});

describe('buildAgentChoices / suggestedPools', () => {
  it('keeps agents the existing config disabled deselected even when usable', () => {
    const r = buildAgentChoices(
      { codex: { enabled: false }, claude: {}, mine: { adapter: 'claude' } },
      [fakeAgentReport('codex'), fakeAgentReport('claude')],
      true,
    );
    expect(r.initialValues).toEqual(['claude', 'mine']);
    expect([...r.usable]).toEqual(['codex', 'claude', 'mine']);
    expect(buildAgentChoices({ codex: { enabled: false } }, [fakeAgentReport('codex')], false).initialValues).toEqual(['codex']);
  });

  it('falls back to every pool when none has a usable agent', () => {
    const pools = { a: { agents: ['x'] }, b: { agents: ['y'] } };
    expect(suggestedPools(pools, new Set(['y']))).toEqual({ pools: ['b'], hidden: ['a'] });
    expect(suggestedPools(pools, new Set())).toEqual({ pools: ['a', 'b'], hidden: [] });
  });
});
