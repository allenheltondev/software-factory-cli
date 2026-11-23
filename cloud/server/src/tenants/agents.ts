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

/**
 * Variables that can stand in for an agent's API key. Claude: a Claude subscription's token, from
 * `claude setup-token`, which Claude Code uses in place of API credits.
 *
 * What a workflow needs is still recorded as the agent's key (SUPPORTED_AGENT_KEY_ENV): published
 * versions and job records name ANTHROPIC_API_KEY, and the token meets that need (keysMet). When
 * both are set, a job is handed the token alone (keysToHand): the subscription is used, not credits.
 */
export const ALTERNATE_AGENT_KEY_ENV: Partial<Record<CloudAgent, readonly string[]>> = { claude: ['CLAUDE_CODE_OAUTH_TOKEN'] };

/** Every variable an agent's key may be passed in: its API key first, then the alternatives. */
export function agentKeyVariables(agent: CloudAgent): string[] {
  return [SUPPORTED_AGENT_KEY_ENV[agent], ...(ALTERNATE_AGENT_KEY_ENV[agent] ?? [])];
}

/** An agent's key as a tenant is asked for it: `ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN` for Claude. */
export function keyOrAlternatives(agent: CloudAgent): string {
  return agentKeyVariables(agent).join(' or ');
}

/** The API key an alternative stands in for (CLAUDE_CODE_OAUTH_TOKEN: ANTHROPIC_API_KEY); undefined for any other name. */
export function alternativeTo(name: string): string | undefined {
  for (const [agent, alts] of Object.entries(ALTERNATE_AGENT_KEY_ENV)) if (alts?.includes(name)) return SUPPORTED_AGENT_KEY_ENV[agent as CloudAgent];
  return undefined;
}

/**
 * The needs the set keys meet: the set itself, plus an agent's API key when one of its
 * alternatives is set. What every "is this key set" check compares a workflow's needs with.
 */
export function keysMet(set: Iterable<string>): Set<string> {
  const met = new Set(set);
  for (const name of [...met]) {
    const primary = alternativeTo(name);
    if (primary) met.add(primary);
  }
  return met;
}

/**
 * The keys to hand a job, from those set: each one, except an API key whose alternative is set
 * too (the alternative is used instead: a Claude subscription before API credits).
 */
export function keysToHand(set: Iterable<string>): string[] {
  const all = [...new Set(set)];
  const replaced = new Set(all.map(alternativeTo).filter((k): k is string => k !== undefined));
  return all.filter((name) => !replaced.has(name));
}

/** The key names a job's needs were met with, from the keys handed: each need, or the alternative that stood in for it. */
export function keysUsedFor(needed: readonly string[], handed: Iterable<string>): string[] {
  const h = new Set(handed);
  return needed.flatMap((need) => {
    if (h.has(need)) return [need];
    const agent = (Object.entries(SUPPORTED_AGENT_KEY_ENV) as [CloudAgent, string][]).find(([, k]) => k === need)?.[0];
    return (agent ? (ALTERNATE_AGENT_KEY_ENV[agent] ?? []) : []).filter((alt) => h.has(alt));
  });
}
