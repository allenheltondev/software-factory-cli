import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanSummaryLines, readOutput } from './run-summary.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readOutput', () => {
  it('returns everything after the offset, or the last bytes from a line boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-output-'));
    dirs.push(dir);
    const file = join(dir, 'run.log');
    const header = 'header line\n';
    writeFileSync(file, `${header}{"a":1}\n{"b":2}\n`);
    expect(await readOutput(file, header.length, 1024)).toBe('{"a":1}\n{"b":2}\n');
    // Only the last 10 bytes: the cut first line is dropped.
    expect(await readOutput(file, header.length, 10)).toBe('{"b":2}\n');
    expect(await readOutput(join(dir, 'missing.log'), 0, 10)).toBe('');
  });
});

describe('cleanSummaryLines', () => {
  it('splits, strips control sequences and blank lines, and caps long lines', () => {
    expect(cleanSummaryLines(['a\r\nb', '', '\u001b[31mred\u001b[0m  ', 'x'.repeat(1200)])).toEqual(['a', 'b', 'red', `${'x'.repeat(999)}…`]);
  });

  it('keeps the first lines and the last (status) line when there are too many', () => {
    const lines = [...Array.from({ length: 100 }, (_, i) => `line ${i}`), 'status'];
    const out = cleanSummaryLines(lines);
    expect(out).toHaveLength(60);
    expect(out[0]).toBe('line 0');
    expect(out.at(-2)).toBe('… (42 more lines in run.log)');
    expect(out.at(-1)).toBe('status');
  });
});
