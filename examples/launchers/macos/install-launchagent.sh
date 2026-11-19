#!/bin/bash
# Installs (or removes) a per-user launchd LaunchAgent that runs `updraft start`.
#
#   bash install-launchagent.sh [options]
#
# Options:
#   --config PATH        Config file (default: per-user config location, see README)
#   --label LABEL        launchd label and plist name (default: local.updraft)
#   --node PATH          node binary (default: `command -v node`)
#   --cli PATH           installed dist/cli.js (default: $(npm root -g)/@allenheltondev/updraft/dist/cli.js)
#   --workdir DIR        working directory (default: the config file's directory)
#   --extra-path DIR     extra directory for the agent's PATH (repeatable)
#   --updraft-home DIR   set UPDRAFT_HOME for the agent (default: current $UPDRAFT_HOME)
#   --no-start           write the plist but do not load it (it loads at next login)
#   --print              print the rendered plist and exit without installing
#   --uninstall          unload the agent and remove its plist
#
# Works with macOS's /bin/bash 3.2. Paths may contain spaces.
set -euo pipefail

HOME_DIR=.updraft
PACKAGE=@allenheltondev/updraft
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)

label=local.updraft
config= node= cli= workdir= mode=install start=1
updraft_home=${UPDRAFT_HOME:-}
extra_path=()

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

while [ $# -gt 0 ]; do
  case $1 in
    --config) config=${2:?--config needs a value}; shift 2 ;;
    --label) label=${2:?--label needs a value}; shift 2 ;;
    --node) node=${2:?--node needs a value}; shift 2 ;;
    --cli) cli=${2:?--cli needs a value}; shift 2 ;;
    --workdir) workdir=${2:?--workdir needs a value}; shift 2 ;;
    --extra-path) extra_path+=("${2:?--extra-path needs a value}"); shift 2 ;;
    --updraft-home) updraft_home=${2:?--updraft-home needs a value}; shift 2 ;;
    --no-start) start=0; shift ;;
    --print) mode=print; shift ;;
    --uninstall) mode=uninstall; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# Absolute path without requiring the file itself to exist.
abspath() {
  local p=$1 d b
  case $p in /*) ;; *) p="$PWD/$p" ;; esac
  d=$(dirname "$p"); b=$(basename "$p")
  if [ -d "$d" ]; then d=$(cd "$d" && pwd -P); fi
  if [ "$d" = / ]; then printf '/%s\n' "$b"; else printf '%s/%s\n' "$d" "$b"; fi
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

uid=$(id -u)
domain="gui/$uid"
plist="$HOME/Library/LaunchAgents/$label.plist"

if [ "$mode" = uninstall ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "Removed LaunchAgent $label ($plist). Config, state and logs are kept."
  exit 0
fi

# --- Per-user locations (mirrors src/paths.ts) ---------------------------------------------
if [ -n "$updraft_home" ]; then
  updraft_home=$(abspath "$updraft_home")
  root="$updraft_home"
else
  root="$HOME/$HOME_DIR"
fi
default_config="$root/config.yaml"
log_dir="$root/logs"

config=$(abspath "${config:-$default_config}")
[ -f "$config" ] || warn "config file not found: $config (run 'updraft configure' or pass --config)"
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

# --- PATH for the agent: launchd starts agents with a minimal PATH -------------------------
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
for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do add_path "$d"; done

for v in "$node" "$cli" "$config" "$workdir" "$path_value" "$updraft_home"; do
  case $v in *$'\n'*) die "paths must not contain newlines" ;; esac
done

# --- Render ---------------------------------------------------------------------------------
template="$SCRIPT_DIR/updraft.plist.template"
[ -f "$template" ] || die "template not found: $template"

render() {
  SF_LABEL=$(xml_escape "$label") \
  SF_NODE=$(xml_escape "$node") \
  SF_CLI=$(xml_escape "$cli") \
  SF_CONFIG=$(xml_escape "$config") \
  SF_WORKDIR=$(xml_escape "$workdir") \
  SF_PATH=$(xml_escape "$path_value") \
  SF_HOME=$(xml_escape "$HOME") \
  SF_LOGDIR=$(xml_escape "$log_dir") \
  SF_UPDRAFT_HOME=$(xml_escape "$updraft_home") \
  awk '
    # Literal (non-regex, no & or \ processing) replacement.
    function repl(s, pat, val,   out, i) {
      out = ""
      while ((i = index(s, pat)) > 0) { out = out substr(s, 1, i - 1) val; s = substr(s, i + length(pat)) }
      return out s
    }
    /<!--__EXTRA_ENV__-->/ {
      if (ENVIRON["SF_UPDRAFT_HOME"] != "") {
        print "    <key>UPDRAFT_HOME</key>"
        print "    <string>" ENVIRON["SF_UPDRAFT_HOME"] "</string>"
      }
      next
    }
    {
      line = $0
      line = repl(line, "__LABEL__", ENVIRON["SF_LABEL"])
      line = repl(line, "__NODE__", ENVIRON["SF_NODE"])
      line = repl(line, "__CLI__", ENVIRON["SF_CLI"])
      line = repl(line, "__CONFIG__", ENVIRON["SF_CONFIG"])
      line = repl(line, "__WORKDIR__", ENVIRON["SF_WORKDIR"])
      line = repl(line, "__PATH__", ENVIRON["SF_PATH"])
      line = repl(line, "__HOME__", ENVIRON["SF_HOME"])
      line = repl(line, "__LOGDIR__", ENVIRON["SF_LOGDIR"])
      print line
    }
  ' "$template"
}

if [ "$mode" = print ]; then render; exit 0; fi

mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
tmp="$plist.tmp.$$"
render > "$tmp"
if command -v plutil >/dev/null 2>&1; then plutil -lint "$tmp" >/dev/null || { rm -f "$tmp"; die "rendered plist failed plutil -lint"; }; fi

# Replace a loaded copy: bootout is asynchronous, so wait for it before bootstrapping again.
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$domain/$label" >/dev/null 2>&1 || break
    sleep 1
  done
fi
mv -f "$tmp" "$plist"
chmod 644 "$plist"

echo "Label:             $label"
echo "Plist:             $plist"
echo "node:              $node"
echo "cli.js:            $cli"
echo "Config:            $config"
echo "Working directory: $workdir"
echo "PATH:              $path_value"
echo "Logs:              $log_dir/launchd.{out,err}.log (worker log: see README)"

if [ "$start" = 1 ]; then
  launchctl enable "$domain/$label"
  launchctl bootstrap "$domain" "$plist"
  echo "Loaded. Check with: launchctl print $domain/$label"
else
  echo "Not loaded (--no-start). It loads at next login, or run: launchctl bootstrap $domain \"$plist\""
fi
