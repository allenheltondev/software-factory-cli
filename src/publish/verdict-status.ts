// The status comment's line for a verdict (quiet notifications): a leaf module, shared by the
// review posting (review.ts) and the suggestion step (suggestions.ts) without either importing the other.
import { DEFAULT_MAX_REVISIONS, autoMergeMethod, ciSettings, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import type { ReviewOutcome } from '../db/pr-reviews.js';
import { shortSha } from './status-comment.js';
import { STATUS_STAGE } from './status-marker.js';

/**
 * The status comment's stage after a verdict on the current head (quiet notifications): the loop
 * at work (a revision queued, checks or a merge to come) or resting until a person acts. Null for
 * a verdict that was stale, or a pull request that is closed.
 */
export function verdictStatus(config: UpdraftConfig, repo: RepositoryConfig, outcome: ReviewOutcome, prNumber: number, headSha: string): { stage: number; title: string; text: string } | null {
  const at = `\`${shortSha(headSha)}\``;
  switch (outcome) {
    case 'revision-queued':
      return { stage: STATUS_STAGE.loop, title: 'Changes requested', text: `The review asked for changes on ${at} of PR #${prNumber}; a revision is queued.` };
    case 'over-limit':
      return { stage: STATUS_STAGE.person, title: 'Revision limit reached', text: `The review asked for changes on ${at}, and PR #${prNumber} has used its ${repo.maxRevisions ?? DEFAULT_MAX_REVISIONS} revision(s); the changes are up to a person.` };
    case 'no-revise':
      return { stage: STATUS_STAGE.person, title: 'Changes requested', text: `The review asked for changes on ${at} of PR #${prNumber}; revisions are off here, so the changes are up to a person.` };
    case 'needs-verification':
      return { stage: STATUS_STAGE.person, title: 'Waiting for a person', text: `The review found ${at} of PR #${prNumber} done but some acceptance criteria unverified; a person checks them and merges.` };
    case 'ready': {
      if (ciSettings(config, repo)) return { stage: STATUS_STAGE.loop, title: 'Waiting for checks', text: `The review found ${at} of PR #${prNumber} ready; Updraft waits for its checks.` };
      const method = autoMergeMethod(config, repo);
      return method
        ? { stage: STATUS_STAGE.loop, title: 'Ready to merge', text: `The review found ${at} of PR #${prNumber} ready; Updraft merges it once its required checks pass.` }
        : { stage: STATUS_STAGE.person, title: 'Ready for a person to merge', text: `The review found ${at} of PR #${prNumber} ready; merging is up to a person.` };
    }
    default:
      return null;
  }
}
