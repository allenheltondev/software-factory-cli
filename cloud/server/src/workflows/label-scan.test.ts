import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { LabelEvent, LabeledIssue } from '../github/client.js';
import type { LaunchRequest, LaunchResult } from '../jobs/launch.js';
import { createLabelScanner, FIRST_LOOK_MS, labelDeliveryId, MAX_AGE_MS, QUIET_MS, SCAN_INTERVAL_MS } from './label-scan.js';
import { createWorkflowRecorder } from './recorder.js';
import { createMemoryWorkflowStore } from './store.js';

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SETTINGS = { appId: '4242', slug: 'updraft', privateKey, clientId: 'c', clientSecret: 's', webhookSecret: 'w' };

function setup(o: { issues?: LabeledIssue[]; event?: LabelEvent | null; launch?: LaunchResult; tenants?: unknown[] } = {}) {
  const store = createMemoryWorkflowStore();
  let clock = T0;
  const recorder = createWorkflowRecorder({ store, now: () => clock, log: () => {} });
  const tenants = {
    listTenants: vi.fn(async () => (o.tenants ?? [{ installationId: 55, status: 'active', activeConfigVersion: 3 }]) as never),
    getConfigVersion: vi.fn(async () => ({ dispatch: { repositories: { 'acme/web': { id: 99, triggers: [{ label: 'updraft' }, { label: 'Updraft' }] }, 'acme/paused': { id: 98, paused: true, triggers: [{ label: 'updraft' }] } } } }) as never),
  };
  const github = {
    createInstallationToken: vi.fn(async () => ({ token: 'ghs_x', expiresAt: clock + 3_600_000 })),
    labeledIssues: vi.fn(async () => o.issues ?? [{ number: 7, title: 'Add a widget', htmlUrl: 'https://github.com/acme/web/issues/7', labels: ['updraft'] }]),
    latestLabelEvent: vi.fn(async () => (o.event === undefined ? { id: 9001, actor: 'pat', createdAt: new Date(T0 - 30 * 60_000).toISOString(), label: 'updraft' } : o.event)),
  };
  const launched: LaunchRequest[] = [];
  const launch = vi.fn(async (req: LaunchRequest): Promise<LaunchResult> => {
    launched.push(req);
    const result = o.launch ?? { status: 202, disposition: 'launched', jobId: 'job_label00001' };
    // The launcher records the job's start on its workflow, as it does for any launch.
    if (result.disposition === 'launched') await recorder.started({ jobId: result.jobId!, installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, eventName: 'issues', deliveryId: req.deliveryId });
    return result;
  });
  const scan = createLabelScanner({ tenants, store, github, loadSettings: async () => SETTINGS as never, launch, now: () => clock, log: () => {} });
  return { store, scan, github, launch, launched, tenants, recorder, tick: (ms: number) => (clock += ms) };
}

describe('the missed-label scan', () => {
  it('dispatches a labeled issue that has no workflow as the delivery that was missed, once', async () => {
    const s = setup();
    expect(await s.scan()).toEqual({ tenants: 1, recovered: 1, refused: 0, failed: 0 });
    expect(s.github.labeledIssues).toHaveBeenCalledWith('ghs_x', 'acme/web', 'updraft', new Date(T0 - FIRST_LOOK_MS).toISOString(), 20);
    expect(s.github.createInstallationToken).toHaveBeenCalledWith(expect.any(String), 55, { repositoryIds: [99], permissions: { issues: 'read' } });
    const req = s.launched[0]!;
    expect(req).toMatchObject({ installationId: 55, eventName: 'issues', deliveryId: labelDeliveryId(55, 99, 7, 9001) });
    expect(JSON.parse(req.body)).toMatchObject({ action: 'labeled', issue: { number: 7 }, label: { name: 'updraft' }, repository: { id: 99, full_name: 'acme/web' }, sender: { login: 'pat' }, installation: { id: 55 } });
    // The paused repository is not looked at.
    expect(s.github.createInstallationToken).toHaveBeenCalledTimes(1);
    const events = await s.store.listWorkflowEvents(55, '99-i7', 10);
    // The recovery, then the job it started.
    expect(events.map((e) => e.kind)).toEqual(['label_recovered', 'job_started']);
    expect(events[0]!.message).toContain('by @pat');

    // An hour later: the issue has its workflow now, and the label event is claimed anyway.
    s.tick(SCAN_INTERVAL_MS);
    await s.scan();
    expect(s.launched).toHaveLength(1);
    expect(s.github.labeledIssues).toHaveBeenLastCalledWith('ghs_x', 'acme/web', 'updraft', new Date(T0 - SCAN_INTERVAL_MS).toISOString(), expect.any(Number));
  });

  it('looks at a tenant once an hour, and not at an inactive one or one without a config', async () => {
    const s = setup({ tenants: [{ installationId: 55, status: 'active', activeConfigVersion: 3 }, { installationId: 66, status: 'suspended', activeConfigVersion: 1 }, { installationId: 77, status: 'active' }] });
    await s.scan();
    s.tick(5 * 60_000);
    expect(await s.scan()).toMatchObject({ tenants: 0 });
    expect(s.tenants.getConfigVersion).toHaveBeenCalledTimes(1);
  });

  it('leaves a label applied just now (its delivery may be in flight) or long ago alone', async () => {
    for (const ageMs of [QUIET_MS - 60_000, MAX_AGE_MS + 60_000]) {
      const s = setup({ event: { id: 1, actor: 'pat', createdAt: new Date(T0 - ageMs).toISOString(), label: 'updraft' } });
      await s.scan();
      expect(s.launched).toEqual([]);
    }
  });

  it('acts on each label event once, even when the launcher refuses it', async () => {
    const s = setup({ launch: { status: 200, disposition: 'not_dispatched', reason: 'actor_not_allowed' } });
    expect(await s.scan()).toMatchObject({ recovered: 0, refused: 1 });
    s.tick(SCAN_INTERVAL_MS);
    await s.scan();
    expect(s.launched).toHaveLength(1);
  });

  it('skips an issue that already has a workflow', async () => {
    const s = setup();
    await s.recorder.started({ jobId: 'job_issue0001', installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, eventName: 'issues', deliveryId: 'd-1' });
    await s.scan();
    expect(s.github.latestLabelEvent).not.toHaveBeenCalled();
    expect(s.launched).toEqual([]);
  });

  it('isolates a failing tenant and tries it again at the next interval', async () => {
    const s = setup();
    s.github.labeledIssues.mockRejectedValueOnce(new Error('GitHub is down'));
    expect(await s.scan()).toMatchObject({ failed: 1 });
    s.tick(5 * 60_000);
    expect(await s.scan()).toMatchObject({ tenants: 0 });
    s.tick(SCAN_INTERVAL_MS);
    expect(await s.scan()).toMatchObject({ tenants: 1, recovered: 1 });
  });
});
