#!/usr/bin/env bash
# Grants or revokes the ADMIN role in the VPS database, from your machine.
#
#   scripts/admin.sh add <email> [username]    promote an account, or create it (asks for a password; or set ADMIN_PASSWORD)
#   scripts/admin.sh remove <email>            demote an admin back to USER (never the last one)
#
# SSH settings come from .secrets (see .secrets.example). Opens an SSH tunnel to the Postgres port compose publishes
# on the VPS's 127.0.0.1 and runs src/db/{add,remove}_admin.ts locally through it, as the table owner from the VPS's
# .env, so it works before those scripts are deployed.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { echo "usage: scripts/admin.sh add <email> [username] | remove <email>" >&2; exit 2; }
case "${1:-}" in
	add) script=src/db/add_admin.ts ;;
	remove) script=src/db/remove_admin.ts ;;
	*) usage ;;
esac
shift
[[ $# -ge 1 ]] || usage

# shellcheck source=scripts/lib/ssh.sh
. scripts/lib/ssh.sh

echo "==> $USER@$IP"
remote_n true || { echo "error: cannot ssh to $USER@$IP (check IP, USER, SSH_KEY and SSH_PORT in .secrets)" >&2; exit 1; }

# The VPS's .env is the one Postgres was created with, so its credentials are the ones that work.
get() { remote_n "grep -E '^$1=' $(printf %q "$dir/.env") | tail -n 1 | cut -d= -f2-" | tr -d '"'; }
db_user="$(get POSTGRES_USER)"
db_name="$(get POSTGRES_DB)"
db_password="$(get POSTGRES_PASSWORD)"
[[ -n "$db_password" ]] || { echo "error: POSTGRES_PASSWORD not found in $dir/.env on the VPS" >&2; exit 1; }

port="$(node -e "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })")"
ctl="$ssh_tmp/ctl"
trap 'remote -S "$ctl" -O exit -- 2> /dev/null || true; rm -rf "$ssh_tmp"' EXIT
# -f returns once the forward is up (ExitOnForwardFailure makes a failed one an error); the control socket closes it.
remote -M -S "$ctl" -f -N -o ExitOnForwardFailure=yes -L "127.0.0.1:$port:127.0.0.1:5432" -- < /dev/null

# Hex passwords (enforced by scripts/upload-env.sh) need no URL encoding.
MIGRATE_DATABASE_URL="postgres://${db_user:-illusi}:$db_password@127.0.0.1:$port/${db_name:-illusi}" \
	DATABASE_URL='' NODE_NO_WARNINGS=1 npx tsx "$script" "$@"
