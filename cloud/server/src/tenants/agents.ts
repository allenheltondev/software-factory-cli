/** Every agent Updraft Cloud can run, and the variable each one's API key is passed in as. */
export const SUPPORTED_AGENT_KEY_ENV = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY', kiro: 'KIRO_API_KEY' } as const;
export type CloudAgent = keyof typeof SUPPORTED_AGENT_KEY_ENV;

/** What a deployment runs when CLOUD_AGENTS is not set: what the job image ships by default and Codex, as before Kiro. */
export const DEFAULT_CLOUD_AGENTS: readonly CloudAgent[] = ['claude', 'codex'];

/**
 * The agents a deployment offers (CLOUD_AGENTS, comma-separated; the stack's CloudAgents): the
 * ones its job image ships (deploy/aws-microvm, image/build.env). Unknown names are ignored; an
 * empty or unusable list is the default.
 */
export function agentsFrom(raw: string | undefined): CloudAgent[] {
  const named = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is CloudAgent => s in SUPPORTED_AGENT_KEY_ENV);
  return named.length ? [...new Set(named)] : [...DEFAULT_CLOUD_AGENTS];
}

/**
 * The agents this deployment offers, and each one's key variable: what a tenant may configure,
 * and the keys the console asks for.
 */
export const AGENT_KEY_ENV: Partial<Record<CloudAgent, string>> = Object.fromEntries(
  agentsFrom(process.env.CLOUD_AGENTS).map((a) => [a, SUPPORTED_AGENT_KEY_ENV[a]]),
);
