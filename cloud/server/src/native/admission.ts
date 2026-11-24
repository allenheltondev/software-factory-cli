import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { FlowError } from '../flows/github.js';

export const SESSION_SECONDS = 8 * 60 * 60;
export const STARTUP_MS = 10 * 60_000;
export const IDLE_MS = 15 * 60_000;
export interface SessionLease {
  installationId: number;
  generation: string;
  requestedAt: number;
  idleAt: number;
  mayHaveLaunched: boolean;
  retiring?: boolean;
  microvmId?: string;
}
interface Registry {
  revision: number;
  leases: Record<string, SessionLease>;
  day: string;
  seconds: number;
  tenants: Record<string, number>;
}
export interface AdmissionLimits {
  concurrent: number;
  dailySeconds: number;
  tenantDailySeconds: number;
}
export const DEFAULT_ADMISSION: AdmissionLimits = {
  concurrent: 4,
  dailySeconds: 24 * SESSION_SECONDS,
  tenantDailySeconds: 3 * SESSION_SECONDS,
};
const key = { pk: 'CLAUDE_CAPACITY', sk: 'REGISTRY' };

/** One bounded, strongly consistent CAS registry. Capacity never expires via TTL or a guessed deadline. */
export function createClaudeAdmission(
  table: string,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
) {
  async function read(): Promise<Registry> {
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    return (Item as Registry) ?? { revision: 0, leases: {}, day: '', seconds: 0, tenants: {} };
  }
  async function change<T>(mutate: (registry: Registry) => T): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const registry = await read();
      const result = mutate(registry);
      try {
        await db.send(
          new PutCommand({
            TableName: table,
            Item: { ...key, ...registry, revision: registry.revision + 1 },
            ConditionExpression: registry.revision === 0 ? 'attribute_not_exists(pk)' : 'revision = :revision',
            ...(registry.revision === 0 ? {} : { ExpressionAttributeValues: { ':revision': registry.revision } }),
          }),
        );
        return result;
      } catch (err) {
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
    reserve(installationId: number, generation: string, now: number, limits = DEFAULT_ADMISSION) {
      return change((registry) => {
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
        const day = new Date(now).toISOString().slice(0, 10);
        if (registry.day > day)
          throw new FlowError('throttled', 429, 'The Claude budget window is changing. Try connecting again shortly.');
        if (registry.day !== day) {
          registry.day = day;
          registry.seconds = 0;
          registry.tenants = {};
        }
        const tenantSeconds = registry.tenants[String(installationId)] ?? 0;
        if (
          registry.seconds + SESSION_SECONDS > limits.dailySeconds ||
          tenantSeconds + SESSION_SECONDS > limits.tenantDailySeconds
        ) {
          throw new FlowError(
            'throttled',
            429,
            'The daily Claude connection budget has been reached. Try again after midnight UTC or contact an operator.',
          );
        }
        registry.seconds += SESSION_SECONDS;
        registry.tenants[String(installationId)] = tenantSeconds + SESSION_SECONDS;
        return (registry.leases[generation] = {
          installationId,
          generation,
          requestedAt: now,
          idleAt: now + IDLE_MS,
          mayHaveLaunched: false,
        });
      });
    },
    launching(generation: string) {
      return change((registry) => {
        const lease = registry.leases[generation];
        if (!lease || lease.retiring)
          throw new FlowError('invalid_settings', 409, 'This environment was retired. Reconnect Claude to try again.');
        lease.mayHaveLaunched = true;
      });
    },
    bind(generation: string, microvmId: string) {
      return change((registry) => {
        const lease = registry.leases[generation];
        if (!lease || (lease.microvmId && lease.microvmId !== microvmId))
          throw new Error('Managed admission generation changed');
        lease.microvmId = microvmId;
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
        if (lease && !lease.retiring) lease.idleAt = now + IDLE_MS;
      });
    },
    /** Caller must establish physical termination, or seal a generation before any launch was possible. */
    release(generation: string) {
      return change((registry) => {
        delete registry.leases[generation];
      });
    },
  };
}
export type ClaudeAdmission = ReturnType<typeof createClaudeAdmission>;
