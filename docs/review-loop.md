# The review loop

Off by default. With `repositories.<OWNER/REPO>.review: true`, every head commit of a pull
request Updraft opened is reviewed by a second agent. If the reviewer asks for changes and
[`revise`](revisions.md) is on, the coding agent revises the PR and the new head is reviewed
again, for up to `maxRevisions` rounds. When the reviewer finds a head ready, a draft PR is
marked ready for review and the loop stops: a person merges. With `autoMerge` set as well,
Updraft merges it itself once the checks listed [below](#auto-merge) hold.

```yaml
pools:
  coders: { agents: [claude] }
  reviewers: { agents: [codex] }

actions:
  implement-issue:
    prompt: ./prompts/implement-issue.md
    revisePrompt: ./prompts/revise-pr.md
    reviewPrompt: ./prompts/review-pr.md
    verify: ["npm test"]

repositories:
  octo/widgets:
    id: 42
    checkoutPath: ../clones/widgets
    publish: draft-pr
    revise: true
    review: true
    # maxRevisions: 3
    # autoMerge: squash          # off unless set; read "Auto-merge" first
    # autoMergeWaitMinutes: 60
    workflows:
      - trigger: { event: issue.labeled, label: updraft:ready }
        action: implement-issue
        pool: coders
        reviewPool: reviewers
```

`review` applies only in `live` mode and only together with `publish`. Every action used by a
repository with `review` on needs a `reviewPrompt`; a starting point is
[examples/prompts/review-pr.md](../examples/prompts/review-pr.md). Without `revise`, a
"changes requested" verdict is only posted (a validation warning says so). `autoMerge`
without `review` does nothing.

## Why the verdict is not a GitHub approval

GitHub does not let an account approve or request changes on its own pull request. Updraft
opens PRs as the worker's account and the reviewer runs as that same account, so the only
review it can submit is a comment. The verdict therefore lives in Updraft's own database, and
what appears on the PR is one **comment review** per reviewer run, for people to read. Nothing
is ever decided by reading that comment back from GitHub.

It follows that branch protection which requires an approving review is not satisfied by
Updraft's reviewer. On such a branch a person still has to approve, and auto-merge is refused
by GitHub until they have.

## Stages

`updraft status` shows each watched PR under "Pull requests (review loop)" with its stage:

| Stage | Meaning | Next |
| --- | --- | --- |
| awaiting review | The current head has no verdict yet; its reviewer job is queued or about to be | reviewing |
| reviewing | A reviewer run is in progress, or its review is being posted | changes requested, ready to merge, or needs a human if the run fails |
| changes requested (round n of max) | A reviewer or an allowed person asked for changes; the revision job is queued | revising |
| revising | The coding agent is running on the PR branch, or its commits are being pushed | awaiting review (new head), or needs a human |
| ready to merge | The reviewer found the current head ready; a draft was marked ready for review. The end state unless `autoMerge` is on. If Updraft tried to merge and could not, the reason is shown here | merged by a person, or merging |
| merging / waiting for checks | `autoMerge`: waiting for pending checks, or the merge was requested | merged, or ready to merge with the reason it was not merged |
| merged | Updraft merged it | none |
| needs a human | The loop cannot continue by itself; the line says why: `maxRevisions` reached, the reviewer run failed or gave no readable verdict, a revision failed or pushed nothing, or `revise` is off | `updraft retry JOB_ID`, a push, a new review, or a merge by hand |
| closed | Closed or merged on GitHub; no longer watched | none |

A push by anyone to the PR branch starts over at "awaiting review" for the new head.

## When a review runs

One reviewer job per pull request and head commit:

- after Updraft publishes a PR;
- after every revision Updraft pushes;
- when the head changes for any other reason (someone pushed to the branch).

For its own pushes Updraft makes no request: it knows what it pushed. A head someone else
pushed is noticed by the read the [review poller](revisions.md#what-it-costs-in-api-requests)
already makes when a watched PR changed. The job's key is the PR number and the commit, so a
head is reviewed once across restarts, replays and `updraft clean --older-than`.

A reviewer job is an ordinary job: it appears in `updraft status`, and `updraft logs`,
`updraft cancel` and `updraft retry` work on it. It belongs to the issue of its PR, so it never
runs at the same time as a revision of that PR. A reviewer job whose commit is no longer the
PR's head is canceled before it starts; the new head has its own job.

Turning `review` on for a repository that already has open PRs opened by Updraft reviews
their current heads.

## Who reviews

Reviewers are your coding agents (Claude Code, Codex, Kiro), each review in a fresh context:
see [A fresh context per review](#a-fresh-context-per-review). Which of them reviews is set
with a pool, the same way coding work is routed. The first of these that is set wins:

1. the workflow's `reviewPool`;
2. the repository's `review.pool`, for every workflow of the repository that names none;
3. the pool the original job was routed to.

```yaml
pools:
  coders: { agents: [claude] }
  reviewers: { agents: [codex, kiro, claude] }   # taken in turn

repositories:
  octo/widgets:
    review: { pool: reviewers }
```

- **A fixed reviewer** is a pool with one agent: `reviewers: { agents: [kiro] }`.
- **Round robin** is a pool with several. Reviewer jobs rotate on a cursor of their own, apart
  from the cursor of the pool's coding jobs, so the reviewers take turns even when the same
  pool also writes code, and the rotation survives restarts. Successive heads of one PR
  therefore usually get different reviewers; each is given the earlier reviews' findings.
- A reviewer that is disabled, at its `maxConcurrent` or just failed to start the job is passed
  over for the next one in turn, as for any job.

The reviewer must not be the agent that wrote the code. When a reviewer job is claimed, the
agent of the PR's latest code run is left out of the rotation: the job waits for another
agent in the pool to have capacity. With the pool above and Claude writing every PR, reviews
alternate between Codex and Kiro.

A configuration in which that can never work is rejected by `updraft validate`: for example a
coding pool and a review pool that hold the same single enabled agent. To let an agent review
its own work on purpose, say so:

```yaml
    review: { allowSameAgent: true }
```

Even then another enabled agent in the pool is preferred whenever there is one.

### A fresh context per review

Every reviewer run is a new agent process started in a new worktree: `claude -p`, `codex exec`
or `kiro-cli chat --no-interactive`, never a resumed or continued session. It shares nothing
with the run that wrote the code or with an earlier review except what the prompt below hands
it, as fenced text: the PR, the issue, earlier reviews' findings and people's change
requests. In particular it never sees the coding agent's conversation, its reasoning or its
own summary of what it did, only the commits.

Outside a container the agent runs as your user, so per-user settings of the agent CLI still
apply to it (a global `CLAUDE.md` or Codex `AGENTS.md`, for example), as they do for coding runs.
A [container](isolation.md) gives it a scratch `HOME` instead.

Updraft's reviewer and an outside reviewer such as a ChatGPT task are independent: the review
loop never waits for or reads an outside review, and the outside review's
[result block](review-result.md) is still shown by `updraft reviews`. You can run both.

## What the reviewer is given

The action's `reviewPrompt`, then, generated by the worker:

- what to review: the PR, its **head commit** (checked out in the worktree) and the **base
  commit** (the merge base with the branch the PR was opened against), so it can diff;
- how to answer (the verdict protocol, below);
- the findings of **earlier Updraft reviews** of this PR (the newest five), so it can check
  whether each blocker was addressed;
- **change requests by allowed reviewers** that queued a revision of this PR, as they read when
  the worker first saw them (the same snapshots the [revision loop](revisions.md) uses, never
  a new read), from reviewers who are still allowed actors. This needs `revise`; without it
  people's reviews are not read at all;
- the **original issue**, with the same rule as for a revision: if the issue's text is no
  longer text an allowed actor stands behind, the review still runs but the body is withheld.

Everything from GitHub or from an earlier agent is fenced and labelled as untrusted input, as
in every prompt. Nothing written by an account that is not an allowed actor is included.

## The verdict

The reviewer must end its final message with exactly one line:

```
UPDRAFT-VERDICT: ready-to-merge
```

or

```
UPDRAFT-VERDICT: changes-requested
```

preceded by its findings (the prompt asks for file and line references, with blockers apart
from suggestions). The worker reads that line from the agent's final message: for Claude Code
and Codex, the final message of their structured output, so nothing a tool printed counts; for
an agent with plain-text output (Kiro), the whole output.

The reading fails closed. A missing line, two lines (even two that agree), any other value, or
text after the line makes the reviewer run **failed**. A failed review is never an approval:
the PR goes to "needs a human", and with `commentOnFailure` the PR gets the usual
[failure comment](failure-comments.md).

A verdict is bound to the commit that was reviewed. If the PR's head is a different commit
when the verdict is recorded, or when the revision it queued would start, or when a merge is
considered, the verdict is stale and nothing follows from it.

## The review on the pull request

One comment review per reviewer run, attached to the reviewed commit, with the verdict, the
reviewed commit, the reviewing agent and the findings. The findings are an agent's text about
untrusted code, so they are inside a code fence: mentions, links and closing keywords in them
do nothing. A hidden marker with the run id lets a retry find the review instead of posting a
second one (only among the worker's own reviews). Posting uses the same lease, retries and
`updraft publish RUN_ID` as publication.

The verdict is acted on once its review is on the PR, so nothing happens on a PR that people
cannot see explained there.

## Where the reviewer runs

Through the same path as every live run: the agent's container if it has one, the action's
`timeoutMinutes`, `updraft logs`, `updraft cancel`. What differs:

- **A throwaway worktree at exactly the reviewed commit.** The reviewer never publishes.
  Whatever it changes or commits stays in that worktree and its throwaway local branch, both
  of which the worker deletes after the run, whatever the outcome (success, failure, timeout,
  cancel, shutdown). No step pushes anything from a reviewer run. Only a worker that is killed
  outright leaves the worktree behind.
- **In a container, the clone's git directory is read-only.** The worktree itself and its
  private index stay writable, so the reviewer can build and run tests; the clone's objects,
  refs, config and hooks cannot be written, so `git commit` and `git branch` fail inside the
  container while `git diff`, `git log` and `git show` work. The scratch `HOME` is a tmpfs as
  for every containerized run. Without a container the reviewer runs as your user, like any
  agent ([Isolating agents](isolation.md)).
- **The `verify` commands are not run again.** They ran for the code run that produced the
  commit. The reviewer may run the tests itself.

## Closing the loop

- **changes-requested**, for the current head, with `revise` on: a revision job is queued at
  once, from the worker's own record of the verdict. The revision prompt carries the
  reviewer's findings as fenced input, in place of a person's review.
- A person's "Request changes" review keeps working as described in [Revisions](revisions.md).
- **`maxRevisions` bounds all of it.** Revisions asked for by the reviewer and by people count
  together. When the limit is reached, the PR gets the one existing comment about it and stays
  at "needs a human".
- **ready-to-merge**, for the current head: the worker checks on GitHub that the PR is still
  at that commit, marks a draft ready for review, and stops.

## Auto-merge

Off unless `repositories.<OWNER/REPO>.autoMerge` is set to `squash`, `merge` or `rebase`.

**This is the most dangerous thing Updraft can do.** The issue text and the code under review
are untrusted input. An issue, a code comment, a test name or a file in the repository can
contain text written to talk the reviewing agent into approving, and an agent can be wrong
without being attacked. With auto-merge on, a wrong "ready to merge" becomes a commit on your
base branch with nobody having looked at it. Leave it off unless every actor in
`allowedActors` is someone you would let push to the base branch directly, and protect the
branch on GitHub with required checks you trust.

Updraft merges only when all of these hold, evaluated again after every poll until the merge
settles one way or the other:

1. the newest verdict is `ready-to-merge` and is for the PR's current head commit;
2. the code run that pushed that commit passed the action's `verify` commands on exactly that
   commit, or the action has none. The worker records which commit the commands started on,
   and the pass counts only when that is the commit to merge, the worktree held no uncommitted
   or untracked files when they started, and the checked-out commit had not changed when they
   ended. A commit someone else pushed was never verified by the worker, so with `verify`
   configured it is not merged;
3. on GitHub the PR is open, not a draft, still at that commit, and its base is the branch it
   was opened against;
4. GitHub does not report it unmergeable;
5. no allowed actor has a "Request changes" review outstanding (a later approval or a
   dismissal clears it);
6. no commit status or check run of that commit is failing, none is pending, and at least one
   reported success. The worker's own `verify` commands run in the worktree the agent left,
   where ignored files such as earlier build output can make a test pass that would fail on
   the commit alone, so a merge also needs a check GitHub ran itself to have passed. A check
   run that was skipped or ended neutral does not block, but it is not a pass either: a commit
   whose only checks were skipped is not merged. With `autoMergeRequiredChecks`, each check
   named there must have reported success; name your test job there so that some other
   check passing is not enough. A commit on which no check has succeeded yet, or which is
   still missing a required one, is waited for like a pending one (CI often registers a moment
   after the push, and a passing workflow can arrive after a skipped one) and then given up on: a repository with no CI is never auto-merged. Every page of both listings is read; if either cannot be read to
   its end, it is unknown whether the checks passed and the PR is not merged.

Pending checks, and mergeability GitHub is still computing, are waited for up to
`autoMergeWaitMinutes` (default 60).

The merge itself is one request that names the commit (`sha`) and the method. GitHub refuses
it if anything was pushed after the review, and applies branch protection itself.

If a gate fails, the wait runs out, or GitHub refuses the merge (branch protection, a
conflict, a moved head), that is final for that commit: the reason is recorded, one comment on
the PR says so, and the PR stays at "ready to merge" for a person. Updraft never forces a
merge, never bypasses protection, never retries a refused merge and never deletes a branch.
The only repetition is for a merge request that got no answer at all (a network error): the
next cycle asks GitHub what became of it, and after three such requests it gives up. A new
head starts a new review and a new decision.

What the gates cover: that the commit merged is the commit reviewed and verified; that
GitHub's own checks passed; that no allowed person objected; that GitHub's branch rules were
applied.

What they do not cover:

- **whether the reviewer was right.** It is an agent reading untrusted text. A second agent
  makes a successful prompt injection harder, not impossible, and both agents may share blind
  spots;
- **what the checks check.** Without `autoMergeRequiredChecks`, any one successful check satisfies the gate, and a PR can change the tests
  or the CI configuration it is judged by. Required checks on the base branch that a PR cannot
  redefine are GitHub's to enforce;
- **`verify` beyond its exit code**, and only for commits the worker pushed;
- **people who have not reviewed.** Only an outstanding "Request changes" by an allowed actor
  blocks; silence does not;
- **reviews or checks that arrive between the last look and the merge request.** The pinned
  commit covers pushes, nothing else.

## What it costs in API requests

On top of the [revision loop's polling](revisions.md#what-it-costs-in-api-requests), which
`review` turns on for the repository even without `revise` (one conditional listing per poll
while a watched PR is open, plus one GraphQL request per watched PR that changed):

- queueing reviewer jobs: nothing;
- starting a reviewer job: one GraphQL request for the PR, plus the issue lookups of any job;
- per reviewer run: one request for the worker's own login (once per worker process), one
  listing of the PR's reviews, one request to post the review; for a ready verdict one request
  for the PR, and one more to mark a draft ready;
- `autoMerge`, per poll and per PR that is ready and whose merge has not settled: up to four
  requests (the PR, its reviews, commit statuses, check runs), fewer when an earlier one already
  decides; then one merge request. A PR that is merged or blocked costs nothing more. A blocked
  merge costs one listing of the PR's comments and one comment.

## Permissions

The review comment and the ready mark need what publication needs. `autoMerge` needs write
access to the repository; a fine-grained token also needs Pull requests (write), Contents
(write), Commit statuses (read) and Checks (read). When the worker runs as a GitHub App, the
App needs the Checks: read and Commit statuses: read permissions for auto-merge as well.
`updraft doctor` checks the prompt files, that a reviewer other than the author exists, and
that the account can merge with the configured method; it does not look at branch protection.

## Housekeeping

`updraft clean --older-than` prunes reviewer jobs with their runs, logs and recorded verdicts
like any other job. The PR's stage, its newest verdict and the record that a head was reviewed
are kept, so pruning never causes a second review of the same commit.
