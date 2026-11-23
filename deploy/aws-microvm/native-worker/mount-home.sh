#!/bin/sh
# Root-only, explicit EFS mount. Never copy or inspect Claude's credential files.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
[ "$#" = 2 ] || { echo 'Usage: mount-home.sh fs-ID fsap-ID' >&2; exit 1; }
case "$1" in fs-*) ;; *) exit 1;; esac
case "$2" in fsap-*) ;; *) exit 1;; esac
# IDs are passed as arguments, never evaluated as shell source or mount options.
case "$1$2" in *[!a-z0-9-]*) exit 1;; esac
parent=/var/lib/updraft-native-auth
home=$parent/home
mkdir -p "$parent"
chown 1001:1001 "$parent"
chmod 0700 "$parent"
mkdir -p "$home"
if mountpoint -q "$home"; then
  echo 'Credential home is already mounted; refusing to replace it' >&2
  exit 1
fi
# A failed mount leaves a root-owned, inaccessible directory, never an ephemeral fallback.
chmod 000 "$home"
mount -t efs -o "tls,iam,accesspoint=$2" "$1:/" "$home"
[ "$(findmnt -n -o FSTYPE --mountpoint "$home")" = nfs4 ] || exit 1
[ "$(stat -c %u "$home")" = 1001 ] || exit 1
[ "$(stat -c %a "$home")" = 700 ] || exit 1
echo 'Durable CLI home mounted. No credential files were read.'
