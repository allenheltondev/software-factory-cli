import type { NativeProvider } from './provider.js';

export interface SessionReconcileReport { released: number; failed: number }

/**
 * Each provider's managed sessions reconciled on its own (#125): one provider's failure, thrown
 * or reported, never skips another's, and each error is logged with its name and message (never
 * a credential: these are AWS and DynamoDB errors). The caller fails the run afterwards when any
 * provider failed, so alarms see it and the next run retries.
 */
export async function reconcileSessions(
  stacks: { provider: NativeProvider; reconcile?: () => Promise<SessionReconcileReport> }[],
  log: (entry: Record<string, unknown>) => void = (entry) => console.error(JSON.stringify(entry)),
) {
  const reports: Partial<Record<NativeProvider, SessionReconcileReport>> = {};
  const failures: string[] = [];
  for (const { provider, reconcile } of stacks) {
    if (!reconcile) continue;
    try {
      const report = await reconcile();
      reports[provider] = report;
      if (report.failed) failures.push(`${provider}: ${report.failed} session(s)`);
    } catch (error) {
      reports[provider] = { released: 0, failed: 1 };
      failures.push(`${provider}: ${(error as Error)?.name ?? 'error'}`);
      log({ sessionReconcile: 'failed', provider, name: (error as Error)?.name ?? 'error', message: String((error as Error)?.message ?? error).slice(0, 500) });
    }
  }
  return { reports, failures };
}
