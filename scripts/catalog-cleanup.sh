#!/usr/bin/env bash
# Runs the one-off catalog cleanup (src/db/cleanup_catalog.ts) on the VPS, from your machine.
#
#   scripts/catalog-cleanup.sh            dry run: prints every change, then rolls back
#   scripts/catalog-cleanup.sh --apply    keeps the changes
#
# It makes thousands of small queries in one transaction, too slow through an SSH tunnel, so this copies the local
# src/ to the VPS and runs it there in a throwaway container of the deployed API image, next to the database. Works
# before the script is deployed. Back up first (data/backups) when applying.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/ssh.sh
. scripts/lib/ssh.sh
tmp="/tmp/illusi-cleanup-src"
COPYFILE_DISABLE=1 tar czf - --no-xattrs src 2> /dev/null | remote_app -- "rm -rf $tmp && mkdir -p $tmp && tar xzf - -C $tmp 2> /dev/null"
remote_app -- bash -s -- "$@" <<SCRIPT
set -euo pipefail
trap 'rm -rf $tmp' EXIT
set -a; . ./.env; . ./.env.deploy; set +a
docker run --rm --network "\${COMPOSE_PROJECT_NAME:-illusi}_default" -v $tmp/src:/app/src:ro -w /app --entrypoint node \\
	-e MIGRATE_DATABASE_URL="postgres://\${POSTGRES_USER:-illusi}:\${POSTGRES_PASSWORD}@db:5432/\${POSTGRES_DB:-illusi}" -e DATABASE_URL= -e NODE_NO_WARNINGS=1 \\
	"\$API_IMAGE:\$API_TAG" --import tsx src/db/cleanup_catalog.ts "\$@"
SCRIPT
