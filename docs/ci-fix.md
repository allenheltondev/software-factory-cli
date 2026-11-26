# CI in the review loop

Off by default. With `repositories.<OWNER/REPO>.ciFix` set (together with `review`), GitHub's
checks on a pull request are part of the [review loop](review-loop.md), not only a merge gate.
A "ready to merge" verdict does not end the loop while the head's checks are pending or failing:

- **pending** checks are waited for. Nothing is held while waiting: no worker, no job, no agent.
  The polling worker looks again after each poll (at most once a minute per pull request); a
  `check_suite`, `check_run` or `status` webhook makes [`updraft run-event`](run-event.md) look
  at once;
- a **failure the change cannot have caused** (one leg of a matrix failed while the others
  passed, or the job failed only in files the pull request does not touch) is
  [re-run once](#one-re-run), and a pass carries on as if it had passed the first time;
- a **failure the code can cause** queues a revision of the same pull request with the failed
  checks' diagnostics, when `revise` is on. Its push is reviewed again and its checks are
  waited for again, until both are green or a limit is reached;
- **all checks passed** (or the repository has none): only now is a draft marked ready for
  review, and only now may [auto-merge](review-loop.md#auto-merge), if it is on, consider the
  head. With auto-merge off, that is the end: the pull request is ready for a person to merge.

```yaml
repositories:
  octo/widgets:
    publish: draft-pr
    review: true
    revise: true
    ciFix: true
    # ciFix:
    #   checks: [test, lint]       # only these decide (default: autoMergeRequiredChecks, else all)
    #   ignore: [preview-deploy]   # never count, e.g. a deployment that is not about the code
    #   waitMinutes: 60            # per head, for pending checks and checks that never report
```

`ciFix` needs `review`: the checks are looked at for a head the reviewer found ready (a
"changes requested" head gets a revision anyway, and its push gets new checks). Without
`revise`, a failure is reported on the pull request and left for a person. `updraft validate`
warns about both.

## What decides

Only the pull request's **current head** is ever judged, by its commit SHA. The pull request is
read on GitHub first: if its head moved on, nothing is decided about the old one, and the new
head gets its own review. Check runs and commit statuses are read together, every page; GitHub
lists the newest check run per name, so a rerun replaces the run it reran.

| What GitHub reports | What Updraft does |
| --- | --- |
| A check run queued or in progress, a status `pending` | Waits, up to `waitMinutes`, then stops for a person |
| A decisive check (`checks`) that has not reported | Waits, up to `waitMinutes`, then stops for a person |
| No checks at all, five minutes after the push (or `waitMinutes`, if shorter) | Passes: the repository has no CI |
| `success`, `skipped`, `neutral` | Passes (skipped and neutral are not failures) |
| Check run `failure` or `timed_out`; status `failure` | Once per head, a [re-run](#one-re-run) if it cannot be the change's; otherwise (or if the re-run fails too) a revision to fix it |
| Check run `cancelled`, `startup_failure`, `stale`; status `error` | Stops for a person: the run did not get to judge the code. Re-run it on GitHub |
| Check run `action_required` (an approval, a manual gate) | Stops for a person |
| Checks that cannot all be read | Waits, then stops for a person; never read as passing |

All failures of one head go into one revision: while some checks are still running, the step
waits for them before it queues the fix.

Checks named in `ignore` never count, failing or not. With `checks`, only those decide; every
other check is left out, so an unrelated deployment cannot fail the loop.

## One re-run

A failure in code the change never touches, on one leg of a matrix whose other legs pass, is
almost always flaky. So before anything else, once per head, the CI step re-runs the failed jobs
(`POST .../actions/runs/{run}/rerun-failed-jobs`) when every failed check of the head:

- is a job of a GitHub Actions workflow run (its link names the run);
- had its log or annotations read, and names no file of the pull request's diff (as a path, the
  end of the runner's absolute path, or a bare file name); and
- either passed on another leg of the same matrix job on that head (the same workflow run, and a
  name that differs only in its OS or version values: `windows-latest / node 22` against
  `windows-latest / node 24`; shards like `test (2/4)` are not legs), or names a test file, with
  every file it names outside the diff.

When the diff cannot be read in full, or anything of the failure cannot be read, nothing is
re-run. A failure inside the diff never is: it goes to the CI fix.

The re-run is recorded on the pull request's row before it is asked for, so a head is re-run at
most once, whatever happens next (a GitHub refusal, a crash, another machine). The record is on
the timeline: `updraft status` and the stage detail say `Updraft re-ran the failed jobs once (it
looks unrelated to the change: …)`, `updraft run-event`'s summary has `loop.ciRerun` (head, time,
checks), and with quiet notifications the status comment shows `Re-running a failed check`.
The head waits for its checks again, for a full `waitMinutes`.

- **The re-run passes:** the step carries on exactly as for a first-time pass (the draft is
  marked ready, auto-merge may merge it). Nothing is posted on the pull request.
- **It fails again**, or a re-run could not be asked for (GitHub refused it: the token needs
  **Actions: Read and write**): the failure goes the usual way, a revision when `revise` is on.
  When the step has to stop, its reason says the check failed twice, in which files the pull
  request does not touch, and that it looks unrelated: re-run it or fix it on the base branch.

## Picking the merge up again

A head the CI step stopped for a person is not given up on while the checks may still pass on
it: its checks are read again on every check event about the pull request (and by the polling
worker every five minutes). When they pass now, after a re-run by Updraft or by a person, the
step carries on as a pass, with no new commit: the draft is marked ready and auto-merge merges
it. Nothing else changes a stopped head, and the comment that said it stopped is not posted
again. Quietly, the status comment moves on in place: `Checks passed`, then `Merged`.

Without `ciFix`, auto-merge does the same for a merge it blocked on the head's checks (a check
failed, could not be read, or did not pass in time): the gates are evaluated again on a check
event for that pull request (`updraft run-event` takes one for it even without `ciFix`) and every
five minutes, and the merge goes ahead when they all hold. Its blocked note for that commit stays
the only one.

## Stop wording

While a required check fails, Updraft never says the pull request is "ready to merge" or asks a
person to merge it: the comment and the status say **Blocked by a failing check**, name the
check, and say why Updraft stopped and what lifts the block (fix it, push, or re-run it; Updraft
merges once the checks pass on the commit). "Ready for a person to merge" is said only when a
person really is the last step, for example with auto-merge off after the checks passed.

## The revision

A CI fix is an ordinary [revision](revisions.md) of the pull request, of the new kind
`ci_failure`:

- **one per pull request and head commit.** Its dedupe key is the PR number and the head SHA,
  so repeated webhook deliveries, reruns that fail again, several failing checks and a worker
  that asks again after a restart all come to the same revision job;
- **one revision at a time per pull request.** If a revision is already queued or running (a
  person's change request, say), the CI step waits for it: its push gets new checks;
- **stale is dropped.** If the pull request's head is another commit when the revision would
  start, the job is canceled before an agent runs, as for a reviewer's verdict;
- **the same pool, agents and way of running them** as the job that opened the pull request,
  including a Claude subscription worker; nothing switches to API keys;
- **counted against `maxRevisions`**, with every other revision of the pull request.

The agent gets the action's `revisePrompt`, then the diagnostics, then the issue:

- each failed check's name, conclusion and link, its output title and summary;
- its annotations (file, line, level, message; up to 20);
- for a GitHub Actions job, an excerpt of its log: the lines around the first error and the
  end of the log, without timestamps, at most 6,000 characters;
- what could not be read (an expired log, a missing permission), in Updraft's words;
- the checks that failed for reasons a code change cannot fix, so the agent leaves them alone.

Annotations and logs are written by the code under test and the tools it ran, so they are
**untrusted input**: they are redacted (tokens, keys and bearer credentials are removed),
capped and fenced like a review. The prompt tells the agent to fix the cause, not to disable,
skip or weaken tests or checks, and not to change the CI configuration to get a green result.
Updraft never skips or bypasses a check, re-runs one only as [above](#one-re-run) (at most
once per head), and does not touch branch protection.

## Limits and stopping

The loop stops for a person, with the reason in `updraft status` and in one comment on the
pull request, when:

- `maxRevisions` is used up;
- **no progress:** the same checks failed in the same way (the same check names, conclusions,
  annotation messages and error region of the job log, with timestamps and numbers taken out, and
  the runner's generic "Process completed with exit code N." ignored) as before the last CI fix.
  A failure whose content was not read (a commit status, a check whose log could not be read) is
  never taken for the same failure; `maxRevisions` bounds those;
- a failure is not one code can fix (see the table above), or the checks never finish;
- `revise` is off;
- the revision ran and pushed nothing (the agent found no cause in the code, say), or failed;
  `updraft retry JOB_ID` tries it again.

Each of these is final for that head, except that a pass on the same head (a person re-ran the
checks) [picks it up again](#picking-the-merge-up-again). A new commit on the branch gets a new
review and new checks.

## Where it shows

`updraft status` has two more stages under "Pull requests (review loop)":

| Stage | Meaning |
| --- | --- |
| waiting for CI | The current head was found ready; its checks are pending, not registered yet, or not looked at yet |
| fixing failed checks | Checks failed on the current head; the revision for them is queued or running |

and "needs a human" says why when the CI step stopped. Revision jobs for checks read
`(revision of PR #n, to fix failed checks)`, and their change requests `(failed checks)`. The
same stages are in `updraft run-event`'s summary and in Updraft Cloud's job view.

With `notifications: quiet` (the default, [assignment-comments.md](assignment-comments.md)), the
CI step posts no comment while it fixes a head, nor when the fixed head passes and auto-merge
takes it: the issue's status comment shows `Fixing checks` (`Fixing failed checks on abc1234 of
PR #12 (CI fix 1)`), `Checks passed` and then `Merged after CI fix N`. A separate comment on the
pull request appears only when the step stops and needs a person: the revision budget is used up,
the failure isn't one the code can fix, CI repair is off, or the fixed head passed and merging is
up to a person. It names the reason and the next step in one or two sentences, lists the failed
checks, and links the console when hosted; the status comment says `Waiting for a person`. The
CI fix's own revision posts no reply on the pull request either (no claim, no "Coding agent ·
pushed" comment); replies in human review threads stay.

One CI-fix revision per failed head still holds across machines (`updraft run-event` on a shared
state database, where two runs can fix the same head at once). Three fences, none visible:
- the CI step queues one revision per (pull request, head) in the state it reads;
- a revision is dropped before its agent starts when the pull request moved on from the head
  it fixes (a fix that landed moves it);
- two runs already under way race on the push itself: each first pushes a claim ref of its own,
  `refs/updraft/revision-claims/<review>/<run>`, at the commit it pushes, and the branch push is
  a fast-forward under a lease. The run that loses the lease finds the winner's claim at the new
  head and gives way silently, exactly as a comment claim does in verbose mode, and deletes its
  own claim. GitHub shows no branch or tag for these refs. The winner's claim stays until the
  pull request is merged or closed, when the review loop deletes the pull request's claims (best
  effort). A remote that refuses refs outside branches and tags (a ruleset, a pre-receive hook)
  costs only the claim: the fix is pushed all the same, and a race lost without claims reads as
  the branch moving.

With `notifications: verbose`, on the pull request, one comment per head, headed **Updraft · CI** and the commit, says that a
fix was queued (which checks failed, each linked to its run on GitHub even when its log could
not be read, and how many automatic fixes there were) or why a person has to act. The
revision's own reply follows its push: the **Coding agent** names the commit the checks failed
on and links the commit it pushed, as its account, not a verification. Its push is reviewed
again, and once the review agent finds the new head ready and its checks pass, one more
**Updraft · CI** comment for that head says so, and that the pull request is ready for a person
to merge (or that Updraft merges it, with auto-merge on). A head whose checks passed without
any CI fix of the pull request gets no comment: the review already said what happens next.
Neither does a pull request whose fix was queued by an earlier version of Updraft (its CI
comment has no **Updraft · CI** heading): the outcome is recorded as said, with no late comment.
A failed check's link, in the comment and in the coding agent's reply, is shown only when it is
a plain https link: a commit status's target is set by whatever wrote the status.

## State and recovery

What the CI step knows is on the pull request's row of the state database (`revision_prs`):
the head it is about, its state (`waiting`, `passed`, `fixing`, `blocked`), the reason, the
revision it queued and the failure that revision was for. Nothing is kept in memory, so a
restarted worker, or a later `run-event` for any event on the pull request, reads the checks
again and goes on where the last one stopped. A crash between queuing the revision and
recording it finds the same revision again by its dedupe key.

## Webhooks and permissions

- **`updraft start`** polls and needs no webhook.
- **`updraft run-event`** handles `check_suite.completed`, `check_run.completed` and `status`
  deliveries ([run-event.md](run-event.md#events)). Every event about a watched pull request
  also reconciles its checks, so a missed delivery is caught up by the next one.
- **The self-hosted microVM stack** starts a microVM for `check_suite.completed` when
  `AcceptedEvents` includes `check_suite`.
- **Updraft Cloud** starts a job for `check_suite.completed` on an Updraft pull request of a
  repository with `ciFix` on (published config), whoever pushed the commit. In the console it
  is **Fix failing CI on pull requests the reviewer finds ready**, in a repository's settings
  (simple and full editor). A repository added to a reviewing workflow starts with it on; one
  configured before keeps its setting, so it stays off until it is ticked and published.
  When the account's execution slot is taken, the check suite's event waits in the admission
  queue and starts on its own once a slot frees; if the pull request's head has moved on by
  then, the queued event is dropped (`stale_head`) and the newer head's events continue the
  loop ([cloud/README.md](../cloud/README.md#admission-queue)).

A GitHub App needs **Checks: Read-only** and **Commit statuses: Read-only**, and **Actions:
Read-only** for job logs (without it the revision gets the annotations only, and the
diagnostics say why); **Actions: Read and write** for the [one re-run](#one-re-run) (without it
GitHub refuses the re-run, and the failure goes the usual way), and must be subscribed to **Check suite** (and **Check run** and
**Status** for `run-event`) events. `updraft doctor` checks the permissions of a configured
App. A fine-grained token needs the same three permissions.

## Not covered (yet)

- A commit status event is matched to a pull request by its commit, which needs the state
  database; the Cloud and microVM launchers take `check_suite` only, so external CI that
  reports statuses alone is picked up there by the next event on the pull request.
- An Updraft Cloud CI fix's token asks for Actions: read only where the installation grants
  it; an installation that has not accepted that permission gets annotations and summaries,
  without job logs. Other Cloud jobs never get Actions: read.
- A head whose checks pass after its fix was queued (a flaky test re-run by a person) still
  runs that revision; one that finds nothing to change pushes nothing and says so.
