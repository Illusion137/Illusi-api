#!/usr/bin/env bash
# docker compose with both env files the stack needs: .env (secrets/settings) and .env.deploy (image tags).
# Usage: scripts/compose.sh ps | logs -f api | exec db psql -U illusi ...
set -euo pipefail
cd "$(dirname "$0")/.."
touch .env.deploy
exec docker compose --env-file .env --env-file .env.deploy "$@"
