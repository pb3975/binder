# Binder. Two targets:
#   slim (default): no Chromium; cards show a generated cover.
#   full:           previews rendered by Chromium. Opt in only if you trust your
#                   publishers: Chromium runs without its own sandbox (docs/design.md, "Previews").
# docker build -t binder .            docker build --target full -t binder:full .

# Litestream copies the SQLite database to S3 when BINDER_STORAGE is s3 (docs/self-hosting.md, "Storage").
# No release has the fix for upstream issue 1580 yet (a writer killed mid-commit gets its uncommitted
# frames replicated), so this builds the upstream commit that merged it (PR 1581). Three pins: the commit
# SHA (git checks it), the modules (go.sum), and the sha256 of the binary for each architecture (the
# build is reproducible: CGO off, -trimpath, no VCS stamp). Switch back to a release once one has it.
FROM --platform=$BUILDPLATFORM golang:1.26.11-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS litestream
ARG LITESTREAM_COMMIT=bcd69ae0dc397a5986c79639873075b5770fb485
ARG TARGETARCH
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS="-trimpath -buildvcs=false"
RUN apk add --no-cache git
RUN set -eu; \
    arch="${TARGETARCH:-$(go env GOARCH)}"; \
    case "$arch" in \
      amd64) sum=8a6a576a0e188c0ceb71da8bfb30c5b044b6cf0f89c0fde220a8577031614fd0 ;; \
      arm64) sum=7df438b4ee84ea1b700723716cab362a7f726b6d26fffc98d129c92f0726fa65 ;; \
      *) echo "no Litestream build pinned for $arch" >&2; exit 1 ;; \
    esac; \
    git init -q /src; cd /src; \
    git fetch -q --depth 1 https://github.com/benbjohnson/litestream "$LITESTREAM_COMMIT"; \
    git checkout -q FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$LITESTREAM_COMMIT"; \
    GOARCH="$arch" go build -ldflags "-s -w -X main.Version=0.5.18-${LITESTREAM_COMMIT%"${LITESTREAM_COMMIT#???????}"}" \
      -o /usr/local/bin/litestream ./cmd/litestream; \
    echo "$sum  /usr/local/bin/litestream" | sha256sum -c -

FROM oven/bun:1.4.2-alpine AS base
# tini reaps the processes Chromium leaves behind; su-exec drops root (docker/entrypoint.sh).
RUN apk add --no-cache su-exec tini
WORKDIR /app
ENV NODE_ENV=production BINDER_DATA_DIR=/data HOST=0.0.0.0 PORT=8480 TMPDIR=/tmp \
    BINDER_LITESTREAM_SOCKET=/tmp/litestream.sock \
    HOME=/tmp XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache
COPY package.json ./
COPY src ./src
COPY public ./public
COPY skill/binder/SKILL.md ./skill/binder/SKILL.md
COPY docker/entrypoint.sh /usr/local/bin/binder-entrypoint
COPY docker/binder /usr/local/bin/binder
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
ARG BINDER_BUILD=
ENV BINDER_BUILD=$BINDER_BUILD
VOLUME ["/data"]
EXPOSE 8480
# Starts as root only to give /data to the `bun` user, then drops to it (docker/entrypoint.sh).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8480) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--", "binder-entrypoint"]
CMD ["bun", "src/server.ts"]

FROM base AS full
# Chromium renders card previews (src/thumbs.ts). Fonts keep previews legible.
RUN apk add --no-cache chromium font-noto font-noto-emoji ttf-dejavu
ENV CHROMIUM=/usr/bin/chromium-browser

# Last stage = what `docker build .` produces.
FROM base AS slim
