import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../util/log.js';

const MAX_REPORT_BYTES = 1024 * 1024;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const money = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export const VIBE_EXPORT_PREFIX = '.vibe-usage-';

interface VibeRunUsage {
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cached_input_tokens?: unknown };
  cost_usd?: unknown;
  steps?: unknown;
}

async function removeExport(directory: string, log: Pick<Logger, 'warn'>): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    log.warn('could not remove private Vibe export; startup cleanup will retry', {
      directory, code: (error as NodeJS.ErrnoException).code,
    });
  }
}

/** Run under the local worker lock, after interrupted agents have been reconciled. */
export async function recoverVibeExports(
  runsDir: string,
  isInactiveRun: (runId: string) => boolean,
  log: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    for (const run of await readdir(runsDir, { withFileTypes: true })) {
      if (!run.isDirectory() || !run.name.startsWith('run_') || !isInactiveRun(run.name)) continue;
      const directory = join(runsDir, run.name);
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('could not inspect run for private Vibe exports', { runId: run.name });
        return [];
      });
      for (const entry of entries) {
        if (entry.isDirectory() && /^\.vibe-usage-[A-Za-z0-9]{6}$/.test(entry.name)) await removeExport(join(directory, entry.name), log);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('could not scan run logs for abandoned Vibe exports');
  }
}

/** Read only numeric run totals, then remove Vibe's temporary report and copied journals. */
export async function consumeVibeUsage(directory: string, log: Pick<Logger, 'warn'>): Promise<string | undefined> {
  try {
    const file = join(directory, 'export.json');
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_REPORT_BYTES) return;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let report: (VibeRunUsage & { schema_version?: unknown; subagents?: VibeRunUsage[] }) | null;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return;
      const data = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(data);
      report = JSON.parse(data.toString('utf8', 0, bytesRead));
    } finally {
      await handle.close();
    }
    if (report?.schema_version !== 1) return;
    const runs = [report, ...(Array.isArray(report.subagents) ? report.subagents : [])];
    const sum = (read: (run: VibeRunUsage) => number | undefined, validate = count) => {
      const values = runs.map(read);
      return values.every((value) => value !== undefined)
        ? validate(values.reduce<number>((total, value) => total + (value ?? 0), 0))
        : undefined;
    };
    const usage = {
      inputTokens: sum((run) => count(run?.usage?.input_tokens)),
      outputTokens: sum((run) => count(run?.usage?.output_tokens)),
      cacheReadTokens: sum((run) => count(run?.usage?.cached_input_tokens)),
      costUsd: sum((run) => money(run?.cost_usd), money),
      modelSteps: sum((run) => count(run?.steps)),
    };
    if (Object.values(usage).some((value) => value !== undefined)) return `vibe usage: ${JSON.stringify(usage)}`;
  } catch {
    // An absent or incomplete report does not change the job's result.
  } finally {
    await removeExport(directory, log);
  }
}
