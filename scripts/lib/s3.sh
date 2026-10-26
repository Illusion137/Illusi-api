# shellcheck shell=bash
# Shared by scripts/backup.sh and scripts/backup-media.sh (sourced after .env is loaded): rclone, run from its
# Docker image, against the S3-compatible bucket in BACKUP_S3_* (Contabo Object Storage).
#   BACKUP_S3_ENDPOINT   e.g. https://eu2.contabostorage.com (empty: off-site copies are off)
#   BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY

RCLONE_IMAGE=rclone/rclone:1.69.1

s3_configured() { [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; }

s3_init() {
	: "${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET in .env}"
	: "${BACKUP_S3_ACCESS_KEY:?set BACKUP_S3_ACCESS_KEY in .env}"
	: "${BACKUP_S3_SECRET_KEY:?set BACKUP_S3_SECRET_KEY in .env}"
	# rclone reads the remote from the environment; `-e NAME` passes values without putting them on a command line.
	export RCLONE_CONFIG_BACKUP_TYPE=s3
	export RCLONE_CONFIG_BACKUP_PROVIDER=Other
	export RCLONE_CONFIG_BACKUP_ENDPOINT="$BACKUP_S3_ENDPOINT"
	export RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY"
	export RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
	export RCLONE_CONFIG_BACKUP_FORCE_PATH_STYLE=true
	export RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET=true
}

# `s3_remote <prefix>`: the rclone path of a prefix inside the bucket.
s3_remote() { echo "backup:$BACKUP_S3_BUCKET/$1"; }

# `s3_rclone <host dir> <ro|rw> <uid:gid> rclone args...`: the host dir is mounted at /local.
s3_rclone() {
	local dir="$1" mode="$2" user="$3"
	shift 3
	docker run --rm -i --user "$user" -v "$dir:/local:$mode" \
		-e RCLONE_CONFIG_BACKUP_TYPE -e RCLONE_CONFIG_BACKUP_PROVIDER -e RCLONE_CONFIG_BACKUP_ENDPOINT \
		-e RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID -e RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY \
		-e RCLONE_CONFIG_BACKUP_FORCE_PATH_STYLE -e RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET \
		-e RCLONE_CONFIG=/dev/null \
		"$RCLONE_IMAGE" "$@"
}
