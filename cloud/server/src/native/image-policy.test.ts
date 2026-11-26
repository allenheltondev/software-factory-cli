import { describe, expect, it, vi } from 'vitest';
import type { GetCommand, TransactWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createImageCapabilities, createImagePolicies, imageCapabilityKey, imageDecision, recordCodexCapability, WORKER_PROTOCOL, type ImagePolicy } from './image-policy.js';
import { classifyReadiness } from './readiness.js';
import { createNativeStore, type Worker } from './store.js';
import type { Job } from '../store/store.js';

const policy: ImagePolicy = { imageVersion: '9.0', revision: 2, state: 'approved', protocol: WORKER_PROTOCOL, reason: 'Compatible rollout' };
const worker: Worker = { installationId: 55, workerId: 'managed-55', version: 1, session: 'session-a', microvmId: 'mvm-a', imageVersion: '9.0', workerVersion: WORKER_PROTOCOL, heartbeatAt: 1000, auth: 'connected' };
const route = { ...worker, generation: 'generation-a', controlSecretArn: '' };
const dbWith = (send: ReturnType<typeof vi.fn>) => ({ send } as unknown as DynamoDBDocumentClient);

describe('exact image compatibility approval', () => {
  it('keeps an approved immutable session ready across rollouts and rollback, retaining auth and image binding', () => {
    for (const latest of ['10.0', '11.0', '8.0']) {
      expect(classifyReadiness(route, worker, 1001, latest, { imagePolicy: policy })).toBe('ready');
      expect(classifyReadiness(route, { ...worker, auth: 'expired' }, 1001, latest, { imagePolicy: policy })).toBe('expired');
      expect(classifyReadiness(route, { ...worker, imageVersion: latest }, 1001, latest, { imagePolicy: policy })).toBe('worker-lost');
    }
  });
  it.each([
    ['draining', 'image-draining'], ['revoked', 'image-revoked'], ['unknown', 'image-unapproved'],
  ] as const)('blocks %s images with an exact reason', (state, expected) => {
    expect(imageDecision({ ...policy, state })).toBe(expected);
    expect(classifyReadiness(route, worker, 1001, '10.0', { imagePolicy: { ...policy, state } })).toBe(expected);
  });
  it('rejects unknown protocols and never infers approval from version ordering', async () => {
    expect(imageDecision(policy, 'future-protocol')).toBe('protocol-incompatible');
    expect(imageDecision({ ...policy, protocol: 'future-protocol' })).toBe('protocol-incompatible');
    const send = vi.fn<(command: unknown) => Promise<object>>().mockResolvedValue({});
    const read = createImagePolicies('table', '10.0', dbWith(send));
    expect(imageDecision(await read('9.0'))).toBe('image-unapproved');
    expect(imageDecision(await read('99.0'))).toBe('image-unapproved');
    expect(imageDecision(await read('10.0'))).toBe('approved');
    expect(send.mock.calls.every(([command]) => (command as GetCommand).input.ConsistentRead)).toBe(true);
  });
  it('honors revocation even for the latest image and fails closed for corrupt records', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: { ...policy, state: 'revoked' } }).mockResolvedValueOnce({ Item: { ...policy, revision: 'bad' } });
    const read = createImagePolicies('table', '9.0', dbWith(send));
    expect(imageDecision(await read('9.0'))).toBe('image-revoked');
    expect(imageDecision(await read('9.0'))).toBe('image-unapproved');
  });
  it('judges protocol only by the worker registered for this VM, never a placeholder or previous VM row', () => {
    // sessions.retire leaves a placeholder row for the retired VM with workerVersion 'unregistered'.
    const placeholder: Worker = { ...worker, microvmId: 'mvm-retired', workerVersion: 'unregistered', heartbeatAt: 0, auth: 'unavailable' };
    const bound = { session: { phase: 'bound' as const, startingUntil: 5000 } };
    expect(classifyReadiness(route, placeholder, 1001, '9.0', { imagePolicy: policy, ...bound })).toBe('worker-starting');
    expect(classifyReadiness(route, placeholder, 6000, '9.0', { imagePolicy: policy, ...bound })).toBe('startup-failed');
    // The same incompatible protocol on this VM's own row is still fenced.
    expect(classifyReadiness(route, { ...worker, workerVersion: 'unregistered' }, 1001, '9.0', { imagePolicy: policy, ...bound })).toBe('protocol-incompatible');
    // Policy-level incompatibility does not depend on the worker row at all.
    expect(classifyReadiness(route, placeholder, 1001, '9.0', { imagePolicy: { ...policy, protocol: 'future' }, ...bound })).toBe('protocol-incompatible');
  });
  it('conditions assignment on the exact approval revision so a concurrent revoke wins', async () => {
    const send = vi.fn<(command: unknown) => Promise<object>>().mockResolvedValue({});
    const store = createNativeStore('table', dbWith(send));
    const job = { jobId: 'job-a', installationId: 55, imageVersion: '9.0', native: { workerId: worker.workerId } } as Job;
    expect(await store.assign(job, worker, 1000, 2000, policy)).toBe(true);
    const command = send.mock.calls[0]![0] as unknown as TransactWriteCommand;
    expect(command.input.TransactItems).toEqual(expect.arrayContaining([expect.objectContaining({ ConditionCheck: expect.objectContaining({
      Key: { pk: 'NATIVE_IMAGE#9.0', sk: 'POLICY' }, ExpressionAttributeValues: { ':revision': 2, ':approved': 'approved' },
    }) })]));
    send.mockClear();
    expect(await store.assign(job, worker, 1000, 2000, { ...policy, state: 'revoked' })).toBe(false);
    expect(await store.assign({ ...job, imageVersion: '10.0' }, worker, 1000, 2000, policy)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('rebinds only a never-started queued job, rotating its per-job token under the new session fence', async () => {
    const send = vi.fn<(command: unknown) => Promise<object>>().mockResolvedValue({});
    const store = createNativeStore('table', dbWith(send));
    await store.rebindQueued!({ installationId: 55, jobId: 'job-a', tokenHash: 'old-hash', native: { workerId: worker.workerId, generation: 'old-generation' } } as Job, route, 'new-hash');
    const command = send.mock.calls[0]![0] as unknown as TransactWriteCommand;
    const update = command.input.TransactItems![1]!.Update!;
    expect(update.ConditionExpression).toContain('attribute_not_exists(startedAt)');
    expect(update.ConditionExpression).toContain('attribute_not_exists(microvmId)');
    expect(update.ExpressionAttributeValues).toMatchObject({ ':old': 'old-generation', ':next': 'generation-a', ':previous': 'old-hash', ':token': 'new-hash', ':image': '9.0' });
    expect(command.input.TransactItems![0]!.ConditionCheck!.ConditionExpression).toContain('attribute_not_exists(retiring)');
  });
});

describe('image capabilities (#125)', () => {
  it('reads Codex only from the version\'s own capability record, separate from its policy', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const send = vi.fn(async (command: { input: { Key?: { pk: string; sk: string }; Item?: Record<string, unknown> } }) => {
      if (command.input.Item) { rows.set(`${command.input.Item.pk}|${command.input.Item.sk}`, command.input.Item); return {}; }
      return { Item: rows.get(`${command.input.Key!.pk}|${command.input.Key!.sk}`) };
    });
    let clock = 0;
    const read = createImageCapabilities('table', dbWith(send), { now: () => clock });
    // An image built before Codex: no record, Claude only. Looked up again each time.
    expect(await read('9.0')).toEqual({ codex: false });
    expect(await read('9.0')).toEqual({ codex: false });
    expect(send).toHaveBeenCalledTimes(2);
    await recordCodexCapability(dbWith(send), 'table', '10.0', '0.172.0', new Date(0));
    expect(rows.get('NATIVE_IMAGE#10.0|CAPABILITIES')).toMatchObject({ ...imageCapabilityKey('10.0'), imageVersion: '10.0', codex: true, codexVersion: '0.172.0' });
    expect(rows.has('NATIVE_IMAGE#10.0|POLICY')).toBe(false);
    expect(await read('10.0')).toEqual({ codex: true, codexVersion: '0.172.0' });
    send.mockClear();
    expect(await read('10.0')).toEqual({ codex: true, codexVersion: '0.172.0' });
    expect(send).not.toHaveBeenCalled();
    clock = 120_000;
    await read('10.0');
    expect(send).toHaveBeenCalledOnce();
    // A record for another version, or a malformed one, grants nothing.
    rows.set('NATIVE_IMAGE#11.0|CAPABILITIES', { pk: 'NATIVE_IMAGE#11.0', sk: 'CAPABILITIES', imageVersion: '10.0', codex: true });
    expect(await read('11.0')).toEqual({ codex: false });
    await expect(recordCodexCapability(dbWith(send), 'table', '10.0', 'latest')).rejects.toThrow();
  });
});
