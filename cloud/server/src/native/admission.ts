import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { FlowError } from '../flows/github.js';

export const SESSION_SECONDS = 8 * 60 * 60;
export const STARTUP_MS = 10 * 60_000;
export const IDLE_MS = SESSION_SECONDS * 1000;
export interface SessionLease {
  installationId: number;
  generation: string;
  requestedAt: number;
  idleAt: number;
  mayHaveLaunched: boolean;
  launchedAt?: number;
  reservedSeconds?: number;
  idleMs?: number;
  retiring?: boolean;
  microvmId?: string;
}
interface Registry {
  revision: number;
  leases: Record<string, SessionLease>;
  day: string;
  seconds: number;
  tenants: Record<string, number>;
  accountingVersion?: number;
  launches?: number;
  tenantLaunches?: Record<string, number>;
}
export interface AdmissionLimits {
  concurrent: number;
  dailySeconds: number;
  tenantDailySeconds: number;
  idleMs?: number;
  platformLaunchesPerDay?: number;
  tenantLaunchesPerDay?: number;
}
export const DEFAULT_ADMISSION: AdmissionLimits = {
  concurrent: 4,
  dailySeconds: 24 * SESSION_SECONDS,
  tenantDailySeconds: 3 * SESSION_SECONDS,
  idleMs: IDLE_MS,
  platformLaunchesPerDay: 96,
  tenantLaunchesPerDay: 12,
};
export function managedPolicy(env: Record<string, string | undefined>): AdmissionLimits {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    concurrent: integer('NATIVE_MANAGED_CONCURRENT_SESSIONS', 4, 1, 20),
    dailySeconds: integer('NATIVE_MANAGED_PLATFORM_DAILY_HOURS', 192, 8, 8000) * 3600,
    tenantDailySeconds: integer('NATIVE_MANAGED_TENANT_DAILY_HOURS', 24, 8, 192) * 3600,
    idleMs: integer('NATIVE_MANAGED_IDLE_MINUTES', 480, 15, 480) * 60_000,
    platformLaunchesPerDay: integer('NATIVE_MANAGED_PLATFORM_LAUNCHES_PER_DAY', 96, 1, 1000),
    tenantLaunchesPerDay: integer('NATIVE_MANAGED_TENANT_LAUNCHES_PER_DAY', 12, 1, 100),
  };
}

/** Upgrade legacy prepaid accounting once; preserve settled charges whose duration is unknown. */
function migrate(registry: Registry) {
  if (registry.accountingVersion === 2) return;
  registry.launches = Math.ceil(registry.seconds / SESSION_SECONDS);
  registry.tenantLaunches = Object.fromEntries(
    Object.entries(registry.tenants).map(([id, seconds]) => [id, Math.ceil(seconds / SESSION_SECONDS)]),
  );
  for (const lease of Object.values(registry.leases)) {
    lease.idleMs ??= IDLE_MS;
    if (lease.microvmId) {
      lease.mayHaveLaunched = true;
      lease.launchedAt ??= lease.requestedAt;
    }
    lease.idleAt = Math.max(lease.idleAt, lease.requestedAt + lease.idleMs);
    if (new Date(lease.requestedAt).toISOString().slice(0, 10) !== registry.day) continue;
    registry.seconds = Math.max(0, registry.seconds - (lease.reservedSeconds ?? SESSION_SECONDS));
    const id = String(lease.installationId);
    registry.tenants[id] = Math.max(0, (registry.tenants[id] ?? 0) - (lease.reservedSeconds ?? SESSION_SECONDS));
  }
  registry.accountingVersion = 2;
}
function budgetDay(registry: Registry, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (registry.day > day)
    throw new FlowError('throttled', 429, 'The Claude budget window is changing. Try connecting again shortly.');
  if (registry.day !== day) {
    registry.day = day;
    registry.seconds = 0;
    registry.tenants = {};
    registry.launches = 0;
    registry.tenantLaunches = {};
  }
}
const key = { pk: 'CLAUDE_CAPACITY', sk: 'REGISTRY' };

/** One bounded, strongly consistent CAS registry. Capacity never expires via TTL or a guessed deadline. */
export function createClaudeAdmission(
  table: string,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
) {
  async function read(): Promise<Registry> {
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    const registry = (Item as Registry) ?? { revision: 0, leases: {}, day: '', seconds: 0, tenants: {} };
    migrate(registry);
    return registry;
  }
  async function change<T>(
    mutate: (registry: Registry) => T,
    binding?: { generation: string; installationId?: number; state: 'active' | 'sealed' | 'inactive' },
  ): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const registry = await read();
      migrate(registry);
      const installationId =
        binding?.installationId ?? (binding ? registry.leases[binding.generation]?.installationId : undefined);
      const result = mutate(registry);
      if (binding && installationId === undefined) return result;
      try {
        const put = {
          TableName: table,
          Item: { ...key, ...registry, revision: registry.revision + 1 },
          ConditionExpression: registry.revision === 0 ? 'attribute_not_exists(pk)' : 'revision = :revision',
          ...(registry.revision === 0 ? {} : { ExpressionAttributeValues: { ':revision': registry.revision } }),
        };
        if (binding) {
          // Session eligibility and the global registry CAS commit together. A retired/replaced
          // generation cannot recreate a hold or mark a previously safe hold as possibly launched.
          await db.send(
            new TransactWriteCommand({
              TransactItems: [
                { Put: put },
                {
                  ConditionCheck: {
                    TableName: table,
                    Key: { pk: `TENANT#${installationId}`, sk: 'CLAUDE_SESSION' },
                    ConditionExpression:
                      binding.state === 'active'
                        ? 'generation = :generation AND attribute_not_exists(retiring)'
                        : binding.state === 'sealed'
                          ? 'generation = :generation AND retiring = :retiring'
                          : 'attribute_not_exists(pk) OR generation <> :generation OR retiring = :retiring',
                    ExpressionAttributeValues: {
                      ':generation': binding.generation,
                      ...(binding.state === 'active' ? {} : { ':retiring': true }),
                    },
                  },
                },
              ],
            }),
          );
        } else await db.send(new PutCommand(put));
        return result;
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          if (err.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed') {
            throw new FlowError(
              'invalid_settings',
              409,
              'The Claude environment generation changed. Reconnect using its current status.',
            );
          }
          if (
            err.CancellationReasons?.some((reason) =>
              ['ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code ?? ''),
            )
          )
            continue;
        }
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    }
    throw new FlowError('throttled', 429, 'Claude connection admission is busy. Try connecting again shortly.');
  }
  return {
    async list() {
      return Object.values((await read()).leases);
    },
    async get(generation: string) {
      return (await read()).leases[generation];
    },
    reserve(installationId: number, generation: string, now: number, limits = DEFAULT_ADMISSION, recovery = false) {
      return change(
        (registry) => {
          const existing = registry.leases[generation];
          if (existing) {
            if (existing.installationId !== installationId || existing.retiring)
              throw new FlowError(
                'invalid_settings',
                409,
                'This environment is retiring. Wait for it to stop, then reconnect.',
              );
            return existing;
          }
          if (
            Object.keys(registry.leases).length >= limits.concurrent ||
            Object.values(registry.leases).some((lease) => lease.installationId === installationId)
          ) {
            throw new FlowError(
              'throttled',
              429,
              'Claude environment capacity is full. Try connecting again after an environment finishes.',
            );
          }
          budgetDay(registry, now);
          const held = Object.values(registry.leases).reduce(
            (sum, lease) => sum + (lease.reservedSeconds ?? SESSION_SECONDS),
            0,
          );
          const tenantHeld = Object.values(registry.leases)
            .filter((lease) => lease.installationId === installationId)
            .reduce((sum, lease) => sum + (lease.reservedSeconds ?? SESSION_SECONDS), 0);
          const tenantSeconds = registry.tenants[String(installationId)] ?? 0;
          if (
            registry.seconds + held + SESSION_SECONDS > limits.dailySeconds ||
            tenantSeconds + tenantHeld + SESSION_SECONDS > limits.tenantDailySeconds
          ) {
            throw new FlowError(
              'throttled',
              429,
              'The daily Claude runtime budget is reserved or spent. Try again after an environment ends or after midnight UTC.',
            );
          }
          const tenantLaunches = registry.tenantLaunches![String(installationId)] ?? 0;
          if (
            (registry.launches ?? 0) >= (limits.platformLaunchesPerDay ?? DEFAULT_ADMISSION.platformLaunchesPerDay!) ||
            tenantLaunches >= (limits.tenantLaunchesPerDay ?? DEFAULT_ADMISSION.tenantLaunchesPerDay!)
          ) {
            throw new FlowError(
              'throttled',
              429,
              'The daily Claude connection launch limit has been reached. Try again after midnight UTC or contact an operator.',
            );
          }
          registry.launches = (registry.launches ?? 0) + 1;
          registry.tenantLaunches![String(installationId)] = tenantLaunches + 1;
          return (registry.leases[generation] = {
            installationId,
            generation,
            requestedAt: now,
            idleAt: now + (limits.idleMs ?? IDLE_MS),
            idleMs: limits.idleMs ?? IDLE_MS,
            reservedSeconds: SESSION_SECONDS,
            mayHaveLaunched: false,
          });
        },
        { installationId, generation, state: recovery ? 'sealed' : 'active' },
      );
    },
    launching(generation: string, now = Date.now(), recovery = false) {
      return change(
        (registry) => {
          const lease = registry.leases[generation];
          if (!lease || (lease.retiring && !recovery))
            throw new FlowError(
              'invalid_settings',
              409,
              'This environment was retired. Reconnect Claude to try again.',
            );
          lease.mayHaveLaunched = true;
          lease.launchedAt ??= now;
        },
        { generation, state: recovery ? 'sealed' : 'active' },
      );
    },
    bind(generation: string, microvmId: string) {
      return change((registry) => {
        const lease = registry.leases[generation];
        if (!lease || (lease.microvmId && lease.microvmId !== microvmId))
          throw new Error('Managed admission generation changed');
        lease.microvmId = microvmId;
        lease.mayHaveLaunched = true;
        lease.launchedAt ??= lease.requestedAt;
      });
    },
    retiring(generation: string) {
      return change((registry) => {
        const lease = registry.leases[generation];
        if (lease) lease.retiring = true;
      });
    },
    touch(generation: string, now: number) {
      return change((registry) => {
        const lease = registry.leases[generation];
        if (lease && !lease.retiring) lease.idleAt = now + (lease.idleMs ?? IDLE_MS);
      });
    },
    /** Reclaim only a sealed/replaced generation whose latest registry state proves no launch. */
    reclaimUnlaunched(generation: string) {
      return change(
        (registry) => {
          const lease = registry.leases[generation];
          if (!lease || lease.mayHaveLaunched || lease.microvmId || lease.launchedAt !== undefined) return false;
          delete registry.leases[generation];
          return true;
        },
        { generation, state: 'inactive' },
      ).catch((err) => {
        if (err instanceof FlowError && err.code === 'invalid_settings') return false;
        throw err;
      });
    },
    /** Caller must establish physical termination, or seal a generation before any launch was possible. */
    release(generation: string, now = Date.now()) {
      return change((registry) => {
        const lease = registry.leases[generation];
        if (!lease) return;
        budgetDay(registry, now);
        // Settle once, after physical termination (or sealing before any possible launch).
        // Active maximum-exposure holds are counted separately, even across UTC midnight.
        const start = lease.launchedAt ?? (lease.mayHaveLaunched ? lease.requestedAt : undefined);
        const midnight = Date.parse(registry.day + 'T00:00:00Z');
        const seconds =
          start === undefined
            ? 0
            : Math.max(
                0,
                Math.ceil(
                  (Math.min(now, start + (lease.reservedSeconds ?? SESSION_SECONDS) * 1000) -
                    Math.max(start, midnight)) /
                    1000,
                ),
              );
        registry.seconds += seconds;
        const id = String(lease.installationId);
        registry.tenants[id] = (registry.tenants[id] ?? 0) + seconds;
        delete registry.leases[generation];
      });
    },
  };
}
export type ClaudeAdmission = ReturnType<typeof createClaudeAdmission>;
