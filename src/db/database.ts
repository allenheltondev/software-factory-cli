import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { EventEnvelope, Job, JobStatus, Run, RunOutcome, RunSummary } from '../types.js';
import { backfillMetrics, mergeReasonCodeSql } from './metrics.js';

export type Db = DatabaseSyncType;

/**
 * node:sqlite prints an ExperimentalWarning on first load. Filter exactly that
 * warning so CLI output stays clean, then load the module.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/.test(msg)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

export const SCHEMA_VERSION = 22;

/** The schema version that added the CI step's one re-run per head and the merge block's code (docs/ci-fix.md, "One re-run"). */
export const RERUN_SCHEMA_VERSION = 22;

/** The schema version that added the suggestion step (review.suggestions, docs/review-loop.md "Suggestions"). */
export const SUGGESTIONS_SCHEMA_VERSION = 21;

/** The schema version that added the needs-verification outcome of pr_reviews (docs/acceptance.md). */
export const ACCEPTANCE_SCHEMA_VERSION = 20;

/** The schema version that added review_findings (docs/review-loop.md, "Findings as threads"). */
export const FINDINGS_SCHEMA_VERSION = 19;

/** The schema version that added dependency_waits (docs/dependencies.md). */
export const DEPENDENCIES_SCHEMA_VERSION = 17;

/** The schema version that added the metric_events rollup (`updraft stats`). */
export const METRICS_SCHEMA_VERSION = 13;

/** A migration is plain SQL, or a function for steps that need to backfill from existing rows. */
type Migration = string | ((db: Db) => void);

const MIGRATIONS: Record<number, Migration> = {
  1: `
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- One event-stream checkpoint per watched repository (keyed by stable GitHub ID).
    CREATE TABLE repo_checkpoints (
      repo_id        INTEGER PRIMARY KEY,
      full_name      TEXT    NOT NULL,
      last_event_id  INTEGER,            -- highest GitHub issue-event ID fully processed
      etag           TEXT,               -- ETag of the newest events page, for conditional polling
      initialized_at TEXT    NOT NULL,
      updated_at     TEXT    NOT NULL
    );

    CREATE TABLE jobs (
      id             TEXT    PRIMARY KEY,
      repo_id        INTEGER NOT NULL,
      repo_full_name TEXT    NOT NULL,
      workflow_id    TEXT    NOT NULL,
      event_id       TEXT    NOT NULL,
      issue_number   INTEGER NOT NULL,
      action         TEXT    NOT NULL,
      pool           TEXT    NOT NULL,
      envelope       TEXT    NOT NULL,   -- JSON EventEnvelope
      status         TEXT    NOT NULL CHECK (status IN ('queued','running','succeeded','failed','interrupted','canceled')),
      status_reason  TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL,
      updated_at     TEXT    NOT NULL,
      UNIQUE (repo_id, workflow_id, event_id)
    );
    CREATE INDEX jobs_by_status ON jobs (status, created_at);
    CREATE INDEX jobs_by_issue  ON jobs (repo_id, issue_number, status);

    CREATE TABLE runs (
      id               TEXT    PRIMARY KEY,
      job_id           TEXT    NOT NULL REFERENCES jobs (id),
      attempt          INTEGER NOT NULL,
      pool             TEXT    NOT NULL,
      agent            TEXT    NOT NULL,
      checkout_path    TEXT,
      log_path         TEXT,
      worker_id        TEXT    NOT NULL,
      pid              INTEGER,
      lease_expires_at TEXT    NOT NULL,
      started_at       TEXT    NOT NULL,
      ended_at         TEXT,
      outcome          TEXT CHECK (outcome IN ('succeeded','failed','interrupted','start_failed')),
      error            TEXT
    );
    CREATE INDEX runs_by_job    ON runs (job_id, attempt);
    CREATE INDEX runs_active    ON runs (ended_at);

    -- Round-robin position per pool, so rotation survives restarts.
    CREATE TABLE pool_cursors (
      pool       TEXT    PRIMARY KEY,
      next_index INTEGER NOT NULL
    );

    -- Single-worker lock. One row at most.
    CREATE TABLE worker_lock (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      worker_id    TEXT    NOT NULL,
      pid          INTEGER NOT NULL,
      hostname     TEXT    NOT NULL,
      started_at   TEXT    NOT NULL,
      heartbeat_at TEXT    NOT NULL
    );

    CREATE TABLE errors (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      at             TEXT    NOT NULL,
      scope          TEXT    NOT NULL,   -- e.g. 'poll', 'worker', 'github'
      repo_full_name TEXT,
      job_id         TEXT,
      message        TEXT    NOT NULL
    );
    CREATE INDEX errors_by_time ON errors (at);
  `,
  2: `
    -- created_at of the newest event seen by the last committed scan. The events
    -- endpoint orders by created_at (not id), so the poller scans back to this time
    -- minus an overlap instead of stopping at the first already-seen id.
    ALTER TABLE repo_checkpoints ADD COLUMN last_event_created_at TEXT;
  `,
  3: `
    -- Where the subscription started. Events at or before it are never dispatched, even
    -- when a later scan's overlap window reaches back over them.
    ALTER TABLE repo_checkpoints ADD COLUMN start_event_id INTEGER;
    ALTER TABLE repo_checkpoints ADD COLUMN start_created_at TEXT;
    -- 1 when page 1 of the last scan reached past the overlap boundary (or was the whole
    -- stream). Only then does a page-1 304 prove nothing in the overlap changed.
    ALTER TABLE repo_checkpoints ADD COLUMN page1_covers_overlap INTEGER;
  `,
  4: (db) => {
    db.exec(`
      -- Host the claiming worker ran on. Reconcile only signals a recorded pid when this
      -- equals its own host. NULL (unknown) is never signalled.
      ALTER TABLE runs ADD COLUMN hostname TEXT;
      -- Consecutive start failures since the job was enqueued or last retried by the user.
      -- Replaces the retry_floor:<jobId> rows in meta.
      ALTER TABLE jobs ADD COLUMN start_failures INTEGER NOT NULL DEFAULT 0;
      -- When the worker handed the run to the executor (after the pre-start check). NULL
      -- means the agent never started, so reconcile can requeue the job instead of
      -- marking it interrupted.
      ALTER TABLE runs ADD COLUMN execution_started_at TEXT;
    `);
    // v3 did not record this. Closed runs with an outcome did execute. Open runs might
    // have, so treat them as started: they stay 'interrupted' for inspection, as before.
    // Runs closed without an outcome (canceled/released before start) stay NULL.
    db.exec('UPDATE runs SET execution_started_at = started_at WHERE outcome IS NOT NULL OR ended_at IS NULL');
    // A run's host was only known for the current lock holder; carry that over so the
    // next worker can still reap that holder's processes. Other runs stay NULL.
    db.exec(`
      UPDATE runs SET hostname = (SELECT l.hostname FROM worker_lock l WHERE l.worker_id = runs.worker_id)
      WHERE hostname IS NULL
    `);
    backfillStartFailures(db);
    db.exec("DELETE FROM meta WHERE substr(key, 1, 12) = 'retry_floor:'");
  },
  5: `
    -- OS start time of runs.pid, platform-tagged ("linux:<boot id>:<ticks>", "darwin:<lstart>",
    -- "win32:<filetime>"). Reconcile and shutdown signal a pid only when its current start time
    -- still matches, so a pid the OS reused is never killed. Earlier runs have none and are
    -- never signalled.
    ALTER TABLE runs ADD COLUMN pid_start_time TEXT;
    -- JSON RunSummary written after a live agent run: commits, changed files, last output.
    ALTER TABLE runs ADD COLUMN summary TEXT;
  `,
  6: `
    -- Publication of a succeeded live run (repositories.<repo>.publish): push the job branch,
    -- open a PR, comment on the issue. Kept apart from runs so it never changes a run's outcome.
    -- Each step's result is recorded as it completes; a retry resumes from what is recorded and
    -- re-checks GitHub before every write, so it never creates a duplicate.
    CREATE TABLE publications (
      run_id           TEXT    PRIMARY KEY REFERENCES runs (id),
      job_id           TEXT    NOT NULL,
      repo_id          INTEGER NOT NULL,
      repo_full_name   TEXT    NOT NULL,
      issue_number     INTEGER NOT NULL,
      mode             TEXT    NOT NULL CHECK (mode IN ('draft-pr','pr')),
      state            TEXT    NOT NULL CHECK (state IN ('publishing','published','failed','skipped')),
      branch           TEXT    NOT NULL,
      base_branch      TEXT,
      head_sha         TEXT,               -- commit pushed (or found already on the remote)
      pushed_at        TEXT,
      pr_number        INTEGER,
      pr_url           TEXT,
      comment_id       INTEGER,
      comment_url      TEXT,
      error            TEXT,               -- why it failed, or why it was skipped
      retryable        INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,               -- while state = 'publishing'
      next_attempt_at  TEXT,               -- automatic retry of a retryable failure
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      published_at     TEXT
    );
    CREATE INDEX publications_by_state ON publications (state, next_attempt_at);
  `,
  7: `
    -- The comment that tells an issue its live run failed (repositories.<repo>.commentOnFailure).
    -- One row per run that left its job failed; like publications, kept apart from runs so it
    -- never changes a run's outcome, with the same lease and attempt counter for retries.
    CREATE TABLE failure_comments (
      run_id           TEXT    PRIMARY KEY REFERENCES runs (id),
      job_id           TEXT    NOT NULL,
      repo_id          INTEGER NOT NULL,
      repo_full_name   TEXT    NOT NULL,
      issue_number     INTEGER NOT NULL,
      state            TEXT    NOT NULL CHECK (state IN ('posting','posted','failed','skipped')),
      comment_id       INTEGER,
      comment_url      TEXT,
      error            TEXT,               -- why it failed, or why it was skipped
      retryable        INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,               -- while state = 'posting'
      next_attempt_at  TEXT,               -- automatic retry of a retryable failure
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      posted_at        TEXT
    );
    CREATE INDEX failure_comments_by_state ON failure_comments (state, next_attempt_at);
  `,
  8: `
    -- Set by "updraft cancel" on a run that is claimed or executing. The CLI is not the worker
    -- process, so it only records the request; the worker stops the run and closes it with no
    -- outcome and its job 'canceled'. It is on the run, not the job, so a request can never
    -- carry over to a later attempt after "updraft retry".
    ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT;
    -- Dedupe keys of jobs deleted by "updraft clean --older-than". The poller re-reads the
    -- newest events of a repository on every scan (for a quiet repository, indefinitely), and
    -- only the jobs unique key stops such an event from being enqueued again. A deleted job
    -- leaves its key here, and commitPollBatch refuses any event listed.
    CREATE TABLE pruned_events (
      repo_id     INTEGER NOT NULL,
      workflow_id TEXT    NOT NULL,
      event_id    TEXT    NOT NULL,
      pruned_at   TEXT    NOT NULL,
      PRIMARY KEY (repo_id, workflow_id, event_id)
    ) WITHOUT ROWID;
  `,
  9: `
    -- A containerized live run (agents.<name>.container): the runtime client that started the
    -- container (an absolute path) and the container's name. Recorded before the container
    -- starts, so that a later worker on the same host can remove it after a crash. The config may
    -- have changed by then, which is why the runtime is recorded and not derived. NULL: the
    -- agent ran on the host.
    ALTER TABLE runs ADD COLUMN container_runtime TEXT;
    ALTER TABLE runs ADD COLUMN container_name TEXT;
  `,
  10: `
    -- The revision loop (repositories.<repo>.revise): a review that requests changes on a PR
    -- Updraft opened queues a revision job, an ordinary row in jobs whose envelope has type
    -- pull_request.changes_requested and whose event_id is "review:<review node id>".

    -- The PRs the loop watches: one row per PR of a published publication, copied here with what
    -- a revision job needs, so a PR stays watched after "updraft clean --older-than" deleted the
    -- job that opened it. 'closed' is final (closed or merged on GitHub, or no longer readable).
    CREATE TABLE revision_prs (
      repo_id                INTEGER NOT NULL,
      pr_number              INTEGER NOT NULL,
      pr_url                 TEXT    NOT NULL,
      source_run_id          TEXT    NOT NULL,   -- the run whose publication opened the PR
      original_event_id      TEXT    NOT NULL,   -- label event that queued that run's job
      workflow_id            TEXT    NOT NULL,
      issue_number           INTEGER NOT NULL,
      issue_title            TEXT    NOT NULL,
      issue_url              TEXT    NOT NULL,
      label                  TEXT    NOT NULL,
      labels                 TEXT    NOT NULL,   -- JSON array: the original job's labelsAtEnqueue
      action                 TEXT    NOT NULL,
      pool                   TEXT    NOT NULL,
      branch                 TEXT    NOT NULL,   -- the PR's head: the job branch that was pushed
      base_branch            TEXT,
      state                  TEXT    NOT NULL CHECK (state IN ('open','closed')),
      seen_updated_at        TEXT,               -- the PR's updated_at when its reviews were last read
      limit_reached_at       TEXT,               -- first change request refused by maxRevisions
      limit_comment_id       INTEGER,            -- the one comment that says so
      limit_comment_url      TEXT,
      limit_comment_attempts INTEGER NOT NULL DEFAULT 0,
      limit_comment_error    TEXT,
      created_at             TEXT    NOT NULL,
      updated_at             TEXT    NOT NULL,
      PRIMARY KEY (repo_id, pr_number)
    ) WITHOUT ROWID;

    -- Position in a repository's pull request listing (most recently updated first), like
    -- repo_checkpoints for issue events.
    CREATE TABLE review_checkpoints (
      repo_id         INTEGER PRIMARY KEY,
      etag            TEXT,                      -- ETag of page 1, for conditional polling
      last_updated_at TEXT,                      -- newest updated_at seen by the last committed scan
      updated_at      TEXT    NOT NULL
    );

    -- Every change request seen on a watched PR, by review id, with what was decided about it the
    -- first time it was seen. A review listed here is never evaluated again, across restarts,
    -- replays and pruning (rows are kept when their job is pruned; job_id then points nowhere).
    CREATE TABLE review_requests (
      repo_id      INTEGER NOT NULL,
      review_id    TEXT    NOT NULL,             -- GitHub node id of the review
      pr_number    INTEGER NOT NULL,
      reviewer     TEXT,
      trigger_kind TEXT    NOT NULL,             -- what kind of change request it is, e.g. changes_requested
      review_url   TEXT,
      submitted_at TEXT,
      state        TEXT    NOT NULL CHECK (state IN ('queued','over-limit','ignored','not-allowed')),
      reason       TEXT,                         -- why it was not queued
      job_id       TEXT,                         -- the revision job, when state = 'queued'
      created_at   TEXT    NOT NULL,
      PRIMARY KEY (repo_id, review_id)
    ) WITHOUT ROWID;
    CREATE INDEX review_requests_by_pr ON review_requests (repo_id, pr_number);

    -- The push and reply of one revision run; the counterpart of publications, with the same
    -- lease and attempt fence. base_sha is the remote head of the PR branch the run started
    -- from (the push fast-forwards from exactly that commit or not at all), head_sha what was
    -- pushed. moved = 1: the push was refused because the branch was no longer at base_sha.
    CREATE TABLE revisions (
      run_id           TEXT    PRIMARY KEY REFERENCES runs (id),
      job_id           TEXT    NOT NULL,
      repo_id          INTEGER NOT NULL,
      repo_full_name   TEXT    NOT NULL,
      issue_number     INTEGER NOT NULL,
      pr_number        INTEGER NOT NULL,
      review_id        TEXT    NOT NULL,
      trigger_kind     TEXT    NOT NULL,
      state            TEXT    NOT NULL CHECK (state IN ('publishing','published','failed','skipped')),
      branch           TEXT    NOT NULL,
      base_sha         TEXT,
      head_sha         TEXT,
      pushed_at        TEXT,
      moved            INTEGER NOT NULL DEFAULT 0,
      comment_id       INTEGER,
      comment_url      TEXT,
      error            TEXT,
      retryable        INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      next_attempt_at  TEXT,
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      published_at     TEXT
    );
    CREATE INDEX revisions_by_state ON revisions (state, next_attempt_at);
  `,
  11: `
    -- The review loop (repositories.<repo>.review, autoMerge): a reviewer run for every head
    -- commit of a PR Updraft opened. A reviewer run is an ordinary row in jobs whose envelope has
    -- type pull_request.review and whose event_id is "pr-review:<pr number>:<head sha>", so the
    -- jobs unique key (and pruned_events) gives one review per PR and head, across restarts.

    -- Where each watched PR stands. These live on the PR's row, not on a run, so they survive
    -- "updraft clean --older-than".
    ALTER TABLE revision_prs ADD COLUMN head_sha TEXT;               -- newest head commit the worker knows of
    ALTER TABLE revision_prs ADD COLUMN head_at TEXT;                -- when it learned of it (its own push, or a read of the PR)
    ALTER TABLE revision_prs ADD COLUMN author_agent TEXT;           -- agent of the PR's latest code run; not picked as reviewer
    ALTER TABLE revision_prs ADD COLUMN verdict TEXT;                -- newest recorded verdict: ready-to-merge | changes-requested
    ALTER TABLE revision_prs ADD COLUMN verdict_sha TEXT;            -- the head commit that verdict is for
    ALTER TABLE revision_prs ADD COLUMN verdict_run_id TEXT;
    ALTER TABLE revision_prs ADD COLUMN verdict_at TEXT;
    ALTER TABLE revision_prs ADD COLUMN ready_marked_at TEXT;        -- when the worker marked the draft ready for review
    -- Auto-merge of the head in merge_sha: waiting (for checks), merging (the request was sent),
    -- merged, or blocked (see merge_reason; final for that head). NULL: not looked at yet.
    ALTER TABLE revision_prs ADD COLUMN merge_state TEXT CHECK (merge_state IN ('waiting','merging','merged','blocked'));
    ALTER TABLE revision_prs ADD COLUMN merge_sha TEXT;
    ALTER TABLE revision_prs ADD COLUMN merge_reason TEXT;
    ALTER TABLE revision_prs ADD COLUMN merge_wait_started_at TEXT;
    ALTER TABLE revision_prs ADD COLUMN merge_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE revision_prs ADD COLUMN merged_at TEXT;
    ALTER TABLE revision_prs ADD COLUMN merge_commit_sha TEXT;
    ALTER TABLE revision_prs ADD COLUMN merge_comment_id INTEGER;    -- the one comment that says why it was not merged
    ALTER TABLE revision_prs ADD COLUMN merge_comment_url TEXT;
    ALTER TABLE revision_prs ADD COLUMN merge_comment_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE revision_prs ADD COLUMN merge_comment_error TEXT;

    -- PRs watched before this version: their head is what the worker last pushed to them.
    UPDATE revision_prs SET
      head_sha = (SELECT p.head_sha FROM publications p WHERE p.run_id = revision_prs.source_run_id),
      head_at = (SELECT p.pushed_at FROM publications p WHERE p.run_id = revision_prs.source_run_id),
      author_agent = (SELECT r.agent FROM runs r WHERE r.id = revision_prs.source_run_id);
    UPDATE revision_prs SET
      head_sha = (SELECT v.head_sha FROM revisions v WHERE v.repo_id = revision_prs.repo_id AND v.pr_number = revision_prs.pr_number
                    AND v.pushed_at IS NOT NULL AND v.head_sha IS NOT NULL ORDER BY v.pushed_at DESC LIMIT 1),
      head_at = (SELECT v.pushed_at FROM revisions v WHERE v.repo_id = revision_prs.repo_id AND v.pr_number = revision_prs.pr_number
                    AND v.pushed_at IS NOT NULL AND v.head_sha IS NOT NULL ORDER BY v.pushed_at DESC LIMIT 1),
      author_agent = coalesce((SELECT r.agent FROM revisions v JOIN runs r ON r.id = v.run_id WHERE v.repo_id = revision_prs.repo_id
                    AND v.pr_number = revision_prs.pr_number AND v.pushed_at IS NOT NULL AND v.head_sha IS NOT NULL
                    ORDER BY v.pushed_at DESC LIMIT 1), author_agent)
    WHERE EXISTS (SELECT 1 FROM revisions v WHERE v.repo_id = revision_prs.repo_id AND v.pr_number = revision_prs.pr_number
                    AND v.pushed_at IS NOT NULL AND v.head_sha IS NOT NULL);

    -- The verdict of one reviewer run and its posting as a COMMENT review on the PR; the
    -- counterpart of publications and revisions, with the same lease and attempt fence. The
    -- verdict is the worker's own record: GitHub only gets a comment for people to read.
    -- outcome is what the worker did with the verdict once the review was posted.
    CREATE TABLE pr_reviews (
      run_id           TEXT    PRIMARY KEY REFERENCES runs (id),
      job_id           TEXT    NOT NULL,
      repo_id          INTEGER NOT NULL,
      repo_full_name   TEXT    NOT NULL,
      issue_number     INTEGER NOT NULL,
      pr_number        INTEGER NOT NULL,
      head_sha         TEXT    NOT NULL,   -- the commit that was reviewed; the verdict is for it only
      agent            TEXT    NOT NULL,   -- the reviewing agent
      verdict          TEXT    NOT NULL CHECK (verdict IN ('ready-to-merge','changes-requested')),
      findings         TEXT    NOT NULL,
      state            TEXT    NOT NULL CHECK (state IN ('publishing','published','failed','skipped')),
      review_id        INTEGER,            -- the COMMENT review on GitHub
      review_url       TEXT,
      outcome          TEXT CHECK (outcome IN ('ready','revision-queued','over-limit','no-revise','stale','closed')),
      outcome_detail   TEXT,
      revision_job_id  TEXT,               -- the revision job a changes-requested verdict queued
      error            TEXT,
      retryable        INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      next_attempt_at  TEXT,
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      published_at     TEXT
    );
    CREATE INDEX pr_reviews_by_state ON pr_reviews (state, next_attempt_at);
    CREATE INDEX pr_reviews_by_pr ON pr_reviews (repo_id, pr_number, created_at);
  `,
  12: `
    -- Each repository's publish setting as the CLI last saw it, keyed by GitHub repo id. The config
    -- file has no history, so this records when publication was turned on (off -> draft-pr/pr);
    -- turning it off clears enabled_at, and switching between draft-pr and pr keeps it. The
    -- worker's startup sweep only publishes runs that ended at or after enabled_at.
    CREATE TABLE publish_settings (
      repo_id        INTEGER PRIMARY KEY,
      repo_full_name TEXT    NOT NULL,
      mode           TEXT    NOT NULL CHECK (mode IN ('none','draft-pr','pr')),
      enabled_at     TEXT,               -- NULL while mode = 'none'
      updated_at     TEXT    NOT NULL
    );
  `,
  13: (db) => {
    db.exec(`
      -- The operator rollup behind "updraft stats" (src/db/metrics.ts, docs/stats.md): one row per
      -- fact, appended in the transaction of the state change it describes and never updated.
      -- (kind, subject_id) is the idempotency key, so a replay, retry or restart records nothing
      -- twice. "updraft clean --older-than" never deletes these rows. Ids, numbers, timestamps,
      -- agent/pool names and fixed outcome codes only: no issue, review or findings text, no paths.
      CREATE TABLE metric_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        kind           TEXT    NOT NULL,   -- run.ended, job.finished, pr.opened, pr.merged, ... (MetricKind)
        subject_id     TEXT    NOT NULL,   -- what the fact is about: a run id, "<repo id>#<pr>", ...
        at             TEXT    NOT NULL,   -- when it happened; the --since window filters on this
        repo_id        INTEGER NOT NULL,
        repo_full_name TEXT,               -- OWNER/REPO when it happened, display only
        job_id         TEXT,
        job_kind       TEXT,               -- implement | revision | review
        pr_number      INTEGER,
        agent          TEXT,
        pool           TEXT,
        outcome        TEXT,               -- run outcome, job status, verdict, change request state, ...
        reason         TEXT,               -- a fixed code: verify result, merge block code, trigger kind
        start_at       TEXT,               -- start of the interval that ends at "at", when there is one
        wait_ms        INTEGER,            -- run.ended: queue wait of the job's first started run
        findings       INTEGER,            -- review.verdict: the reviewer's UPDRAFT-FINDINGS count
        backfilled     INTEGER NOT NULL DEFAULT 0,   -- 1: recorded by this migration from existing rows
        recorded_at    TEXT    NOT NULL,
        UNIQUE (kind, subject_id)
      );
      CREATE INDEX metric_events_by_kind_at ON metric_events (kind, at);
      CREATE INDEX metric_events_by_repo ON metric_events (repo_id, at);

      -- The reviewer's UPDRAFT-FINDINGS count of each verdict (telemetry; never part of the
      -- verdict). NULL: the line was missing, repeated or malformed, or the review predates it.
      ALTER TABLE pr_reviews ADD COLUMN findings_count INTEGER;

      -- When the run's agent process was spawned (setRunProcess with a pid). execution_started_at
      -- is earlier: it is set before the executor prepares the checkout, so a run that failed
      -- before its agent launched has it too. Agent run time and queue wait use this instead.
      -- Earlier runs: a recorded pid is the evidence that the agent launched, and
      -- execution_started_at is the closest time there is; runs without a pid stay NULL (unknown).
      ALTER TABLE runs ADD COLUMN agent_started_at TEXT;
      UPDATE runs SET agent_started_at = execution_started_at WHERE pid IS NOT NULL AND execution_started_at IS NOT NULL;

      -- How many times "updraft retry" requeued the job. A retry does not change attempts (only a
      -- claim does), so this tells apart two terminal states a job reached with no claim in
      -- between (canceled, retried, canceled again), which the job.finished fact is keyed on.
      ALTER TABLE jobs ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
    `);
    backfillMetrics(db);
  },
  14: `
    -- CLI-powered triage of ambiguous issues (docs/triage.md, src/triage). cache_key is a hash of
    -- the issue identity, its content revision, the triage agent and the policy version, so a
    -- restart or a repeated poll finds the earlier answer instead of spending subscription
    -- capacity again. A failed attempt is kept too (outcome 'failed', until expires_at) so a
    -- broken CLI is not retried on every poll. No issue text is stored: only the validated
    -- verdict (complexity, risk, confidence, a short explanation) or the failure reason.
    CREATE TABLE triage_cache (
      cache_key  TEXT PRIMARY KEY,
      outcome    TEXT NOT NULL CHECK (outcome IN ('ok','failed')),
      result     TEXT,               -- JSON verdict when outcome = 'ok'
      reason     TEXT,               -- why it failed, when outcome = 'failed'
      agent      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT                -- NULL: never expires (policy version change invalidates)
    ) WITHOUT ROWID;

    -- One row per triage CLI launch, for the per-hour frequency limit.
    CREATE TABLE triage_runs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      agent    TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE INDEX triage_runs_by_time ON triage_runs (started_at);
  `,
  15: `
    -- Subscription capacity and escalation (docs/capacity-and-escalation.md). A cooldown is a
    -- bounded pause of a capacity group (or of a profile with no group) after a recognized CLI
    -- usage-limit exit; it lives in the database so a restarted worker still honors it.
    CREATE TABLE capacity_cooldowns (
      scope      TEXT NOT NULL CHECK (scope IN ('group','agent')),
      name       TEXT NOT NULL,
      until      TEXT NOT NULL,
      reason     TEXT NOT NULL,
      stated     INTEGER NOT NULL DEFAULT 0,   -- 1: the CLI gave the retry-after; 0: the configured default
      job_id     TEXT,
      run_id     TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope, name)
    ) WITHOUT ROWID;

    -- Every cooldown, deferral, escalation and refusal, by job and run, so each is explainable.
    CREATE TABLE policy_events (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     TEXT NOT NULL,
      kind   TEXT NOT NULL,   -- cooldown | deferred | escalated | escalation-denied | exhausted
      job_id TEXT NOT NULL,
      run_id TEXT,
      detail TEXT NOT NULL
    );
    CREATE INDEX policy_events_by_job ON policy_events (job_id, id);

    ALTER TABLE jobs ADD COLUMN escalation_hops INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0;
  `,
  16: `
    -- Model-tier measurement (docs/stats.md). metric_events gains nullable columns for the routing
    -- decision and the run selection; every older row keeps NULL, which "updraft stats" reports
    -- as unknown. Codes, names, numbers and ids only: no prompt, issue text, account or path.
    ALTER TABLE metric_events ADD COLUMN tier           TEXT;     -- resolved tier: routine | standard | complex | high-risk
    ALTER TABLE metric_events ADD COLUMN requested_tier TEXT;     -- tier the router asked for (escalation: the tier left)
    ALTER TABLE metric_events ADD COLUMN risk           TEXT;     -- low | medium | high
    ALTER TABLE metric_events ADD COLUMN adapter        TEXT;
    ALTER TABLE metric_events ADD COLUMN model          TEXT;     -- as configured for the profile; never what the CLI reports
    ALTER TABLE metric_events ADD COLUMN effort         TEXT;
    ALTER TABLE metric_events ADD COLUMN model_source   TEXT;     -- configured | observed | unknown
    ALTER TABLE metric_events ADD COLUMN route_source   TEXT;     -- override | local-rule | cli-triage | fallback | legacy-label | default
    ALTER TABLE metric_events ADD COLUMN confidence     REAL;     -- classifier or triage confidence
    ALTER TABLE metric_events ADD COLUMN hops           INTEGER;  -- escalations the job had had when the fact happened
    ALTER TABLE metric_events ADD COLUMN retries        INTEGER;  -- "updraft retry" count of the job at that time
    ALTER TABLE metric_events ADD COLUMN head_sha       TEXT;     -- review.verdict, revision.pushed: the PR head commit
  `,
  17: `
    -- Waits on a pull request in another repository (repositories.<repo>.dependencies,
    -- docs/dependencies.md). One row per run that declared one with an UPDRAFT-WAITING-ON line;
    -- that run's job stays 'succeeded' and nothing of the run is published. The worker checks the
    -- pull request every checkIntervalMinutes and, once it is merged, queues a follow-up job of the
    -- same workflow on the same issue (event_id "dep:<run_id>"). Kept apart from runs, like
    -- publications, so it never changes a run's outcome. 'waiting' is the only state that is not final.
    -- IF NOT EXISTS: a database taken back to an older user_version by hand keeps its waits.
    CREATE TABLE IF NOT EXISTS dependency_waits (
      run_id                TEXT    PRIMARY KEY REFERENCES runs (id),
      job_id                TEXT    NOT NULL,
      repo_id               INTEGER NOT NULL,
      repo_full_name        TEXT    NOT NULL,
      issue_number          INTEGER NOT NULL,
      workflow_id           TEXT    NOT NULL,
      original_event_id     TEXT    NOT NULL,   -- label application the issue text is vouched for against
      waits                 INTEGER NOT NULL,   -- waits in this chain, this one included
      dep_repo              TEXT    NOT NULL,   -- OWNER/REPO as allowed by the config
      dep_repo_id           INTEGER,            -- its GitHub id, once read
      dep_number            INTEGER NOT NULL,
      dep_url               TEXT    NOT NULL,
      dep_title             TEXT,               -- as last read; untrusted text, never posted
      note                  TEXT    NOT NULL,   -- the run's final message before the line, capped; untrusted, never posted
      state                 TEXT    NOT NULL CHECK (state IN ('waiting','resumed','closed','canceled','expired')),
      reason                TEXT,               -- why the wait ended, in the worker's words
      checks                INTEGER NOT NULL DEFAULT 0,
      failures              INTEGER NOT NULL DEFAULT 0,   -- consecutive checks that could not read GitHub
      last_error            TEXT,
      last_checked_at       TEXT,
      next_check_at         TEXT    NOT NULL,
      merged_at             TEXT,
      merge_commit_sha      TEXT,
      resume_job_id         TEXT,               -- the follow-up job, when state = 'resumed'
      wait_comment_id       INTEGER,            -- "waiting on OWNER/REPO#N" on the issue
      wait_comment_url      TEXT,
      wait_comment_attempts INTEGER NOT NULL DEFAULT 0,
      wait_comment_error    TEXT,
      end_comment_id        INTEGER,            -- "stopped waiting" on the issue (closed unmerged, expired)
      end_comment_url       TEXT,
      end_comment_attempts  INTEGER NOT NULL DEFAULT 0,
      end_comment_error     TEXT,
      created_at            TEXT    NOT NULL,
      updated_at            TEXT    NOT NULL,
      ended_at              TEXT
    );
    CREATE INDEX IF NOT EXISTS dependency_waits_by_state ON dependency_waits (state, next_check_at);
    CREATE INDEX IF NOT EXISTS dependency_waits_by_job ON dependency_waits (job_id);
  `,
  // The CI step of the review loop (repositories.<repo>.ciFix, docs/ci-fix.md): what GitHub's
  // checks say about the head in ci_sha, once that head has a ready-to-merge verdict. On the PR's
  // row, like the merge, so it survives "updraft clean --older-than" and is merged with it.
  // ci_state: waiting (checks pending or not registered yet), passed (the applicable checks
  // hold), fixing (a failure queued the revision in ci_fix_job_id), blocked (a person has to act,
  // see ci_reason; final for that head); NULL: not looked at yet. Each column only if missing: a
  // database taken back to an older user_version by hand keeps them.
  18: (db) => {
    const have = new Set((db.prepare('PRAGMA table_info(revision_prs)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, decl] of CI_COLUMNS) if (!have.has(name)) db.exec(`ALTER TABLE revision_prs ADD COLUMN ${name} ${decl}`);
  },
  // The structured findings of Updraft's reviewer runs (src/agents/findings.ts), one row per
  // finding, and the review thread each one is discussed in. The posted text is never read back
  // to decide anything: the thread a finding has is the comment the worker itself posted with
  // the review (its own login, its review id, its marker), and its status is what the worker
  // recorded from the coding agent's report and the next reviewer's check.
  // thread_key: the finding whose thread this one is discussed in (itself, or the earlier
  // finding it repeats). status: open, verified (a later reviewer checked it is fixed) or
  // unresolved (a later reviewer found it is not). resolution*: the coding agent's report of
  // the revision that answered it, recorded after its push was confirmed: a claim, not a check.
  19: `
    CREATE TABLE IF NOT EXISTS review_findings (
      repo_id            INTEGER NOT NULL,
      pr_number          INTEGER NOT NULL,
      finding_key        TEXT    NOT NULL,   -- <run_id>#<finding id>
      run_id             TEXT    NOT NULL,   -- the reviewer run
      finding_id         TEXT    NOT NULL,
      head_sha           TEXT    NOT NULL,   -- the commit it was found on
      severity           TEXT    NOT NULL CHECK (severity IN ('blocker','suggestion')),
      title              TEXT    NOT NULL,
      problem            TEXT    NOT NULL,
      suggestion         TEXT,
      path               TEXT,
      line               INTEGER,
      thread_key         TEXT    NOT NULL,
      review_id          INTEGER,            -- GitHub's id of the review it was posted with
      comment_id         INTEGER,            -- the thread's first comment, when it is inline
      comment_url        TEXT,
      status             TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','verified','unresolved')),
      status_sha         TEXT,               -- the head the status is about
      status_note        TEXT,
      status_at          TEXT,               -- when the review behind the status was recorded: an older one never overwrites it
      resolution         TEXT    CHECK (resolution IN ('fixed','disagreed','deferred','unable','unreported')),
      resolution_note    TEXT,
      resolution_sha     TEXT,
      resolution_run_id  TEXT,
      thread_resolved_at TEXT,
      created_at         TEXT    NOT NULL,
      updated_at         TEXT    NOT NULL,
      PRIMARY KEY (repo_id, pr_number, finding_key)
    );
    CREATE INDEX IF NOT EXISTS review_findings_by_run ON review_findings (run_id);
  `,
  // Acceptance criteria (docs/acceptance.md): a verdict held back because mandatory criteria are
  // unverified or unclear, which a person has to resolve (no revision is queued), is the outcome
  // needs-verification. SQLite cannot change a CHECK in place, so pr_reviews is rebuilt from its
  // own definition with the one value added, keeping every column, row and index.
  20: (db) => rebuildWithOutcome(db, 'needs-verification'),
  // The suggestion step (repositories.<repo>.review.suggestions, docs/review-loop.md "Suggestions"):
  // what became of the reviewer's non-blocking suggestions on the head in suggest_sha, once that
  // head has a ready-to-merge verdict. suggest_state: fixing (the one suggestion revision of the
  // pull request, suggest_job_id, is on its way; checks and merge wait), settled (every open
  // suggestion was answered: fixed, declined or deferred to the follow-up issue); NULL: not looked
  // at yet. The follow-up issue spans heads: one per pull request. On review_findings, settled_as
  // says how a suggestion's thread was closed, so it is never answered twice. Each column only if
  // missing, as for migration 18.
  21: (db) => {
    const have = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    const prs = have('revision_prs');
    for (const [name, decl] of SUGGESTION_COLUMNS) if (!prs.has(name)) db.exec(`ALTER TABLE revision_prs ADD COLUMN ${name} ${decl}`);
    const findings = have('review_findings');
    for (const [name, decl] of SETTLED_COLUMNS) if (!findings.has(name)) db.exec(`ALTER TABLE review_findings ADD COLUMN ${name} ${decl}`);
  },
  // The CI step's one automatic re-run per head (docs/ci-fix.md, "One re-run"): the head whose
  // failed jobs were re-run, when, which checks and which files their logs named. And the code of
  // a merge block, so that a block on the checks can be picked up again when they pass on the
  // same head; blocks recorded before have it read from their reason. Each column only if missing.
  22: (db) => {
    const prs = new Set((db.prepare('PRAGMA table_info(revision_prs)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, decl] of RERUN_COLUMNS) if (!prs.has(name)) db.exec(`ALTER TABLE revision_prs ADD COLUMN ${name} ${decl}`);
    db.exec(`UPDATE revision_prs SET merge_code = ${mergeReasonCodeSql('merge_reason')} WHERE merge_state = 'blocked' AND merge_code IS NULL`);
  },
};

/** Migration 22's columns of revision_prs. */
const RERUN_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  // the head whose failed jobs the CI step re-ran, once (never again for that head)
  ['ci_rerun_sha', 'TEXT'],
  ['ci_rerun_at', 'TEXT'],
  // JSON arrays: the checks re-run, and the files their logs named (none of them in the diff)
  ['ci_rerun_checks', 'TEXT'],
  ['ci_rerun_files', 'TEXT'],
  // the MergeBlockCode of merge_state 'blocked'
  ['merge_code', 'TEXT'],
  // when a merge blocked on its checks was last looked at again
  ['merge_checked_at', 'TEXT'],
];

/** Migration 21's columns of revision_prs. */
const SUGGESTION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['suggest_state', "TEXT CHECK (suggest_state IN ('fixing','settled'))"],
  ['suggest_sha', 'TEXT'],
  ['suggest_reason', 'TEXT'],
  // the suggestion revision, once queued (one per pull request: its review id is suggestions:<pr>)
  ['suggest_job_id', 'TEXT'],
  // failed attempts to settle the head in suggest_sha; past the limit the head is settled anyway
  ['suggest_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  // the one follow-up issue of the pull request
  ['suggest_issue_number', 'INTEGER'],
  ['suggest_issue_url', 'TEXT'],
];

/** Migration 21's columns of review_findings. */
const SETTLED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['settled_as', "TEXT CHECK (settled_as IN ('fixed','declined','deferred'))"],
  ['settled_at', 'TEXT'],
  // the follow-up issue a deferred suggestion went into
  ['settled_issue', 'INTEGER'],
];

/** pr_reviews rebuilt with `value` allowed as an outcome; nothing when it already is. */
function rebuildWithOutcome(db: Db, value: string): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pr_reviews'").get() as { sql: string } | undefined;
  if (!table) return;
  const marker = "'no-revise',";
  if (table.sql.includes(`'${value}'`)) return;
  // A definition this migration does not know: stamping the version without the change would
  // leave a database that refuses the outcome while claiming to allow it.
  if (!table.sql.includes(marker)) throw new Error(`pr_reviews has an outcome constraint this migration does not recognize; cannot add '${value}'`);
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pr_reviews' AND sql IS NOT NULL").all() as { sql: string }[];
  const created = table.sql.replace(marker, `${marker}'${value}',`).replace(/^CREATE TABLE\s+("?)pr_reviews\1/i, 'CREATE TABLE pr_reviews_rebuilt');
  db.exec(created);
  db.exec('INSERT INTO pr_reviews_rebuilt SELECT * FROM pr_reviews');
  db.exec('DROP TABLE pr_reviews');
  db.exec('ALTER TABLE pr_reviews_rebuilt RENAME TO pr_reviews');
  for (const i of indexes) db.exec(i.sql);
}

/** Migration 18's columns of revision_prs. */
const CI_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['ci_state', "TEXT CHECK (ci_state IN ('waiting','passed','fixing','blocked'))"],
  ['ci_sha', 'TEXT'],
  ['ci_reason', 'TEXT'],
  ['ci_wait_started_at', 'TEXT'],
  ['ci_checked_at', 'TEXT'],
  // what failed on ci_sha, as a digest
  ['ci_signature', 'TEXT'],
  // the revision a failure on ci_sha queued
  ['ci_fix_job_id', 'TEXT'],
  // CI-fix revisions the PR was given
  ['ci_fixes', 'INTEGER NOT NULL DEFAULT 0'],
  // the failure the newest CI fix was for: the same one again is no progress
  ['ci_last_fix_signature', 'TEXT'],
  // the head the one CI comment on the PR is about (src/publish/ci.ts)
  ['ci_comment_sha', 'TEXT'],
  ['ci_comment_id', 'INTEGER'],
  ['ci_comment_url', 'TEXT'],
  ['ci_comment_attempts', 'INTEGER NOT NULL DEFAULT 0'],
];

/**
 * v4: derive jobs.start_failures from run history the way v3 computed the streak:
 * walk the job's runs after its retry floor, newest first, counting start_failed runs,
 * skipping runs closed without an outcome, and stopping at any other run.
 */
function backfillStartFailures(db: Db): void {
  const jobs = db.prepare("SELECT DISTINCT job_id FROM runs WHERE outcome = 'start_failed'").all() as { job_id: string }[];
  const floorOf = db.prepare('SELECT value FROM meta WHERE key = ?');
  const runsOf = db.prepare('SELECT outcome, ended_at FROM runs WHERE job_id = ? AND attempt > ? ORDER BY attempt DESC');
  const set = db.prepare('UPDATE jobs SET start_failures = ? WHERE id = ?');
  for (const { job_id } of jobs) {
    const floorRow = floorOf.get(`retry_floor:${job_id}`) as { value: string } | undefined;
    const floor = floorRow ? Number(floorRow.value) || 0 : 0;
    let count = 0;
    for (const r of runsOf.all(job_id, floor) as { outcome: RunOutcome | null; ended_at: string | null }[]) {
      if (r.outcome === 'start_failed') count++;
      else if (r.outcome === null && r.ended_at !== null) continue;
      else break;
    }
    if (count > 0) set.run(count, job_id);
  }
}

/** `migrateTo` stops at an older schema version; only migration tests should pass it. */
export function openDatabase(file: string, opts: { migrateTo?: number } = {}): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  try {
    migrate(db, opts.migrateTo);
  } catch (err) {
    // A refused database (newer schema, failed migration) must not stay open: on Windows an
    // open handle keeps the file, and its directory, from being moved or removed.
    db.close();
    throw err;
  }
  return db;
}

/**
 * Open an existing state database to look at it and nothing more: no migration, no switch to
 * WAL, no pragma that writes. For commands that must not change state as a side effect of
 * reading it. The caller checks {@link schemaVersion} before relying on a table.
 */
export function openDatabaseReadOnly(file: string): Db {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/**
 * Fold a database's write-ahead log into its main file, so that the one file is all of it. No
 * migration and no change to what the database holds. For `updraft state merge`.
 */
export function foldWriteAheadLog(file: string): void {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    db.close();
  }
}

/** The schema version a state database is at (PRAGMA user_version). */
export function schemaVersion(db: Db): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** The schema version that added the publications table. */
export const PUBLICATIONS_SCHEMA_VERSION = 6;

/** Apply pending migrations up to `target` (default: the current schema). Exported for migration tests. */
export function migrate(db: Db, target = SCHEMA_VERSION): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`state database schema v${current} is newer than this CLI supports (v${SCHEMA_VERSION})`);
  }
  for (let v = current + 1; v <= target; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`missing migration ${v}`);
    transaction(db, () => {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${v}`);
    });
  }
}

/** Open transactions per database, so a nested transaction() is a savepoint of the outer one. */
const depth = new WeakMap<Db, number>();

/**
 * Run fn inside BEGIN IMMEDIATE so writers serialize. Rolls back and rethrows on error. Nested
 * inside another transaction() on the same database, it is a savepoint: its changes commit or
 * roll back with the outer transaction, and an error rolls back only what it did.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const name = `updraft_sp_${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    depth.set(db, level);
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (err) {
    depth.set(db, level);
    try {
      db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    } catch {
      // ignore rollback failure; surface the original error
    }
    throw err;
  }
}

export function recordError(
  db: Db,
  e: { scope: string; message: string; repoFullName?: string | null; jobId?: string | null; at?: string },
): void {
  db.prepare('INSERT INTO errors (at, scope, repo_full_name, job_id, message) VALUES (?, ?, ?, ?, ?)').run(
    e.at ?? new Date().toISOString(),
    e.scope,
    e.repoFullName ?? null,
    e.jobId ?? null,
    e.message,
  );
}

// ---------------------------------------------------------------------------
// Row mappers shared by the ingest (poller) and queue (worker) modules.
// ---------------------------------------------------------------------------

export interface JobRow {
  id: string;
  repo_id: number;
  repo_full_name: string;
  workflow_id: string;
  event_id: string;
  issue_number: number;
  action: string;
  pool: string;
  envelope: string;
  status: JobStatus;
  status_reason: string | null;
  attempts: number;
  start_failures: number;
  escalation_hops: number;
  deferrals: number;
  created_at: string;
  updated_at: string;
}

export function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    repoId: r.repo_id,
    repoFullName: r.repo_full_name,
    workflowId: r.workflow_id,
    eventId: r.event_id,
    issueNumber: r.issue_number,
    action: r.action,
    pool: r.pool,
    envelope: JSON.parse(r.envelope) as EventEnvelope,
    status: r.status,
    statusReason: r.status_reason,
    attempts: r.attempts,
    startFailures: r.start_failures,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface RunRow {
  id: string;
  job_id: string;
  attempt: number;
  pool: string;
  agent: string;
  checkout_path: string | null;
  log_path: string | null;
  worker_id: string;
  hostname: string | null;
  pid: number | null;
  pid_start_time: string | null;
  lease_expires_at: string;
  started_at: string;
  execution_started_at: string | null;
  ended_at: string | null;
  outcome: RunOutcome | null;
  error: string | null;
  summary: string | null;
  cancel_requested_at: string | null;
  container_runtime: string | null;
  container_name: string | null;
}

function parseSummary(json: string | null): RunSummary | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RunSummary;
  } catch {
    return null;
  }
}

export function rowToRun(r: RunRow): Run {
  return {
    id: r.id,
    jobId: r.job_id,
    attempt: r.attempt,
    pool: r.pool,
    agent: r.agent,
    checkoutPath: r.checkout_path,
    logPath: r.log_path,
    workerId: r.worker_id,
    hostname: r.hostname,
    pid: r.pid,
    pidStartTime: r.pid_start_time,
    leaseExpiresAt: r.lease_expires_at,
    startedAt: r.started_at,
    executionStartedAt: r.execution_started_at,
    endedAt: r.ended_at,
    outcome: r.outcome,
    error: r.error,
    summary: parseSummary(r.summary),
    cancelRequestedAt: r.cancel_requested_at,
    container: r.container_runtime && r.container_name ? { runtime: r.container_runtime, name: r.container_name } : null,
  };
}
