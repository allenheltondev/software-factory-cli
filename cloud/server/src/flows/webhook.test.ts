import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubInstallation } from '../github/client.js';
import { signBody, verifySignature } from '../github/signature.js';
import type { AppSettings } from '../github/settings.js';
import { createMemoryStore, type Tenant } from '../store/store.js';
import type { Launcher } from '../jobs/launch.js';
import { createWebhookHandler, RETENTION_MS } from './webhook.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SETTINGS = {
  appId: '1',
  slug: 'updraft',
  privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  webhookSecret: 'hook-secret',
} as AppSettings;
const NOW = Date.UTC(2026, 10, 19);
const tenant: Tenant = {
  installationId: 55,
  accountId: 900,
  accountLogin: 'acme',
  accountType: 'Organization',
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 'sub-pat',
};
const installation = (suspendedAt: string | null): GitHubInstallation => ({
  id: 55,
  account: { id: 900, login: 'acme', type: 'Organization' },
  suspendedAt,
});

/** `github` says what GitHub reports for installation 55 right now: an installation, gone (null), or an error. */
async function setup(github: { current: GitHubInstallation | null | Error } = { current: installation(null) }, launch?: Launcher,
  routing: Pick<Parameters<typeof createWebhookHandler>[0], 'routines' | 'benchmarkInstallationId' | 'queueEvents'> = {}) {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant, {
    installationId: 55,
    sub: 'sub-pat',
    role: 'owner',
    githubUserId: 101,
    githubLogin: 'pat',
    addedAt: tenant.createdAt,
  });
  const clock = { now: NOW };
  const handle = createWebhookHandler({
    store,
    github: {
      async getInstallation(jwt) {
        expect(jwt.split('.')).toHaveLength(3);
        if (github.current instanceof Error) throw github.current;
        return github.current;
      },
    },
    loadSettings: async () => SETTINGS,
    ...(launch ? { launch } : {}),
    ...routing,
    now: () => clock.now,
    log: () => {},
  });
  const deliver = (event: string, payload: unknown, secret = SETTINGS.webhookSecret) => {
    const body = JSON.stringify(payload);
    return handle({ body, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': 'd1', 'X-Hub-Signature-256': signBody(body, secret) } });
  };
  const lifecycle = (action: string, id = 55) => deliver('installation', { action, installation: { id } });
  return { store, handle, deliver, lifecycle, clock, github };
}

describe('verifySignature', () => {
  it('accepts the right signature only', () => {
    const body = '{"a":1}';
    expect(verifySignature(body, signBody(body, 's'), 's')).toBe(true);
    expect(verifySignature(body, signBody(body, 'other'), 's')).toBe(false);
    expect(verifySignature(`${body} `, signBody(body, 's'), 's')).toBe(false);
    expect(verifySignature(body, 'sha256=xyz', 's')).toBe(false);
    expect(verifySignature(body, undefined, 's')).toBe(false);
    expect(verifySignature(body, signBody(body, ''), '')).toBe(false);
  });
});

describe('webhook', () => {
  it.each([
    { label: 'Updraft:Benchmark', installationId: undefined },
    { label: 'updraft', installationId: 55 },
  ])('fences ordinary dispatch for $label when the benchmark installation is $installationId', async ({ label, installationId }) => {
    const launch = vi.fn<Launcher>(async () => ({ status: 202, disposition: 'launched' }));
    const routines = vi.fn(async () => null);
    const { deliver } = await setup(undefined, launch, { routines, ...(installationId ? { benchmarkInstallationId: installationId } : {}) });
    expect(await deliver('issues', { action: 'labeled', installation: { id: 55 }, issue: { number: 12 }, label: { name: label } }))
      .toMatchObject({ body: { disposition: 'not_dispatched' } });
    expect(routines).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
  it('refuses a bad signature before reading anything', async () => {
    const { deliver, store } = await setup();
    const res = await deliver('installation', { action: 'deleted', installation: { id: 55 } }, 'wrong');
    expect(res.status).toBe(401);
    expect((await store.getTenant(55))?.status).toBe('active');
  });

  it('answers 503 until the App is registered', async () => {
    const handle = createWebhookHandler({ store: createMemoryStore(), github: { getInstallation: async () => null }, loadSettings: async () => null, log: () => {} });
    expect((await handle({ body: '{}', headers: {} })).status).toBe(503);
  });

  describe('uninstall', () => {
    it('disables the tenant and gives it and its members the table TTL', async () => {
      const { lifecycle, store } = await setup();
      expect((await lifecycle('deleted')).body.disposition).toBe('tenant_uninstalled');
      expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'uninstalled', deleteAfter: NOW + RETENTION_MS });
      const ttl = Math.ceil((NOW + RETENTION_MS) / 1000);
      expect(store.ttlOf(55)).toEqual({ tenant: ttl, members: [ttl] });
    });

    it('keeps the first deadline when the delete is delivered again', async () => {
      const { lifecycle, store, clock } = await setup();
      await lifecycle('deleted');
      clock.now = NOW + 5 * 24 * 60 * 60 * 1000;
      expect((await lifecycle('deleted')).body.disposition).toBe('already_uninstalled');
      expect((await store.getTenant(55))?.deleteAfter).toBe(NOW + RETENTION_MS);
    });

    it('is final: a late suspend or unsuspend does not override it, whatever GitHub says', async () => {
      const github = { current: installation(null) as GitHubInstallation | null | Error };
      const { lifecycle, store } = await setup(github);
      await lifecycle('deleted');
      for (const [action, current] of [['suspend', installation('2026-11-18T00:00:00Z')], ['unsuspend', installation(null)]] as const) {
        github.current = current;
        expect((await lifecycle(action)).body.disposition).toBe('already_uninstalled');
        expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'uninstalled', deleteAfter: NOW + RETENTION_MS });
      }
    });

    it('a suspend whose installation is already gone on GitHub uninstalls it', async () => {
      const { lifecycle, store } = await setup({ current: null });
      expect((await lifecycle('suspend')).body.disposition).toBe('tenant_uninstalled');
      expect((await store.getTenant(55))?.disabledReason).toBe('uninstalled');
    });
  });

  describe('suspend and unsuspend follow GitHub, not delivery order', () => {
    it('records what GitHub reports now', async () => {
      const github = { current: installation('2026-11-19T00:00:00Z') as GitHubInstallation | null | Error };
      const { lifecycle, store } = await setup(github);
      expect((await lifecycle('suspend')).body.disposition).toBe('tenant_suspended');
      expect(await store.getTenant(55)).toMatchObject({ status: 'disabled', disabledReason: 'suspended' });

      github.current = installation(null);
      expect((await lifecycle('unsuspend')).body.disposition).toBe('tenant_active');
      const t = await store.getTenant(55);
      expect(t?.status).toBe('active');
      expect(t?.disabledReason).toBeUndefined();
    });

    it('a stale suspend delivered after the unsuspend leaves the tenant active', async () => {
      const { lifecycle, store } = await setup({ current: installation(null) });
      await lifecycle('unsuspend');
      expect((await lifecycle('suspend')).body.disposition).toBe('tenant_active');
      expect((await store.getTenant(55))?.status).toBe('active');
    });

    it('falls back to the event when GitHub cannot be asked', async () => {
      const { lifecycle, store } = await setup({ current: new Error('GitHub is down') });
      expect((await lifecycle('suspend')).body.disposition).toBe('tenant_suspended');
      expect((await store.getTenant(55))?.status).toBe('disabled');
    });
  });

  it('answers 500 when a write fails, so GitHub shows a delivery to redeliver, and the redelivery finishes it', async () => {
    const { store, deliver } = await setup();
    const markUninstalled = store.markUninstalled.bind(store);
    let calls = 0;
    store.markUninstalled = async (id, deadline) => {
      if (++calls === 1) throw new Error('throttled');
      return markUninstalled(id, deadline);
    };
    const first = await deliver('installation', { action: 'deleted', installation: { id: 55 } });
    expect(first).toEqual({ status: 500, body: { ok: false, disposition: 'error' } });
    const again = await deliver('installation', { action: 'deleted', installation: { id: 55 } });
    expect(again.body.disposition).toBe('tenant_uninstalled');
  });

  it('creates no tenant for an install or suspend of an installation never onboarded', async () => {
    const { lifecycle, store } = await setup();
    expect((await lifecycle('created', 66)).body.disposition).toBe('ignored');
    expect((await lifecycle('suspend', 66)).body.disposition).toBe('no_tenant');
    expect(await store.getTenant(66)).toBeNull();
  });

  it('records a delete of an installation never onboarded as an uninstalled tombstone that expires', async () => {
    const { deliver, store } = await setup();
    const res = await deliver('installation', { action: 'deleted', installation: { id: 66, account: { id: 7, login: 'late', type: 'User' } } });
    expect(res.body.disposition).toBe('tombstone');
    expect(await store.getTenant(66)).toMatchObject({ status: 'disabled', disabledReason: 'uninstalled', deleteAfter: NOW + RETENTION_MS, accountLogin: 'late' });
    expect(store.ttlOf(66).tenant).toBe(Math.ceil((NOW + RETENTION_MS) / 1000));
    // Nothing can be added to it.
    expect(await store.putTenantWithMember({ ...tenant, installationId: 66 }, { installationId: 66, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'x', addedAt: '' })).toBe('uninstalled');
  });

  it('answers ping and acknowledges other events without acting', async () => {
    const { deliver } = await setup();
    expect((await deliver('ping', { zen: 'hi' })).body.disposition).toBe('pong');
    expect((await deliver('issues', { action: 'opened', installation: { id: 55 } })).body).toEqual({ ok: true, disposition: 'ignored' });
    expect((await deliver('pull_request', { action: 'synchronize', installation: { id: 55 } })).body).toEqual({ ok: true, disposition: 'ignored' });
    // Without a launcher (local development), a labeled issue starts nothing.
    expect((await deliver('issues', { action: 'labeled', installation: { id: 55 } })).body).toEqual({ ok: true, disposition: 'jobs_not_configured' });
  });

  it('hands a labeled issue to the launcher, with the body exactly as signed, and answers as it does', async () => {
    const calls: Parameters<Launcher>[0][] = [];
    const answers = [
      { status: 202, disposition: 'launched', jobId: 'job_1' },
      { status: 500, disposition: 'launch_failed' },
    ];
    const launch: Launcher = async (req) => {
      calls.push(req);
      return answers.shift()!;
    };
    const { deliver } = await setup(undefined, launch);
    const payload = { action: 'labeled', installation: { id: 55 }, label: { name: 'updraft' }, repository: { id: 9, full_name: 'acme/web' } };
    const first = await deliver('issues', payload);
    expect(first).toEqual({ status: 202, body: { ok: true, disposition: 'launched' } });
    expect(calls[0]).toMatchObject({ installationId: 55, deliveryId: 'd1', body: JSON.stringify(payload), payload: { label: { name: 'updraft' } } });
    expect(await deliver('issues', payload)).toEqual({ status: 500, body: { ok: false, disposition: 'launch_failed' } });
    // An event for no installation never reaches it.
    await deliver('issues', { action: 'labeled' });
    expect(calls).toHaveLength(2);
  });

  it("hands the review loop's pull request events to the launcher, with the event and the App's own login, and records them by pull request", async () => {
    const calls: Parameters<Launcher>[0][] = [];
    const launch: Launcher = async (req) => {
      calls.push(req);
      return calls.length === 1 ? { status: 202, disposition: 'launched', jobId: 'job_pr' } : { status: 200, disposition: 'coalesced', message: 'a job for pull request #40 starts in a few seconds' };
    };
    const { deliver, store } = await setup(undefined, launch);
    const review = { action: 'submitted', installation: { id: 55 }, repository: { id: 9, full_name: 'acme/web' }, pull_request: { number: 40, head: { ref: 'updraft/issue-1-a' } }, review: { state: 'changes_requested' }, sender: { login: 'pat' } };
    expect(await deliver('pull_request_review', review)).toEqual({ status: 202, body: { ok: true, disposition: 'launched' } });
    expect(calls[0]).toMatchObject({ installationId: 55, eventName: 'pull_request_review', appBot: `${SETTINGS.slug}[bot]`, payload: { pull_request: { number: 40 } } });
    await deliver('pull_request', { ...review, action: 'synchronize' });
    // An action that leads to no work never reaches it.
    await deliver('pull_request', { ...review, action: 'opened' });
    expect(calls.map((c) => c.eventName)).toEqual(['pull_request_review', 'pull_request']);
    const listed = (await store.listDeliveries(55, 10)).map((d) => [d.event, d.action, d.pullRequest, d.disposition]);
    expect(listed).toHaveLength(3);
    expect(listed).toEqual(
      expect.arrayContaining([
        ['pull_request', 'opened', 40, 'filtered'],
        ['pull_request', 'synchronize', 40, 'coalesced'],
        ['pull_request_review', 'submitted', 40, 'launched'],
      ]),
    );
  });

  it('rejects a signed body that is not JSON', async () => {
    const { handle } = await setup();
    const body = 'not json';
    const res = await handle({ body, headers: { 'x-github-event': 'installation', 'x-hub-signature-256': signBody(body, 'hook-secret') } });
    expect(res.status).toBe(400);
  });

  describe('the deliveries list (#71)', () => {
    const labeled = { action: 'labeled', installation: { id: 55 }, repository: { id: 9, full_name: 'acme/web' }, issue: { number: 12 }, label: { name: 'updraft' }, sender: { login: 'pat' } };

    it("records what became of a tenant's labeled issue, with the event's details", async () => {
      const launch: Launcher = async () => ({ status: 500, disposition: 'launch_failed', jobId: 'job_1', errorClass: 'ServiceException' });
      const { deliver, store } = await setup(undefined, launch);
      await deliver('issues', labeled);
      expect(await store.listDeliveries(55, 5)).toEqual([
        {
          at: new Date(NOW).toISOString(),
          deliveryId: 'd1',
          event: 'issues',
          action: 'labeled',
          repository: 'acme/web',
          issue: 12,
          label: 'updraft',
          sender: 'pat',
          disposition: 'launch_failed',
          errorClass: 'ServiceException',
          jobId: 'job_1',
        },
      ]);
    });

    it('lists work events Updraft Cloud does not take as filtered, and never lifecycle events or other installations', async () => {
      const { deliver, lifecycle, store } = await setup(undefined, async () => ({ status: 200, disposition: 'no_tenant' }));
      await deliver('pull_request', { action: 'opened', installation: { id: 55 }, repository: { full_name: 'acme/web' } });
      await deliver('issues', { ...labeled, action: 'opened' });
      await deliver('issues', { ...labeled, installation: { id: 77 } });
      await deliver('pull_request', { action: 'opened', installation: { id: 77 } });
      await lifecycle('suspend');
      expect((await store.listDeliveries(55, 10)).map((d) => [d.event, d.action, d.disposition, d.reason])).toEqual([
        ['pull_request', 'opened', 'filtered', 'event_not_accepted'],
        ['issues', 'opened', 'filtered', 'event_not_accepted'],
      ]);
      expect(await store.listDeliveries(77, 10)).toEqual([]);
    });

    it('records a launch that fails before the launcher handles it, and still answers 500', async () => {
      const launch: Launcher = async () => {
        throw Object.assign(new Error('Rate exceeded: secret detail'), { name: 'ProvisionedThroughputExceededException' });
      };
      const { deliver, store } = await setup(undefined, launch);
      expect(await deliver('issues', labeled)).toMatchObject({ status: 500 });
      expect(await store.listDeliveries(55, 5)).toEqual([expect.objectContaining({ disposition: 'launch_failed', errorClass: 'ProvisionedThroughputExceededException' })]);
      expect(JSON.stringify(await store.listDeliveries(55, 5))).not.toContain('secret detail');
    });

    it('answers the delivery even when it cannot be recorded', async () => {
      const launch: Launcher = async () => ({ status: 202, disposition: 'launched', jobId: 'job_1' });
      const { deliver, store } = await setup(undefined, launch);
      store.recordDelivery = async () => {
        throw new Error('throttled');
      };
      expect(await deliver('issues', labeled)).toEqual({ status: 202, body: { ok: true, disposition: 'launched' } });
    });
  });
});

describe('queued work and its issue', () => {
  const issueEvent = (action: string, label?: string) => ({ action, installation: { id: 55 }, repository: { id: 9, full_name: 'acme/web' }, issue: { number: 12 }, ...(label ? { label: { name: label } } : {}), sender: { login: 'pat' } });
  it('cancels queued work when its label is removed or its issue closed, and records it', async () => {
    const subjectChanged = vi.fn(async () => true);
    const { deliver, store } = await setup(undefined, undefined, { queueEvents: { subjectChanged } });
    expect(await deliver('issues', issueEvent('unlabeled', 'updraft'))).toEqual({ status: 200, body: { ok: true, disposition: 'queue_canceled' } });
    expect(subjectChanged).toHaveBeenCalledWith(55, 9, { issue: 12 }, { kind: 'unlabeled', label: 'updraft' });
    expect(await deliver('issues', issueEvent('closed'))).toMatchObject({ body: { disposition: 'queue_canceled' } });
    expect(subjectChanged).toHaveBeenLastCalledWith(55, 9, { issue: 12 }, { kind: 'closed' });
    expect((await store.listDeliveries(55, 5)).map((d) => d.reason)).toEqual(['queue_canceled', 'queue_canceled']);
  });
  it('is an ordinary filtered delivery when nothing was queued', async () => {
    const { deliver } = await setup(undefined, undefined, { queueEvents: { subjectChanged: async () => false } });
    expect(await deliver('issues', issueEvent('unlabeled', 'updraft'))).toMatchObject({ body: { disposition: 'ignored' } });
  });
});
