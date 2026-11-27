# Acting as a GitHub App

By default the worker acts on GitHub as you: it reads issues, pushes branches, opens pull
requests and comments with your `gh` account's token. With `github.app` in the config it acts
as a GitHub App you own instead, and everything it writes is authored by `<app-slug>[bot]`.

Reasons to set it up:

- **Provenance.** Pull requests and comments are visibly the bot's, not yours.
- **You can review them.** GitHub does not let you approve, or request changes on, a pull
  request you opened yourself. A bot-opened PR you can approve, and with
  [`revise`](revisions.md) your own "Request changes" review starts a revision.
- **Narrower, short-lived credentials.** The worker holds an installation token that lasts
  one hour, reaches only the repositories the App is installed on, and carries only the
  permissions listed below, instead of a token for your whole account.

It is off unless configured. Without `github.app`, nothing described here applies.

> This feature was written from GitHub's API documentation and tested against a simulated
> API. It has not yet been run with a real App. Run `updraft doctor` after setting it up, and
> start with one repository.

## Setup

1. **Create the App.** On GitHub: your profile picture, Settings, Developer settings, GitHub
   Apps, New GitHub App. (For repositories of an organization, create it under the
   organization's settings instead, or make it installable on any account in step 2.)
   - *GitHub App name*: anything unique, for example `yourname-updraft`. The name becomes the
     slug, and the bot is `<slug>[bot]`.
   - *Homepage URL*: required by the form; any URL of yours.
   - *Webhook*: clear **Active**. The worker polls; it receives nothing.
   - *Repository permissions*: **Contents**, **Issues** and **Pull requests** set to
     **Read and write**. **Metadata: Read-only** is selected for you. Nothing else, no
     organization or account permissions, and no event subscriptions. See
     [Permissions](#permissions) if you publish nothing or use fewer features.
   - *Where can this GitHub App be installed?* **Only on this account**, unless you watch
     repositories under several owners; then **Any account**, and install it on each.
2. **Install it.** On the App's page: Install App, pick the account, **Only select
   repositories**, and select the repositories in your Updraft config. Nothing else needs
   access.
3. **Note the App ID** from the App's settings page (General, About). The client ID works too.
4. **Generate a private key** on the same page (Private keys, Generate a private key). The
   browser downloads a `.pem` file. GitHub keeps only the public half; this file is the only
   copy.
5. **Put the key where only the worker's user can read it**, outside any repository clone,
   for example next to the config file:

   ```sh
   mv ~/Downloads/yourname-updraft.*.private-key.pem ~/.updraft/github-app.pem
   chmod 600 ~/.updraft/github-app.pem
   ```

   On Windows, move it to `%USERPROFILE%\.updraft\github-app.pem` and remove inherited access:

   ```powershell
   icacls "$env:USERPROFILE\.updraft\github-app.pem" /inheritance:r /grant:r "${env:USERNAME}:R"
   ```

6. **Add it to the config:**

   ```yaml
   github:
     app:
       appId: 1234567
       privateKeyPath: ./github-app.pem   # relative to the config file's directory
       # installationId: 87654321         # optional, see below
       # commitAsApp: true                # optional, see "Commit authorship"
   ```

7. **Check it:** `updraft validate` checks offline that the file exists and is an RSA private
   key. `updraft doctor` then checks that the key loads and is not readable by other users,
   that the App authenticates (and prints the bot's name), that every configured repository
   has an installation, and that the installation's permissions cover what that repository's
   configuration uses. Restart the worker to pick the change up.

### Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `github.app.appId` | required | The App's ID (a number) or client ID (a string such as `Iv23li...`) |
| `github.app.privateKeyPath` | one of the two | Path of the PEM private key file, relative to the config file's directory. The key itself is never in the config. `UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH` in the worker's environment names another file (also relative to the config file's directory) and wins |
| `github.app.tokenFile` | one of the two | Instead of the key: path of a [token file](#a-token-file-instead-of-the-key), relative to the config file's directory. `UPDRAFT_GITHUB_APP_TOKEN_FILE` in the worker's environment names another file and wins over both settings |
| `github.app.installationId` | looked up per repository | Use this installation for every repository. Leave it out when repositories are under different owners: each owner has its own installation, and the worker finds the right one per repository |
| `github.app.commitAsApp` | `false` | Live mode: agents commit as the bot. See [Commit authorship](#commit-authorship) |

The private key is read each time the worker signs in to GitHub (for a new token, at least
once an hour), so a replaced key file is picked up without a restart.

### A token file instead of the key

Whoever holds the private key can mint a token for *every* installation of the App. A worker
that should reach only some repositories, such as one job on a shared machine (Updraft Cloud
runs each job like this), can be given installation tokens instead. Something else holds the
key, mints a token with only the repositories and permissions the job needs, and writes it to a
file the worker reads:

```json
{
  "app": { "id": 123456, "slug": "updraft", "name": "Updraft" },
  "installationId": 55,
  "token": "ghs_...",
  "expiresAt": "2026-11-19T21:00:00Z",
  "permissions": { "contents": "write", "issues": "write", "pull_requests": "write" },
  "repositories": ["acme/web"],
  "bot": { "id": 98765, "login": "updraft[bot]" }
}
```

`app`, `installationId`, `token` and `expiresAt` are required. `token` may contain only letters,
digits, `_`, `.` and `-`; anything else, such as a line break, is refused before it reaches a
request header. `name`, `permissions`, `repositories` and `bot` are optional:
- **`permissions`:** without it the permissions are unknown, not empty. `updraft doctor` then says
  it can't check them, instead of reporting each one as missing.
- **`repositories`:** with it, the worker asks for a token only for those repositories and says
  so for any other.
- **`bot`:** without it, the bot user is looked up once with the token, for `commitAsApp`.

The file must be for the configured App, and the worker checks that on every read. That way a
refresh that wrote another App's or another installation's token can't switch who the worker acts as:
- **A numeric `github.app.appId`,** quoted or not, must equal `app.id`.
- **A client ID** in `github.app.appId` must equal `app.clientId`, which the file must then state.
- **`github.app.installationId`,** when set, must equal `installationId`.

How the worker uses the file:
- **It reads the file again for every token it needs,** so the writer replaces the token before
  it expires, and the worker picks up the new one with no restart. Installation tokens last an
  hour.
- **When a token is about to expire,** with under ten minutes left, it's still used, with one
  warning in the log.
- **An expired token stops the request.** The error says the file was not replaced.
- **A token GitHub rejected** isn't used again until the file holds another.

Set `github.app.tokenFile` instead of `privateKeyPath`, or set `UPDRAFT_GITHUB_APP_TOKEN_FILE`.
`updraft validate` and `updraft doctor` read the file, and doctor also reports how long the
token has left. Like the key path, the variable is never passed to an agent. Keep the file
readable only by the worker's user (mode 600) and outside every clone.

## What changes

- **Who authors things.** Pull requests, the comment on the issue, failure comments, revision
  replies and the pushes themselves are by `<app-slug>[bot]`.
- **What you can do with its PRs.** You can approve them and request changes on them, which
  GitHub refuses for PRs you opened, so a branch protection rule that requires an approving
  review can be met by yours.
- **All of the worker's GitHub access goes through the App:** polling issue events, reading
  issues, labels, edit history and reviews, opening PRs, commenting, and pushing. So does
  `updraft publish`, and `updraft doctor` checks the App rather than your account.
- **Pushes always use HTTPS.** See [Pushing](#pushing).
- **Rate limits** are the installation's own, separate from your account's.
- **`gh` becomes optional for the worker.** Only `updraft configure` and `updraft add` use it.

## What does not change

- **Who can dispatch work.** `dispatch.allowedActors` (and a workflow's `allowedActors`)
  still lists the *people* who may apply the trigger label, and with `revise` whose "Request
  changes" review counts. Do not add the bot. Nothing the bot does is a trigger: it applies no
  labels and submits no reviews, and its comments, pushes and pull requests are not events the
  worker acts on. If the bot's login were ever on a label event or a review, it would be
  refused like any login that is not listed. `updraft doctor` warns when the bot is listed.
- **`updraft configure` and `updraft add` use your own `gh` sign-in.** They list the
  repositories *you* can reach (`GET /user/repos`), which an App cannot ask. They do not offer
  the App's installed repositories instead, and they do not check that a repository you add
  has the App installed; `updraft doctor` does.
- **Fetching uses your own Git credentials.** Before a run the worker fetches into your clone
  through the clone's remote, with your SSH key or credential helper as before. Only the push
  is the bot's.
- **Commits are authored by whoever Git is configured as** on the machine, unless you turn on
  `commitAsApp`. A bot-opened PR can therefore contain commits with your name.
- **Earlier pull requests and comments stay as they are,** and are still recognised: the
  worker finds its PRs by branch and its comments by a hidden marker, not by author, so
  switching identity never produces duplicates.
- **Merging.** The worker never merges, approves or marks a PR ready, as either identity, except
  as the review loop and `autoMerge` say. Its reviewer submits a formal approval only on a pull
  request a person published (see [Publishing as a person](#publishing-as-a-person)).

## Pushing

With an App configured, a push goes to `https://github.com/OWNER/REPO.git` with a newly
issued installation token, whatever protocol the clone's remote uses. An SSH remote is still
what the worktree is fetched from, but a push over SSH would be made with your key and so as
you, which is what this feature is meant to avoid; the worker neither does that nor asks you
to change the remote. The remote must still be one that points at `OWNER/REPO`, with a single
push URL, as described under [Publication](publication.md). The machine needs HTTPS access to
`github.com`.

The token reaches Git the same way your token does today: as an `Authorization` header scoped
to `https://github.com/`, passed to that one `git` process through `GIT_CONFIG_*` environment
variables. It is never on a command line, in a URL, in a file or in a log.

A push that changes files under `.github/workflows/` is refused by GitHub unless the App also
has the **Workflows** permission (read and write). Grant it only if your agents are meant to
edit workflows.

## Commit authorship

Commits are made by the agent, in the job's worktree, before the worker pushes. By default
they carry the local Git identity (`user.name` and `user.email` of the machine or the clone).

With `github.app.commitAsApp: true`, the worker sets `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
`GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` in the agent's environment to the bot's name
and GitHub's noreply address for it, `<bot user id>+<app-slug>[bot]@users.noreply.github.com`,
so GitHub shows the commits as the bot's. Things to know:

- It is a default for the agent, not a guarantee: an agent can still commit under another
  name, and `agents.<name>.env` wins if it sets the same variables.
- Commits are never rewritten after the fact. Runs that finished before you turned it on keep
  their authors.
- The commits are not signed, so GitHub does not mark them "Verified".
- For a containerized agent the four variables are passed into the container by name, like
  the agent's own `env`.
- The bot's user id is read from GitHub once per worker. If it cannot be read, the run fails
  before a worktree is created and can be retried.

## Publishing as a person

With an App configured, a repository can have its pull requests opened and pushed under a
person's own GitHub account instead, while the App reviews them. The pull request conversation
then has two clearly different participants: the coding agent, as the person who authorized it,
and the reviewer, as `<app-slug>[bot]`. Because they are different accounts, the reviewer can
submit a real GitHub **approval** or **change request** instead of a comment.

It is off unless configured, and only for the repositories you name:

```yaml
github:
  app:
    appId: 1234567
    privateKeyPath: ./github-app.pem
  publisher:
    login: your-login        # the account that agreed to publish; never inferred
    id: 1234                 # optional: its numeric id, which survives a rename
repositories:
  your-org/your-repo:
    publish: pr
    review: true
    publishAs: user          # default: app
```

`updraft validate` refuses `publishAs: user` without `github.app` (without an App the worker
already publishes as you) and without `github.publisher`. `updraft doctor` then checks, for
each repository with `publishAs: user`, the same things publication checks, and prints both
identities: *"pull requests and pushes as your-login (id 1234, github.publisher); reviews,
notices and merges as updraft[bot]"*. The worker logs the same at start.

### Who does what

| Action | Identity |
| --- | --- |
| Push of the job branch, the pull request itself | the person |
| Revision and CI-fix pushes, the coding agent's replies and claims on the PR, its answers in finding threads | the person |
| The reviewer's review, inline findings, thread resolution | the App |
| The issue's status comment, assignment, CI and merge notices, limit notices | the App |
| Marking ready for review, `autoMerge` | the App |
| Polling, reading issues and reviews | the App |

### Consent and checks

- **Explicit.** The person is the one named in `github.publisher`. Updraft never takes the
  issue's author, the label's actor or the installation's owner for it.
- **Local CLI: your own `gh` sign-in.** The token is `GH_TOKEN` / `GITHUB_TOKEN` if set, else
  `gh auth token`. Nothing asks you to paste a classic PAT into the config.
- **Checked on every use.** Before a job of such a repository starts, and again at every
  publication and revision push, the worker reads a fresh token and asks GitHub whose it is
  (`GET /user`) and whether that account can push to the configured repository, compared by
  repository id. The token it checked is the one it pushes with, so a `gh auth switch` in
  between cannot change who pushes.
- **No fallback.** Another account's sign-in, an expired or revoked one, a repository the
  account cannot reach or push to, or a bot token: each stops the step with what to change.
  A job that has not started stays queued (the reason is in `updraft status`); a publication
  or revision fails without pushing. Nothing is ever retried as the App instead.
- **A pull request keeps its publisher.** The publisher is recorded (login and account id,
  never a credential) before the first push, and every retry, revision and CI fix of that pull
  request uses it. Turning `publishAs` on or off applies to new pull requests only. If the
  recorded person is no longer configured, or `github.publisher` now names someone else, the
  step stops rather than continue as another account. Pull requests from before this setting,
  and those of repositories without it, stay the App's.
- **Pushes go over HTTPS** with the person's checked token, never with the clone's SSH key
  (whose account nobody checked), to exactly the validated repository. The branch rules of
  [Publication](publication.md) are unchanged: only Updraft's own job branch, create-only for
  the first push, fast-forward with a lease for revisions, never the base or default branch,
  never a force push.

### Reviews

On a pull request the person published, the App's reviewer submits:

- **APPROVE** for a ready-to-merge verdict, and **REQUEST_CHANGES** for changes requested,
  pinned to the exact reviewed commit (`commit_id`).
- A **COMMENT** that says why it is not one of those, when the pull request is no longer at the
  reviewed commit, when what is missing is for a person to settle (acceptance criteria only a
  person can verify), when blockers of earlier reviews are not verified yet (for an approval),
  when the reviewer and the publisher turn out to be the same account, or when GitHub refuses
  the formal review (repository rules, permissions). It never reads as an approval.
- When a later head is reviewed without an approval, the App dismisses its own earlier
  approvals of other commits, so one never outlives the commit it was for. A person's reviews
  are never touched.

What a formal review does **not** change:

- **The worker's own verdict decides**, as before: a revision is queued from the recorded
  verdict, and the App's change request on GitHub is recognised as its own (author and the
  review's hidden marker together) and never queues a second one. CI waits, the same-head
  check and `autoMerge` read the recorded verdict, not GitHub's review state.
- **Required reviews.** Whether the App's approval counts toward a branch protection rule or
  ruleset is GitHub's decision, and depends on the rule (a required code owner, a required
  approval from someone with write access, "dismiss stale approvals", and so on). Updraft never
  claims an automated approval stands in for a person's or a code owner's. `autoMerge` still
  asks GitHub to merge the exact head and reports GitHub's refusal.
- **A person's reviews** still trigger revisions under `revise`, as before.

### Commit authorship and attribution

Who *pushes* and who *authored* a commit are separate in Git. Commits keep the local Git
identity, or the bot's with `commitAsApp`; Updraft does not set them to the person, does not
sign them, and does not mark them verified. The pull request body says plainly that it was
pushed and opened by Updraft's coding agent with the person's sign-in, that the code is the
agent's, and (with `review`) that the automated reviews are the App's and do not replace a
review a person or code owner must give. The usual run and agent markers and run details stay.

### What it is not yet

- **Updraft Cloud** does not offer this yet: hosted jobs publish as the App only. The design and
  threat model for a hosted version are in [Publication identity](publication-identity.md).
- It was tested against simulated GitHub APIs, not yet against a real repository with real
  formal reviews. Before you rely on it, run `updraft doctor`, start with one repository, and
  check on GitHub that the pull request's author, each push's actor and the review state are as
  described.

## Permissions

Repository permissions of the App, by what you have turned on:

| Permission | Level | Needed for |
| --- | --- | --- |
| Metadata | Read-only | Always (GitHub grants it to every App) |
| Issues | Read-only | Polling: issue events, issues, labels and the body's edit history |
| Issues | Read and write | `publish` (the comment on the issue) and `commentOnFailure` |
| Contents | Read and write | `publish` and `revise`: pushing the job branch |
| Pull requests | Read and write | `publish` (opening the PR) and `revise` (reading reviews, replying on the PR) |
| Checks | Read-only | `autoMerge` and `ciFix`: reading the head commit's check runs and their annotations |
| Commit statuses | Read-only | `autoMerge` and `ciFix`: reading the head commit's statuses |
| Actions | Read-only | `ciFix`: reading the logs of failed GitHub Actions jobs for the fix's diagnostics |
| Workflows | Read and write | Only if agents change files under `.github/workflows/` |

So a worker that publishes needs **Metadata read; Contents, Pull requests and Issues read and
write; nothing else**. A worker that only records or prepares runs needs Metadata and Issues
read. No organization permissions, no account permissions, no webhook events.

Two planned features would need more, should you turn them on later: an automated reviewer
posts reviews (covered by Pull requests write), and automatic merging uses Contents write and
Pull requests write (covered) and reads check results, which needs **Checks: Read-only** and
**Commit statuses: Read-only**.

When you change an App's permissions, each installation keeps the old ones until its owner
accepts the request GitHub sends (the account's Settings, GitHub Apps, Configure).
`updraft doctor` reads what the installation actually grants, so it shows a change that has
not been accepted yet as missing.

## When something is wrong

Each of these is reported by `updraft doctor`, in `updraft status` and in the worker's log
with what to change. The worker backs off between attempts (polling a repository that fails
waits longer each time, up to fifteen minutes) instead of retrying in a loop, and a publication stopped by one of them waits for
`updraft publish RUN_ID`.

| Message | Cause | What to do |
| --- | --- | --- |
| `the GitHub App private key ... does not exist` / `cannot be read` / `is not a PEM private key` / `is a ... key` | The file is missing, belongs to another user, or is not the RSA key GitHub generated. A passphrase-protected key is not supported | Point `github.app.privateKeyPath` at the downloaded `.pem`, owned by the worker's user |
| `GitHub rejected the App's JWT because of its timestamps` | The machine's clock is ahead by more than a minute or behind by more than about nine (the message gives both clocks) | Turn on time synchronization |
| `GitHub did not accept the App's JWT` | `appId` is not this App's ID, or the key belongs to another App or was deleted | Compare the App ID and the keys listed on the App's settings page |
| `is not installed on OWNER/REPO` | The App has no installation covering that repository | Install the App on the account, or add the repository to the installation's selected repositories |
| `has no installation <id>` | `installationId` is wrong, or the App was uninstalled | Correct it, or remove it to have the installation looked up |
| `installation ... is suspended` | The account owner suspended the installation | Unsuspend it under the account's Settings, GitHub Apps |
| `lacks a permission this request needs` / `GitHub App permission missing for ...` | The installation does not grant a permission the configuration uses | Set it under the App's "Permissions & events", then accept the new permissions on the installation |
| `rejected the GitHub App's installation token` | A token stopped working early, usually because the installation changed | The worker already retried once with a new token; run `updraft doctor` |

Network errors, GitHub 5xx responses and rate limits while signing in are retried like any
other. If GitHub cannot be reached when a token is due for renewal, the worker keeps using the
current one until it expires.

## Security

- **The private key is the secret.** Whoever holds it can act as the App on every repository
  it is installed on, for as long as the key exists, and can mint as many tokens as they
  like. That makes it a stronger secret than the `gh` session token the worker uses
  otherwise. Keep one copy, readable only by the worker's user (`updraft doctor` warns on
  POSIX when group or others can read it), never in the config file, a repository or a
  backup that others can read. If it may have leaked, delete it on the App's settings page
  and generate a new one.
- **The agent can read it unless you isolate the agent.** An agent runs as the same OS user
  as the worker, so it can read the key file, exactly as it can run `gh auth token` today.
  The worker does not hand it over: the key path variable is removed from the agent's
  environment like `GH_TOKEN` and `GITHUB_TOKEN`, and no token or key is ever passed to an
  agent. That prevents accidents, not a determined or misled agent. To actually keep the key
  from the agent, run the agent in a container (`agents.<name>.container`: the container sees
  only the job's worktree, so keep the key outside every clone), or run the worker under a
  dedicated OS account. See [Isolating agents](isolation.md).
- **What narrowing you get.** A leaked installation token expires within the hour and is
  limited to the installed repositories and the granted permissions. Install the App on the
  repositories Updraft watches and nothing else, and grant only what the table above lists.
- **Nothing is logged.** The key, the JWT and tokens are not written to logs, `run.log`,
  recorded errors or comments, and text that looks like any of them is redacted from Git's
  and GitHub's error output before it is stored.
- **Your own credentials are still on the machine** for `updraft configure`, `updraft add`
  and Git fetches. The App narrows what the *worker* uses to write; it does not remove what
  your user can reach.
