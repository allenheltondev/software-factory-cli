/**
 * Whether a verified subscription worker version may run Codex (#125), decided after its Claude
 * smoke passed. A Codex failure never blocks the Claude rollout: the version is still published
 * and approved for Claude, its Codex capability is simply not recorded, so Cloud keeps Codex off
 * on it, and the failure is said loudly (a workflow warning and the step summary). Only the Claude
 * smoke failing fails the image job.
 */
export interface CodexCapabilityDeps {
  /** Whether the version already has its Codex capability record. */
  has(version: string): Promise<boolean>;
  /** The Codex session smoke check on a real VM (native-claude-image-check.ts, provider codex). */
  smoke(version: string): Promise<void>;
  /** Writes the capability record (image-policy.ts recordCodexCapability). */
  record(version: string): Promise<void>;
  log(line: string): void;
  /** Appends a line to the CI step summary, where there is one. */
  summary?(line: string): void;
}

export type CodexCapabilityOutcome = 'present' | 'recorded' | 'failed';

export async function ensureCodexCapability(deps: CodexCapabilityDeps, version: string, codexVersion: string): Promise<CodexCapabilityOutcome> {
  try {
    if (await deps.has(version)) return 'present';
    await deps.smoke(version);
    await deps.record(version);
    deps.log(`==> worker version ${version} passed the Codex session smoke test; Codex ${codexVersion} recorded for it`);
    deps.summary?.(`Codex ${codexVersion} verified on subscription worker image ${version}: Connect ChatGPT is offered on it.`);
    return 'recorded';
  } catch (error) {
    const why = error instanceof Error ? error.message : 'unknown error';
    // GitHub Actions shows ::warning:: lines as annotations on the run.
    deps.log(`::warning title=Codex not enabled on image ${version}::The Codex check failed (${why}). The image is published for Claude only; Connect ChatGPT stays off on it.`);
    deps.summary?.(`:warning: Codex was NOT enabled on subscription worker image ${version}: ${why}. Claude is unaffected; Connect ChatGPT stays off on this image.`);
    return 'failed';
  }
}
