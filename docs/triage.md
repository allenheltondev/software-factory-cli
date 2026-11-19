# CLI triage of ambiguous issues

Opt-in, on top of [tier routing](tier-routing.md). When the local heuristics are unsure about an
issue, Updraft can ask an **installed, signed-in coding CLI** (Claude Code, Codex or Kiro) to
classify it once. It never calls a model API, never uses an SDK or a third-party inference
service, and needs no new credential: it launches the same CLI you already use for live runs, under
that CLI's own login.

Without a `tiers.triage` block nothing changes, and nothing is classified by a model.

```yaml
agents:
  claude-triage:
    adapter: claude
    model: haiku              # a cheap model on your plan; see "Choosing a profile"
pools: { ... }
repositories:
  owner/repo:
    workflows:
      - trigger: { event: issue.labeled, label: updraft:ready }
        action: implement-issue
        pool: standard
        tiers:
          pools: { routine: fast, standard: standard, complex: deep }
          highRisk: { pool: safe }
          triage:
            agent: claude-triage        # required: an entry of `agents`
            # all optional, defaults shown
            enabled: true               # false: opt this workflow out without deleting the block
            onLowConfidence: true       # triage when the local confidence is below tiers.minConfidence
            requestLabel: triage:requested   # a label that asks for triage explicitly
            timeoutSeconds: 120
            maxOutputBytes: 65536       # largest accepted reply
            maxRetries: 1               # extra launches after an unreadable reply (max 2)
            maxPerHour: 20              # launches per hour, all repositories together
            failureCooldownMinutes: 60  # no relaunch for an issue revision that just failed
```

## When it runs

Only for work the local router would send down its heuristic rule:

- The classifier's confidence is below `tiers.minConfidence` (and `onLowConfidence` is on), or the
  issue carries `requestLabel`.
- Never when a tier override label or a legacy `pool.rules` match already decided: labels and
  configuration win, even if triage is requested.
- Never when the local result is already `high-risk`: triage can only raise a tier, and that is the
  top one, so it would spend usage for nothing.
- Never for every issue: confident local results are used as they are.

The decision is made once, at enqueue, like every routing decision, and stored on the job.

## What the agent sees and must answer

The prompt (on stdin, never in arguments, never logged or stored) holds the issue title (300
characters), body (6000), up to 20 labels (60 characters each), the repository name, the workflow's
action and the local classifier's fixed signal names. Each issue field is embedded as a JSON string,
and the prompt says the issue is untrusted data. The CLI starts in an empty temporary directory,
not in your checkout.

The agent must reply with one JSON object and no other keys:

```json
{"complexity": "routine|standard|complex", "risk": "low|medium|high", "confidence": 0.8,
 "explanation": "one or two sentences", "evidence": ["optional", "at most 5"]}
```

A reply with prose around the JSON (one fenced block is tolerated), extra keys (for example a
claimed `tier` or `pool`), a wrong value, or more than `maxOutputBytes` is rejected whole.

## Policy: the agent can raise a tier, never lower a floor

- A verdict of `risk: high` selects the high-risk tier. A verdict below `tiers.minConfidence` means
  `standard`.
- The **floor** is what local policy already requires: `high-risk` when the local classifier saw
  high-risk wording or labels, and the local complexity when the local classifier was confident.
  The final tier is the higher of the verdict and the floor. When the verdict was lower, the
  decision records `triage said X but local policy requires at least Y`.
- With low local confidence there is no floor, so a confident verdict may choose `routine`.
- Labels and configuration are never consulted by the agent and cannot be overridden by it.

## When triage cannot answer

The CLI is missing or not signed in, out of usage, returns an error, times out, prints an
unreadable or oversized reply, or the hourly limit is reached. The job is routed to `standard`, or
to the higher tier local policy already requires, and the reason is recorded. There is no
recursion: triage never queues work or triages itself.

## Limits and caching

- One launch has `timeoutSeconds`; the process tree is killed at the limit. A timeout or a CLI
  failure is not retried. An unreadable reply is retried up to `maxRetries` times.
- At most `maxPerHour` launches per hour (counted in the state database, so restarts do not reset
  it). A refused launch is not cached; the next poll tries again once the hour has room.
- Each answer is cached in the state database by repository, issue number, a hash of the title,
  body and labels, the agent profile (adapter, command, effective arguments) and a policy version.
  Polling, a worker restart, or two jobs for one issue revision reuse it without launching. Editing
  the issue or changing a label, or switching the profile, asks again. A **failed** triage is
  cached for `failureCooldownMinutes`, so a broken CLI is not launched on every poll.
- Concurrent requests for one issue revision share a single launch.
- The cache stores the verdict (including its short explanation) or the failure reason, never the
  issue text.

## Visibility

`updraft status` shows, under each job, for example:

```
routing: tier routine, risk low, rule triage, triage cli (claude-triage), pool fast
routing: tier standard, risk low, rule heuristic, triage unavailable (claude-triage: triage timed out after 120s), standard used
```

`origin` is `cli` (a launch answered), `cache` (an earlier answer was reused) or `fallback`. The
worker log has an `issue triaged` line with the agent, origin, verdict or failure reason, and tier.
Neither shows the prompt or the issue text.

## Confinement per adapter

Triage never uses the profile's write-capable flags. The adapter builds its own invocation and
**refuses** permission, sandbox, tool or output-mode settings in `agents.<name>.args` (validation
reports it, and a triage run would fail with the reason).

| Adapter | Invocation | Guarantee |
|---|---|---|
| Claude Code | `-p --output-format stream-json --verbose --tools "" --permission-mode default --no-session-persistence` | **No tools**: every built-in tool is off, so nothing can read or write files or run commands. |
| Codex | `exec --json --sandbox read-only --skip-git-repo-check --ephemeral` | **Read-only**, not no-tools. The sandbox blocks writes, but Codex has no switch to remove its tools, so the model could read files its sandbox can see. The run starts in an empty directory. |
| Kiro | `chat --no-interactive --v3 --trust-tools=` | **Best effort.** An empty trust list trusts no tool and a headless run cannot answer an approval prompt, but Kiro does not document that read-only tools need approval. The run starts in an empty directory. Validation warns about this. |

Codex and Kiro do not guarantee a read-only, no-tools run. If that matters, use a Claude Code
profile for triage. The CLI inherits the worker's environment, as live runs do. Do not set
`triage.agent` to an agent that has a `container`: triage launches the CLI on the host.

## Choosing a profile and the subscription tradeoff

Triage uses **your subscription's usage**: each launch is one short prompt on the profile's plan,
and counts against the same limits as your coding runs. Pick a cheap, fast model with a dedicated
entry in `agents` (see [agent profiles](agents/profiles.md)), for example `model: haiku` for Claude
Code, and keep it out of the pools that run code. The default of 20 launches per hour, the cache,
and the failure cooldown bound the cost; lower `maxPerHour` to tighten it.

To turn triage off: delete `tiers.triage`, set `tiers.triage.enabled: false` for one workflow, or
set `onLowConfidence: false` to keep only label-requested triage. Remove the `requestLabel` from
issues (or never create it) to stop explicit requests.
