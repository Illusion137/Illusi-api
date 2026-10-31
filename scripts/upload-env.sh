#!/usr/bin/env bash
# Replaces the VPS's .env with the local one and applies it with a zero-downtime redeploy of the
# running image tags. Shows which keys change (secret values masked) and asks before uploading.
# The previous remote file is kept as .env.bak.<timestamp>.
#
#   scripts/upload-env.sh [--yes] [--no-apply] [--allow-db-password-change]
#
# On a fresh VPS run this before scripts/preinstall.sh: the database is then created with your POSTGRES_PASSWORD.
#
# SSH settings come from .secrets (see .secrets.example): IP, USER, SSH_KEY, SSH_PORT, DEPLOY_DIR.
#
# POSTGRES_PASSWORD is only read by Postgres when the data directory is first created, so changing it
# in .env afterwards locks the app out of the database. A change is refused unless
# --allow-db-password-change is given, in which case the database user's password is changed first.
set -euo pipefail
cd "$(dirname "$0")/.."

assume_yes=0
apply=1
allow_db_password=0
for arg in "$@"; do
	case "$arg" in
		--yes | -y) assume_yes=1 ;;
		--no-apply) apply=0 ;;
		--allow-db-password-change) allow_db_password=1 ;;
		*) echo "unknown option $arg" >&2; exit 2 ;;
	esac
done

die() { echo "error: $*" >&2; exit 1; }

[[ -f .env ]] || die ".env not found"
# shellcheck source=scripts/lib/ssh.sh
. scripts/lib/ssh.sh
tmp="$ssh_tmp"

# KEY=value lines only, comments and blanks dropped.
values() { grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" || true; }
get() { values "$2" | grep -E "^$1=" | tail -n 1 | cut -d= -f2- || true; }

# --- validate the local file ---
problems=()
for k in DOMAIN LETSENCRYPT_EMAIL DATA_DIR POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD POSTGRES_APP_USER POSTGRES_APP_PASSWORD JWT_ACCESS_SECRET ACTION_TOKEN_SECRET; do
	[[ -n "$(get "$k" .env)" ]] || problems+=("$k is empty")
done
[[ "$(get DOMAIN .env)" == *example.com ]] && problems+=("DOMAIN is still the example")
[[ "$(get LETSENCRYPT_EMAIL .env)" == *example.com ]] && problems+=("LETSENCRYPT_EMAIL is still the example")
[[ "$(get POSTGRES_PASSWORD .env)" =~ ^[0-9a-fA-F]*$ ]] || problems+=("POSTGRES_PASSWORD must be hex (it is embedded in DATABASE_URL)")
[[ "$(get POSTGRES_APP_PASSWORD .env)" =~ ^[0-9a-fA-F]*$ ]] || problems+=("POSTGRES_APP_PASSWORD must be hex (it is embedded in DATABASE_URL)")
for k in JWT_ACCESS_SECRET ACTION_TOKEN_SECRET; do
	v="$(get "$k" .env)"
	[[ -z "$v" || ${#v} -ge 32 ]] || problems+=("$k must be at least 32 characters")
done
[[ -n "$(get JWT_ACCESS_SECRET .env)" && "$(get JWT_ACCESS_SECRET .env)" == "$(get ACTION_TOKEN_SECRET .env)" ]] && problems+=("JWT_ACCESS_SECRET and ACTION_TOKEN_SECRET must differ")
backup_key="$(get BACKUP_ENCRYPTION_KEY .env)"
[[ -z "$backup_key" || ${#backup_key} -ge 32 ]] || problems+=("BACKUP_ENCRYPTION_KEY must be at least 32 characters")
if [[ ${#problems[@]} -gt 0 ]]; then
	printf 'local .env is not ready:\n' >&2
	printf '  - %s\n' "${problems[@]}" >&2
	exit 1
fi

# --- compare with the remote file ---
echo "==> $USER@$IP:$dir/.env"
remote_n true || die "cannot ssh to $USER@$IP (check IP, USER, SSH_KEY and SSH_PORT in .secrets)"
if ! remote_n "test -d $(printf %q "$dir")"; then
	# Before scripts/preinstall.sh: it keeps this .env (and its POSTGRES_PASSWORD) and fills in only what's empty.
	echo "  $dir does not exist yet; creating it (run scripts/preinstall.sh on the VPS afterwards)"
	remote_n "mkdir -p $(printf %q "$dir")" || die "cannot create $dir as $USER (use root, or run scripts/preinstall.sh first)"
fi
remote_n "cat $(printf %q "$dir/.env") 2>/dev/null" > "$tmp/remote" || true

is_secret() { [[ "$1" =~ (SECRET|PASSWORD|TOKEN|KEY) ]]; }
show() { if is_secret "$1"; then echo "<${#2} chars>"; else echo "$2"; fi; }
changes=0
while IFS= read -r k; do
	old="$(get "$k" "$tmp/remote")"
	new="$(get "$k" .env)"
	has_old=$(values "$tmp/remote" | grep -qE "^$k=" && echo 1 || echo 0)
	has_new=$(values .env | grep -qE "^$k=" && echo 1 || echo 0)
	if [[ $has_old == 0 ]]; then
		echo "  + $k=$(show "$k" "$new")"
	elif [[ $has_new == 0 ]]; then
		echo "  - $k"
	elif [[ "$old" != "$new" ]]; then
		if is_secret "$k"; then echo "  ~ $k (changed)"; else echo "  ~ $k: $old -> $new"; fi
	else
		continue
	fi
	changes=$((changes + 1))
done < <({ values "$tmp/remote"; values .env; } | cut -d= -f1 | awk '!seen[$0]++')

if [[ $changes -eq 0 ]] && cmp -s "$tmp/remote" .env; then
	echo "no changes"
	exit 0
fi
[[ $changes -eq 0 ]] && echo "  (only comments or formatting differ)"

old_pw="$(get POSTGRES_PASSWORD "$tmp/remote")"
new_pw="$(get POSTGRES_PASSWORD .env)"
rotate_db_password=0
if [[ -n "$old_pw" && "$old_pw" != "$new_pw" ]]; then
	if [[ $allow_db_password -ne 1 ]]; then
		die "POSTGRES_PASSWORD differs from the VPS. Copy the VPS value into your .env, or pass --allow-db-password-change to change the database password too."
	fi
	rotate_db_password=1
	echo "  ! the database user's password will be changed before the new .env goes live"
fi
for k in JWT_ACCESS_SECRET ACTION_TOKEN_SECRET; do
	old="$(get "$k" "$tmp/remote")"
	if [[ -n "$old" && "$old" != "$(get "$k" .env)" ]]; then
		echo "  ! $k changes: tokens signed with the old value stop working"
	fi
done
old_backup_key="$(get BACKUP_ENCRYPTION_KEY "$tmp/remote")"
if [[ -n "$old_backup_key" && "$old_backup_key" != "$(get BACKUP_ENCRYPTION_KEY .env)" ]]; then
	echo "  ! BACKUP_ENCRYPTION_KEY changes: existing dumps still need the old key to restore; keep it"
fi
if [[ -n "$(get DOMAIN "$tmp/remote")" && "$(get DOMAIN "$tmp/remote")" != "$(get DOMAIN .env)" ]]; then
	echo "  ! DOMAIN changes: run scripts/ssl.sh on the VPS afterwards for a certificate"
fi

if [[ $assume_yes -ne 1 ]]; then
	read -r -p "Upload$( [[ $apply -eq 1 ]] && echo " and redeploy")? [y/N] " answer || true
	[[ "$answer" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }
fi

# --- upload ---
if [[ $rotate_db_password -eq 1 ]]; then
	echo "==> changing the database password"
	db_user="$(get POSTGRES_USER .env)"
	# Sent on stdin so the password never appears in a process list.
	printf "ALTER USER \"%s\" WITH PASSWORD '%s';\n" "${db_user:-illusi}" "$new_pw" |
		remote_app -- "scripts/compose.sh exec -T db psql -v ON_ERROR_STOP=1 -q -U $(printf %q "${db_user:-illusi}") -d postgres"
fi

echo "==> uploading"
remote_app -- "umask 077 && cat > .env.upload && { [ ! -f .env ] || cp -p .env .env.bak.\$(date +%Y%m%d%H%M%S); } && mv .env.upload .env && chmod 600 .env" < .env

if [[ $apply -ne 1 ]]; then
	echo "uploaded; not applied (run scripts/deploy.sh --skip-git <tag> on the VPS to apply)"
	exit 0
fi

# --- apply: roll the currently deployed images out again so every container picks up the new .env ---
echo "==> redeploying the current images"
remote_app -- "bash -s" <<'EOF'
set -euo pipefail
[[ -f .env.deploy ]] || { echo 'nothing deployed yet; the new .env applies on the first deploy'; exit 0; }
tag="$(grep '^API_TAG=' .env.deploy | cut -d= -f2-)"
args=(--skip-git)
[[ "$(grep '^API_IMAGE=' .env.deploy | cut -d= -f2-)" == illusi-api ]] && args+=(--local)
scripts/deploy.sh "${args[@]}" "$tag"
EOF
echo "done"
