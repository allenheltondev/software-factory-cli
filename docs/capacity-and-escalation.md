# Capacity groups, usage-limit cooldowns and escalation

Two opt-in policies, both off unless configured. Without `capacity` and `tiers.escalation`, runs,
pools and concurrency limits behave exactly as before. Neither calls a model API: Updraft only
launches the signed-in CLIs you already configured, and never tries to get around a usage limit.

## Subscription capacity groups

Several profiles (`claude-fast`, `claude-deep`, ...) can run under one authenticated CLI account.
Updraft does not infer that from credentials, environment or usernames; you declare it:

```yaml
capacity:
  groups:
    claude-account: { maxConcurrent: 2, defaultCooldownMinutes: 60, maxCooldownMinutes: 360 }
  defaultCooldownMinutes: 60   # for a profile with no group
  maxCooldownMinutes: 360
  maxDeferrals: 5              # usage-limit requeues one job may get before it fails
agents:
  claude-fast: { adapter: claude, model: haiku, capacityGroup: claude-account }
  claude-deep: { adapter: claude, model: opus, capacityGroup: claude-account }
  codex-deep: {}
```

- Runs of all profiles in a group together never exceed the group's `maxConcurrent`, on top of each
  profile's own `maxConcurrent` and the global `maxConcurrent`. A job that cannot start because of
  a group limit or cooldown stays `queued` with `status_reason` `waiting: ...` naming why.
- A profile without a group is its own scope for cooldowns.

## Usage-limit cooldowns

When an agent CLI **exits unsuccessfully** and its own output matches a known usage/rate-limit
message, the affected group (or ungrouped profile) goes into a cooldown, the failed run is
recorded as an ordinary `failed` run whose error says so, and the job returns to the queue.

- The wait is the CLI's stated retry-after when it gave one plainly (`Retry-After: <s>`, "try
  again in 2 hours 30 minutes", Claude's `limit reached|<epoch>`), capped at `maxCooldownMinutes`;
  otherwise `defaultCooldownMinutes`. Vague text such as "resets 3pm" is not trusted as a time.
- Cooldowns are stored in the state database, so a restarted worker honors them. They expire on
  their own; the next claim after expiry runs the job (no manual step).
- A job is requeued at most `maxDeferrals` times for usage limits, then it fails (no retry storm).
- Authentication failures ("not logged in", 401, invalid key) and any unrecognized error are **not**
  quota exhaustion: they are ordinary failures, unchanged.
- A user `updraft cancel` always wins over requeueing.

### Fallback

Fallback is the pool you already wrote: while one group cools down, the next agent in the **same
pool** that is not cooling down (for example `codex-deep` beside the Claude profiles) takes the
job. Updraft never moves a job to another pool because of a limit, so a high-risk job is never
silently downgraded, never crosses a provider you did not put in its pool, and never starts an
API-billed call. If no eligible agent exists the job waits (visible in `status`) until a cooldown
ends.

### CLI differences (best-effort classification)

Detection is phrase matching on what each CLI prints; it can change between CLI versions, and a
miss only means the failure is handled as before. Known today: Codex ("You've hit your usage
limit ... try again in ..."), Claude Code ("usage limit reached", "5-hour limit reached", `limit
reached|<epoch>`, JSON `is_error` results), Kiro (rate/quota/monthly request limit, HTTP 429).
Only Codex and the legacy Claude form state a reliable wait; the rest use the default cooldown.

## Escalation

Some issues are underestimated. A workflow with tier routing can allow bounded escalation:

```yaml
tiers:
  pools: { routine: fast, standard: standard, complex: deep }
  escalation: { maxHops: 1, ceiling: complex, onVerificationFailure: true, allowAgentRequests: true }
```

An agent can only *request* it by printing one line (job runs only; reviewer and revision jobs
never escalate):

```
updraft-escalation: {"reason":"migration-risk","requestedTier":"complex","evidence":"needs a schema migration"}
```

The request is schema-validated (`reason`, `requestedTier`, `evidence`; no pool, agent or command
can be named). A separate worker policy decides: the target is clamped to `ceiling`, must be
stronger than the current tier, within `maxHops`, with a configured pool that has an enabled
agent. `high-risk` needs both `ceiling: high-risk` and `tiers.highRisk`. Nothing lowers a tier.

- **Pre-edit deferral:** a run that exits cleanly with the request and **no commits** is closed as
  failed (`escalated ...`) and the job is requeued on the stronger pool. A request after commits
  exist is refused.
- **After a failed verification** (when `onVerificationFailure`): one tier up, without a request.
- Ordinary failures are not escalations. Each escalation is a new run/attempt of the **same job**
  on a new branch and worktree (`-<attempt>` suffix), started only after the earlier run ended, so
  two mutating workers never share a worktree. Earlier attempts stay for inspection.
- `jobs.pool` is updated to the stronger pool; `updraft retry` reuses it.

## Explaining decisions

`updraft status` shows active cooldowns with their wake-up time and source, `waiting:` reasons on
queued jobs, and "Recent capacity and escalation decisions": every cooldown, deferral, escalation,
refusal and exhausted cap by job and run (stored in `policy_events`). The worker log has a
`failure policy applied` line per run.
