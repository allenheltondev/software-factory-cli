// #176: a Claude subscription session started N rollouts ago survives N routine, compatible
// rollouts. Each rollout here does what the deploy workflow does, with the real code: build a
// version (pruning old ones first, build-job-image.ts), seed `--seed "$active" --seed
// "$VERIFIED_VERSION"` (claude-image-policy.ts), then move the latest-image parameter on.
import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  AccessDeniedException,
  DeleteMicrovmImageVersionCommand,
  ListMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
  type LambdaMicrovmsClient,
} from '@aws-sdk/client-lambda-microvms';
import { writePolicy } from './claude-image-policy.js';
import { DEFAULT_KEEP_VERSIONS, liveImageVersions, pruneImageVersions, pruneNativeImageVersions } from './job-image-prune.js';
import { BOOTSTRAP_REASON, createImagePolicies, imageDecision, type ImagePolicy } from '../src/native/image-policy.js';
import { classifyReadiness, sessionPhase } from '../src/native/readiness.js';
import type { Worker } from '../src/native/store.js';

const ARN = 'arn:aws:lambda:us-east-1:111122223333:microvm-image:updraft-native-claude';

/** The Cloud table's NATIVE_IMAGE# records, with DynamoDB's conditional writes. */
function policyTable() {
  const items = new Map<string, Record<string, unknown>>();
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: items.get(String(command.input.Key!.pk)) };
    if (command instanceof PutCommand) {
      const item = command.input.Item!;
      const existing = items.get(String(item.pk));
      const condition = command.input.ConditionExpression;
      const ok = condition === 'attribute_not_exists(pk)' ? !existing
        : condition === 'revision = :revision' ? existing?.revision === command.input.ExpressionAttributeValues?.[':revision'] : true;
      if (!ok) throw new ConditionalCheckFailedException({ message: 'conditional', $metadata: {} });
      items.set(String(item.pk), { ...item });
      return {};
    }
    throw new Error('unexpected command');
  });
  return { db: { send } as unknown as DynamoDBDocumentClient, items, send };
}

/** One MicroVM image: its versions (created in order) and the microVMs running them. */
function microvmImage() {
  const versions: { imageVersion: string; state: string; createdAt: Date }[] = [];
  const vms: { microvmId: string; imageVersion: string; state: string }[] = [];
  let listDenied = false;
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof ListMicrovmImageVersionsCommand) return { items: versions.filter((v) => v.state !== 'DELETED') };
    if (command instanceof ListMicrovmsCommand) {
      if (listDenied) throw new AccessDeniedException({ message: 'no', $metadata: {} });
      return { items: vms.map((vm) => ({ ...vm, imageArn: ARN, startedAt: new Date(0) })) };
    }
    if (command instanceof DeleteMicrovmImageVersionCommand) {
      const v = versions.find((x) => x.imageVersion === command.input.imageVersion)!;
      v.state = 'DELETED';
      // What we must never rely on: a deleted version may take its running microVMs with it.
      for (const vm of vms) if (vm.imageVersion === v.imageVersion) vm.state = 'TERMINATED';
      return {};
    }
    throw new Error('unexpected command');
  });
  return {
    client: { send } as unknown as LambdaMicrovmsClient, versions, vms,
    build(n: number) { const imageVersion = String(n); versions.push({ imageVersion, state: 'SUCCESSFUL', createdAt: new Date(n * 60_000) }); return imageVersion; },
    exists: (v: string) => versions.some((x) => x.imageVersion === v && x.state !== 'DELETED'),
    deny() { listDenied = true; },
  };
}

const settle = async () => undefined;
const quiet = () => undefined;

/** The deploy workflow's Claude image steps, for one merge. */
async function rollout(table: ReturnType<typeof policyTable>, image: ReturnType<typeof microvmImage>, stack: { active: string }, n: number, prune = pruneNativeImageVersions) {
  const latestActive = image.versions.filter((v) => v.state !== 'DELETED').at(-1)?.imageVersion;
  await prune(image.client, ARN, { active: stack.active, latestActive, log: quiet, settle });
  const verified = image.build(n);
  for (const seed of [stack.active, verified]) await writePolicy(table.db, 'table', seed, 'approved', 'Verified protocol-1 rollout', true);
  stack.active = verified;
}

const worker = (imageVersion: string, at: number): Worker => ({ installationId: 55, workerId: 'managed-55', version: 3, session: 'worker-session-a',
  microvmId: 'mvm-a', imageVersion, workerVersion: 'tenant-browser-1', heartbeatAt: at, auth: 'connected' });

/** Dispatch's answer for the session, judged as aws.ts does: against the deployed latest image's policy reader. */
async function readiness(table: ReturnType<typeof policyTable>, latest: string, sessionImage: string, vmState: string) {
  const route = { installationId: 55, workerId: 'managed-55', microvmId: 'mvm-a', imageVersion: sessionImage, generation: 'generation-a', controlSecretArn: '' };
  const policy = await createImagePolicies('table', latest, table.db)(sessionImage);
  const session = sessionPhase({ generation: 'generation-a', microvmId: 'mvm-a', requestedAt: 0, readyAt: 1 }, route, 600_000);
  return classifyReadiness(route, worker(sessionImage, 10_000), 10_000, latest, { session, imagePolicy: policy, vmState });
}

describe('routine compatible rollouts never retire a healthy Claude session (#176)', () => {
  it.each([3, 6, 12])('a session started %i rollouts ago keeps its approved, undeleted image and stays ready', async (n) => {
    const table = policyTable();
    const image = microvmImage();
    const stack = { active: image.build(0) };
    await writePolicy(table.db, 'table', stack.active, 'approved', 'Verified protocol-1 rollout', true);
    // The session connects on the then-latest image, 0, and keeps it for its whole life.
    image.vms.push({ microvmId: 'mvm-a', imageVersion: '0', state: 'RUNNING' });
    for (let i = 1; i <= n; i++) await rollout(table, image, stack, i);

    expect(stack.active).toBe(String(n));
    expect(image.exists('0')).toBe(true);
    expect(image.vms[0]!.state).toBe('RUNNING');
    const policy = await createImagePolicies('table', stack.active, table.db)('0');
    expect(policy).toMatchObject({ state: 'approved', revision: 1 });
    expect(imageDecision(policy)).toBe('approved');
    expect(await readiness(table, stack.active, '0', image.vms[0]!.state)).toBe('ready');
    // Pruning still bounds the image: the session's version and the newest few are all that is left.
    const left = image.versions.filter((v) => v.state !== 'DELETED').map((v) => v.imageVersion);
    expect(left).toContain('0');
    expect(left.length).toBeLessThanOrEqual(DEFAULT_KEEP_VERSIONS + 2);
  });

  it('shows the failure mode it fixes: pruning by "the newest few" deletes a live session\'s version after six rollouts', async () => {
    const table = policyTable();
    const image = microvmImage();
    const stack = { active: image.build(0) };
    image.vms.push({ microvmId: 'mvm-a', imageVersion: '0', state: 'RUNNING' });
    const keepNewest: typeof pruneNativeImageVersions = async (client, arn, o) => ({ ...await pruneImageVersions(client, arn, { protect: [o.active, o.latestActive], log: quiet, settle }), live: [] });
    for (let i = 1; i <= 5; i++) await rollout(table, image, stack, i, keepNewest);
    expect(image.exists('0')).toBe(true);
    await rollout(table, image, stack, 6, keepNewest);
    expect(image.exists('0')).toBe(false);
    // Its approval is untouched, so the policy still says approved, but the VM may be gone with
    // it: cleanup then seals the session (`vm-ended`) and the next job asks for a sign-in.
    expect(imageDecision(await createImagePolicies('table', stack.active, table.db)('0'))).toBe('approved');
    expect(image.vms[0]!.state).toBe('TERMINATED');
  });

  it('prunes nothing when the live microVMs cannot be listed', async () => {
    const image = microvmImage();
    const stack = { active: image.build(0) };
    image.vms.push({ microvmId: 'mvm-a', imageVersion: '0', state: 'RUNNING' });
    image.deny();
    const lines: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const latestActive = image.versions.at(-1)?.imageVersion;
      await pruneNativeImageVersions(image.client, ARN, { active: stack.active, latestActive, log: (l) => lines.push(l), settle });
      stack.active = image.build(i);
    }
    expect(image.versions.every((v) => v.state === 'SUCCESSFUL')).toBe(true);
    expect(lines.some((l) => l.includes('lambda:ListMicrovms'))).toBe(true);
  });

  it('counts every microVM not yet terminated as live, and refuses a row with no version', async () => {
    const image = microvmImage();
    image.vms.push(
      { microvmId: 'a', imageVersion: '1', state: 'RUNNING' }, { microvmId: 'b', imageVersion: '2', state: 'SUSPENDED' },
      { microvmId: 'c', imageVersion: '3', state: 'TERMINATING' }, { microvmId: 'd', imageVersion: '4', state: 'TERMINATED' },
      { microvmId: 'e', imageVersion: '5', state: 'PENDING' },
    );
    expect([...await liveImageVersions(image.client, ARN)].sort()).toEqual(['1', '2', '3', '5']);
    image.vms.push({ microvmId: 'f', imageVersion: '', state: 'RUNNING' });
    await expect(liveImageVersions(image.client, ARN)).rejects.toThrow(/no image version/);
  });

  it('never approves an unverified image, and never undoes a drain or revocation, across rollouts and rollback', async () => {
    const table = policyTable();
    const image = microvmImage();
    const stack = { active: image.build(0) };
    await writePolicy(table.db, 'table', '0', 'approved', 'Verified protocol-1 rollout', true);
    await rollout(table, image, stack, 1);
    await writePolicy(table.db, 'table', '0', 'revoked', 'Critical issue');
    await writePolicy(table.db, 'table', '1', 'draining', 'Upgrade required');
    for (let i = 2; i <= 4; i++) await rollout(table, image, stack, i);
    // A rollback re-seeds 1 as the verified target: the drain stands.
    await writePolicy(table.db, 'table', '1', 'approved', 'Verified protocol-1 rollout', true);
    const read = createImagePolicies('table', stack.active, table.db);
    expect(imageDecision(await read('0'))).toBe('image-revoked');
    expect(imageDecision(await read('1'))).toBe('image-draining');
    // A version some VM runs but that no rollout verified (a smoke test's, say) is never approved by pruning or seeding.
    image.vms.push({ microvmId: 'smoke', imageVersion: '99', state: 'RUNNING' });
    await rollout(table, image, stack, 5);
    expect(imageDecision(await read('99'))).toBe('image-unapproved');
  });
});

describe('a launch on an unrecorded latest image records its approval (#176)', () => {
  const bootstrap: ImagePolicy = { imageVersion: '7', revision: 0, state: 'approved', protocol: 'tenant-browser-1', reason: 'Latest verified image' };

  it('so later rollouts that never seed it leave the session approved', async () => {
    const table = policyTable();
    const read = createImagePolicies('table', '7', table.db);
    const policy = await read('7');
    expect(policy).toEqual(bootstrap);
    expect(await read.durable!(policy)).toMatchObject({ revision: 1, state: 'approved', reason: BOOTSTRAP_REASON });
    // Three manual parameter changes that seeded nothing: 7 is still approved, not "no approval".
    for (const latest of ['8', '9', '10']) expect(imageDecision(await createImagePolicies('table', latest, table.db)('7'))).toBe('approved');
  });

  it('only for the current latest, only when no record exists, and a concurrent revocation wins', async () => {
    const table = policyTable();
    const read = createImagePolicies('table', '7', table.db);
    expect(await read.durable!({ ...bootstrap, imageVersion: '6' })).toMatchObject({ imageVersion: '6', revision: 0 });
    expect(await read.durable!({ ...bootstrap, state: 'unknown' })).toMatchObject({ state: 'unknown', revision: 0 });
    expect(await read.durable!({ ...bootstrap, revision: 3 })).toMatchObject({ revision: 3 });
    expect(table.send.mock.calls.some(([c]) => c instanceof PutCommand)).toBe(false);
    // The revocation commits between the read and the write: the write fails and the revocation is returned.
    await writePolicy(table.db, 'table', '7', 'revoked', 'Critical issue');
    expect(await read.durable!(bootstrap)).toMatchObject({ state: 'revoked', reason: 'Critical issue' });
    expect(imageDecision(await read('7'))).toBe('image-revoked');
  });

  it('fails closed when the record cannot be written', async () => {
    const send = vi.fn(async (command: unknown) => { if (command instanceof PutCommand) throw new Error('throttled'); return {}; });
    const read = createImagePolicies('table', '7', { send } as unknown as DynamoDBDocumentClient);
    await expect(read.durable!(bootstrap)).rejects.toThrow('throttled');
  });
});
