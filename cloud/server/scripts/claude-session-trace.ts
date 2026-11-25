// Read-only trace of one installation's Claude subscription session (#144), for the hosted
// acceptance runs: connect once, label issue A, let it finish, label issue B 1-5 minutes later,
// and record whether B reused the same session generation and VM.
//
//   npm run claude-session-trace --workspace=server -- --installation 55 [--watch 30] [--jobs 5]
//     [--stack updraft-cloud] [--region us-east-1]
//
// Each snapshot is one JSON line: the session generation and worker session (shortened), the
// VM's id, AWS state and idle policy, heartbeat age and auth, the idle and lifetime deadlines,
// busy/queued work, waiting requests, recent jobs, and the decision dispatch would make now
// (classifyReadiness, the same rules the webhook uses). It writes nothing and prints no
// token, secret or account identity. --watch repeats it every N seconds until interrupted, so
// a whole A-then-B sequence, including a cleanup run, is captured as a timeline.
import { createImagePolicies, type ImagePolicy } from '../src/native/image-policy.js';
import { parseArgs } from 'node:util';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException } from '@aws-sdk/client-lambda-microvms';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { IDLE_MS, SESSION_SECONDS, STARTUP_MS, type SessionLease } from '../src/native/admission.js';
import { classifyReadiness, PENDING_MICROVM, sessionPhase } from '../src/native/readiness.js';
import { readinessAction } from '../src/jobs/launch.js';
import type { ManagedSession, WaitingClaudeJob } from '../src/native/sessions.js';
import { managedWorkerId } from '../src/native/sessions.js';
import { nativePartition, type Worker } from '../src/native/store.js';
import type { Job } from '../src/store/store.js';
import { createAdminClients } from './admin-clients.js';

/** Enough of an id to match lines across snapshots and logs, not enough to act with. */
export const short = (id: string | undefined) => (id ? (id.length > 12 ? `${id.slice(0, 8)}…` : id) : undefined);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

export interface TraceInput {
  installationId: number;
  now: number;
  latestImageVersion?: string;
  imagePolicy?: ImagePolicy;
  session?: ManagedSession;
  lease?: SessionLease;
  worker: Worker | null;
  queued: string[];
  waiting: Pick<WaitingClaudeJob, 'id' | 'status' | 'jobId' | 'reason'>[];
  vm?: { state: string | null; imageVersion?: string; idlePolicy?: unknown; startedAt?: Date };
  jobs: (Pick<Job, 'jobId' | 'outcome' | 'microvmId' | 'createdAt'> &
    Partial<Pick<Job, 'repository' | 'issue' | 'pullRequest' | 'eventName' | 'startedAt' | 'releasedAt' | 'reservedSeconds' | 'agentKeys'>> & { status: string; generation?: string })[];
}

/** One sanitized snapshot. Pure, so it is tested without AWS. */
export function snapshot(t: TraceInput) {
  const s = t.session;
  const w = t.worker;
  const route = {
    installationId: t.installationId, workerId: managedWorkerId(t.installationId), controlSecretArn: '',
    microvmId: s?.microvmId && !s.retiring ? s.microvmId : PENDING_MICROVM, imageVersion: s?.imageVersion ?? t.latestImageVersion ?? '',
    ...(s?.microvmId && !s.retiring ? { generation: s.generation } : {}),
  };
  const session = sessionPhase(s, route, STARTUP_MS);
  const readiness = classifyReadiness(route, w, t.now, t.latestImageVersion, { session, imagePolicy: t.imagePolicy, ...(t.vm ? { vmState: t.vm.state } : {}) });
  const idleMs = t.lease?.idleMs ?? IDLE_MS;
  const idleAt = t.lease ? Math.max(t.lease.idleAt, (w?.lastWorkAt ?? 0) + idleMs) : undefined;
  return {
    at: iso(t.now),
    installationId: t.installationId,
    imagePolicy: t.imagePolicy,
    dispatch: { readiness, session: session.phase, ownerAction: readinessAction(readiness) },
    session: s && {
      generation: short(s.generation), imageVersion: s.imageVersion, microvmId: s.microvmId,
      requestedAt: iso(s.requestedAt), readyAt: iso(s.readyAt), retiring: !!s.retiring, retirementReason: s.retirementReason,
      lifetimeEndsAt: iso(s.requestedAt + SESSION_SECONDS * 1000), idleEndsAt: iso(idleAt), idleMinutes: idleMs / 60_000,
    },
    lease: t.lease && { held: true, retiring: !!t.lease.retiring, microvmId: t.lease.microvmId, launchedAt: iso(t.lease.launchedAt) },
    vm: t.vm && { state: t.vm.state, imageVersion: t.vm.imageVersion, idlePolicy: t.vm.idlePolicy ?? 'none reported', startedAt: t.vm.startedAt?.toISOString() },
    worker: w && {
      session: short(w.session), microvmId: w.microvmId, imageVersion: w.imageVersion, workerVersion: w.workerVersion,
      auth: w.auth, heartbeatAgeSeconds: Math.round((t.now - w.heartbeatAt) / 1000), fenced: !!w.fenced,
      active: w.active?.jobId, settling: w.settling?.jobId, lastWorkAt: iso(w.lastWorkAt),
    },
    queued: t.queued,
    waiting: t.waiting.map((r) => ({ id: r.id, status: r.status, jobId: r.jobId, reason: r.reason })),
    jobs: t.jobs.map((j) => ({ jobId: j.jobId, status: j.status, outcome: j.outcome, microvmId: j.microvmId, generation: short(j.generation), createdAt: j.createdAt,
      eventName: j.eventName, startedAt: iso(j.startedAt), releasedAt: iso(j.releasedAt), reservedSeconds: j.reservedSeconds,
      apiKeyRequested: j.agentKeys?.includes('ANTHROPIC_API_KEY'),
      ...(j.repository && /^[\w.-]+\/[\w.-]+$/.test(j.repository) ? {
        ...(j.issue ? { issueUrl: `https://github.com/${j.repository}/issues/${j.issue}` } : {}),
        ...(j.pullRequest ? { pullRequestUrl: `https://github.com/${j.repository}/pull/${j.pullRequest}` } : {}),
      } : {}),
    })),
  };
}

async function read(db: DynamoDBDocumentClient, table: string, installationId: number, jobsLimit: number, latestImageVersion: string | undefined, microvms: LambdaMicrovmsClient) {
  const get = async <T>(pk: string, sk: string) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk }, ConsistentRead: true }))).Item as T | undefined;
  const query = async (pk: string, prefix: string, limit = 100, forward = true) => (await db.send(new QueryCommand({ TableName: table, ConsistentRead: true,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :q)', ExpressionAttributeValues: { ':p': pk, ':q': prefix }, Limit: limit, ScanIndexForward: forward }))).Items ?? [];
  const tenant = `TENANT#${installationId}`;
  const workerPk = nativePartition(installationId, managedWorkerId(installationId));
  const session = await get<ManagedSession>(tenant, 'CLAUDE_SESSION');
  const registry = await get<{ leases?: Record<string, SessionLease> }>('CLAUDE_CAPACITY', 'REGISTRY');
  const worker = (await get<Worker>(workerPk, 'WORKER')) ?? null;
  const queued = (await query(workerPk, 'QUEUE#')).map((i) => String(i.jobId));
  const waiting = (await query(tenant, 'CLAUDE_WAIT#')).filter((r) => Number(r.expiresAt) > Date.now()) as WaitingClaudeJob[];
  const summaries = await query(tenant, 'JOB#', jobsLimit, false);
  const jobs = await Promise.all(summaries.map(async (j) => {
    const meta = await get<Job>(`JOB#${j.jobId}`, 'META');
    return { jobId: String(j.jobId), status: meta?.status ?? String(j.status), outcome: meta?.outcome, microvmId: meta?.microvmId, generation: meta?.native?.generation, createdAt: String(j.createdAt),
      repository: meta?.repository, issue: meta?.issue, pullRequest: meta?.pullRequest, eventName: meta?.eventName,
      startedAt: meta?.startedAt, releasedAt: meta?.releasedAt, reservedSeconds: meta?.reservedSeconds, agentKeys: meta?.agentKeys };
  }));
  let vm: TraceInput['vm'];
  if (session?.microvmId) {
    try {
      const out = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: session.microvmId }));
      vm = { state: out.state ?? null, imageVersion: out.imageVersion, idlePolicy: out.idlePolicy, startedAt: out.startedAt };
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
      vm = { state: null };
    }
  }
  const imagePolicy = session ? await createImagePolicies(table, latestImageVersion ?? '', db)(session.imageVersion) : undefined;
  return snapshot({ imagePolicy, installationId, now: Date.now(), latestImageVersion, session, lease: session ? registry?.leases?.[session.generation] : undefined,
    worker, queued, waiting, vm, jobs });
}

async function main() {
  const { values } = parseArgs({ options: {
    installation: { type: 'string' }, stack: { type: 'string', default: 'updraft-cloud' }, region: { type: 'string' },
    watch: { type: 'string' }, jobs: { type: 'string', default: '5' },
  } });
  const installationId = Number(values.installation);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('usage: claude-session-trace --installation <id> [--watch <seconds>] [--jobs <n>] [--stack <name>] [--region <region>]');
  const clients = createAdminClients(values.region);
  const stack = (await clients.cloudFormation.send(new DescribeStacksCommand({ StackName: values.stack }))).Stacks?.[0];
  const outputs = Object.fromEntries((stack?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
  const parameters = Object.fromEntries((stack?.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue ?? '']));
  if (!outputs.TableName) throw new Error(`stack ${values.stack} has no TableName output`);
  const microvms = new LambdaMicrovmsClient(values.region ? { region: values.region } : {});
  const latest = parameters.ManagedClaudeImageVersion || undefined;
  const every = values.watch === undefined ? 0 : Math.max(5, Number(values.watch) || 0);
  for (;;) {
    console.log(JSON.stringify(await read(clients.dynamo, outputs.TableName, installationId, Math.max(1, Number(values.jobs) || 5), latest, microvms)));
    if (!every) return;
    await new Promise((resolve) => setTimeout(resolve, every * 1000));
  }
}

if (process.argv[1]?.endsWith('claude-session-trace.ts')) {
  main().catch((err: unknown) => { console.error((err as Error)?.message ?? String(err)); process.exitCode = 1; });
}
