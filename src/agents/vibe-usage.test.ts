import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeVibeUsage, recoverVibeExports, VIBE_EXPORT_PREFIX } from './vibe-usage.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'updraft-vibe-cleanup-'));
  roots.push(root);
  const makeExport = (run: string) => {
    const file = join(root, run, `${VIBE_EXPORT_PREFIX}abc123`);
    mkdirSync(join(file, 'session'), { recursive: true });
    writeFileSync(join(file, 'session', 'journal.jsonl'), 'private session contents');
    return file;
  };
  return { root, makeExport, log: { warn: vi.fn() } };
}

afterEach(() => {
  vi.mocked(fs.rm).mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Vibe export cleanup', () => {
  it('warns when bounded cleanup fails and retries the abandoned export at startup', async () => {
    const { root, makeExport, log } = fixture();
    const directory = makeExport('run_old');
    writeFileSync(join(directory, 'export.json'), JSON.stringify({ schema_version: 1, steps: 2 }));
    const remove = vi.mocked(fs.rm).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));
    await expect(consumeVibeUsage(directory, log)).resolves.toBe('vibe usage: {"modelSteps":2}');
    expect(remove).toHaveBeenCalledWith(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('startup cleanup will retry'), { directory, code: 'EBUSY' });
    expect(existsSync(directory)).toBe(true);
    await recoverVibeExports(root, (id) => id === 'run_old', log);
    expect(existsSync(directory)).toBe(false);
  });

  it('removes abandoned exports and preserves active runs and unrelated directories', async () => {
    const { root, makeExport, log } = fixture();
    const inactive = makeExport('run_old');
    const active = makeExport('run_active');
    const unrelated = join(root, 'run_old', `${VIBE_EXPORT_PREFIX}notes`);
    mkdirSync(unrelated);
    await recoverVibeExports(root, (id) => id === 'run_old', log);
    expect(existsSync(inactive)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
