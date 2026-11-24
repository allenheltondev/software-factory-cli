import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_REPORT_BYTES = 1024 * 1024;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const money = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Read only numeric run totals, then remove Vibe's temporary report and copied journals. */
export async function consumeVibeUsage(directory: string): Promise<string | undefined> {
  try {
    const file = join(directory, 'export.json');
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_REPORT_BYTES) return;
    const report = JSON.parse(await readFile(file, 'utf8'));
    if (report?.schema_version !== 1) return;
    const runs = [report, ...(Array.isArray(report.subagents) ? report.subagents : [])];
    const sum = (read: (run: typeof report) => number | undefined, validate = count) => {
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
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
