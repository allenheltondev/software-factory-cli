import { describe, expect, it } from 'vitest';
import type { StructuredFinding } from '../agents/findings.js';
import { anchorFinding, commentableLines, diffIndex } from './anchors.js';

const PATCH = ['@@ -1,4 +1,5 @@', ' keep1', '-gone2', '+new2', '+new3', ' keep3', '\\ No newline at end of file', '@@ -20,2 +21,2 @@', ' ctx20', '-old21', '+new22'].join('\n');

const finding = (location: StructuredFinding['location'], path: string | null = location?.path ?? null): StructuredFinding => ({
  id: 'F1',
  severity: 'blocker',
  title: 't',
  problem: 'p',
  suggestion: null,
  path,
  location,
  sameAs: null,
  notes: [],
});

describe('commentableLines', () => {
  it('numbers added and context lines on the right, removed and context lines on the left, by hunk', () => {
    const { right, left } = commentableLines(PATCH);
    expect([...right]).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [21, 1],
      [22, 1],
    ]);
    expect([...left]).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [20, 1],
      [21, 1],
    ]);
  });
});

describe('anchorFinding', () => {
  const diff = diffIndex([
    { path: 'src/a.ts', status: 'modified', patch: PATCH },
    { path: 'logo.png', status: 'added', patch: null },
  ]);
  it('attaches a line or a range that is in one hunk of the diff', () => {
    expect(anchorFinding(finding({ path: 'src/a.ts', line: 3, startLine: null, side: 'RIGHT' }), diff).ok).toBe(true);
    expect(anchorFinding(finding({ path: 'src/a.ts', line: 3, startLine: 1, side: 'RIGHT' }), diff).ok).toBe(true);
    expect(anchorFinding(finding({ path: 'src/a.ts', line: 2, startLine: null, side: 'LEFT' }), diff).ok).toBe(true);
  });
  it('refuses what GitHub would refuse, and says why', () => {
    expect(anchorFinding(finding({ path: 'src/a.ts', line: 10, startLine: null, side: 'RIGHT' }), diff)).toEqual({ ok: false, reason: 'line 10 is not in the diff of this file' });
    expect(anchorFinding(finding({ path: 'src/a.ts', line: 22, startLine: 3, side: 'RIGHT' }), diff)).toMatchObject({ ok: false, reason: expect.stringMatching(/not in one part/) });
    expect(anchorFinding(finding({ path: 'src/b.ts', line: 1, startLine: null, side: 'RIGHT' }), diff)).toMatchObject({ ok: false, reason: expect.stringMatching(/not part of this pull request/) });
    expect(anchorFinding(finding({ path: 'logo.png', line: 1, startLine: null, side: 'RIGHT' }), diff)).toMatchObject({ ok: false, reason: expect.stringMatching(/binary or too large/) });
    expect(anchorFinding(finding(null, 'README.md'), diff)).toMatchObject({ ok: false, reason: 'no line in the diff was given' });
    expect(anchorFinding(finding(null), diff)).toMatchObject({ ok: false, reason: 'no file was given' });
  });
});
