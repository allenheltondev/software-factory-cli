# The review loop

Off by default. With `repositories.<OWNER/REPO>.review: true`, every head commit of a pull
request Updraft opened is reviewed by a second agent. If the reviewer asks for changes and
[`revise`](revisions.md) is on, the coding agent revises the PR and the new head is reviewed
again, for up to `maxRevisions` rounds. When the reviewer finds a head ready, a draft PR is
marked ready for review and the loop stops: a person merges. With `autoMerge` set as well,
Updraft merges it itself once the checks listed [below](#auto-merge) hold. The reviewer's
non-blocking suggestions on a ready head are not left as open threads: one revision applies
those the coding agent agrees with, and the rest go into one follow-up issue (see
[Suggestions](#suggestions)).

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
| revising | The coding agent is running on the PR branch, or its commits are being pushed; also the one [suggestion revision](#suggestions) of a ready head, queued or running | awaiting review (new head), or needs a human; a suggestion revision that changes nothing goes back to ready to merge |
| waiting for CI | `ciFix`: the reviewer found the current head ready; its checks are pending or not looked at yet ([CI in the review loop](ci-fix.md)) | ready to merge, fixing failed checks, or needs a human |
| fixing failed checks | `ciFix`: checks failed on the current head; a revision with their diagnostics is queued or running | awaiting review (new head), or needs a human |
| ready to merge | The reviewer found the current head ready (and, with `ciFix`, its checks passed); a draft was marked ready for review. The end state unless `autoMerge` is on. If Updraft tried to merge and could not, the reason is shown here. While its [suggestions](#suggestions) are being answered, the line says so | merged by a person, or merging |
| merging / waiting for checks | `autoMerge`: waiting for pending checks, or the merge was requested | merged, or ready to merge with the reason it was not merged |
| merged | Updraft merged it | none |
| needs a human | The loop cannot continue by itself; the line says why: `maxRevisions` reached, the reviewer run failed or gave no readable verdict, a revision failed or pushed nothing, `revise` is off, or mandatory [acceptance criteria](acceptance.md) are unverified or unclear | `updraft retry JOB_ID`, a push, a new review, or a merge by hand |
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
  longer text an allowed actor stands behind, the review still runs but the body is withheld;
- the issue's **acceptance criteria**, with the coding agent's report on each as a claim, to
  assess one by one on the commit under review: see [Acceptance criteria](acceptance.md).

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

### The findings count

Before the verdict line, the prompt also asks for one line with the number of findings
(blockers and suggestions together):

```
UPDRAFT-FINDINGS: 3
UPDRAFT-VERDICT: changes-requested
```

The count is telemetry for [`updraft stats`](stats.md) and nothing else. It is read from the
findings after the verdict has been decided, and never changes or fails a verdict: the rules
above are applied exactly as if the line were not there. Exactly one such line with a whole
number from 0 to 999999 gives the count. A missing line, two of them, or any other value gives
no count, and one line in `run.log` says why (`review findings count: none (...)`); a count is
logged as `review findings count: N`, which agent telemetry reads. The line
must still come before the verdict line: written after it, it is text after the verdict and the
run fails as it always would. The count line is left out of the findings Updraft stores, posts
on the PR and gives to later reviews and revisions. It is stored with the verdict
(`pr_reviews.findings_count`) and in the stats rollup. A person's "Request changes" review has
no count; it counts as a round only.

With [acceptance criteria](acceptance.md) enforced (the default), a ready-to-merge is also
held to them: a mandatory criterion not met is taken as changes requested and revised, and one
that is unverified or unclear holds the head back for a person (outcome `needs-verification`).

A verdict is bound to the commit that was reviewed. If the PR's head is a different commit
when the verdict is recorded, or when the revision it queued would start, or when a merge is
considered, the verdict is stale and nothing follows from it.

## The review on the pull request

One comment review per reviewer run, attached to the reviewed commit, with the verdict, the
reviewed commit, the reviewing agent and the findings. The findings are an agent's text about
untrusted code, so they are rendered as sanitized Markdown (headings, lists and code display
normally in a blockquote): mentions, closing keywords and HTML comments in them do nothing.
See [Publication](publication.md). A hidden marker with the run id lets a retry find the review instead of posting a
second one (only among the worker's own reviews). Posting uses the same lease, retries and
`updraft publish RUN_ID` as publication.

The verdict is acted on once its review is on the PR, so nothing happens on a PR that people
cannot see explained there.

## Findings as threads

A reviewer may list its findings in a structured block as well as in prose. The default
prompt asks for one. When it does, each finding becomes something people can follow on the pull
request, and the coding agent and the next reviewer answer it where it was raised.

Three roles speak on the pull request, all as the worker's one GitHub account (Updraft never
pretends to be another user). Each says which role it is: the **Review agent**, the **Coding
agent**, and **Updraft** itself. This holds even when the same agent or profile plays both
review and coding.

### The contract

Before its findings count and verdict lines, the reviewer writes one fenced block tagged
`updraft-findings`:

````text
```updraft-findings
{"findings": [{"id": "F1", "severity": "blocker", "title": "Retired worker is not fenced",
               "path": "src/pool.ts", "line": 42, "startLine": 40, "side": "RIGHT",
               "problem": "What is wrong and how it fails.", "suggestion": "What would fix it.",
               "sameAs": "run_abc#F2"}],
 "checks": [{"finding": "run_abc#F1", "status": "verified", "note": "What was checked."}]}
```
````

- **Required fields:** a finding needs a `title` or a `problem`. Everything else is optional.
- **Severity:** `severity` is `blocker` or `suggestion`. Anything else counts as a blocker, so a typo can't make a finding optional.
- **Keys:** a finding's key is `<run id>#<id>`, and that key names it for the rest of the pull request. An `id` that is missing or used twice is replaced by `F<n>`.
- **Location:** `path` is relative to the repository. `line` (and `startLine` for a range) is on `side`: RIGHT, the head's numbering (the default), or LEFT, a removed line. A path or line that can't be used is dropped with the reason. The finding itself is always kept.
- **Repeats:** `sameAs` names an earlier finding of this pull request that is still not fixed. The new finding joins that finding's thread.
- **Checks:** `checks` re-check earlier findings against the commit under review. `verified` or `unresolved`; anything else counts as unresolved.
- **Limits:** a block holds at most 50 findings and 50 checks. Each text field is capped, and control characters are removed.
- **Verdict:** the verdict line decides, as before, but a structured review's verdict must agree with its findings. A `ready-to-merge` is never acted on as ready when the review lists a blocker, or when any earlier blocker thread of the pull request is not verified by it. That means every recorded blocker, not only the ones the reviewer was shown, and also a blocker verified in an earlier round that this review finds broken again. Its state and the verdict are recorded in one transaction, checked once more against every blocker as it then stands, so a ready verdict is never on record while a blocker is open. It is recorded and acted on as changes requested, and the review says why. A legacy review on a pull request with no earlier blockers is not checked.
- **One answer per thread:** a review says one thing about each earlier thread, whichever of its keys it names. A thread counts as verified only when every check of it says `verified` and no finding of the review repeats it. Anything else is unresolved. When several findings repeat one thread, the strongest (a blocker over a suggestion) speaks for it, and the others' text is kept with it. A repeat never lowers a thread's severity: a blocker that is repeated is still a blocker, whatever the repeat calls it.
- **What the reviewer is shown:** at most 50 earlier findings, blockers first. When there are more, the prompt says so: a pull request with more unverified blockers than one review can check needs further rounds, or a person.
- **Fallback:** a review with no block, two blocks or a block that isn't valid JSON is posted as a legacy review: its whole text, as before. Run.log says why.

### On the pull request

- **One review:** each reviewer run posts one COMMENT review, pinned to the reviewed commit. The body is short. It opens with `Review agent · Round N · reviewed <sha>`, then the verdict in plain words, the reviewer's prose, one line per finding, the re-checks of earlier findings, and what happens next.
- **Inline threads:** a finding whose line is in the pull request's diff, as GitHub shows it for the reviewed head, is posted with the review as an inline comment on that line. Its full text is in the thread and not repeated in the summary. Updraft never invents a line: a range must be within one hunk, and the file must have a diff.
- **The rest:** findings on lines outside the diff, files the change didn't touch, findings with no file, findings beyond 25 inline comments, and every finding when the pull request has moved past the reviewed commit go in the summary in full, with the reason.
- **Refused inline comments:** GitHub refuses the whole review when it can't place one comment. Updraft then posts the review again with every finding in the summary. Nothing is dropped.
- **Current head only:** repeats and checks change earlier findings only for a review of the pull request's current head, looked at on GitHub just before. They change them in one transaction, before the verdict queues a revision or marks the pull request ready. A review whose head has moved on is posted as history and changes nothing. A check or repeat from an older review never overwrites the state a newer review recorded. A thread is resolved only if it is still verified for that head and GitHub, read right before, still shows that head.
- **Repeats:** a repeat of a finding that has a thread gets a reply in that thread ("this is still not fixed", with the current text), not a new thread. The summary carries the repeat's full text too. A repeat of a finding that was only in a summary, posted inline now, becomes that finding's thread. Either way, the thread takes on the repeat's current severity and text, so a suggestion that now blocks is a blocker for the next round.
- **Checks:** each check of an earlier finding is answered in that finding's thread. A thread is resolved only when the check `verified` it and the thread is one the worker started: its first comment was posted by the worker's own login, with the review recorded for that run. A person's thread is never resolved. A thread of the worker's that a later review finds unresolved again (a check or a repeat) is reopened on GitHub if it was resolved, while the pull request is still at that head; a person's thread is never reopened. The resolution is recorded only once GitHub confirms it, and the reply never says "resolved" on its own. A check that names no finding of this pull request is ignored, and the summary says so.

### The revision

The revision of a structured review gets each finding by key, as its thread stands after the review: a repeat by the thread it repeats, with the strongest severity and all its text, and each earlier thread a check found unresolved. For each it gets its severity, file, line, title,
problem and suggestion, fenced as untrusted input like any review. The revision is asked to end
its final message with a report on each one, in a block tagged `updraft-resolutions`:

````text
```updraft-resolutions
[{"finding": "run_abc#F1", "status": "fixed", "note": "Retire compares generations.", "tests": "npm test: 214 passed"}]
```
````

`status` is `fixed`, `disagreed`, `deferred` or `unable`. Only keys the revision was given are
read. A finding the agent doesn't report on is answered as having no report.

- **After the push:** only once the push is confirmed does the worker reply in each finding's thread as the **Coding agent**. The reply names the commit and its link, the agent's note and its tests, and says that it is the coding agent's account, not a verification.
- **No push:** a revision that pushed nothing (no commits, a branch that moved) says nothing in the threads.
- **The reply comment:** the revision's PR comment lists every finding with its status. A finding whose thread couldn't be replied to, or that has no thread, gets its whole answer there.
- **The record:** the report is recorded as the coding agent's claim.
- **The next review:** the next reviewer is given every finding no reviewer has verified yet, with that claim marked as a claim. It checks each one on the new head, by key.

### What decides

- **The worker's records:** what the worker recorded decides, never the posted text. That record is the finding, its thread (the comment the worker itself posted), the coding agent's report and the reviewer's check, kept in `review_findings` in the state database and merged across Cloud jobs (see [shared state](shared-state.md)).
- **Markers:** every reply carries a marker for its kind, run and thread, so a retry or a lost response never posts it twice. A marker copied into someone else's comment is ignored.
- **The fence:** every thread write and every change of a finding's state is made under the step's lease and attempt fence, checked right before it, with the same stop and deadline. An attempt that lost its lease, or is stopping, writes nothing more.
- **Failures:** a thread write GitHub refuses for good (a permission, a thread that is gone) is said in run.log; the summary has the finding, and the step goes on. A failure worth retrying (a rate limit, a 5xx, the network) fails the attempt, which is retried like any. The review is not posted twice, and no reply is either.
- **Many threads:** the threads of a pull request are read page by page. One with more than 2000 threads is reported as not fully read, and its findings are verified, not resolved.
- **Without thread support:** a GitHub client without thread support posts the summary only.

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
  at that commit, marks a draft ready for review, and stops. With `ciFix`, it waits for the
  head's checks first, and a failure gets a revision: see [CI in the review loop](ci-fix.md).

## Suggestions

A ready-to-merge verdict may come with suggestions: findings of severity `suggestion` in the
reviewer's [structured block](#findings-as-threads). They never hold a head back, and they are not
left as open threads either. What happens to them is `review.suggestions`:

```yaml
repositories:
  octo/widgets:
    review:
      suggestions: address   # the default; or follow-up, or ignore
```

- **`address`** (the default): when the reviewer finds the current head ready and suggestions are
  open, Updraft queues **one** revision of the pull request for them, if the pull request has
  revisions left (`maxRevisions`; this revision counts like any other, and it can take the last
  one: a pull request that then gets changes requested on the new head has no revision left for
  them, and stops for a person as at any limit). It is given at most 25 suggestions; any more are
  deferred to the follow-up issue. The coding agent applies
  the suggestions it agrees with. It reports each one in its `updraft-resolutions` block:
  `disagreed` with a one-line reason for a suggestion it judges wrong, `deferred` with a reason for
  one that is right but too large or out of scope. Its push is reviewed again as usual, and only
  that new head goes on to its checks and its merge. A pull request gets at most one suggestion
  revision, whatever happens later.
- **`follow-up`**: no revision. Every open suggestion goes into the follow-up issue, and the ready
  head goes on to its checks and its merge.
- **`ignore`**: the behaviour before this setting: suggestion threads are left open.

Without `revise`, `address` works as `follow-up` (a validation warning says so).

### How each suggestion ends

Once a ready head has nothing more coming for its suggestions (no revision is queued, or the one
that was queued has ended), every open suggestion is settled on that head, before its checks are
read and before a merge:

| The suggestion | Its thread |
| --- | --- |
| verified by a reviewer, or reported `fixed` by the coding agent in a push no reviewer found unfixed since | The coding agent's reply names the commit (`Fixed in <sha>`). Resolved |
| reported `disagreed` | The coding agent's reply gives its reason. Resolved |
| anything else: deferred, unable, no report, the budget spent, `follow-up` | One reply links the follow-up issue. Resolved |

The follow-up issue is normally one per pull request. Its body lists every suggestion deferred
to it as a task list (`- [ ]` items under *Acceptance criteria*), each with its file, line and a
link to its thread, and the coding agent's reason where it gave one. Adding the workflow's label to
the issue dispatches it like any other. Every open suggestion is settled, however many: past the
50 a reviewer is shown, or the 25 a revision is given, they are deferred like the rest (at most 500
per head; the body names any that do not fit GitHub's limit by count, and their threads link it).

A later head with more suggestions, or a retry, adds them to the same issue, which is found by the
number the state database recorded, else by a hidden marker
(`<!-- updraft-suggestions-followup: <repo id>#<pr> -->`) among the issues the worker opened (read
page by page, up to 1,000). An issue counts only if the worker itself opened it (its author is
checked, so a person's issue with the marker is never adopted), it is still open, and it does not
carry one of the repository's trigger labels. Once someone labels it, its run is dispatched, and
an edit by the worker would read as an edit of the issue and stop that run. So a closed, deleted,
transferred or labelled follow-up issue is never edited: the newly deferred suggestions go into a
new follow-up issue, which lists only them.

Only threads the worker started are replied to or resolved. A person's thread on the pull request
is never touched.

### What it never does

- **Block a merge for good.** A suggestion revision that pushes nothing, fails or is canceled
  releases the ready head: its suggestions are settled as above (a decline still gets its reason)
  and the head goes on to its checks and merge. That is at most one revision attempt later than
  without suggestions. A head whose suggestions cannot be settled because GitHub keeps failing is
  let through after five attempts.
- **Change a verdict.** Suggestions are not blockers; the acceptance gate ([acceptance.md](acceptance.md))
  and the CI gate ([ci-fix.md](ci-fix.md)) are unchanged. Auto-merge waits for the suggestion
  revision's own head to be reviewed and pass its checks; it never merges the head the revision
  was for while that revision is on its way.
- **Run twice.** The revision's dedupe key is the pull request (`suggestions:<pr>`): a redelivered
  review, a retry or a stale head never queues a second one. A revision queued for a head that a
  person's push replaced is canceled before it starts, as for any verdict; the new head is
  reviewed, and its suggestions go to the follow-up issue. Two machines that both run it (Updraft
  Cloud, `updraft run-event` on a shared state database) race on the push exactly as two CI fixes
  do: each claims its push with a hidden ref, `refs/updraft/revision-claims/suggestions-<pr>/<run>`,
  and the one that loses the branch's lease gives way silently ([ci-fix.md](ci-fix.md)).
- **Post a status comment.** With `notifications: quiet` (the default) the issue's status comment
  shows `Addressing suggestions` while the revision is on its way, then the usual stages; the
  revision posts no claim, no reply and no "pushed nothing" comment on the pull request. Thread
  replies and the follow-up issue are its only GitHub writes. With `verbose`, the revision's
  reply comment is posted as for every revision.

In the Cloud console it is **Review suggestions** in a repository's settings (simple and full
editor), shown when the repository's workflows review. Address is the default and is stored as
nothing.

## Auto-merge

Off unless `repositories.<OWNER/REPO>.autoMerge` is set to `squash`, `merge` or `rebase`.

**This is the most dangerous thing Updraft can do.** The issue text and the code under review
are untrusted input. An issue, a code comment, a test name or a file in the repository can
contain text written to talk the reviewing agent into approving, and an agent can be wrong
without being attacked. With auto-merge on, a wrong "ready to merge" becomes a commit on your
base branch with nobody having looked at it. Leave it off unless every actor in
`allowedActors` is someone you would let push to the base branch directly, and protect the
branch on GitHub with required checks you trust.

With [`ciFix`](ci-fix.md) on, a head is only considered once the CI step found its checks
passed; a failure there is fixed rather than refused. The gates below still apply on top.

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
the PR says so, and the PR stays at "ready to merge" for a person. The exception is a block on
the commit's checks (a check failed, could not be read, or did not pass in time): it is not
"ready to merge" (the comment and the status say **Blocked by a failing check** and name it), and
when the checks pass on that same commit after a re-run, every gate is evaluated again and the
merge goes ahead, with no second comment ([ci-fix.md](ci-fix.md#picking-the-merge-up-again)).
Updraft never forces a merge, never bypasses protection, never retries a refused merge and never
deletes a branch.
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
  for the PR, and one more to mark a draft ready. With structured findings, also one request
  for the PR and one listing of its files before posting, one listing of its review comments
  after, one reply per repeated or re-checked finding with a thread, and, when a check verified
  a thread, one GraphQL listing of the threads and one GraphQL request per thread resolved;
- per revision of structured findings, after its push: one listing of the PR's review comments
  and one reply per finding with a thread;
- suggestions, per ready head with open suggestions: nothing to queue the revision; to settle
  them, one request for the PR, one read of the recorded follow-up issue (or, without one, up to ten pages of the worker's issues), one
  request to open or edit the follow-up issue when one is owed, one listing of the PR's review
  comments and of its threads, and one reply and one GraphQL request per thread resolved. A head
  with no open suggestion costs nothing;
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
