import { describe, expect, it } from 'vitest';
import { hasChanges, lineDiff, MAX_DIFF_CELLS } from './diff';

describe('lineDiff', () => {
  it('marks unchanged, removed and added lines in order', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
  });

  it('diffs against nothing: a new file is all added, a removed one all removed', () => {
    expect(lineDiff('', 'x\ny')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
    expect(lineDiff('x', '')).toEqual([{ kind: 'del', text: 'x' }]);
    expect(hasChanges(lineDiff('same\n', 'same'))).toBe(false);
  });

  it('keeps the common head and tail even for inputs too large to align', () => {
    const n = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10;
    const old = ['top', ...Array.from({ length: n }, (_, i) => `old ${i}`), 'bottom'].join('\n');
    const next = ['top', ...Array.from({ length: n }, (_, i) => `new ${i}`), 'bottom'].join('\n');
    const d = lineDiff(old, next);
    expect(d[0]).toEqual({ kind: 'same', text: 'top' });
    expect(d.at(-1)).toEqual({ kind: 'same', text: 'bottom' });
    expect(d.filter((l) => l.kind === 'del')).toHaveLength(n);
    expect(d.filter((l) => l.kind === 'add')).toHaveLength(n);
  });
});
