#!/usr/bin/env bash
# S3 storage end to end, against MinIO. CI and local runs use the same script.
# Usage: scripts/e2e-s3.sh [image-tag]
#   TARGET=full   also check that previews render, upload to S3, and are served from S3 (default: slim)
#
# 1. The storage and credential unit tests, against real MinIO.
# 2. A container with BINDER_STORAGE=s3://... and no volume: make a token with the CLI, publish, view, download.
# 3. Stop and delete that container, start a new one: Litestream restores the database, and the token,
#    the artifact, its history, and its files are all still there. Then write, and restore a second time.
# 4. Wrong S3 credentials, or no BINDER_SECRET_KEY: the container stops instead of starting empty.
# 5. No keys in the environment: Binder and Litestream both get credentials from a fake ECS endpoint.
# All keys here are fake and work only against this throwaway MinIO.
set -euo pipefail
cd "$(dirname "$0")/.."
target=${TARGET:-slim}
image=${1:-binder:e2e-s3-$target}
# minio/minio is no longer on Docker Hub. Bitnami's last free MinIO build, pinned by digest (docs/decisions.md).
minio_image=bitnamilegacy/minio:2025.7.23@sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7
name=binder-e2e-s3-$$
docker build -q --target "$target" -t "$image" . >/dev/null

cleanup() {
  if [ "${failed:-1}" != 0 ]; then
    for c in a b c ecs ecs-helper; do docker logs "$name-$c" 2>&1 | tail -20 | sed "s/^/[$c] /" || true; done
  fi
  docker rm -f -v "$name-minio" "$name-a" "$name-b" "$name-c" "$name-bad" "$name-ecs" "$name-ecs-helper" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

key_id=binder-e2e-fake-key
secret=binder-e2e-fake-secret-not-real
aws=(-e AWS_REGION=us-east-1 -e AWS_ENDPOINT_URL=http://minio:9000)
keys=(-e AWS_ACCESS_KEY_ID=$key_id -e AWS_SECRET_ACCESS_KEY=$secret)
# A fixed, fake signing key: content URLs and sessions must survive a new container.
s3=(-e BINDER_STORAGE=s3://binder-e2e/team-a -e BINDER_SECRET_KEY=ZmFrZS1lMmUtc2lnbmluZy1rZXktbm90LWEtc2VjcmV0ISE= "${aws[@]}")

wait_healthy() {
  for _ in $(seq 1 40); do
    docker exec "$1" bun -e "fetch('http://127.0.0.1:8480/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && return 0
    sleep 1
  done
  echo "$1 did not become healthy" >&2
  docker logs "$1" 2>&1 | tail -20 >&2
  return 1
}

docker network create "$name" >/dev/null
docker run -d --name "$name-minio" --network "$name" --network-alias minio \
  -e MINIO_ROOT_USER=$key_id -e MINIO_ROOT_PASSWORD=$secret -e MINIO_DEFAULT_BUCKETS=binder-e2e "$minio_image" >/dev/null
for i in $(seq 1 60); do
  docker run --rm --network "$name" "${aws[@]}" "${keys[@]}" --entrypoint bun "$image" \
    -e "await new Bun.S3Client({ bucket: 'binder-e2e', endpoint: 'http://minio:9000' }).list({ maxKeys: 1 })" 2>/dev/null && break
  [ "$i" = 60 ] && { echo "MinIO did not start" >&2; exit 1; }
  sleep 1
done
echo "ok   MinIO is up with bucket binder-e2e"

# 1. Unit tests for both storage backends and the credential provider, with S3 against MinIO.
docker run --rm --network "$name" -v "$PWD/test:/app/test:ro" "${aws[@]}" "${keys[@]}" -e BINDER_TEST_S3=s3://binder-e2e/unit \
  --entrypoint bun "$image" test /app/test/storage.test.ts /app/test/aws.test.ts

# 2. First container. No volume: the disk is thrown away, as on Fargate.
docker run -d --name "$name-a" --network "$name" -v "$PWD/test/e2e:/e2e:ro" "${s3[@]}" "${keys[@]}" "$image" >/dev/null
wait_healthy "$name-a"
token=$(docker exec "$name-a" binder token create --name e2e)
docker exec -e BINDER_TOKEN="$token" "$name-a" bun /e2e/s3.ts seed

# 3. SIGTERM (as ECS sends) stops Binder, then Litestream makes its last copy. Then the container is gone.
start=$(date +%s)
docker stop -t 30 "$name-a" >/dev/null
took=$(( $(date +%s) - start ))
[ "$took" -lt 20 ] || { echo "FAIL stopping took ${took}s; SIGTERM did not reach Litestream and Binder" >&2; exit 1; }
echo "ok   stopped cleanly in ${took}s"
docker rm -v "$name-a" >/dev/null

docker run -d --name "$name-b" --network "$name" -v "$PWD/test/e2e:/e2e:ro" "${s3[@]}" "${keys[@]}" "$image" >/dev/null
wait_healthy "$name-b"
docker exec -e BINDER_TOKEN="$token" "$name-b" bun /e2e/s3.ts verify
docker exec "$name-b" binder token list | grep -q "e2e" && echo "ok   the token survived the new container"

# 4. Wrong credentials must stop startup, never start an empty Binder that would replicate over the real data.
docker run -d --name "$name-bad" --network "$name" "${s3[@]}" -e AWS_ACCESS_KEY_ID=$key_id -e AWS_SECRET_ACCESS_KEY=wrong-fake-secret "$image" >/dev/null
code=$(timeout 60 docker wait "$name-bad" || echo timeout)
if [ "$code" = 0 ] || [ "$code" = timeout ]; then echo "FAIL wrong S3 credentials did not stop the container (exit $code)" >&2; exit 1; fi
docker logs "$name-bad" 2>&1 | grep -q "did not start with an empty database" || { echo "FAIL no clear message for wrong credentials" >&2; docker logs "$name-bad" >&2; exit 1; }
echo "ok   wrong S3 credentials stop startup (exit $code) with a clear message"
out=$(docker run --rm "${aws[@]}" "${keys[@]}" -e BINDER_STORAGE=s3://binder-e2e/team-a "$image" 2>&1) && { echo "FAIL started without BINDER_SECRET_KEY" >&2; exit 1; }
grep -q "BINDER_SECRET_KEY is required" <<<"$out" || { echo "FAIL no clear message without BINDER_SECRET_KEY: $out" >&2; exit 1; }
echo "ok   S3 storage without BINDER_SECRET_KEY stops startup with a clear message"
# The data from step 2 is untouched.
docker exec -e BINDER_TOKEN="$token" "$name-b" bun -e "
  const a = await (await fetch('http://127.0.0.1:8480/api/artifacts/e2e-s3-doc', { headers: { authorization: 'Bearer ' + process.env.BINDER_TOKEN } })).json();
  if (a.version !== 4) { console.error('FAIL data changed after the failed starts', a.version); process.exit(1); }
  console.log('ok   the failed starts left the data alone');"

# A second restore, as on every deploy: the writes made after the first restore (v3, v4) must survive too.
docker stop -t 30 "$name-b" >/dev/null && docker rm -v "$name-b" >/dev/null
docker run -d --name "$name-c" --network "$name" "${s3[@]}" "${keys[@]}" "$image" >/dev/null
wait_healthy "$name-c"
docker exec -e BINDER_TOKEN="$token" "$name-c" bun -e "
  const h = { authorization: 'Bearer ' + process.env.BINDER_TOKEN };
  const vs = (await (await fetch('http://127.0.0.1:8480/api/artifacts/e2e-s3-doc/versions', { headers: h })).json()).versions;
  const list = vs?.map((v) => v.version).join();
  const page = vs && await (await fetch(vs[0].content_url, { redirect: 'manual' })).text();
  if (list !== '4,3,2,1' || !page?.includes('<h1>one</h1>')) { console.error('FAIL second restore', list); process.exit(1); }
  console.log('ok   a second restore keeps the writes made after the first one (versions ' + list + ')');"

# 5. A task role: no keys in the environment, only the container credentials endpoint and its token.
#    The helper owns the network namespace, so the endpoint is on 127.0.0.1 as an ECS agent sidecar would be.
docker run -d --name "$name-ecs-helper" --network "$name" -v "$PWD/test/e2e:/e2e:ro" \
  -e FAKE_ECS_TOKEN=fake-ecs-auth-token -e FAKE_ECS_KEY=$key_id -e FAKE_ECS_SECRET=$secret --entrypoint bun "$image" /e2e/fake-ecs.ts >/dev/null
docker run -d --name "$name-ecs" --network "container:$name-ecs-helper" \
  -e BINDER_STORAGE=s3://binder-e2e/team-b -e BINDER_SECRET_KEY=ZmFrZS1lMmUtc2lnbmluZy1rZXktbm90LWEtc2VjcmV0ISE= "${aws[@]}" \
  -e AWS_CONTAINER_CREDENTIALS_FULL_URI=http://127.0.0.1:9911/creds -e AWS_CONTAINER_AUTHORIZATION_TOKEN=fake-ecs-auth-token "$image" >/dev/null
wait_healthy "$name-ecs"
t3=$(docker exec "$name-ecs" binder token create --name ecs)
docker exec -e T="$t3" "$name-ecs" bun -e "
  const f = new FormData(); f.set('meta', JSON.stringify({ id: 'ecs', title: 'via task role' })); f.append('file', new File(['<p>ecs</p>'], 'index.html'));
  const r = await fetch('http://127.0.0.1:8480/api/artifacts', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.T, 'x-binder': '1' }, body: f });
  const a = await r.json();
  const page = await fetch(a.content_url, { redirect: 'manual' });
  if (r.status !== 201 || (await page.text()) !== '<p>ecs</p>') { console.error('FAIL publish with task-role credentials', r.status); process.exit(1); }
  await Bun.sleep(2000); // one Litestream sync interval and then some
  const hits = await (await fetch('http://127.0.0.1:9911/hits')).json();
  if (!hits.binder || !hits.litestream) { console.error('FAIL both must use the endpoint', JSON.stringify(hits)); process.exit(1); }
  console.log('ok   Binder and Litestream both use container credentials', JSON.stringify(hits));"
docker run --rm --network "$name" "${aws[@]}" "${keys[@]}" --entrypoint bun "$image" -e "
  const s3 = new Bun.S3Client({ bucket: 'binder-e2e', endpoint: 'http://minio:9000' });
  const ok = (await s3.file('team-b/versions/ecs/1/index.html').exists()) && ((await s3.list({ prefix: 'team-b/db/' })).keyCount ?? 0) > 0;
  if (!ok) { console.error('FAIL task-role writes are not in the bucket'); process.exit(1); }
  console.log('ok   files and the database replica were written with task-role credentials');"
failed=0
echo "all S3 e2e checks passed"
