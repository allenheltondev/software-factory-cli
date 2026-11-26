/** Every agent Updraft Cloud can run, and the variable each one's API key is passed in as. */
export const SUPPORTED_AGENT_KEY_ENV = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY', kiro: 'KIRO_API_KEY', vibe: 'MISTRAL_API_KEY' } as const;
export type CloudAgent = keyof typeof SUPPORTED_AGENT_KEY_ENV;

/**
 * The agents Updraft Cloud offers, and each one's key variable: what a tenant may configure and
 * the keys the console asks for. Every supported agent is always offered: the job image ships
 * them all (cloud/server/scripts/job-image-context.ts).
 */
export const AGENT_KEY_ENV: Readonly<Record<CloudAgent, string>> = SUPPORTED_AGENT_KEY_ENV;
