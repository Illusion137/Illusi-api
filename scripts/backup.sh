#!/usr/bin/env bash
# Daily Postgres backup (systemd timer, 02:30): a pg_dump (custom format) into $DATA_DIR/backups, encrypted with
# BACKUP_ENCRYPTION_KEY (gpg, AES-256), checked by listing it with pg_restore, then copied to the backup bucket
# (scripts/lib/s3.sh) under BACKUP_S3_DB_PREFIX (default db).
#
# Retention, applied to the local directory and the bucket alike (by the date in the file name):
#   - every dump from the last 7 days
#   - for dumps 7 to 21 days old, the first dump of each ISO week
# so there is always one dump between 14 and 20 days old, and at most about 9 files.
#
#   scripts/backup.sh                    back up now and prune
#   scripts/backup.sh list               dumps here and in the bucket
#   scripts/backup.sh fetch              download the bucket's dumps into $DATA_DIR/backups (after losing the VPS)
#   scripts/backup.sh decrypt <file>     write the plain pg_dump to stdout, e.g. to restore:
#       scripts/backup.sh decrypt data/backups/illusi-....dump.gpg |
#         scripts/compose.sh exec -T db pg_restore --clean --if-exists -U illusi -d illusi
#
# Without BACKUP_ENCRYPTION_KEY dumps are kept unencrypted and never leave the VPS.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
# shellcheck source=scripts/lib/s3.sh
. scripts/lib/s3.sh
umask 077

KEEP_DAILY_DAYS=7
KEEP_WEEKLY_DAYS=21

dir="${DATA_DIR:-./data}/backups"
mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"
key="${BACKUP_ENCRYPTION_KEY:-}"
db_user="${POSTGRES_USER:-illusi}"
db_name="${POSTGRES_DB:-illusi}"
me="$(id -u):$(id -g)"

gpg_with_key() { gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 "$@" 3<<< "$key"; }

# Reads dump file names on stdin, prints the ones the retention rule drops.
expired() {
	local now name stamp day age week
	now="$(date -u +%s)"
	declare -A first_of_week=()
	# Oldest first, so the first file seen in a week is that week's keeper.
	while IFS= read -r name; do
		[[ "$name" =~ ^illusi-([0-9]{8})T[0-9]{6}Z\.dump(\.gpg)?$ ]] || continue
		stamp="${BASH_REMATCH[1]}"
		day="$(date -u -d "$stamp" +%s)"
		age=$(( (now - day) / 86400 ))
		if (( age < KEEP_DAILY_DAYS )); then continue; fi
		week="$(date -u -d "$stamp" +%G%V)"
		if (( age < KEEP_WEEKLY_DAYS )) && [[ -z "${first_of_week[$week]:-}" ]]; then
			first_of_week[$week]="$name"
			continue
		fi
		echo "$name"
	done < <(sort)
}

backup() {
	local stamp out
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	out="$dir/illusi-$stamp.dump"
	[[ -n "$key" ]] && out="$out.gpg"
	# Global so the EXIT trap still sees it if a step fails: no half-written dump is left behind.
	partial="$out.partial"
	trap 'rm -f "$partial"' EXIT
	dump() { scripts/compose.sh exec -T db pg_dump -U "$db_user" -d "$db_name" -Fc; }
	if [[ -n "$key" ]]; then
		dump | gpg_with_key --symmetric --cipher-algo AES256 --compress-algo none -o "$out.partial"
		# Proves the file decrypts and is a readable dump before it replaces anything.
		gpg_with_key --decrypt "$out.partial" | scripts/compose.sh exec -T db pg_restore --list > /dev/null
	else
		echo "warning: BACKUP_ENCRYPTION_KEY is empty; keeping an unencrypted dump on this VPS only" >&2
		dump > "$out.partial"
		scripts/compose.sh exec -T db pg_restore --list < "$out.partial" > /dev/null
	fi
	mv "$out.partial" "$out"
	echo "backup written: $out ($(du -h "$out" | cut -f1))"

	local name
	while IFS= read -r name; do
		rm -f "$dir/$name"
		echo "pruned $name"
	done < <(find "$dir" -maxdepth 1 -name 'illusi-*.dump*' ! -name '*.partial' -printf '%f\n' | expired)

	if [[ -z "$key" ]] || ! s3_configured; then return; fi
	s3_init
	local remote
	remote="$(s3_remote "${BACKUP_S3_DB_PREFIX:-db}")"
	s3_rclone "$dir" ro "$me" copy /local "$remote" --include 'illusi-*.dump.gpg' --ignore-existing --stats 0 -v
	# Remote retention goes by the bucket's own listing, never by what is (or isn't) on this disk: a fresh VPS
	# with one new dump must not wipe older copies.
	s3_rclone "$dir" ro "$me" lsf "$remote" --include 'illusi-*.dump.gpg' | expired > "$dir/.expired-remote"
	if [[ -s "$dir/.expired-remote" ]]; then
		s3_rclone "$dir" ro "$me" delete "$remote" --files-from /local/.expired-remote -v
	fi
	rm -f "$dir/.expired-remote"
}

case "${1:-backup}" in
	backup)
		backup
		;;
	list)
		echo "local ($dir):"
		find "$dir" -maxdepth 1 -name 'illusi-*.dump*' ! -name '*.partial' -printf '  %f  %s bytes\n' | sort
		if s3_configured; then
			s3_init
			echo "bucket:"
			s3_rclone "$dir" ro "$me" lsf "$(s3_remote "${BACKUP_S3_DB_PREFIX:-db}")" --format sp --separator '  ' | sed 's/^/  /' | sort
		fi
		;;
	fetch)
		s3_configured || { echo "BACKUP_S3_ENDPOINT is empty" >&2; exit 1; }
		s3_init
		s3_rclone "$dir" rw "$me" copy "$(s3_remote "${BACKUP_S3_DB_PREFIX:-db}")" /local --ignore-existing -v
		;;
	decrypt)
		file="${2:?usage: scripts/backup.sh decrypt <file.dump.gpg>}"
		[[ -n "$key" ]] || { echo "BACKUP_ENCRYPTION_KEY is empty" >&2; exit 1; }
		gpg_with_key --decrypt "$file"
		;;
	*)
		echo "usage: scripts/backup.sh [backup|list|fetch|decrypt <file>]" >&2
		exit 2
		;;
esac
