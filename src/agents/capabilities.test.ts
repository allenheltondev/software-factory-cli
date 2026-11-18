import { describe, expect, it } from 'vitest';
import { checkCapabilities, helpAdvertises, readHelp } from './capabilities.js';
import { agentProfile } from './profile.js';

const CLAUDE_HELP = `Options:\n  --effort <level>   Effort level\n  --model <model>    Model\n`;
const CODEX_HELP = `Options:\n  -c, --config <key=value>\n  -m, --model <MODEL>\n`;
const KIRO_HELP = `Options:\n      --model <MODEL>   Model\n      --effort <LEVEL>  Effort\n`;

describe('helpAdvertises', () => {
  it('matches whole option names only', () => {
    expect(helpAdvertises(CLAUDE_HELP, '--effort')).toBe(true);
    expect(helpAdvertises('  --effort-level <x>', '--effort')).toBe(false);
    expect(helpAdvertises('  -m, --model <MODEL>', '--model')).toBe(true);
  });
});

describe('checkCapabilities', () => {
  const p = (adapter: string, a: { model?: string; effort?: string; args?: string[] }) => agentProfile(adapter, a);

  it('is ok when the help advertises the options', () => {
    expect(checkCapabilities('claude', p('claude', { model: 'x', effort: 'low' }), CLAUDE_HELP).state).toBe('ok');
    expect(checkCapabilities('codex', p('codex', { model: 'x', effort: 'low' }), CODEX_HELP).state).toBe('ok');
    expect(checkCapabilities('kiro', p('kiro', { model: 'x', effort: 'low' }), KIRO_HELP).state).toBe('ok');
  });

  it('reports an option the CLI does not advertise, with a remedy', () => {
    const r = checkCapabilities('kiro', p('kiro', { effort: 'high' }), '  --model <MODEL>\n');
    expect(r.state).toBe('unsupported');
    expect(r.messages[0]).toMatch(/does not advertise --effort/);
    expect(r.messages[0]).toMatch(/remove effort/);
  });

  it('checks args-sourced settings too', () => {
    expect(checkCapabilities('claude', p('claude', { args: ['--effort', 'low'] }), '  --model <m>').state).toBe('unsupported');
  });

  it('is unverified, not ok, when the help cannot be read', () => {
    const r = checkCapabilities('claude', p('claude', { model: 'x' }), null);
    expect(r.state).toBe('unverified');
    expect(r.messages[0]).toMatch(/unverified/);
  });

  it('needs nothing when no model or effort is set', () => {
    expect(checkCapabilities('claude', p('claude', {}), null)).toEqual({ state: 'ok', messages: [] });
  });
});

describe('readHelp', () => {
  it('runs only the help command and returns its text', async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: KIRO_HELP, stderr: '' };
    };
    expect(await readHelp('kiro', { file: 'kiro-cli', args: [] }, run)).toBe(`${KIRO_HELP}\n`);
    expect(calls).toEqual([['kiro-cli', 'chat', '--help']]);
  });

  it('returns null when the CLI is missing, fails or throws', async () => {
    expect(await readHelp('claude', null, async () => ({ code: 0, stdout: 'x', stderr: '' }))).toBeNull();
    expect(await readHelp('claude', { file: 'c', args: [] }, async () => ({ code: 1, stdout: '', stderr: 'no' }))).toBeNull();
    expect(await readHelp('claude', { file: 'c', args: [] }, async () => { throw new Error('boom'); })).toBeNull();
  });
});