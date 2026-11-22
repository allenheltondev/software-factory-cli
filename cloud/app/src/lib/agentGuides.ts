/** Where a tenant creates a provider credential and the provider's own instructions for it (#92). */
export interface GuideLink {
  label: string;
  href: string;
}

export interface AgentGuide {
  agent: string;
  /** Updraft's key name for the credential; null when the deployment has no key slot for it. */
  keyName: string | null;
  /** The credential Updraft takes, in the provider's words. */
  credential: string;
  billing: string;
  getKeyUrl: string;
  guides: GuideLink[];
  note?: string;
}

export const AGENT_GUIDES: Record<'claude' | 'codex' | 'kiro', AgentGuide> = {
  claude: {
    agent: 'Claude Code',
    keyName: 'ANTHROPIC_API_KEY',
    credential: 'a Claude Console API key',
    billing: "Usage is billed to your Claude API account.",
    getKeyUrl: 'https://platform.claude.com/settings/keys',
    guides: [{ label: 'Get your Claude API key', href: 'https://platform.claude.com/docs/en/get-api-key' }],
  },
  codex: {
    agent: 'Codex',
    keyName: 'CODEX_API_KEY',
    credential: 'an OpenAI Platform API key',
    billing: "Usage is billed to your OpenAI API account.",
    getKeyUrl: 'https://platform.openai.com/api-keys',
    guides: [
      { label: 'Codex authentication with an API key', href: 'https://learn.chatgpt.com/docs/auth#sign-in-with-an-api-key' },
      { label: 'OpenAI API key creation', href: 'https://developers.openai.com/api/docs/quickstart#create-and-export-an-api-key' },
    ],
  },
  kiro: {
    agent: 'Kiro',
    keyName: null,
    credential: 'a Kiro headless API key',
    billing: "Usage draws from your Kiro subscription's credits.",
    getKeyUrl: 'https://app.kiro.dev/',
    guides: [
      { label: 'Generate a Kiro API key', href: 'https://kiro.dev/docs/getting-started/authentication/#generate-an-api-key' },
      { label: 'Enable API keys for an organization', href: 'https://kiro.dev/docs/enterprise/governance/api-keys/' },
    ],
    note: 'Open the API Keys section of the Kiro portal. Key generation is documented for Pro, Pro+, Pro Max and Power; on a managed organization an administrator may need to enable user-generated API keys first.',
  },
};
