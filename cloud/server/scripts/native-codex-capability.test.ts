import { describe, expect, it, vi } from 'vitest';
import { ensureCodexCapability } from './native-codex-capability.js';

function deps(overrides: Partial<Parameters<typeof ensureCodexCapability>[0]> = {}) {
  const lines: string[] = [];
  const summary: string[] = [];
  const record = vi.fn(async () => {});
  const smoke = vi.fn(async () => {});
  return { lines, summary, record, smoke, d: { has: async () => false, smoke, record, log: (l: string) => lines.push(l), summary: (l: string) => summary.push(l), ...overrides } };
}

describe('Codex on a verified subscription image (#125)', () => {
  it('records Codex only after its session smoke passes', async () => {
    const t = deps();
    expect(await ensureCodexCapability(t.d, '12', '0.172.0')).toBe('recorded');
    expect(t.smoke).toHaveBeenCalledWith('12');
    expect(t.record).toHaveBeenCalledWith('12');
    expect(t.summary[0]).toMatch(/Codex 0\.172\.0 verified on subscription worker image 12/);
  });

  it('never fails the Claude rollout on a Codex smoke failure: no record, a warning and a summary line', async () => {
    const t = deps();
    t.smoke.mockRejectedValueOnce(new Error('Codex sign-in smoke failed for version 12: the Codex worker did not serve its sign-in route'));
    await expect(ensureCodexCapability(t.d, '12', '0.172.0')).resolves.toBe('failed');
    expect(t.record).not.toHaveBeenCalled();
    expect(t.lines.some((l) => l.startsWith('::warning title=Codex not enabled on image 12::') && l.includes('did not serve its sign-in route'))).toBe(true);
    expect(t.summary).toEqual([expect.stringContaining('Codex was NOT enabled on subscription worker image 12')]);
  });

  it('treats a failed capability read or write the same way, and skips a version already recorded', async () => {
    const failing = deps({ has: async () => { throw new Error('AccessDenied'); } });
    expect(await ensureCodexCapability(failing.d, '12', '0.172.0')).toBe('failed');
    expect(failing.smoke).not.toHaveBeenCalled();
    const write = deps();
    write.record.mockRejectedValueOnce(new Error('throttled'));
    expect(await ensureCodexCapability(write.d, '12', '0.172.0')).toBe('failed');
    const present = deps({ has: async () => true });
    expect(await ensureCodexCapability(present.d, '12', '0.172.0')).toBe('present');
    expect(present.smoke).not.toHaveBeenCalled();
  });
});
