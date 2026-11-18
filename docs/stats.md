# Stats

`updraft stats` tells you how the factory is doing: what it finished, how long things took,
what came of it, what review caught and how much back-and-forth it took.

```sh
updraft stats                        # the last 30 days, all repositories
updraft stats --since 12h            # h, d or w, as for "updraft clean --older-than"
updraft stats --since all --repo octo/widgets
updraft stats --json                 # the same, machine-readable
```

It is read-only and local. It opens the state database read-only (it never creates, migrates or
writes it), makes no network request and sends nothing anywhere. A database from before stats
existed (schema v12 or older) is refused with a hint: run `updraft status` once to upgrade it.

## Where the numbers come from

Every number except the current queue comes from `metric_events`, a table the worker appends
one row to for each fact, in the same transaction as the change the fact describes:

| Fact | Written when |
| --- | --- |
| `run.ended` | a run is closed (agent finished, failed, could not start, was interrupted, canceled, or released before start) |
| `job.finished` | a job reaches succeeded, failed, interrupted or canceled |
| `pr.opened` | a publication finishes with a PR |
| `pr.merged` | Updraft's auto-merge merges a PR |
| `pr.merge_blocked` | auto-merge gives up on a head (final for that head), with a reason code |
| `pr.limit_reached` | a PR's first change request is refused by `maxRevisions` |
| `review.verdict` | a reviewer run's verdict is first recorded, with its findings count |
| `change_request` | a change request on a watched PR is recorded (a person's, or Updraft's reviewer's) |
| `revision.pushed` | a revision's commits are pushed to its PR |

Each fact has an idempotency key (its kind and what it is about, such as the run id), so a
replay, retry or restart never counts anything twice. Rows hold ids, numbers, timestamps, agent
and pool names, and fixed codes; never issue text, review or findings text, logins, paths or
logs. `updraft clean --older-than` never deletes them, so pruning never lowers a number.

Upgrading to this version (schema v13) backfills the table from the rows the database still
holds; those facts are marked as backfilled, and the report says how many of the facts in the
window are.

A fact belongs to the window by when it happened (a run by when it ended, a PR by when it was
opened, and so on). "Now" counts (queued, running) are the jobs table as it is, not windowed.

## What each number means

**Work items done.** Jobs whose latest final status is in the window, by that status and by
kind: `implement` (an issue's label), `revision` (a change request on a PR), `review`
(Updraft's reviewer). A job that failed and was retried counts once, with its latest status. A
job that was retried and is queued or running again still counts with its last final status,
and in the "now" rows.

**Time taken.** *Agent run*: from the agent's start to the run's end, over runs whose agent
ran (succeeded, failed, interrupted, canceled), by kind and by agent. *Queue wait*: from the job
being queued to the start of its first run whose agent started; later attempts are not counted.
*Label to PR opened*: from the trigger label being applied (the label event's time on GitHub) to
the publication finishing. *PR opened to merged*: only PRs Updraft merged itself. Each shows
`n`, average, median and 90th percentile (linear interpolation between closest ranks). Where
some rows cannot be measured, `n` reads `4 of 5`: the average is over the 4, and the 5th is not
guessed at.

**Outcomes.** PRs opened and merged by Updraft. Heads blocked from auto-merge, the PRs they
belong to and the reason codes, most frequent first: `config`, `not-verified`, `base-changed`,
`draft`, `unmergeable`, `changes-requested`, `checks-failed`, `checks-unreadable`,
`wait-timeout`, `merge-refused`, `no-answer`, `github-error`, `other`. Runs by how they ended.
Failed runs by kind and agent, with how many failed their `verify` commands (the run's summary
records the verify result) and how many have no verify result: an agent failure or timeout
before verification, a reviewer run, or a run recorded before the verify result was.

**Caught in review.** Reviewer runs whose agent ran, split into ready-to-merge,
changes-requested, failed (no readable verdict, or the agent failed) and other (interrupted or
canceled). Verdicts by reviewing agent. Change-request rounds, shown apart: changes-requested
verdicts of Updraft's reviewer, and people's "Request changes" reviews by allowed actors that
were acted on or refused by `maxRevisions`; for each, how many queued a revision. Findings:
the total of the reviewer's [`UPDRAFT-FINDINGS`](review-loop.md#the-findings-count) counts over
changes-requested verdicts, their average over the verdicts that have a count, and how many have
none (the line was missing or malformed, or the review predates it). People's reviews have no
count. First-pass ready: of the PRs whose first review is in the window, how many got
ready-to-merge on the first head reviewed.

**Back-and-forths.** For the PRs opened in the window, over their whole history: revisions
pushed per PR (average, maximum, and how many PRs had 0, 1, 2 or 3 or more) and reviews per PR,
plus how many PRs reached `maxRevisions` in the window.

The text output shows all of this for the window, then one line per repository. `--repo`
narrows everything, including the queue, to one repository (any case; a renamed repository is
matched by any name it was recorded under). `--json` has the full breakdown for each repository.

## What it does not measure

- **History that was pruned before the upgrade.** The backfill can only read rows that are still
  there. After the upgrade nothing is lost to pruning.
- **A retried job's earlier final statuses from before the upgrade**: the jobs table only holds
  the latest one.
- **PRs merged or closed by people.** Updraft records only its own merges, so "PR opened to
  merged" is about auto-merge. A PR closed without a merge is not a fact.
- **Timeouts apart from other failures.** Both end a run `failed`; the difference is only in
  the error text, which is not kept.
- **Backfilled approximations.** A PR still watched whose publication was pruned is counted as
  opened when Updraft started watching it, with no lead time. A merge block from before the
  upgrade is dated by the PR's last change and its reason code is read from the recorded
  reason's wording.

## JSON

`--json` prints one object. `version` changes only when a field is removed or changes meaning;
new fields may be added. Durations are in milliseconds; a measure with no rows is `null`.

```jsonc
{
  "version": 1,
  "generatedAt": "2026-11-18T12:00:00.000Z",
  "window": { "label": "30d", "since": "2026-10-19T12:00:00.000Z", "until": "2026-11-18T12:00:00.000Z" }, // since: null for "all"
  "repo": null,                          // the --repo filter, as recorded
  "database": true,                      // false: no state database yet; everything is zero
  "facts": { "total": 38, "backfilled": 0 },
  "overall": Section,
  "byRepo": [{ "repo": "octo/widgets", "repoId": 42, "stats": Section }]
}

// Section
{
  "work": {
    "finished": { "succeeded": Kinds, "failed": Kinds, "interrupted": Kinds, "canceled": Kinds, "total": Kinds },
    "current": { "queued": Kinds, "running": Kinds }
  },
  "time": {
    "agentRun": { "all": Covered, "byKind": { "implement": Covered, "revision": Covered, "review": Covered }, "byAgent": { "<agent>": Covered } },
    "queueWait": { "all": Dist, "byKind": { "implement": Dist, ... }, "byAgent": { "<agent>": Dist } },
    "labelToPr": Covered,
    "prToMerge": Covered
  },
  "outcomes": {
    "prsOpened": 3, "prsMerged": 1,
    "mergeBlocked": { "heads": 1, "prs": 1, "reasons": [{ "code": "checks-failed", "count": 1 }] },
    "runs": { "succeeded": 9, "failed": 2, "interrupted": 0, "start_failed": 0, "canceled": 0, "not-started": 0, "total": 11 },
    "failedRuns": { "total": 2, "byKind": { "implement": 2, "revision": 0, "review": 0, "unknown": 0 }, "byAgent": { "claude": 2 }, "verifyFailed": 1, "verifyUnknown": 1 }
  },
  "review": {
    "reviewerRuns": { "total": 4, "readyToMerge": 2, "changesRequested": 2, "failed": 0, "other": 0 },
    "verdictsByAgent": { "codex": { "readyToMerge": 2, "changesRequested": 2 } },
    "changesRequestedRounds": { "reviewer": 2, "people": 2, "reviewerQueued": 1, "peopleQueued": 1 },
    "findings": { "changesRequestedReviews": 2, "withCount": 1, "withoutCount": 1, "total": 3, "average": 3, "allReviewsWithoutCount": 2 },
    "firstPass": { "prs": 3, "readyToMerge": 2, "rate": 0.667 }
  },
  "backAndForth": {
    "prs": 3,
    "revisionsPerPr": { "average": 0.667, "max": 2, "distribution": { "0": 2, "1": 0, "2": 1, "3+": 0 } },
    "reviewsPerPr": { "average": 1.333, "max": 2 },
    "limitReached": 1
  }
}

// Kinds:   { "implement": n, "revision": n, "review": n, "unknown": n, "total": n }
// Dist:    { "count": n, "averageMs": ms, "medianMs": ms, "p90Ms": ms }
// Covered: Dist plus "total": the rows considered; "count" of them could be measured
```
