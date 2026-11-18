# Updraft CLI design

**Status** Original design. The CLI parts are implemented; see the note below.  
**Pilot repository** `allenheltondev/kids-and-dragons`  
**Scope** A local CLI for GitHub-triggered work and a ChatGPT task for PR review.  
**Platforms** Windows, macOS, and Linux. Windows is the first pilot environment.

> **Implementation status.** This is the design the CLI was built from, kept for its
> reasoning. It is not updated as the tool changes. Current behavior is documented in the
> [README](../README.md), [worktrees.md](worktrees.md),
> [live-execution.md](live-execution.md), the agent pages
> ([Claude Code](agents/claude.md), [Codex](agents/codex.md), [Kiro](agents/kiro.md)),
> [publication.md](publication.md), [security.md](security.md) and
> [background-operation.md](background-operation.md).
>
> Implemented: repository discovery and configuration (§2), the background launchers (§2),
> issue-event polling, the durable queue and its persistence (§3), routing, per-job branches
> and worktrees, live execution through the Claude Code, Codex and Kiro adapters (§4),
> and opt-in publication of a job branch as a pull request (§7). Build steps 1 and 2 of §6
> are done.
>
> Not implemented: PR revision polling (§3, "PR revisions") and anything else the CLI would
> need to host or consume reviews. The ChatGPT review task (§5) is separate from the CLI.
>
> Where the text below differs from the tool:
>
> - The default trigger label is `ready`, not `updraft:ready`.
> - The example config omits the required `repositories.<OWNER/REPO>.id` and the
>   `execution`, `dispatch` and per-repository checkout and publication settings added
>   since. Use [examples/config.yaml](../examples/config.yaml) instead.
> - The command table in §2 lists the first commands only. The README has the current set.
> - §4 calls for an explicit tool-permission profile and a limited environment per runner.
>   What shipped: each adapter runs its agent in full-auto by default, as the user running
>   the worker, with the worker's environment minus `GH_TOKEN` and `GITHUB_TOKEN`. A narrower
>   profile is set per agent in `agents.<name>.args`. There is no sandbox.

## 1. User workflow

1. Install the TypeScript CLI as an npm package and sign in to GitHub with `gh`.
2. Run `updraft configure`. Search and select repositories available to the active GitHub account. Choose which actions run in each repo, the labels that trigger them, and the eligible agents.
3. Start the worker in a terminal with `updraft start`. Use the operating system's background runner to start the same command at login. On a Linux host without systemd, run it under the process supervisor the host already uses.
4. Add the configured dispatch label to an issue. Updraft queues an implementation job, selects an eligible agent and gives it an isolated checkout.
5. Open the resulting PR. The ChatGPT task reviews it on open and after new commits. The review identifies the exact revision, reports blockers, and follows up on previous findings. A person can hand feedback back to the implementer and push a revision.

`updraft:ready` is an example label. The CLI is reusable across repos. (This design was written when the project was called software-factory-cli and its command `factory`; it is published as `@allenheltondev/updraft`.)

## 2. Configuration and discovery

`updraft configure` uses the active `gh` account and paginates `GET /user/repos`. The searchable multi-select includes repositories the account owns, collaborates on, or can access through an organization. It preselects watched repos. `updraft add OWNER/REPO` handles scripted setup and accessible public repos outside the picker. Verify repository access when saving a selection, and use the repository's stable GitHub ID for persisted state. Fetch each selected repository's GitHub labels for the issue-trigger and routing pickers.

Save a versioned local config. Validate referenced actions, pools, agents, limits, and repo checkout settings before writing. Show which repos and actions were added or removed. Start new subscriptions at the current state with an explicit backfill option. The startup command is non-interactive and uses the saved config. The pilot can use a 60-second poll interval, adjustable globally. Apply config changes when the worker restarts.

Useful commands for the first release:

| Command | Behavior |
| --- | --- |
| `updraft configure` | Select repos, triggers, actions and pools interactively |
| `updraft add OWNER/REPO` | Add a repo by name |
| `updraft start` | Poll GitHub and execute jobs |
| `updraft status` | Show watched repos, agent availability, queue state and recent errors |
| `updraft doctor` | Check paths, Git and GitHub access, enabled agent commands, and authentication in the current environment |
| `updraft retry JOB_ID` | Requeue a failed or interrupted job deliberately |

### Background operation

Publish one npm package with the same `updraft` commands and YAML schema across platforms. Installing the package makes the CLI available to the user. Background startup is configured separately so users can choose when it starts. Ship example launcher definitions that invoke `updraft start`.

| Environment | Background runner |
| --- | --- |
| Windows | Task Scheduler task at login, under the developer's account. Use fully qualified executable paths, restart on failure, ignore overlapping launches, and remove the default runtime limit. |
| macOS | A per-user `launchd` LaunchAgent with explicit program arguments and log paths. |
| Linux with systemd | A `systemd --user` service with restart on failure. Enable lingering if the machine needs to run jobs before login or after logout. |
| Other Linux hosts | Run `updraft start` in the foreground under the host's existing process supervisor. |

Launchers specify the executable, config path, working directory, and environment they need. Test `updraft doctor` under the same account and environment as the launcher, since a background process may get a different PATH and credential context from a terminal. Keep config, queue and logs in per-user locations resolved for the host OS, with a config path override. The worker resumes polling from saved checkpoints after sleep or restart.

On Windows, use one execution environment for the worker, checkout and agents. Prefer the native Windows setup for Windows-hosted repos. WSL2 can run the Linux setup when repos and tooling already live there or a runner needs Linux-native tools. In that case, keep the relevant binaries, credentials and worktrees inside WSL.

### Example config

```yaml
version: 1
pollIntervalSeconds: 60
maxConcurrent: 2

agents:
  codex:
    maxConcurrent: 1
  claude:
    maxConcurrent: 1
  kiro:
    maxConcurrent: 1

pools:
  art:
    agents: [codex]
  general:
    agents: [claude, kiro]
    strategy: round-robin

actions:
  implement-issue:
    prompt: ./prompts/implement-issue.md
    output: local-branch

repositories:
  allenheltondev/kids-and-dragons:
    workflows:
      - trigger:
          event: issue.labeled
          label: "updraft:ready"
        action: implement-issue
        pool:
          rules:
            - hasLabel: art
              use: art
          default: general
```

## 3. GitHub events and queue

### Issue dispatch

Poll the repository's issue events endpoint for actual `labeled` events. Filter out PRs, which also appear in GitHub's Issues API. Match the label added by the event and fetch the issue's current state before enqueueing. The issue must be open and still carry the dispatch label. This lets removing the label cancel pending work. Evaluate routing rules once at enqueue time using the fetched label set, then persist the chosen pool. Adding `art` alone leaves the queue unchanged. Reapplying the dispatch label generates a new event and allows a fresh route.

Deduplicate by repository ID, workflow ID and GitHub event ID. Persist the event checkpoint and inserted jobs in one transaction so a crash can safely replay the last batch. Page through the backlog and process unseen matching events from oldest to newest. Verify the issue-event endpoint's actual ordering and pagination during implementation before using an early-stop watermark. On API errors, retain the last confirmed checkpoint and retry with backoff. Mark a queued job canceled if the issue closes or loses its dispatch label before the worker claims it. Keep concurrent runs for the same repo and issue at one.

### PR revisions

ChatGPT receives PR events from GitHub directly during the pilot. If the CLI later hosts the review, poll PRs for `headRefOid`, compare the current head with the last reviewed head, and queue one job per repo, PR and head SHA. Coalesce pending pushes to the newest revision for that PR. Hold the checked-out SHA fixed during a run and include the actual SHA in the review result. A webhook relay could feed these same events later if push latency becomes important.

### Persistence

Use SQLite for queue state, checkpoints, leases and run history. Keep the JSON event envelope independent of how events arrive. Include schema version, event type, repo ID and full name, issue or PR number, event ID or SHA, and a link. Store the run separately with its pool, chosen agent, checkout path, attempts, outcome and log location.

Claim jobs atomically. If the daemon stops during a run, reconcile the lease and worker process before releasing the slot. Record interrupted runs with their checkout and logs so the user can decide whether to resume or retry. Use stable run identifiers in any later GitHub write step and check for an existing branch or PR before retrying publication.

## 4. Agent routing and execution

The first matching rule wins. A job with `art` uses the Codex-only pool. General work uses Claude Code or Kiro. Round-robin rotates among eligible workers with available capacity. If all eligible workers are busy, the job waits. Per-agent limits apply across pools and repos. A global limit keeps the pilot to two simultaneous workers.

Each action owns its prompt and expected output. Each agent adapter owns its command, arguments and headless authentication. Use `codex exec`, `claude -p`, and Kiro's `--no-interactive` mode. Kiro needs `KIRO_API_KEY` in its runtime environment. Verify binary availability and authentication for enabled agents under the same user and environment as the background launcher. Check each adapter's supported OS and architecture independently of CLI support. Use direct executables or verified Node entry points where possible, with a dedicated Windows launcher for any supported command shim. Pass issue context through stdin or a prompt file so it stays out of shell command strings. Use platform-native path handling and verify that the worker can stop and reap agent subprocesses consistently.

For an implementation job, create a per-job branch and Git worktree from the repository's configured base branch. Keep logs with the run. Treat issue text and PR content as untrusted inputs. A worktree separates changes between jobs. The runner still needs an explicit tool-permission profile and a limited environment when it executes repository code. Verify isolation per adapter and OS. For example, Claude Code's native Windows setup currently lacks its built-in command sandbox. Use WSL2 or another isolation boundary for that adapter when the action requires sandboxed execution. Keep repository write authority with the CLI's publication step if automated publishing is enabled.

If an adapter cannot start, release the slot and try another eligible agent. Once the agent starts working, record its outcome with the checkout intact. A failed partial run stays visible for inspection and explicit retry.

## 5. ChatGPT PR review

Create a dedicated Kids and Dragons review chat and configure a GitHub event-triggered task there. Subscribe to PR opens and commit updates. Review the current open PR head, read the linked issue and prior findings, check whether each previous finding was addressed, and report actionable regressions with file and line references. Record the PR URL, reviewed SHA and whether blockers remain. Group events by PR if ChatGPT batches pushes.

**Pilot status** GitHub repository read access was confirmed. Two task creation attempts returned a webhook connector validation error. The task is pending setup from the signed-in ChatGPT session. Validate both paths with a test PR: receive the initial review, push a fix, and receive a second review tied to the new SHA. Confirm whether the second run has access to the previous findings.

The initial review destination is the dedicated ChatGPT chat. To close the loop automatically later, Updraft will need a review result it can read reliably, with PR number, head SHA and blocker status. Options include an authorized GitHub review output or a local Codex reviewer with structured output. Define that handoff before letting Updraft send findings back to an implementation agent. Keep merges a human decision in the pilot.

**Decided (#13):** a result from an outside reviewer is a GitHub PR review carrying a hidden `updraft-review-result v1` block with the reviewed head SHA and `blockers: yes|no`, trusted only from logins in `review.reviewers` and only when the block's head matches the review's `commit_id`. The blocker status lives in the block because reviews posted from the PR author's own account are always `COMMENTED`. `updraft reviews` reads it; it acts on nothing. Updraft's own reviewer and fix cycle were built separately ([review-loop.md](review-loop.md)). See [review-result.md](review-result.md).

## 6. First build and acceptance

1. Ship repo discovery, config validation, issue-event polling and a durable queue. Run a log-only action before enabling agents.
2. Add per-job worktrees and adapter execution. Exercise Codex for art and Claude Code/Kiro for general work. Verify that the packed npm install, config, SQLite state, worktree creation and child process lifecycle work in Windows, macOS and Linux CI. Test each background launcher under its normal user account and verify headless agent startup on the Windows pilot host.
3. Validate the ChatGPT task separately on a PR open and a follow-up push. Walk one real issue through implementation, PR creation and re-review.

| Scenario | Expected outcome |
| --- | --- |
| Apply the dispatch label with `art` present | One job enters the Codex pool |
| Apply the dispatch label without `art` | One job enters the Claude/Kiro pool |
| Add `art` alone | No implementation job |
| Both general agents are occupied | Job stays queued |
| Restart or replay a fetched event | The original job is retained |
| Remove and re-add the dispatch label | A new job can run when the prior one has finished |
| Two different issues run in one repo | Separate branches, worktrees and logs |
| An agent stops after editing files | Failed run remains inspectable |
| Install and start on Windows, macOS and Linux | Same commands and config work, including workspace paths with spaces |
| Background runner restarts after a crash | One worker resumes from the existing checkpoints without duplicating queued jobs |
| Open a PR, then push a fix | ChatGPT reviews each observed revision and identifies its SHA |

## 7. Decisions to make before unattended runs

| Decision | Proposed pilot behavior |
| --- | --- |
| Who can dispatch work? | Use an explicit GitHub actor allowlist for the pilot, starting with Allen. Check the actor on the label event. Expand to collaborators or planned bot accounts only if needed. |
| What counts as done? | Leave a local branch and summarize changes and checks. **Decided (#12):** publication is opt-in per repository (`publish: none`, the default, `draft-pr` or `pr`), applies in live mode to `local-branch` actions, and only to runs that succeeded and left commits. The CLI's worker pushes the job branch (create-only: it never moves an existing branch; the opt-in revision loop, [revisions.md](revisions.md), later fast-forwards that one branch) and opens the PR as the user's own `gh` account, then comments on the issue; the agent gets no GitHub token. Each step is idempotent by run id. `pr` exists for private repos whose plan refuses draft PRs; the CLI never falls back to it on its own. Merging stays a human decision. |
| Where does feedback go? | Deliver reviews in ChatGPT and hand findings back to the implementer manually. Decide where machine-readable reviews should live before automating fix-and-review cycles. |
| What can agents execute? | Configure the commands, credentials and tool permissions needed by each action before running it unattended. Validate Kiro headless auth and each adapter's exit behavior under the worker account. |

The first coding step can begin with repo selection, event ingestion and a log-only worker. The trigger label, authorized dispatchers and publication behavior need to be settled before enabling live implementation runs. ChatGPT webhook activation is an integration dependency for the review phase.

## References

- [GitHub CLI authenticated API requests](https://cli.github.com/manual/gh_api)
- [GitHub repository discovery](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)
- [GitHub repository issue events](https://docs.github.com/en/rest/issues/events#list-issue-events-for-a-repository)
- [GitHub issue label event fields](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#labeled)
- [ChatGPT event-triggered tasks](https://learn.chatgpt.com/docs/automations#trigger-tasks-from-app-events)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Kiro CLI headless mode](https://kiro.dev/docs/cli/headless/)
- [Windows Task Scheduler logon triggers](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger)
- [Windows Task Scheduler runtime limit](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)
- [macOS user LaunchAgents](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)
- [Linux user services and lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)
- [Codex native Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- [Claude Code Windows setup](https://code.claude.com/docs/en/setup#set-up-on-windows)
- [Kiro platform requirements](https://kiro.dev/docs/getting-started/installation/)
- [Node.js child process behavior on Windows](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)

