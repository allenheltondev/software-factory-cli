# Steering by mention

People allowed to direct Updraft can pause, resume, stop, cancel, re-review or steer the work on an issue
from GitHub itself, by mentioning the App in a comment on the issue or on the pull request Updraft opened for
it. There is no relabeling, no duplicate pull request, and the workflow's history (reviews, threads, commits)
is kept. The same commands run from the worker's terminal with `updraft control`.

```text
@updraft-app pause
@updraft-app resume — I fixed the failing test; review the latest commit again.
@updraft-app stop
@updraft-app stop job_3kQ9…          (when several jobs are active)
@updraft-app cancel
@updraft-app review
@updraft-app steer Please keep the existing API and add a regression test.
@updraft-app help
```

The handle is the App's own: its slug (`@<slug>`, or `@<slug>[bot]`). For the local CLI it is the worker's
identity (the App's slug, or the `gh` account's login), or `controls.handle`. `help` shows the real handle.

## What counts as a command

- A line that **starts** with the mention (after at most three spaces), followed by a command word. A mention
  inside a sentence, a quotation (`>`), a code block, inline code or an HTML comment is not a command.
- Exactly one command per comment. A bare mention, an unknown word or two command lines get the help text,
  never an action. A plain mention never authorizes anything.
- Text after the command (`resume — …`, `steer …`) is kept, at most 2000 characters. It is untrusted input: it
  reaches an agent only fenced as a change request, and can never change the sandbox, credentials, approvals,
  quotas or the verdict protocol.
- Only a comment **as first written** (`created`). Edits are never acted on, and neither is anything older than
  the moment the local poller first looked.
- Comments by bots, by the App or worker itself, and Updraft's own comments (they carry hidden
  `<!-- updraft… -->` markers) are ignored without a reply, so replies can never loop.
- Each command is handled once, by comment id: a redelivered webhook, a replayed event, a re-read or a restart
  does nothing more. The record of it (who, what, when, the head it was judged against, the outcome) is the
  audit trail. Comments nothing is done for (automation, someone not allowed, a subject Updraft does not manage) are
  not recorded, so they cannot grow the state.

Commands only apply to work Updraft manages: an issue it has worked on, or a pull request on an Updraft branch
(`updraft/…`) it opened. Anything else, and any repository not in the configuration, is left alone, unanswered.

## Who may give them

| Command | Needs |
| --- | --- |
| `help` | an allowed actor |
| `pause`, `resume` (of a `pause`), `review`, `steer` | an allowed actor with **write** access to the repository now |
| `stop`, `cancel`, `resume` of a stop or cancel | an allowed actor with **maintain** or **admin** access |

Allowed actors are the people the configuration lets dispatch work in the repository (the union of its
workflows' `allowedActors`, else `dispatch.allowedActors`). GitHub is asked for the commenter's permission each
time (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`); if it cannot be read, the command is
refused. A refusal is one short reply that says nothing about the workflow's state. Destructive commands are
only ever recognized from their own word.

Someone who is **not** an allowed actor gets no reply at all, and costs nothing: the allowlist is checked first,
before any GitHub request, and in Cloud before anything is written (only a log line). Anyone can comment on an
issue; no one outside the allowlist can make the App post. Cloud also checks, from its own table, that the issue
has a workflow (or a pause) or that the pull request was opened by a recorded job, before any GitHub request,
and a pull request's head must be in the same repository (never a fork's look-alike `updraft/` branch).

## What each command does

| Command | Effect |
| --- | --- |
| `pause` | Nothing new of the workflow starts: queued work is held, and later events are held too. A job already running **continues to completion and may still publish**; the reply names it. Use `stop` to end it. |
| `resume` | Lifts the pause it finds, exactly that one: a newer stop always wins. Then continues from where it stopped (below). On a closed issue or a merged or closed pull request, nothing is resumed: reopen and label it to start new work. |
| `stop` | Emergency stop of the one active job of this issue and its pull requests, through the same stop primitive as the console's **Stop job** (docs: `cloud/server/src/jobs/STOPPING.md`). Pauses the workflow. With no active job, nothing happens; with several, it names them and stops none: name one. The reply says *stopping* until termination is confirmed. It never turns on the platform kill switch. |
| `cancel` | Holds the workflow first (a new pause, or the pause in place taken over and extended to the issue and the pull request, so only a maintainer can lift it), then ends its queued work and stops every active job. Resume runs each stopped job again. Taking a pause over gives it a new identity, so a resume decided against the earlier pause can never lift the cancel. Commits, branches and pull requests are kept. |
| `review` | Reviews the pull request's current head again, without a dummy commit. Earlier reviews and threads stay. |
| `steer` | Queues a coding run on the pull request with the text as a change request by the person who wrote it, under `maxRevisions` and the usual checks; the next review checks it too (it becomes an `S<n>` acceptance requirement, see [Acceptance criteria](acceptance.md)). A run already in progress does not see it. On an issue with no pull request yet, it is refused: comment on the pull request once it opens. |
| `escalate` | Not available yet: routing policy (tiers, escalation, tier override labels) decides. |

**Resume continues, it does not restart.** Locally, resume requeues exactly the jobs the pause held (canceled
or stopped), each of which meets every pre-start check again: a review of a head that moved is dropped, and the
head someone pushed while it was paused gets its review. In Updraft Cloud, resuming a stopped job runs it again
from its own event through the console's retry path: once per job, with the current configuration, keys,
quotas, kill switch and Claude sign-in. Publication never opens a second pull request, and nothing is
force-pushed. A resume never bypasses budgets, required approvals, branch protection, provider consent, the
kill switch or an unresolved blocker; when it cannot continue, the reply says why.

## Local CLI

```yaml
controls:
  enabled: true          # off by default: it reads the repository's comments every poll
  handle: updraft-app    # optional; default: the worker's own login or App slug
```

Each poll cycle reads the repository's new issue and pull request comments (`GET /repos/{o}/{r}/issues/comments
?since=…`), after its issue events and reviews, so a pause given now also holds what they just queued. State is
kept in the state database's `meta` rows (`control:pause:…`, `control:command:…`, `control:checkpoint:…`), so
shared state copies merge it like any other meta row (last writer wins; a pause is never deleted, only marked
resumed).

`updraft control OWNER/REPO#N COMMAND [TEXT…]` runs the same state machine from the terminal. `N` is the issue or
a pull request Updraft opened. Whoever can run it owns the state database, so it asks GitHub for no permission;
it is recorded like a comment command.

### Command history

`updraft controls OWNER/REPO[#N] [--json] [--limit N] [--outcome OUTCOME]` lists the commands recorded in the
state database: every `@<handle>` command and every `updraft control` run, who gave it, what Updraft decided
and why. It is read-only and local: the database is opened read-only, GitHub is never called and no credentials
are needed.

```text
$ updraft controls octo/widgets#7
RECEIVED                  ISSUE  PR   ACTOR              COMMAND  OUTCOME  MESSAGE
2026-01-05T14:02:11.408Z  #7     -    allen              pause    applied  Paused #7: nothing new starts. Job job_3kQ9xT2 is running; it continues to comp…
2026-01-05T14:20:37.002Z  #7     #12  mona               stop     refused  stop needs maintain or admin access.
2026-01-05T15:41:09.913Z  #7     -    allen (local CLI)  resume   applied  Resumed #7: requeued 1 job.
```

- `OWNER/REPO` lists every issue and pull request of the repository; `OWNER/REPO#N` only issue `N`. When `N`
  is a pull request Updraft opened (one the review loop knows), it lists the commands of that pull request's
  issue, the way `updraft control` resolves it.
- Oldest first: by time received, then the order recorded, then the comment id (or `cli-…` source).
- `--limit N` keeps the newest `N` (default 50), still oldest first. `--outcome` keeps one outcome: `applied`,
  `noop`, `refused`, `ignored`, `ambiguous` or `unsupported`.
- The table shows each message on one line of about 80 characters. Actor, command and message are printed as
  plain text: escape sequences and control characters a comment carried are removed.
- `--json` prints the records, unshortened, as one JSON array (the fields of the stored record: `source`,
  `repoId`, `issue`, `pullRequest`, `actor`, `command`, `receivedAt`, `headSha`, `outcome`, `message`,
  `replyId`, `seq`), and `[]` when there are none.

## Updraft Cloud

The webhook handles `issue_comment` and `pull_request_review_comment` deliveries (`created`) after verifying
their signature. A comment that is not a command changes nothing and costs no GitHub request. Commands are
listed in the installation's deliveries as `filtered` with reason `control_<outcome>`; their audit records are
`TENANT#<id>` / `CONTROL#<repositoryId>#<commentId>` items, kept 90 days. A `pause` or `cancel` writes the same
durable `PAUSE#` record a stop does (no TTL), with `control: { kind, source }` and no job behind it, so the
launcher, the admission queue, the broker and native assignment all hold the workflow, and its page shows
**Resume automation** as for any pause.

`review`, `steer` and `escalate` are answered as not available on Cloud yet: they need the job runner to take a
comment as its event.

**GitHub App settings.** The App must be subscribed to the **Issue comment** event (and **Pull request review
comment** for inline review comments). New Apps registered with `cloud/scripts/register-github-app.mjs` are; an
existing App's owner must turn them on under the App's *Permissions & events* page, and each installation must
accept the change. No new permission is needed (Issues, Pull requests and Metadata are already granted). The
readiness page reports whether issue comments reach Updraft.

## Not done yet

- Cloud: `review`, `steer`, `escalate`; resuming a `pause` given while nothing was stopped waits for the next
  event (a push, a review, the label) instead of re-reading the pull request at once.
- Escalation by comment on either path.
- Console: the command history of a workflow (the audit records exist; no page shows them yet). Locally,
  `updraft controls` shows it.
- Hosted validation on a real staging issue and pull request (standard and subscription routes).
