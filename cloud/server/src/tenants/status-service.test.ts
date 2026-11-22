import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { finishDetail } from '../broker/broker.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import type { GitHubInstallation } from '../github/client.js';
import { deliveryFromLaunch } from '../jobs/deliveries.js';
import { jobResult } from '../jobs/status.js';
import { createMemoryStore, type Job, type Tenant } from '../store/store.js';
import { expireResults } from './results-retention.js';
import { createS3LogReader } from './s3-logs.js';
import { ACTIVITY_SAMPLE, createStatusService, LOG_TAIL_BYTES, missingPermissions, type LogReader, type StatusServiceDeps } from './status-service.js';

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

async function setup(opts: { installation?: GitHubInstallation | null | Error; logs?: Record<string, string>; retentionDays?: number; requestRetry?: StatusServiceDeps['requestRetry'] } = {}) {
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
    return { tenant: t, summary: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: t.status, role: 'owner' as const }, githubLogin: 'Pat' };
  };
  const clock = { now: Date.now() };
  const service = createStatusService({
    store,
    now: () => clock.now,
    resultRetentionDays: opts.retentionDays ?? 30,
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
    ...(opts.requestRetry ? { requestRetry: opts.requestRetry } : {}),
    log: () => {},
  });
  const app = createApp({ resolveCaller: () => caller, status: service, logError: () => {} });
  const get = async (path: string) => {
    const res = await app.request(`/api/v1/installations/${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('cache-control') };
  };
  const post = async (path: string) => {
    const res = await app.request(`/api/v1/installations/${path}`, { method: 'POST' });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { store, service, get, post, reads, clock };
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
        activity: {
          deliveries: { launched: 1, filtered: 1 },
          running: 1,
          lastDeliveryAt: '2026-11-20T12:01:00.000Z',
          window: { deliveries: 2, deliveriesComplete: true, jobs: 1, jobsComplete: true },
        },
      });
      // Configured first; one configured that the installation no longer reaches.
      expect(body.repositories).toEqual([
        { fullName: 'acme/gone', reachable: false, configured: true, paused: true },
        { fullName: 'acme/web', htmlUrl: 'https://github.com/acme/web', private: true, reachable: true, configured: true, paused: false },
        { fullName: 'acme/docs', htmlUrl: 'https://github.com/acme/docs', private: false, reachable: true, configured: false, paused: false },
      ]);
      expect((body.keys as unknown[]).length).toBe(2);
    });

    it("names only the labels the viewer may apply, in repositories the installation reaches, and whether traces are set up", async () => {
      const { store, get } = await setup();
      const v = await store.createConfigVersion(55, {
        sha256: 'x',
        files: ['config.yaml'],
        publishedBy: 'pat',
        publishedAt: '2026-11-20T10:00:00.000Z',
        dispatch: {
          repositories: {
            'acme/web': { id: 9, actors: ['pat'], triggers: [{ label: 'updraft' }, { label: 'updraft:review' }, { label: 'others', actors: ['sam'] }] },
            'acme/docs': { id: 10, paused: true, actors: ['pat'], triggers: [{ label: 'paused' }] },
            'acme/api': { id: 12, triggers: [{ label: 'theirs', actors: ['sam'] }] },
            'acme/gone': { id: 13, actors: ['pat'], triggers: [{ label: 'unreachable' }] },
          },
        },
      });
      await store.markConfigReady(55, v as number);
      await store.activateConfig(55, v as number);
      const first = (await get('55/overview')).body;
      expect((first.config as { triggers?: unknown }).triggers).toEqual([{ repository: 'acme/web', label: 'updraft' }, { repository: 'acme/web', label: 'updraft:review' }]);
      expect(first.config).not.toHaveProperty('replaced');
      expect(first.telemetry).toEqual({ configured: false, enabled: false });
      expect(first.activity).not.toHaveProperty('firstJobAt');
      await store.markFirstJob(55, '2026-11-20T11:00:00.000Z');
      expect((await get('55/overview')).body.activity).toMatchObject({ firstJobAt: '2026-11-20T11:00:00.000Z' });
      await store.putTelemetry(55, { provider: 'honeycomb', region: 'us', serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat' } }, 0);
      expect((await get('55/overview')).body.telemetry).toEqual({ configured: true, enabled: true });
    });

    it('seeds the first-job marker from a started job the records still keep, so it outlives them', async () => {
      const { store, get } = await setup();
      const j = job({ jobId: 'job_seed00001', createdAt: '2026-11-19T09:00:00.000Z' });
      await store.putJob(j);
      await store.startJob(j, j.expiresAt);
      await store.finishJob(j.jobId, 'succeeded', { at: Date.now() });
      expect((await get('55/overview')).body.activity).toMatchObject({ firstJobAt: '2026-11-19T09:00:00.000Z' });
      expect((await store.getTenant(55))?.firstJobAt).toBe('2026-11-19T09:00:00.000Z');
    });

    it('suggests no label in a repository GitHub now has under another id, and says it needs publishing again', async () => {
      const { store, get } = await setup();
      const v = await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml'], publishedBy: 'pat', publishedAt: '', dispatch: { repositories: { 'acme/web': { id: 99, actors: ['pat'], triggers: [{ label: 'updraft' }] } } } });
      await store.markConfigReady(55, v as number);
      await store.activateConfig(55, v as number);
      const { body } = await get('55/overview');
      expect(body.config).toMatchObject({ replaced: ['acme/web'] });
      expect(body.config).not.toHaveProperty('triggers');
    });

    it('says when its counts are of the latest deliveries only, not all 30 days', async () => {
      const { store, get } = await setup();
      for (let n = 0; n <= ACTIVITY_SAMPLE; n++) await store.recordDelivery(55, { at: `2026-11-20T12:00:${String(n).padStart(4, '0')}Z`, deliveryId: `d-${n}`, event: 'issues', disposition: 'filtered', reason: 'not_trigger' });
      const { body } = await get('55/overview');
      expect(body.activity).toMatchObject({ deliveries: { filtered: ACTIVITY_SAMPLE }, window: { deliveries: ACTIVITY_SAMPLE, deliveriesComplete: false, jobsComplete: true } });
    });

    it('shows a job every attempt of its delivery, an earlier failed one included, however many others arrived since', async () => {
      const { store, get } = await setup();
      await store.putJob(job());
      // The day before: the first attempt failed to launch; GitHub's redelivery (same id) launched this job.
      await store.recordDelivery(55, { at: '2026-11-19T12:00:00.000Z', deliveryId: 'd-1', event: 'issues', disposition: 'launch_failed', errorClass: 'ServiceException' });
      await store.recordDelivery(55, { at: '2026-11-20T11:59:59.000Z', deliveryId: 'd-1', event: 'issues', disposition: 'launched', jobId: 'job_status0001' });
      for (let n = 0; n < 250; n++) await store.recordDelivery(55, { at: `2026-11-20T13:00:${String(n).padStart(4, '0')}Z`, deliveryId: `other-${n}`, event: 'issues', disposition: 'filtered' });
      const { body } = await get('55/jobs/job_status0001');
      expect((body.deliveries as { deliveryId: string; disposition: string }[]).map((d) => [d.deliveryId, d.disposition])).toEqual([
        ['d-1', 'launch_failed'],
        ['d-1', 'launched'],
      ]);
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

  describe('retrying a job', () => {
    const failed = async (store: Awaited<ReturnType<typeof setup>>['store'], outcome = 'failed') => {
      await store.putJob(job());
      await store.finishJob('job_status0001', outcome);
    };

    it('marks the jobs that can be retried', async () => {
      const { store, get } = await setup();
      await failed(store);
      await store.putJob(job({ jobId: 'job_status0002', deliveryId: 'd-2' }));
      const jobs = (await get('55/jobs')).body.jobs as { jobId: string; retryable: boolean }[];
      expect(jobs.find((j) => j.jobId === 'job_status0001')!.retryable).toBe(true);
      expect(jobs.find((j) => j.jobId === 'job_status0002')!.retryable).toBe(false);
    });

    it("asks the launcher to run a failed job again, and answers with the new job's id", async () => {
      const requestRetry = vi.fn(async () => ({ ok: true as const, jobId: 'job_new000001' }));
      const { store, post } = await setup({ requestRetry });
      await failed(store);
      expect(await post('55/jobs/job_status0001/retry')).toEqual({ status: 202, body: { jobId: 'job_new000001' } });
      expect(requestRetry).toHaveBeenCalledWith(55, 'job_status0001');
    });

    it('refuses a job that is running or succeeded without asking the launcher', async () => {
      const requestRetry = vi.fn();
      const { store, post } = await setup({ requestRetry });
      await store.putJob(job());
      expect(await post('55/jobs/job_status0001/retry')).toMatchObject({ status: 409, body: { error: 'not_retryable', message: 'This job is still running' } });
      await store.finishJob('job_status0001', 'succeeded');
      expect(await post('55/jobs/job_status0001/retry')).toMatchObject({ status: 409, body: { error: 'not_retryable' } });
      expect(requestRetry).not.toHaveBeenCalled();
    });

    it("passes on the launcher's refusal with its status and words", async () => {
      const requestRetry = vi.fn(async () => ({ ok: false as const, status: 429, code: 'throttled' as const, message: 'over a usage limit' }));
      const { store, post } = await setup({ requestRetry });
      await failed(store);
      expect(await post('55/jobs/job_status0001/retry')).toEqual({ status: 429, body: { error: 'throttled', message: 'over a usage limit' } });
    });

    it('does not offer a job a retry already started one for, and says so', async () => {
      const requestRetry = vi.fn();
      const { store, get, post } = await setup({ requestRetry });
      await failed(store);
      const key = { installationId: 55, createdAt: job().createdAt, jobId: 'job_status0001' };
      await store.reserveJobRetry(key, 'tok', Date.now(), Date.now() + 60_000, 'job_new000001');
      await store.markJobRetried(key, 'tok', 'job_new000001');
      const listed = ((await get('55/jobs')).body.jobs as Record<string, unknown>[])[0]!;
      expect(listed).toMatchObject({ retryable: false, retriedAs: 'job_new000001' });
      expect(await post('55/jobs/job_status0001/retry')).toMatchObject({ status: 409, body: { error: 'already_retried' } });
      expect(requestRetry).not.toHaveBeenCalled();
    });

    it('does not offer a job of a pull request’s review loop', async () => {
      const requestRetry = vi.fn();
      const { store, get, post } = await setup({ requestRetry });
      await store.putJob(job({ jobId: 'job_status0003', deliveryId: 'd-3', issue: undefined, pullRequest: 40, eventName: 'pull_request_review' }));
      await store.finishJob('job_status0003', 'failed');
      expect(((await get('55/jobs')).body.jobs as Record<string, unknown>[])[0]).toMatchObject({ retryable: false });
      expect(await post('55/jobs/job_status0003/retry')).toMatchObject({ status: 409, body: { error: 'not_retryable', message: expect.stringContaining('review loop') } });
      expect(requestRetry).not.toHaveBeenCalled();
    });

    it('is for members only, and finds only the tenant’s own jobs', async () => {
      const requestRetry = vi.fn();
      const { store, post } = await setup({ requestRetry });
      await failed(store);
      expect((await post('56/jobs/job_status0001/retry')).status).toBe(403);
      expect((await post('55/jobs/job_nobody00001/retry')).status).toBe(404);
      expect((await post('55/jobs/not-a-job/retry')).status).toBe(404);
      expect(requestRetry).not.toHaveBeenCalled();
    });

    it('is not offered where no launcher is wired', async () => {
      const { store, post } = await setup();
      await failed(store);
      expect(await post('55/jobs/job_status0001/retry')).toMatchObject({ status: 503, body: { error: 'retry_unavailable' } });
    });
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

    it("links a pull request's job to that pull request, with no issue", async () => {
      const { store, get } = await setup();
      await store.putJob(job({ jobId: 'job_status0002', issue: undefined, pullRequest: 40, eventName: 'pull_request_review', deliveryId: 'd-2' }));
      const listed = ((await get('55/jobs')).body.jobs as Record<string, unknown>[]).find((j) => j.jobId === 'job_status0002')!;
      expect(listed).toMatchObject({ pullRequest: 40, prUrl: 'https://github.com/acme/web/pull/40' });
      expect(listed).not.toHaveProperty('issueUrl');
    });

    it("shows a job with the other recent jobs of its conversation, newest first", async () => {
      const { store, get } = await setup();
      const traceId = 'ab'.repeat(16);
      const finished = async (jobId: string, over: Partial<Job>, conversationId?: string) => {
        await store.putJob(job({ jobId, deliveryId: `d-${jobId}`, ...over }));
        await store.finishJob(jobId, 'succeeded', { at: Date.now(), detail: { telemetry: { traceId, spans: 1, exported: 1, failed: 0, ...(conversationId ? { conversationId } : {}) } } });
      };
      await finished('job_conv00001', { createdAt: '2026-11-20T10:00:00.000Z' });
      // A review of the issue's pull request: no issue on the job, the runner named the conversation.
      await finished('job_conv00002', { createdAt: '2026-11-20T11:00:00.000Z', issue: undefined, eventName: 'pull_request_review' }, 'acme/web#12');
      await finished('job_conv00003', { createdAt: '2026-11-20T12:00:00.000Z', issue: 13 });
      const { body } = await get('55/jobs/job_conv00001');
      expect((body.conversation as { jobId: string }[]).map((j) => j.jobId)).toEqual(['job_conv00002']);
      expect((await get('55/jobs/job_conv00002')).body.conversation).toMatchObject([{ jobId: 'job_conv00001' }]);
      expect((await get('55/jobs/job_conv00003')).body.conversation).toEqual([]);
    });

    it.each([
      [{ status: 'launched' }, 'running'],
      [{ status: 'finished', outcome: 'succeeded' }, 'success'],
      [{ status: 'finished', outcome: 'succeeded', detail: { updraftOutcome: 'nothing-to-do' } }, 'nothing_to_do'],
      [{ status: 'finished', outcome: 'succeeded', detail: { updraftOutcome: 'canceled' } }, 'canceled'],
      [{ status: 'finished', outcome: 'succeeded', detail: { updraftOutcome: 'superseded' } }, 'superseded'],
      [{ status: 'finished', outcome: 'failed', detail: { updraftOutcome: 'deferred' } }, 'deferred'],
      [{ status: 'finished', outcome: 'microvm_gone' }, 'terminated'],
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

    it('keeps the lifecycle as codes, counts and booleans only', () => {
      const d = finishDetail(
        { repository: 'acme/web' },
        {
          loop: { rounds: 2, maxRevisions: 3, reviews: 3, verdict: 'ready-to-merge', stage: 'merged', merged: true, detail: 'free text' },
          steps: [
            { kind: 'implement', agent: 'claude', outcome: 'succeeded', verificationPassed: true, publication: 'published' },
            { kind: 'review', agent: 'codex<script>', outcome: 'Not A Code' },
            { kind: 'deploy' },
            'nope',
          ],
        },
      );
      expect(d).toEqual({
        loop: { rounds: 2, maxRevisions: 3, reviews: 3, verdict: 'ready-to-merge', stage: 'merged', merged: true },
        steps: [{ kind: 'implement', agent: 'claude', outcome: 'succeeded', verificationPassed: true, publication: 'published' }, { kind: 'review' }],
      });
      expect(finishDetail({ repository: 'acme/web' }, { loop: { rounds: -1, reviews: 1 }, steps: [] })).toBeUndefined();
      expect(finishDetail({ repository: 'acme/web' }, { loop: { rounds: 0, reviews: 0, stage: 'launching-rockets' } })).toEqual({ loop: { rounds: 0, reviews: 0 } });
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

    it('answers 404 for a log the job did not upload', async () => {
      const { store, get, reads } = await setup({ logs: {} });
      await finished(store);
      expect((await get('55/jobs/job_status0001/logs/updraft.log')).status).toBe(404);
      expect((await get('55/jobs/job_status0001/logs/..%2F..%2Fconfig.yaml')).status).toBe(404);
      expect(reads).toEqual([]);
    });

    it('serves a log that is still there, however old; a missing one is expired (410) past the retention, else 502', async () => {
      const DAY = 24 * 3600 * 1000;
      const logs: Record<string, string> = {};
      const { store, get, clock } = await setup({ logs, retentionDays: 7 });
      await finished(store);
      // Within the retention: the reader found nothing (S3 says 403 for a missing object to this role).
      expect(await get('55/jobs/job_status0001/logs/run.log')).toMatchObject({ status: 502, body: { error: 'log_unavailable' } });
      // The stack's setting decides, not a default: missing on day 8 of 7 is expired.
      clock.now += 8 * DAY;
      expect(await get('55/jobs/job_status0001/logs/run.log')).toMatchObject({ status: 410, body: { error: 'log_expired' } });
      // At the boundary, a log the cleanup has not reached yet is still served.
      logs[KEY] = 'still here\n';
      expect(await get('55/jobs/job_status0001/logs/run.log')).toMatchObject({ status: 200, body: { text: 'still here\n' } });
    });
  });

  it("reads a log's end from S3, and takes the deployed role's 403 for a missing object as missing", async () => {
    const calls: unknown[] = [];
    const reader = (answer: () => unknown) =>
      createS3LogReader(
        {
          send: (async (cmd: { input: unknown }) => {
            calls.push(cmd.input);
            return answer();
          }) as never,
        },
        'tenant-bucket',
      );
    const ok = reader(() => ({ ContentRange: 'bytes 4-9/10', Body: { transformToString: async () => 'tail!\n' } }));
    expect(await ok('tenants/55/results/d/m/run.log', 6)).toEqual({ text: 'tail!\n', size: 10 });
    expect(calls[0]).toEqual({ Bucket: 'tenant-bucket', Key: 'tenants/55/results/d/m/run.log', Range: 'bytes=-6' });
    const fail = (name: string, status: number) => () => {
      throw Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
    };
    // Without s3:ListBucket, S3 answers a missing object with 403 AccessDenied.
    expect(await reader(fail('AccessDenied', 403))('k', 6)).toBeNull();
    expect(await reader(fail('NoSuchKey', 404))('k', 6)).toBeNull();
    expect(await reader(fail('InvalidRange', 416))('k', 6)).toEqual({ text: '', size: 0 });
    await expect(reader(fail('SlowDown', 503))('k', 6)).rejects.toThrow('SlowDown');
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
