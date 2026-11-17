#!/bin/bash
# Installs (or removes) a `systemd --user` service that runs `factory start`.
#
#   bash install-systemd-user.sh [options]
#
# Options:
#   --config PATH        Config file (default: per-user config location, see README)
#   --name NAME          unit name without .service (default: software-factory)
#   --node PATH          node binary (default: `command -v node`)
#   --cli PATH           installed dist/cli.js (default: $(npm root -g)/software-factory-cli/dist/cli.js)
#   --workdir DIR        working directory (default: the config file's directory)
#   --extra-path DIR     extra directory for the service's PATH (repeatable)
#   --factory-home DIR   set FACTORY_HOME for the service (default: current $FACTORY_HOME)
#   --no-start           install and enable, but do not start now
#   --print              print the rendered unit and exit without installing
#   --uninstall          stop, disable and remove the unit
#
# Lingering (run before login / after logout) is a separate, one-time step:
#   loginctl enable-linger "$USER"
# Hosts without systemd: run `factory start --config <path>` in the foreground under the
# host's existing supervisor instead (see docs/background-operation.md).
set -euo pipefail

APP_DIR=software-factory
PACKAGE=software-factory-cli
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)

name=software-factory
config= node= cli= workdir= mode=install start=1
factory_home=${FACTORY_HOME:-}
extra_path=()

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

while [ $# -gt 0 ]; do
  case $1 in
    --config) config=${2:?--config needs a value}; shift 2 ;;
    --name) name=${2:?--name needs a value}; shift 2 ;;
    --node) node=${2:?--node needs a value}; shift 2 ;;
    --cli) cli=${2:?--cli needs a value}; shift 2 ;;
    --workdir) workdir=${2:?--workdir needs a value}; shift 2 ;;
    --extra-path) extra_path+=("${2:?--extra-path needs a value}"); shift 2 ;;
    --factory-home) factory_home=${2:?--factory-home needs a value}; shift 2 ;;
    --no-start) start=0; shift ;;
    --print) mode=print; shift ;;
    --uninstall) mode=uninstall; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case $name in
  *[!A-Za-z0-9:_.@-]*|'') die "invalid unit name: $name" ;;
esac

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_dir/$name.service"

if [ "$mode" = uninstall ]; then
  systemctl --user disable --now "$name.service" 2>/dev/null || true
  rm -f "$unit_file"
  systemctl --user daemon-reload || true
  echo "Removed $unit_file. Config, state and logs are kept."
  exit 0
fi

# Absolute path without requiring the file itself to exist.
abspath() {
  local p=$1 d b
  case $p in /*) ;; *) p="$PWD/$p" ;; esac
  d=$(dirname "$p"); b=$(basename "$p")
  if [ -d "$d" ]; then d=$(cd "$d" && pwd -P); fi
  if [ "$d" = / ]; then printf '/%s\n' "$b"; else printf '%s/%s\n' "$d" "$b"; fi
}

# Value inside a double-quoted systemd word: escape \ and ", double % (specifiers) and,
# for ExecStart, $ (variable expansion).
q_exec() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g'; }
q_env() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'; }
q_raw() { printf '%s' "$1" | sed -e 's/%/%%/g'; }

# --- Per-user locations (mirrors src/paths.ts) ---------------------------------------------
if [ -n "$factory_home" ]; then
  factory_home=$(abspath "$factory_home")
  default_config="$factory_home/config.yaml"
  log_hint="$factory_home/logs"
else
  default_config="${XDG_CONFIG_HOME:-$HOME/.config}/$APP_DIR/config.yaml"
  log_hint="${XDG_STATE_HOME:-$HOME/.local/state}/$APP_DIR/logs"
fi

config=$(abspath "${config:-$default_config}")
[ -f "$config" ] || warn "config file not found: $config (run 'factory configure' or pass --config)"
workdir=$(abspath "${workdir:-$(dirname "$config")}")

# --- node and the installed cli.js ---------------------------------------------------------
if [ -z "$node" ]; then node=$(command -v node || true); fi
[ -n "$node" ] || die "node not found on PATH; install Node.js 22.13+ or pass --node"
node=$(abspath "$node")
[ -x "$node" ] || die "node is not executable: $node"

if [ -z "$cli" ]; then
  npm_root=$(npm root -g 2>/dev/null || true)
  for candidate in "${npm_root:+$npm_root/$PACKAGE/dist/cli.js}" "$SCRIPT_DIR/../../../dist/cli.js"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then cli=$candidate; break; fi
  done
  [ -n "$cli" ] || die "could not find $PACKAGE/dist/cli.js; run 'npm install -g $PACKAGE' or pass --cli"
fi
cli=$(abspath "$cli")
[ -f "$cli" ] || die "cli.js not found: $cli"

# --- PATH for the service: the user manager's PATH is not your shell's ---------------------
path_value=
add_path() {
  local d=$1
  [ -n "$d" ] || return 0
  case ":$path_value:" in *":$d:"*) return 0 ;; esac
  path_value=${path_value:+$path_value:}$d
}
add_path "$(dirname "$node")"
for tool in git gh; do
  if p=$(command -v "$tool"); then add_path "$(dirname "$(abspath "$p")")"
  else warn "$tool not found on PATH; the worker needs it (use --extra-path)"; fi
done
for agent in codex claude kiro-cli; do
  if p=$(command -v "$agent"); then add_path "$(dirname "$(abspath "$p")")"; fi
done
for d in ${extra_path[@]+"${extra_path[@]}"}; do add_path "$(abspath "$d")"; done
for d in /usr/local/bin /usr/bin /bin; do add_path "$d"; done

for v in "$node" "$cli" "$config" "$workdir" "$path_value" "$factory_home"; do
  case $v in *$'\n'*) die "paths must not contain newlines" ;; esac
done

# --- Render ---------------------------------------------------------------------------------
template="$SCRIPT_DIR/software-factory.service.template"
[ -f "$template" ] || die "template not found: $template"

render() {
  SF_NODE=$(q_exec "$node") \
  SF_CLI=$(q_exec "$cli") \
  SF_CONFIG=$(q_exec "$config") \
  SF_WORKDIR=$(q_raw "$workdir") \
  SF_PATH=$(q_env "$path_value") \
  SF_FACTORY_HOME=$(q_env "$factory_home") \
  awk '
    # Literal (non-regex, no & or \ processing) replacement.
    function repl(s, pat, val,   out, i) {
      out = ""
      while ((i = index(s, pat)) > 0) { out = out substr(s, 1, i - 1) val; s = substr(s, i + length(pat)) }
      return out s
    }
    /^#__EXTRA_ENV__$/ {
      if (ENVIRON["SF_FACTORY_HOME"] != "") print "Environment=\"FACTORY_HOME=" ENVIRON["SF_FACTORY_HOME"] "\""
      next
    }
    {
      line = $0
      line = repl(line, "__NODE__", ENVIRON["SF_NODE"])
      line = repl(line, "__CLI__", ENVIRON["SF_CLI"])
      line = repl(line, "__CONFIG__", ENVIRON["SF_CONFIG"])
      line = repl(line, "__WORKDIR__", ENVIRON["SF_WORKDIR"])
      line = repl(line, "__PATH__", ENVIRON["SF_PATH"])
      print line
    }
  ' "$template"
}

if [ "$mode" = print ]; then render; exit 0; fi

command -v systemctl >/dev/null 2>&1 || die "systemctl not found; run 'factory start' under your host's supervisor instead"

mkdir -p "$unit_dir"
render > "$unit_file.tmp.$$"
mv -f "$unit_file.tmp.$$" "$unit_file"
systemctl --user daemon-reload

echo "Unit:              $unit_file"
echo "node:              $node"
echo "cli.js:            $cli"
echo "Config:            $config"
echo "Working directory: $workdir"
echo "PATH:              $path_value"
echo "Logs:              journalctl --user -u $name, plus the worker log under $log_hint"

if [ "$start" = 1 ]; then
  systemctl --user enable "$name.service"
  systemctl --user restart "$name.service"
  echo "Started. Check with: systemctl --user status $name"
else
  systemctl --user enable "$name.service"
  echo "Enabled; starts at next login (or: systemctl --user start $name)."
fi

if command -v loginctl >/dev/null 2>&1; then
  linger=$(loginctl show-user "${USER:-$(id -un)}" --property=Linger --value 2>/dev/null || true)
  if [ "$linger" != yes ]; then
    echo "Note: lingering is off, so the service stops when you log out."
    echo "      To run before login and after logout: loginctl enable-linger \"${USER:-$(id -un)}\""
  fi
fi
