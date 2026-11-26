import { describe, expect, it, vi } from 'vitest';
import { reconcileSessions } from './reconcile-sessions.js';

describe('per-provider session reconciliation (#125)', () => {
  it('runs Codex\'s cleanup even when Claude\'s throws, and Claude\'s when Codex\'s does, logging each error', async () => {
    for (const failing of ['claude', 'codex'] as const) {
      const log = vi.fn();
      const claude = vi.fn(async () => { if (failing === 'claude') throw Object.assign(new Error('registry read timed out'), { name: 'TimeoutError' }); return { released: 1, failed: 0 }; });
      const codex = vi.fn(async () => { if (failing === 'codex') throw new Error('codex boom'); return { released: 2, failed: 0 }; });
      const { reports, failures } = await reconcileSessions([{ provider: 'claude', reconcile: claude }, { provider: 'codex', reconcile: codex }], log);
      expect(claude).toHaveBeenCalledOnce();
      expect(codex).toHaveBeenCalledOnce();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(new RegExp(`^${failing}: `));
      expect(reports[failing]).toEqual({ released: 0, failed: 1 });
      expect(reports[failing === 'claude' ? 'codex' : 'claude']?.failed).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ sessionReconcile: 'failed', provider: failing, message: expect.stringMatching(/timed out|boom/) }));
    }
  });
  it('reports a provider\'s failed sessions and skips one not deployed', async () => {
    const { reports, failures } = await reconcileSessions([{ provider: 'claude', reconcile: async () => ({ released: 0, failed: 2 }) }, { provider: 'codex' }], vi.fn());
    expect(failures).toEqual(['claude: 2 session(s)']);
    expect(reports).toEqual({ claude: { released: 0, failed: 2 } });
  });
});
