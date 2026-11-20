# Linux with PrusaSlicer from Flathub, the build Prusa points Linux users to, for the test suites.
# Built and run by test/linux/run.sh. Flatpak's sandbox (bwrap) needs the container to be --privileged.
FROM ubuntu:24.04

ARG NODE_VERSION=24.14.1
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends flatpak dbus ca-certificates curl xz-utils procps \
 && rm -rf /var/lib/apt/lists/*

RUN flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo \
 && flatpak install -y --noninteractive flathub com.prusa3d.PrusaSlicer

RUN arch="$(dpkg --print-architecture)"; case "$arch" in amd64) node=x64 ;; arm64) node=arm64 ;; *) echo "no Node for $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node}.tar.xz" | tar -xJ -C /opt \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-${node}/bin/node" /usr/local/bin/node \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-${node}/bin/npm" /usr/local/bin/npm \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-${node}/bin/npx" /usr/local/bin/npx

# A desktop session has a system bus, a session bus and XDG_RUNTIME_DIR; flatpak run needs them
# ("Could not connect: No such file or directory" without). The entry script starts them.
RUN useradd -m tester
COPY --chmod=755 entry.sh /usr/local/bin/entry.sh
ENTRYPOINT ["/usr/local/bin/entry.sh"]
