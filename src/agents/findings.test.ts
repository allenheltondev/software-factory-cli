import { describe, expect, it } from 'vitest';
import { findingKey, MAX_STRUCTURED_FINDINGS, normalizePath, readStructuredFindings } from './findings.js';

const block = (data: unknown) => ['Prose before.', '', '```updraft-findings', JSON.stringify(data), '```', '', 'Prose after.'].join('\n');

describe('readStructuredFindings', () => {
  it('reads a legacy review (no block) as prose only', () => {
    expect(readStructuredFindings('- blocker: x is wrong (src/a.ts:3)')).toEqual({ prose: '- blocker: x is wrong (src/a.ts:3)', structured: null, problem: null });
  });

  it('reads findings and checks, and keeps the prose without the block', () => {
    const r = readStructuredFindings(
      block({
        findings: [
          { id: 'F1', severity: 'blocker', title: 'Race on retire', path: './src/pool.ts', line: 42, startLine: 40, problem: 'The generation is not checked.', suggestion: 'Check it.' },
          { id: 'F2', severity: 'suggestion', title: 'Name', problem: 'Rename x.', path: 'README.md' },
        ],
        checks: [{ finding: 'run_abc#F1', status: 'verified', note: 'Fixed and tested.' }],
      }),
    );
    expect(r.problem).toBeNull();
    expect(r.prose).toBe('Prose before.\n\n\nProse after.');
    expect(r.structured!.findings).toEqual([
      { id: 'F1', severity: 'blocker', title: 'Race on retire', problem: 'The generation is not checked.', suggestion: 'Check it.', path: 'src/pool.ts', location: { path: 'src/pool.ts', line: 42, startLine: 40, side: 'RIGHT' }, sameAs: null, notes: [] },
      { id: 'F2', severity: 'suggestion', title: 'Name', problem: 'Rename x.', suggestion: null, path: 'README.md', location: null, sameAs: null, notes: [] },
    ]);
    expect(r.structured!.checks).toEqual([{ finding: 'run_abc#F1', status: 'verified', note: 'Fixed and tested.' }]);
  });

  it('takes a bare list as the findings', () => {
    expect(readStructuredFindings(block([{ title: 'A' }])).structured!.findings.map((f) => f.id)).toEqual(['F1']);
  });

  it('never drops a finding for a bad location: it keeps it without the location, and says why', () => {
    const r = readStructuredFindings(
      block([
        { id: 'A', title: 'abs', path: '/etc/passwd', line: 1 },
        { id: 'B', title: 'escape', path: 'src/../../x', line: 1 },
        { id: 'C', title: 'line', path: 'src/a.ts', line: 'ten' },
        { id: 'D', title: 'range', path: 'src/a.ts', line: 3, startLine: 9 },
        { id: 'E', title: 'side', path: 'src/a.ts', line: 3, side: 'MIDDLE' },
      ]),
    );
    const f = r.structured!.findings;
    expect(f.map((x) => [x.id, x.path, x.location])).toEqual([
      ['A', null, null],
      ['B', null, null],
      ['C', 'src/a.ts', null],
      ['D', 'src/a.ts', null],
      ['E', 'src/a.ts', null],
    ]);
    for (const x of f) expect(x.notes.length).toBe(1);
  });

  it('treats an unknown severity as a blocker, and fixes ids that clash or are unusable', () => {
    const f = readStructuredFindings(block([{ id: 'X', title: 'a', severity: 'urgent' }, { id: 'X', title: 'b' }, { id: 'has space', title: 'c' }])).structured!.findings;
    expect(f.map((x) => [x.id, x.severity])).toEqual([
      ['X', 'blocker'],
      ['F2', 'blocker'],
      ['F3', 'blocker'],
    ]);
    expect(f[0]!.notes[0]).toMatch(/treated as a blocker/);
  });

  it('reads nothing structured from a broken or doubled block, and keeps all the text', () => {
    const broken = 'Before\n```updraft-findings\n{not json\n```';
    expect(readStructuredFindings(broken)).toEqual({ prose: broken, structured: null, problem: expect.stringMatching(/not valid JSON/) });
    const two = `${block([{ title: 'a' }])}\n${block([{ title: 'b' }])}`;
    expect(readStructuredFindings(two)).toMatchObject({ structured: null, problem: expect.stringMatching(/2 updraft-findings blocks/) });
    expect(readStructuredFindings(block({ findings: 'x' }))).toMatchObject({ structured: null, problem: expect.stringMatching(/not a list/) });
  });

  it('bounds what it reads', () => {
    const many = Array.from({ length: MAX_STRUCTURED_FINDINGS + 5 }, (_, i) => ({ title: `t${i}` }));
    const r = readStructuredFindings(block({ findings: many, checks: [{ finding: 'nope', status: 'verified' }, { finding: 'run_a#F1', status: 'maybe' }] }));
    expect(r.structured!.findings).toHaveLength(MAX_STRUCTURED_FINDINGS);
    expect(r.structured!.checks).toEqual([{ finding: 'run_a#F1', status: 'unresolved', note: '' }]);
    expect(r.structured!.omitted).toBe(6);
    const long = readStructuredFindings(block([{ title: 'x'.repeat(500), problem: '\u001b[31mred\u001b[0m' }])).structured!.findings[0]!;
    expect(long.title).toHaveLength(200);
    expect(long.problem).toBe('red');
  });

  it('keeps a repeated finding\'s earlier key, and refuses one that is not a key', () => {
    const f = readStructuredFindings(block([{ title: 'a', sameAs: 'run_1#F2' }, { title: 'b', sameAs: 'whatever' }])).structured!.findings;
    expect(f[0]!.sameAs).toBe('run_1#F2');
    expect(f[1]!.sameAs).toBeNull();
    expect(findingKey('run_1', 'F2')).toBe('run_1#F2');
  });
});

describe('normalizePath', () => {
  it('takes repository-relative paths only', () => {
    expect(normalizePath('./a/b.ts')).toEqual({ path: 'a/b.ts' });
    expect(normalizePath('a\\b')).toHaveProperty('problem');
    expect(normalizePath('C:/x')).toHaveProperty('problem');
    expect(normalizePath('a//b')).toHaveProperty('problem');
  });
});

describe('with the findings count', () => {
  it('keeps the block intact: its fence is not a count line', async () => {
    const { readFindingsCount } = await import('./verdict.js');
    const text = `${block([{ title: 'a' }])}\nUPDRAFT-FINDINGS: 1`;
    const counted = readFindingsCount(text);
    expect(counted.count).toBe(1);
    expect(readStructuredFindings(counted.findings).structured!.findings).toHaveLength(1);
  });
});

describe('readResolutions', () => {
  const known = new Set(['run_1#F1', 'run_1#F2']);
  const report = (data: unknown) => `Done.\n\n\`\`\`updraft-resolutions\n${JSON.stringify(data)}\n\`\`\``;
  it('reads one report per finding it was given, and nothing else', async () => {
    const { readResolutions } = await import('./findings.js');
    expect(
      readResolutions(
        report([
          { finding: 'run_1#F1', status: 'fixed', note: 'Did it.', tests: 'npm test ok' },
          { finding: 'run_1#F1', status: 'unable' },
          { finding: 'run_9#F1', status: 'fixed' },
          { finding: 'run_1#F2', status: 'wontfix' },
        ]),
        known,
      ),
    ).toEqual({ resolutions: [{ finding: 'run_1#F1', status: 'fixed', note: 'Did it.', tests: 'npm test ok' }], problem: null });
    expect(readResolutions('no block', known)).toMatchObject({ resolutions: [], problem: expect.stringMatching(/no updraft-resolutions block/) });
    expect(readResolutions('```updraft-resolutions\n{bad\n```', known)).toMatchObject({ resolutions: [], problem: expect.stringMatching(/not valid JSON/) });
  });
});

describe('capFindings', () => {
  it('shortens the prose and keeps the block whole', async () => {
    const { capFindings } = await import('./findings.js');
    const text = `${'x'.repeat(5_000)}\n\n\`\`\`updraft-findings\n[{"title":"keep me"}]\n\`\`\``;
    const out = capFindings(text, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(readStructuredFindings(out).structured!.findings[0]!.title).toBe('keep me');
    expect(capFindings('short', 1_000)).toBe('short');
  });
});
