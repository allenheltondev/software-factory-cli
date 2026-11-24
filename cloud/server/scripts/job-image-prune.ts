// Deletes old versions of a MicroVM image so the next build does not hit the API's cap on the
// number of versions an image may have ("has reached the maximum number of versions allowed").
import {
  AccessDeniedException,
  ConflictException,
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageCommand,
  ListMicrovmImageVersionsCommand,
  ResourceNotFoundException,
  type LambdaMicrovmsClient,
  type MicrovmImageVersionSummary,
} from '@aws-sdk/client-lambda-microvms';

/** How many of the newest versions a build leaves in place. */
export const DEFAULT_KEEP_VERSIONS = 5;

const BUSY_IMAGE_STATES = new Set(['CREATING', 'UPDATING', 'DELETING']);
const SETTLE_TIMEOUT_MS = 10 * 60 * 1000;
const SETTLE_POLL_MS = 5_000;

/**
 * Waits until the image is not changing. Deleting versions puts it in UPDATING for a while, and
 * the API refuses an update or another delete until that is over ("Cannot update MicroVM Image in
 * its current state").
 */
export async function waitForImageSettled(
  microvms: LambdaMicrovmsClient,
  imageArn: string,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<void> {
  const { timeoutMs = SETTLE_TIMEOUT_MS, pollMs = SETTLE_POLL_MS, log = console.log } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waited = 0;
  for (;;) {
    const { state } = await microvms.send(new GetMicrovmImageCommand({ imageIdentifier: imageArn }));
    if (!BUSY_IMAGE_STATES.has(state ?? '')) return;
    if (waited >= timeoutMs) throw new Error(`the image is still ${state} after ${Math.round(timeoutMs / 60000)} minutes`);
    if (waited === 0) log(`    waiting for the image to finish ${state?.toLowerCase()}`);
    await sleep(pollMs);
    waited += pollMs;
  }
}

export interface PruneResult {
  deleted: string[];
  /** Versions that should have gone but did not (in use, or the deploy role may not delete). */
  skipped: string[];
}

/** A version no longer counted or touched: already gone or on its way out. */
const GONE = new Set(['DELETED', 'DELETING']);
/** A version that is still building must be left to finish. */
const SETTLED = new Set(['SUCCESSFUL', 'FAILED', 'DELETE_FAILED']);

/** The versions to delete, oldest first: everything settled beyond the `keep` newest, except the `protect`ed ones. */
export function versionsToDelete(versions: MicrovmImageVersionSummary[], keep: number, protect: Iterable<string | undefined>): string[] {
  const protectedVersions = new Set([...protect].filter((v): v is string => Boolean(v)));
  const newestFirst = versions
    .filter((v) => v.imageVersion && !GONE.has(v.state ?? ''))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return newestFirst
    .slice(Math.max(keep, 0))
    .filter((v) => SETTLED.has(v.state ?? '') && !protectedVersions.has(v.imageVersion!))
    .map((v) => v.imageVersion!)
    .reverse();
}

/**
 * Deletes the settled versions of `imageArn` beyond the `keep` newest, never the `protect`ed ones
 * (the version jobs start with, the latest active one). Best effort: a deploy role that may not
 * list or delete versions, or a version that is still in use, is reported and the build goes on,
 * because it only fails if the image is actually at its cap.
 */
export async function pruneImageVersions(
  microvms: LambdaMicrovmsClient,
  imageArn: string,
  options: { keep?: number; protect?: Iterable<string | undefined>; log?: (line: string) => void; settle?: typeof waitForImageSettled } = {},
): Promise<PruneResult> {
  const log = options.log ?? console.log;
  const settle = options.settle ?? waitForImageSettled;
  const result: PruneResult = { deleted: [], skipped: [] };
  const versions: MicrovmImageVersionSummary[] = [];
  await settle(microvms, imageArn, { log });
  try {
    let nextToken: string | undefined;
    do {
      const page = await microvms.send(new ListMicrovmImageVersionsCommand({ imageIdentifier: imageArn, nextToken }));
      versions.push(...(page.items ?? []));
      nextToken = page.nextToken;
    } while (nextToken);
  } catch (error) {
    if (error instanceof AccessDeniedException) {
      log('    cannot list image versions (the deploy role needs lambda:ListMicrovmImageVersions); not pruning old ones');
      return result;
    }
    throw error;
  }

  for (const version of versionsToDelete(versions, options.keep ?? DEFAULT_KEEP_VERSIONS, options.protect ?? [])) {
    try {
      await microvms.send(new DeleteMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: version }));
      result.deleted.push(version);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) continue;
      if (error instanceof AccessDeniedException) {
        log('    cannot delete image versions (the deploy role needs lambda:DeleteMicrovmImageVersion); stopping');
        result.skipped.push(version);
        break;
      }
      if (error instanceof ConflictException) {
        log(`    kept version ${version}: ${error.message}`);
        result.skipped.push(version);
        continue;
      }
      throw error;
    }
  }
  if (result.deleted.length) await settle(microvms, imageArn, { log });
  if (result.deleted.length) log(`==> deleted ${result.deleted.length} old image version${result.deleted.length === 1 ? '' : 's'}: ${result.deleted.join(', ')}`);
  return result;
}
