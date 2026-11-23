import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, MissingConfigError } from '../config/io.js';
import { GitHubError } from '../github/api.js';
import { WorkerLockedError } from '../worker/daemon.js';
import type { CommandContext } from './context.js';
import { EXIT } from './errors.js';
import { fakeContext } from './fakes.js';
import { buildProgram, type Handlers } from './program.js';

function setup(handlers: Partial<Handlers> = {}) {
  const ctx = fakeContext();
  const globals: Array<{ config?: string }> = [];
  const codes: number[] = [];
  const program = buildProgram({
    version: '9.9.9',
    context: (g) => {
      globals.push(g);
      return ctx;
    },
    handlers,
    setExitCode: (c) => codes.push(c),
  });
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const c of program.commands) {
    c.exitOverride();
    c.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  }
  const parse = (...args: string[]) => program.parseAsync(['node', 'updraft', ...args]);
  return { ctx, globals, codes, parse };
}

describe('commander wiring', () => {
  it('parses state merge and state info, and passes their exit codes on', async () => {
    const stateMerge = vi.fn(async () => 5);
    const stateInfo = vi.fn(async () => 0);
    const { parse, codes } = setup({ stateMerge, stateInfo });
    await parse('state', 'merge', '--changed', 'run.db', '--into', 'shared.db', '--base', 'snapshot.db', '--json');
    expect(stateMerge).toHaveBeenCalledWith(expect.anything(), { changed: 'run.db', into: 'shared.db', base: 'snapshot.db', json: true });
    await parse('state', 'merge', '--changed', 'run.db', '--into', 'shared.db');
    expect(stateMerge).toHaveBeenLastCalledWith(expect.anything(), { changed: 'run.db', into: 'shared.db' });
    await parse('state', 'info', '--db', 'shared.db', '--json');
    expect(stateInfo).toHaveBeenCalledWith(expect.anything(), { db: 'shared.db', json: true });
    expect(codes).toEqual([5, 5, 0]);
  });

  it('parses add with defaults and repeatable routes', async () => {
    const add = vi.fn(async () => 0);
    const { parse, codes } = setup({ add });
    await parse('add', 'o/r', '--route', 'art=art', '--route', 'ui=design', '--backfill-since', '2025-01-01', '--workflow-id', 'impl');
    expect(add).toHaveBeenCalledWith(expect.anything(), 'o/r', {
      label: 'ready',
      action: 'implement-issue',
      pool: 'general',
      route: ['art=art', 'ui=design'],
      backfillSince: '2025-01-01',
      workflowId: 'impl',
    });
    expect(codes).toEqual([0]);
  });

  it('passes --config (before or after the subcommand) to the context updraft', async () => {
    const validate = vi.fn(async () => 0);
    const { parse, globals } = setup({ validate });
    await parse('-c', 'a.yaml', 'validate');
    await parse('validate', '--config', 'b.yaml');
    expect(globals.map((g) => g.config)).toEqual(['a.yaml', 'b.yaml']);
  });

  it('parses status/doctor --json, retry and the argument-less commands', async () => {
    const h = {
      status: vi.fn(async () => 0),
      doctor: vi.fn(async (_ctx: unknown, _o: { json?: boolean }) => 1),
      retry: vi.fn(async () => 0),
      start: vi.fn(async () => 0),
      configure: vi.fn(async () => 0),
    };
    const { parse, codes } = setup(h);
    await parse('status', '--json');
    await parse('doctor');
    await parse('retry', 'job_abc');
    await parse('start');
    await parse('configure');
    expect(h.status).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ json: true }));
    expect(h.doctor.mock.calls[0]?.[1]).not.toHaveProperty('json', true);
    expect(h.retry).toHaveBeenCalledWith(expect.anything(), 'job_abc');
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.configure).toHaveBeenCalledOnce();
    expect(codes).toEqual([0, 1, 0, 0, 0]);
  });

  it('parses stats with its 30-day default, --since, --repo and --json', async () => {
    const stats = vi.fn(async (_ctx: unknown, _o: { json?: boolean; since?: string; repo?: string }) => 0);
    const { parse, codes } = setup({ stats });
    await parse('stats');
    await parse('stats', '--json', '--since', 'all', '--repo', 'octo/widgets');
    expect(stats.mock.calls[0]?.[1]).toEqual({ since: '30d' });
    expect(stats.mock.calls[1]?.[1]).toEqual({ json: true, since: 'all', repo: 'octo/widgets' });
    expect(codes).toEqual([0, 0]);
  });

  it('parses clean with and without --dry-run', async () => {
    const clean = vi.fn(async (_ctx: unknown, _o: { dryRun?: boolean }) => 0);
    const { parse, codes } = setup({ clean });
    await parse('clean', '--dry-run');
    await parse('clean');
    expect(clean.mock.calls[0]?.[1]).toEqual({ dryRun: true });
    expect(clean.mock.calls[1]?.[1]).not.toHaveProperty('dryRun', true);
    expect(codes).toEqual([0, 0]);
  });

  it('parses clean --older-than, cancel, and logs with its flags', async () => {
    const h = {
      clean: vi.fn(async (_ctx: unknown, _o: { dryRun?: boolean; olderThan?: string }) => 0),
      cancel: vi.fn(async () => 1),
      logs: vi.fn(async (_ctx: unknown, _id: string, _o: { follow?: boolean; path?: boolean }) => 0),
    };
    const { parse, codes } = setup(h);
    await parse('clean', '--older-than', '30d', '--dry-run');
    await parse('cancel', 'job_abc');
    await parse('logs', 'run_abc');
    await parse('logs', 'job_abc', '--follow');
    await parse('logs', '-f', '--path', 'job_abc');
    expect(h.clean.mock.calls[0]?.[1]).toEqual({ olderThan: '30d', dryRun: true });
    expect(h.cancel).toHaveBeenCalledWith(expect.anything(), 'job_abc');
    expect(h.logs.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['run_abc', {}],
      ['job_abc', { follow: true }],
      ['job_abc', { follow: true, path: true }],
    ]);
    expect(codes).toEqual([0, 1, 0, 0, 0]);
    await expect(parse('cancel')).rejects.toMatchObject({ code: 'commander.missingArgument' });
    await expect(parse('logs')).rejects.toMatchObject({ code: 'commander.missingArgument' });
  });

  it('parses reviews with --json and --limit', async () => {
    const reviews = vi.fn(async (_ctx: unknown, _o: { json?: boolean; limit?: string }) => 0);
    const { parse, codes } = setup({ reviews });
    await parse('reviews');
    await parse('reviews', '--json', '--limit', '5');
    expect(reviews.mock.calls[0]?.[1]).toEqual({ limit: '20' });
    expect(reviews.mock.calls[1]?.[1]).toEqual({ json: true, limit: '5' });
    expect(codes).toEqual([0, 0]);
  });

  it('routes native-claude-auth to the sanitized worker auth probe', async () => {
    const nativeClaudeAuth = vi.fn(async () => 0);
    const { parse, codes } = setup({ nativeClaudeAuth });
    await parse('native-claude-auth', '--json');
    expect(nativeClaudeAuth).toHaveBeenCalledWith(expect.anything(), { json: true });
    expect(codes).toEqual([0]);
  });

  it('parses agents --json --deep', async () => {
    const agents = vi.fn(async (_ctx: unknown, _o: { json?: boolean; deep?: boolean }) => 0);
    const { parse } = setup({ agents });
    await parse('agents');
    await parse('agents', '--json', '--deep');
    expect(agents.mock.calls[0]?.[1]).toEqual({});
    expect(agents.mock.calls[1]?.[1]).toEqual({ json: true, deep: true });
  });

  it('rejects a missing argument and prints the version', async () => {
    const { parse } = setup();
    await expect(parse('add')).rejects.toMatchObject({ code: 'commander.missingArgument' });
    await expect(parse('--version')).rejects.toMatchObject({ code: 'commander.version' });
  });

  it.each([
    [new ConfigError('No config at /x'), EXIT.FAILURE, /No config at \/x/],
    [new GitHubError('Bad credentials', 401), EXIT.FAILURE, /gh auth login/],
    [new GitHubError('Repository o/r', 404), EXIT.FAILURE, /cannot access it/],
    [new WorkerLockedError({ workerId: 'w', pid: 7, hostname: 'h', heartbeatAt: 't' }), EXIT.LOCKED, /pid 7 on h/],
    [new Error('boom'), EXIT.FAILURE, /boom/],
  ])('maps %s to a friendly message', async (err, code, re) => {
    const { parse, codes, ctx } = setup({ start: async () => Promise.reject(err) });
    await parse('start');
    expect(codes).toEqual([code]);
    expect(ctx.err.text).toMatch(/^error: /);
    expect(ctx.err.text).toMatch(re);
  });
});

describe('default context', () => {
  it('resolves --config into paths', async () => {
    const { createDefaultContext } = await import('./context.js');
    const ctx: CommandContext = createDefaultContext({ config: 'some/dir/cfg.yaml' });
    expect(ctx.paths.configFile).toBe(resolve('some/dir/cfg.yaml'));
  });
});

describe('legacy install notice', () => {
  const legacy = { configFile: resolve('/old/updraft/config.yaml'), dataDir: resolve('/old/state/updraft') };

  it('follows a missing-config error when an earlier install is still in the per-OS folders', async () => {
    const { parse, ctx } = setup({ validate: async () => { throw new MissingConfigError('/x/config.yaml'); } });
    ctx.findLegacyInstall = () => legacy;
    await parse('validate');
    expect(ctx.err.text).toContain(`UPDRAFT_CONFIG=${legacy.configFile}`);
    expect(ctx.err.text).toContain(`UPDRAFT_HOME=${legacy.dataDir}`);
  });

  it('is not shown for other config errors', async () => {
    const { parse, ctx } = setup({ validate: async () => { throw new ConfigError('Invalid config /x'); } });
    ctx.findLegacyInstall = () => legacy;
    await parse('validate');
    expect(ctx.err.text).not.toContain('UPDRAFT_CONFIG=');
  });
});
