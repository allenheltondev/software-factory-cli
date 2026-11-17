import { describe, expect, it } from 'vitest';
import { agentHint, agentStatus, agentsCommand, renderAgents } from './agents.js';
import { EXIT } from './errors.js';
import { fakeAgentReport, fakeContext, missingAgentReport } from './fakes.js';

const windowsClaude = fakeAgentReport('claude', {
  name: 'Claude Code',
  path: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd',
  launch: { file: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', args: [] },
  version: '2.1.289',
  auth: 'claude.ai',
  platform: { supported: 'yes', detail: 'win32 x64 (Windows 10 1809+; x64/arm64)' },
});

describe('agentStatus / agentHint', () => {
  it('names the most fundamental problem first', () => {
    expect(agentStatus(missingAgentReport('kiro'))).toBe('missing');
    expect(agentStatus(fakeAgentReport('codex', { runnable: 'no', usable: false }))).toBe('not runnable');
    expect(agentStatus(fakeAgentReport('codex', { signedIn: 'no', usable: false }))).toBe('not signed in');
    expect(agentStatus(fakeAgentReport('codex', { platform: { supported: 'no', detail: '' }, signedIn: 'no' }))).toBe('unsupported here');
    expect(agentStatus(fakeAgentReport('codex', { deep: { ok: false, detail: 'x' } }))).toBe('prompt test failed');
    expect(agentHint(fakeAgentReport('codex', { signedIn: 'unknown', onPath: false }))).toBe('found, sign-in unknown · 1.0.0 · not on PATH');
  });
});

describe('factory agents', () => {
  it('renders path, shim launch target, version, sign-in, platform and notes', async () => {
    const ctx = fakeContext({ agents: [windowsClaude, missingAgentReport('kiro')] });
    expect(await agentsCommand(ctx)).toBe(EXIT.OK);
    const text = ctx.out.text;
    expect(text).toContain('✓ claude (Claude Code): ready');
    expect(text).toContain('path      C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd');
    expect(text).toMatch(/launch {4}"C:\\Users\\Jane Doe\\.*\\claude\.exe"\n/);
    expect(text).toContain('version   2.1.289');
    expect(text).toContain('signed in yes (claude.ai)');
    expect(text).toContain('✗ kiro (kiro): missing');
    expect(text).toContain('1 of 2 agent(s) usable here.');
    expect(ctx.err.text).toBe('');
  });

  it('prints JSON, warns before --deep, and fails when nothing is usable', async () => {
    const ctx = fakeContext({ agents: [missingAgentReport('kiro')] });
    expect(await agentsCommand(ctx, { json: true, deep: true })).toBe(EXIT.FAILURE);
    expect(JSON.parse(ctx.out.text).agents[0]).toMatchObject({ adapter: 'kiro', installed: false });
    expect(ctx.err.text).toMatch(/uses tokens/);
  });

  it('notes a Kiro CLI older than 3.0, or one whose version could not be read', async () => {
    const ctx = fakeContext({ agents: [fakeAgentReport('kiro', { version: '2.4.1', kiroV3: 'no' })] });
    expect(await agentsCommand(ctx)).toBe(EXIT.OK);
    expect(ctx.out.text).toContain(
      'note      Kiro CLI 2.4.1 is older than 3.0.0: factory starts Kiro with --v3, which needs Kiro CLI 3.0.0 or later, so live runs fail. Upgrade Kiro CLI, or add --v2 to agents.<name>.args',
    );
    expect(renderAgents([fakeAgentReport('kiro', { version: 'nightly', kiroV3: 'unknown' })])).toContain(
      'note      could not read a Kiro CLI version from "nightly"; factory starts Kiro with --v3, which needs Kiro CLI 3.0.0 or later',
    );
    expect(renderAgents([fakeAgentReport('kiro', { version: '3.0.0', kiroV3: 'yes' })])).not.toContain('note');
  });

  it('shows the prompt result in deep mode', () => {
    expect(renderAgents([fakeAgentReport('codex', { deep: { ok: true, detail: 'headless prompt succeeded' } })], true)).toContain(
      'prompt    ok (headless prompt succeeded)',
    );
  });
});
