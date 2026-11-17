# Background operation

`factory start` is a long-running foreground process. Installing the npm package does not
start it; you choose when and how it runs in the background. The package ships example
launchers under `examples/launchers/` (inside the installed package at
`$(npm root -g)/software-factory-cli/examples/launchers`).

| Environment | Launcher | Files |
| --- | --- | --- |
| Windows | Task Scheduler task at logon, under your account | `windows/register-task.ps1`, `windows/unregister-task.ps1` |
| macOS | Per-user `launchd` LaunchAgent | `macos/software-factory.plist.template`, `macos/install-launchagent.sh` |
| Linux with systemd | `systemd --user` service | `linux/software-factory.service.template`, `linux/install-systemd-user.sh` |
| Other Linux hosts | Your existing process supervisor | see [below](#other-hosts) |

Every launcher:

- runs `node <installed package>/dist/cli.js start --config <absolute path>` directly, not
  npm's `factory` shim, with fully qualified paths;
- sets the working directory (default: the config file's directory);
- sets `PATH` to include the directories of `node`, `git`, `gh` and any agent CLIs
  (`codex`, `claude`, `kiro-cli`) found when you install it, because a background process does
  not get your terminal's PATH. Add more with `-ExtraPath` / `--extra-path`;
- passes `FACTORY_HOME` through if you use it;
- restarts the worker after a crash, and only ever runs one copy.

The worker holds a lock in the state database, so a second `factory start` against the same
state exits with code 3 instead of polling twice. Launchers treat that as a failure and retry
on their restart interval, so a launcher-started worker takes over once a terminal-started one
stops or its lock goes stale. After a restart the worker resumes from the saved checkpoints;
already-queued jobs are not duplicated.

Re-run the install script after upgrading Node.js to a new install location or moving the
package. Upgrading the package in place (`npm install -g software-factory-cli`) keeps the same
`cli.js` path; restart the launcher to pick up the new version.

## Check the environment first

A background process can see a different PATH and credential context than your terminal.
Before relying on a launcher, run `factory doctor` with the same config and, where possible,
the same environment the launcher uses:

```sh
factory doctor --config "/path/to/config.yaml"
```

`gh` must be signed in for the same user account (`gh auth status`). If `gh` stores its token
in the OS keychain, that keychain must be available to the background process; this is the
case for the interactive logon task on Windows and for a LaunchAgent on macOS. On Linux with
lingering enabled, the service may run without a desktop keyring; see
[Linux](#linux-systemd---user).

## Logs

| Platform | Worker log | Launcher stdout/stderr |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\software-factory\logs\factory.log` | `launcher.out.log`, `launcher.err.log` in the same directory (previous run kept as `*.prev`) |
| macOS | `~/Library/Logs/software-factory/factory.log` | `~/Library/Logs/software-factory/launchd.out.log`, `launchd.err.log` |
| Linux | `~/.local/state/software-factory/logs/factory.log` | `journalctl --user -u software-factory` |

With `FACTORY_HOME` set, the worker log is `$FACTORY_HOME/logs/factory.log` (and the Windows
launcher logs go there too).

## Windows (Task Scheduler)

Run from a normal, non-elevated PowerShell window as the user who should run the worker:

```powershell
$launchers = Join-Path (npm root -g) 'software-factory-cli\examples\launchers\windows'
powershell -NoProfile -ExecutionPolicy Bypass -File "$launchers\register-task.ps1"
# or with options:
powershell -NoProfile -ExecutionPolicy Bypass -File "$launchers\register-task.ps1" `
  -ConfigPath "D:\My Configs\factory.yaml" -TaskName "SoftwareFactory" -ExtraPath "C:\Tools\bin"
```

Add `-WhatIf` to see the resolved paths without registering anything, and `-NoStart` to
register without starting now.

What it creates:

- A task (default name `SoftwareFactory`) triggered at logon of your account, with an
  interactive logon type, so no password is stored and the worker uses your credential
  context (gh token, Git Credential Manager).
- Settings: restart on failure (999 times, every minute), `MultipleInstances = IgnoreNew`,
  no execution time limit (`PT0S`), start when available, keep running on battery.
- A generated wrapper, `%LOCALAPPDATA%\software-factory\launcher\<TaskName>.ps1`. Task
  Scheduler cannot set environment variables or capture output, so the task runs
  `powershell.exe -WindowStyle Hidden -File <wrapper>`; the wrapper sets PATH, starts
  `node.exe` with the installed `dist\cli.js`, redirects its output to `launcher.*.log` and
  exits with the worker's exit code so a failure triggers the restart policy.

Manage it with:

```powershell
Get-ScheduledTaskInfo -TaskName SoftwareFactory   # LastTaskResult, NextRunTime
Start-ScheduledTask   -TaskName SoftwareFactory
Stop-ScheduledTask    -TaskName SoftwareFactory
powershell -NoProfile -ExecutionPolicy Bypass -File "$launchers\unregister-task.ps1"
```

`unregister-task.ps1` stops and removes the task, stops a leftover worker process started by
the wrapper, and deletes the wrapper. Config, state and logs are kept. The wrapper records the
worker's PID, start time and executable in `launcher\<TaskName>.worker.json`, and unregister
stops a process only when all three match, so a `factory start` you run by hand is never
stopped, even with the same CLI and config.

Notes:

- A console window can flash briefly at logon. If Windows Terminal is set as the default
  terminal application and a window stays open, closing it stops the worker; set the default
  terminal to Windows Console Host or leave the window minimized.
- Test the restart policy once: start the task, end the `node.exe` process in Task Manager,
  and check that it comes back within a minute.
- Use one execution environment for the worker, checkouts and agents. To run the Linux setup
  inside WSL2 instead, keep the repos, binaries and credentials inside WSL and use the
  systemd launcher there (enable systemd in `/etc/wsl.conf`).

## macOS (LaunchAgent)

```sh
launchers="$(npm root -g)/software-factory-cli/examples/launchers/macos"
bash "$launchers/install-launchagent.sh"
# or with options:
bash "$launchers/install-launchagent.sh" --config "$HOME/My Configs/factory.yaml" --extra-path /opt/tools/bin
```

The script fills `software-factory.plist.template` (XML-escaping every value), writes
`~/Library/LaunchAgents/local.software-factory.plist`, checks it with `plutil -lint`, and
loads it with `launchctl bootstrap gui/$(id -u)`. Use `--print` to see the rendered plist
without installing, `--no-start` to install without loading, and `--label` to change the
label.

The agent has explicit `ProgramArguments` (node, cli.js, `start`, `--config`, path),
`RunAtLoad`, `KeepAlive` with `SuccessfulExit = false` (restart after a crash or non-zero
exit, 30-second throttle), a `PATH` in `EnvironmentVariables`, and stdout/stderr under
`~/Library/Logs/software-factory/`.

```sh
launchctl print gui/$(id -u)/local.software-factory    # state, pid, last exit code
launchctl kickstart -k gui/$(id -u)/local.software-factory   # restart
bash "$launchers/install-launchagent.sh" --uninstall
```

If repositories live under `~/Documents`, `~/Desktop` or another protected folder, macOS may
block background access until node is granted access in System Settings > Privacy & Security.

## Linux (systemd --user)

```sh
launchers="$(npm root -g)/software-factory-cli/examples/launchers/linux"
bash "$launchers/install-systemd-user.sh"
# or with options:
bash "$launchers/install-systemd-user.sh" --config "$HOME/My Configs/factory.yaml" --name software-factory
```

The script fills `software-factory.service.template` (quoting paths and escaping `%`, `$`,
`"` and `\` for systemd), writes `~/.config/systemd/user/software-factory.service`, runs
`daemon-reload`, then enables and starts it. Use `--print` to see the unit without
installing and `--no-start` to enable without starting.

The unit uses `Restart=on-failure` with `RestartSec=30`, an explicit
`Environment="PATH=..."`, `WorkingDirectory=`, and `KillMode=mixed` so the worker receives
SIGTERM and can stop gracefully before anything left over is killed.

```sh
systemctl --user status software-factory
journalctl --user -u software-factory -f
bash "$launchers/install-systemd-user.sh" --uninstall
```

A user service runs only while you have a session. To run jobs before login and after
logout, enable lingering once:

```sh
loginctl enable-linger "$USER"
```

With lingering and no desktop session, a keyring-backed `gh` token may be unavailable. Check
with `systemd-run --user --wait --pipe gh auth status`; if it fails, sign in with
`gh auth login --insecure-storage` so the token is stored in `~/.config/gh/hosts.yml`
(readable only by you).

## Other hosts

On a Linux host without systemd (or in a container), run the worker in the foreground under
the supervisor the host already uses, with the same explicit arguments:

```sh
/usr/local/bin/node /usr/local/lib/node_modules/software-factory-cli/dist/cli.js \
  start --config "/home/me/.config/software-factory/config.yaml"
```

The supervisor should run it as your user, set the working directory and `PATH`, restart it on
non-zero exit, send SIGTERM to stop it, and capture stdout/stderr. For example, with
supervisord:

```ini
[program:software-factory]
command=/usr/local/bin/node /usr/local/lib/node_modules/software-factory-cli/dist/cli.js start --config "/home/me/.config/software-factory/config.yaml"
directory=/home/me/.config/software-factory
user=me
environment=PATH="/usr/local/bin:/usr/bin:/bin",HOME="/home/me"
autorestart=unexpected
stopsignal=TERM
stopwaitsecs=60
```

Run only one worker per state directory.
