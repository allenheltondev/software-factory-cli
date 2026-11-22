#!/bin/sh
set -eu

# https://kiro.dev/docs/getting-started/installation.md#amazon-linux-2023-and-2027-rpm-repository
repo_url=https://prod.download.cli.kiro.dev/rpm
repo_file=/etc/yum.repos.d/kiro-cli.repo
fingerprint=9600944AF4B40FA81C3F6EE8724E8BC8D4F7DD61

packages="$(command -v dnf || command -v microdnf)"
if ! command -v dnf >/dev/null 2>&1; then
    "$packages" install -y dnf
fi
if ! command -v gpg >/dev/null 2>&1 && ! command -v gpg2 >/dev/null 2>&1; then
    dnf install -y gnupg2-minimal
fi
gpg="$(command -v gpg || command -v gpg2)"

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --proto '=https' --tlsv1.2 -fsS "$repo_url/kiro-cli.gpg" -o "$temporary/kiro-cli.gpg"
"$gpg" --batch --homedir "$temporary" --with-colons --show-keys "$temporary/kiro-cli.gpg" > "$temporary/key-info"
# Accept exactly one primary key, with Kiro's published fingerprint.
published="$(awk -F: '$1 == "pub" { primary = 1 } $1 == "fpr" && primary { print $10; primary = 0 }' "$temporary/key-info")"
if [ "$published" != "$fingerprint" ]; then
    echo 'Kiro RPM repository signing key does not match the published fingerprint' >&2
    exit 1
fi

cat > "$repo_file" <<EOF
[kiro-cli]
name=Kiro CLI
baseurl=$repo_url/stable/\$basearch/
enabled=0
gpgcheck=1
repo_gpgcheck=1
gpgkey=file://$temporary/kiro-cli.gpg
EOF
trap 'rm -f "$repo_file"; rm -rf "$temporary"' EXIT
dnf install -y --enablerepo=kiro-cli kiro-cli
rpm -q kiro-cli
dnf clean all
