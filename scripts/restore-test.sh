#!/usr/bin/env bash
# Proves the backups restore (systemd timer, monthly, through scripts/cron.sh so a failure alerts in Sentry):
#   1. takes the newest dump from the bucket (what you'd have after losing the VPS), or the newest local one
#      when off-site copies aren't configured; fails if it is more than MAX_AGE_HOURS old
#   2. restores it with pg_restore --exit-on-error into a throwaway Postgres container (same image as `db`)
#   3. compares every table's row count with the live database: every live table must exist, and a table with
#      rows must have kept at least MIN_RATIO of them (the dump is up to a day older than the live data)
# Nothing touches the live database except the read-only counts. Exit status 0 means the restore worked.
#
#   scripts/restore-test.sh            run the test
#   scripts/restore-test.sh --local    use the newest local dump even when the bucket is configured
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
# shellcheck source=scripts/lib/s3.sh
. scripts/lib/s3.sh
umask 077

MAX_AGE_HOURS=48
MIN_RATIO_PERCENT=50
CONTAINER=illusi-restore-test

dir="${DATA_DIR:-./data}/backups"
mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"
key="${BACKUP_ENCRYPTION_KEY:-}"
db_user="${POSTGRES_USER:-illusi}"
db_name="${POSTGRES_DB:-illusi}"
me="$(id -u):$(id -g)"
work="$dir/.restore-test"

cleanup() {
	docker rm -f -v "$CONTAINER" > /dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT
cleanup
mkdir -p "$work"

# 1. the dump
source_name=local
if [[ "${1:-}" != --local ]] && [[ -n "$key" ]] && s3_configured BACKUP; then
	s3_init BACKUP
	remote="$(s3_remote BACKUP "${BACKUP_S3_DB_PREFIX:-db}")"
	newest="$(s3_rclone "$work" ro "$me" lsf "$remote" --include 'illusi-*.dump.gpg' | sort | tail -n 1)"
	[[ -n "$newest" ]] || { echo "error: no dumps in the bucket" >&2; exit 1; }
	s3_rclone "$work" rw "$me" copy "$remote/$newest" /local --stats 0
	dump="$work/$newest"
	source_name=bucket
else
	dump="$(find "$dir" -maxdepth 1 -name 'illusi-*.dump*' ! -name '*.partial' | sort | tail -n 1)"
	[[ -n "$dump" ]] || { echo "error: no local dumps in $dir" >&2; exit 1; }
fi
name="$(basename "$dump")"
[[ "$name" =~ ^illusi-([0-9]{8})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump(\.gpg)?$ ]] || { echo "error: unexpected dump name $name" >&2; exit 1; }
taken="$(date -u -d "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}:${BASH_REMATCH[3]}:${BASH_REMATCH[4]}" +%s)"
age_hours=$(( ($(date -u +%s) - taken) / 3600 ))
echo "testing $name from the $source_name ($age_hours h old)"
(( age_hours <= MAX_AGE_HOURS )) || { echo "error: the newest dump is $age_hours h old; backups have stopped" >&2; exit 1; }

# 2. restore into a throwaway container (anonymous volume, removed with it)
image="$(scripts/compose.sh config --images | grep -m1 pgvector)"
password="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name "$CONTAINER" -e POSTGRES_USER="$db_user" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB="$db_name" \
	--shm-size 256m "$image" > /dev/null
for _ in $(seq 1 60); do
	# The entrypoint restarts the server once after initdb; wait for the final one.
	if docker exec "$CONTAINER" pg_isready -q -U "$db_user" -d "$db_name" 2> /dev/null \
		&& docker logs "$CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete'; then
		break
	fi
	sleep 1
done
docker exec "$CONTAINER" pg_isready -q -U "$db_user" -d "$db_name"

plain() {
	if [[ "$name" == *.gpg ]]; then
		[[ -n "$key" ]] || { echo "error: BACKUP_ENCRYPTION_KEY is empty" >&2; return 1; }
		gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$dump" 3<<< "$key"
	else
		cat "$dump"
	fi
}
started="$(date +%s)"
plain | docker exec -i "$CONTAINER" pg_restore --exit-on-error --no-owner -U "$db_user" -d "$db_name"
echo "restored in $(( $(date +%s) - started ))s"

# 3. compare row counts
counts_sql="select table_schema || '.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE' order by 1"
scripts/compose.sh exec -T db psql -X -At -F ' ' -U "$db_user" -d "$db_name" -c "$counts_sql" > "$work/live.txt"
docker exec -i "$CONTAINER" psql -X -At -F ' ' -U "$db_user" -d "$db_name" -c "$counts_sql" > "$work/restored.txt"

failed=0
declare -A restored=()
while read -r table count; do restored[$table]="$count"; done < "$work/restored.txt"
while read -r table live; do
	got="${restored[$table]:-}"
	if [[ -z "$got" ]]; then
		echo "FAIL $table: missing from the restore"
		failed=1
	elif (( live > 0 && got * 100 < live * MIN_RATIO_PERCENT )); then
		echo "FAIL $table: $got rows restored, $live live"
		failed=1
	fi
done < "$work/live.txt"
(( failed == 0 )) || exit 1
echo "restore test passed: $(wc -l < "$work/live.txt" | tr -d ' ') tables, $(awk '{ s += $2 } END { print s }' "$work/restored.txt") rows"
