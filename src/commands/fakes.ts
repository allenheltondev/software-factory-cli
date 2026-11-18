/**
 * In-memory fakes for command tests (GitHub API, context, output).
 * Kept tiny and dependency-free; not used at runtime.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewLoopApiStubs } from '../../test/review-loop-api-stubs.js';
import type { AgentReport } from '../agents/discovery.js';
import { KNOWN_ADAPTERS, type AdapterName } from '../config/schema.js';
import { GitHubError, type GitHubApi, type GitHubLabel, type GitHubRepo, type PullRequestDetails, type PullRequestReviewSummary } from '../github/api.js';
import { createUserCredentials, userIdentity } from '../github/credentials.js';
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
  /** Pull requests by "OWNER/REPO#N", for getPullRequest. */
  pulls?: Record<string, PullRequestDetails>;
  /** Reviews by "OWNER/REPO#N", oldest first, for listPullRequestReviews. */
  reviews?: Record<string, PullRequestReviewSummary[]>;
}

export function fakeApi(data: FakeApiData = {}): GitHubApi & { calls: string[] } {
  const calls: string[] = [];
  const all = [...(data.repos ?? []), ...(data.publicRepos ?? [])];
  return {
    ...new ReviewLoopApiStubs(),
    calls,
    async getViewer() {
      calls.push('getViewer');
      return { login: data.login ?? 'octocat', id: 1 };
    },
    async getWorkerIdentity() {
      calls.push('getWorkerIdentity');
      return userIdentity({ login: data.login ?? 'octocat', id: 1 });
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
    async listEventsForIssue() {
      throw new Error('not used');
    },
    async getIssueBodyEdit() {
      throw new Error('not used');
    },
    async listPullRequestsForHead() {
      throw new Error('not used');
    },
    async listPullRequestUpdates() {
      throw new Error('not used');
    },
    async getPullRequestReviews() {
      throw new Error('not used');
    },
    async createPullRequest() {
      throw new Error('not used');
    },
    async listIssueComments() {
      throw new Error('not used');
    },
    async createIssueComment() {
      throw new Error('not used');
    },
    async getPullRequest(repo, n) {
      calls.push(`getPullRequest ${repo.fullName}#${n}`);
      const pr = data.pulls?.[`${repo.fullName}#${n}`];
      if (!pr) throw new GitHubError(`Pull request ${repo.fullName}#${n}`, 404);
      return pr;
    },
    async listPullRequestReviews(repo, n) {
      calls.push(`listPullRequestReviews ${repo.fullName}#${n}`);
      return data.reviews?.[`${repo.fullName}#${n}`] ?? [];
    },
  };
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'updraft-cmd-'));
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
  const env = { ...o.env, UPDRAFT_HOME: home };
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
    createCredentials: () => createUserCredentials(async () => 'fake-token'),
    prompter: () => {
      if (!o.prompter) throw new Error('no prompter in this test');
      return o.prompter;
    },
    openDb: () => {
      throw new Error('no db in this test');
    },
    openDbReadOnly: () => {
      throw new Error('no db in this test');
    },
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    discoverAgents: async (opts) => {
      const all = o.agents ?? KNOWN_ADAPTERS.map((a) => fakeAgentReport(a));
      return opts?.adapters ? all.filter((r) => opts.adapters!.includes(r.adapter)) : all;
    },
  };
}

/** A hand-edited config with comments, blank lines and mixed styles, shared by save round-trip tests. */
export const COMMENTED_CONFIG = `# Updraft config, edited by hand
version: 1

# Poll every two minutes; rate limits are tight.
pollIntervalSeconds: 120
maxConcurrent: 2

dispatch:
  allowedActors:
    - allen # me
    - "bot-user"

agents:
  # Codex is flaky right now
  codex:
    enabled: false
  claude: {} # defaults are fine
  kiro:
    maxConcurrent: 1

pools:
  general:
    agents: [claude, kiro]
  art:
    agents: [kiro]

actions:
  implement-issue:
    prompt: ./prompts/implement-issue.md # starter prompt

repositories:
  # The main app
  o/app:
    id: 1
    baseBranch: main # release branch later
    workflows:
      - trigger:
          event: issue.labeled
          label: updraft:ready
        action: implement-issue
        pool: general # default pool
      # Old experiment, to be removed
      - id: old
        trigger: {event: issue.labeled, label: try-me}
        action: implement-issue
        pool: art
`;
