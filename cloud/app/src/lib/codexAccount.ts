import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';

/** What a page may say about Codex on a ChatGPT plan: status words only, never a credential. */
export interface CodexAccount {
  /** The deployment can run Codex on a ChatGPT plan: only then is the connect link offered. */
  available: boolean;
  status?: 'Connected' | 'Needs sign-in';
}

export type CodexAccountApi = Partial<Pick<ApiClient, 'nativeClaude' | 'nativeCodex'>>;

const NONE: CodexAccount = { available: false };

/**
 * Reads, once per page, whether Connect ChatGPT can be offered (the Claude subscription view
 * carries `codexAvailable`) and, only when it can, whether the account is connected. A failed
 * read means unavailable: the page renders as it did, and nothing waits on this.
 */
export function useCodexAccount(api: CodexAccountApi, installationId: number, valid: boolean): CodexAccount {
  const [account, setAccount] = useState<CodexAccount>(NONE);
  useEffect(() => {
    let live = true;
    if (!valid || !api.nativeClaude) return;
    const signal = AbortSignal.timeout(5000);
    void (async () => {
      try {
        const claude = await api.nativeClaude!(installationId, signal);
        if (!live || claude?.codexAvailable !== true) return;
        setAccount({ available: true });
        const codex = await api.nativeCodex?.(installationId, signal).catch(() => undefined);
        const worker = codex?.worker?.status;
        const status = worker === 'connected' ? 'Connected' : worker === 'auth-required' || worker === 'expired' ? 'Needs sign-in' : undefined;
        if (live && status) setAccount({ available: true, status });
      } catch {
        /* unavailable */
      }
    })();
    return () => {
      live = false;
    };
  }, [api, installationId, valid]);
  return account;
}
