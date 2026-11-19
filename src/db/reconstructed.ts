// How rows that were reconstructed from GitHub are told from rows a run recorded itself
// (docs/shared-state.md, "Reconstructed rows"). `updraft run-event` writes them when a pull
// request it opened exists on GitHub and the state database has nothing of the run that opened
// it; `updraft state merge` never lets one replace the real row should that turn up later.

/** `runs.worker_id` (and `hostname`) of a run nobody observed: its row was rebuilt from the pull request. */
export const RECONSTRUCTED_WORKER = 'reconstructed';
/** How `jobs.status_reason`, `runs.error` and `publications.error` of such rows begin. */
export const RECONSTRUCTED_PREFIX = 'reconstructed: ';
/**
 * `created_at` and `updated_at` of a reconstructed `revision_prs` row: older than anything a run
 * records, so that under "the later updated_at wins" every recorded row beats it.
 */
export const RECONSTRUCTED_AT = '1970-01-01T00:00:00.000Z';

export const isReconstructedText = (v: unknown): boolean => typeof v === 'string' && v.startsWith(RECONSTRUCTED_PREFIX);
