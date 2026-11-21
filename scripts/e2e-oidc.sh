#!/usr/bin/env bash
# Signs in through a real Keycloak, in Chromium: alice (in the binder-users group) gets in,
# bob (not in it) is refused, sign-out works, and an agent token still publishes.
# Usage: scripts/e2e-oidc.sh [image-tag]     SHOTS=<dir> also saves sign-in screenshots
# Synthetic users and secrets only: test/e2e/keycloak-realm.json.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYCLOAK=quay.io/keycloak/keycloak:26.8.2
image=${1:-binder:e2e-full}
name=binder-oidc-$$
docker build -q --target full -t "$image" . >/dev/null
cleanup() {
  if [ "${failed:-1}" != 0 ]; then
    echo "--- keycloak"; docker logs "$name-kc" 2>&1 | tail -15
    echo "--- binder"; docker logs "$name" 2>&1 | tail -20
  fi
  docker rm -f "$name" "$name-kc" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Binder and the browser (which runs inside the Binder container) both reach Keycloak as
# http://keycloak:8080, so the issuer in discovery, in the ID token, and in the browser is the same.
docker network create "$name" >/dev/null
docker run -d --name "$name-kc" --network "$name" --network-alias keycloak \
  -v "$PWD/test/e2e/keycloak-realm.json:/opt/keycloak/data/import/binder.json:ro" \
  "$KEYCLOAK" start-dev --import-realm >/dev/null
shots=${SHOTS:+$(cd "$SHOTS" && pwd)}
docker run -d --name "$name" --network "$name" -v "$PWD/test/e2e:/e2e:ro" -v "$PWD/scripts:/scripts:ro" ${shots:+-v "$shots:/shots"} \
  -e BINDER_AUTH=oidc -e BINDER_PUBLIC_URL=http://127.0.0.1:8480 \
  -e BINDER_OIDC_ISSUER=http://keycloak:8080/realms/binder -e BINDER_OIDC_CLIENT_ID=binder \
  -e BINDER_OIDC_CLIENT_SECRET=binder-e2e-client-secret -e BINDER_ALLOWED_GROUPS=binder-users \
  -e BINDER_OIDC_LABEL="Sign in with Example SSO" -e BINDER_PREVIEWS=off \
  "$image" >/dev/null

# Keycloak takes 10 to 60 s to import the realm. Wait for its discovery document, not only a port.
for i in $(seq 1 120); do
  docker exec "$name" bun -e "
    const r = await fetch('http://keycloak:8080/realms/binder/.well-known/openid-configuration').catch(() => null);
    const d = r?.ok ? await r.json() : null;
    process.exit(d?.issuer === 'http://keycloak:8080/realms/binder' ? 0 : 1);" 2>/dev/null && break
  [ "$i" = 120 ] && { echo "keycloak did not come up" >&2; exit 1; }
  sleep 2
done

token=$(docker exec "$name" binder token create --name agent)
docker exec -e BINDER_TOKEN="$token" "$name" bun /scripts/demo.ts >/dev/null
docker exec -e BINDER_TOKEN="$token" ${shots:+-e SHOTS=/shots} ${E2E_DEBUG:+-e E2E_DEBUG=1} "$name" bun /e2e/oidc.ts
failed=0
