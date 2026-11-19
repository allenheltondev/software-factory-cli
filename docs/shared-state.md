# A state database shared between runs: `updraft state merge`

`updraft start` is one process with one state database. `updraft run-event`
([run-event.md](run-event.md)) is one process per event, usually on a machine that exists only
for that event. Most of what the worker does depends on history in the state database:
usage-limit cooldowns, the triage cache and its hourly limit, the round-robin cursors, the stats
rollup, and the whole review loop (which pull requests Updraft opened, which reviews were already
acted on, how many revisions a pull request has had). A machine that starts with an empty
database has none of it.

So the runs share one database, as a file:

1. Before a run, the caller downloads the current shared database and keeps an untouched copy
   of it (the **snapshot**).
2. `updraft run-event` uses the downloaded file as its state database
   (`<UPDRAFT_HOME>/state.db`).
3. After the run, the caller downloads the shared database again (other runs may have changed it
   meanwhile), merges what this run changed into it, and uploads the result with a conditional
   write. If the upload loses the race, it repeats this step with the newer copy.

Step 3's merge is `updraft state merge`. Where the file is kept and how the conditional write
works is the caller's business; Updraft only ever sees local files.

```
updraft state merge --changed <db the run used> --into <latest shared db>
                    [--base <snapshot the run started from>] [--json]
updraft state info  --db <file> [--json]
```

## `updraft state merge`

| Option | Meaning |
| --- | --- |
| `--changed <file>` | The state database the run used |
| `--into <file>` | The latest shared copy. Created when it does not exist. Rewritten only when there is something to merge |
| `--base <file>` | The snapshot the run started from. Omit it when the run started from nothing: every row of `--changed` is then the run's |
| `--json` | Print one JSON object on stdout |

It applies to `--into` every row the run added or changed, relative to `--base`: a three-way
merge by primary key, table by table, not a file copy.

- A row of `--changed` that is identical to its row in `--base` was not touched by the run. It
  is not looked at again, whatever `--into` says about it: rows other runs changed or added stay
  as they are.
- A row the run added is inserted. A row the run changed, which nobody else changed since the
  snapshot, is replaced by the run's version.
- A row the run changed **and** another run changed since the snapshot (or that both added under
  the same key) is a **conflict**, resolved by the rule of its table (below).
- A row the run changed that `--into` no longer has was deleted there since the snapshot (by
  `updraft clean --older-than`). It is not brought back, and neither is anything that hangs off
  it.
- Deletions are not merged. A row that is missing from `--changed` is simply not touched. To
  prune the shared database, run `updraft clean --older-than` on a downloaded copy and upload
  that copy with the same conditional write; do not expect a merge to carry the deletions.

### What the caller can rely on

- **`--into` is never left half-written.** The merge works on a copy next to it and replaces it
  in one rename at the end. If anything fails, `--into` is the file it was.
- **The result is one self-contained file.** It is checkpointed and switched out of
  write-ahead-log mode before the rename: there is no `-wal` or `-shm` file to upload with it.
  (Any Updraft command that opens it later switches it back, as for every state database.)
  Stray `-wal`/`-shm` files that reading the inputs created are removed again.
- **`--changed` and `--base` are not modified.** One that is at an older schema version is
  copied to a temporary directory and migrated there. A `-wal` file beside `--changed` (the run
  was killed) is read as part of it.
- **Schema versions.** `--into` older than this CLI: it is migrated as part of the merge.
  `--into`, `--changed` or `--base` newer than this CLI: the merge refuses with exit code 5 and
  changes nothing. Run it again with a newer `updraft`, or do not upload. The merge never
  writes a database that the `updraft start` of the same version could not open.
- **Applying the same merge twice adds nothing.** Keyed rows are already there, and appended
  rows are recognised by their content. The second merge reports `changed: false` unless the
  run left unfinished work (which is settled again, to the same result).

### Output and exit codes

`--json` prints one object:

```json
{
  "ok": true,
  "changed": true,
  "schemaVersion": 15,
  "created": false,
  "migratedFrom": null,
  "tables": {
    "jobs": { "inserted": 1, "updated": 0, "appended": 0, "conflicts": 0, "dropped": 0 },
    "runs": { "inserted": 1, "updated": 0, "appended": 0, "conflicts": 0, "dropped": 0 },
    "metric_events": { "inserted": 0, "updated": 0, "appended": 2, "conflicts": 0, "dropped": 0 }
  },
  "totals": { "inserted": 2, "updated": 0, "appended": 2, "conflicts": 0, "dropped": 0 },
  "unfinished": { "runsInterrupted": 0, "runsReleased": 0, "jobsInterrupted": 0, "stepsClosed": 0 },
  "jobsFolded": {},
  "exitCode": 0
}
```

| Field | Meaning |
| --- | --- |
| `changed` | False when the run changed nothing that `--into` does not already have. `--into` was then not rewritten (not even to migrate it), and the upload can be skipped |
| `schemaVersion` | The schema version of `--into` as it is now |
| `created` | True when `--into` did not exist. It is created even when there was nothing to merge |
| `migratedFrom` | The version `--into` was migrated from, or null |
| `tables` | Per table: rows `inserted`, `updated` (replaced by the run's version or by a conflict's resolution), `appended` (append-only tables), `conflicts` resolved, and `dropped` (rows of the run left out because their job was pruned or deleted in `--into`). Every merged table is listed |
| `unfinished` | Work the run left unfinished, as `--into` now records it (see [Work the run did not finish](#work-the-run-did-not-finish)) |
| `jobsFolded` | Jobs of the run that were folded into the job `--into` already had for the same event (see `jobs` below): the run's job id to the id that was kept |

When the merge is refused or fails, the object is `{ "ok": false, "changed": false, "reason":
"schema-too-new" | "bad-input" | "failed", "error": "...", "exitCode": n }`, and the error is on
stderr too.

| Code | Meaning |
| --- | --- |
| 0 | Merged, or nothing to merge |
| 1 | The merge failed. `--into` is unchanged |
| 2 | A file is missing or unreadable, or the same file was named twice. `--into` is unchanged |
| 5 | `--into` (or `--changed`, `--base`) is at a newer schema version than this CLI. `--into` is unchanged |

## `updraft state info`

`updraft state info --db <file> [--json]` prints the schema version, whether this CLI can open
the file, the rows per table, the jobs by status, how many runs are open, and whether the file
carries a worker lock. It opens the file read-only: no migration, nothing written. Exit code 2
when the file does not exist (`{"exists": false}` with `--json`).

## The rule per table

Every table has a rule in `TABLE_RULES` (`src/db/merge.ts`). The merge refuses to run when
`--changed` has a table without one, and a test fails when a migration adds a table without
adding its rule and its row here.

| Table | Key | Rule; on a conflict |
| --- | --- | --- |
| `jobs` | `id` | A finished job (succeeded, failed, interrupted, canceled) beats an unfinished one; between two finished or two unfinished, the later `updated_at` wins (this run's on a tie). `attempts`, `retries`, `deferrals` and `escalation_hops` take the larger value. A job whose event `--into` has a tombstone for (`pruned_events`) is not inserted. A job whose dedupe key (repository, workflow, event) `--into` already has under **another id** is folded into that job: the existing row keeps the key, the rule above decides its content, and this run's runs and records are attached to it |
| `runs` | `id` | A run id is written by one run only: this run's row wins. Inserted only when its job is in `--into` |
| `publications` | `run_id` | As `runs`; inserted only when its run is in `--into` |
| `failure_comments` | `run_id` | As `publications` |
| `revisions` | `run_id` | As `publications` |
| `pr_reviews` | `run_id` | As `publications` |
| `revision_prs` | `repo_id, pr_number` | A merged row beats an unmerged one, and a closed row an open one. Between two open rows the later `updated_at` wins, as a whole row |
| `review_requests` | `repo_id, review_id` | The decision recorded first stands: `--into`'s row is kept |
| `pruned_events` | `repo_id, workflow_id, event_id` | Tombstones are only ever added; an existing one is kept as it is |
| `triage_cache` | `cache_key` | An answer beats a recorded failure; otherwise the later `created_at` wins |
| `capacity_cooldowns` | `scope, name` | The later expiry (`until`) wins |
| `publish_settings` | `repo_id` | The later `updated_at` wins |
| `meta` | `key` | Last writer wins: this run's value |
| `pool_cursors` | `pool` | Last writer wins: this run's position |
| `repo_checkpoints` | `repo_id` | The further position wins: `last_event_id` and `last_event_created_at` take the larger value, the rest comes from the row with the later `updated_at`; where the subscription started is never changed |
| `review_checkpoints` | `repo_id` | The later `last_updated_at` wins, then the later `updated_at` |
| `errors` | append-only | Rows the run added are appended under new ids |
| `metric_events` | append-only | Rows the run added are appended under new ids. A fact (`kind`, `subject_id`) that `--into` already has is kept as recorded first |
| `policy_events` | append-only | Rows the run added are appended under new ids |
| `triage_runs` | append-only | Rows the run added are appended under new ids |
| `worker_lock` | - | Never carried over. A lock belongs to one process on one machine |

About the append-only tables: their `id` is an `AUTOINCREMENT` integer, and two runs that start
from the same snapshot hand out the same ids. So an id is never merged. The rows the run added
are the ones whose id the snapshot does not have; each is inserted without its id and gets the
next one of `--into`. Nothing in the schema refers to one of these ids (a test checks that no
such column appears), so nothing has to be rewritten. A row whose content is already in `--into`
is not appended again; that is what makes a repeated merge harmless.

### Work the run did not finish

A run is over when its database is merged. Whatever it still shows as in progress is not: the
process is gone. Left as it is, the shared database would show the work as taken for ever. So for
the rows **this merge wrote**, and only those:

- A run that had started (its agent was launched, or was about to be) is closed as `interrupted`
  and its job becomes `interrupted`, exactly as a restarted worker records a run its predecessor
  left. Nothing retries it by itself: `updraft retry JOB_ID` on a copy of the shared database
  puts it back in the queue, and the next delivery of the event runs it.
- A run that was claimed and never started is closed without an outcome and its job goes back to
  `queued`. The next delivery of the event runs it.
- A publication or revision push that was mid-step, or scheduled for a retry, becomes `failed`
  and is not retried: the commits to push existed only in the clone of the machine that is gone.
- A review posting or failure comment that was mid-step becomes `failed` and due for a retry:
  both are made from the database alone, so a later run of the same event can still make them.

`unfinished` in the output counts these. Unfinished work of **other** runs that happens to be in
`--into` or in the snapshot is not touched: this run never changed those rows, and their owner
may still be working.

A job that is `queued` at the end of a run (for example behind a usage-limit cooldown) is merged
as it is. That is the point: the next delivery of the event finds it and continues.

## What concurrent runs can and cannot do to each other

Two runs never write the same file. Each works on its own copy, and the copies meet only in the
merge, under the rules above. So one run cannot corrupt another's database, and a run that is
killed leaves the shared database as it was. What can go wrong is the two runs **not knowing
about each other** while they work, because neither has uploaded yet:

- **The same event twice at the same moment.** Both queue the same job (the job id is derived
  from the event), both run the agent, and GitHub decides: only one push can create the branch.
  The other ends `superseded` ([run-event.md](run-event.md#idempotency)). In the merge the job
  is one row (a conflict; both say `succeeded`), with both runs on record.
- **Two events for the same pull request at the same moment** (a review and a push, or a review
  that is submitted and then edited). Each run reads the pull request from the API and may queue
  the same revision or the same reviewer run. What they can do: run the agent twice, and post
  two review comments for the same head commit. What they cannot do: push twice. A revision
  push only fast-forwards from the exact commit it started from, so the second is refused and
  changes nothing on the branch (it does leave a comment on the pull request that says so).
  Nor can they merge twice or merge the wrong commit: the merge request names the reviewed
  commit, and GitHub refuses it for any other head. In the merge, the second run's revision or
  reviewer job is folded into the first one's (same event key), `review_requests` keeps the
  first decision, and `revision_prs` keeps the further-advanced row.
- **`maxRevisions` can be exceeded by one** in that same race: each run counts the revisions in
  its own snapshot.
- **A cooldown set by one run is not seen by runs that started before it was uploaded.** They
  will try the agent, hit the same limit, and set the cooldown themselves.
- **Rotation is approximate.** Two runs that start from the same cursor pick the same agent, and
  the cursor of the run merged last stays. The rule "the author of the code does not review it"
  is not affected: it is decided from the job, not from a cursor.
- **Per-agent and global concurrency limits do not span machines.** `maxConcurrent` and a
  capacity group's limit count the runs of one process. A hundred events at once are a hundred
  agents, unless the caller limits how many machines it starts.
- **One job per issue at a time is not enforced across machines** for the same reason. Within
  one run it is.
- **The triage limit per hour can be exceeded** by runs that overlap, each counting only the
  launches it knows of.

And what is deliberately approximate in the merged result:

- `revision_prs` is merged as a whole row. If two runs changed different facts about one pull
  request (one saw a new head, the other recorded a verdict), the row merged last wins and the
  other's observation is gone until the next event about the pull request reads it from GitHub
  again. Closed and merged are never lost.
- `updraft stats` counts every agent run, including both runs of a race.
- Paths in the database (`runs.log_path`, `runs.checkout_path`, worktrees) are the paths on the
  machine that ran the job. On any other machine `updraft logs` finds nothing there, and
  `updraft publish RUN_ID` has no commits to push. Keep the run's `logs/` directory if you want
  the logs.
- Timestamps come from each machine's clock. "Later wins" rules assume the clocks agree to
  within the length of a run or so.

## Seeding and maintenance

- **Starting from the database of a worker.** Merge it into nothing:
  `updraft state merge --changed <worker's state.db> --into shared.db` (with the worker
  stopped). That drops its lock and closes whatever it left open. Do not upload a raw copy of a
  running worker's database: a run that starts from a snapshot with a fresh lock in it exits
  with code 3.
- **Pruning.** `UPDRAFT_HOME=<dir with a copy> updraft clean --older-than 30d`, then upload that
  copy conditionally. Runs that started before the upload and changed a pruned job merge
  without bringing it back.
- **Looking.** `updraft state info --db shared.db`, or any read-only command on a copy
  (`UPDRAFT_HOME=<dir> updraft status`, `updraft stats`).
- **A worker and single-event runs on the same repositories.** Not supported as one system. A
  long-running `updraft start` keeps its own database on its own machine; it would not see
  what the single-event runs record, and both would pick up the same labels.
