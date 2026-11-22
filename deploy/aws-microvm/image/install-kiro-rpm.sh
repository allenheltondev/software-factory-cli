#!/bin/sh
set -eu

# The key matches Kiro's published GPG fingerprint. The RPM hash comes from the
# repository metadata verified with that key.
release=https://prod.download.cli.kiro.dev/rpm
package=kiro-cli-3.5.0-1.aarch64.rpm
key_hash=b1aee3f429f660ddf6fb4aae8beda0fe4b1b1c919dbc4afae818744646b0a4c6
rpm_hash=7821d585b429b7df9c56d4ac2b0cf584a568777710760a94dcdb8424443661dd

if ! command -v rpm >/dev/null 2>&1; then
    packages="$(command -v dnf || command -v microdnf)"
    "$packages" install -y rpm
fi

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
cd "$temporary"
curl --proto '=https' --tlsv1.2 -fsS --retry 2 "$release/kiro-cli.gpg" -o kiro-cli.gpg
curl --proto '=https' --tlsv1.2 -fsS --retry 2 "$release/stable/aarch64/$package" -o "$package"
printf '%s  %s\n' "$key_hash" kiro-cli.gpg "$rpm_hash" "$package" | sha256sum -c -
rpm --import kiro-cli.gpg
rpm -K "$package"
rpm -Uvh "$package"
rpm -q kiro-cli
