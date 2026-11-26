import { describe, expect, it } from 'vitest';
import {
  acceptanceChanges,
  acceptanceGate,
  assessAcceptance,
  extractCriteria,
  gateReason,
  issueFingerprint,
  MAX_CRITERIA,
  readAcceptanceReport,
  readEvidence,
  revisionCriteria,
  UNLISTED_CRITERIA,
  UNREAD_ISSUE,
} from './acceptance.js';
import { coderAcceptanceSection, reviewerAcceptanceInstructions, reviewerAcceptanceSection } from './acceptance-prompt.js';

const FOUR = [
  'Make retire safe.',
  '',
  '## Acceptance',
  '- [ ] Retire compares the worker generation',
  '- [ ] A stale retire is a no-op',
  '- [x] Tests cover the race',
  '- [ ] Docs describe the generation check',
  '',
  '## Out of scope',
  '- [ ] Rewriting the pool',
].join('\n');

const issue = (body: string | null, title = 'Retire safely') => ({ title, body });
const review = (data: unknown) => ['Looks mostly fine.', '', '```updraft-findings', JSON.stringify(data), '```'].join('\n');

describe('extractCriteria', () => {
  it('reads task-list items as criteria, with stable ids, and leaves out-of-scope items out', () => {
    const s = extractCriteria(issue(FOUR));
    expect(s.source).toBe('checklist');
    expect(s.criteria.map((c) => c.text)).toEqual([
      'Retire compares the worker generation',
      'A stale retire is a no-op',
      'Tests cover the race',
      'Docs describe the generation check',
    ]);
    expect(s.criteria.every((c) => /^AC-[0-9a-f]{8}$/.test(c.id))).toBe(true);
    expect(new Set(s.criteria.map((c) => c.id)).size).toBe(4);
    expect(s.criteria[2]!.checkedInSource).toBe(true);
    expect(s.criteria.every((c) => c.mandatory && c.gate === 'code' && c.section === 'Acceptance' && c.origin === 'checklist')).toBe(true);
    expect(s.fingerprint).toBe(issueFingerprint(issue(FOUR)));
  });

  it('keeps a criterion id when the rest of the issue changes, and gives an edited criterion a new one', () => {
    const before = extractCriteria(issue(FOUR));
    const edited = extractCriteria(issue(FOUR.replace('Make retire safe.', 'Make retire safe, please.').replace('A stale retire is a no-op', 'A stale retire is rejected')));
    expect(edited.fingerprint).not.toBe(before.fingerprint);
    expect(edited.criteria[0]!.id).toBe(before.criteria[0]!.id);
    expect(edited.criteria[1]!.id).not.toBe(before.criteria[1]!.id);
    // Case, spacing and emphasis do not change an id.
    expect(extractCriteria(issue('- [ ] **Retire**   compares the WORKER generation')).criteria[0]!.id).toBe(before.criteria[0]!.id);
  });

  it('marks optional items and live gates, and gives duplicates distinct ids', () => {
    const s = extractCriteria(
      issue(
        [
          '- [ ] Real staging PR shows the evidence at the exact head',
          '- [ ] (optional) A nicer log line',
          '- [ ] Real-time counters update',
          '- [ ] Same text',
          '- [ ] Same text',
          '### Nice to have',
          '- [ ] A dashboard',
        ].join('\n'),
      ),
    );
    expect(s.criteria.map((c) => [c.mandatory, c.gate])).toEqual([
      [true, 'live'],
      [false, 'code'],
      [true, 'code'],
      [true, 'code'],
      [true, 'code'],
      [false, 'code'],
    ]);
    expect(s.criteria[4]!.id).toBe(`${s.criteria[3]!.id}-2`);
  });

  it('without a task list, reads list items under a requirements heading; otherwise reports none', () => {
    const s = extractCriteria(issue('Intro\n\n**Requirements**\n- Must log the generation\n  on every retire\n- Must not retry\n\nNotes:\n- just a note'));
    expect(s.source).toBe('requirements');
    expect(s.criteria.map((c) => [c.text, c.origin])).toEqual([
      ['Must log the generation on every retire', 'requirement'],
      ['Must not retry', 'requirement'],
    ]);
    expect(extractCriteria(issue('Please make it faster.\n\n- some thought')).source).toBe('none');
    expect(extractCriteria(issue('')).criteria).toEqual([]);
  });

  it('ignores items inside code blocks and HTML comments', () => {
    const s = extractCriteria(issue('```\n- [ ] not a criterion\n```\n<!-- - [ ] hidden -->\n- [ ] real one'));
    expect(s.criteria.map((c) => c.text)).toEqual(['real one']);
  });

  it('caps the number of criteria and says how many were left out', () => {
    const body = Array.from({ length: MAX_CRITERIA + 5 }, (_, i) => `- [ ] item ${i}`).join('\n');
    const s = extractCriteria(issue(body));
    expect(s.criteria).toHaveLength(MAX_CRITERIA);
    expect(s.omitted).toBe(5);
  });

  it('marks as live only criteria that ask for live evidence or action, not ones that merely name a live system', () => {
    const gate = (text: string) => extractCriteria(issue(`- [ ] ${text}`)).criteria[0]!.gate;
    for (const live of [
      'Verified on staging',
      'A staging PR shows the checklist',
      'A hosted run completes end to end',
      'Include a screenshot of the editor',
      'Manually test the sign-in flow',
      'Real PR shows criterion evidence at the exact head',
      'Behaviour is confirmed in production',
      'Deployed to production without errors',
      'Live validation of the webhook',
      'Deploy to prod and watch the error rate',
      'Works after deploy',
      'No errors after deployment',
      'Tested on real devices',
      'Runs on a real device',
    ]) {
      expect(gate(live), live).toBe('live');
    }
    for (const code of [
      'Keep hosted mode working',
      "Don't break production deployments",
      'Production config is read from the environment',
      'The deploy script handles a missing region',
      'Add UI examples to the docs',
      'Real-time counters update',
      'Staging is not mentioned in logs',
    ]) {
      expect(gate(code), code).toBe('code');
    }
  });

  it('keeps every ticked item as a mandatory criterion, template-like or not: the reviewer marks report-only ones not applicable', () => {
    const s = extractCriteria(
      issue(
        [
          '## Acceptance',
          '- [x] I have reviewed the documentation and updated the CLI reference for --foo',
          '- [x] I checked that the duplicates are removed from the export',
          '- [x] I searched existing issues for duplicates',
        ].join('\n'),
      ),
    );
    expect(s.criteria.map((c) => [c.text, c.mandatory, c.checkedInSource])).toEqual([
      ['I have reviewed the documentation and updated the CLI reference for --foo', true, true],
      ['I checked that the duplicates are removed from the export', true, true],
      ['I searched existing issues for duplicates', true, true],
    ]);
    // Unassessed, each one holds the head back.
    expect(acceptanceGate(assessAcceptance(s, review({ findings: [] }))).pending).toHaveLength(3);
    expect(reviewerAcceptanceInstructions(s).join('\n')).toContain('is `not-applicable`, with that reason in `note`');
  });

  it('never lets criteria beyond the limit pass: they hold the head back', () => {
    const body = Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => `- [ ] item ${i}`).join('\n');
    const s = extractCriteria(issue(body));
    const a = assessAcceptance(s, review({ criteria: s.criteria.map((c) => ({ criterion: c.id, status: 'verified', evidence: ['src/a.ts'] })) }));
    expect(a.rows.filter((r) => r.status === 'verified')).toHaveLength(MAX_CRITERIA);
    expect(a.rows.at(-1)).toMatchObject({ id: UNLISTED_CRITERIA, mandatory: true, status: 'unverified', text: '1 more criteria of the issue' });
    const g = acceptanceGate(a);
    expect(g.passed).toBe(false);
    expect(g.pending.map((r) => r.id)).toEqual([UNLISTED_CRITERIA]);
  });

  const UNIT_TESTS = [
    '## Acceptance criteria',
    '- [ ] Unit tests cover:',
    '  - ordering for records received in the same millisecond;',
    '  - issue filtering and pull-request-to-issue resolution;',
    '  - `--limit`, `--outcome` and `--json`;',
    '  - truncation and escaping;',
    '  - every error case listed above.',
    '- [ ] Errors are reported',
  ].join('\n');

  it('keeps a checklist item\'s sub-bullets as part of its criterion, and gives them to the reviewer', () => {
    const s = extractCriteria(issue(UNIT_TESTS));
    expect(s.criteria).toHaveLength(2);
    expect(s.criteria[0]!.text).toBe(
      [
        'Unit tests cover:',
        '- ordering for records received in the same millisecond;',
        '- issue filtering and pull-request-to-issue resolution;',
        '- `--limit`, `--outcome` and `--json`;',
        '- truncation and escaping;',
        '- every error case listed above.',
      ].join('\n'),
    );
    expect(s.criteria[0]!.context).toBeNull();
    expect(s.criteria[1]!.text).toBe('Errors are reported');
    const prompt = reviewerAcceptanceSection(s, {}).join('\n');
    expect(prompt).toContain(`<untrusted-acceptance-criterion>\n${s.criteria[0]!.text}\n</untrusted-acceptance-criterion>`);
    expect(coderAcceptanceSection(s).join('\n')).toContain('- every error case listed above.\n</untrusted-acceptance-criterion>');
  });

  it('makes a nested checkbox a criterion of its own, with its parent\'s first line as context', () => {
    const s = extractCriteria(
      issue(['- [ ] The export works', '  continued here', '  - [ ] CSV export', '    - with a header row', '  - plain point of the parent', '- [ ] Next one'].join('\n')),
    );
    expect(s.criteria.map((c) => [c.text, c.context])).toEqual([
      ['The export works continued here\n- plain point of the parent', null],
      ['CSV export\n- with a header row', 'The export works continued here'],
      ['Next one', null],
    ]);
    expect(reviewerAcceptanceSection(s, {}).join('\n')).toContain('- Nested under the item: "The export works continued here"');
    // Nested checkboxes count toward the limit like any other.
    const many = extractCriteria(issue(['- [ ] parent', ...Array.from({ length: MAX_CRITERIA }, (_, i) => `  - [ ] child ${i}`)].join('\n')));
    expect(many.criteria).toHaveLength(MAX_CRITERIA);
    expect(many.omitted).toBe(1);
  });

  it('keeps continuation lines and numbered sub-items; a following top-level item starts a new criterion', () => {
    const s = extractCriteria(
      issue(['- [ ] Retire is safe', '  when the generation', '  matches:', '  1. old workers', '     are skipped', '  2) new ones retire', '', '  Afterwards it logs.', '- [ ] Second'].join('\n')),
    );
    expect(s.criteria.map((c) => c.text)).toEqual([
      'Retire is safe when the generation matches:\n1. old workers are skipped\n2) new ones retire\nAfterwards it logs.',
      'Second',
    ]);
  });

  it('leaves code blocks and HTML comments nested under an item out of its text', () => {
    const s = extractCriteria(
      issue(['- [ ] Parse the config', '  ```yaml', '  - [ ] not a criterion', '  - not a point', '  ```', '  <!-- - hidden point -->', '  - real point', '- [ ] Next'].join('\n')),
    );
    expect(s.criteria.map((c) => c.text)).toEqual(['Parse the config\n- real point', 'Next']);
    // A sub-point marked optional does not make the criterion optional.
    expect(extractCriteria(issue('- [ ] Tests\n  - (optional) a benchmark')).criteria[0]!.mandatory).toBe(true);
  });

  it('gives a criterion a new id when a sub-point is edited, and the old assessment does not carry over', () => {
    const before = extractCriteria(issue(UNIT_TESTS));
    const after = extractCriteria(issue(UNIT_TESTS.replace('truncation and escaping', 'truncation, escaping and wrapping')));
    expect(after.criteria[0]!.id).not.toBe(before.criteria[0]!.id);
    expect(after.criteria[1]!.id).toBe(before.criteria[1]!.id);
    // An item without sub-points keeps the id it had before sub-points were read.
    expect(before.criteria[1]!.id).toBe(extractCriteria(issue('- [ ] Errors are reported')).criteria[0]!.id);
    const old = review({ criteria: before.criteria.map((c) => ({ criterion: c.id, status: 'verified', evidence: ['src/a.ts'] })) });
    const a = assessAcceptance(after, old);
    expect(a.rows.map((r) => [r.id, r.status])).toEqual([
      [after.criteria[0]!.id, 'unverified'],
      [after.criteria[1]!.id, 'verified'],
    ]);
    expect(acceptanceGate(a).pending.map((r) => r.id)).toEqual([after.criteria[0]!.id]);
  });

  it('reports a withheld body as unavailable, never as an issue without requirements', () => {
    const s = extractCriteria(issue(null), 'report');
    expect(s).toMatchObject({ source: 'unavailable', criteria: [], policy: 'report' });
  });
});

describe('readEvidence', () => {
  it('reads the forms it knows, and nothing else', () => {
    expect(readEvidence('file: ./src/pool.ts:40-48')).toEqual({ kind: 'file', ref: 'src/pool.ts', line: 40, endLine: 48 });
    expect(readEvidence('src/pool.test.ts')).toEqual({ kind: 'file', ref: 'src/pool.test.ts', line: null, endLine: null });
    expect(readEvidence('commit: ABCDEF1')).toEqual({ kind: 'commit', ref: 'abcdef1', line: null, endLine: null });
    expect(readEvidence('test: npm test -- pool (12 passed)')).toMatchObject({ kind: 'test' });
    expect(readEvidence({ kind: 'check', ref: 'ci / lint' })).toMatchObject({ kind: 'check', ref: 'ci / lint' });
    expect(readEvidence('https://github.com/o/r/actions/runs/1')).toMatchObject({ kind: 'link' });
    expect(readEvidence('file: /etc/passwd')).toBeNull();
    expect(readEvidence('file: src/../x')).toBeNull();
    expect(readEvidence('commit: not-a-sha')).toBeNull();
    expect(readEvidence('link: http://insecure')).toBeNull();
    expect(readEvidence('I looked at it')).toBeNull();
    expect(readEvidence(42)).toBeNull();
  });
});

describe('assessAcceptance and acceptanceGate', () => {
  const snapshot = extractCriteria(issue(FOUR));
  const [a, b, c, d] = snapshot.criteria.map((x) => x.id) as [string, string, string, string];

  it('finds the one criterion of four that is not met: a revision can fix it', () => {
    const r = assessAcceptance(
      snapshot,
      review({
        findings: [],
        criteria: [
          { criterion: a, status: 'verified', evidence: ['file: src/pool.ts:40'] },
          { criterion: b, status: 'verified', evidence: ['test: pool.test.ts stale retire (ran it)'] },
          { criterion: c, status: 'verified', evidence: ['src/pool.test.ts:10'] },
          { criterion: d, status: 'unmet', note: 'docs/pool.md is unchanged' },
        ],
      }),
    );
    expect(r.problem).toBeNull();
    expect(r.rows.map((x) => x.status)).toEqual(['verified', 'verified', 'verified', 'unmet']);
    const g = acceptanceGate(r);
    expect(g.passed).toBe(false);
    expect(g.unmet.map((x) => x.id)).toEqual([d]);
    expect(g.pending).toEqual([]);
    expect(gateReason(g)).toBe(`1 mandatory acceptance criterion is not met (${d})`);
    expect(revisionCriteria(g)).toEqual([{ id: d, text: 'Docs describe the generation check', status: 'unmet', gate: 'code', note: 'docs/pool.md is unchanged' }]);
  });

  it('passes when every mandatory criterion is verified with evidence or not applicable with a reason', () => {
    const r = assessAcceptance(
      snapshot,
      review({
        criteria: [
          { criterion: a, status: 'verified', evidence: ['file: src/pool.ts:40'] },
          { criterion: b, status: 'verified', evidence: ['commit: abc1234'] },
          { criterion: c, status: 'verified', evidence: ['src/pool.test.ts'] },
          { criterion: d, status: 'not-applicable', note: 'there are no docs for the pool' },
        ],
      }),
    );
    expect(acceptanceGate(r).passed).toBe(true);
  });

  it('fails closed: no block, no assessment, verified without evidence, n/a without a reason, an unknown status', () => {
    const none = assessAcceptance(snapshot, 'Looks good to me.');
    expect(none.problem).toMatch(/no updraft-findings block/);
    expect(none.rows.every((x) => x.status === 'unverified')).toBe(true);
    expect(acceptanceGate(none).pending).toHaveLength(4);

    const bad = assessAcceptance(snapshot, '```updraft-findings\n{not json\n```');
    expect(bad.problem).toMatch(/not valid JSON/);
    expect(bad.rows.every((x) => x.status === 'unverified')).toBe(true);

    const r = assessAcceptance(
      snapshot,
      review({
        criteria: [
          { criterion: a, status: 'verified' },
          { criterion: b, status: 'not-applicable' },
          { criterion: c, status: 'done', evidence: ['src/a.ts'] },
          { criterion: 'AC-ffffffff', status: 'verified', evidence: ['src/a.ts'] },
        ],
      }),
    );
    expect(r.rows.map((x) => [x.claimed, x.status])).toEqual([
      ['verified', 'unverified'],
      ['not-applicable', 'unverified'],
      [null, 'unverified'],
      [null, 'unverified'],
    ]);
    expect(r.rows.every((x) => x.notes.length === 1)).toBe(true);
    expect(r.omitted).toBe(1);
  });

  it('never lets a live gate pass on an agent review, whatever the tests and the evidence', () => {
    const live = extractCriteria(issue('- [ ] Real staging PR shows criterion evidence at the exact head'));
    const r = assessAcceptance(live, review({ criteria: [{ criterion: live.criteria[0]!.id, status: 'verified', evidence: ['test: npm test (all green)', 'https://example.com/staging'] }] }));
    expect(r.rows[0]).toMatchObject({ claimed: 'verified', status: 'unverified', gate: 'live' });
    const g = acceptanceGate(r);
    expect(g.unmet).toEqual([]);
    expect(g.pending.map((x) => x.id)).toEqual([live.criteria[0]!.id]);
    expect(gateReason(g)).toMatch(/1 mandatory acceptance criterion is unverified/);
  });

  it('does not let a ticked box count as anything', () => {
    const ticked = extractCriteria(issue('- [x] Tests cover the race'));
    expect(acceptanceGate(assessAcceptance(ticked, review({ findings: [] }))).pending).toHaveLength(1);
  });

  it('takes criteria the reviewer adds, from the issue or from steering, and ignores optional ones in the gate', () => {
    const none = extractCriteria(issue('Make it faster.'));
    const r = assessAcceptance(
      none,
      review({
        criteria: [
          { criterion: 'I1', text: 'Startup is faster than before', status: 'needs-clarification', note: 'By how much?' },
          { criterion: 'S1', text: 'Keep the old flag', status: 'verified', evidence: ['src/cli.ts:12'] },
          { criterion: 'I2', text: 'Nicer output', status: 'unmet', optional: true },
          { criterion: 'X9', text: 'not an added id', status: 'unmet' },
        ],
      }),
    );
    expect(r.problem).toBeNull();
    expect(r.rows.map((x) => [x.id, x.origin, x.mandatory, x.status])).toEqual([
      ['I1', 'inferred', true, 'needs-clarification'],
      ['S1', 'steering', true, 'verified'],
      ['I2', 'inferred', false, 'unmet'],
    ]);
    const g = acceptanceGate(r);
    expect(g.unmet).toEqual([]);
    expect(g.pending.map((x) => x.id)).toEqual(['I1']);
    expect(gateReason(g)).toBe('1 mandatory acceptance criterion needs clarification (I1)');
  });

  it('an issue without criteria and a review that assesses none: nothing to hold back, and no problem', () => {
    const r = assessAcceptance(extractCriteria(issue('Make it faster.')), 'Fine.');
    expect(r).toMatchObject({ rows: [], problem: null });
    expect(acceptanceGate(r).passed).toBe(true);
  });

  it('an unavailable issue body holds the head back for a person', () => {
    const r = assessAcceptance(extractCriteria(issue(null)), review({ findings: [] }));
    expect(r.rows.map((x) => [x.id, x.status, x.mandatory])).toEqual([[UNREAD_ISSUE, 'unverified', true]]);
    expect(acceptanceGate(r).passed).toBe(false);
  });

  it('says what changed since an earlier assessment, including criteria the issue no longer has', () => {
    const before = assessAcceptance(snapshot, review({ criteria: [{ criterion: d, status: 'unmet' }] }));
    const editedIssue = extractCriteria(issue(FOUR.replace('- [ ] A stale retire is a no-op\n', '')));
    const after = assessAcceptance(editedIssue, review({ criteria: [{ criterion: d, status: 'verified', evidence: ['docs/pool.md'] }] }));
    const { issueChanged, changes } = acceptanceChanges(before, after);
    expect(issueChanged).toBe(true);
    expect(changes).toEqual([
      { id: d, before: 'unmet', after: 'verified' },
      { id: b, before: 'unverified', after: null },
    ]);
  });
});

describe('readAcceptanceReport', () => {
  const snapshot = extractCriteria(issue(FOUR));
  const id = snapshot.criteria[0]!.id;

  it('reads the claims about the criteria the agent was given, and only those', () => {
    const text = [
      'Done.',
      '```updraft-acceptance',
      JSON.stringify([
        { criterion: id, status: 'implemented', evidence: 'src/pool.ts', tests: 'npm test: 3 passed' },
        { criterion: id, status: 'partial' },
        { criterion: 'AC-00000000', status: 'implemented' },
        { criterion: snapshot.criteria[1]!.id, status: 'finished' },
      ]),
      '```',
    ].join('\n');
    expect(readAcceptanceReport(text, snapshot)).toEqual({
      report: { fingerprint: snapshot.fingerprint, claims: [{ criterion: id, status: 'implemented', evidence: 'src/pool.ts', tests: 'npm test: 3 passed' }] },
      problem: null,
    });
  });

  it('says why there is no report', () => {
    expect(readAcceptanceReport('Done.', snapshot)).toEqual({ report: null, problem: 'the agent wrote no updraft-acceptance block' });
    expect(readAcceptanceReport('```updraft-acceptance\nnope\n```', snapshot).problem).toMatch(/not valid JSON/);
    expect(readAcceptanceReport('```updraft-acceptance\n{"a":1}\n```', snapshot).problem).toMatch(/not a list/);
  });
});

describe('the acceptance sections of the prompts', () => {
  const snapshot = extractCriteria(issue(`${FOUR}\n- [ ] Real staging PR shows it`));

  it('gives the coding agent every criterion, fenced, and asks for its report', () => {
    const text = coderAcceptanceSection(snapshot).join('\n');
    for (const c of snapshot.criteria) expect(text).toContain(c.id);
    expect(text).toContain('<untrusted-acceptance-criterion>\nRetire compares the worker generation\n</untrusted-acceptance-criterion>');
    expect(text).toContain('```updraft-acceptance');
    expect(text).toContain('do not deploy, change live systems');
    expect(text).toContain('a ticked box is not evidence');
    expect(coderAcceptanceSection(null)).toEqual([]);
  });

  it('tells a revision what the reviewer found about each criterion', () => {
    const gaps = [
      { id: snapshot.criteria[3]!.id, text: 'Docs describe the generation check', status: 'unmet' as const, gate: 'code' as const, note: 'no docs' },
      { id: 'I1', text: 'Log it', status: 'unmet' as const, gate: 'code' as const, note: null },
    ];
    const text = coderAcceptanceSection(snapshot, gaps).join('\n');
    expect(text).toContain('The reviewer of the current head found it: unmet');
    expect(text).toContain('<untrusted-reviewer-note>\nno docs\n</untrusted-reviewer-note>');
    expect(text).toContain('## Added by the reviewer: I1');
  });

  it('gives the reviewer the criteria and the coding agent\'s claims, labelled as claims, and only for this issue revision', () => {
    const claims = { runId: 'run_1', fingerprint: snapshot.fingerprint, claims: [{ criterion: snapshot.criteria[0]!.id, status: 'implemented' as const, evidence: 'trust me', tests: null }] };
    const text = reviewerAcceptanceSection(snapshot, { acceptanceClaims: claims }).join('\n');
    expect(text).toContain("Coding agent's report (a claim, not evidence): implemented, run run_1");
    expect(text).toContain('<untrusted-coding-agent-evidence>\ntrust me\n</untrusted-coding-agent-evidence>');
    const stale = reviewerAcceptanceSection(snapshot, { acceptanceClaims: { ...claims, fingerprint: 'other' } }).join('\n');
    expect(stale).toContain('reported on an earlier revision of the issue');
    expect(stale).not.toContain('trust me');
    const how = reviewerAcceptanceInstructions(snapshot).join('\n');
    expect(how).toContain('"criteria"');
    expect(how).toContain('Never cite a test run, screenshot or deployment you did not see');
    expect(reviewerAcceptanceInstructions(null)).toEqual([]);
  });

  it('tells the reviewer honestly when the issue has no list, or could not be read', () => {
    expect(reviewerAcceptanceSection(extractCriteria(issue('Make it faster.')), {}).join('\n')).toContain('add them as `I1`');
    expect(reviewerAcceptanceSection(extractCriteria(issue(null)), {}).join('\n')).toContain('was not available to this review');
  });
});
