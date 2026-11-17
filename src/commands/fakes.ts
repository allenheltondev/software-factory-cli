/**
 * In-memory fakes for command tests (GitHub API, context, output).
 * Kept tiny and dependency-free; not used at runtime.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentReport } from '../agents/discovery.js';
import { KNOWN_ADAPTERS, type AdapterName } from '../config/schema.js';
import { GitHubError, type GitHubApi, type GitHubLabel, type GitHubRepo } from '../github/api.js';
import { resolvePaths } from '../paths.js';
import type { CommandContext } from './context.js';
import type { Prompter } from './prompter.js';

export class MemoryOutput {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

export function fakeRepo(fullName: string, id: number, extra: Partial<GitHubRepo> = {}): GitHubRepo {
  const [owner = '', name = ''] = fullName.split('/');
  return {
    id,
    fullName,
    owner,
    name,
    private: false,
    archived: false,
    defaultBranch: 'main',
    description: null,
    permissions: { admin: true, push: true, pull: true },
    ...extra,
  };
}

export interface FakeApiData {
  login?: string;
  repos?: GitHubRepo[];
  /** Accessible via getRepo but not listed by listUserRepos (e.g. public repos). */
  publicRepos?: GitHubRepo[];
  labels?: Record<string, string[]>;
}

export function fakeApi(data: FakeApiData = {}): GitHubApi & { calls: string[] } {
  const calls: string[] = [];
  const all = [...(data.repos ?? []), ...(data.publicRepos ?? [])];
  return {
    calls,
    async getViewer() {
      calls.push('getViewer');
      return { login: data.login ?? 'octocat', id: 1 };
    },
    async listUserRepos() {
      calls.push('listUserRepos');
      return data.repos ?? [];
    },
    async getRepo(fullName) {
      calls.push(`getRepo ${fullName}`);
      const r = all.find((x) => x.fullName.toLowerCase() === fullName.toLowerCase());
      if (!r) throw new GitHubError(`Repository ${fullName}`, 404);
      return r;
    },
    async listLabels(repo) {
      calls.push(`listLabels ${repo.fullName}`);
      return (data.labels?.[repo.fullName] ?? []).map((name): GitHubLabel => ({ name, color: 'ededed', description: null }));
    },
    async listIssueEvents() {
      throw new Error('not used');
    },
    async getIssue() {
      throw new Error('not used');
    },
  };
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'factory-cmd-'));
}

/** A discovery report for one agent; usable (found, runnable, signed in, supported) by default. */
export function fakeAgentReport(adapter: AdapterName, extra: Partial<AgentReport> = {}): AgentReport {
  const command = adapter === 'kiro' ? 'kiro-cli' : adapter;
  return {
    adapter,
    name: adapter,
    command,
    installed: true,
    path: `/usr/bin/${command}`,
    onPath: true,
    launch: { file: `/usr/bin/${command}`, args: [] },
    runnable: 'yes',
    version: '1.0.0',
    signedIn: 'yes',
    auth: 'test',
    platform: { supported: 'yes', detail: 'linux x64' },
    usable: true,
    notes: [],
    ...extra,
  };
}

/** A missing agent report. */
export function missingAgentReport(adapter: AdapterName): AgentReport {
  return fakeAgentReport(adapter, {
    installed: false,
    path: null,
    onPath: false,
    launch: null,
    runnable: 'no',
    version: null,
    signedIn: 'unknown',
    auth: null,
    usable: false,
    notes: ['not found on PATH or in common install locations'],
  });
}

export function fakeContext(
  o: {
    home?: string;
    api?: GitHubApi;
    isTTY?: boolean;
    prompter?: Prompter;
    env?: NodeJS.ProcessEnv;
    /** Discovery results; defaults to every known adapter usable. */
    agents?: AgentReport[];
  } = {},
): CommandContext & { out: MemoryOutput; err: MemoryOutput } {
  const home = o.home ?? tempHome();
  const env = { ...o.env, FACTORY_HOME: home };
  return {
    paths: resolvePaths({ env }),
    env,
    out: new MemoryOutput(),
    err: new MemoryOutput(),
    isTTY: o.isTTY ?? false,
    createApi: async () => {
      if (!o.api) throw new Error('no api in this test');
      return o.api;
    },
    prompter: () => {
      if (!o.prompter) throw new Error('no prompter in this test');
      return o.prompter;
    },
    openDb: () => {
      throw new Error('no db in this test');
    },
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    discoverAgents: async (opts) => {
      const all = o.agents ?? KNOWN_ADAPTERS.map((a) => fakeAgentReport(a));
      return opts?.adapters ? all.filter((r) => opts.adapters!.includes(r.adapter)) : all;
    },
  };
}
