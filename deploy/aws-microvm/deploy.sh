#!/usr/bin/env bash
# Deploys Updraft on AWS Lambda MicroVMs. See README.md.
#
#   ./deploy.sh            everything: stack, then config (if ./config/config.yaml exists), then image
#   ./deploy.sh stack      build and deploy the SAM stack
#   ./deploy.sh config     upload ./config/ to s3://<bucket>/config/
#   ./deploy.sh image      package ./image/, create or update the MicroVM image, wait for the build
#   ./deploy.sh status     stack outputs, image state, microVMs of the image
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
#   NODE_VERSION, UPDRAFT_SPEC, AGENT_PACKAGES   override image/build.env
#   UPDRAFT_TARBALL   path of an `npm pack` tarball to install instead of UPDRAFT_SPEC
#   BUILD_TIMEOUT_SECONDS  how long to wait for the image build      (default: 2400)
#   SAM_PARAMETER_OVERRIDES  extra template parameters, e.g.
#                     "MaximumDurationSeconds=5400 TriggerLabels=ready"
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
  -h|--help|help) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $1 (try --help)" ;;
esac
