#!/usr/bin/env bash
# Runs on the Docker host (piped over SSH by ship.sh). Idempotent.
set -euo pipefail
data="$DEPLOY_DIR/data"
mkdir -p "$data"
if [ -n "$CONTAINER_USER" ]; then chown -R "$CONTAINER_USER" "$DEPLOY_DIR"; chmod 0700 "$data"; fi

# Before the first start on schema v2, snapshot a v1 data folder: an older Binder cannot read v2.
snap=""
if [ -d "$data/artifacts" ] && [ ! -d "$data/versions" ]; then
  snap="$DEPLOY_DIR/data-v1-backup-$(date +%Y%m%d-%H%M%S)"
  # Stop first: a copy of a live SQLite database (with its WAL) may not be consistent, and this is the only rollback.
  docker stop binder >/dev/null 2>&1 || true
  cp -a "$data" "$snap"
  echo "snapshot of the v1 data folder: $snap"
fi

# Keep the allowed logins of the running container unless the caller passed new ones.
# Containers from Binder 0.1 carry ALLOWED_LOGINS; newer ones carry BINDER_ALLOWED_USERS.
env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' binder 2>/dev/null | sed -n "s/^$1=//p" || true; }
logins=${BINDER_ALLOWED_USERS:-$(env_of BINDER_ALLOWED_USERS)}
logins=${logins:-$(env_of ALLOWED_LOGINS)}
[ -n "$logins" ] || { echo "BINDER_ALLOWED_USERS is required on first deploy" >&2; exit 1; }
# tailscale serve reaches the container through the bridge gateway, so that is the only trusted proxy.
gateway=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
port=$(echo "$BINDER_PUBLIC_URL" | sed -n 's#.*:\([0-9][0-9]*\)/*$#\1#p'); port=${port:-443}

start() {  # start <image> [extra docker args...]
  local image=$1; shift
  docker rm -f binder >/dev/null 2>&1 || true
  docker run -d --name binder --restart unless-stopped "$@" \
    -p "127.0.0.1:$HOST_PORT:8480" ${CONTAINER_USER:+--user "$CONTAINER_USER"} \
    -e BINDER_AUTH_HEADER=Tailscale-User-Login -e BINDER_ALLOWED_USERS="$logins" \
    -e BINDER_TRUSTED_PROXIES="$gateway" -e BINDER_PUBLIC_URL="$BINDER_PUBLIC_URL" -e TZ="$TZ" \
    -v "$data":/data ${EXTRA_LABEL:+-l "$EXTRA_LABEL"} \
    "$image" >/dev/null
}
start binder:latest

# The only door: tailnet-only HTTPS that adds the Tailscale-User-Login header Binder checks.
tailscale serve status 2>/dev/null | grep -q ":$port" || tailscale serve --bg --https="$port" "http://127.0.0.1:$HOST_PORT" >/dev/null

healthy() {
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' binder)" = healthy ] && return 0
    sleep 2
  done
  return 1
}
# /healthz stays green even when every login fails, so also sign in the way tailscale serve does.
login_ok() {
  local who=${CHECK_LOGIN:-${logins%%,*}}
  case "$who" in *'*'*) return 0 ;; esac  # a wildcard allowlist has no single login to test
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Tailscale-User-Login: $who" "http://127.0.0.1:$HOST_PORT/api/session")" = 200 ]
}
if healthy && login_ok; then
  echo "binder healthy, and sign-in through the port mapping works"
  exit 0
fi
echo "binder failed its checks; rolling back to binder:previous" >&2
docker logs --tail 30 binder >&2
docker rm -f binder >/dev/null 2>&1 || true
if [ -n "$snap" ]; then
  # The old image cannot read migrated data: set the migrated folder aside (never delete it) and restore the snapshot.
  mv "$data" "$DEPLOY_DIR/data-v2-failed-$(date +%Y%m%d-%H%M%S)"
  cp -a "$snap" "$data"
fi
# A v1 image reads ALLOWED_LOGINS (newer images refuse it, so it is passed only here).
if docker image inspect binder:previous >/dev/null 2>&1; then start binder:previous ${snap:+-e ALLOWED_LOGINS="$logins"}; fi
exit 1
