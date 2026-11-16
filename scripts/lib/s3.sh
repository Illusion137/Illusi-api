# shellcheck shell=bash
# Shared by scripts/backup.sh, scripts/restore-test.sh and scripts/backup-media.sh (sourced after .env is loaded):
# rclone, run from its Docker image, against S3-compatible buckets (Contabo Object Storage). Two buckets, each named by
# its .env prefix:
#   BACKUP   encrypted database dumps (BACKUP_S3_*)
#   MEDIA    media files and playlist artwork, served publicly (MEDIA_S3_*, MEDIA_PUBLIC_URL)
# Each needs <PREFIX>_S3_ENDPOINT (e.g. https://eu2.contabostorage.com; empty turns that bucket off), _BUCKET,
# _ACCESS_KEY and _SECRET_KEY.

RCLONE_IMAGE=rclone/rclone:1.69.1

# `s3_configured BACKUP|MEDIA`
s3_configured() { local endpoint="${1}_S3_ENDPOINT"; [[ -n "${!endpoint:-}" ]]; }

# `s3_init BACKUP|MEDIA`: defines the rclone remote `backup:` or `media:`.
s3_init() {
	local p="$1" v
	for v in BUCKET ACCESS_KEY SECRET_KEY; do
		[[ -n "$(printenv "${p}_S3_$v")" ]] || { echo "set ${p}_S3_$v in .env" >&2; exit 1; }
	done
	# rclone reads the remote from the environment; `-e NAME` passes values without putting them on a command line.
	export "RCLONE_CONFIG_${p}_TYPE=s3"
	export "RCLONE_CONFIG_${p}_PROVIDER=Other"
	export "RCLONE_CONFIG_${p}_ENDPOINT=$(printenv "${p}_S3_ENDPOINT")"
	export "RCLONE_CONFIG_${p}_ACCESS_KEY_ID=$(printenv "${p}_S3_ACCESS_KEY")"
	export "RCLONE_CONFIG_${p}_SECRET_ACCESS_KEY=$(printenv "${p}_S3_SECRET_KEY")"
	export "RCLONE_CONFIG_${p}_FORCE_PATH_STYLE=true"
	export "RCLONE_CONFIG_${p}_NO_CHECK_BUCKET=true"
}

# `s3_remote BACKUP|MEDIA [path]`: the rclone path of a folder inside that bucket (the bucket root without one).
s3_remote() {
	local p="$1" bucket
	bucket="$(printenv "${p}_S3_BUCKET")"
	echo "$(tr '[:upper:]' '[:lower:]' <<< "$p"):$bucket${2:+/$2}"
}

# `s3_rclone <host dir> <ro|rw> <uid:gid> rclone args...`: the host dir is mounted at /local.
s3_rclone() {
	local dir="$1" mode="$2" user="$3" p s envs=()
	shift 3
	for p in BACKUP MEDIA; do
		for s in TYPE PROVIDER ENDPOINT ACCESS_KEY_ID SECRET_ACCESS_KEY FORCE_PATH_STYLE NO_CHECK_BUCKET; do
			envs+=(-e "RCLONE_CONFIG_${p}_$s")
		done
	done
	docker run --rm -i --user "$user" -v "$dir:/local:$mode" "${envs[@]}" -e RCLONE_CONFIG=/dev/null "$RCLONE_IMAGE" "$@"
}
