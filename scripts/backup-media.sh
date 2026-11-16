#!/usr/bin/env bash
# Moves stored media and playlist artwork into the media bucket (scripts/lib/s3.sh, MEDIA_S3_* in .env), which serves
# them publicly at MEDIA_PUBLIC_URL: once a file is gone from $DATA_DIR/media the API redirects to its bucket URL, and
# the analyzer downloads a copy when it needs one. The bucket mirrors the media directory (`<uuid>.m4a`,
# `artwork/<uuid>.jpg`). Files are immutable (`<uuid>.<ext>`, moved into place once), so this never overwrites
# anything remote; each local file is deleted only after rclone has verified its upload. Removed media and artwork are
# deleted from the bucket by the API.
#
# The bucket is the only copy of a moved file: keep it apart from the backup bucket (database dumps).
#
#   scripts/backup-media.sh           move files older than 5 minutes into the bucket (systemd timer, every 15 min)
#   scripts/backup-media.sh check     list local files not in the bucket yet, or differing from it
#   scripts/backup-media.sh restore   download every file from the bucket into $DATA_DIR/media (e.g. before turning
#                                     the bucket off: clear MEDIA_PUBLIC_URL afterwards)
#
# Without MEDIA_S3_ENDPOINT this does nothing and media stays on disk.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
# shellcheck source=scripts/lib/s3.sh
. scripts/lib/s3.sh

mode="${1:-push}"
if ! s3_configured MEDIA; then
	echo "media bucket not configured (MEDIA_S3_ENDPOINT is empty); media stays on disk"
	exit 0
fi
s3_init MEDIA
if [[ "$mode" == push && -z "${MEDIA_PUBLIC_URL:-}" ]]; then
	echo "error: MEDIA_PUBLIC_URL is empty: the API couldn't serve moved files" >&2
	exit 1
fi

media="${DATA_DIR:-./data}/media"
mkdir -p "$media"
media="$(cd "$media" && pwd)"
remote="$(s3_remote MEDIA)"
# Uploads in progress live in .incoming; --min-age skips a file that was just moved into place and could still
# be removed again if its database row rolls back. Data exports (.exports) are short-lived copies of personal data
# and stay on disk.
filters=(--exclude '.incoming/**' --exclude '.exports/**' --min-age 5m)

# The api container (uid 1000) owns the media files.
case "$mode" in
	push)
		s3_rclone "$media" rw 1000:1000 move /local "$remote" "${filters[@]}" --immutable --fast-list --transfers 4 --stats 0 -v
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
