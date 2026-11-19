/** Agents the job image ships, and the variable each one's API key is passed in as. */
export const AGENT_KEY_ENV = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY' } as const;
export type CloudAgent = keyof typeof AGENT_KEY_ENV;
