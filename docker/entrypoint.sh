#!/bin/sh
# Runs Binder as the unprivileged `bun` user. When the container starts as root
# (the default, so a fresh cloud volume owned by root works), it first gives the
# data folder to that user, then runs this script again as that user. With --user,
# it runs as that user unchanged.
#
# With BINDER_STORAGE=s3://..., the database is restored from S3 before Binder starts,
# and Litestream then runs Binder as its child and copies every database change to S3
# (docs/self-hosting.md, "Storage").
set -e
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$BINDER_DATA_DIR"
  chown bun:bun "$BINDER_DATA_DIR"
  chmod 0700 "$BINDER_DATA_DIR"
  exec su-exec bun "$0" "$@"
fi

case "${BINDER_STORAGE:-local}" in
  local) exec "$@" ;;
esac

config="${TMPDIR:-/tmp}/litestream.yml"
# Validates every setting with the server's own parser, then writes the config.
db=$(bun /app/src/litestream.ts "$config")

# Only "no replica in S3 yet" may start with an empty database. Any other failure
# (wrong credentials, no such bucket, no network) stops here, so Binder never starts
# empty and then replicates that empty database over the real one.
if ! litestream restore -config "$config" -no-expand-env -if-db-not-exists -if-replica-exists "$db"; then
  echo "binder: cannot start: restoring the database from $BINDER_STORAGE failed (see the Litestream error above)." >&2
  echo "binder: check the bucket, the region, the endpoint, and the credentials. Binder did not start with an empty database." >&2
  exit 1
fi

# Litestream stops when Binder exits, and fails when Binder fails. On SIGTERM it stops
# Binder first, then makes a last copy to S3. -exec takes one string that Litestream
# splits like a shell, so each argument is single-quoted.
cmd=""
for arg in "$@"; do
  cmd="$cmd '$(printf %s "$arg" | sed "s/'/'\\\\''/g")'"
done
exec litestream replicate -config "$config" -no-expand-env -exec "$cmd"
