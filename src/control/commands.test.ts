import { describe, expect, it } from 'vitest';
import { controlHelp, controlPolicy, controlReply, isAutomatedComment, MAX_CONTROL_TEXT, parseControlComment, repoPermissionOf } from './commands.js';

const H = ['updraft-app[bot]'];

describe('parseControlComment', () => {
  it('reads a command at the start of a line, with the App slug or its bot login', () => {
    expect(parseControlComment('@updraft-app resume', H)).toMatchObject({ kind: 'command', command: 'resume', text: '' });
    expect(parseControlComment('@Updraft-App[bot] PAUSE', H)).toMatchObject({ kind: 'command', command: 'pause' });
    expect(parseControlComment('Thanks!\n\n  @updraft-app review', H)).toMatchObject({ kind: 'command', command: 'review' });
  });

  it('keeps what follows the command as text, separators removed', () => {
    expect(parseControlComment('@updraft-app resume — I fixed the failing test; review the latest commit again.', H)).toMatchObject({
      command: 'resume', text: 'I fixed the failing test; review the latest commit again.',
    });
    expect(parseControlComment('@updraft-app steer: keep the API\nand add a regression test.', H)).toMatchObject({
      command: 'steer', text: 'keep the API\nand add a regression test.',
    });
  });

  it('ignores mentions inside sentences, quotations, code and HTML comments', () => {
    for (const body of [
      'Please ask @updraft-app resume later',
      '> @updraft-app stop',
      '```\n@updraft-app stop\n```',
      '~~~md\n@updraft-app cancel\n~~~',
      'text\n\n    @updraft-app stop',
      '`@updraft-app stop`',
      '<!-- @updraft-app stop -->',
      '<!--\n@updraft-app stop\n-->',
      '@updraft-apps stop',
    ]) expect(parseControlComment(body, H), body).toEqual({ kind: 'none' });
  });

  it('answers a bare mention, an unknown word or several commands with help, never an action', () => {
    expect(parseControlComment('@updraft-app', H)).toMatchObject({ kind: 'unrecognized', reason: 'bare_mention' });
    expect(parseControlComment('@updraft-app please merge this', H)).toMatchObject({ kind: 'unrecognized', reason: 'unknown_command', word: 'please' });
    expect(parseControlComment('@updraft-app pause\n@updraft-app resume', H)).toMatchObject({ kind: 'unrecognized', reason: 'several_commands' });
  });

  it('names a stop target only from an id right after the word', () => {
    expect(parseControlComment('@updraft-app stop job_abcdefghijklmnop', H)).toMatchObject({ command: 'stop', target: 'job_abcdefghijklmnop' });
    expect(parseControlComment('@updraft-app stop now please', H)).toMatchObject({ command: 'stop', target: null });
    expect(parseControlComment('@updraft-app resume job_abcdefghijklmnop', H)).toMatchObject({ command: 'resume', target: null });
  });

  it('caps the text', () => {
    const parsed = parseControlComment(`@updraft-app steer ${'x'.repeat(MAX_CONTROL_TEXT + 10)}`, H);
    expect(parsed).toMatchObject({ kind: 'command', truncated: true });
    expect(parsed.kind === 'command' && parsed.text.length).toBe(MAX_CONTROL_TEXT);
  });

  it('reads nothing without a handle', () => {
    expect(parseControlComment('@updraft-app stop', [])).toEqual({ kind: 'none' });
  });
});

describe('controlPolicy', () => {
  const base = { body: '@updraft-app pause', ownLogins: ['updraft-app'], allowedActors: ['Alice'] };
  it('allows an allowed actor with write access to pause, resume, review and steer', () => {
    for (const command of ['pause', 'resume', 'review', 'steer'] as const) {
      expect(controlPolicy({ ...base, command, actor: { login: 'alice' }, permission: 'write' })).toEqual({ allowed: true });
    }
  });

  it('ignores bots, the worker and Updraft’s own comments without a reply', () => {
    expect(controlPolicy({ ...base, command: 'stop', actor: { login: 'dependabot[bot]' }, permission: 'admin' })).toMatchObject({ respond: 'ignore' });
    expect(controlPolicy({ ...base, command: 'stop', actor: { login: 'helper', type: 'Bot' }, permission: 'admin' })).toMatchObject({ respond: 'ignore' });
    expect(controlPolicy({ ...base, command: 'stop', actor: { login: 'updraft-app[bot]' }, permission: 'admin' })).toMatchObject({ respond: 'ignore' });
    expect(controlPolicy({ ...base, allowedActors: ['alice'], body: '<!-- updraft-run-details -->\n@updraft-app stop', command: 'stop', actor: { login: 'alice' }, permission: 'admin' }))
      .toMatchObject({ respond: 'ignore' });
  });

  it('refuses someone not allowed, whatever their GitHub access', () => {
    expect(controlPolicy({ ...base, command: 'pause', actor: { login: 'mallory' }, permission: 'admin' })).toMatchObject({ respond: 'refuse', reason: 'not_allowed' });
  });

  it('fails closed on an unknown permission and needs write', () => {
    expect(controlPolicy({ ...base, command: 'pause', actor: { login: 'alice' }, permission: null })).toMatchObject({ reason: 'permission_unknown' });
    expect(controlPolicy({ ...base, command: 'pause', actor: { login: 'alice' }, permission: 'triage' })).toMatchObject({ reason: 'needs_write' });
  });

  it('needs maintain for destructive commands and elevated resumes', () => {
    expect(controlPolicy({ ...base, command: 'stop', actor: { login: 'alice' }, permission: 'write' })).toMatchObject({ reason: 'needs_maintain' });
    expect(controlPolicy({ ...base, command: 'cancel', actor: { login: 'alice' }, permission: 'write' })).toMatchObject({ reason: 'needs_maintain' });
    expect(controlPolicy({ ...base, command: 'resume', elevated: true, actor: { login: 'alice' }, permission: 'write' })).toMatchObject({ reason: 'needs_maintain' });
    expect(controlPolicy({ ...base, command: 'stop', actor: { login: 'alice' }, permission: 'maintain' })).toEqual({ allowed: true });
  });
});

describe('helpers', () => {
  it('normalizes GitHub permissions', () => {
    expect(repoPermissionOf({ permission: 'write', role_name: 'maintain' })).toBe('maintain');
    expect(repoPermissionOf({ permission: 'admin' })).toBe('admin');
    expect(repoPermissionOf({ permission: 'weird' })).toBeNull();
    expect(repoPermissionOf(null)).toBeNull();
  });

  it('marks replies so they are never commands', () => {
    const reply = controlReply(42, '@updraft-app stop');
    expect(isAutomatedComment({ login: 'alice' }, reply, [])).toBe(true);
  });

  it('shows the real handle in help', () => {
    expect(controlHelp('updraft-app[bot]', { unsupported: ['escalate'] })).toContain('`@updraft-app resume`');
    expect(controlHelp('updraft-app')).not.toContain('not available');
    expect(controlHelp('x', { unsupported: ['escalate'] })).toContain('escalate`: ask for a more capable tier on the next run, within the configured policy (not available here yet)');
  });
});
