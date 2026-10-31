#!/usr/bin/env bash
# Runs the integration suite locally without act: a throwaway pgvector container, migrations (which also create the
# restricted API role), the API on the restricted role, then the suite. Tear-down is automatic.
#
#   scripts/test-integration.sh              run tests/integration
#   scripts/test-integration.sh --coverage   also report the API's own code coverage (V8, via c8)
#   scripts/test-integration.sh <vitest args>   e.g. tests/integration/13_row_level_security.test.ts
set -euo pipefail
cd "$(dirname "$0")/.."

coverage=0
if [[ "${1:-}" == "--coverage" ]]; then coverage=1; shift; fi

work="$(mktemp -d)"
container="illusi-it-$$"
api_pid=""
cleanup() {
	[[ -n "$api_pid" ]] && kill -TERM "$api_pid" 2> /dev/null && wait "$api_pid" 2> /dev/null || true
	docker rm -f "$container" > /dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

port="${PG_PORT:-55433}"
docker run -d --name "$container" -e POSTGRES_USER=illusi -e POSTGRES_PASSWORD=illusi -e POSTGRES_DB=illusi \
	-p "127.0.0.1:$port:5432" pgvector/pgvector:0.8.7-pg17-bookworm > /dev/null
until docker exec "$container" pg_isready -U illusi -d illusi > /dev/null 2>&1; do sleep 1; done
sleep 2

export NODE_ENV=test
export MIGRATE_DATABASE_URL="postgres://illusi:illusi@127.0.0.1:$port/illusi"
export DATABASE_URL="postgres://illusi_app:illusi_app@127.0.0.1:$port/illusi"
export JWT_ACCESS_SECRET=integration-access-secret-0000000000000000
export ACTION_TOKEN_SECRET=integration-action-secret-0000000000000000
export BACKGROUND_SERVICES=false LYRICS_SERVERS_STUB=not_found PORT=3000 API_URL=http://127.0.0.1:3000
export MEDIA_DIR="$work/media" ANALYZER_TMP_DIR="$work/analyzer_tmp" LOG_DIR="$work/logs"
mkdir -p "$MEDIA_DIR" "$ANALYZER_TMP_DIR"

npm run --silent db:migrate
if [[ $coverage == 1 ]]; then export NODE_V8_COVERAGE="$work/v8"; fi
node --import tsx src/index.ts > "$work/api.log" 2>&1 &
api_pid=$!
for _ in $(seq 1 60); do curl -sf "$API_URL/health" > /dev/null && break; sleep 1; done

status=0
vitest_cov=()
if [[ $coverage == 1 ]]; then vitest_cov=(--coverage --coverage.reporter=json --coverage.reportsDirectory="${COV_OUT:-coverage-merged}/inproc"); fi
(unset NODE_V8_COVERAGE; npx vitest run -c vitest.integration.config.mts ${vitest_cov[@]+"${vitest_cov[@]}"} "$@") || status=$?

if [[ $coverage == 1 ]]; then
	kill -TERM "$api_pid"; wait "$api_pid" 2> /dev/null || true; api_pid=""
	npx c8 report --temp-directory="$work/v8" --include='src/**' --exclude='**/*.test.ts' --reporter=json --reporter=text-summary --reports-dir="${COV_OUT:-coverage-merged}/api"
fi
[[ $status == 0 ]] || tail -40 "$work/api.log"
exit "$status"
