# Isolating agents

In `live` mode an agent CLI runs in full-auto mode on text from a GitHub issue. By default it
runs as your user, so it can read whatever your user can read: SSH keys, `gh auth token`, Git
credential helpers, cloud credentials, every other repository on the machine. It can also reach
the network. The allowlist of actors who may dispatch work is the only guard on who starts such
a run, and it does not guard against what an issue's text talks the agent into.

This page describes two ways to put a boundary around the agent:

1. [Run the agent in a container](#run-the-agent-in-a-container) (`agents.<name>.container`).
   The agent sees the job's worktree and nothing else of the host.
2. [Run the worker under a dedicated OS account](#run-the-worker-under-a-dedicated-account).
   Lighter, no container runtime needed; the agent sees only what that account can.

They combine: a containerized agent started by a worker that itself runs under a dedicated
account is the strongest setup this project offers.

> **Status.** The container option has been tested against a stand-in runtime client (which
> records the exact `run`, `stop`, `rm` and `inspect` calls) and by applying its mount list as
> real bind mounts in a Linux mount namespace; the Docker 29 client accepts the generated `run`
> arguments. As of this writing it has **not** been run
> against a real Docker or Podman daemon. Before relying on it, run `updraft doctor`, dispatch
> one throwaway issue, and read the `command:` and `mount` lines in that run's `run.log`.

## Run the agent in a container

```yaml
agents:
  claude:
    maxConcurrent: 1
    env:                                   # non-secret settings, set inside the container
      GIT_AUTHOR_NAME: Updraft Agent
      GIT_AUTHOR_EMAIL: updraft-agent@example.com
      GIT_COMMITTER_NAME: Updraft Agent
      GIT_COMMITTER_EMAIL: updraft-agent@example.com
    container:
      image: my-org/claude-runner:latest   # required
      runtime: docker                      # docker (default), podman, or a path
      env: [ANTHROPIC_API_KEY]             # names of worker variables to pass in
      network: bridge                      # optional, passed as --network
      args: ["--memory", "4g", "--cpus", "2", "--pids-limit", "512"]   # optional
```

| Key | Default | Meaning |
| --- | --- | --- |
| `container.image` | required | The image to run. It must contain the agent CLI, `git`, and whatever the repository needs to build and test. A run never pulls: the image must already be present locally |
| `container.runtime` | `docker` | The runtime client: `docker` or `podman` looked up on `PATH`, or a path (relative to the config file's directory) |
| `container.env` | `[]` | Names of variables to pass from the worker's environment into the container. Names only; a `NAME=value` entry is rejected |
| `container.network` | the runtime's default | Passed as `--network`: `none`, `bridge`, or a network you created |
| `container.args` | none | Extra arguments for `<runtime> run`, placed last before the image. They can widen the boundary (see [What it does not protect against](#what-it-does-not-protect-against)) |

With `container` set, two other keys change meaning:

- `agents.<name>.command` is a name or path **inside the image**, used exactly as written.
  Without it the adapter's CLI name is used (`claude`, `codex`, `kiro-cli`). The host is not
  searched for the CLI, and it does not need to be installed there.
- `agents.<name>.env` is set **inside the container**. Its values still come from the config
  file, so it remains the wrong place for secrets.

`agents.<name>.args` is unchanged: the adapter builds the same agent command line as for a host
run, and the worker wraps it. A containerized run starts:

```
<runtime> run --rm -i --name updraft-<run id> --pull never
  --label updraft.run=<run id>
  --user <uid>:<gid> --cap-drop ALL --security-opt no-new-privileges
  --tmpfs /updraft-home:rw,exec,mode=1777 -e HOME=/updraft-home
  --mount type=bind,source=<path>,target=<path>[,readonly]   (one per mount, below)
  --workdir <job worktree>
  [--network <network>]
  -e <NAME>                                                  (one per variable, by name)
  [container.args]
  <image> <agent cli> <the adapter's arguments>
```

The full command is written to `run.log` (`command:`), followed by the list of mounts and of
variables passed by name. It contains no secret values.

### What the container can see

**Mounts.** Every mount is at the same absolute path inside the container as on the host,
because a Git worktree's `.git` is a file holding the absolute path of its administrative
directory inside the source clone. Nothing else of the host is mounted: not your home
directory, not the SSH agent socket, not the runtime's own socket.

| Path | Access | Why |
| --- | --- | --- |
| The job worktree | read-write | The agent's working directory |
| `<worktree>/.git` (a file) | read-only | The pointer to the worktree's Git data; see [The Git directory](#the-git-directory) |
| The clone's Git directory (`<clone>/.git`) | read-only | Git reads `config`, `packed-refs`, `info/` and the rest from here |
| `<clone>/.git/objects`, `refs`, `logs` (and `reftable`, `lfs` when present) | read-write | A commit writes objects, the branch ref and its reflog here |
| `<clone>/.git/worktrees/<job>` | read-write | This worktree's `HEAD`, index and logs |
| `commondir`, `gitdir`, `config.worktree` in that directory | read-only | See below |
| Object stores listed in `objects/info/alternates` | read-only | Only for clones made with `--reference` or `--shared` |
| `<state dir>/base-checks/<run>/base` | read-only | The files of the base commit, no git metadata; see [Checking a failure against the base commit](worktrees.md#checking-a-failure-against-the-base-commit) |
| `<state dir>/base-checks/<run>/scratch` | read-write | Scratch space for running a test on a copy of the base. Removed with the run, like the base |
| `prompt.md` of the run | read-only | Only for an adapter that passes the prompt by path. The built-in adapters use stdin, and then the run directory is not mounted at all |

**User.** The container runs as the worker's own `uid:gid`, so files the agent creates in the
worktree are owned by you, and Claude Code (which refuses its full-auto mode as root) is not
root. That uid usually has no home directory in the image, so `HOME` is set to
`/updraft-home`, an in-memory filesystem any uid can write. It is empty at the start of every
run and gone at the end: nothing an agent stores under `~` survives, including logins. All
capabilities are dropped and `no-new-privileges` is set, so `sudo` inside the image does not
work.

**Environment.** The container gets `HOME`, the variables named in `container.env`, the keys
of `agents.<name>.env`, and any variable the adapter itself sets. Each is passed as `-e NAME`:
the runtime client copies the value from its own environment, so values never appear on a
command line, in `run.log` or in `ps` output on the host. Nothing else of the worker's
environment is passed. `GH_TOKEN` and `GITHUB_TOKEN` are withheld as for host runs; naming
them in `container.env` is a validation warning and passes nothing (set
`agents.<name>.env.GH_TOKEN` if you really mean to hand the agent a token).

**Prompt and output.** The prompt reaches the agent on the client's stdin (`-i`), and the
client's stdout and stderr are the run's `run.log`, exactly as for a host run.

### The Git directory

The agent has to share the source clone's Git directory to commit, and the worker (and you)
later run `git` on the host in that same clone. `git worktree add` for the next job runs the
clone's `post-checkout` hook, and every Git command obeys the clone's `config`, in which
several settings name commands to run. An agent that could write either would run code on the
host, outside the container, at the next job.

So the Git directory is mounted read-only, and only the directories a commit writes are opened
inside it. In particular these stay read-only:

- `hooks/` and `config`;
- `info/attributes` and `info/exclude`;
- `packed-refs`, and the main worktree's own `HEAD` and index;
- other worktrees' administrative directories;
- `objects/info`, inside the otherwise writable object store. Its `alternates` file names other
  object stores by host path, and the worker mounts whatever it lists into containers; an agent
  that could write it would have host directories of its choosing mounted into the next one;
- the worktree's `.git` pointer file, and `commondir` in its administrative directory. Either
  could otherwise be rewritten to point at a directory the agent made, whose `config` host Git
  would then obey when it runs in the worktree;
- `config.worktree` in that directory, which Git obeys when the clone has
  `extensions.worktreeConfig`. The worker creates it empty if it does not exist, so that it
  can be mounted read-only.

Ordinary work is unaffected: `git add`, `commit`, `checkout -b`, `stash`, `rebase`, `tag` and
`reset` all work. Commands that rewrite files directly in the Git directory fail inside the
container: `git gc`, `git pack-refs`, deleting a ref (`git branch -d`, `git stash pop` or
`drop` of the last entry: Git locks `packed-refs` for every deletion), and `git config`
without `--global` (`--global` writes to the scratch home and works). To compare a failure with
the base commit an agent uses the run's base checkout instead
([Checking a failure against the base commit](worktrees.md#checking-a-failure-against-the-base-commit)).

With the files ref store, Git takes `packed-refs.lock` in the top level of the Git directory for
every ref deletion, whether or not the ref is packed, and Git 2.45 and later delete per-worktree
pseudorefs (`AUTO_MERGE`, `CHERRY_PICK_HEAD` and the like) through the ref store after every
`git commit`. In a container that lock cannot be created, so each commit prints
`error: Unable to create '.../packed-refs.lock': Read-only file system` (the commit itself
succeeds). No configuration turns that deletion off.

So a clone the worker creates itself (`updraft run-event`) uses the reftable ref store where Git
has it (2.45 and later): every ref, its lock and its tables live in `reftable/`, which is mounted
like `refs/`, and commits, `git stash pop` and `git branch -d` work without the top level. An
older Git gets the files store, and its `git commit` deletes no ref. The same clone also has
`gc.auto=0` and `maintenance.auto=false`, because the automatic gc that `git commit` starts once
there are enough loose objects writes `gc.pid.lock` there too; the worker runs `git gc --auto`
itself instead, on the host and outside any agent run (before an event's run at most once a
day, and on `updraft clean`). A clone you made is left as you configured it: with the files
store and Git 2.45 or later, a contained agent's commits print that error and still succeed.

After the agent exits, the worker summarizes the run with `git diff` on the host, in a
worktree whose contents the agent wrote. For a containerized run it tells Git not to look
inside submodules (`--ignore-submodules=dirty`): otherwise Git would run `git status` in any
nested repository the agent left, under that repository's own config. A changed submodule
commit still counts in the summary; uncommitted changes inside a submodule do not.

### Verify commands

An action's `verify` commands ([Verification](verification.md)) execute code the agent wrote,
so for a containerized agent the worker runs them in containers too, one per command, named
`updraft-<run id>-verify-<n>`, from the same image with the same mounts, user, `network` and
`args`. The mount list is the one worked out before the agent started; it is not read again
from the clone, whose object store the agent could write to in the meantime. A string command
runs through `/bin/sh -c` inside the container. They get none of the
variables named in `container.env`: those are the agent's credentials, and checking its work
does not need them. The image therefore needs whatever the commands use (the test runner, the
package manager and network access to its registry if a command installs dependencies).

### Stopping

A container is not a child process of the worker: killing the runtime client does not
reliably stop it. The container's name is derived from the run id, and the worker stops it by
name:

- at `timeoutMinutes` and on worker shutdown: `<runtime> stop -t <grace> <name>` (SIGTERM,
  then SIGKILL after the grace period), then `<runtime> rm -f <name>`, then the client's
  process group as for a host run;
- after every run, `<runtime> rm -f <name>` once more, in case the client died before its
  container;
- if the worker is killed outright, the container keeps running. The runtime's path and the
  container's name were recorded with the run before the container started, so the next
  `updraft start` on the same host removes it (`rm -f`) and marks the run `interrupted`. As
  with recorded pids, a run claimed on a different host is left alone.

`docker ps --filter label=updraft.run` lists the worker's containers.

### Checking the setup

- `updraft validate` checks the shape of `container` without touching the runtime.
- `updraft doctor` checks, for each enabled containerized agent: the runtime is installed and
  answers `info`; the image is present locally; and `<agent cli> --version` runs in the image
  as your uid, with the same scratch home and `container.args`, no mounts and no network. It
  warns about a variable named in `container.env` that is not set where doctor runs. It does
  not check that the agent is signed in.
- `updraft agents` lists the same checks after the host CLIs.

In live mode a failed check is a failure; otherwise a warning.

### An image for Claude Code

This Dockerfile is an **untested starting point**, not a supported image. Add your
repository's toolchain to it.

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# The worker runs the container as its own uid:gid. Some tools want that uid to have a passwd
# entry, so create one that matches the account the worker runs under.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN (getent group "$AGENT_GID" || groupadd --gid "$AGENT_GID" agent) \
 && (getent passwd "$AGENT_UID" || useradd --uid "$AGENT_UID" --gid "$AGENT_GID" --no-create-home agent)

# No ENTRYPOINT: the worker passes the whole command (claude -p ...).
```

```bash
docker build -t my-org/claude-runner:latest \
  --build-arg AGENT_UID="$(id -u)" --build-arg AGENT_GID="$(id -g)" .
```

Notes:

- Authenticate with an API key in the worker's environment (`ANTHROPIC_API_KEY`, named in
  `container.env`). A subscription login lives in `~/.claude`, and the container's home is
  empty on every run.
- Give the agent a Git identity with `agents.<name>.env` (as in the example above); there is
  no `~/.gitconfig` in the container.
- The image needs network access to the model API, so `network: none` does not work for a
  hosted model.

### Platforms

- **Linux and macOS.** Same-path mounts work. With Docker Desktop on macOS, the worktree
  directory (`~/.updraft/worktrees`) and the clone must be inside a path Docker Desktop shares
  with its VM; the default share, `/Users`, covers both.
- **Docker installed as a snap** (Ubuntu) cannot bind-mount hidden directories in your home
  directory, which includes `~/.updraft`. Set `UPDRAFT_HOME` to a path outside them, such as
  `/srv/updraft`, or install Docker from Docker's own packages.
- **The worker itself in a container.** Not supported together with `container`: see
  [In a container](background-operation.md#in-a-container).
- **Windows.** `container` is a validation error on native Windows: a Windows path cannot
  exist inside a Linux container, so the worktree's Git pointer would not resolve. Run the
  worker inside WSL2, with the clone and Updraft's data directory on the WSL filesystem.
- **Rootless Podman.** `--user <uid>:<gid>` then refers to an id inside the user namespace,
  which does not own the worktree. Add `--userns=keep-id` to `container.args`. Untested.
- **Rootless Docker** maps your uid to root inside the container, so running as your uid does
  not give access to your files. Not supported as is.
- **SELinux hosts.** Bind mounts may need `--security-opt label=disable` in `container.args`.
  Untested.

### What it protects against

With the default settings, an agent that has been talked into misbehaving cannot:

- read your home directory, SSH keys, `gh` login, Git credential helpers, cloud credentials,
  or any repository other than the one it is working on;
- use your SSH agent or the container runtime;
- see the worker's `GH_TOKEN`/`GITHUB_TOKEN`, or any worker variable you did not name;
- change the clone's hooks or Git config, or the pointers that decide which config host Git
  uses, and so cannot arrange for code to run on the host through Git;
- push to GitHub, open PRs or comment: it has no GitHub credential. Publication is still done
  by the worker, after the agent has exited;
- outlive its run: the container is removed at the end, on timeout, on shutdown, and by the
  next worker after a crash.

### What it does not protect against

- **The network.** Unless you set `network`, the container is on the runtime's default
  network and can reach the internet, and usually services on your LAN and on the host.
  An agent that reads a hostile issue can send what it can see (the repository, the API key
  below) anywhere. To narrow this, create a network that only reaches an egress proxy with an
  allowlist and name it in `network`.
- **The credentials you pass in.** Every variable named in `container.env` is readable by the
  agent. Use a key that is scoped and capped for this purpose, not your personal one. Anyone
  who may use the runtime on the host can also read the values with `<runtime> inspect` while
  the container runs.
- **The clone's objects and refs.** The agent can write any object and any loose ref in the
  source clone: it can create, move or delete branches and tags other than its own (including
  your local `main` and the remote-tracking refs), write `refs/replace/*` (which changes what
  later checkouts in that clone contain), and fill the disk.
  It cannot rewrite `packed-refs`. The worker fetches the base branch from the remote before
  each job and publishes only the job branch, but if you work in that clone yourself, check
  what you are on before you trust it. A clone dedicated to Updraft avoids the question.
- **The worktree's contents.** Everything in the worktree after a run is the agent's. Running
  it on the host runs the agent's code as you: tests, package manager scripts, a build, an
  editor that executes workspace settings. Review the diff (or the PR) first, or run it in a
  container too. The same goes for Git itself when used by hand in a kept worktree: a nested
  repository's `config` is obeyed by `git status` and `git diff`. Prefer
  `git -c core.fsmonitor=false diff --ignore-submodules=all`, or review the branch from the
  clone or on GitHub instead. Symbolic links in the worktree may point anywhere on the host.
- **Git settings that point into the worktree.** If the clone's `core.hooksPath` (or a filter
  command in its config) names a path inside the repository, such as `.husky`, the hook
  scripts are files the agent can edit on its branch. They run on the host when that branch
  is checked out there.
- **`container.args`.** `--privileged`, `-v /:/host`, `--network host`, mounting the runtime
  socket or `~/.ssh`, `--cap-add`: any of these gives back what the defaults take away. The
  config file is trusted; keep it that way.
- **The runtime and the kernel.** A container shares the host's kernel. A kernel or runtime
  escape defeats it; a VM does not have that problem. With rootful Docker, membership of the
  `docker` group is root on the host, which matters for the account the worker runs under.
- **The image.** Whatever is in the image runs with the API key in its environment.
- **Resources.** No memory, CPU or process limits are set by default. The scratch home is in
  memory and counts against the container's memory. Set limits in `container.args`.
- **Cost.** A contained agent can still spend your API quota until `timeoutMinutes`.

### Reviewer runs

A reviewer run ([The review loop](review-loop.md)) of a containerized agent gets narrower
mounts than a code run: the worktree and its private index are writable (the reviewer may
build and run tests), and the whole git directory of the clone is read-only, including
`objects` and `refs`. Nothing it does can add a commit or a branch to the clone; `git commit`
fails inside the container, while `git diff`, `git log` and `git show` work. The worktree is
deleted after the run in any case, and nothing of a reviewer run is ever pushed.

### A runtime that is not Docker

`container.runtime` may be any program that answers the part of the docker command line
Updraft uses: `run` with the options above, `image inspect`, `container inspect`, `stop`,
`rm -f` and `info`. The AWS MicroVM deployment ships one,
[`deploy/aws-microvm/image/sandbox/updraft-sandbox.mjs`](../deploy/aws-microvm/image/sandbox/updraft-sandbox.mjs).
It needs no daemon. It builds each "container" with bubblewrap on the machine it runs on: new
mount, PID, IPC, UTS and user namespaces, and a root file system made from an allowlist (the
system directories read-only, a filtered `/etc`, and exactly the binds Updraft passes). Its
only "image" is the machine itself, under one fixed name (`microvm`). It refuses any option
it cannot honour instead of ignoring it.

Compared with a container runtime it gives less:

- **The host's software.** The agent runs the host's own tools and libraries, read-only,
  instead of an image's.
- **The network.** It is shared with the host unless `network: none` is set.
- **No resource limits.** There are none at all.
- **The kernel.** It relies on unprivileged user namespaces, so a kernel that does not allow
  them cannot run it, and a kernel exploit defeats it.

The deployment uses it together with a packet filter and a per-job self-test; see "Security
model" in [its README](../deploy/aws-microvm/README.md#security-model). It is written for
that machine. Elsewhere, a real container runtime is the better choice.

## Run the worker under a dedicated account

A separate OS account is a boundary your operating system already enforces. Run the worker,
and therefore every agent, as a user that has nothing worth stealing:

1. **Create the account**, for example `updraft`, as an ordinary user without `sudo`, and not
   in the `docker` group unless it needs it. Make sure your own home directory is not readable
   by it (`chmod 750 ~` or stricter).
2. **Give it its own GitHub identity, scoped to the watched repositories.** Log in as that
   user and run `gh auth login` with a fine-grained personal access token (ideally of a
   machine account, not yours) that is limited to the repositories in the config, with:
   - Metadata: read; Issues: read (to poll events and read issues);
   - for `publish`: Contents, Pull requests and Issues: read and write.

   The worker uses this login to poll and to publish. The agent can find it too
   (`gh auth token`), which is why its scope is the point: the worst it can do with it is
   what that token can do to those repositories. Protect the base branch on GitHub so a
   token with Contents write cannot push to it directly.
3. **Give it its own clones.** Clone each watched repository as that user, with HTTPS and
   `gh auth setup-git` or a deploy key, and point `checkoutPath` at those clones. Do not
   share your working clones with it.
4. **Give it its own agent credentials**: an API key in the launcher's environment (see
   [Agent credentials](background-operation.md#agent-credentials)), or the agent CLI's own
   login done as that user. Use a key you can cap and revoke.
5. **Install the launcher for that user** (see
   [Background operation](background-operation.md)), so the worker starts as `updraft`, not
   as you. Run `updraft doctor` as that user.

What this gives you: the agent cannot read your SSH keys, your `gh` login, your cloud
credentials, your browser profile or your other repositories, because the account cannot.

What it does not give you:

- The agent has the account's GitHub token, and can use it for anything the token allows on
  the watched repositories: push branches, open or close PRs, edit issues.
- The agent has the account's agent credentials and can read and send out the repositories it
  works on. The network is not restricted.
- Everything world-readable on the machine is still readable, and local services listening on
  `localhost` are reachable.
- Agents working on different repositories share the account, so one can read (and change)
  another's clone and worktrees.
- Nothing is cleaned up between runs: files an agent leaves in the account's home, including
  changes to its shell profile, Git config or the agent CLI's settings, are there for the
  next run.

Adding `agents.<name>.container` on top closes most of these: the agent no longer sees the
account's token, home directory or other clones, and the account limits what an escape from
the container (or a mistake in `container.args`) can reach.
