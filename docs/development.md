# Development

## Toolchain

- Bun 1.4.2 (runtime, test runner, SQLite via `bun:sqlite`). No runtime npm dependencies.
- TypeScript 5.9 for type checks only (`devDependencies`).
- Chromium for preview images. Locally the server uses `/usr/bin/chromium` if present; previews are skipped when it is missing.
- Docker for the image (`oven/bun:1.4.2-alpine`; the `full` target adds Alpine `chromium`, the `slim` target does not).
- [Litestream](https://litestream.io) in both images, for S3 storage only. The Dockerfile builds upstream commit `LITESTREAM_COMMIT` from source (Go 1.26.11, pinned by digest) and checks the binary's sha256 for each architecture. To change it, set the commit, build `--target litestream` for `linux/amd64` and `linux/arm64`, and copy the two new sums from the failed check. Once a release contains the fix for upstream issue 1580, go back to the release download.
- MinIO for the S3 end-to-end test only (`bitnamilegacy/minio`, pinned by digest in `scripts/e2e-s3.sh`).

## Run locally

```sh
bun install
bun run dev                      # http://localhost:8480, no login check, data in ./data
bun scripts/seed.ts <seed-root> http://localhost:8480
```

`bun run dev` sets `BINDER_AUTH=none`, which turns sign-in off and answers only on `localhost`. Never use it on a shared host. To try tokens locally, run `bun run binder token create --name me` and `bun src/server.ts` without that variable. All variables are in [self-hosting.md](self-hosting.md).

A seed root holds one folder per artifact: `meta.json` (same fields as the publish `meta`, plus `slug` and optional `skip`) and the artifact files. `bun scripts/demo.ts [url]` publishes synthetic artifacts with version history instead.

## Check

```sh
bun run check                    # tsc --noEmit && bun test (contract, history, migration)
scripts/e2e.sh                   # builds the image, boots a clean container, runs test/e2e/ with real Chromium
TARGET=slim scripts/e2e.sh       # the same for the image without Chromium
SHOTS=/tmp/shots scripts/e2e.sh  # also saves UI screenshots
scripts/e2e-s3.sh                # S3 storage with Litestream, against MinIO (see the script's header)
TARGET=full scripts/e2e-s3.sh    # the same, plus previews stored in S3
scripts/e2e-oidc.sh              # signs in through a real Keycloak (quay.io/keycloak/keycloak:26.8.2) in Chromium
```

`bun run check` tests the local storage backend. To test the S3 backend against your own MinIO, set `BINDER_TEST_S3=s3://<bucket>/<prefix>` and the `AWS_*` variables, then run `bun test test/storage.test.ts`. `scripts/e2e-s3.sh` does this in a container.

`scripts/e2e-oidc.sh` starts Keycloak and the `full` image on one Docker network. Chromium runs inside the Binder container, so Binder and the browser both reach Keycloak as `http://keycloak:8080`. The realm, users, and client secret in `test/e2e/keycloak-realm.json` are synthetic. Unit tests for OIDC (`test/oidc.test.ts`) use a fake provider with real RS256, PS256, and ES256 keys, and need no network.

CI runs all of these, plus an arm64 build once the repo is public (`.github/workflows/ci.yml`). Pushing a `v*` tag publishes a release; see [releasing.md](releasing.md). The e2e run checks publish, view, and history, and two security properties in a real browser: previews cannot reach internal http services, and an artifact in the viewer cannot read or change Binder.

## Deploy over SSH (maintainers)

`deploy/ssh/ship.sh` deploys to a Docker host behind `tailscale serve`, without a registry. It reads an env file that stays out of git (`deploy/ssh/local.env`; see `deploy/ssh/example.env`).

```sh
deploy/ssh/ship.sh                 # build here, stream the image over SSH, recreate the container
```

On the host, `deploy/ssh/remote.sh`:

1. Snapshots a schema v1 data folder before its first v2 start.
2. Keeps the allowed logins of the running container (including the 0.1 name `ALLOWED_LOGINS`).
3. Trusts only the Docker bridge gateway as the proxy.
4. Checks `/healthz` and a sign-in through the port mapping. If either fails, it sets the new data aside, restores the snapshot, and starts the previous image (`binder:previous`).

Merging to `main` does not deploy.

## Data layout (`/data`)

- `binder.sqlite` — artifacts and their versions (schema version in `PRAGMA user_version`, now 2). Schema v1 folders migrate on first start; back up the folder first, because an older Binder cannot read v2.
- `secret.key` — the key that signs content URLs. Created on first start, mode 0600. Deleting it only expires open links.
- `versions/<id>/<n>/` — the files of each version, never changed after publish.
- `thumbs/<id>.png` — 640x400 previews of the current version.
- `tmp/` — staged uploads, cleared on start.
- `trash/` — files from schema v1 and orphaned folders. Binder never reads it.

With S3 storage, `/data` holds only `binder.sqlite` (restored by Litestream at start) and `tmp/`. `versions/` and `thumbs/` are keys in the bucket under the prefix, the Litestream replica is under `<prefix>/db/`, and the signing key comes from `BINDER_SECRET_KEY`.
