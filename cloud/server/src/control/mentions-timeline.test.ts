import { describe, expect, it } from 'vitest';
import type { RepoPermission } from '../../../../src/control/commands.js';
import { createMemoryStore, type Tenant } from '../store/store.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createWorkflowRecorder } from '../workflows/recorder.js';
import { createMemoryWorkflowStore } from '../workflows/store.js';
import { createMentionHandler, type MentionEvent } from './mentions.js';

// A GitHub mention's pause, cancel and resume on the workflow timeline (#135 with #139).
const INSTALLATION = 55;
const REPO = { id: 9, full_name: 'acme/web' };
const ISSUE = 12;
const WF = '9-i12';
const tenant: Tenant = { installationId: INSTALLATION, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '2026-11-19T00:00:00.000Z', createdBy: 's' };
const rules = dispatchRules({
  dispatch: { allowedActors: ['pat', 'olive'] },
  repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
}, { keysFor: () => [] });

async function setup() {
  let clock = Date.parse('2026-11-25T12:00:00.000Z');
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant, { installationId: INSTALLATION, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
  const version = await store.createConfigVersion(INSTALLATION, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: rules });
  await store.markConfigReady(INSTALLATION, version as number);
  await store.activateConfig(INSTALLATION, version as number);
  const permissions: Record<string, RepoPermission> = { pat: 'write', olive: 'admin' };
  const workflowStore = createMemoryWorkflowStore();
  const workflows = createWorkflowRecorder({ store: workflowStore, pauses: store, now: () => clock, log: () => {} });
  // The issue's workflow, waiting for CI on its pull request.
  const opener = { jobId: 'job_issue0001', installationId: INSTALLATION, repository: REPO.full_name, repositoryId: REPO.id, issue: ISSUE, eventName: 'issues', deliveryId: 'd-1' };
  await workflows.started(opener);
  await workflows.finished(opener, 'succeeded', { prNumber: 40, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
  const handle = createMentionHandler({
    store,
    slug: async () => 'updraft-app',
    github: {
      permission: async (_i, _r, _n, login) => permissions[login] ?? null,
      pullRequest: async () => ({ state: 'open', merged: false, headRef: 'updraft/issue-12-x', headSha: 'a'.repeat(40), headRepoId: REPO.id }),
      issueOpen: async () => true,
      reply: async () => {},
    },
    managedIssue: async () => true,
    workflows,
    now: () => clock,
    log: () => {},
  });
  let seq = 0;
  const comment = (login: string, body: string): MentionEvent => ({
    installationId: INSTALLATION,
    deliveryId: `delivery-${++seq}`,
    eventName: 'issue_comment',
    payload: {
      action: 'created',
      repository: REPO,
      sender: { login, type: 'User' },
      issue: { number: ISSUE },
      comment: { id: 8000 + seq, body, user: { login, type: 'User' }, html_url: 'https://github.com/acme/web/issues/12#c' },
    },
  });
  return {
    store, workflowStore, handle, comment,
    tick: (ms: number) => (clock += ms),
    wf: () => workflowStore.getWorkflow(INSTALLATION, WF),
    controls: async () => (await workflowStore.listWorkflowEvents(INSTALLATION, WF, 50)).filter((e) => e.kind === 'control'),
  };
}

describe('GitHub mention commands on the workflow timeline', () => {
  it('a pause overlays the workflow at once, worded as the command, and a resume gives it back with who and how long', async () => {
    const s = await setup();
    expect(await s.handle(s.comment('pat', '@updraft-app pause waiting on design'))).toMatchObject({ reason: 'control_applied' });
    const pause = (await s.store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE))!;
    expect(await s.wf()).toMatchObject({
      status: 'blocked', reason: 'workflow_paused', message: 'Automation was paused by pat (from a GitHub comment). Existing commits and the pull request are preserved.',
      controlPause: { jobId: pause.jobId, at: pause.at, control: { kind: 'pause' } },
    });
    const [paused] = await s.controls();
    expect(paused).toMatchObject({ jobId: pause.jobId, control: { action: 'paused', by: 'pat' }, waited: { for: 'ci' } });
    // Its synthetic id names no job record (the console gives it no job link).
    expect(paused!.jobId).toMatch(/^control-/);

    s.tick(30 * 60_000);
    expect(await s.handle(s.comment('pat', '@updraft-app resume'))).toMatchObject({ reason: 'control_applied' });
    expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci', reason: 'ci_pending' });
    expect((await s.wf())!.controlPause).toBeUndefined();
    expect((await s.controls()).at(-1)).toMatchObject({ control: { action: 'resumed', by: 'pat' }, waited: { for: 'pause', seconds: 1800 } });
  });

  it('a cancel that takes a pause over moves the overlay to the new identity, and its resume matches it', async () => {
    const s = await setup();
    await s.handle(s.comment('pat', '@updraft-app pause'));
    const first = (await s.store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE))!;
    s.tick(1000);
    expect(await s.handle(s.comment('olive', '@updraft-app cancel'))).toMatchObject({ reason: 'control_applied' });
    const taken = (await s.store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE))!;
    expect(taken).toMatchObject({ jobId: first.jobId, control: { kind: 'cancel' } });
    expect(taken.at).toBeGreaterThan(first.at);
    expect(await s.wf()).toMatchObject({ message: expect.stringMatching(/^Automation was canceled by pat \(from a GitHub comment\)/), controlPause: { jobId: first.jobId, at: taken.at, control: { kind: 'cancel' } } });
    expect((await s.controls()).map((e) => e.control?.action)).toEqual(['paused', 'canceled']);

    s.tick(1000);
    expect(await s.handle(s.comment('olive', '@updraft-app resume'))).toMatchObject({ reason: 'control_applied' });
    expect(await s.wf()).toMatchObject({ status: 'waiting', reason: 'ci_pending' });
    expect((await s.controls()).at(-1)).toMatchObject({ control: { action: 'resumed', by: 'olive' } });
  });

  it('a resume decided against a pause as it was before a takeover still lifts the overlay of that pause', async () => {
    const s = await setup();
    await s.handle(s.comment('pat', '@updraft-app pause'));
    const first = (await s.store.getWorkflowPause(INSTALLATION, REPO.id, ISSUE))!;
    // The overlay recorded the earlier identity; the pause has been taken over (a later `at`) since.
    const { createWorkflowRecorder: make } = await import('../workflows/recorder.js');
    const recorder = make({ store: s.workflowStore, pauses: { getWorkflowPause: async () => null }, log: () => {} });
    await recorder.resumed({ installationId: INSTALLATION, workflowId: WF }, { jobId: first.jobId, at: first.at + 5 }, 'github:olive');
    expect((await s.wf())!.controlPause).toBeUndefined();
    // Never a newer overlay from an older identity.
    const { overlayOf } = await import('../workflows/timeline.js');
    expect(overlayOf({ controlPause: { jobId: 'control-1', at: 10, by: 'pat', previous: { status: 'waiting' } } }, { jobId: 'control-1', at: 9 })).toBe(false);
    expect(overlayOf({ controlPause: { jobId: 'control-1', at: 10, by: 'pat', previous: { status: 'waiting' } } }, { jobId: 'control-2', at: 11 })).toBe(false);
    expect(overlayOf({ controlPause: { jobId: 'control-1', at: 10, by: 'pat', previous: { status: 'waiting' } } }, { jobId: 'control-1', at: 12 })).toBe(true);
  });
});
