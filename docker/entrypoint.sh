#!/bin/sh
# Runs Binder as the unprivileged `bun` user. When the container starts as root
# (the default, so a fresh cloud volume owned by root works), it first gives the
# data folder to that user. With --user, it runs as that user unchanged.
set -e
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$BINDER_DATA_DIR"
  chown bun:bun "$BINDER_DATA_DIR"
  chmod 0700 "$BINDER_DATA_DIR"
  exec su-exec bun "$@"
fi
exec "$@"
