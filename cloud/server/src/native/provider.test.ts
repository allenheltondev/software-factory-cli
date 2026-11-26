import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createClaudeAdmission, SESSION_SECONDS } from './admission.js';
import { admissionFixture } from './admission-fixture.js';
import { isManagedWorkerId, managedWorkerId, parseManagedWorkerId, providerKeys, providerOfWorker } from './provider.js';
import { retirementCode, retirementWords } from './retirement.js';
import { createClaudeSessions, createManagedSessions, sessionKeyOf, waitingId } from './sessions.js';

// Upgrade compatibility (#125): every key, id and record Claude stored before providers existed is
// read and written exactly as before. Codex's records are new keys beside them.

/** A record store that keeps what is written and checks only the conditions these tests need. */
function table() {
  const rows = new Map<string, Record<string, unknown>>();
  const id = (key: Record<string, unknown>) => `${String(key.pk)}|${String(key.sk)}`;
  const writes: { kind: string; key: string }[] = [];
  const db = {
    async send(command: unknown) {
      if (command instanceof GetCommand) return { Item: rows.get(id(command.input.Key!)) };
      if (command instanceof PutCommand) {
        const key = id(command.input.Item!);
        if (command.input.ConditionExpression === 'attribute_not_exists(pk)' && rows.has(key))
          throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
        writes.push({ kind: 'put', key });
        rows.set(key, command.input.Item!);
        return {};
      }
      if (command instanceof UpdateCommand) {
        writes.push({ kind: 'update', key: id(command.input.Key!) });
        return {};
      }
      if (command instanceof QueryCommand) {
        const prefix = String(command.input.ExpressionAttributeValues?.[':q']);
        const pk = String(command.input.ExpressionAttributeValues?.[':p']);
        return { Items: [...rows.values()].filter((r) => r.pk === pk && String(r.sk).startsWith(prefix) && r.status === 'waiting') };
      }
      if (command instanceof TransactWriteCommand) {
        for (const item of command.input.TransactItems ?? []) {
          const key = item.Put?.Item ?? item.Update?.Key ?? item.ConditionCheck?.Key;
          writes.push({ kind: item.Put ? 'put' : item.Update ? 'update' : 'check', key: id(key as Record<string, unknown>) });
          if (item.Put) rows.set(id(item.Put.Item!), item.Put.Item!);
        }
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return { db: db as unknown as DynamoDBDocumentClient, rows, writes };
}

describe('managed session providers', () => {
  it('names Claude exactly as before and gives Codex its own keys', () => {
    expect(managedWorkerId(55)).toBe('managed-55');
    expect(managedWorkerId(55, 'claude')).toBe('managed-55');
    expect(managedWorkerId(55, 'codex')).toBe('managed-codex-55');
    expect(sessionKeyOf(55)).toEqual({ pk: 'TENANT#55', sk: 'CLAUDE_SESSION' });
    expect(sessionKeyOf(55, 'codex')).toEqual({ pk: 'TENANT#55', sk: 'CODEX_SESSION' });
    expect(providerKeys().waitPrefix).toBe('CLAUDE_WAIT#');
    expect(providerKeys('codex').waitPrefix).toBe('CODEX_WAIT#');
    expect(providerKeys('codex').apiKey).toBe('CODEX_API_KEY');
    expect(providerKeys(undefined).apiKey).toBe('ANTHROPIC_API_KEY');
  });

  it('parses managed worker ids, and reads every other or older id as Claude', () => {
    expect(parseManagedWorkerId('managed-55')).toEqual({ installationId: 55, provider: 'claude' });
    expect(parseManagedWorkerId('managed-codex-55')).toEqual({ installationId: 55, provider: 'codex' });
    for (const id of ['managed-0', 'managed-codex-', 'managed-codex-0', 'managed-kiro-5', 'native-worker', 'managed-55x', undefined, 55]) {
      expect(parseManagedWorkerId(id), String(id)).toBeUndefined();
      expect(isManagedWorkerId(id)).toBe(false);
    }
    // A pinned route's worker, a queue route of `standard`, a job without a worker: Claude's.
    expect(providerOfWorker('native-worker-1')).toBe('claude');
    expect(providerOfWorker('standard')).toBe('claude');
    expect(providerOfWorker(undefined)).toBe('claude');
    expect(providerOfWorker('managed-codex-9')).toBe('codex');
  });

  it('keeps the waiting job id of a Claude delivery parked before providers, so a redelivery still finds it', () => {
    const before = `job_${createHash('sha256').update(JSON.stringify([55, 'delivery-1', 'claude-wait'])).digest('base64url').slice(0, 16)}`;
    expect(waitingId(55, 'delivery-1')).toBe(before);
    expect(waitingId(55, 'delivery-1', 'claude')).toBe(before);
    expect(waitingId(55, 'delivery-1', 'codex')).not.toBe(before);
    expect(waitingId(55, 'delivery-1', 'codex')).toMatch(/^job_[A-Za-z0-9_-]{16}$/);
  });

  it('reads an existing Claude session and its waiting jobs as stored, never Codex\'s', async () => {
    const { db, rows } = table();
    // Rows as an earlier release wrote them: no provider anywhere.
    rows.set('TENANT#55|CLAUDE_SESSION', { pk: 'TENANT#55', sk: 'CLAUDE_SESSION', generation: 'live-gen', imageVersion: '9', microvmId: 'mvm-live', requestedAt: 1, readyAt: 2 });
    const parked = waitingId(55, 'old-delivery');
    rows.set(`TENANT#55|CLAUDE_WAIT#${parked}`, { pk: 'TENANT#55', sk: `CLAUDE_WAIT#${parked}`, id: parked, status: 'waiting', expiresAt: Date.now() + 60_000,
      request: { installationId: 55, deliveryId: 'old-delivery' }, eventKey: `tenants/55/events/claude-wait/${parked}.json` });
    const claude = createClaudeSessions('table', db);
    const codex = createManagedSessions('table', db, 'codex');
    expect(await claude.session(55)).toMatchObject({ generation: 'live-gen', microvmId: 'mvm-live' });
    expect(await claude.get(55, parked)).toMatchObject({ status: 'waiting' });
    expect((await claude.pending(55)).map((p) => p.id)).toEqual([parked]);
    expect(await codex.session(55)).toBeUndefined();
    expect(await codex.get(55, parked)).toBeUndefined();
    expect(await codex.pending(55)).toEqual([]);
  });

  it('never writes a Claude record when a Codex session starts, parks or retires', async () => {
    const { db, rows, writes } = table();
    rows.set('TENANT#55|CLAUDE_SESSION', { pk: 'TENANT#55', sk: 'CLAUDE_SESSION', generation: 'live-gen', imageVersion: '9', microvmId: 'mvm-live', requestedAt: 1 });
    const live = { ...rows.get('TENANT#55|CLAUDE_SESSION') };
    const codex = createManagedSessions('table', db, 'codex');
    const session = await codex.requestSession(55, undefined, '10');
    expect(session).toBeDefined();
    const { id } = await codex.park({ installationId: 55, deliveryId: 'new-delivery' }, 'key.json');
    expect(id).toBe(waitingId(55, 'new-delivery', 'codex'));
    await codex.retire(55, session!, { enabled: true, revision: 0 }, null, 'reconnect');
    const touched = writes.map((w) => w.key);
    expect(touched).toEqual(expect.arrayContaining(['TENANT#55|CODEX_SESSION', `TENANT#55|CODEX_WAIT#${id}`,
      'NATIVE#55#managed-codex-55|MODE', 'NATIVE#55#managed-codex-55|WORKER']));
    expect(touched.filter((key) => key.includes('CLAUDE') || key.includes('#managed-55|'))).toEqual([]);
    expect(rows.get('TENANT#55|CLAUDE_SESSION')).toEqual(live);
    expect(rows.get('NATIVE#55#managed-codex-55|WORKER')).toMatchObject({ workerId: 'managed-codex-55', fenced: true });
  });

  it('words a retirement and its timeline code per provider, Claude\'s unchanged', () => {
    expect(retirementCode('idle')).toBe('claude_session_idle');
    expect(retirementCode('idle', 'codex')).toBe('codex_session_idle');
    expect(retirementWords('disabled')).toBe('an operator paused Claude connections');
    expect(retirementWords('disabled', 'codex')).toBe('an operator paused Codex connections');
  });
});

describe('shared admission registry across providers', () => {
  const now = Date.UTC(2026, 10, 26);
  const limits = { concurrent: 4, dailySeconds: 24 * SESSION_SECONDS, tenantDailySeconds: 6 * SESSION_SECONDS };

  it('reads a lease stored before providers as Claude\'s: Claude keeps judging it, Codex never sees it', async () => {
    // The registry as an earlier release left it, with a live Claude session's lease.
    const fixture = admissionFixture({
      pk: 'CLAUDE_CAPACITY', sk: 'REGISTRY', revision: 3, day: '2026-11-26', seconds: 0, tenants: {}, accountingVersion: 2, launches: 1, tenantLaunches: { 55: 1 },
      leases: { 'live-gen': { installationId: 55, generation: 'live-gen', requestedAt: now, idleAt: now + 1000, mayHaveLaunched: true, launchedAt: now, microvmId: 'mvm-live', reservedSeconds: SESSION_SECONDS, idleMs: 1000 } },
    });
    const claude = createClaudeAdmission('test', fixture.db);
    const codex = createClaudeAdmission('test', fixture.db, 'codex');
    expect((await claude.list()).map((l) => l.generation)).toEqual(['live-gen']);
    expect(await codex.list()).toEqual([]);
    // One lease per installation and provider: Claude still cannot hold two, Codex may hold its own.
    await expect(claude.reserve(55, 'second-claude', now, limits)).rejects.toThrow('Claude environment capacity is full');
    await expect(codex.reserve(55, 'codex-gen', now, limits)).resolves.toMatchObject({ generation: 'codex-gen', provider: 'codex' });
    await expect(codex.reserve(55, 'second-codex', now, limits)).rejects.toThrow('Codex environment capacity is full');
    expect((await claude.list()).map((l) => l.generation)).toEqual(['live-gen']);
    expect((await codex.list()).map((l) => l.generation)).toEqual(['codex-gen']);
    // The live Claude lease is untouched, byte for byte, and Claude's own leases never gain a provider.
    const leases = fixture.read()!.leases as Record<string, Record<string, unknown>>;
    expect(leases['live-gen']).not.toHaveProperty('provider');
    await claude.reserve(56, 'claude-56', now, limits);
    expect((fixture.read()!.leases as Record<string, Record<string, unknown>>)['claude-56']).not.toHaveProperty('provider');
  });

  it('checks each lease against its own provider\'s session record', async () => {
    const checked: string[] = [];
    const sessions: Record<string, { generation: string }> = { CLAUDE_SESSION: { generation: 'claude-gen' }, CODEX_SESSION: { generation: 'codex-gen' } };
    const fixture = admissionFixture(undefined, (_id, sk) => { checked.push(sk); return sessions[sk]; });
    const claude = createClaudeAdmission('test', fixture.db);
    const codex = createClaudeAdmission('test', fixture.db, 'codex');
    await codex.reserve(55, 'codex-gen', now, limits);
    await codex.launching('codex-gen', now);
    await claude.reserve(55, 'claude-gen', now, limits);
    await claude.launching('claude-gen', now);
    expect(checked).toEqual(['CODEX_SESSION', 'CODEX_SESSION', 'CLAUDE_SESSION', 'CLAUDE_SESSION']);
    // Claude's session record never makes a Codex reservation eligible: only CODEX_SESSION is asked.
    sessions.CLAUDE_SESSION = { generation: 'fresh-gen' };
    await expect(codex.reserve(56, 'fresh-gen', now, limits)).rejects.toThrow('Codex environment generation changed');
    expect(checked.at(-1)).toBe('CODEX_SESSION');
  });

  it('shares the platform\'s concurrent environments across providers', async () => {
    const fixture = admissionFixture();
    const tight = { ...limits, concurrent: 1 };
    await createClaudeAdmission('test', fixture.db).reserve(55, 'claude-gen', now, tight);
    await expect(createClaudeAdmission('test', fixture.db, 'codex').reserve(56, 'codex-gen', now, tight)).rejects.toThrow('capacity is full');
  });
});
