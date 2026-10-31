#!/usr/bin/env bash
# Runs a scheduled job and reports it to a Sentry Cron Monitor (systemd services from preinstall.sh run every job
# through this). The first check-in creates the monitor with the schedule below, so a failed run (non-zero exit), a
# run that hangs past max_runtime, or a run that never happens opens a Sentry issue. Without SENTRY_DSN in .env the
# job just runs.
#
#   scripts/cron.sh <monitor> -- <command> [args...]
#
# The schedules must match the systemd timers in scripts/preinstall.sh (host time zone).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

slug="${1:?usage: scripts/cron.sh <monitor> -- <command> [args...]}"
shift
[[ "${1:-}" == -- ]] && shift
[[ $# -gt 0 ]] || { echo "usage: scripts/cron.sh <monitor> -- <command> [args...]" >&2; exit 2; }

# monitor: schedule (crontab, or "every <n> <unit>"), checkin margin (min), max runtime (min)
case "$slug" in
	db-backup)     schedule='30 2 * * *';      margin=30;  max_runtime=120 ;;
	media-backup)  schedule='every 15 minute'; margin=15;  max_runtime=120 ;;
	certs-renew)   schedule='17 3,15 * * *';   margin=75;  max_runtime=15 ;;
	docker-prune)  schedule='0 0 * * 1';       margin=120; max_runtime=30 ;;
	restore-test)  schedule='0 4 1 * *';       margin=120; max_runtime=240 ;;
	*) echo "unknown monitor $slug" >&2; exit 2 ;;
esac

# SENTRY_DSN = https://<public key>@<ingest host>/<project id>
cron_url=""
if [[ "${SENTRY_DSN:-}" =~ ^(https?)://([^@:]+)(:[^@]*)?@([^/]+)/(.*/)?([0-9]+)$ ]]; then
	cron_url="${BASH_REMATCH[1]}://${BASH_REMATCH[4]}/api/${BASH_REMATCH[6]}/cron/$slug/${BASH_REMATCH[2]}/"
elif [[ -n "${SENTRY_DSN:-}" ]]; then
	echo "warning: SENTRY_DSN is not a DSN; running $slug without a cron monitor" >&2
fi
environment="${SENTRY_ENVIRONMENT:-production}"
timezone="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
timezone="${timezone:-UTC}"

if [[ "$schedule" == every* ]]; then
	read -r _ value unit <<< "$schedule"
	schedule_json="{\"type\":\"interval\",\"value\":$value,\"unit\":\"$unit\"}"
else
	schedule_json="{\"type\":\"crontab\",\"value\":\"$schedule\"}"
fi

check_in_id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
# Check-ins never fail the job: Sentry being unreachable only loses the report.
check_in() {
	[[ -n "$cron_url" ]] || return 0
	curl -fsS -m 10 -o /dev/null "$@" || echo "warning: Sentry check-in for $slug failed" >&2
}

check_in -X POST "$cron_url?check_in_id=$check_in_id&environment=$environment" -H 'Content-Type: application/json' --data-raw "{
	\"status\": \"in_progress\",
	\"monitor_config\": {\"schedule\": $schedule_json, \"checkin_margin\": $margin, \"max_runtime\": $max_runtime,
		\"timezone\": \"$timezone\", \"failure_issue_threshold\": 1, \"recovery_threshold\": 1}
}"

status=0
"$@" || status=$?

if (( status == 0 )); then
	check_in "$cron_url?check_in_id=$check_in_id&status=ok&environment=$environment"
else
	check_in "$cron_url?check_in_id=$check_in_id&status=error&environment=$environment"
fi
exit "$status"
