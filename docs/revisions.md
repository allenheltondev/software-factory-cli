# Revisions

Off by default. With `repositories.<OWNER/REPO>.revise: true`, a reviewer who requests changes
on a pull request Updraft opened gets them without carrying the feedback back by hand: the
worker queues a revision job, runs the agent on the PR's branch with the review, verifies the
result, pushes the new commits to the PR and replies there. Merging, approving and resolving
stay with people.

Reviews by people are one of two things that can ask for a revision. With
`repositories.<repo>.review` on as well, Updraft's own reviewer run does too: see
[The review loop](review-loop.md). Everything on this page applies to both unless it says
otherwise.

```yaml
actions:
  implement-issue:
    prompt: ./prompts/implement-issue.md
    revisePrompt: ./prompts/revise-pr.md
    verify: ["npm test"]

repositories:
  octo/widgets:
    id: 42
    checkoutPath: ../clones/widgets
    publish: draft-pr
    revise: true
    # maxRevisions: 3
    workflows:
      - trigger: { event: issue.labeled, label: updraft:ready }
        action: implement-issue
        pool: general
```

`revise` applies only in `live` mode and only together with `publish` (revisions are made to
PRs the worker opened). Set otherwise, it is a validation warning and does nothing. Every
action used by a repository with `revise` on needs a `revisePrompt`; without one the config is
invalid. A starting point is
[examples/prompts/revise-pr.md](../examples/prompts/revise-pr.md).

## What triggers a revision

- **Which PRs.** Only pull requests the worker itself opened and recorded as published, while
  they are open. No other PR is ever read for reviews, and none is ever pushed to. A PR stays
  watched after `updraft clean --older-than` pruned the job that opened it. A PR that was
  closed or merged is no longer watched; reopening it does not resume revisions.
- **Updraft's own reviewer.** With `review` on, a "changes requested" verdict of a reviewer
  run queues a revision too. It is taken from the worker's own record when the verdict is
  recorded, not read from GitHub, and it is not subject to the allowlist (the `review` setting
  is what allows it). It is bound to the commit that was reviewed: if the PR's head is another
  commit by the time the revision would start, the job is canceled as stale. The rest of this
  list is about reviews by people.
- **Which reviews.** A submitted review with state "Request changes" (`CHANGES_REQUESTED`)
  whose author is an allowed actor for the workflow that produced the PR: the workflow's
  `allowedActors`, else `dispatch.allowedActors`, the same list that decides who may dispatch
  an issue. A review by anyone else is ignored. Plain comments, "Comment" reviews and
  approvals trigger nothing.
- **Once.** Each review is decided the first time it is seen and recorded by its id, so it is
  acted on once across restarts, replays and pruning. That includes the decision to ignore
  it: adding someone to the allowlist later does not revive a review they submitted before.

## What the agent is given

The action's `revisePrompt`, then the review, then the original issue, each fenced and
labelled as untrusted input like the issue in an ordinary run:

- the review's body and its own inline comments: file path, line, the diff hunk GitHub shows
  above the comment, and the comment text;
- only text written by allowed actors. Inline comments by anyone else are left out (the
  prompt says how many), and other people's comments and reviews on the PR are never read
  into it;
- the text **as it was when the worker first saw the review**. GitHub lets a review body and
  its comments be edited after submission, also by other people with write access. The worker
  copies the text into the job when it ingests the review and never reads it again, so a later
  edit cannot reach the agent. If, at that first sight, the newest edit of the body or of a
  comment was made by someone who is not an allowed actor (or cannot be identified), the whole
  review is refused and shown in `updraft status` as ignored. To change what you asked for,
  submit a new review;
- the issue as an issue job gets it. If the issue's text is no longer text an allowed actor
  stands behind (it was edited since the label, the label was removed, the issue was closed),
  the revision still runs, because the review is what it acts on, but the issue body is
  withheld from the agent and the run log says why.

Long reviews are capped: 50 inline comments, with limits on each text.

## Where the agent runs

In a new worktree and a new local branch, like any attempt, created from the PR branch's
**current remote head**, fetched just before the run. The original job's worktree is not
needed and may have been cleaned. If a person pushed commits to the PR, the agent builds on
top of them.

From there it is an ordinary live run: the same pool and agent rules as the job that opened
the PR, a container if the agent has one, the action's `verify` commands, timeouts,
`updraft logs`, `updraft cancel` and `updraft retry`.

Before it starts, the worker checks that the PR is still open, that the review still stands
(a dismissed review cancels the job, as does a later approval by the same reviewer), and that
the reviewer is still an allowed actor.

## The push

A succeeded revision run that left commits is pushed to the PR's branch by the worker, never
by the agent. This is the only case in which the worker moves a branch that already exists on
the remote, and the only move it can make is a fast-forward of exactly the commit the run
started from:

- the branch is the one recorded when the PR was published; it must be a job branch
  (`updraft/issue-<n>-<jobId>`) and is refused if it is the base or default branch;
- the worker checks that the run's commit descends from the commit the run started from, and
  pushes with a non-forcing refspec and `--force-with-lease=<branch>:<that commit>`, so the
  remote refuses the push unless the branch is still exactly there;
- if the branch moved in the meantime (someone pushed, or deleted it), nothing is pushed. The
  worker does not retry and does not rebase. It records the revision as not pushed and says
  so in one comment on the PR. The commits stay on the worker's machine; request changes
  again to get a revision that starts from the new head.

The destination checks, the throwaway repository, disabled hooks and the token handling are
the same as for [publication](publication.md), as are the lease around each write and the
retries of network failures (up to five attempts; `updraft publish RUN_ID` retries by hand).

## The reply

One comment on the PR per revision run, found again by a hidden marker so a retry never posts
a second one:

- after a push: the new commits, the diff stat, the verification results and the agent's
  final message, as sanitized Markdown so mentions and closing keywords in it stay inert;
- when the agent made no commits: a comment saying so, with its final message (also sanitized Markdown);
- when the push was refused: the reason, in the worker's own words (no agent output, no local
  paths).

If the revision run itself fails and `commentOnFailure` is on, the PR gets one short
[failure comment](failure-comments.md) with the same safety rules as on an issue.

## Limits

- `maxRevisions` (default 3, at most 20) is the number of revision jobs one PR gets, whoever
  asked for them: change requests by people and by Updraft's reviewer count together. A job
  canceled before it ran does not count; `updraft retry` of a failed revision does not use
  another. Once the limit is reached, further change requests are recorded and listed in
  `updraft status`, not acted on, and one comment on the PR says so. Raising the limit lets
  new reviews through; reviews already recorded as over the limit stay that way.
- One revision at a time per PR. A change request that arrives while a revision is running
  waits for it, and for its push, and then starts from the pushed result. A revision job also
  waits for any other job on the same issue.
- Closing or merging the PR cancels its queued revision jobs. A revision that is already
  running finishes, but pushes nothing to a closed PR.

## What it costs in API requests

Per poll cycle, per repository with `revise` on:

- nothing while no watched PR is open;
- otherwise one conditional request for the repository's most recently updated pull requests.
  When nothing changed GitHub answers `304`, which does not count against the rate limit;
- one GraphQL request for each watched PR that changed since its reviews were last read
  (a review, a comment or a push changes it, including the worker's own push and reply).

A queued revision job costs nothing while it waits. Starting one costs one GraphQL request
for the PR and the issue lookups of an ordinary job.

Errors are handled as for issue events: the repository backs off, and the position in the
listing is only stored after every changed PR was processed, so nothing is skipped.

## Status

With `review` on, the reviewer's findings take the place of the review in the prompt (fenced
the same way), the reply names the worker's own comment review, and each pushed revision is
followed by a new reviewer run.

`updraft status` marks revision jobs as `(revision of PR #n)`, lists each revision run with
the commit range it pushed (or why it pushed nothing) under "Revisions", and under "Change
requests" every review that was queued, was over the limit, or was ignored and why.
