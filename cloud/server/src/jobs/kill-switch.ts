/**
 * The platform's kill switch (#68): an SSM parameter, `/updraft/kill-switch`, that stops every job.
 * While it is on, the launcher starts nothing and the broker serves running jobs nothing more
 * (start, credentials, GitHub tokens), so they end within minutes; finish and terminate still work.
 *
 * Values `on`, `true`, `1` or `engaged` (any case) turn it on; anything else is off, and so is no
 * parameter at all (the stack does not create one, so a deploy never resets it). A parameter that
 * exists but cannot be read counts as on: what it guards is spend and abuse.
 */
export interface KillSwitch {
  engaged(): Promise<boolean>;
  /**
   * What was read, for diagnostics only (tenants/readiness-service.ts): `unreadable` is a switch
   * that could not be read, which engaged() treats as on. Dispatch decides by engaged() alone.
   */
  state?(): Promise<KillSwitchState>;
}

export type KillSwitchState = 'on' | 'off' | 'unreadable';

export const OFF_SWITCH: KillSwitch = { engaged: async () => false };

export const KILL_SWITCH_PARAMETER = '/updraft/kill-switch';

export function isEngagedValue(value: string | undefined | null): boolean {
  return typeof value === 'string' && ['on', 'true', '1', 'engaged'].includes(value.trim().toLowerCase());
}

/**
 * Reads the parameter at most once per `ttlMs` (per container). `read` resolves to the value, or
 * null when there is no such parameter; it throws when the parameter cannot be read.
 */
export function createKillSwitch({
  read,
  now = Date.now,
  ttlMs = 30_000,
  log = (entry) => console.log(JSON.stringify(entry)),
}: {
  read: () => Promise<string | null>;
  now?: () => number;
  ttlMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}): KillSwitch {
  let cached: { state: KillSwitchState; at: number } | undefined;
  async function state(): Promise<KillSwitchState> {
    if (cached && now() - cached.at < ttlMs) return cached.state;
    let value: KillSwitchState;
    try {
      value = isEngagedValue(await read()) ? 'on' : 'off';
    } catch (err) {
      log({ warning: 'the kill switch could not be read; treating it as on', message: (err as Error)?.message });
      value = 'unreadable';
    }
    cached = { state: value, at: now() };
    return value;
  }
  return {
    async engaged() {
      return (await state()) !== 'off';
    },
    state,
  };
}
