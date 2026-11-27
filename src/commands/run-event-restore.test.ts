// readOwnPullRequest with publishAs user: which pull requests of the person of github.publisher are
// Updraft's, and the account id the adopted publication is recorded with.
import { describe, expect, it } from 'vitest';
import type { GitHubApi, PullRequestDetails } from '../github/api.js';
import { readOwnPullRequest } from './run-event-restore.js';

const REPO = { id: 42, fullName: 'octo/widgets' };
const RUN = 'run_0abc';

function api(pr: Partial<PullRequestDetails>): Pick<GitHubApi, 'getPullRequest' | 'getWorkerIdentity'> {
  return {
    getPullRequest: async () => ({
      number: 100,
      nodeId: 'PR_100',
      htmlUrl: 'https://github.com/octo/widgets/pull/100',
      state: 'open',
      merged: false,
      draft: true,
      headRef: 'updraft/issue-7-job_0abc',
      headSha: 'a'.repeat(40),
      baseRef: 'main',
      mergeable: true,
      mergeableState: 'clean',
      author: 'alice',
      authorId: 7,
      body: `Body.\n\n<!-- updraft-run: ${RUN} -->`,
      headRepoId: 42,
      ...pr,
    }),
    getWorkerIdentity: async () => ({ kind: 'app', login: 'updraft[bot]', id: 9, appSlug: 'updraft' }) as never,
  };
}

describe('readOwnPullRequest of a person-published pull request', () => {
  it("records the author's account id, so the loop keeps checking the sign-in by id", async () => {
    const answer = await readOwnPullRequest(api({}), REPO, 100, { login: 'alice' });
    expect(answer).toMatchObject({ kind: 'ours', own: { runId: RUN, publisher: { kind: 'user', login: 'alice', id: 7 } } });
  });

  it('takes the configured id when GitHub did not report the author\'s', async () => {
    const answer = await readOwnPullRequest(api({ authorId: null }), REPO, 100, { login: 'alice', id: 7 });
    expect(answer).toMatchObject({ kind: 'ours', own: { publisher: { kind: 'user', login: 'alice', id: 7 } } });
  });

  it('records no id only when neither GitHub nor the config gives one', async () => {
    const answer = await readOwnPullRequest(api({ authorId: undefined }), REPO, 100, { login: 'alice' });
    expect(answer).toMatchObject({ kind: 'ours', own: { publisher: { kind: 'user', login: 'alice', id: null } } });
  });

  it('does not adopt a pull request of another account with the same login', async () => {
    const answer = await readOwnPullRequest(api({ authorId: 8 }), REPO, 100, { login: 'alice', id: 7 });
    expect(answer).toEqual({ kind: 'not-ours', why: 'it was opened by alice (account 8), not by account 7 of github.publisher' });
  });

  it("does not adopt the person's pull request without the job branch or the run marker", async () => {
    expect(await readOwnPullRequest(api({ headRef: 'feature/x' }), REPO, 100, { login: 'alice', id: 7 })).toMatchObject({ kind: 'not-ours' });
    expect(await readOwnPullRequest(api({ body: 'no marker' }), REPO, 100, { login: 'alice', id: 7 })).toMatchObject({ kind: 'not-ours' });
  });
});
