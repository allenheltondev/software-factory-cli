import { describe, expect, it } from 'vitest';
import { acceptanceGate, assessAcceptance, extractCriteria } from '../agents/acceptance.js';
import { plain, renderAcceptanceChecklist, repoWebUrl } from './acceptance.js';

const SHA = 'a'.repeat(40);
const PR_URL = 'https://github.com/octo/widgets/pull/9';
const block = (data: unknown) => `\`\`\`updraft-findings\n${JSON.stringify(data)}\n\`\`\``;

describe('the acceptance checklist', () => {
  it('makes untrusted text inert: no mentions, HTML, comments, links or closing keywords', () => {
    const text = plain('@octocat <img src=x> <!-- updraft-review: x --> [click](https://evil) fixes #12\nsecond line');
    expect(text).not.toMatch(/@octocat|<img|<!--|\[click\]|fixes #12|\n/);
    expect(text).toContain('@​octocat');
  });

  it('links evidence at the reviewed commit, only for the pull request\'s own repository', () => {
    expect(repoWebUrl(PR_URL)).toBe('https://github.com/octo/widgets');
    expect(repoWebUrl('not a url')).toBeNull();
    const snap = extractCriteria({ title: 't', body: '- [ ] One thing\n- [ ] Optional: another' });
    const [one, two] = snap.criteria.map((c) => c.id) as [string, string];
    const a = assessAcceptance(
      snap,
      block({
        criteria: [
          { criterion: one, status: 'verified', evidence: ['file: src/a b.ts:3-5', 'commit: abcdef1234', 'https://ci.example/run(1)', 'nonsense here'], note: '@someone said so' },
          { criterion: two, status: 'unmet' },
        ],
      }),
    );
    const text = renderAcceptanceChecklist({ assessment: a, gate: acceptanceGate(a), headSha: SHA, prUrl: PR_URL, previous: null });
    expect(text).toContain(`[\`src/a b.ts:3-5\`](https://github.com/octo/widgets/blob/${SHA}/src/a%20b.ts#L3-L5)`);
    expect(text).toContain('[commit `abcdef1234`](https://github.com/octo/widgets/commit/abcdef1234)');
    expect(text).toContain('[link](https://ci.example/run%281%29)');
    expect(text).toContain('Updraft: 1 evidence reference(s) had no form the worker recognizes and were left out');
    expect(text).toContain('Review agent: @​someone said so');
    // An optional criterion not met is shown and never holds the head back.
    expect(text).toContain(`- **Not met** · \`${two}\` · Optional: another (optional)`);
    expect(text).toContain('1 of 1 mandatory criteria verified');
    expect(text).not.toContain('this head is not ready');
  });

  it('says so honestly when the issue lists nothing and the reviewer named nothing', () => {
    const a = assessAcceptance(extractCriteria({ title: 't', body: 'Make it faster.' }), 'ok');
    expect(renderAcceptanceChecklist({ assessment: a, gate: acceptanceGate(a), headSha: SHA, prUrl: PR_URL, previous: null })).toContain(
      'The issue has no task list or requirements list, and the reviewer named no concrete requirement of it.',
    );
  });
});
