#!/usr/bin/env bash
# Deploys Updraft on AWS Lambda MicroVMs. See README.md.
#
#   ./deploy.sh            everything: stack, then config (if ./config/config.yaml exists), then image
#   ./deploy.sh stack      build and deploy the SAM stack
#   ./deploy.sh config     upload ./config/ to s3://<bucket>/config/
#   ./deploy.sh image      package ./image/, create or update the MicroVM image, wait for the build,
#                          then activate the new version (below). Jobs stay on the version they
#                          ran until then: the stack's ImageVersion is pinned to it first
#   ./deploy.sh activate <version>
#                          check isolation on that image version in one microVM (the packet
#                          filter and the sandbox self-test, as a job does them), and only if it
#                          passes point jobs at it (the stack's ImageVersion). Also a rollback
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
#   CHECK_TIMEOUT_SECONDS  how long to wait for the isolation check   (default: 360)
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
CHECK_TIMEOUT_SECONDS="${CHECK_TIMEOUT_SECONDS:-360}"
CHECK_POLL_SECONDS="${CHECK_POLL_SECONDS:-5}"
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

# A text answer from the CLI, with its "None" (nothing there) read as empty.
none_is_empty() { [ "$1" = "None" ] && echo "" || echo "$1"; }

stack_parameter() {
  none_is_empty "$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text)"
}

# One variable of the launcher's environment: what it starts jobs with (template.yaml).
launcher_env() {
  local fn
  fn="$(aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --logical-resource-id LauncherFunction \
    --query StackResourceDetail.PhysicalResourceId --output text)" || die "stack $STACK_NAME has no launcher; run ./deploy.sh stack first"
  none_is_empty "$(aws lambda get-function-configuration --function-name "$fn" --query "Environment.Variables.$1" --output text)"
}

# Points the launcher at one image version: the stack's ImageVersion parameter, with the
# template and every other parameter as deployed. `sam deploy` (./deploy.sh stack) keeps it:
# parameters it is not given keep their previous values.
pin_image_version() {
  local value="$1" keys k err
  keys="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Parameters[].ParameterKey" --output text)"
  local params=()
  for k in $keys; do [ "$k" = "ImageVersion" ] || params+=("ParameterKey=$k,UsePreviousValue=true"); done
  params+=("ParameterKey=ImageVersion,ParameterValue=$value")
  err="$(mktemp)"
  if ! aws cloudformation update-stack --stack-name "$STACK_NAME" --use-previous-template \
      --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --parameters "${params[@]}" >/dev/null 2>"$err"; then
    if grep -q "No updates are to be performed" "$err"; then rm -f "$err"; return 0; fi
    cat "$err" >&2
    rm -f "$err"
    die "could not set the stack's ImageVersion to $value"
  fi
  rm -f "$err"
  aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME" \
    || die "the stack update that sets ImageVersion=$value did not complete; see the stack's events"
}

# Before a build: keep jobs on the version they run now. With ImageVersion empty the launcher
# runs Lambda's latest active version, which a new version becomes as soon as it builds, before
# it is checked. With no version yet, "none" makes the launcher refuse to start jobs (500)
# until one has passed its check.
hold_jobs_on_current_version() {
  local pinned current
  pinned="$(stack_parameter ImageVersion)"
  if [ -n "$pinned" ]; then
    say "jobs stay on image version $pinned until the new one has passed its isolation check"
    return 0
  fi
  current="$(none_is_empty "$(aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_NAME" \
    --query latestActiveImageVersion --output text 2>/dev/null || true)")"
  if [ -n "$current" ]; then
    say "pinning jobs to image version $current (the stack's ImageVersion) while the new one is built and checked"
    pin_image_version "$current"
  else
    say "no image version has passed an isolation check yet: jobs are refused (ImageVersion=none) until one does"
    pin_image_version none
  fi
}

# The image check (run-hook payload version 3, image/runner/hooks.mjs): one microVM from the
# version, with the jobs' execution role and egress, installs the packet filter and runs the
# job's sandbox self-test, logs one ISOLATION CHECK line and starts nothing else. Returns 0 if
# it passed; prints the line otherwise. The microVM is terminated here (and by its 15 minute
# maximum duration if this script dies first).
check_image_version() {
  local version="$1" image_arn role egress log_group partition stamp check_id stream input microvm line state waited=0
  image_arn="$(launcher_env IMAGE_ARN)"
  role="$(launcher_env EXECUTION_ROLE_ARN)"
  egress="$(launcher_env EGRESS_CONNECTOR_ARN)"
  log_group="$(launcher_env MICROVM_LOG_GROUP)"
  [ -n "$image_arn" ] && [ -n "$role" ] && [ -n "$egress" ] && [ -n "$log_group" ] || die "the launcher's environment lacks IMAGE_ARN, EXECUTION_ROLE_ARN, EGRESS_CONNECTOR_ARN or MICROVM_LOG_GROUP; run ./deploy.sh stack"
  partition="$(echo "$image_arn" | cut -d: -f2)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  check_id="image-check-$(echo "$stamp" | tr '[:upper:]' '[:lower:]')"
  stream="isolation-check/$version/$stamp"
  input="$(mktemp)"
  cat > "$input" <<JSON
{
  "imageIdentifier": "$image_arn",
  "imageVersion": "$version",
  "executionRoleArn": "$role",
  "ingressNetworkConnectors": [ "arn:$partition:lambda:$REGION:aws:network-connector:aws-network-connector:NO_INGRESS" ],
  "egressNetworkConnectors": [ "$egress" ],
  "maximumDurationInSeconds": 900,
  "idlePolicy": { "maxIdleDurationSeconds": 900, "suspendedDurationSeconds": 0, "autoResumeEnabled": false },
  "logging": { "cloudWatch": { "logGroup": "$log_group", "logStream": "$stream" } },
  "runHookPayload": "{\"version\":3,\"checkId\":\"$check_id\"}",
  "clientToken": "$check_id"
}
JSON
  if ! microvm="$(aws lambda-microvms run-microvm --cli-input-json "file://$input" --query microvmId --output text)"; then
    rm -f "$input"
    die "could not start the isolation check's microVM"
  fi
  rm -f "$input"
  microvm="$(none_is_empty "$microvm")"
  [ -n "$microvm" ] || die "RunMicrovm returned no microVM id for the isolation check"
  say "isolation check in microVM $microvm (log stream $stream)"
  line=""
  while :; do
    sleep "$CHECK_POLL_SECONDS"
    waited=$((waited + CHECK_POLL_SECONDS))
    # State first: a microVM that reported and then ended is not one that ended without reporting.
    state="$(aws lambda-microvms get-microvm --microvm-identifier "$microvm" --query state --output text 2>/dev/null || echo UNKNOWN)"
    line="$(none_is_empty "$(aws logs get-log-events --log-group-name "$log_group" --log-stream-name "$stream" --start-from-head \
      --query "events[?contains(message, 'ISOLATION CHECK ')].message | [0]" --output text 2>/dev/null || true)")"
    [ -z "$line" ] || break
    case "$state" in
      TERMINATING|TERMINATED) line="the microVM ended ($state) before the check reported"; break ;;
    esac
    if [ "$waited" -ge "$CHECK_TIMEOUT_SECONDS" ]; then line="no ISOLATION CHECK line within ${CHECK_TIMEOUT_SECONDS}s"; break; fi
  done
  aws lambda-microvms terminate-microvm --microvm-identifier "$microvm" >/dev/null 2>&1 \
    || echo "    could not terminate $microvm; its maximum duration (15 minutes) ends it" >&2
  # The runner prints the report with "ok" first (checkImageIsolation in image/runner/job.mjs).
  case "$line" in
    *'ISOLATION CHECK {"ok":true,'*) return 0 ;;
  esac
  echo "    $line" >&2
  return 1
}

# Points jobs at a built version, once it has passed the isolation check.
activate_image_version() {
  local version="${1:-}" state
  need aws
  [ -n "$version" ] || die "usage: ./deploy.sh activate <image version>   (./deploy.sh status lists the image)"
  case "$version" in *[!A-Za-z0-9._-]*) die "not an image version: $version" ;; esac
  state="$(version_state "$version" 2>/dev/null || echo UNKNOWN)"
  [ "$state" = "SUCCESSFUL" ] || die "image version $version is $state, not SUCCESSFUL; nothing was changed"
  if [ "$(launcher_env AGENT_ISOLATION)" = "disabled" ]; then
    say "AgentIsolation=disabled: no isolation check (jobs do not need the boundary)"
  else
    say "checking isolation on image version $version in a microVM"
    check_image_version "$version" \
      || die "image version $version failed its isolation check (above); jobs stay on version $(stack_parameter ImageVersion). The check's log is in $(launcher_env MICROVM_LOG_GROUP), stream isolation-check/$version/..."
    say "image version $version passed its isolation check"
  fi
  pin_image_version "$version"
  say "jobs now run image version $version (the stack's ImageVersion)"
}

build_image() {
  need aws; need zip
  local bucket build_role log_group
  bucket="$(stack_output BucketName)"
  build_role="$(stack_output BuildRoleArn)"
  log_group="$(stack_output MicrovmLogGroup)"
  [ -n "$bucket" ] && [ "$bucket" != "None" ] || die "stack $STACK_NAME has no BucketName output; run ./deploy.sh stack first"

  hold_jobs_on_current_version

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
  activate_image_version "$version"
}

show_status() {
  need aws
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[].[OutputKey, OutputValue]' --output table
  echo "jobs run image version: $(stack_parameter ImageVersion || true) (empty: the latest active one)"
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
  activate) activate_image_version "${2:-}" ;;
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
  -h|--help|help) sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $1 (try --help)" ;;
esac
