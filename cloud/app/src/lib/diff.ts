/** One line of a line diff: unchanged, only in the new text, or only in the old one. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Above this many cells (old lines × new lines) the diff is the whole old text removed and the new added. */
export const MAX_DIFF_CELLS = 4_000_000;

const lines = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/**
 * A line diff of two texts by longest common subsequence: what a version's history shows. Small
 * inputs only (config files and prompts); beyond MAX_DIFF_CELLS it gives up on alignment.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = lines(a);
  const y = lines(b);
  // Common head and tail first: most edits touch a few lines of a long file.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const head: DiffLine[] = x.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = x.slice(endX).map((text) => ({ kind: 'same', text }));
  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);
  const n = mx.length;
  const m = my.length;

  if (n * m > MAX_DIFF_CELLS) {
    return [...head, ...mx.map((text): DiffLine => ({ kind: 'del', text })), ...my.map((text): DiffLine => ({ kind: 'add', text })), ...tail];
  }

  // lcs[i][j]: the LCS length of mx[i..] and my[j..], in one flat array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = mx[i] === my[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (mx[i] === my[j]) {
      middle.push({ kind: 'same', text: mx[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      middle.push({ kind: 'del', text: mx[i++]! });
    } else {
      middle.push({ kind: 'add', text: my[j++]! });
    }
  }
  while (i < n) middle.push({ kind: 'del', text: mx[i++]! });
  while (j < m) middle.push({ kind: 'add', text: my[j++]! });
  return [...head, ...middle, ...tail];
}

/** True when the diff changes anything. */
export const hasChanges = (d: DiffLine[]) => d.some((l) => l.kind !== 'same');
