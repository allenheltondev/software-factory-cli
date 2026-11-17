import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanSummaryLines, readLastLine, readOutput } from './run-summary.js';

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

describe('readLastLine', () => {
  it('returns the last non-blank line in full, however long, up to the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-lastline-'));
    dirs.push(dir);
    const file = join(dir, 'run.log');
    const header = 'header line\n';
    const long = `{"type":"result","result":"${'y'.repeat(300 * 1024)}"}`;
    writeFileSync(file, `${header}{"a":1}\r\n${long}\r\n\n  \n`);
    expect(await readLastLine(file, header.length, 1024 * 1024)).toBe(long);
    expect(await readLastLine(file, header.length, 1024)).toBeNull(); // longer than the cap

    writeFileSync(file, `${header}only line`);
    expect(await readLastLine(file, header.length, 1024)).toBe('only line'); // no line ending, stops at the offset
    writeFileSync(file, `${header}\n\n`);
    expect(await readLastLine(file, header.length, 1024)).toBeNull();
    expect(await readLastLine(join(dir, 'missing.log'), 0, 10)).toBeNull();
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
