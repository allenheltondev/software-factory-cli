/**
 * The subscription CLI a managed session runs (#125): Claude Code on a Claude subscription, or
 * Codex on a ChatGPT plan. Each provider has its own session, worker, waiting jobs and console
 * page, so the two logins never share a VM and a Codex job never waits on a Claude sign-in.
 *
 * Data compatibility: everything Claude stored before providers existed keeps its exact key
 * (`CLAUDE_SESSION`, `CLAUDE_WAIT#…`, `managed-<id>`, the `claude-wait` id salt, the shared
 * `CLAUDE_CAPACITY` registry). Codex gets new, additive keys beside them. A stored record that
 * names no provider (an admission lease, a queue route, a job's worker id) is Claude's.
 */
export type NativeProvider = 'claude' | 'codex';
export const NATIVE_PROVIDERS: readonly NativeProvider[] = ['claude', 'codex'];

export interface ProviderKeys {
  provider: NativeProvider;
  /** For people: "Claude", "Codex". */
  name: string;
  /** What the person signs in to: "Claude", "ChatGPT". */
  account: string;
  /** The agent key a subscription job of this provider is never given. */
  apiKey: 'ANTHROPIC_API_KEY' | 'CODEX_API_KEY';
  /** The session record's sort key under `TENANT#<id>`. */
  sessionSk: string;
  /** The waiting jobs' sort key prefix under `TENANT#<id>`. */
  waitPrefix: string;
  /** Salt of the waiting job's stable id. */
  waitSalt: string;
  /**
   * S3 folder of a waiting job's event, under `tenants/<id>/events/`. Codex shares Claude's
   * folder: its objects carry the same two-day retention tag the stack's lifecycle rule and the
   * webhook's tagging permission already cover, and their ids never collide (another salt).
   */
  eventFolder: string;
  /** The console page, under `/installations/<id>/`. */
  consolePage: string;
  /** The worker's sign-in route on the private sign-in listener. */
  loginPath: '/claude-login' | '/codex-login';
  /** Timeline code prefix (`claude_…`, `codex_…`). */
  code: string;
  /** Structured log key for session decisions. */
  logKey: 'claudeSession' | 'codexSession';
}

const KEYS: Record<NativeProvider, ProviderKeys> = {
  claude: {
    provider: 'claude', name: 'Claude', account: 'Claude', apiKey: 'ANTHROPIC_API_KEY',
    sessionSk: 'CLAUDE_SESSION', waitPrefix: 'CLAUDE_WAIT#', waitSalt: 'claude-wait', eventFolder: 'claude-wait',
    consolePage: 'claude', loginPath: '/claude-login', code: 'claude', logKey: 'claudeSession',
  },
  codex: {
    provider: 'codex', name: 'Codex', account: 'ChatGPT', apiKey: 'CODEX_API_KEY',
    sessionSk: 'CODEX_SESSION', waitPrefix: 'CODEX_WAIT#', waitSalt: 'codex-wait', eventFolder: 'claude-wait',
    consolePage: 'codex', loginPath: '/codex-login', code: 'codex', logKey: 'codexSession',
  },
};

/** A provider's keys; anything that is not a known provider (absent, older data) is Claude. */
export const providerKeys = (provider: NativeProvider | undefined = 'claude'): ProviderKeys => KEYS[provider === 'codex' ? 'codex' : 'claude'];

/** The managed worker of an installation: `managed-<id>` for Claude (as before), `managed-codex-<id>` for Codex. */
export const managedWorkerId = (installationId: number, provider: NativeProvider = 'claude') =>
  provider === 'codex' ? `managed-codex-${installationId}` : `managed-${installationId}`;

/** The installation and provider of a managed worker id, or undefined for any other id. */
export function parseManagedWorkerId(workerId: unknown): { installationId: number; provider: NativeProvider } | undefined {
  const m = /^managed-(?:(codex)-)?([1-9]\d{0,15})$/.exec(typeof workerId === 'string' ? workerId : '');
  const installationId = Number(m?.[2]);
  if (!m || !Number.isSafeInteger(installationId)) return undefined;
  return { installationId, provider: m[1] === 'codex' ? 'codex' : 'claude' };
}

export const isManagedWorkerId = (workerId: unknown) => parseManagedWorkerId(workerId) !== undefined;

/** The provider of a stored worker id or queue route: Codex only for a Codex managed worker. */
export const providerOfWorker = (workerId: string | undefined): NativeProvider => parseManagedWorkerId(workerId)?.provider ?? 'claude';

/** What an owner is told when this deployment's worker image cannot run Codex yet (#125). */
export const CODEX_UNAVAILABLE = "Connect ChatGPT is not available on this deployment's worker image yet. An operator needs to publish a subscription worker image verified with Codex.";
