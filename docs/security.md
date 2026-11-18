# Security

What the worker and the agents it starts can do, and which guards exist. The
[README](../README.md#security) has a summary.

- Only GitHub logins in `dispatch.allowedActors` (or a workflow's `allowedActors`) can
  dispatch work. The check uses the actor on the label event; with an empty list, no events
  are queued. In live mode the worker checks again right before it starts an agent: the label
  application that queued the job must still be the latest one for that label on the issue,
  and its actor must still be allowed. If the label was removed and put back since, the old
  job is canceled; a reapplication by an allowed actor has queued its own job.
- Applying the trigger label approves the issue's title and body as they are at that moment.
  Whoever opened an issue can still edit it without being able to label it, so in live mode
  the worker also checks, right before it starts an agent, who last edited the issue. If the
  title or the body was edited after the label was applied by anyone who is not an allowed
  actor for the workflow, the job is canceled with a reason such as `issue #12's body was
  edited by mallory after the "ready" label was applied; remove and re-apply the label to
  dispatch the edited issue`. Removing and re-applying the label queues a new job for the
  edited text. Edits by allowed actors do not cancel anything, and only the newest edit of the
  title and of the body counts, so an allowed actor who edits an issue approves the text they
  saved. Edits made before the label was applied are part of what was approved: read the
  issue before you label it. The poller applies the same check to queued jobs on every cycle,
  so `updraft status` shows the cancellation early. Body edits are read through GitHub's
  GraphQL API (title changes come from the issue's events); if that information cannot be
  read, the job stays queued and is retried, and no agent is started. The check does not run
  in `log-only` or `prepare-only` mode, where no agent runs.
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
  never merges unless `autoMerge` is set (below). The one exception to "never moving an existing one" is the push of a
  revision, which is off unless `revise` is set too (next point).
- With `revise` set as well, a "Request changes" review on a PR the worker opened starts
  another agent run, so the same allowlist guards it: only a review whose author is an
  allowed actor for the workflow that produced the PR counts, and only on PRs the worker
  recorded as published. The review's body and inline comments are untrusted input like the
  issue: fenced in the prompt, only text written by allowed actors, and as it read when the
  worker first saw the review, so a later edit never reaches the agent; a review whose text
  was last edited by anyone else by then is refused. The worker then pushes to the PR's own
  job branch, as a fast-forward of exactly the commit the run started from, which is the one
  case in which it moves an existing branch (never the base branch, never a rewrite; a branch
  that moved meanwhile is left alone). The number of revisions per PR is capped by
  `maxRevisions`. It never approves, merges, dismisses a review or resolves a thread. See
  [Revisions](revisions.md).
- With `review` set, a second agent reviews every head commit of a PR the worker opened, and
  its "changes requested" verdict starts a revision without a person asking for it. The
  reviewer is an agent reading untrusted input (the code, the issue, earlier reviews), so its
  verdict is only as good as that: text in any of them can try to steer it. What limits the
  damage: the reviewer runs in a throwaway worktree that is deleted afterwards and nothing of
  it is ever pushed; it is not the agent that wrote the code unless you allow that; its
  verdict is read from one exact line of its final message and anything else fails the run
  rather than counting as approval; a verdict only ever applies to the one commit that was
  reviewed; the rounds are capped by `maxRevisions`; and the review is posted as a comment,
  with the findings as sanitized Markdown, because GitHub does not let an account approve its own PR. Without
  `autoMerge` the worst a fooled reviewer can do is mark a draft ready for review. See
  [The review loop](review-loop.md).
- **`autoMerge` is the most dangerous option Updraft has, and it is off unless you set it.**
  With it, a "ready to merge" verdict leads to a merge into your base branch with no person
  in between, and the verdict comes from an agent that read untrusted issue text and
  untrusted code, either of which can be written to talk it into approving. Updraft merges
  only the exact commit that was reviewed (the merge request names it, so GitHub refuses if
  anything was pushed since), only if the worker's own `verify` commands passed on it, only
  if GitHub reports at least one successful check on the commit (or every check named in
  `autoMergeRequiredChecks`), none failing or pending, and no conflict, only if no allowed actor has
  a "Request changes" review outstanding, and it never forces, bypasses branch protection or
  retries a refused merge. None of that tells you the reviewer was right: unless you name the
  required checks any one successful check satisfies the gate, a PR can change the tests and CI it is judged by, and silence from people
  is not approval. Use it only where every allowed actor could push to the base branch anyway,
  and put required checks on that branch in GitHub. See
  [Auto-merge](review-loop.md#auto-merge).
- Publication is done by the worker after the agent has exited; the agent itself is not given
  `GH_TOKEN`/`GITHUB_TOKEN`. That is a guard against accidental use, not isolation: the agent
  runs as your user, so it can still reach whatever that user can, including `gh auth token`,
  Git credential helpers (such as the one `gh auth setup-git` installs) and SSH keys, and so
  could push or call the API itself. Only an isolation boundary such as a separate account,
  VM or container would prevent that.
- To put that boundary in place, set `agents.<name>.container`: the agent, and the action's
  `verify` commands, then run in containers that see only the job's worktree and the parts of
  the clone's Git directory a commit writes (hooks and Git config stay read-only), as your uid,
  with only the environment variables you name. A lighter alternative is to run the worker
  under a dedicated OS account with its own `gh` login scoped to the watched repositories.
  Both, and what each does not protect against (the network and the credentials you pass in,
  among others), are described in [Isolating agents](isolation.md).
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
- With `github.app`, the worker acts as a GitHub App installation (`<app-slug>[bot]`) instead:
  it signs a short-lived JWT with the App's private key and exchanges it for an installation
  token that lasts an hour and reaches only the repositories the App is installed on, with
  only the permissions the App was given. The key is read from a file (only its path is in
  the config), and neither it, the JWT nor a token is logged, passed on a command line or
  given to an agent; the variable that can name the key file is withheld from agents like
  `GH_TOKEN`. The caveat above holds here too, and matters more: an agent runs as the same OS
  user and can read the key file unless it runs in a container (`agents.<name>.container`) or
  the worker runs under a dedicated account, and a private key that can mint tokens is a
  stronger secret than a session token. The bot is not an allowed actor unless you list it,
  so nothing it does can dispatch or re-trigger work; `updraft configure` and `updraft add`
  keep using your own `gh` sign-in. See [Acting as a GitHub App](github-app.md).
- With `commentOnFailure`, the worker also comments on the issue when a run fails, as your `gh`
  account. The comment carries only what the worker itself knows (run id, agent, duration, its
  own description of the failure with local paths removed, the job branch name, how to retry),
  never the agent's output or final message, and its text is rendered so it cannot mention
  users, reference issues or trigger closing keywords. See
  [Failure comments](failure-comments.md).
