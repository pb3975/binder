#!/usr/bin/env bash
# Deploys Binder to a Docker host over SSH, behind `tailscale serve`, without a registry.
# It builds the image here, streams it to the host, and recreates the container there.
#
# Settings come from an env file that stays out of git (default: deploy/ssh/local.env).
# Copy deploy/ssh/example.env, fill it in, then run:  deploy/ssh/ship.sh [env-file]
set -euo pipefail
cd "$(dirname "$0")/../.."
env_file=${1:-${BINDER_DEPLOY_ENV:-deploy/ssh/local.env}}
[ -f "$env_file" ] || { echo "missing $env_file; copy deploy/ssh/example.env" >&2; exit 1; }
# shellcheck disable=SC1090
. "$env_file"
: "${DEPLOY_SSH:?set DEPLOY_SSH in $env_file}" "${DEPLOY_DIR:?set DEPLOY_DIR}" "${BINDER_PUBLIC_URL:?set BINDER_PUBLIC_URL}"

build=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d)
docker build --target "${IMAGE_TARGET:-full}" -t binder:latest --build-arg BINDER_BUILD="$build" .
# Keep the running image as binder:previous, so a bad deploy rolls back with one command (see remote.sh).
ssh "$DEPLOY_SSH" 'docker image inspect binder:latest >/dev/null 2>&1 && docker tag binder:latest binder:previous || true'
docker save binder:latest | gzip -1 | ssh "$DEPLOY_SSH" 'gunzip | docker load'
ssh "$DEPLOY_SSH" "$(printf 'export %q=%q; ' \
    DEPLOY_DIR "$DEPLOY_DIR" BINDER_PUBLIC_URL "$BINDER_PUBLIC_URL" HOST_PORT "${HOST_PORT:-18480}" \
    CONTAINER_USER "${CONTAINER_USER:-}" TZ "${TZ:-UTC}" BINDER_ALLOWED_USERS "${BINDER_ALLOWED_USERS:-}" \
    CHECK_LOGIN "${CHECK_LOGIN:-}" EXTRA_LABEL "${EXTRA_LABEL:-}") bash -s" < deploy/ssh/remote.sh
