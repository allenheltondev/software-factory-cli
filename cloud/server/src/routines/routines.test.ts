import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createWebhookHandler } from '../flows/webhook.js';
import { createRoutineDispatcher, fireRoutine } from './dispatch.js';
import { createRoutineService } from './service.js';
import { routineId, routineLabel, routineSecretName, validRoutineToken, validRoutineUrl, type RoutineRule, type RoutineRuleStore } from './rules.js';

const repo = 'acme/web';
const url = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire';
const token = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';
const rule: RoutineRule = { id: routineId(9, 'art'), repositoryId: 9, repository: repo, label: 'art', url, updatedAt: '', updatedBy: 'pat', allowedActors: ['pat'], credentialId: '11111111-1111-4111-8111-111111111111' };
const event = { action: 'labeled', repository: { id: 9, full_name: repo }, issue: { number: 12 }, label: { name: 'art' }, sender: { login: 'pat' } };

function memoryRules(): RoutineRuleStore {
  const rows = new Map<string, RoutineRule>();
  const key = (id: number, ruleId: string) => `${id}/${ruleId}`;
  return {
    list: async (id) => [...rows].filter(([k]) => k.startsWith(`${id}/`)).map(([, value]) => value),
    get: async (id, ruleId) => rows.get(key(id, ruleId)) ?? null,
    put: async (id, value, expected) => {
      if (rows.get(key(id, value.id))?.credentialId !== expected) return 'conflict';
      rows.set(key(id, value.id), value); return 'stored';
    },
    remove: async (id, ruleId, expected) => {
      if (rows.get(key(id, ruleId))?.credentialId !== expected) return false;
      rows.delete(key(id, ruleId)); return true;
    },
  };
}

function memoryDispatchStore() {
  const claimed = new Map<string, { jobId: string; expiresAt: number }>();
  return {
    getTenant: async () => ({ status: 'active' }),
    getConfigVersion: vi.fn(),
    listDeliveriesOf: vi.fn().mockResolvedValue([]),
    getDeliveryClaim: async (_id: number, delivery: string) => claimed.get(delivery) ?? null,
    claimDelivery: async (_id: number, delivery: string, expiresAt: number, jobId: string) => {
      if (claimed.has(delivery)) return false;
      claimed.set(delivery, { jobId, expiresAt }); return true;
    },
  };
}

describe('Claude Code scheduled-task API triggers', () => {
  it('validates only official per-routine endpoints, never arbitrary user supplied URLs', () => {
    expect(validRoutineUrl(url)).toBe(true);
    for (const s of [
      'https://api.anthropic.com.evil.test/v1/claude_code/routines/trig_1/fire',
      'http://api.anthropic.com/v1/claude_code/routines/trig_1/fire',
      'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire?next=evil',
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com@evil.test/v1/claude_code/routines/trig_1/fire',
    ]) expect(validRoutineUrl(s)).toBe(false);
    expect(validRoutineToken(token)).toBe(true);
    expect(validRoutineToken('sk-ant-api03-thisisanapikeynotaroutinetoken')).toBe(false);
    expect(routineLabel(' Art ')).toBe('art');
    expect(routineId(9, 'ART')).toBe(routineId(9, 'art'));
  });

  it('fires with Anthropic headers and contextual text, returns the cloud session link', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: 'routine_fire', claude_code_session_id: 'session_01ABC', claude_code_session_url: 'https://claude.ai/code/session_01ABC',
    }), { status: 200 }));
    expect(await fireRoutine(rule, token, 'Review issue 12', fetchImpl)).toEqual({ kind: 'created', sessionUrl: 'https://claude.ai/code/session_01ABC' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [target, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(url);
    expect((request.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
    expect((request.headers as Record<string, string>)['anthropic-version']).toBe('2026-10-21');
    expect(JSON.parse(request.body as string)).toEqual({ text: 'Review issue 12' });
  });

  it('routes only matching labels, records successful triggers once, and reports the session', async () => {
    const rules = memoryRules();
    await rules.put(55, rule);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_01ABC',
    }), { status: 200 }));
    const notifyRun = vi.fn().mockResolvedValue(undefined);
    const route = createRoutineDispatcher({
      rules,
      store: memoryDispatchStore() as never,
      readToken: async (name) => name === routineSecretName(55, rule.id, rule.credentialId) ? token : null,
      fetchImpl,
      notifyRun,
    });
    const input = { installationId: 55, deliveryId: 'delivery-1', eventName: 'issues', payload: event };
    expect(await route({ ...input, deliveryId: 'other-delivery', payload: { ...event, label: { name: 'other' } } })).toBeNull();
    expect(await route(input)).toMatchObject({ disposition: 'routine_triggered', message: 'https://claude.ai/code/session_01ABC' });
    expect(await route(input)).toMatchObject({ disposition: 'deduped' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(notifyRun).toHaveBeenCalledOnce();
  });

  it('does not retry ambiguous errors because a fire may have succeeded remotely', async () => {
    const rules = memoryRules(); await rules.put(55, rule);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket timeout'));
    const route = createRoutineDispatcher({
      rules,
      store: memoryDispatchStore() as never,
      readToken: async () => token, fetchImpl,
    });
    expect(await route({ installationId: 55, deliveryId: 'd', eventName: 'issues', payload: event })).toMatchObject({
      status: 200, disposition: 'routine_unknown', reason: 'ambiguous_network_error',
    });
  });

  it('requires installation membership and never returns a stored token', async () => {
    const rules = memoryRules();
    const secrets = { put: vi.fn(), remove: vi.fn() };
    const service = createRoutineService({
      rules, secrets, store: { getTenant: async () => ({ status: 'active' }) } as never,
      github: {
        member: vi.fn().mockResolvedValue({}),
        configContext: vi.fn().mockResolvedValue({
          githubLogin: 'pat', repositories: [{ id: 9, fullName: repo }],
        }),
      } as never,
    });
    const caller = { sub: 's' } as never;
    const saved = await service.set(caller, 55, { repositoryId: 9, label: 'ART', url, token });
    expect(saved.rules).toHaveLength(1);
    expect(saved.rules[0]).toMatchObject({ label: 'art', url });
    expect(JSON.stringify(saved)).not.toContain(token);
    const stored = (await rules.get(55, rule.id))!;
    expect(saved.rules[0]).toMatchObject({ allowedActors: ['pat'] });
    expect(saved.rules[0]).not.toHaveProperty('credentialId');
    expect(secrets.put).toHaveBeenCalledWith(routineSecretName(55, rule.id, stored.credentialId), token, expect.any(Object));
    const list = await service.list(caller, 55);
    expect(JSON.stringify(list)).not.toContain(token);
    await expect(service.set(caller, 55, { repositoryId: 9, label: 'art', url: 'https://evil.test', token }))
      .rejects.toMatchObject({ code: 'invalid_routine' });
    await service.remove(caller, 55, rule.id);
    expect(secrets.remove).toHaveBeenCalledWith(routineSecretName(55, rule.id, stored.credentialId));
  });
  it('fails closed for missing or unauthorized actors, including overlapping workflow policies and pauses', async () => {
    const rules = memoryRules(); await rules.put(55, rule);
    const store = memoryDispatchStore();
    const fetchImpl = vi.fn();
    const route = createRoutineDispatcher({ rules, store: store as never, readToken: async () => token, fetchImpl });
    for (const sender of [undefined, { login: 'stranger' }]) {
      expect(await route({ installationId: 55, deliveryId: 'actor-test', eventName: 'issues', payload: { ...event, sender } })).toMatchObject({ reason: 'actor_not_allowed' });
    }
    const configured = { ...store, getTenant: async () => ({ status: 'active', activeConfigVersion: 1 }) };
    const checked = createRoutineDispatcher({ rules, store: configured as never, readToken: async () => token, fetchImpl });
    store.getConfigVersion.mockResolvedValue({ dispatch: { repositories: { [repo]: { id: 9, triggers: [{ label: 'art', actors: ['owner'] }] } } } });
    const input = { installationId: 55, deliveryId: 'overlap', eventName: 'issues', payload: event };
    expect(await checked(input)).toMatchObject({ reason: 'actor_not_allowed' });
    store.getConfigVersion.mockResolvedValue({ dispatch: { repositories: { [repo]: { id: 9, paused: true, triggers: [] } } } });
    expect(await checked(input)).toMatchObject({ reason: 'paused' });
    const stopped = createRoutineDispatcher({ rules, store: store as never, readToken: async () => token, fetchImpl, killSwitch: { engaged: async () => true } });
    expect(await stopped(input)).toMatchObject({ reason: 'kill_switch' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not switch backends on redelivery after adding or deleting a route', async () => {
    const rules = memoryRules(), store = memoryDispatchStore();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_01ABC' })));
    const route = createRoutineDispatcher({ rules, store: store as never, readToken: async () => token, fetchImpl });
    const input = { installationId: 55, deliveryId: 'managed-first', eventName: 'issues', payload: event };
    expect(await route(input)).toBeNull();
    await rules.put(55, rule);
    expect(await route(input)).toMatchObject({ disposition: 'deduped' });
    const routineInput = { ...input, deliveryId: 'routine-first' };
    expect(await route(routineInput)).toMatchObject({ disposition: 'routine_triggered' });
    await rules.remove(55, rule.id, rule.credentialId);
    expect(await route(routineInput)).toMatchObject({ disposition: 'deduped' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('claims only one fire across concurrent deliveries and recognizes preexisting managed claims', async () => {
    const rules = memoryRules(), store = memoryDispatchStore();
    await rules.put(55, rule);
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_01ABC' })));
    const route = createRoutineDispatcher({ rules, store: store as never, readToken: async () => token, fetchImpl });
    const input = { installationId: 55, deliveryId: 'concurrent', eventName: 'issues', payload: event };
    const outcomes = await Promise.all([route(input), route(input)]);
    expect(outcomes.map((v) => v?.disposition).sort()).toEqual(['deduped', 'routine_triggered']);
    await store.claimDelivery(55, 'already-managed', Date.now() + 10000, 'job_existing');
    expect(await route({ ...input, deliveryId: 'already-managed' })).toMatchObject({ disposition: 'deduped' });
    store.listDeliveriesOf.mockResolvedValue([{ disposition: 'launched' }]);
    expect(await route({ ...input, deliveryId: 'historical' })).toMatchObject({ disposition: 'deduped' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps the old credential intact after an ambiguous metadata failure and rejects racing updates', async () => {
    const rules = memoryRules();
    const values = new Map<string, string>();
    const secrets = {
      put: vi.fn(async (name: string, value: string) => { values.set(name, value); }),
      remove: vi.fn(async (name: string) => { values.delete(name); }),
    };
    const service = createRoutineService({ rules, secrets, store: memoryDispatchStore() as never,
      github: { member: vi.fn(), configContext: async () => ({ githubLogin: 'pat', repositories: [{ id: 9, fullName: repo }] }) } as never });
    const caller = { sub: 's' } as never;
    const input = { repositoryId: 9, label: 'art', url, token };
    await service.set(caller, 55, input);
    const before = (await rules.get(55, rule.id))!;
    const oldName = routineSecretName(55, rule.id, before.credentialId);
    const nextToken = token + 'new';
    const put = rules.put.bind(rules);
    const mockPut = vi.spyOn(rules, 'put').mockRejectedValueOnce(new Error('ambiguous write'));
    await expect(service.set(caller, 55, { ...input, token: nextToken })).rejects.toThrow('ambiguous write');
    expect((await rules.get(55, rule.id))?.credentialId).toBe(before.credentialId);
    expect(values.get(oldName)).toBe(token);
    mockPut.mockImplementation(put);
    const secondUrl = url.replace('trig_01ABC', 'trig_02ABC');
    const results = await Promise.allSettled([service.set(caller, 55, { ...input, url: secondUrl, token: nextToken }), service.set(caller, 55, { ...input, token: token + 'third' })]);
    expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    const after = (await rules.get(55, rule.id))!;
    const selectedToken = values.get(routineSecretName(55, rule.id, after.credentialId));
    expect(selectedToken).toBe(after.url === secondUrl ? nextToken : token + 'third');
    expect(values.has(oldName)).toBe(false);
  });

  it('enforces authorization and backend ownership through the signed webhook handler', async () => {
    const rules = memoryRules(), store = memoryDispatchStore();
    const recordDelivery = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_01ABC',
    })));
    const routines = createRoutineDispatcher({ rules, store: store as never, readToken: async () => token, fetchImpl });
    const launch = vi.fn().mockResolvedValue({ disposition: 'launched', status: 202, jobId: 'job_test' });
    const webhookSecret = 'test-webhook-secret';
    const webhook = createWebhookHandler({ store: { ...store, recordDelivery } as never,
      github: {} as never, loadSettings: async () => ({ webhookSecret } as never), launch, routines, log: () => {} });
    const deliver = (deliveryId: string, sender: string) => {
      const body = JSON.stringify({ ...event, installation: { id: 55 }, sender: { login: sender } });
      return webhook({ body, headers: { 'x-github-event': 'issues', 'x-github-delivery': deliveryId,
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', webhookSecret).update(body).digest('hex') } });
    };
    expect((await deliver('managed', 'pat')).body.disposition).toBe('launched');
    await rules.put(55, rule);
    expect((await deliver('managed', 'pat')).body.disposition).toBe('deduped');
    expect((await deliver('denied', 'stranger')).body.disposition).toBe('filtered');
    expect((await deliver('routine', 'pat')).body.disposition).toBe('routine_triggered');
    await rules.remove(55, rule.id, rule.credentialId);
    expect((await deliver('routine', 'pat')).body.disposition).toBe('deduped');
    expect(launch).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(recordDelivery).toHaveBeenCalledWith(55, expect.objectContaining({ disposition: 'filtered', reason: 'actor_not_allowed' }));
  });

  it('never reads a replacement token for a stale URL during dispatch', async () => {
    const rules = memoryRules(); await rules.put(55, rule);
    const replacement = { ...rule, url: url.replace('trig_01ABC', 'trig_02ABC'),
      credentialId: '22222222-2222-4222-8222-222222222222' };
    const readToken = vi.fn(async (name: string) => {
      await rules.put(55, replacement, rule.credentialId);
      // Replacement removed the old immutable credential before it could be read.
      return name === routineSecretName(55, rule.id, replacement.credentialId) ? token + 'new' : null;
    });
    const fetchImpl = vi.fn();
    const route = createRoutineDispatcher({ rules, store: memoryDispatchStore() as never, readToken, fetchImpl });
    expect(await route({ installationId: 55, deliveryId: 'stale-route', eventName: 'issues', payload: event })).toMatchObject({
      disposition: 'routine_failed', reason: 'trigger_token_unavailable',
    });
    expect(readToken).toHaveBeenCalledWith(routineSecretName(55, rule.id, rule.credentialId));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

});
