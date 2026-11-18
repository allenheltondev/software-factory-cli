# MicroVM image for one Updraft job per microVM.
#
# Lambda runs this Dockerfile on its managed MicroVM base image, starts the ENTRYPOINT, calls
# the /ready hook and snapshots disk and memory. Every microVM starts from that snapshot, so
# nothing here may create per-run state: no secrets, no ids, no clones. All of that happens
# after the /run hook (runner/job.mjs).
#
# The container base image is the one Lambda publishes for MicroVMs; it carries the
# snapshot-compatible OpenSSL that git and curl link against.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

COPY build.env /opt/updraft/build.env

# System packages. The minimal Amazon Linux 2023 images ship microdnf or dnf depending on the
# variant; use whichever is there. curl is only installed when no curl is present (the
# `curl` and `curl-minimal` packages conflict on Amazon Linux 2023).
RUN set -eu; \
    PM="$(command -v dnf || command -v microdnf)"; \
    "$PM" install -y git tar xz gzip shadow-utils ca-certificates findutils; \
    command -v curl >/dev/null 2>&1 || "$PM" install -y curl-minimal; \
    "$PM" clean all

# Node.js from nodejs.org, pinned in build.env, for the microVM's CPU architecture. The
# checksum file comes from the same origin, so it guards against a damaged download, not
# against a compromised origin.
RUN set -eu; . /opt/updraft/build.env; \
    case "$(uname -m)" in \
      aarch64|arm64) NODE_ARCH=arm64 ;; \
      x86_64) NODE_ARCH=x64 ;; \
      *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; \
    esac; \
    FILE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${FILE}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${FILE}\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "${FILE}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "${FILE}" SHASUMS256.txt; \
    node --version; npm --version

# Updraft: a local `npm pack` tarball in vendor/ wins (for builds that are not on npm yet),
# otherwise the pinned npm spec. The build fails if the installed version has no `run-event`
# command, because the image would be useless.
COPY vendor/ /opt/updraft/vendor/
RUN set -eu; . /opt/updraft/build.env; \
    set -- /opt/updraft/vendor/*.tgz; \
    if [ -e "$1" ]; then \
      if [ "$#" -ne 1 ]; then echo "vendor/ must contain at most one .tgz" >&2; exit 1; fi; \
      echo "installing Updraft from $1"; \
      npm install -g --no-fund --no-audit "$1"; \
    else \
      echo "installing Updraft from npm: ${UPDRAFT_SPEC}"; \
      npm install -g --no-fund --no-audit "${UPDRAFT_SPEC}"; \
    fi; \
    updraft --version; \
    if ! updraft --help | grep -q 'run-event'; then \
      echo "this Updraft has no run-event command; use a newer UPDRAFT_SPEC or a tarball in vendor/" >&2; \
      exit 1; \
    fi

# Agent CLIs (word splitting of the list is intended).
RUN set -eu; . /opt/updraft/build.env; \
    if [ -n "${AGENT_PACKAGES}" ]; then npm install -g --no-fund --no-audit ${AGENT_PACKAGES}; fi; \
    npm cache clean --force >/dev/null 2>&1 || true

# Toolchain for the repositories the agents work on (TOOL_PACKAGES in build.env), on PATH for
# the agent and for the verify commands alike.
RUN set -eu; . /opt/updraft/build.env; \
    if [ -n "${TOOL_PACKAGES:-}" ]; then npm install -g --no-fund --no-audit ${TOOL_PACKAGES}; fi; \
    npm cache clean --force >/dev/null 2>&1 || true; \
    if command -v tsc >/dev/null 2>&1; then tsc --version; fi

# The runner and its AWS SDK clients.
COPY runner/ /opt/updraft/runner/
RUN set -eu; cd /opt/updraft/runner; npm ci --omit=dev --no-fund --no-audit; npm cache clean --force >/dev/null 2>&1 || true

# The job user. The runner (root) starts `updraft run-event` as this user; Updraft starts the
# agent as the same user. Claude Code refuses its full-auto mode as root. The Git identity is
# a fallback for agents that commit without `github.app.commitAsApp: true`.
RUN set -eu; \
    useradd --create-home --uid 1000 --user-group --shell /bin/sh updraft; \
    mkdir -p /var/lib/updraft-jobs; chmod 0755 /var/lib/updraft-jobs; \
    git config --system user.name "Updraft Agent"; \
    git config --system user.email "updraft-agent@users.noreply.invalid"; \
    git config --system init.defaultBranch main

ENV UPDRAFT_JOB_USER=updraft \
    UPDRAFT_JOB_UID=1000 \
    UPDRAFT_JOB_GID=1000 \
    UPDRAFT_JOB_HOME=/home/updraft \
    UPDRAFT_STATE_ROOT=/var/lib/updraft-jobs \
    HOOK_PORT=9000 \
    NODE_ENV=production

# Lifecycle hooks only. Nothing listens for application traffic: jobs run with NO_INGRESS.
EXPOSE 9000

ENTRYPOINT ["node", "/opt/updraft/runner/server.mjs"]
