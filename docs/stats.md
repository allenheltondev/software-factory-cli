# Stats

`updraft stats` tells you how the factory is doing: what it finished, how long things took,
what came of it, what review caught and how much back-and-forth it took.

```sh
updraft stats                        # the last 30 days, all repositories
updraft stats --since 12h            # h, d or w, as for "updraft clean --older-than"
updraft stats --since today          # since midnight, in this machine's local time zone
updraft stats --since all --repo octo/widgets
updraft stats --json                 # the same, machine-readable
```

`--since today` starts the window at the most recent local midnight (an event exactly at midnight
is included; one a moment earlier is not). It works with `--repo` and `--json`; the JSON
`window.since` is that midnight as a UTC timestamp and `window.label` is `"today"`.

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

**Time taken.** *Agent run*: from the moment the agent process was spawned to the run's end,
by kind and by agent. It covers runs that ended succeeded, failed, interrupted or canceled. A
run that failed before its agent was spawned (while its checkout was prepared, for example) is
counted in `n of m` but not measured, and a `start_failed` run is not counted. *Queue wait*:
from the job being queued to the spawn of its first run's agent that actually launched.
Attempts that never launched an agent don't end the wait, and later attempts are not counted.
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

## Model tiers

With tier routing, escalation or several agent profiles configured, `updraft stats` also shows
whether each choice pays off. The same blocks (`routing` and `pressure`) are in every section of
`--json`, so `--repo` and the per-repository breakdown narrow them too. Nothing here leaves the
machine, and none of it changes how jobs are routed: it only measures.

### What is recorded

Schema v16 adds nullable columns to `metric_events` and six more kinds of fact, each written in
the transaction of the decision it describes and keyed so a restart records it once:

| Fact | Key | Holds |
| --- | --- | --- |
| `route.decided` | job id | tier, risk, selection source, reason code, classifier or triage confidence |
| `run.selected` | run id | profile (agent), pool, adapter, model, effort, resolved and requested tier, risk, selection source, confidence, escalations and retries so far |
| `job.retried` | job id and retry count | the retry (`updraft retry`) |
| `job.escalated` | job id and hop count | tier left and reached, the policy that decided (a fixed code), profile that failed |
| `job.deferred` | job id and deferral count | a job requeued to wait out a usage limit |
| `capacity.cooldown` | run id | capacity group or profile, cooldown length, whether the CLI stated the retry-after |

Failed verification (`run.ended` with `verify-failed`), reviewer findings and changes requested
(`review.verdict`, now with the PR head commit it judged), revisions (`revision.pushed`, also
with its head commit) and job start and end were already facts. They are attributed to a route
through the run and job ids.

- **Selection source** is one of `override` (a tier label), `local-rule` (the heuristic
  classifier), `cli-triage` (an answer from the triage CLI, fresh or cached), `fallback` (triage
  was asked and unavailable, so the local tier stands), `legacy-label` (a `pool.rules` match)
  or `default`.
- **Model and effort are configured, not observed.** They are the values the profile asks its
  CLI for (`model`/`effort`, or `--model` in `args`). A profile that sets neither is recorded
  with `model_source = unknown`: the CLI picks its own default and Updraft cannot tell which.
  `observed` is reserved for a CLI that reports the model it used; none does today, so it is
  never written. Treat a model name as the request, not as proof of what ran.
- **Resolved tier** is the tier of the pool the run was claimed from. After an escalation that
  is the new tier; the tier the router first asked for stays in `requested_tier`.
- **Not stored:** prompts, issue or review text, triage explanations, account names or emails,
  credential paths, session tokens, CLI output. Model and effort values that do not look like a
  plain identifier (for example a path) are dropped.
- **Older databases.** Migration 16 only adds columns. Existing rows keep `NULL`, and a run from
  before this version is reported under the tier `unknown`, with its profile taken from the run
  record. Selections are never backfilled. `updraft stats` still reads a database that has not
  been upgraded (it never migrates one).

### What is reported

For implement jobs, by tier, by profile and by model (`routing.byTier`, `byProfile`, `byModel`):

- `jobs` that finished in the window and `success`: succeeded of succeeded plus failed, with the
  count, sample size, rate and a 95% Wilson interval (`low`, `high`). Canceled and interrupted
  jobs are not counted either way.
- `smallSample`: true below `routing.minSample` (20) jobs. Do not compare groups that are small.
- `reviewReady`: of the PRs opened in the window that Updraft's reviewer has reviewed, how many
  have a latest verdict of ready-to-merge. `changesRequested` counts the changes-requested
  verdicts and `revisions` the revision pushes on those PRs.
- `labelToPr` (time to a finished PR), `queueWait`, `retries` and `verificationFailures` (runs of
  the group whose verify commands failed).
- `escalatedOut`: jobs moved up after a run of this group. `escalatedIn`: jobs that finished here
  after at least one escalation.

**Attribution after an escalation.** A job's outcome belongs to the run that ended it, so a job
that failed on `routine` and succeeded on `complex` is a `complex` success flagged in
`escalatedIn`. The failed run counts against `routine` through `verificationFailures` and
`escalatedOut`. A group's success rate therefore describes work that reached it, not work that
started there: compare `escalatedIn` with `jobs` before reading a cheap tier's rate as better.

`routing.decisions` counts the routing decisions made in the window by source and tier, and
`triageFallbacks` how many fell back. `pressure` reports the local signals of subscription
usage: cooldowns started by a recognized usage-limit exit (count, total time, per group or
profile), jobs deferred, and runs whose agent could not start. It does not know your plan's quota
and reports no token, credit or dollar figure: `tokenUsage.reported` is `false` because the CLIs
Updraft drives give no trustworthy number.

### Evaluating a model choice

1. Let a route collect a meaningful sample before judging it: at least `minSample` jobs per group
   and, better, several dozen. Read the interval, not the point rate: 9 of 10 is 90% but its
   range runs from about 57% to 98%.
2. Compare like with like. Use `--since` to hold the window and the configuration steady, and
   change one thing at a time (a model, an effort, a tier mapping). Different mixes of issues
   make a cheaper tier look better or worse than it is.
3. Judge the outcome through to review, not just completion: success rate, then `reviewReady`,
   then revisions per PR, `verificationFailures` and time to PR, and count the escalations a
   cheap tier needed.
4. Weigh pressure: a profile that often hits a usage limit costs queue time elsewhere.
5. Keep the high-risk policy. Risk-based routing and `tiers.highRisk` hold whatever the
   history says; a cheaper average is never a reason to route high-risk work to a cheaper pool.

Nothing here recommends a model automatically. The facts are kept per run so a later comparison
tool can read them without a new migration.

## What it does not measure

- **Model use before schema v16.** Runs from before it have no selection facts.

- **History that was pruned before the upgrade.** The backfill can only read rows that are still
  there. After the upgrade nothing is lost to pruning.
- **A retried job's earlier final statuses from before the upgrade**: the jobs table only holds
  the latest one. After the upgrade, each one is its own fact, including two with no claim in
  between (canceled, retried with `updraft retry`, canceled again).
- **Exact agent start times from before the upgrade.** Older runs recorded no spawn time. A run
  with a recorded agent pid is measured from its execution start, which is slightly earlier,
  because it includes preparing the checkout. A run without a pid is not measured.
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
