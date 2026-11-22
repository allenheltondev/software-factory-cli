#!/usr/bin/env bash
# Deploys Updraft on AWS Lambda MicroVMs. See README.md.
#
#   ./deploy.sh            everything: stack, then config (if ./config/config.yaml exists), then image
#   ./deploy.sh stack      build and deploy the SAM stack
#   ./deploy.sh config     upload ./config/ to s3://<bucket>/config/
#   ./deploy.sh image      package ./image/, create or update the MicroVM image, wait for the build
#   ./deploy.sh status     stack outputs, image state, microVMs of the image
#   ./deploy.sh state info        what the shared state database in S3 is: size, date, versions
#   ./deploy.sh state pull [dir]  download it (and the config) into dir, laid out as an Updraft
#                                 home, for `UPDRAFT_HOME=dir updraft status` (default: ./updraft-state)
#   ./deploy.sh state unsaved     list the backups of jobs whose state could not be saved:
#                                 complete ones (with a manifest) and incomplete ones
#   ./deploy.sh state recover <delivery id> [attempt id]
#                                 verify such a backup against its manifest and merge it into
#                                 the shared database (needs `updraft` and `node` here)
#
# Settings come from the environment; nothing is hard-coded:
#
#   STACK_NAME        CloudFormation stack name                      (default: updraft-microvm)
#   IMAGE_NAME        MicroVM image name                             (default: updraft-job)
#   AWS_REGION        region (else AWS_DEFAULT_REGION, else the CLI's configured region)
#   IMAGE_ARCH        ARM_64 or X86_64                               (default: ARM_64)
#   IMAGE_MEMORY_MIB  baseline memory of a microVM                   (default: 4096)
#   BASE_IMAGE_ARN    Lambda-managed MicroVM base image
#                     (default: arn:aws:lambda:<region>:aws:microvm-image:al2023-1)
#   BASE_IMAGE_VERSION  pin a base image version                     (default: latest)
#   NODE_VERSION, UPDRAFT_SPEC, AGENT_PACKAGES, TOOL_PACKAGES,
#   SYSTEM_PACKAGES, PYTHON_COMMAND, UV_VERSION, BROWSER_PACKAGES,
#   PLAYWRIGHT_VERSION, PLAYWRIGHT_BROWSERS,
#   REQUIRE_STATE_COMMANDS, ISOLATION_PACKAGES                   override image/build.env
#   UPDRAFT_TARBALL   path of an `npm pack` tarball to install instead of UPDRAFT_SPEC
#   BUILD_TIMEOUT_SECONDS  how long to wait for the image build      (default: 2400)
#   SAM_PARAMETER_OVERRIDES  extra template parameters, e.g.
#                     "MaximumDurationSeconds=5400 TriggerLabels=ready"
#   STATE_KEY         key of the shared state database             (default: state/state.db)
#   UPDRAFT_BIN       the updraft command `state recover` merges with  (default: updraft)
#
# The MicroVM image is created with the AWS CLI rather than by the template; README.md
# ("Why the image is not in the template") explains why.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_NAME="${STACK_NAME:-updraft-microvm}"
IMAGE_NAME="${IMAGE_NAME:-updraft-job}"
IMAGE_ARCH="${IMAGE_ARCH:-ARM_64}"
IMAGE_MEMORY_MIB="${IMAGE_MEMORY_MIB:-4096}"
BUILD_TIMEOUT_SECONDS="${BUILD_TIMEOUT_SECONDS:-2400}"
HOOK_PORT=9000

die() { echo "deploy.sh: $*" >&2; exit 1; }
say() { echo "==> $*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
if [ -z "$REGION" ]; then
  need aws
  REGION="$(aws configure get region 2>/dev/null || true)"
fi
[ -n "$REGION" ] || die "no region: set AWS_REGION"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1}"

case "$IMAGE_NAME" in *[!a-zA-Z0-9_-]*|'') die "IMAGE_NAME may only contain letters, digits, - and _" ;; esac
case "$IMAGE_ARCH" in ARM_64|X86_64) ;; *) die "IMAGE_ARCH must be ARM_64 or X86_64" ;; esac
case "$IMAGE_MEMORY_MIB" in *[!0-9]*|'') die "IMAGE_MEMORY_MIB must be a number" ;; esac

stack_output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

deploy_stack() {
  need aws; need sam
  say "building the launcher (sam build)"
  (cd "$HERE" && sam build --template-file template.yaml)
  say "deploying stack $STACK_NAME in $REGION"
  # shellcheck disable=SC2086  # SAM_PARAMETER_OVERRIDES is a list of Key=Value words
  (cd "$HERE" && sam deploy \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --resolve-s3 \
    --capabilities CAPABILITY_IAM \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset \
    --parameter-overrides "ImageName=$IMAGE_NAME" ${SAM_PARAMETER_OVERRIDES:-})
  say "webhook URL: $(stack_output WebhookUrl)"
}

upload_config() {
  need aws
  [ -f "$HERE/config/config.yaml" ] || die "config/config.yaml does not exist; copy config/config.example.yaml and edit it"
  local bucket
  bucket="$(stack_output BucketName)"
  [ -n "$bucket" ] && [ "$bucket" != "None" ] || die "stack $STACK_NAME has no BucketName output; run ./deploy.sh stack first"
  say "uploading config/ to s3://$bucket/config/"
  aws s3 sync "$HERE/config/" "s3://$bucket/config/" --delete --exclude '*.example.*' --exclude '.*'
}

# Prints the state of one image version (PENDING, IN_PROGRESS, SUCCESSFUL, FAILED).
version_state() {
  aws lambda-microvms get-microvm-image-version \
    --image-identifier "$IMAGE_NAME" --image-version "$1" --query state --output text
}

build_image() {
  need aws; need zip
  local bucket build_role log_group
  bucket="$(stack_output BucketName)"
  build_role="$(stack_output BuildRoleArn)"
  log_group="$(stack_output MicrovmLogGroup)"
  [ -n "$bucket" ] && [ "$bucket" != "None" ] || die "stack $STACK_NAME has no BucketName output; run ./deploy.sh stack first"

  local stage
  stage="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$stage'" EXIT
  mkdir -p "$stage/context"
  cp -R "$HERE/image/." "$stage/context/"
  rm -rf "$stage/context/runner/node_modules"

  if [ -n "${UPDRAFT_TARBALL:-}" ]; then
    [ -f "$UPDRAFT_TARBALL" ] || die "UPDRAFT_TARBALL=$UPDRAFT_TARBALL does not exist"
    rm -f "$stage/context/vendor/"*.tgz
    cp "$UPDRAFT_TARBALL" "$stage/context/vendor/"
    say "the image will install Updraft from $(basename "$UPDRAFT_TARBALL")"
  fi

  # Values from the environment win over the defaults in image/build.env.
  {
    [ -z "${NODE_VERSION:-}" ] || printf 'NODE_VERSION="%s"\n' "$NODE_VERSION"
    [ -z "${UPDRAFT_SPEC:-}" ] || printf 'UPDRAFT_SPEC="%s"\n' "$UPDRAFT_SPEC"
    [ -z "${AGENT_PACKAGES+set}" ] || printf 'AGENT_PACKAGES="%s"\n' "$AGENT_PACKAGES"
    [ -z "${TOOL_PACKAGES+set}" ] || printf 'TOOL_PACKAGES="%s"\n' "$TOOL_PACKAGES"
    [ -z "${SYSTEM_PACKAGES+set}" ] || printf 'SYSTEM_PACKAGES="%s"\n' "$SYSTEM_PACKAGES"
    [ -z "${PYTHON_COMMAND+set}" ] || printf 'PYTHON_COMMAND="%s"\n' "$PYTHON_COMMAND"
    [ -z "${UV_VERSION+set}" ] || printf 'UV_VERSION="%s"\n' "$UV_VERSION"
    [ -z "${BROWSER_PACKAGES+set}" ] || printf 'BROWSER_PACKAGES="%s"\n' "$BROWSER_PACKAGES"
    [ -z "${PLAYWRIGHT_VERSION+set}" ] || printf 'PLAYWRIGHT_VERSION="%s"\n' "$PLAYWRIGHT_VERSION"
    [ -z "${PLAYWRIGHT_BROWSERS+set}" ] || printf 'PLAYWRIGHT_BROWSERS="%s"\n' "$PLAYWRIGHT_BROWSERS"
    [ -z "${REQUIRE_STATE_COMMANDS:-}" ] || printf 'REQUIRE_STATE_COMMANDS="%s"\n' "$REQUIRE_STATE_COMMANDS"
    [ -z "${ISOLATION_PACKAGES+set}" ] || printf 'ISOLATION_PACKAGES="%s"\n' "$ISOLATION_PACKAGES"
  } >> "$stage/context/build.env"

  local stamp key uri
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  key="image/context-${stamp}.zip"
  uri="s3://${bucket}/${key}"
  (cd "$stage/context" && zip -q -r "$stage/context.zip" .)
  say "uploading the build context to $uri"
  aws s3 cp "$stage/context.zip" "$uri" --only-show-errors

  # The request, in the API's own field names (CreateMicrovmImage / UpdateMicrovmImage).
  # Hooks: Lambda POSTs to /aws/lambda-microvms/runtime/v1/<hook> on HOOK_PORT.
  # additionalOsCapabilities: without it root in the microVM has only the container-default
  # capabilities (no CAP_NET_ADMIN), so the packet filter cannot be installed and every job
  # with AgentIsolation=enforced is refused. Sent on updates too, or the new version lacks it.
  local base_version_line=""
  if [ -n "${BASE_IMAGE_VERSION:-}" ]; then
    base_version_line="\"baseImageVersion\": \"${BASE_IMAGE_VERSION}\","
  fi
  local common
  common=$(cat <<JSON
  "baseImageArn": "${BASE_IMAGE_ARN}",
  ${base_version_line}
  "buildRoleArn": "${build_role}",
  "codeArtifact": { "uri": "${uri}" },
  "description": "Updraft job runner, built ${stamp}",
  "cpuConfigurations": [ { "architecture": "${IMAGE_ARCH}" } ],
  "resources": [ { "minimumMemoryInMiB": ${IMAGE_MEMORY_MIB} } ],
  "logging": { "cloudWatch": { "logGroup": "${log_group}" } },
  "additionalOsCapabilities": [ "ALL" ],
  "hooks": {
    "port": ${HOOK_PORT},
    "microvmImageHooks": { "ready": "ENABLED", "readyTimeoutInSeconds": 300 },
    "microvmHooks": {
      "run": "ENABLED", "runTimeoutInSeconds": 60,
      "terminate": "ENABLED", "terminateTimeoutInSeconds": 60,
      "suspend": "ENABLED", "suspendTimeoutInSeconds": 30
    }
  }
JSON
)

  local version
  if aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_NAME" >/dev/null 2>"$stage/get.err"; then
    say "updating MicroVM image $IMAGE_NAME"
    printf '{\n  "imageIdentifier": "%s",\n%s\n}\n' "$IMAGE_NAME" "$common" > "$stage/request.json"
    version="$(aws lambda-microvms update-microvm-image \
      --cli-input-json "file://$stage/request.json" --query imageVersion --output text)"
  elif grep -q "ResourceNotFound" "$stage/get.err"; then
    say "creating MicroVM image $IMAGE_NAME"
    printf '{\n  "name": "%s",\n  "tags": { "updraft:stack": "%s" },\n%s\n}\n' "$IMAGE_NAME" "$STACK_NAME" "$common" > "$stage/request.json"
    version="$(aws lambda-microvms create-microvm-image \
      --cli-input-json "file://$stage/request.json" --query imageVersion --output text)"
  else
    cat "$stage/get.err" >&2
    die "cannot look up MicroVM image $IMAGE_NAME"
  fi
  [ -n "$version" ] && [ "$version" != "None" ] || die "the API returned no image version"

  say "waiting for version $version to build (logs: aws logs tail $log_group --follow)"
  local waited=0 state=""
  while :; do
    state="$(version_state "$version" 2>/dev/null || echo UNKNOWN)"
    case "$state" in
      SUCCESSFUL) break ;;
      FAILED)
        aws lambda-microvms get-microvm-image-version \
          --image-identifier "$IMAGE_NAME" --image-version "$version" --query stateReason --output text >&2 || true
        die "image version $version failed to build; see the log group $log_group" ;;
    esac
    [ "$waited" -lt "$BUILD_TIMEOUT_SECONDS" ] || die "image version $version is still $state after ${BUILD_TIMEOUT_SECONDS}s"
    sleep 15
    waited=$((waited + 15))
    echo "    $state (${waited}s)"
  done
  say "image $IMAGE_NAME version $version is built"
  aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_NAME" \
    --query '{state: state, latestActiveImageVersion: latestActiveImageVersion, imageArn: imageArn}' --output table  || true
}

show_status() {
  need aws
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[].[OutputKey, OutputValue]' --output table
  aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_NAME" \
    --query '{state: state, latestActiveImageVersion: latestActiveImageVersion, latestFailedImageVersion: latestFailedImageVersion}' \
    --output table || true
  aws lambda-microvms list-microvms --image-identifier "$IMAGE_NAME" \
    --query 'items[].[microvmId, state, startedAt]' --output table || true
}

# The bucket and key of the shared state database, in $STATE_BUCKET and $STATE_KEY.
state_location() {
  need aws
  STATE_BUCKET="$(stack_output BucketName)"
  [ -n "$STATE_BUCKET" ] && [ "$STATE_BUCKET" != "None" ] || die "stack $STACK_NAME has no BucketName output; run ./deploy.sh stack first"
  STATE_KEY="${STATE_KEY:-state/state.db}"
}

state_info() {
  state_location
  say "s3://$STATE_BUCKET/$STATE_KEY"
  if ! aws s3api head-object --bucket "$STATE_BUCKET" --key "$STATE_KEY" \
      --query '{bytes: ContentLength, lastModified: LastModified, etag: ETag, versionId: VersionId}' --output table 2>/dev/null; then
    echo "    no state database yet (no job has saved one), or no permission to read it"
    return 0
  fi
  # Every write by a job is a new version; old ones expire after StateVersionRetentionDays.
  local count
  count="$(aws s3api list-object-versions --bucket "$STATE_BUCKET" --prefix "$STATE_KEY" \
    --query "length(Versions[?Key=='$STATE_KEY'] || \`[]\`)" --output text)"
  echo "    versions kept: $count"
  aws s3api list-object-versions --bucket "$STATE_BUCKET" --prefix "$STATE_KEY" --max-items 10 \
    --query "Versions[?Key=='$STATE_KEY'].[LastModified, Size, VersionId, IsLatest]" --output table || true
}

# Downloads the state database (and the config it belongs to) into a directory that Updraft
# reads as its home. A copy for reading: nothing done to it locally is ever uploaded.
state_pull() {
  state_location
  local dir="${1:-$PWD/updraft-state}"
  mkdir -p "$dir"
  # A write-ahead log left by an earlier look at an earlier copy must not be replayed onto
  # the new file.
  rm -f "$dir/state.db" "$dir/state.db-wal" "$dir/state.db-shm"
  say "downloading s3://$STATE_BUCKET/$STATE_KEY to $dir/state.db"
  aws s3 cp "s3://$STATE_BUCKET/$STATE_KEY" "$dir/state.db" --only-show-errors \
    || die "no state database at s3://$STATE_BUCKET/$STATE_KEY (no job has saved one yet?)"
  # status and stats read the config for names and settings. The App's private key is not
  # downloaded, so nothing run against this directory can act on GitHub as the App.
  say "downloading the config from s3://$STATE_BUCKET/config/"
  aws s3 sync "s3://$STATE_BUCKET/config/" "$dir/" --exclude 'state.db*' --only-show-errors
  cat <<NOTE
==> a copy of the fleet's state as of now. Read it with:
      UPDRAFT_HOME="$dir" updraft status
      UPDRAFT_HOME="$dir" updraft stats
    Changes made to this copy are NOT pushed back; run 'state pull' again for a newer one.
    Do not run 'updraft start' or 'updraft run-event' against it.
NOTE
}

# Where the runner keeps the database of a job whose final state sync failed.
unsaved_prefix() {
  case "$STATE_KEY" in */*) echo "${STATE_KEY%/*}/unsaved" ;; *) echo "unsaved" ;; esac
}

# Every key under the unsaved prefix, one per line (nothing when there are none).
unsaved_keys() {
  local out
  out="$(aws s3api list-objects-v2 --bucket "$STATE_BUCKET" --prefix "$1" --query 'Contents[].Key' --output text)" \
    || die "could not list s3://$STATE_BUCKET/$1"
  printf '%s\n' "$out" | tr '\t' '\n' | grep -v -e '^None$' -e '^$' || true
}

# A backup is one attempt's directory: <prefix>/<delivery id>/<attempt id>/ holding base.db
# (unless the job started from nothing), changed.db and, written last, manifest.json. It is
# complete when the manifest is there. Anything else cannot be told apart from an upload that
# stopped half-way, and `state recover` does not touch it.
state_unsaved() {
  state_location
  local prefix keys attempts a files
  prefix="$(unsaved_prefix)"
  say "s3://$STATE_BUCKET/$prefix/"
  keys="$(unsaved_keys "$prefix/")"
  if [ -z "$keys" ]; then
    echo "    none: no job has failed to save its state (or the backups have expired)"
    return 0
  fi
  attempts="$(printf '%s\n' "$keys" | sed -n "s|^$prefix/\([A-Za-z0-9-]\{1,\}\)/\([A-Za-z0-9-]\{1,\}\)/[^/]\{1,\}\$|\1/\2|p" | sort -u)"
  echo "    complete (./deploy.sh state recover <delivery id> [attempt id]):"
  for a in $attempts; do
    if printf '%s\n' "$keys" | grep -qxF "$prefix/$a/manifest.json"; then
      echo "      delivery ${a%%/*}  attempt ${a##*/}"
    fi
  done
  echo "    incomplete (no manifest: the upload did not finish; not recoverable with this command):"
  for a in $attempts; do
    if ! printf '%s\n' "$keys" | grep -qxF "$prefix/$a/manifest.json"; then
      files="$(printf '%s\n' "$keys" | sed -n "s|^$prefix/$a/||p" | tr '\n' ' ')"
      echo "      delivery ${a%%/*}  attempt ${a##*/}  has: $files"
    fi
  done
  # Written by an earlier version of the runner, which kept no manifest.
  printf '%s\n' "$keys" | sed -n "s|^$prefix/\([^/]*\.db\)\$|      \1  (old layout, no manifest)|p"
}

# Reads and checks a backup's manifest, and checks a downloaded file against it. Kept in one
# small Node program because the checks are on JSON, sizes and SHA-256 checksums; Node is
# here wherever `updraft` is.
write_manifest_tool() {
  cat > "$1" <<'JS'
import crypto from 'node:crypto';
import fs from 'node:fs';
const [command, manifestFile, ...rest] = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
let m;
try {
  m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
} catch (error) {
  fail(`the manifest is not JSON (${error.message})`);
}
const entry = (e, name, key) => {
  if (e === null || typeof e !== 'object') fail(`the manifest has no "${name}" entry`);
  if (e.key !== key) fail(`the manifest's ${name} key is ${JSON.stringify(e.key)}, not ${key}`);
  if (!Number.isInteger(e.bytes) || e.bytes <= 0) fail(`the manifest's ${name} size is not a positive number`);
  if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) fail(`the manifest's ${name} checksum is not a SHA-256`);
};
if (command === 'read') {
  const [delivery, attempt, dir] = rest;
  if (m === null || typeof m !== 'object' || m.version !== 1) fail(`the manifest is version ${JSON.stringify(m?.version)}; this command reads version 1`);
  if (m.deliveryId !== delivery) fail(`the manifest is for delivery ${JSON.stringify(m.deliveryId)}, not ${delivery}`);
  if (m.attemptId !== attempt) fail(`the manifest is for attempt ${JSON.stringify(m.attemptId)}, not ${attempt}`);
  if (typeof m.startedEmpty !== 'boolean') fail('the manifest does not say whether the job started from an empty state (startedEmpty)');
  entry(m.changed, 'changed', `${dir}/changed.db`);
  if (m.base === null) {
    if (m.startedEmpty !== true) fail('the manifest names no base snapshot and does not say that the job started from an empty state');
  } else {
    if (m.startedEmpty !== false) fail('the manifest names a base snapshot and says that the job started from an empty state');
    entry(m.base, 'base', `${dir}/base.db`);
  }
  console.log(m.startedEmpty ? 'empty' : 'base');
} else if (command === 'verify') {
  const [name, file] = rest;
  const e = m[name];
  const body = fs.readFileSync(file);
  if (body.length !== e.bytes) fail(`${name}.db is ${body.length} bytes; the manifest says ${e.bytes}`);
  const sum = crypto.createHash('sha256').update(body).digest('hex');
  if (sum !== e.sha256) fail(`the SHA-256 of ${name}.db is ${sum}; the manifest says ${e.sha256}`);
  if (body.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') fail(`${name}.db is not a SQLite database`);
} else {
  fail(`unknown command ${command}`);
}
JS
}

# Merges what one job changed, and could not save, into the shared database: the same
# three-way merge and the same conditional write the runner uses, from this machine. Safe to
# repeat: merging the same database twice adds nothing.
#
# Only from a complete backup, and only as its manifest says. The base snapshot is what makes
# the merge exact: without it every row of the backup counts as that job's, and rows of other
# runs that the job merely started with would be written over what those runs did since. So
# the merge goes without a base only when the manifest says the job started from an empty
# state; a base that is missing, unreadable or not the one the manifest describes ends the
# command. There is no way to skip that.
state_recover() {
  state_location
  local delivery="${1:-}" attempt="${2:-}" updraft="${UPDRAFT_BIN:-updraft}"
  [ -n "$delivery" ] || die "usage: ./deploy.sh state recover <delivery id> [attempt id]   (./deploy.sh state unsaved lists them)"
  case "$delivery" in *[!A-Za-z0-9-]*) die "not a delivery id: $delivery" ;; esac
  case "$attempt" in *[!A-Za-z0-9-]*) die "not an attempt id: $attempt" ;; esac
  need "$updraft"; need node
  "$updraft" state merge --help 2>/dev/null | grep -q -- '--base' \
    || die "$updraft has no 'state merge' command; install the Updraft version the image uses, or set UPDRAFT_BIN"
  local prefix work out etag try keys complete dir mode
  prefix="$(unsaved_prefix)"
  keys="$(unsaved_keys "$prefix/$delivery")"
  complete="$(printf '%s\n' "$keys" | sed -n "s|^$prefix/$delivery/\([A-Za-z0-9-]\{1,\}\)/manifest\.json\$|\1|p" | sort)"
  if [ -n "$attempt" ]; then
    printf '%s\n' "$complete" | grep -qxF "$attempt" \
      || die "delivery $delivery has no complete backup for attempt $attempt (no manifest.json under s3://$STATE_BUCKET/$prefix/$delivery/$attempt/); nothing was merged. ./deploy.sh state unsaved lists what is there"
  elif [ -z "$complete" ]; then
    if printf '%s\n' "$keys" | grep -q "^$prefix/$delivery/"; then
      die "delivery $delivery has only incomplete backups (no manifest.json: the upload did not finish); nothing was merged. An incomplete backup cannot be verified, so it is never merged; deliver the event again instead (README, \"When state is not saved\")"
    fi
    if printf '%s\n' "$keys" | grep -qxF "$prefix/$delivery.db"; then
      die "the backup of delivery $delivery was written by an earlier version of the runner and has no manifest, so it cannot be verified; nothing was merged (README, \"When state is not saved\")"
    fi
    die "no unsaved backup for delivery $delivery (./deploy.sh state unsaved lists them)"
  elif [ "$(printf '%s\n' "$complete" | wc -l)" -gt 1 ]; then
    die "delivery $delivery has several complete backups; name one: ./deploy.sh state recover $delivery <attempt id> (attempts: $(printf '%s' "$complete" | tr '\n' ' '))"
  else
    attempt="$complete"
  fi
  dir="$prefix/$delivery/$attempt"
  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT
  write_manifest_tool "$work/manifest-tool.mjs"
  say "reading the manifest s3://$STATE_BUCKET/$dir/manifest.json"
  aws s3 cp "s3://$STATE_BUCKET/$dir/manifest.json" "$work/manifest.json" --only-show-errors \
    || die "could not download the manifest of delivery $delivery, attempt $attempt; nothing was merged"
  mode="$(node "$work/manifest-tool.mjs" read "$work/manifest.json" "$delivery" "$attempt" "$dir")" \
    || die "the manifest of delivery $delivery, attempt $attempt, cannot be used (see above); nothing was merged"
  say "downloading s3://$STATE_BUCKET/$dir/changed.db"
  aws s3 cp "s3://$STATE_BUCKET/$dir/changed.db" "$work/unsaved.db" --only-show-errors \
    || die "the manifest names $dir/changed.db, and it could not be downloaded; nothing was merged"
  node "$work/manifest-tool.mjs" verify "$work/manifest.json" changed "$work/unsaved.db" \
    || die "$dir/changed.db is not the file its manifest describes (see above); nothing was merged"
  local base=()
  case "$mode" in
    empty)
      say "the manifest says the job started from an empty state: merging without a base"
      ;;
    base)
      say "downloading s3://$STATE_BUCKET/$dir/base.db"
      aws s3 cp "s3://$STATE_BUCKET/$dir/base.db" "$work/base.db" --only-show-errors \
        || die "the manifest names the base snapshot $dir/base.db, and it could not be downloaded. Without it the merge would take every row of the backup for that job's and could write over what other runs did since, so nothing was merged. Restore the object (the bucket keeps versions) and run this again"
      node "$work/manifest-tool.mjs" verify "$work/manifest.json" base "$work/base.db" \
        || die "$dir/base.db is not the snapshot its manifest describes (see above); nothing was merged. Restore the version of the object the manifest was written with and run this again"
      base=(--base "$work/base.db")
      ;;
    *) die "the manifest of delivery $delivery could not be read; nothing was merged" ;;
  esac
  for try in 1 2 3 4 5; do
    rm -f "$work/shared.db" "$work/shared.db-wal" "$work/shared.db-shm"
    # No object yet is a first write (If-None-Match: *). An object this identity cannot read
    # ends there too, and the condition refuses the write: nothing is overwritten blindly.
    if ! etag="$(aws s3api get-object --bucket "$STATE_BUCKET" --key "$STATE_KEY" "$work/shared.db" --query ETag --output text 2>/dev/null)"; then
      etag=""
      rm -f "$work/shared.db"
    fi
    out="$("$updraft" state merge --changed "$work/unsaved.db" --into "$work/shared.db" ${base[@]+"${base[@]}"} --json)" \
      || die "updraft state merge failed; nothing was uploaded: $out"
    case "$out" in
      *'"changed":false'*)
        say "nothing to recover: the shared database already has everything of delivery $delivery"
        return 0
        ;;
    esac
    local condition=(--if-none-match '*')
    [ -z "$etag" ] || condition=(--if-match "$etag")
    if aws s3api put-object --bucket "$STATE_BUCKET" --key "$STATE_KEY" --body "$work/shared.db" \
        --content-type application/vnd.sqlite3 "${condition[@]}" >/dev/null 2>"$work/put.err"; then
      say "merged delivery $delivery (attempt $attempt) into s3://$STATE_BUCKET/$STATE_KEY"
      echo "    $out"
      echo "    the backup stays under $dir/ until it expires; recovering it again changes nothing"
      return 0
    fi
    grep -qE 'PreconditionFailed|ConditionalRequestConflict|\(412\)|\(409\)' "$work/put.err" || { cat "$work/put.err" >&2; die "the upload failed; the shared database is unchanged"; }
    say "a job wrote the shared database first; merging again into the newer one (attempt $try)"
  done
  die "gave up after 5 attempts that each lost to another write; the shared database has none of delivery $delivery's changes from this run of the command. Try again"
}

case "${1:-all}" in
  all)
    deploy_stack
    if [ -f "$HERE/config/config.yaml" ]; then upload_config; else say "no config/config.yaml yet; skipping the config upload"; fi
    build_image
    ;;
  stack) deploy_stack ;;
  config) upload_config ;;
  image) build_image ;;
  status) show_status ;;
  state)
    case "${2:-}" in
      info) state_info ;;
      pull) state_pull "${3:-}" ;;
      unsaved) state_unsaved ;;
      recover) state_recover "${3:-}" "${4:-}" ;;
      *) die "usage: ./deploy.sh state info | state pull [dir] | state unsaved | state recover <delivery id> [attempt id]" ;;
    esac
    ;;
  -h|--help|help) sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $1 (try --help)" ;;
esac
