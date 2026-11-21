# Self-hosting Binder

Binder is one process with one data folder. It runs anywhere Docker or [Bun](https://bun.sh) runs. CI tests `linux/amd64`; the image is built for `linux/arm64` too, and CI starts testing it once the repository is public.

## Quick start (Docker Compose)

```sh
git clone https://github.com/pb3975/binder && cd binder
docker compose up -d
docker compose exec binder binder token create --name you
```

1. Copy the `bnd_...` token that the last command prints. Binder shows it only once.
2. Open <http://localhost:8480> and paste the token.
3. Give an agent the same kind of token (`binder token create --name my-agent`) and the skill in [`skill/binder/SKILL.md`](../skill/binder/SKILL.md). An agent without the skill can read the same instructions at <http://localhost:8480/llms.txt>.

Compose binds Binder to `localhost` only. To share it, put HTTPS in front (see below) and set `BINDER_PUBLIC_URL`.

## Images

| Target | Build | What you get |
|---|---|---|
| `slim` (default) | `docker build -t binder .` | No Chromium. Cards show a generated cover. About 200 MB. |
| `full` | `docker build --target full -t binder:full .` | Preview images rendered by Chromium. About 1.3 GB. |

Choose `full` only if you trust the people and agents who publish. Chromium cannot use its own sandbox inside an unprivileged container, so a Chromium bug in a published page would reach the container. Binder still renders every preview through a pinned wrapper, a CDN-only CSP, and a network allowlist; see [design.md](design.md#previews). To switch Compose to `full`, set `target: full` in `docker-compose.yml`.

The container starts as root only long enough to give `/data` to the unprivileged `bun` user, then drops to it. To match a host folder's owner instead, pass `--user <uid>:<gid>`; the folder must already belong to that user.

## Bare Bun

```sh
bun install --production
bun run binder token create --name you
BINDER_DATA_DIR=/var/lib/binder bun src/server.ts
```

Install Chromium for previews, or set `BINDER_PREVIEWS=off`. Run it under systemd, launchd, or any process manager. It listens on `127.0.0.1:8480` by default.

## Fly.io

[`fly.toml`](../fly.toml) is an example with HTTPS, one volume, and the health check. It has not been deployed by CI; please report anything that needs changing.

```sh
fly launch --no-deploy --copy-config --name <your-app>
fly volumes create binder_data --size 1 --region <region>
fly deploy
fly ssh console -C "binder token create --name you"
```

Set `BINDER_PUBLIC_URL` in `fly.toml` to your app's URL. Fly stops idle machines and starts them on the next request. Binder is one process with SQLite, so keep it to one machine (`fly scale count 1`). The same pattern works on any container host that gives you one persistent volume, such as Railway, Render, or a VM.

## HTTPS

Binder speaks plain HTTP. Put it behind something that adds TLS: Caddy (`reverse_proxy 127.0.0.1:8480`), nginx, Traefik, Cloudflare Tunnel, a cloud load balancer, or `tailscale serve`. Then set `BINDER_PUBLIC_URL` to the HTTPS URL, so links in API responses are right and session cookies get the `Secure` flag.

## Storage

Binder keeps two kinds of data: the SQLite database (artifacts, versions, tokens) and the files of every version plus their previews. `BINDER_STORAGE` says where the files go.

| `BINDER_STORAGE` | Files | Database | Use it for |
|---|---|---|---|
| unset or `local` (default) | `versions/` and `thumbs/` in the data folder | `binder.sqlite` in the data folder | Any host with a persistent disk or volume. |
| `s3://<bucket>/<prefix>` | `<prefix>/versions/...` and `<prefix>/thumbs/...` in the bucket | local, and copied to `<prefix>/db/` by Litestream | Container hosts with no persistent disk, such as AWS Fargate. |

### S3 storage

The image restores the database from S3 at start, then runs Binder under [Litestream](https://litestream.io), which copies every database change to S3. The database is not kept on EFS or another network file system, because SQLite's locking is not safe there.

```sh
docker run -d --name binder -p 127.0.0.1:8480:8480 \
  -e BINDER_STORAGE=s3://my-binder-bucket/binder \
  -e BINDER_SECRET_KEY="$(openssl rand -base64 32)" \
  -e AWS_REGION=us-east-1 \
  binder
```

1. Generate `BINDER_SECRET_KEY` once and keep it in a secret store. It is required with S3. The container's disk is temporary, so a key generated there would change on every restart and end every session and content link.
2. Set `AWS_REGION` (or `AWS_DEFAULT_REGION`).
3. Give Binder credentials. On ECS or Fargate, use a task role: Binder and Litestream both read the container credentials endpoint (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, or `AWS_CONTAINER_CREDENTIALS_FULL_URI` with `AWS_CONTAINER_AUTHORIZATION_TOKEN` or `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`). Elsewhere, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN`.
4. For MinIO or another S3-compatible store, set `AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL`. Binder then puts the bucket in the path (path-style addressing).
5. The role needs `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on `<bucket>/<prefix>/*`, and `s3:ListBucket` on the bucket for that prefix.

`binder token create` works as usual inside the running container. It writes to the local database, and Litestream copies the change to S3.

**Rules and limits:**

- **One writer.** Only one Binder may use a bucket prefix at a time. Run one task, never two, and give each Binder instance its own prefix. Two Binders on one prefix would overwrite each other's database copy.
- **The loss window.** Litestream copies changes about once a second. If the task crashes or is killed (not a normal stop), the last second or so of database writes can be lost. A normal stop (SIGTERM, as ECS sends) is safe: Litestream stops Binder, then makes a last copy. Files of a version that was lost this way stay in S3 under their own number, and the next publish takes the next free number.
- **A failed restore stops the container.** If the bucket, region, endpoint, or credentials are wrong, the container exits with an error. It never starts with an empty database, except on the first start, when there is no copy in S3 yet.
- **Binder serves every file itself.** It reads from S3 and adds the same sandbox headers as with local storage. It never redirects a browser to S3.
- **Schema v1 data** must be upgraded with local storage first. S3 storage starts at schema v2.

**Backup:** turn on S3 versioning for the bucket, and a lifecycle rule that expires old object versions after a period you choose. Versioning keeps overwritten and deleted objects, including old copies of the database. Litestream also keeps its own snapshots of the database under `<prefix>/db/` (24 hours by default).

## Backup and upgrades

- With local storage, everything lives in the data folder. Back it up with any file copy while Binder is stopped, or use `sqlite3 binder.sqlite ".backup ..."` plus a copy of `versions/` while it runs.
- Binder upgrades the database schema on start. **Back up before upgrading**, because an older Binder cannot read a newer schema and refuses to start on one.
- Run one Binder process per data folder, or per S3 prefix.

## Configuration

Binder reads all configuration from environment variables. Every variable is optional.

| Variable | Default | What it does |
|---|---|---|
| `BINDER_DATA_DIR` | `./data` (`/data` in the image) | Where the database, the signing key, and every version's files live. Back up this folder. With S3 storage, only the database lives here. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Address to listen on. |
| `PORT` | `8480` | Port to listen on. |
| `BINDER_PUBLIC_URL` | the request's origin | The URL people use, such as `https://binder.example.com`. Set it behind a TLS proxy so returned links are right. |
| `BINDER_PREVIEWS` | `auto` | `auto` renders previews when Chromium is found. `on` requires Chromium. `off` never starts Chromium. |
| `CHROMIUM` | `/usr/bin/chromium-browser` or `/usr/bin/chromium` | Chromium binary for previews. |
| `BINDER_PREVIEW_HOSTS` | common public CDNs (cdnjs, jsDelivr, unpkg, esm.sh, Tailwind, jQuery, Google Fonts) | Comma list of the only external hosts a page may load from while its preview renders. `*.example.com` works. Viewing in a browser is not limited. |
| `BINDER_AUTH_HEADER` | unset | Turns on header mode: trust this request header to name the user, such as `Tailscale-User-Login`. |
| `BINDER_ALLOWED_USERS` | unset | Header mode only, and required there. Comma list of logins, `*@example.com`, or `*`. |
| `BINDER_TRUSTED_PROXIES` | `127.0.0.1,::1` | Header mode only. Peer addresses (IPs or IPv4 CIDRs) the header is accepted from. |
| `BINDER_DEV_ANONYMOUS` | unset | `1` turns authentication off. Local development only. |
| `BINDER_STORAGE` | `local` | `local`, or `s3://<bucket>/<prefix>` to keep files in S3 and copy the database there. See [Storage](#storage). |
| `BINDER_SECRET_KEY` | unset (`secret.key` in the data folder) | Base64 of at least 32 random bytes. Signs content links and sessions. Required with S3 storage. |
| `AWS_REGION`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, ... | unset | The standard AWS variables, for S3 storage only. See [S3 storage](#s3-storage). |

`ALLOWED_LOGINS` and `DEV_ALLOW_ANONYMOUS` from Binder 0.1 were renamed. Binder refuses to start when it sees them, so auth never changes silently.

## Who can get in

Binder has two ways to know who is calling. You can use either or both.

### Tokens (default)

Each person and each agent gets a named token. Tokens have a scope: `write` (publish, edit, remove, restore) or `read`.

```sh
binder token create --name alice              # prints bnd_..., shown once
binder token create --name ci-bot --scope read
binder token list
binder token revoke alice                     # also ends alice's browser sessions
```

Run these where the data folder is: `docker compose exec binder binder token create --name alice`, `fly ssh console -C "binder token create --name alice"`, or `bun run binder token create --name alice` for bare Bun. There is no HTTP API for tokens. Whoever can run commands on the server is the admin.

- Agents send `Authorization: Bearer <token>`.
- People paste their token once on the sign-in screen. Binder sets a 30-day session cookie (`HttpOnly`, `SameSite=Strict`) and never stores the token in the browser.
- Binder stores only a SHA-256 hash of each token.
- Serve Binder over HTTPS whenever tokens cross a network you do not trust.

### Header mode (Tailscale or an identity-aware proxy)

A proxy that signs people in can tell Binder who they are in a header. Binder trusts that header only when all of these are true:

1. `BINDER_AUTH_HEADER` names it.
2. The request comes from an address in `BINDER_TRUSTED_PROXIES`.
3. The login matches `BINDER_ALLOWED_USERS`.

Otherwise Binder ignores the header and logs a warning. Header logins can write. Tokens still work in header mode, so agents outside the proxy can publish.

**The proxy must be the only way to reach Binder,** and it must overwrite the header on every request. If anything else can reach the port from a trusted address, it can claim to be anyone.

#### Tailscale

`tailscale serve` adds `Tailscale-User-Login` for tailnet users and is reachable only on your tailnet.

```sh
docker run -d --name binder --restart unless-stopped \
  -p 127.0.0.1:8480:8480 -v binder-data:/data \
  -e BINDER_AUTH_HEADER=Tailscale-User-Login \
  -e BINDER_ALLOWED_USERS='you@example.com' \
  -e BINDER_TRUSTED_PROXIES="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')" \
  -e BINDER_PUBLIC_URL=https://<machine>.<tailnet>.ts.net:8480 \
  binder
tailscale serve --bg --https=8480 http://127.0.0.1:8480
```

Through a Docker port mapping, the container sees the bridge gateway (often `172.17.0.1`) as the peer, not `127.0.0.1`. That is why the example sets `BINDER_TRUSTED_PROXIES`. If sign-in fails, `docker logs binder` shows the address Binder saw.

#### Other proxies (recipe, not tested in CI)

oauth2-proxy, Authelia, Pomerium, and Cloudflare Access can pass a user header too. Two rules make them safe with Binder:

- Let `/c/` and `/render/` through without the proxy's login. A sandboxed artifact's requests for its own images and scripts carry no cookies, so a cookie-based proxy would block them. Binder checks a signature on these URLs itself.
- Let requests with an `Authorization: Bearer` header through to Binder, so agents can publish with tokens.

If your proxy cannot do both, use tokens only.
