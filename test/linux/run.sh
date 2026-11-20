#!/bin/sh
# Runs the unit and integration tests on Linux against Flathub's PrusaSlicer, in Docker.
#
#   test/linux/run.sh                      both suites
#   test/linux/run.sh 'npm test'           any command, run in the repository inside the container
#
# The files git tracks (and new ones it does not ignore) go into the container; node_modules is
# installed there. Test models are cached in a Docker volume, so 3DBenchy is fetched once.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
image=prusaslicer-mcp-linux-test
command="${1:-npm test && npm run test:integration}"

docker build -q -t "$image" "$here" >/dev/null
cd "$repo"
# COPYFILE_DISABLE: macOS's tar would add a ._ file of metadata next to each file.
git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 tar --null -T - -cf - |
  docker run --rm -i --privileged --init -v prusaslicer-mcp-test-cache:/cache "$image" "npm ci --no-audit --no-fund --loglevel=error >/dev/null && $command"
