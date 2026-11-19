# Tier routing

Opt-in routing of issues to capability-tier pools (for example a cheap pool for typo fixes and a
deep pool for migrations). The classifier is local and deterministic: **no model call, no tokens,
no API key, no network**. It is a routing hint, not a quality guarantee.

Without `tiers` on a workflow nothing changes: `workflow.pool` routes exactly as before.

```yaml
pools:
  fast: { agents: [claude-fast] }
  standard: { agents: [claude-standard] }
  deep: { agents: [claude-deep] }
  safe: { agents: [codex-deep, claude-deep] }
repositories:
  owner/repo:
    id: 123
    publish: pr
    review: true            # required when tiers.highRisk is set
    workflows:
      - trigger: { event: issue.labeled, label: updraft:ready }
        action: implement-issue
        pool: standard      # still required; used by legacy rules / as the non-tiered default
        tiers:
          pools: { routine: fast, standard: standard, complex: deep }
          highRisk: { pool: safe }          # optional; absent means high-risk work is held
          overrideLabels: { complex: needs-deep }   # optional; defaults tier:routine|standard|complex|high-risk
          minConfidence: 0.6                # optional
```

## Precedence (highest first)

1. **Legacy `pool.rules`**: a `hasLabel` rule that matches the issue's labels wins, as before.
2. **Override label** on the issue (`tier:routine`, `tier:standard`, `tier:complex`, `tier:high-risk`,
   or your `overrideLabels`). Labels need triage access to set, so they are user-controlled. If
   several are present the most capable tier wins. An override also beats the high-risk floor:
   a human decided.
3. **Heuristic classifier** over the issue title, body and labels.

Issue *text* never configures anything. Lines like `tier: routine` or "use pool fast" in a body are
only words for the classifier, and the classifier can raise but not lower an issue's tier on such
claims: any high-risk wording makes it high-risk whatever else the text says.

## Heuristics

| Result | Signals |
|---|---|
| `routine` | typo, docs, README, spelling, comments, changelog, "add a test"; labels `documentation`, `docs`, `typo`; body under 1500 characters |
| `standard` | default; also routine signals mixed with complex ones, or a long body |
| `complex` | migration, concurrency/race/deadlock, lifecycle, cross-component, state machine, architecture/redesign/rewrite, breaking change; labels `architecture`, `migration`, `epic` |
| risk `high` | auth/permissions/access control, secrets/credentials/tokens/passwords/encryption, security/vulnerability/injection, data loss/destructive/purge; labels `security`, `vulnerability`, `auth`, `data-loss` |

Risk `medium` is complex work with no high-risk signal; otherwise `low`. High risk selects the
`highRisk` pool regardless of complexity. If confidence in the complexity is below `minConfidence`
(default 0.6) the choice is `standard`; that never lowers a high-risk result.

## High-risk policy

- `tiers.highRisk.pool` is the minimum capability pool. Config validation requires
  `repositories.<repo>.review` enabled with `allowSameAgent: false` when it is set, so high-risk
  work is reviewed by a different agent.
- If no `highRisk` pool is configured, or its pool has no enabled agent, the job is **not** run on
  a weaker pool. It is recorded as `canceled` with the reason `needs human: ...`, visible in
  `updraft status` and the worker log.

## Stability and recomputation

The decision is made once, when the job is enqueued, and stored in the job (so it survives
restarts). It is not recomputed when the issue is edited later, nor on `updraft retry`, which requeues the same job with its stored decision. A held job cannot be retried (that would run it on an ineligible pool).
A new decision happens when a new trigger label application creates a new job.

## CLI triage (optional)

For issues the heuristics are unsure about, `tiers.triage` can ask an installed, signed-in coding
CLI to classify them, under its subscription and without any model API. It is off unless
configured, never overrides a label or a high-risk floor, and falls back to `standard` when it
cannot answer. See [triage.md](triage.md). Its decisions appear as rule `triage` (or `heuristic`
with a fallback note).

## Correcting a decision

Add an override label (e.g. `tier:complex`) and remove and re-apply the trigger label to queue a
new job, or cancel the held/misrouted job first. To stop using heuristics, remove `tiers`.

## Observability

`updraft status` prints `routing: tier <t>, risk <r>, rule <rule>, pool <pool>` under each job with
a recorded decision, and the worker's `job queued` log line carries `tier`, `risk`, `rule` and
`pool`. Rules are `legacy-label`, `override-label`, `heuristic` and `triage`.
