#!/bin/sh
# Prepare an independent AWS build context; never changes or deploys the BYOK image.
set -eu
[ "$#" = 1 ] || { echo 'Usage: package-image.sh NEW-OUTPUT-DIRECTORY' >&2; exit 1; }
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=$1
[ ! -e "$out" ] || { echo 'Output directory must not exist' >&2; exit 1; }
mkdir -p "$out"
cp -R "$here/../image/." "$out/"
# Do not package dependencies from a local checkout into the AWS build artifact.
if [ -d "$out/runner/node_modules" ]; then
  echo 'Remove image/runner/node_modules before packaging' >&2; exit 1
fi
mkdir "$out/native-worker"
cp "$here"/*.mjs "$here"/*.sh "$here"/worker.example.json "$out/native-worker/"
cat >> "$out/Dockerfile" <<'DOCKER'

# Experimental native-subscription worker. No credential data exists at image build time.
RUN set -eu; PM="$(command -v dnf || command -v microdnf)"; \
    "$PM" install -y amazon-efs-utils util-linux; "$PM" clean all
COPY native-worker/ /tmp/native-worker/
COPY sandbox/ /tmp/image/sandbox/
RUN sh /tmp/native-worker/install.sh && rm -rf /tmp/native-worker /tmp/image
ENTRYPOINT ["node", "/opt/updraft/native-worker/hooks.mjs"]
DOCKER
echo 'Prepared native worker context. Supply a current Updraft tarball in vendor/ before building.'
