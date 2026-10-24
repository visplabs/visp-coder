# The scope benchmark's worker image (bench/README.md, "Container isolation"). Build it from the
# repository root, with the bench directory as context:
#
#   docker build -f bench/scope/Dockerfile -t visp-bench-scope:2.1.300 \
#     --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" bench
#
# Official sources only: the Node image from Docker Hub (pinned by digest; Debian 13 "trixie", Node 26.12.1),
# Debian's own packages, and Claude Code from the npm registry at the version the host ran when this was
# written (`claude --version`: 2.1.300). Change CLAUDE_CODE_VERSION and the tag together, on purpose.
FROM node:26-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec

ARG CLAUDE_CODE_VERSION=2.1.300
# The image user's ids. run_scope.py runs the container as the host user and refuses an image whose user
# differs, so files written into the mounted run directory belong to the host user.
ARG UID=1000
ARG GID=1000

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python-is-python3 git make ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

# A non-root user with an empty home. The base image's `node` user would hold uid 1000.
RUN userdel --remove node \
 && groupadd --gid "${GID}" bench \
 && useradd --no-create-home --home-dir /home/bench --uid "${UID}" --gid "${GID}" --shell /bin/bash bench \
 && install -d -o bench -g bench -m 700 /home/bench

# The PATH shim (scope_shim.py) and what installs it in a run (scope_env.install_shims, called by the
# entrypoint), the entrypoint and the egress proxy. scope_env.IMAGE_FILES lists them; the entrypoint refuses
# to run when they differ from the bench that launches it.
COPY scope_shim.py scope_env.py scope/entrypoint.py scope/egress_proxy.py /opt/visp-scope/

LABEL org.visp.bench="scope" org.visp.claude-code-version="${CLAUDE_CODE_VERSION}"
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    LANG=C.UTF-8
USER bench
WORKDIR /home/bench
CMD ["python3", "-I", "/opt/visp-scope/entrypoint.py", "--describe"]
