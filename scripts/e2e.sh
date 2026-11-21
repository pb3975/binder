#!/usr/bin/env bash
# Builds the image, starts a clean container, and runs the end-to-end checks inside it.
# Usage: scripts/e2e.sh [image-tag]        CI and local runs use the same script.
#   TARGET=slim   test the image without Chromium (skips the browser, preview, and UI checks)
#   SHOTS=<dir>   also save UI screenshots there
set -euo pipefail
cd "$(dirname "$0")/.."
target=${TARGET:-full}
image=${1:-binder:e2e-$target}
name=binder-e2e-$$
docker build -q --target "$target" -t "$image" . >/dev/null
cleanup() {
  [ "${failed:-1}" = 0 ] || docker logs "$name" 2>&1 | tail -20
  docker rm -f "$name" "$name-ui" "$name-user" >/dev/null 2>&1 || true
  docker volume rm "$name-vol" >/dev/null 2>&1 || true
}
trap cleanup EXIT
wait_healthy() {
  for _ in $(seq 1 30); do
    docker exec "$1" bun -e "fetch('http://127.0.0.1:8480/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && return 0
    sleep 1
  done
  echo "$1 did not become healthy" >&2
  return 1
}

# 1. Default config, as a stranger first runs it: token auth only, a fresh root-owned volume.
docker run -d --name "$name" -v "$PWD/test/e2e:/e2e:ro" "$image" >/dev/null
wait_healthy "$name"
# The quickstart's first-token step, exactly as documented.
token=$(docker exec "$name" binder token create --name e2e)
docker exec -e BINDER_TOKEN="$token" "$name" bun /e2e/container.ts

if [ "$target" = full ]; then
  # The UI, in its own clean container with synthetic demo data only, driven in Chromium.
  shots=${SHOTS:+$(cd "$SHOTS" && pwd)}
  docker run -d --name "$name-ui" -v "$PWD/test/e2e:/e2e:ro" -v "$PWD/scripts:/scripts:ro" ${shots:+-v "$shots:/shots"} "$image" >/dev/null
  wait_healthy "$name-ui"
  token=$(docker exec "$name-ui" binder token create --name alice)
  reader=$(docker exec "$name-ui" binder token create --name sam --scope read)
  docker exec -e BINDER_TOKEN="$token" "$name-ui" bun /scripts/demo.ts >/dev/null
  for _ in $(seq 1 60); do  # wait for previews so screenshots show them
    docker exec -e BINDER_TOKEN="$token" "$name-ui" bun -e "const r=await fetch('http://127.0.0.1:8480/api/artifacts',{headers:{authorization:'Bearer '+process.env.BINDER_TOKEN}});process.exit((await r.json()).artifacts.every(a=>a.thumb)?0:1)" && break
    sleep 1
  done
  docker exec -e BINDER_TOKEN="$token" -e BINDER_READ_TOKEN="$reader" ${shots:+-e SHOTS=/shots} ${E2E_DEBUG:+-e E2E_DEBUG=1} "$name-ui" bun /e2e/ui.ts
fi

# 2. Running as a fixed host user (--user), as on a NAS whose data folder has its own owner.
docker volume create "$name-vol" >/dev/null
docker run --rm --entrypoint sh -v "$name-vol:/data" "$image" -c 'chown 4321:4321 /data' >/dev/null
docker run -d --name "$name-user" --user 4321:4321 -v "$name-vol:/data" "$image" >/dev/null
wait_healthy "$name-user"
t2=$(docker exec "$name-user" binder token create --name user-check)
docker exec -e T="$t2" "$name-user" bun -e "
  const f = new FormData(); f.set('meta', JSON.stringify({ title: 'as user' })); f.append('file', new File(['<p>u</p>'], 'index.html'));
  const r = await fetch('http://127.0.0.1:8480/api/artifacts', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.T, 'x-binder': '1' }, body: f });
  if (r.status !== 201) { console.error('publish as --user failed', r.status, await r.text()); process.exit(1); }
  console.log('ok   runs and publishes as --user 4321:4321');"
failed=0
