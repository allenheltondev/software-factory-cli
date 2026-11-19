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

A caller should not wait for the end of a run to do step 3 for the first time: a run opens its
pull request early and can go on for hours, and until its state is in the shared database no
other run knows that pull request. [Checkpoints](#checkpoints) are step 3 done while the run
is still going, with `--live`.

```
updraft state merge --changed <db the run used> --into <latest shared db>
                    [--base <snapshot the run started from>] [--live] [--json]
updraft state copy  --db <file> --out <new file> [--json]
updraft state info  --db <file> [--json]
```

## `updraft state merge`

| Option | Meaning |
| --- | --- |
| `--changed <file>` | The state database the run used |
| `--into <file>` | The latest shared copy. Created when it does not exist. Rewritten only when there is something to merge |
| `--base <file>` | The snapshot the run started from. Omit it when the run started from nothing: every row of `--changed` is then the run's |
| `--live` | The run is still going and is writing to `--changed`: a [checkpoint](#checkpoints). `--changed` is read in one read transaction, its files are not touched, and nothing unfinished is settled |
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
  "schemaVersion": 16,
  "created": false,
  "migratedFrom": null,
  "tables": {
    "jobs": { "inserted": 1, "updated": 0, "appended": 0, "conflicts": 0, "dropped": 0 },
    "runs": { "inserted": 1, "updated": 0, "appended": 0, "conflicts": 0, "dropped": 0 },
    "metric_events": { "inserted": 0, "updated": 0, "appended": 2, "conflicts": 0, "dropped": 0 }
  },
  "totals": { "inserted": 2, "updated": 0, "appended": 2, "conflicts": 0, "dropped": 0 },
  "unfinished": { "runsInterrupted": 0, "runsReleased": 0, "jobsInterrupted": 0, "stepsClosed": 0, "holdsReleased": 0 },
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

## `updraft state copy`

`updraft state copy --db <file> --out <new file> [--json]` writes a consistent copy of a state
database as one file. It reads through SQLite (`VACUUM INTO` on a read-only connection), so it
is safe while a run is writing to `--db`: the copy is the database as of one moment, commits
that are still in the write-ahead log included, with every row under the id it has, and with
no `-wal` or `-shm` file beside it. `--db` is not changed. `--out` must not exist. Exit code 0
when copied, 2 when `--db` is missing or unreadable or `--out` exists, 1 otherwise.

It is for keeping the database of a run whose merge could not be uploaded
([Recovery](#recovery)), and for anything else that wants a snapshot of a live database. Do
not copy `state.db` with `cp` while a run is going: without its `-wal` file the copy lacks the
newest commits, and a copy of both taken at different moments can be inconsistent.

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
| `jobs` | `id` | A finished job (succeeded, failed, interrupted, canceled) beats an unfinished one; between two finished or two unfinished, the later `updated_at` wins (this run's on a tie). `attempts`, `retries`, `deferrals` and `escalation_hops` take the larger value. A job whose event `--into` has a tombstone for (`pruned_events`) is not inserted. A job whose dedupe key (repository, workflow, event) `--into` already has under **another id** is folded into that job: the existing row keeps the key, the rule above decides its content, and this run's runs and records are attached to it. A [reconstructed](#reconstructed-rows) row never replaces a finished job that a run recorded |
| `runs` | `id` | A run id is written by one run only: this run's row wins. Inserted only when its job is in `--into`. A [reconstructed](#reconstructed-rows) row never replaces a recorded one |
| `publications` | `run_id` | As `runs`; inserted only when its run is in `--into`. A [reconstructed](#reconstructed-rows) row never replaces a recorded one |
| `failure_comments` | `run_id` | As `publications` |
| `revisions` | `run_id` | As `publications` |
| `pr_reviews` | `run_id` | As `publications` |
| `revision_prs` | `repo_id, pr_number` | A merged row beats an unmerged one, and a closed row an open one. Between two open rows the later `updated_at` wins, as a whole row. (A [reconstructed](#reconstructed-rows) row carries the epoch as its `updated_at`, so every recorded row is later) |
| `review_requests` | `repo_id, review_id` | The decision recorded first stands: `--into`'s row is kept |
| `pruned_events` | `repo_id, workflow_id, event_id` | Tombstones are only ever added; an existing one is kept as it is |
| `triage_cache` | `cache_key` | An answer beats a recorded failure; otherwise the later `created_at` wins |
| `capacity_cooldowns` | `scope, name` | The later expiry (`until`) wins |
| `publish_settings` | `repo_id` | The later `updated_at` wins |
| `meta` | `key` | Last writer wins: this run's value. ([Holds](#holds) are `meta` rows; a final merge releases the ones its run left) |
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

- A [hold](#holds) the run did not release itself is released.

`unfinished` in the output counts these. Unfinished work of **other** runs that happens to be in
`--into` or in the snapshot is not touched: this run never changed those rows, and their owner
may still be working.

"The rows this merge wrote" includes rows of the run that `--into` already has exactly as the
run left them, from an earlier merge of the same database (a checkpoint): they are the run's,
and are settled like the rest.

None of this happens with `--live`: that run has not ended.

A job that is `queued` at the end of a run (for example behind a usage-limit cooldown) is merged
as it is. That is the point: the next delivery of the event finds it and continues.

## Checkpoints

`updraft state merge --live` merges the database of a run that is **still going**. The caller
does everything else as for the final merge: download the latest shared copy, merge into it,
upload with the conditional write, start over if it lost the race. What `--live` changes:

- **A consistent reading.** `--changed` is opened through SQLite, read-only, and everything
  the merge reads from it is read in one read transaction. In write-ahead-log mode that is one
  state of the database, whatever the run commits meanwhile; a transaction the run has open is
  not in it. The run is never blocked from writing. (Never hand the merge a raw copy of a
  database in use instead; if a copy is needed, `updraft state copy` makes one.)
- **Its files are left alone.** `-wal` and `-shm` beside `--changed` belong to the run. (After
  a merge without `--live`, such files that the merge itself caused are removed.)
- **Nothing is settled.** An open run stays open, a running job `running`, a publication
  `publishing`, a hold held. That is the truth about them, and `updraft run-event` on another
  machine treats such rows as it always treated another worker's: it does not close them,
  signal them, requeue them or count them towards any limit. The worker lock is never carried,
  as ever.
- `--base` is the snapshot the run started from, the same file for every checkpoint and for
  the final merge. An older `--changed` (the run has not migrated it yet) is copied aside
  with `state copy` and migrated there.

**The final merge after checkpoints.** When the run has ended, merge once more without
`--live`, against the same `--base`. Every row the run changed is compared with what `--into`
has by then, which for most of them is the run's own earlier version from a checkpoint:

- identical: nothing to do (and, if it shows unfinished work, it is settled now);
- different: the rule of the table decides, and each rule ends at the run's final version of a
  row that only this run wrote. `runs`, `publications`, `revisions`, `pr_reviews`,
  `failure_comments`, `meta` and `pool_cursors` take this run's row; a job's later
  `updated_at`, or its being finished, wins; `review_requests` and `pruned_events` rows are
  never changed after they are written, so the first version is the final one. The merge
  counts these as `conflicts`, which they formally are;
- rows of the append-only tables are recognised by their content: what a checkpoint appended
  is not appended again.

So a checkpoint followed by the final merge leaves the shared copy as the final merge alone
would have left it, and merging the same run once more adds nothing: both are tested
(`src/db/merge.test.ts`). If another run changed one of the same rows in between, that is an
ordinary conflict under the same rule.

One difference to a run that is only merged at its end: between a checkpoint and the final
merge, other runs **see** this run's rows. What they do with them is the next section.

### Holds

A hold is how a run that is still going tells the others which work in a snapshot is its own.
`updraft run-event` writes one `meta` row per job of its event (key
`run-event:hold:job:<job id>`), or one for the pull request of a pull request event
(`run-event:hold:pr:<repo id>#<number>`), before it starts working, with a value like
`{"holder":"wrk_…","delivery":"…","until":"<ISO time>","releasedAt":null}`. A hold covers the
job (or pull request), the pull request the job opened, and every reviewer and revision job of
that pull request. It ends when:

- the run releases it (`releasedAt` is set as the run's last write), or
- the final merge of the run's database releases it for a run that could not
  (`unfinished.holdsReleased`), or
- `until` has passed: 15 minutes after the run's `--deadline-minutes`, six hours when it has
  none. This is the only thing that ends the hold of a run whose machine vanished after a
  checkpoint.

A run that starts from a snapshot with another run's live hold in it takes note, once, of the
unfinished work the hold covers (queued and running jobs, open runs, steps towards GitHub that
are not final, the pull requests), and for the rest of its life:

- does not start those queued jobs, and does not retry those steps;
- does not wait for, evaluate or make the merge of a held pull request, and does not post its
  notices, **unless** it has work of its own on that pull request (a job it queued itself,
  because its event brought a new review or a new head): from then on the loop for that pull
  request is its own to carry through as well;
- still treats a held pull request as watched: a pull request event reads it from GitHub and
  acts on what is new.

Two runs can hold the same key (two events for one pull request); the row is then whichever
was merged last, which is enough: it says that somebody holds it, and until when.

## Reconstructed rows

`updraft run-event` can find that the pull request of an event exists on GitHub while the
state database has nothing of the run that opened it: that run's state was lost
([run-event.md](run-event.md#restoring-lost-state)). It then writes the job, the run, the
publication and the watch row again, from the event and the GitHub API. Those rows are real
enough for the revision and review loops, and they are not a record of what happened: there
is no run summary, no log, no commit. They are marked so that anybody, and the merge, can tell:

| Row | Mark |
| --- | --- |
| `jobs` | `status_reason` begins with `reconstructed: ` |
| `runs` | `worker_id` and `hostname` are `reconstructed`; `error` begins with `reconstructed: `; `summary` is null |
| `publications` | `error` begins with `reconstructed: ` (on a row in state `published`); `head_sha`, `pushed_at` and the comment are null |
| `revision_prs` | `created_at` is `1970-01-01T00:00:00.000Z`, and so is `updated_at` until a later run records something about the pull request |

The run id is the original run's (it is in the pull request's body), and the job id is derived
from the event, so reconstructed rows have **the same keys** as the rows the original run
recorded. If that run's database reaches the shared copy after all (see [Recovery](#recovery)),
the two meet as conflicts, and the recorded row wins whichever arrives first:

- `runs`, `publications`: this run's row wins as always, except that a reconstructed row never
  replaces one that is not;
- `jobs`: a reconstructed row never replaces a finished job a run recorded (against an
  unfinished one, the usual rule applies: finished beats unfinished);
- `revision_prs`: the usual rule. A reconstructed row that nothing has touched is older than
  any recorded row and loses; one that a later run has updated (it read the pull request,
  queued a revision) is an ordinary row by then, and the later `updated_at` wins.

Nothing is duplicated: there is one job, one run and one publication under those keys before
and after. Rows that hang off them and that later runs recorded (a revision job, its review
request) are untouched.

## Recovery

What to do when a run's final merge could not be uploaded, so that the shared copy lacks what
the run recorded after its last checkpoint.

1. **Keep the run's database.** Before the machine goes away: `updraft state copy --db
   <UPDRAFT_HOME>/state.db --out <file>`, and store that file and the snapshot the run started
   from (`--base`) somewhere other than the shared copy's key. Report the run as failed, so
   that its event can be delivered again.
2. **Merge it later**, from anywhere: download the latest shared copy, `updraft state merge
   --changed <the kept file> --base <the kept snapshot> --into <latest>` (no `--live`: the run
   is over, and what it left unfinished is settled), upload with the conditional write, repeat
   on a lost race. This is exactly the merge the run's machine would have made. Without the
   kept snapshot, omit `--base` only if the run started from nothing; otherwise rows the run
   never touched would be merged as if it had written them.
3. **Or deliver the event again.** For a run that opened a pull request, `updraft run-event`
   restores the publication from GitHub ([Reconstructed rows](#reconstructed-rows)), which is
   enough for reviews to be acted on. Step 2 can still follow, in either order.

No later run depends on step 2: runs never read the kept files, and a merge of some other run
is the same whether or not they exist. Merging a kept database twice adds nothing.

## What concurrent runs can and cannot do to each other

Two runs never write the same file. Each works on its own copy, and the copies meet only in the
merge, under the rules above. So one run cannot corrupt another's database, and a run that is
killed leaves the shared database as it was at its last checkpoint. With checkpoints, a run's
rows are in the shared copy while it works, and [holds](#holds) keep other runs from finishing
its work for it. What can still go wrong is two runs **not knowing enough about each other**
while they work, because a snapshot is only as new as the last upload before it was taken:

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
- **A review handled in two places.** A person's review that is submitted while the run that
  opened the pull request is still going is acted on by the run its own delivery started (the
  pull request is on record after the first checkpoint), and it is also found by the first
  run's [last look](run-event.md#the-last-look), which does not have the other run's record of
  it. This is the case above with a different timing, and with the same bounds: at most one
  extra agent run and one extra comment, never two pushes. In the merge, the second revision
  job is folded into the first and `review_requests` keeps the first decision.
- **A dead run's work waits for its hold.** A run that checkpointed and then vanished (no
  final merge) leaves its jobs `running` or `queued` and its hold in force until `until`. Other
  runs leave that work alone for that long. After that, a queued job is picked up by the next
  delivery of its event like any leftover; a job left `running` stays so (nothing reconciles
  across machines) until its event is delivered again and, if GitHub has its pull request, its
  publication is restored, or until the run's kept database is merged ([Recovery](#recovery)).
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
