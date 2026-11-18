// `updraft doctor` for the revision loop and the review loop: prompts, who can review whom,
// and whether the account can merge.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { fakeAdapter } from '../../test/fake-adapter.js';
import type { AgentReport } from '../agents/discovery.js';
import { registerAdapter } from '../agents/adapters/registry.js';
import { configSchema, type AdapterName } from '../config/schema.js';
import type { GitHubRepo } from '../github/api.js';
import { resolvePaths } from '../paths.js';
import { loopChecks, runDoctor, type DoctorProbes } from './doctor.js';
import { fakeAgentReport, fakeApi, fakeRepo, tempHome } from './fakes.js';

const REPO = 'o/r';
const R = resolve('/cfg', './prompts/r.md');
const V = resolve('/cfg', './prompts/v.md');

function raw(over: { repo?: Record<string, unknown>; workflow?: Record<string, unknown>; pools?: Record<string, { agents: string[] }>; action?: Record<string, unknown>; mode?: string } = {}) {
  return {
    version: 1,
    execution: { mode: over.mode ?? 'live' },
    agents: { claude: {}, codex: {} },
    pools: over.pools ?? { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
    actions: { 'implement-issue': { prompt: './p.md', revisePrompt: './prompts/r.md', reviewPrompt: './prompts/v.md', ...over.action } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      [REPO]: {
        id: 10,
        checkoutPath: './clone',
        publish: 'draft-pr',
        revise: true,
        review: true,
        ...over.repo,
        workflows: [{ id: 'wf', trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general', reviewPool: 'reviewers', ...over.workflow }],
      },
    },
  };
}

const lines = (o: Parameters<typeof raw>[0], exists: (p: string) => boolean = () => true) => {
  const config = configSchema.parse(raw(o));
  return loopChecks(config, REPO, config.repositories[REPO]!, '/cfg', exists).map((c) => `${c.status} ${c.detail}`);
};

describe('loopChecks', () => {
  it('says nothing when revise and review are off', () => {
    expect(lines({ repo: { revise: false, review: false } })).toEqual([]);
  });

  it('checks the revise and review prompts and that a reviewer other than the author exists', () => {
    expect(lines({})).toEqual([
      `ok revise: prompt ${R} (actions.implement-issue.revisePrompt)`,
      'ok revise: up to 3 revision(s) per pull request; they are pushed with the same access as publish',
      `ok review: prompt ${V} (actions.implement-issue.reviewPrompt)`,
      'ok review: workflow wf, code from pool general, reviewers from pool reviewers: a reviewer other than the author is always available (codex)',
    ]);
    expect(lines({}, (p) => !p.endsWith('v.md') && !p.endsWith('r.md'))).toEqual(
      expect.arrayContaining([
        `fail revise: prompt file ${R} (actions.implement-issue.revisePrompt) does not exist`,
        `fail review: prompt file ${V} (actions.implement-issue.reviewPrompt) does not exist`,
      ]),
    );
    expect(lines({ action: { reviewPrompt: undefined, revisePrompt: undefined } })).toEqual(
      expect.arrayContaining(['fail revise: actions.implement-issue.revisePrompt is not set', 'fail review: actions.implement-issue.reviewPrompt is not set']),
    );
  });

  it('fails when the author would be the only reviewer, and warns when that was allowed on purpose', () => {
    const alone = { workflow: { reviewPool: undefined }, pools: { general: { agents: ['claude'] } } };
    expect(lines(alone)).toContain('fail review: workflow wf, code from pool general, reviewers from pool general: claude is the only enabled reviewer and also writes the code');
    expect(lines({ ...alone, repo: { review: { allowSameAgent: true } } })).toContain(
      'warn review: workflow wf, code from pool general, reviewers from pool general: claude reviews its own work (review.allowSameAgent)',
    );
    expect(lines({ repo: { revise: false } })).toContain('warn review: revise is off, so a "changes requested" verdict is only posted');
    expect(lines({ mode: 'log-only' })).toEqual([
      'warn revise is set but does nothing here: it needs execution.mode live and publish',
      'warn review is set but does nothing here: it needs execution.mode live and publish',
    ]);
  });
});

describe('runDoctor: autoMerge', () => {
  async function doctor(repo: Partial<GitHubRepo>, over: Parameters<typeof raw>[0] = { repo: { autoMerge: 'squash' } }) {
    const restore = [registerAdapter(fakeAdapter({ name: 'claude' })), registerAdapter(fakeAdapter({ name: 'codex' }))];
    try {
      const paths = resolvePaths({ env: { UPDRAFT_HOME: tempHome() } });
      writeFileSync(paths.configFile, stringify(raw(over)));
      const api = fakeApi({ login: 'allen', repos: [fakeRepo(REPO, 10, repo)], labels: { [REPO]: ['updraft:ready'] } });
      const probes: DoctorProbes = {
        nodeVersion: '22.13.0',
        platform: 'linux',
        cwd: '/work',
        user: 'allen',
        env: { PATH: '/usr/bin' },
        which: (cmd) => `/usr/bin/${cmd}`,
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
        discoverAgent: async (adapter): Promise<AgentReport> => fakeAgentReport(adapter as AdapterName),
        checkWritable: () => {},
        checkDb: () => {},
        createApi: async () => api,
        fileExists: () => true,
      };
      const report = await runDoctor(paths, probes);
      return report.checks.filter((c) => c.name === `repo ${REPO}` && /autoMerge|review:|revise:/.test(c.detail)).map((c) => `${c.status} ${c.detail}`);
    } finally {
      for (const r of restore.reverse()) r();
    }
  }

  it('passes when the account can merge with the configured method', async () => {
    const checks = await doctor({ mergeMethods: { squash: true, merge: false, rebase: false } });
    expect(checks).toContainEqual(expect.stringMatching(/^ok autoMerge: squash; the active GitHub account can merge\. Branch protection is not checked here/));
    expect(checks).toContainEqual(expect.stringMatching(/^ok review: prompt /));
    expect(checks).toContainEqual(expect.stringMatching(/^ok revise: prompt /));
    expect(await doctor({})).toContainEqual(expect.stringMatching(/^ok autoMerge: squash; .*whether the repository allows this merge method is unverified/));
  });

  it('fails when it cannot: no write access, the method is turned off, or the repository is archived', async () => {
    expect(await doctor({ permissions: { admin: false, push: false, pull: true } })).toContainEqual(expect.stringMatching(/^fail autoMerge: the active GitHub account has no write access/));
    expect(await doctor({ mergeMethods: { squash: false, merge: true, rebase: true } })).toContainEqual('fail autoMerge: squash merges are turned off in the settings of o/r');
    expect(await doctor({ archived: true })).toContainEqual(expect.stringMatching(/^fail autoMerge: o\/r is archived/));
    expect(await doctor({ permissions: null })).toContainEqual(expect.stringMatching(/^warn autoMerge: GitHub did not report/));
  });

  it('says nothing about merging when autoMerge is off, and warns when it is set without review', async () => {
    expect((await doctor({}, {})).filter((c) => c.includes('autoMerge'))).toEqual([]);
    expect(await doctor({}, { repo: { autoMerge: 'merge', review: false } })).toContainEqual(expect.stringMatching(/^warn autoMerge: merge is set but does nothing here/));
  });
});
