import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, formatConsoleLine, resolveColor } from './log.js';

const at = new Date(2026, 0, 2, 14, 32, 8);
const ESC = String.fromCharCode(27);
const stripAnsi = (s: string) => s.split(ESC).map((p, i) => (i === 0 ? p : p.replace(/^\[[0-9;]*m/, ''))).join('');

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const stream = { write: (s: string) => lines.push(s), isTTY: false } as unknown as NodeJS.WritableStream;
  return { lines, log: createLogger({ stream, env: {}, ...opts }) };
}

describe('formatConsoleLine', () => {
  it('lays out time, level, scope, message, then fields', () => {
    const l = formatConsoleLine(at, 'info', 'job queued', { repo: 'o/app', job: 'job_1', issue: 39, pool: 'general' }, false);
    expect(l).toMatch(/^14:32:08 {2}INFO {3}\[job:job_1\] +job queued {2}issue=39 pool=general repo=o\/app\n$/);
  });

  it('uses nested child context for the scope', () => {
    const { lines, log } = capture();
    log.child({ component: 'poller' }).child({ repo: 'o/app' }).info('hello');
    expect(lines[0]).toMatch(/\[repo:o\/app\] +hello {2}component=poller\n$/);
    const b = capture();
    b.log.info('plain');
    expect(b.lines[0]).toMatch(/\[worker\] +plain\n$/);
  });

  it('colors level and lifecycle words only when enabled', () => {
    const warn = formatConsoleLine(at, 'warn', 'retry scheduled', {}, true);
    expect(warn).toContain(`${ESC}[33mWARN ${ESC}[0m`);
    expect(warn).toContain(`${ESC}[33mretry${ESC}[0m`);
    expect(formatConsoleLine(at, 'error', 'run failed', {}, true)).toContain(`${ESC}[31mfailed${ESC}[0m`);
    expect(formatConsoleLine(at, 'info', 'job queued', {}, true)).toContain(`${ESC}[32mqueued${ESC}[0m`);
    expect(formatConsoleLine(at, 'debug', 'x', {}, true)).toContain(`${ESC}[2mDEBUG${ESC}[0m`);
    const plain = formatConsoleLine(at, 'error', 'run failed', { a: 1 }, false);
    expect(plain).not.toContain(ESC);
    expect(stripAnsi(formatConsoleLine(at, 'error', 'run failed', { a: 1 }, true))).toBe(plain);
  });

  it('quotes and escapes multiline values and messages', () => {
    const l = formatConsoleLine(at, 'error', 'bad\nINFO fake', { error: 'a\nb "c"', path: 'C:\\Users\\jane\\repo', spaced: 'C:\\My Docs\\x' }, false);
    expect(l.trimEnd().split('\n')).toHaveLength(1);
    expect(l).toContain('bad\\nINFO fake');
    expect(l).toContain('path=C:\\Users\\jane\\repo');
    expect(l).toContain('spaced="C:\\My Docs\\x"');
    expect(l.endsWith('error="a\\nb \\"c\\""\n')).toBe(true);
  });

  it('truncates long values', () => {
    const l = formatConsoleLine(at, 'info', 'm', { big: 'x'.repeat(1000) }, false);
    expect(l.length).toBeLessThan(300);
    expect(l).toContain('chars)');
  });
});

describe('resolveColor', () => {
  const tty = { isTTY: true };
  it('colors a TTY and not a pipe', () => {
    expect(resolveColor(tty, {})).toBe(true);
    expect(resolveColor({ isTTY: false }, {})).toBe(false);
    expect(resolveColor({}, {})).toBe(false);
  });
  it('respects NO_COLOR, dumb terminals and CI', () => {
    expect(resolveColor(tty, { NO_COLOR: '1' })).toBe(false);
    expect(resolveColor(tty, { TERM: 'dumb' })).toBe(false);
    expect(resolveColor(tty, { CI: 'true' })).toBe(false);
  });
  it('allows explicit overrides', () => {
    expect(resolveColor({ isTTY: false }, { UPDRAFT_COLOR: 'always' })).toBe(true);
    expect(resolveColor(tty, { UPDRAFT_COLOR: 'never' })).toBe(false);
    expect(resolveColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(resolveColor(tty, { FORCE_COLOR: '0' })).toBe(false);
    expect(resolveColor(tty, { NO_COLOR: '1' }, true)).toBe(true);
    expect(resolveColor({ isTTY: false }, {}, false)).toBe(false);
  });
});

describe('createLogger', () => {
  it('writes no ANSI to a non-TTY stream and colors a TTY', () => {
    const a = capture();
    a.log.warn('retry');
    expect(a.lines[0]).not.toContain(ESC);
    const lines: string[] = [];
    const tty = { write: (s: string) => lines.push(s), isTTY: true } as unknown as NodeJS.WritableStream;
    createLogger({ stream: tty, env: {} }).warn('retry');
    expect(lines[0]).toContain(`${ESC}[33m`);
  });

  it('filters by level and reads UPDRAFT_LOG_LEVEL', () => {
    const a = capture();
    a.log.debug('hidden');
    expect(a.lines).toHaveLength(0);
    const b = capture({ env: { UPDRAFT_LOG_LEVEL: 'debug' } });
    b.log.debug('shown');
    expect(b.lines).toHaveLength(1);
    const c = capture({ level: 'error' });
    c.log.warn('hidden');
    expect(c.lines).toHaveLength(0);
  });

  it('keeps the file as plain JSONL with unchanged fields', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'log-')), 'logs', 'updraft.log');
    const tty = { write: () => true, isTTY: true } as unknown as NodeJS.WritableStream;
    const log = createLogger({ stream: tty, file, env: {}, color: true });
    log.child({ repo: 'o/app' }).error('run failed\nline2', { job: 'job_1', path: 'C:\\x y' });
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(ESC);
    const rec = JSON.parse(raw.trim());
    expect(rec).toMatchObject({ level: 'error', msg: 'run failed\nline2', repo: 'o/app', job: 'job_1', path: 'C:\\x y' });
    expect(new Date(rec.at).toISOString()).toBe(rec.at);
  });
});
