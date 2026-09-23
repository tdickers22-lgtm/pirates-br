#!/bin/sh
# Pirates BR container entrypoint (online-08, online-19).
#
# Fly mounts the pirates_data volume at /app/data owned by root, AFTER the image's
# build-time chown ran, so the stats dir has to be fixed at boot. This runs as root
# for exactly two things (mkdir + chown of the data dir), then execs the server as
# user `node` through setpriv (util-linux, in node:20-bookworm-slim). exec keeps
# the server as the container's main process, so SIGTERM reaches LobbyServer's
# drain directly.
#
# It never falls back to running the server as root: if it cannot drop, it exits.
set -eu

DATA_DIR="${PIRATES_BR_DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "docker-entrypoint: setpriv missing, refusing to run the server as root" >&2
    exit 1
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# Already unprivileged (docker run --user, a platform that drops for us).
exec "$@"
