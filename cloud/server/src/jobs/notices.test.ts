import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow } from '../workflows/workflow.js';
import { blockComment, blockMarker, createGitHubNotices, refusalComment, refusalMarker, type RefusalNotice } from './notices.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SETTINGS = { appId: '4242', slug: 'updraft', privateKey, clientId: 'c', clientSecret: 's', webhookSecret: 'w' };
const ORIGIN = 'https://updraft.example.com';
/** At most two sentences of prose, then the marker. */
const sentences = (body: string) => body.split('\n')[0]!.replace(/ ?\[[^\]]*\]\([^)]*\)/g, '').split(/(?<=[.!?]) (?=[A-Z])/).length;

const refusal = (over: Partial<RefusalNotice> = {}): RefusalNotice => ({
  installationId: 55, repository: 'acme/web', repositoryId: 99, number: 12, pullRequest: false,
  message: 'ANTHROPIC_API_KEY is not set: add it under Agent keys', missing: ['ANTHROPIC_API_KEY'], configVersion: 3, ...over,
});
const workflow = (over: Partial<Workflow> = {}) => ({ workflowId: '99-i7', installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, generation: 2, ...over }) as Workflow;

function fakeGitHub() {
  const posted: { repository: string; number: number; body: string }[] = [];
  const github = {
    createInstallationToken: vi.fn(async () => ({ token: 'ghs_x', expiresAt: Date.now() + 3_600_000 })),
    findIssueComment: vi.fn(async (_t: string, _r: string, number: number, marker: string) => (posted.find((p) => p.number === number && p.body.includes(marker)) ? 1 : null)),
    postIssueComment: vi.fn(async (_t: string, repository: string, number: number, body: string) => (posted.push({ repository, number, body }), posted.length)),
    createIssueComment: vi.fn(async () => {}),
  };
  return { github, posted, notices: createGitHubNotices({ github, loadSettings: async () => SETTINGS as never, consoleOrigin: ORIGIN, log: () => {} }) };
}

describe('please-act comments (#173)', () => {
  it('a missing key: which key, where to add it, how to try again', () => {
    const body = refusalComment(refusal(), ORIGIN);
    expect(body).toMatch(/^Updraft could not start work on this issue: ANTHROPIC_API_KEY is not set/);
    expect(body).toContain(`[add it under Agent keys](${ORIGIN}/installations/55/keys)`);
    expect(body).toContain('remove the label and add it again');
    expect(sentences(body)).toBeLessThanOrEqual(2);
    expect(body.endsWith(refusalMarker(refusal()))).toBe(true);
    expect(refusalComment(refusal({ pullRequest: true }), ORIGIN)).toContain('submit the review again or push a commit');
    // A refusal about the configuration points there instead.
    expect(refusalComment(refusal({ missing: [], message: 'This workflow runs kiro, which Updraft Cloud no longer runs here' }), ORIGIN)).toContain(`[fix the configuration](${ORIGIN}/installations/55/config)`);
    expect(refusalComment(refusal())).not.toContain('](');
  });

  it('a workflow blocked for a person: why, what to do, the workflow link', () => {
    const why = { reason: 'publication_uncertain', message: 'The job\'s worker was lost after it may have published its work.', nextAction: 'Look at the branch or pull request' };
    const body = blockComment(workflow(), why, ORIGIN);
    expect(body).toMatch(/^Updraft stopped working on this issue and needs a person: The job's worker was lost/);
    expect(body).toContain('Look at the branch or pull request.');
    expect(body).toContain(`[Open it in Updraft](${ORIGIN}/installations/55/workflows/99-i7)`);
    expect(sentences(body)).toBeLessThanOrEqual(2);
    expect(blockMarker(workflow(), 'publication_uncertain')).toBe('<!-- updraft-blocked: 99-i7 g2 publication_uncertain -->');
    expect(blockComment(workflow({ pullRequest: 12 }), why, ORIGIN)).toContain('on this pull request');
  });

  it('posts each once: a repeated block, refusal or redelivery finds the marker', async () => {
    const { posted, notices } = fakeGitHub();
    await notices.refused(refusal());
    await notices.refused(refusal());
    expect(posted).toHaveLength(1);
    // A different set of keys, or a new configuration, is said again.
    await notices.refused(refusal({ configVersion: 4 }));
    expect(posted).toHaveLength(2);

    const why = { reason: 'ci_event_missed', message: 'No job picked the checks up.', nextAction: 'Re-run a check on GitHub' };
    await notices.blocked(workflow({ pullRequest: 12 }), why);
    await notices.blocked(workflow({ pullRequest: 12 }), why);
    expect(posted.filter((p) => p.number === 12 && p.body.includes('updraft-blocked'))).toHaveLength(1);
    // The next run of the workflow (a relabel) is its own.
    await notices.blocked(workflow({ pullRequest: 12, generation: 3 }), why);
    expect(posted.filter((p) => p.body.includes('updraft-blocked'))).toHaveLength(2);
  });

  it('fails closed without the App slug: it never matches anyone\'s comment, so it posts nothing', async () => {
    const { github, posted } = fakeGitHub();
    const notices = createGitHubNotices({ github, loadSettings: async () => ({ ...SETTINGS, slug: '' }) as never, consoleOrigin: ORIGIN, log: () => {} });
    await notices.refused(refusal());
    await notices.blocked(workflow(), { reason: 'stalled', message: 'x', nextAction: 'y' });
    expect(posted).toEqual([]);
    expect(github.findIssueComment).not.toHaveBeenCalled();
  });

  it('a block that cannot be said never throws', async () => {
    const { github, notices } = fakeGitHub();
    github.postIssueComment.mockRejectedValueOnce(new Error('502'));
    await expect(notices.blocked(workflow(), { reason: 'stalled', message: 'x', nextAction: 'y' })).resolves.toBeUndefined();
  });
});
