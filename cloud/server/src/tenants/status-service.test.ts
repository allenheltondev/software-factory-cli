import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { finishDetail } from '../broker/broker.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import type { GitHubInstallation } from '../github/client.js';
import { deliveryFromLaunch } from '../jobs/deliveries.js';
import { jobResult } from '../jobs/status.js';
import { createMemoryStore, type Job, type Tenant } from '../store/store.js';
import { expireResults } from './results-retention.js';
import { createStatusService, LOG_TAIL_BYTES, missingPermissions, type LogReader } from './status-service.js';

const caller = { sub: 'u1' } as Caller;
const ALL = { metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', checks: 'read', statuses: 'read' };
const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  installationId: 55,
  accountId: 900,
  accountLogin: 'acme',
  accountType: 'Organization',
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 's',
  ...over,
});
const job = (over: Partial<Job> = {}): Job => ({
  jobId: 'job_status0001',
  tokenHash: 'ab',
  installationId: 55,
  repository: 'acme/web',
  repositoryId: 9,
  configVersion: 2,
  deliveryId: 'd-1',
  eventName: 'issues',
  status: 'launched',
  createdAt: '2026-11-20T12:00:00.000Z',
  expiresAt: Date.now() + 3_600_000,
  issue: 12,
  ...over,
});

async function setup(opts: { installation?: GitHubInstallation | null | Error; logs?: Record<string, string> } = {}) {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant(), { installationId: 55, sub: 'u1', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
  const gh = 'installation' in opts ? opts.installation : { id: 55, account: { id: 900, login: 'acme', type: 'Organization' }, suspendedAt: null, permissions: ALL };
  const reads: string[] = [];
  const readLog: LogReader = async (key, max) => {
    reads.push(key);
    const text = opts.logs?.[key];
    return text === undefined ? null : { text: text.slice(-max), size: text.length };
  };
  const member = async (_c: Caller, id: number) => {
    if (id !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    const t = (await store.getTenant(55))!;
    return { tenant: t, summary: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: t.status, role: 'owner' as const } };
  };
  const service = createStatusService({
    store,
    github: {
      member,
      installation: async (c, id) => {
        await member(c, id);
        if (gh instanceof Error) throw gh;
        return gh ?? null;
      },
      repositories: async () => ({
        tenant: {} as never,
        repositories: [
          { id: 9, fullName: 'acme/web', private: true, htmlUrl: 'https://github.com/acme/web' },
          { id: 10, fullName: 'acme/docs', private: false, htmlUrl: 'https://github.com/acme/docs' },
        ],
      }),
    },
    agentKeys: { list: async () => ({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true }, { name: 'CODEX_API_KEY', configured: false, required: false }], refusals: [] }) },
    readLog,
    log: () => {},
  });
  const app = createApp({ resolveCaller: () => caller, status: service, logError: () => {} });
  const get = async (path: string) => {
    const res = await app.request(`/api/v1/installations/${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('cache-control') };
  };
  return { store, service, get, reads };
}

describe('status and diagnostics (#71)', () => {
  describe('the overview', () => {
    it('shows an active installation with its repositories, config, keys and activity', async () => {
      const { store, get } = await setup();
      const v = await store.createConfigVersion(55, {
        sha256: 'x',
        files: ['config.yaml'],
        publishedBy: 'pat',
        publishedAt: '2026-11-20T10:00:00.000Z',
        dispatch: { repositories: { 'acme/web': { id: 9, triggers: [] }, 'acme/gone': { id: 11, paused: true, triggers: [] } } },
      });
      await store.markConfigReady(55, v as number);
      await store.activateConfig(55, v as number);
      await store.recordDelivery(55, { at: '2026-11-20T12:00:00.000Z', deliveryId: 'd-1', event: 'issues', disposition: 'launched' });
      await store.recordDelivery(55, { at: '2026-11-20T12:01:00.000Z', deliveryId: 'd-2', event: 'issues', disposition: 'filtered', reason: 'not_trigger' });
      await store.putJob(job());
      const { status, body, cache } = await get('55/overview');
      expect(status).toBe(200);
      expect(cache).toBe('no-store');
      expect(body).toMatchObject({
        installation: { status: 'active', checked: true, missingPermissions: [] },
        config: { activeVersion: 1, publishedBy: 'pat' },
        activity: { deliveries: { launched: 1, filtered: 1 }, running: 1, lastDeliveryAt: '2026-11-20T12:01:00.000Z' },
      });
      // Configured first; one configured that the installation no longer reaches.
      expect(body.repositories).toEqual([
        { fullName: 'acme/gone', reachable: false, configured: true, paused: true },
        { fullName: 'acme/web', htmlUrl: 'https://github.com/acme/web', private: true, reachable: true, configured: true, paused: false },
        { fullName: 'acme/docs', htmlUrl: 'https://github.com/acme/docs', private: false, reachable: true, configured: false, paused: false },
      ]);
      expect((body.keys as unknown[]).length).toBe(2);
    });

    it.each([
      ['suspended on GitHub', { id: 55, account: { id: 900, login: 'acme', type: 'Organization' }, suspendedAt: '2026-11-20T00:00:00Z', permissions: ALL }, 'suspended', true],
      ['gone from GitHub', null, 'uninstalled', true],
      ['missing a permission', { id: 55, account: { id: 900, login: 'acme', type: 'Organization' }, suspendedAt: null, permissions: { ...ALL, contents: 'read' } }, 'missing_permissions', true],
      ['GitHub not answering (last known status)', new Error('timeout'), 'active', false],
    ] as const)('says when the installation is %s', async (_what, installation, expected, checked) => {
      const { get } = await setup({ installation: installation as never });
      const { body } = await get('55/overview');
      expect(body.installation).toMatchObject({ status: expected, checked });
    });

    it('names each permission below what jobs need', () => {
      expect(missingPermissions({ ...ALL, contents: 'read', pull_requests: undefined as never })).toEqual([
        { name: 'contents', needs: 'write', granted: 'read' },
        { name: 'pull_requests', needs: 'write' },
      ]);
      expect(missingPermissions({ ...ALL, contents: 'admin' })).toEqual([]);
    });
  });

  it("refuses another tenant's overview, deliveries, jobs and logs", async () => {
    const { get } = await setup();
    for (const path of ['56/overview', '56/deliveries', '56/jobs', '56/jobs/job_status0001', '56/jobs/job_status0001/logs/run.log']) {
      expect((await get(path)).status, path).toBe(403);
    }
  });

  describe('jobs', () => {
    it('lists each with how it ended, its issue and pull request, version and duration', async () => {
      const { store, get } = await setup();
      await store.putJob(job());
      await store.startJob(job(), Date.now() + 3_600_000);
      await store.attachMicrovm('job_status0001', 'mvm-1');
      const startedAt = (await store.getJob('job_status0001'))!.startedAt!;
      await store.finishJob('job_status0001', 'succeeded', {
        at: startedAt + 125_000,
        detail: { updraftOutcome: 'succeeded', prUrl: 'https://github.com/acme/web/pull/7', prNumber: 7, logs: ['updraft.log', 'run.log'] },
      });
      const { body } = await get('55/jobs');
      expect((body.jobs as unknown[])[0]).toMatchObject({
        jobId: 'job_status0001',
        result: 'success',
        configVersion: 2,
        durationSeconds: 125,
        issueUrl: 'https://github.com/acme/web/issues/12',
        prUrl: 'https://github.com/acme/web/pull/7',
        logs: ['updraft.log', 'run.log'],
      });
      expect((await get('55/jobs/job_status0001')).body).toMatchObject({ job: { result: 'success' } });
      expect((await get('55/jobs/job_nobody00001')).status).toBe(404);
    });

    it.each([
      [{ status: 'launched' }, 'running'],
      [{ status: 'finished', outcome: 'succeeded' }, 'success'],
      [{ status: 'finished', outcome: 'succeeded', detail: { updraftOutcome: 'nothing-to-do' } }, 'nothing_to_do'],
      [{ status: 'finished', outcome: 'failed' }, 'agent_failure'],
      [{ status: 'finished', outcome: 'failed', detail: { verificationPassed: false } }, 'verify_failure'],
      [{ status: 'finished', outcome: 'failed', detail: { updraftOutcome: 'publish-failed' } }, 'publish_failure'],
      [{ status: 'finished', outcome: 'timed_out' }, 'timeout'],
      [{ status: 'finished', outcome: 'state_not_saved' }, 'state_not_saved'],
      [{ status: 'finished', outcome: 'throttled' }, 'not_run'],
      [{ status: 'finished', outcome: 'something_new' }, 'other'],
    ] as const)('classifies %o as %s', (summary, expected) => {
      expect(jobResult(summary as never)).toBe(expected);
    });

    it('keeps only what checks out from a finish: a pull request of the job\'s own repository, known logs', () => {
      expect(
        finishDetail({ repository: 'acme/web' }, { updraftOutcome: 'failed', verificationPassed: false, prUrl: 'https://github.com/ACME/web/pull/7', logs: ['run.log', '../../x', 'run.log'] }),
      ).toEqual({ updraftOutcome: 'failed', verificationPassed: false, prUrl: 'https://github.com/ACME/web/pull/7', prNumber: 7, logs: ['run.log'] });
      expect(finishDetail({ repository: 'acme/web' }, { prUrl: 'https://github.com/evil/web/pull/7', updraftOutcome: 'Robert"); DROP' })).toBeUndefined();
      expect(finishDetail({ repository: 'acme/web' }, 'nope')).toBeUndefined();
    });
  });

  describe('logs', () => {
    const finished = async (store: ReturnType<typeof createMemoryStore>, logs = ['run.log']) => {
      await store.putJob(job());
      await store.startJob(job(), Date.now() + 3_600_000);
      await store.attachMicrovm('job_status0001', 'mvm-1');
      await store.finishJob('job_status0001', 'failed', { at: Date.now(), detail: { logs } });
    };
    const KEY = 'tenants/55/results/d-1/mvm-1/run.log';

    it("serves the end of a job's log from its tenant's results, redacted", async () => {
      const { store, get, reads } = await setup({ logs: { [KEY]: 'agent said hi\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n' } });
      await finished(store);
      const { status, body } = await get('55/jobs/job_status0001/logs/run.log');
      expect(status).toBe(200);
      expect(body).toEqual({ name: 'run.log', text: 'agent said hi\nAuthorization: Bearer [redacted]\n', size: 63, truncated: false });
      expect(reads).toEqual([KEY]);
    });

    it('cuts a long log to its end, at a whole line', async () => {
      const long = `${'old line\n'.repeat(LOG_TAIL_BYTES / 9 + 10)}the failure\n`;
      const { store, get } = await setup({ logs: { [KEY]: long } });
      await finished(store);
      const { body } = await get('55/jobs/job_status0001/logs/run.log');
      expect(body).toMatchObject({ truncated: true, size: long.length });
      expect(String(body.text).startsWith('old line\n')).toBe(true);
      expect(String(body.text).endsWith('the failure\n')).toBe(true);
    });

    it('answers 404 for a log the job did not upload, and 410 for one that has expired', async () => {
      const { store, get, reads } = await setup({ logs: {} });
      await finished(store);
      expect((await get('55/jobs/job_status0001/logs/updraft.log')).status).toBe(404);
      expect((await get('55/jobs/job_status0001/logs/..%2F..%2Fconfig.yaml')).status).toBe(404);
      expect(reads).toEqual([]);
      expect((await get('55/jobs/job_status0001/logs/run.log')).body).toMatchObject({ error: 'log_expired' });
    });
  });

  it('records each delivery as one disposition', () => {
    const base = { at: 't', deliveryId: 'd', event: 'issues' };
    expect(deliveryFromLaunch(base, { status: 200, disposition: 'not_dispatched', reason: 'paused', message: 'the repository is paused' })).toMatchObject({ disposition: 'filtered', reason: 'paused' });
    expect(deliveryFromLaunch(base, { status: 200, disposition: 'ignored' })).toMatchObject({ disposition: 'filtered', reason: 'event_not_accepted' });
    expect(deliveryFromLaunch(base, { status: 200, disposition: 'duplicate' })).toMatchObject({ disposition: 'deduped' });
    expect(deliveryFromLaunch(base, { status: 200, disposition: 'throttled', reason: 'jobs_per_day' })).toMatchObject({ disposition: 'throttled', reason: 'jobs_per_day' });
    expect(deliveryFromLaunch(base, { status: 500, disposition: 'launch_failed', jobId: 'job_x', errorClass: 'ServiceQuotaExceededException' })).toMatchObject({
      disposition: 'launch_failed',
      errorClass: 'ServiceQuotaExceededException',
    });
    expect(deliveryFromLaunch(base, { status: 202, disposition: 'launched', jobId: 'job_x' })).toMatchObject({ disposition: 'launched', jobId: 'job_x' });
    expect(deliveryFromLaunch(base, { status: 200, disposition: 'no_tenant' })).toBeNull();
  });

  it('expires results past the retention, per tenant, and carries on past a tenant that fails', async () => {
    const DAY = 24 * 3600 * 1000;
    const now = Date.UTC(2026, 10, 21);
    const deleted: string[] = [];
    const out = await expireResults({
      store: { listTenants: async () => [tenant(), tenant({ installationId: 66 }), tenant({ installationId: 77 })] },
      async listDated(prefix) {
        if (prefix === 'tenants/66/results/') throw new Error('boom');
        return [
          { key: `${prefix}d-old/mvm/run.log`, lastModified: now - 31 * DAY },
          { key: `${prefix}d-new/mvm/run.log`, lastModified: now - 29 * DAY },
        ];
      },
      async deleteObjects(keys) {
        deleted.push(...keys);
      },
      retentionDays: 30,
      now: () => now,
      log: () => {},
    });
    expect(deleted).toEqual(['tenants/55/results/d-old/mvm/run.log', 'tenants/77/results/d-old/mvm/run.log']);
    expect(out).toEqual({ deleted: 2, failed: [66] });
  });
});
