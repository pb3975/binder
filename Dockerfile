# Binder. Two targets:
#   slim (default): no Chromium; cards show a generated cover.
#   full:           previews rendered by Chromium. Opt in only if you trust your
#                   publishers: Chromium runs without its own sandbox (docs/design.md, "Previews").
# docker build -t binder .            docker build --target full -t binder:full .

# Litestream copies the SQLite database to S3 when BINDER_STORAGE is s3 (docs/self-hosting.md, "Storage").
# A pinned release, checked against the sha256 sums its release page publishes.
FROM oven/bun:1.4.2-alpine AS litestream
ARG LITESTREAM_VERSION=0.5.18
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) asset=linux-x86_64; sum=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea ;; \
      arm64|aarch64) asset=linux-arm64; sum=922a09e6a7ac67f2095571894dc6382e94e1dd4cdd9674883ddf1a8e74ab982d ;; \
      *) echo "no Litestream build pinned for ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac; \
    wget -qO /tmp/litestream.tar.gz "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-${asset}.tar.gz"; \
    echo "${sum}  /tmp/litestream.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream; \
    /usr/local/bin/litestream version

FROM oven/bun:1.4.2-alpine AS base
# tini reaps the processes Chromium leaves behind; su-exec drops root (docker/entrypoint.sh).
RUN apk add --no-cache su-exec tini
WORKDIR /app
ENV NODE_ENV=production BINDER_DATA_DIR=/data HOST=0.0.0.0 PORT=8480 TMPDIR=/tmp \
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
