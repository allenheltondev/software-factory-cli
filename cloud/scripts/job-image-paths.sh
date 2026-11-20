#!/usr/bin/env bash
# Reads changed file paths (one per line) on stdin and prints those the job MicroVM image is built
# from. The deploy workflow (cloud-deploy-env.yaml) rebuilds the image only when this prints
# something. Keep it to what really ends up in the image, or must agree with it:
#
#   deploy/aws-microvm/image/      the Dockerfile, build.env, the runner and the sandbox
#   build-job-image, its context and zip writer (cloud/server/scripts/)
#   src/config/                    the config schema: the server validates tenant configs with it
#                                  and the image's CLI runs them, so both must be the same
#   package.json, package-lock.json  the CLI's version and dependencies
#
# The rest of the CLI (src/) is deliberately not here: its changes reach jobs with the next image
# built for one of the reasons above, or when the workflow is run with build_image.
set -euo pipefail

while IFS= read -r path || [ -n "$path" ]; do
  path="${path%$'\r'}"
  case "$path" in
    deploy/aws-microvm/image/*|\
    cloud/server/scripts/build-job-image.ts|\
    cloud/server/scripts/job-image-context.ts|\
    cloud/server/scripts/zip.ts|\
    src/config/*|\
    package.json|\
    package-lock.json)
      printf '%s\n' "$path" ;;
  esac
done
