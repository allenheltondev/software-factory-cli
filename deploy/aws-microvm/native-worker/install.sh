#!/bin/sh
# Run inside a disposable Linux/MicroVM image as root, after installing Updraft and Claude.
# Copies only root-owned code/configuration. No credential synchronization.
set -eu
[ "$(id -u)" = 0 ] || exit 1
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for cmd in node bwrap setpriv findmnt mount.efs; do
  command -v "$cmd" >/dev/null || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
id updraft >/dev/null
[ "$(id -u updraft)" = 1000 ] && [ "$(id -g updraft)" = 1000 ] || exit 1
if ! id updraft-claude >/dev/null 2>&1; then
  useradd --uid 1001 --user-group --no-create-home --home-dir /var/lib/updraft-native-auth/home --shell /bin/sh updraft-claude
fi
[ "$(id -u updraft-claude)" = 1001 ] && [ "$(id -g updraft-claude)" = 1001 ] || exit 1
mkdir -p /opt/updraft/native-worker /opt/updraft/image/sandbox /opt/updraft/bin /var/lib/updraft-jobs
cp "$here"/*.mjs /opt/updraft/native-worker/
npm install --prefix /opt/updraft/native-worker --no-save --package-lock=false --ignore-scripts ws@8.23.0
cp "$here/mount-home.sh" /opt/updraft/native-worker/
cp "$here/../image/sandbox/updraft-sandbox.mjs" /opt/updraft/image/sandbox/
cp "$here/../image/sandbox/egress-proxy.mjs" /opt/updraft/image/sandbox/
# The shim runs inside the sandbox, which mounts only /usr and the job's own paths (#147).
mkdir -p /usr/local/lib/updraft-egress
cp "$here/../image/sandbox/egress-shim.mjs" /usr/local/lib/updraft-egress/
chown -R root:root /usr/local/lib/updraft-egress
chmod 0755 /usr/local/lib/updraft-egress; chmod 0644 /usr/local/lib/updraft-egress/egress-shim.mjs
cp "$here/worker.example.json" /etc/updraft-native-worker.json
node -e 'const fs=require("fs");const p="/etc/updraft-native-worker.json";const c=JSON.parse(fs.readFileSync(p));c.claude=fs.realpathSync(process.argv[1]);fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");' "$(command -v claude)"
printf '{"image":"native-claude-worker"}\n' > /etc/updraft-native-sandbox.json
printf '#!/bin/sh\nexec /usr/local/bin/node /opt/updraft/native-worker/runtime.mjs "$@"\n' > /opt/updraft/bin/updraft-native-worker
chown -R root:root /opt/updraft/native-worker /opt/updraft/image /opt/updraft/bin
chmod 0755 /opt/updraft/bin/updraft-native-worker
chmod 0644 /etc/updraft-native-worker.json /etc/updraft-native-sandbox.json
[ -f /usr/local/lib/node_modules/@allenheltondev/updraft/dist/agents/native-claude-auth.js ] || {
  echo 'Installed Updraft lacks native subscription preflight; build from the current npm pack tarball' >&2; exit 1;
}
echo 'Installed prototype with the resolved official Claude executable path.'
