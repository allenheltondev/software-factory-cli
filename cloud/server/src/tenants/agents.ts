/**
 * Agents Updraft Cloud runs, and the variable each one's API key is passed in as. The job image
 * ships Claude Code by default; Codex and Kiro are added to it at build time (deploy/aws-microvm,
 * image/build.env).
 */
export const AGENT_KEY_ENV = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY', kiro: 'KIRO_API_KEY' } as const;
export type CloudAgent = keyof typeof AGENT_KEY_ENV;
