# Security

What the worker and the agents it starts can do, and which guards exist. The
[README](../README.md#security) has a summary.

- Only GitHub logins in `dispatch.allowedActors` (or a workflow's `allowedActors`) can
  dispatch work. The check uses the actor on the label event; with an empty list, no events
  are queued. In live mode the worker checks again right before it starts an agent: the label
  application that queued the job must still be the latest one for that label on the issue,
  and its actor must still be allowed. If the label was removed and put back since, the old
  job is canceled; a reapplication by an allowed actor has queued its own job.
- Issue titles, bodies and labels are untrusted input. In live mode they reach the agent
  only through a prompt file (on stdin or by path), never a command line, fenced and
  labelled as untrusted; the default prompt
  ([examples/prompts/implement-issue.md](../examples/prompts/implement-issue.md)) also tells
  agents not to follow instructions in them.
- Without `publish`, the worker only reads from GitHub and never pushes. In `prepare-only`
  and `live` mode it fetches into your clone and creates branches and worktrees; Git hooks
  configured for the clone (such as `post-checkout`) run as they would for any
  `git worktree add`. With `publish` set for a repository, the worker also writes to GitHub
  as your `gh` account: it creates job branches (never moving an existing one, never the
  base branch), opens PRs and comments on issues (see [Publication](publication.md)). It
  never merges.
- Publication is done by the worker after the agent has exited; the agent itself is not given
  `GH_TOKEN`/`GITHUB_TOKEN`. That is a guard against accidental use, not isolation: the agent
  runs as your user, so it can still reach whatever that user can, including `gh auth token`,
  Git credential helpers (such as the one `gh auth setup-git` installs) and SSH keys, and so
  could push or call the API itself. Only an isolation boundary such as a separate account,
  VM or container would prevent that.
- In live mode the agent runs as your user, in the job's worktree, with the worker's
  environment minus `GH_TOKEN`/`GITHUB_TOKEN`. That is not a sandbox: what the agent may do
  is up to the agent CLI's own permission settings. Claude Code runs in full-auto mode by
  default (see [Live mode with Claude Code](agents/claude.md#permission-profile)), and so do
  Codex (see [Live mode with Codex](agents/codex.md#permission-profile)) and Kiro
  (see [Live mode with Kiro](agents/kiro.md#permission-profile)); the allowlist of actors
  who can dispatch work is the guard on who can start such a run.
- Agent credentials such as `KIRO_API_KEY` belong in the worker's environment, set by its
  launcher, not in the config file
  (see [Agent credentials](background-operation.md#agent-credentials)).
- GitHub access uses `GH_TOKEN` or `GITHUB_TOKEN` if set, otherwise `gh auth token`. The CLI
  does not store tokens.
