import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { LabelEvent, LabeledIssue } from '../github/client.js';
import { createLabelScanner, FIRST_LOOK_MS, MAX_AGE_MS, QUIET_MS, SCAN_INTERVAL_MS } from './label-scan.js';
import { createWorkflowRecorder } from './recorder.js';
import { createMemoryWorkflowStore } from './store.js';

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const LABELED = new Date(T0 - 30 * 60_000).toISOString();
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SETTINGS = { appId: '4242', slug: 'updraft', privateKey, clientId: 'c', clientSecret: 's', webhookSecret: 'w' };

function setup(o: { issues?: LabeledIssue[]; event?: LabelEvent | null; tenants?: unknown[]; jobs?: unknown[]; deliveries?: unknown[] } = {}) {
  const store = createMemoryWorkflowStore();
  let clock = T0;
  const recorder = createWorkflowRecorder({ store, now: () => clock, log: () => {} });
  const tenants = {
    listTenants: vi.fn(async () => (o.tenants ?? [{ installationId: 55, status: 'active', activeConfigVersion: 3 }]) as never),
    getConfigVersion: vi.fn(async () => ({ dispatch: { repositories: { 'acme/web': { id: 99, triggers: [{ label: 'updraft' }, { label: 'Updraft' }] }, 'acme/paused': { id: 98, paused: true, triggers: [{ label: 'updraft' }] } } } }) as never),
    listRecentJobs: vi.fn(async () => (o.jobs ?? []) as never),
    listDeliveries: vi.fn(async () => (o.deliveries ?? []) as never),
  };
  const github = {
    createInstallationToken: vi.fn(async () => ({ token: 'ghs_x', expiresAt: clock + 3_600_000 })),
    labeledIssues: vi.fn(async () => o.issues ?? [{ number: 7, title: 'Add a widget', htmlUrl: 'https://github.com/acme/web/issues/7', labels: ['updraft'] }]),
    latestLabelEvent: vi.fn(async () => (o.event === undefined ? { id: 9001, actor: 'pat', createdAt: LABELED, label: 'updraft' } : o.event)),
  };
  const scan = createLabelScanner({ tenants, store, github, loadSettings: async () => SETTINGS as never, now: () => clock, log: () => {} });
  const wf = () => store.getWorkflow(55, '99-i7');
  return { store, scan, github, tenants, recorder, wf, tick: (ms: number) => (clock += ms) };
}

describe('the missed-label scan', () => {
  it('reports a labeled issue that nothing reached Updraft for as blocked, with how to start it, and starts nothing', async () => {
    const s = setup();
    expect(await s.scan()).toEqual({ tenants: 1, flagged: 1, failed: 0 });
    expect(s.github.labeledIssues).toHaveBeenCalledWith('ghs_x', 'acme/web', 'updraft', new Date(T0 - FIRST_LOOK_MS).toISOString(), 20);
    expect(s.github.createInstallationToken).toHaveBeenCalledWith(expect.any(String), 55, { repositoryIds: [99], permissions: { issues: 'read' } });
    expect(s.github.createInstallationToken).toHaveBeenCalledTimes(1);
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'label_event_missed', nextAction: 'Remove the label updraft and apply it again on GitHub to start the job.' });
    const events = await s.store.listWorkflowEvents(55, '99-i7', 10);
    expect(events).toEqual([expect.objectContaining({ kind: 'label_missed', message: expect.stringContaining('by @pat') })]);

    // Reported once: the next look finds the workflow.
    s.tick(SCAN_INTERVAL_MS);
    expect(await s.scan()).toMatchObject({ flagged: 0 });
    expect(await s.store.listWorkflowEvents(55, '99-i7', 10)).toHaveLength(1);
    // A delivery that arrives after all starts the job, and the workflow works again.
    await s.recorder.started({ jobId: 'job_late00001', installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, eventName: 'issues', deliveryId: 'gh-uuid' });
    expect(await s.wf()).toMatchObject({ status: 'active', generation: 1 });
  });

  it('never reports an issue whose label did reach Updraft: a job from before workflows, a failed recording, a delivery racing the scan', async () => {
    const after = new Date(Date.parse(LABELED) + 60_000).toISOString();
    for (const evidence of [
      { jobs: [{ jobId: 'job_old', repository: 'ACME/web', issue: 7, createdAt: after }] },
      { deliveries: [{ at: LABELED, deliveryId: 'd', event: 'issues', repository: 'acme/web', issue: 7, disposition: 'filtered' }] },
    ]) {
      const s = setup(evidence);
      expect(await s.scan()).toMatchObject({ flagged: 0 });
      expect(await s.wf()).toBeNull();
    }
  });

  it('reports a label applied again after its earlier job, when the new application never arrived', async () => {
    const s = setup({ jobs: [{ jobId: 'job_old', repository: 'acme/web', issue: 7, createdAt: new Date(Date.parse(LABELED) - 3 * 3_600_000).toISOString() }] });
    expect(await s.scan()).toMatchObject({ flagged: 1 });
  });

  it('leaves a label applied just now (its delivery may be in flight) or long ago alone', async () => {
    for (const ageMs of [QUIET_MS - 60_000, MAX_AGE_MS + 60_000]) {
      const s = setup({ event: { id: 1, actor: 'pat', createdAt: new Date(T0 - ageMs).toISOString(), label: 'updraft' } });
      await s.scan();
      expect(await s.wf()).toBeNull();
    }
  });

  it('looks at a tenant once an hour, and not at an inactive one or one without a config', async () => {
    const s = setup({ tenants: [{ installationId: 55, status: 'active', activeConfigVersion: 3 }, { installationId: 66, status: 'suspended', activeConfigVersion: 1 }, { installationId: 77, status: 'active' }] });
    await s.scan();
    s.tick(5 * 60_000);
    expect(await s.scan()).toMatchObject({ tenants: 0 });
    expect(s.tenants.getConfigVersion).toHaveBeenCalledTimes(1);
  });

  it('tries a failed look again at the next interval, from where the last successful one left off', async () => {
    const s = setup();
    await s.scan();
    s.tick(SCAN_INTERVAL_MS);
    s.github.labeledIssues.mockRejectedValueOnce(new Error('GitHub is down'));
    expect(await s.scan()).toMatchObject({ failed: 1 });
    s.tick(5 * 60_000);
    expect(await s.scan()).toMatchObject({ tenants: 0 });
    s.tick(SCAN_INTERVAL_MS);
    await s.scan();
    // Since the last success (T0) less an interval, not since the failed look.
    expect(s.github.labeledIssues).toHaveBeenLastCalledWith('ghs_x', 'acme/web', 'updraft', new Date(T0 - SCAN_INTERVAL_MS).toISOString(), expect.any(Number));
  });
});
