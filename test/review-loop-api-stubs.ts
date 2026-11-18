// The review loop's part of GitHubApi (docs/review-loop.md) for fakes that have nothing to do
// with it: every call throws, so a test that reaches one by accident fails loudly.
import type { GitHubApi } from '../src/github/api.js';

type ReviewLoopApi = Pick<
  GitHubApi,
  'getPullRequest' | 'listPullRequestReviews' | 'createPullRequestReview' | 'markPullRequestReady' | 'getCommitChecks' | 'mergePullRequest'
>;

const unused = (name: string) => (): never => {
  throw new Error(`${name} is not used by this test`);
};

export class ReviewLoopApiStubs implements ReviewLoopApi {
  getPullRequest: ReviewLoopApi['getPullRequest'] = unused('getPullRequest');
  listPullRequestReviews: ReviewLoopApi['listPullRequestReviews'] = unused('listPullRequestReviews');
  createPullRequestReview: ReviewLoopApi['createPullRequestReview'] = unused('createPullRequestReview');
  markPullRequestReady: ReviewLoopApi['markPullRequestReady'] = unused('markPullRequestReady');
  getCommitChecks: ReviewLoopApi['getCommitChecks'] = unused('getCommitChecks');
  mergePullRequest: ReviewLoopApi['mergePullRequest'] = unused('mergePullRequest');
}
