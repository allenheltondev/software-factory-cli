import { describe, expect, it, vi } from 'vitest';
import { createRoutineDispatcher, fireRoutine } from './dispatch.js';
import { createRoutineService } from './service.js';
import { routineId, routineLabel, routineSecretName, validRoutineToken, validRoutineUrl, type RoutineRule, type RoutineRuleStore } from './rules.js';

const repo = 'acme/web';
const url = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire';
const token = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';
const rule: RoutineRule = { id: routineId(9, 'art'), repositoryId: 9, repository: repo, label: 'art', url, updatedAt: '', updatedBy: 'pat' };
const event = { action: 'labeled', repository: { id: 9, full_name: repo }, issue: { number: 12 }, label: { name: 'art' } };

function memoryRules(): RoutineRuleStore {
  const rows = new Map<string, RoutineRule>();
  const key = (id: number, ruleId: string) => `${id}/${ruleId}`;
  return {
    list: async (id) => [...rows].filter(([k]) => k.startsWith(`${id}/`)).map(([, value]) => value),
    get: async (id, ruleId) => rows.get(key(id, ruleId)) ?? null,
    put: async (id, value) => { rows.set(key(id, value.id), value); return 'stored'; },
    remove: async (id, ruleId) => { rows.delete(key(id, ruleId)); },
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
    const claimed = new Set<string>();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_01ABC',
    }), { status: 200 }));
    const notifyRun = vi.fn();
    const route = createRoutineDispatcher({
      rules,
      store: {
        getTenant: async () => ({ status: 'active' }),
        claimDelivery: async (_id: number, delivery: string) => {
          if (claimed.has(delivery)) return false;
          claimed.add(delivery); return true;
        },
      } as never,
      readToken: async (name) => name === routineSecretName(55, rule.id) ? token : null,
      fetchImpl,
      notifyRun,
    });
    const input = { installationId: 55, deliveryId: 'delivery-1', eventName: 'issues', payload: event };
    expect(await route({ ...input, payload: { ...event, label: { name: 'other' } } })).toBeNull();
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
      store: { getTenant: async () => ({ status: 'active' }), claimDelivery: async () => true } as never,
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
    expect(secrets.put).toHaveBeenCalledWith(routineSecretName(55, rule.id), token, expect.any(Object));
    const list = await service.list(caller, 55);
    expect(JSON.stringify(list)).not.toContain(token);
    await expect(service.set(caller, 55, { repositoryId: 9, label: 'art', url: 'https://evil.test', token }))
      .rejects.toMatchObject({ code: 'invalid_routine' });
    await service.remove(caller, 55, rule.id);
    expect(secrets.remove).toHaveBeenCalledWith(routineSecretName(55, rule.id));
  });
});
