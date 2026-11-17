import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../config/io.js';
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
  const parse = (...args: string[]) => program.parseAsync(['node', 'factory', ...args]);
  return { ctx, globals, codes, parse };
}

describe('commander wiring', () => {
  it('parses add with defaults and repeatable routes', async () => {
    const add = vi.fn(async () => 0);
    const { parse, codes } = setup({ add });
    await parse('add', 'o/r', '--route', 'art=art', '--route', 'ui=design', '--backfill-since', '2025-01-01', '--workflow-id', 'impl');
    expect(add).toHaveBeenCalledWith(expect.anything(), 'o/r', {
      label: 'factory:ready',
      action: 'implement-issue',
      pool: 'general',
      route: ['art=art', 'ui=design'],
      backfillSince: '2025-01-01',
      workflowId: 'impl',
    });
    expect(codes).toEqual([0]);
  });

  it('passes --config (before or after the subcommand) to the context factory', async () => {
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
