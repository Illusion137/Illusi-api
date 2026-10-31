#!/usr/bin/env bash
# Keeps a copy of every stored media file in the backup bucket (scripts/lib/s3.sh, BACKUP_S3_* in .env).
# Files are immutable (`<uuid>.<ext>`, moved into place once), so this only ever uploads new ones and
# never deletes or overwrites anything remote: a file removed locally stays in the bucket.
#
#   scripts/backup-media.sh           upload files not yet in the bucket (systemd timer, every 15 min)
#   scripts/backup-media.sh check     list local files missing from the bucket or differing from it
#   scripts/backup-media.sh restore   download every file from the bucket into $DATA_DIR/media
#
# BACKUP_S3_MEDIA_PREFIX (default media) is the folder inside the bucket. Without BACKUP_S3_ENDPOINT this does nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
# shellcheck source=scripts/lib/s3.sh
. scripts/lib/s3.sh

mode="${1:-push}"
if ! s3_configured; then
	echo "off-site backup not configured (BACKUP_S3_ENDPOINT is empty); skipping"
	exit 0
fi
s3_init

media="${DATA_DIR:-./data}/media"
mkdir -p "$media"
media="$(cd "$media" && pwd)"
remote="$(s3_remote "${BACKUP_S3_MEDIA_PREFIX:-media}")"
# Uploads in progress live in .incoming; --min-age skips a file that was just moved into place and could still
# be removed again if its database row rolls back. Data exports (.exports) are short-lived copies of personal data
# and are never backed up. Playlist artwork (artwork/) is backed up like media.
filters=(--exclude '.incoming/**' --exclude '.exports/**' --min-age 5m)

# The api container (uid 1000) owns the media files.
case "$mode" in
	push)
		s3_rclone "$media" ro 1000:1000 copy /local "$remote" "${filters[@]}" --immutable --fast-list --transfers 4 --stats 0 -v
		;;
	check)
		s3_rclone "$media" ro 1000:1000 check /local "$remote" "${filters[@]}" --one-way --fast-list
		;;
	restore)
		s3_rclone "$media" rw 1000:1000 copy "$remote" /local --immutable --fast-list --transfers 4 --stats 30s --stats-one-line -v
		;;
	*)
		echo "usage: scripts/backup-media.sh [push|check|restore]" >&2
		exit 2
		;;
esac
