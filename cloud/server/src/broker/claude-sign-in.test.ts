// The broker's side of a job's Claude subscription sign-in (claude-sign-in actions), the
// console's (tenants/claude-sign-in-service.ts), and the comment that joins them.
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import { claudeSignInComment, claudeSignInPage } from '../jobs/claude-sign-in.js';
import { createMemoryStore, type Job } from '../store/store.js';
import { agentKeySecretName } from '../tenants/agent-keys.js';
import { createClaudeSignInService } from '../tenants/claude-sign-in-service.js';
import { createBroker, hashToken, type ClaudeSignInNotice } from './broker.js';

const NOW = Date.UTC(2026, 10, 22, 12);
const URL = 'https://claude.ai/oauth/authorize?IeTNORyX8crYI1Al5bOf5n3lUsK-AglIiTg2gkdiJuWw';
const TOKEN = `sk-ant-oat01-${'a1B2c3D4'.repeat(12)}`;
const caller: Caller = { sub: 's', email: 'pat@example.com' } as Caller;

describe("a job's Claude sign-in", () => {
  let store: ReturnType<typeof createMemoryStore>;
  let token: string;
  let notices: ClaudeSignInNotice[];
  let secrets: Map<string, string>;
  let broker: ReturnType<typeof createBroker>;
  const job = (over: Partial<Job> = {}): Job => ({
    jobId: 'job_signin01',
    tokenHash: hashToken(token),
    installationId: 55,
    repository: 'acme/web',
    repositoryId: 9,
    configVersion: 1,
    deliveryId: 'd-1',
    eventName: 'issues',
    status: 'launched',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: NOW + 3_600_000,
    issue: 12,
    agentKeys: ['ANTHROPIC_API_KEY'],
    claudeSignIn: { state: 'starting', at: new Date(NOW).toISOString() },
    ...over,
  });
  const call = (action: string, extra: Record<string, unknown> = {}) => broker({ action, jobId: 'job_signin01', token, ...extra });
  const signIn = async () => (await store.getJob('job_signin01'))?.claudeSignIn;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.putTenantWithMember(
      { installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '', createdBy: 's' },
      { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' },
    );
    token = randomBytes(32).toString('base64url');
    await store.putJob(job());
    notices = [];
    secrets = new Map();
    broker = createBroker({
      store,
      loadSettings: async () => null,
      github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
      assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(NOW + 3_600_000).toISOString() }),
      terminateMicrovm: async () => {},
      microvmState: async () => 'RUNNING',
      policy: { bucket: 'b', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
      notifyClaudeSignIn: async (n) => void notices.push(n),
      secrets: { put: async (name, value) => void secrets.set(name, value), remove: async (name) => void secrets.delete(name) },
      now: () => NOW,
    });
  });

  it('runs end to end: URL, comment, a member\'s code handed once, the token saved for later jobs', async () => {
    const started = (await call('start')) as { descriptor: { claudeSignIn?: true } };
    expect(started.descriptor.claudeSignIn).toBe(true);

    expect(await call('claude-sign-in-url', { url: URL })).toEqual({ ok: true, signIn: 'waiting' });
    expect(notices).toEqual([{ kind: 'needed', installationId: 55, jobId: 'job_signin01', repository: 'acme/web', repositoryId: 9, issue: 12 }]);
    // Only once, and only a claude.ai sign-in link.
    expect(await call('claude-sign-in-url', { url: URL })).toEqual({ ok: false, error: 'refused' });
    expect(await call('claude-sign-in-code')).toEqual({ ok: true, waiting: true });

    // The member gives the code in the console.
    const service = createClaudeSignInService({ store, github: { member: async () => ({ githubLogin: 'pat' }) as never }, now: () => NOW });
    const shown = await service.get(caller, 55, 'job_signin01');
    expect(shown).toMatchObject({ state: 'waiting', url: URL, repository: 'acme/web', issue: 12 });
    await service.submit(caller, 55, 'job_signin01', ' abc123def456#state789 ');
    expect(await signIn()).toMatchObject({ state: 'code', code: 'abc123def456#state789', by: 'pat' });

    expect(await call('claude-sign-in-code')).toEqual({ ok: true, code: 'abc123def456#state789' });
    // Handed once: gone from the record.
    expect((await signIn())?.code).toBeUndefined();
    expect(await call('claude-sign-in-code')).toEqual({ ok: false, error: 'refused' });

    expect(await call('claude-sign-in-token', { value: TOKEN })).toEqual({ ok: true, signIn: 'done' });
    expect(secrets.get(agentKeySecretName(55, 'CLAUDE_CODE_OAUTH_TOKEN'))).toBe(TOKEN);
    expect(await store.listAgentKeyMeta(55)).toMatchObject([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', updatedBy: 'pat' }]);
    expect(await signIn()).toMatchObject({ state: 'done', by: 'pat' });
    // Shown done, with no link and no code.
    expect(await service.get(caller, 55, 'job_signin01')).toEqual({ state: 'done', repository: 'acme/web', issue: 12, by: 'pat' });
  });

  it('refuses what is not a claude.ai link, or a token out of turn, and saves nothing that is not a token', async () => {
    await call('start');
    expect(await call('claude-sign-in-url', { url: 'https://evil.example/oauth/authorize?x=1' })).toEqual({ ok: false, error: 'bad_request' });
    expect(await call('claude-sign-in-token', { value: TOKEN })).toEqual({ ok: false, error: 'refused' });
    expect(secrets.size).toBe(0);
    await call('claude-sign-in-url', { url: URL });
    await store.updateClaudeSignIn('job_signin01', ['waiting'], { state: 'exchanging', at: new Date(NOW).toISOString() });
    expect(await call('claude-sign-in-token', { value: 'sk-ant-api03-notatoken' })).toEqual({ ok: false, error: 'bad_request' });
    expect(secrets.size).toBe(0);
    expect(await signIn()).toMatchObject({ state: 'failed' });
    expect(notices.at(-1)).toMatchObject({ kind: 'failed', reason: 'the token Claude gave could not be saved' });
  });

  it('records a failure once, with a reason that never carries a token, and says so on the issue', async () => {
    await call('start');
    await call('claude-sign-in-url', { url: URL });
    expect(await call('claude-sign-in-failed', { reason: `Claude did not accept the code ${TOKEN}` })).toEqual({ ok: true, signIn: 'failed' });
    expect((await signIn())?.reason).toBe('Claude did not accept the code [redacted]');
    expect(notices.at(-1)).toMatchObject({ kind: 'failed', reason: 'Claude did not accept the code [redacted]' });
    await call('claude-sign-in-failed', { reason: 'again' });
    expect(notices.filter((n) => n.kind === 'failed')).toHaveLength(1);
  });

  it('does not sign in when a Claude credential was set before the job started, and serves no sign-in to a job not started for one', async () => {
    await store.putAgentKeyMeta(55, { name: 'CLAUDE_CODE_OAUTH_TOKEN', updatedAt: new Date(NOW).toISOString(), updatedBy: 'pat' });
    const started = (await call('start')) as { descriptor: { claudeSignIn?: true } };
    expect(started.descriptor.claudeSignIn).toBeUndefined();
    expect(await signIn()).toMatchObject({ state: 'done' });

    await store.putJob(job({ jobId: 'job_plain001', claudeSignIn: undefined }));
    await broker({ action: 'start', jobId: 'job_plain001', token });
    expect(await broker({ action: 'claude-sign-in-url', jobId: 'job_plain001', token, url: URL })).toEqual({ ok: false, error: 'refused' });
  });

  it('marks a token Claude refused as rejected, hands it to no job after, and a new one clears that', async () => {
    await store.putAgentKeyMeta(55, { name: 'CLAUDE_CODE_OAUTH_TOKEN', updatedAt: new Date(NOW - 1000).toISOString(), updatedBy: 'pat' });
    await store.putJob(job({ jobId: 'job_token001', claudeSignIn: undefined }));
    const start = (await broker({ action: 'start', jobId: 'job_token001', token })) as { descriptor: { agentKeySecrets: Record<string, string> } };
    expect(start.descriptor.agentKeySecrets).toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    await broker({ action: 'finish', jobId: 'job_token001', token, outcome: 'failed', detail: { authFailed: true } });
    expect((await store.listAgentKeyMeta(55))[0]).toMatchObject({ name: 'CLAUDE_CODE_OAUTH_TOKEN', rejectedAt: new Date(NOW).toISOString() });

    await store.putJob(job({ jobId: 'job_after001', claudeSignIn: undefined }));
    const after = (await broker({ action: 'start', jobId: 'job_after001', token })) as { descriptor: { agentKeySecrets: Record<string, string> } };
    expect(after.descriptor.agentKeySecrets).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');

    await store.putAgentKeyMeta(55, { name: 'CLAUDE_CODE_OAUTH_TOKEN', updatedAt: new Date(NOW + 1).toISOString(), updatedBy: 'pat' });
    expect((await store.listAgentKeyMeta(55))[0]?.rejectedAt).toBeUndefined();
  });
});

describe('the console side of a sign-in', () => {
  it('is for members of the job\'s own installation, takes a code only while waiting, and only once', async () => {
    const store = createMemoryStore();
    await store.putJob({
      jobId: 'job_signin01',
      tokenHash: 'x',
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 9,
      configVersion: 1,
      deliveryId: 'd',
      eventName: 'issues',
      status: 'launched',
      createdAt: '',
      expiresAt: NOW + 1,
      issue: 12,
      claudeSignIn: { state: 'waiting', at: new Date(NOW).toISOString(), url: URL },
    });
    const member = vi.fn(async (_c: Caller, id: number) => {
      if (id !== 55 && id !== 66) throw new FlowError('not_authorized', 403, 'no');
      return { githubLogin: 'pat' } as never;
    });
    const service = createClaudeSignInService({ store, github: { member }, now: () => NOW });
    expect(await service.get(caller, 55, 'job_signin01')).toMatchObject({ state: 'waiting', url: URL, waitsUntil: new Date(NOW + 15 * 60_000).toISOString() });
    // Another installation's member: as if there were no such job.
    await expect(service.get(caller, 66, 'job_signin01')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.get(caller, 77, 'job_signin01')).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(service.submit(caller, 55, 'job_signin01', 'has spaces in it')).rejects.toMatchObject({ code: 'invalid_code' });
    await service.submit(caller, 55, 'job_signin01', 'abc123def456#state789');
    await expect(service.submit(caller, 55, 'job_signin01', 'abc123def456#state789')).rejects.toMatchObject({ code: 'sign_in_closed', status: 409 });
  });
});

describe('the sign-in comment', () => {
  const base = { installationId: 55, jobId: 'job_signin01', repository: 'acme/web', repositoryId: 9, issue: 12 };
  it('links members to the console page, never to claude.ai, and offers an API key instead', () => {
    const body = claudeSignInComment({ ...base, kind: 'needed' }, 'https://updraft.example/');
    expect(body).toContain(`[Sign in to Claude](${claudeSignInPage('https://updraft.example', 55, 'job_signin01')})`);
    expect(claudeSignInPage('https://updraft.example/', 55, 'job_signin01')).toBe('https://updraft.example/installations/55/claude-sign-in/job_signin01');
    expect(body).not.toContain('claude.ai');
    expect(body).toContain('[Agent keys](https://updraft.example/installations/55/keys)');
    expect(claudeSignInComment({ ...base, kind: 'failed', reason: 'no code was given within 15 minutes' }, 'https://updraft.example')).toMatch(/^\*\*The Claude sign-in did not finish:\*\* no code was given within 15 minutes\. Nothing was run\./);
  });
});
