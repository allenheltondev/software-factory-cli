/**
 * The one cheap provider call that validates an agent key before it is saved (#70): listing
 * models, which costs nothing and needs no particular permission. The value goes only in the
 * request's header, never in a URL, a log or a message.
 */

export type KeyCheck = 'valid' | 'invalid' | 'unavailable';
export type KeyChecker = (name: string, value: string) => Promise<KeyCheck>;

export const checkAgentKeyWithProvider = (fetchFn: typeof fetch = fetch, timeoutMs = 8000): KeyChecker =>
  async (name, value) => {
    const request: { url: string; headers: Record<string, string> } | null =
      name === 'ANTHROPIC_API_KEY'
        ? { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': value, 'anthropic-version': '2023-06-01' } }
        : name === 'CODEX_API_KEY'
          ? { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${value}` } }
          : null;
    if (!request) return 'unavailable';
    try {
      const res = await fetchFn(request.url, { headers: request.headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return 'valid';
      // 401 is a key the provider does not know; 403 one it knows but refuses. Both are unusable.
      if (res.status === 401 || res.status === 403) return 'invalid';
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
