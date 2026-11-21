# Binder. Two targets:
#   slim (default): no Chromium; cards show a generated cover.
#   full:           previews rendered by Chromium. Opt in only if you trust your
#                   publishers: Chromium runs without its own sandbox (docs/design.md, "Previews").
# docker build -t binder .            docker build --target full -t binder:full .
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
