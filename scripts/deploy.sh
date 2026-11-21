#!/usr/bin/env bash
# Zero-downtime deploy on the VPS (run from the app dir, e.g. /opt/illusi). Called by CI over SSH and
# by scripts/force-deploy.sh.
#
#   scripts/deploy.sh <tag>                 pull ghcr images <tag> and roll them out
#   scripts/deploy.sh --local <tag>         use images already built on this host (force-deploy)
#   scripts/deploy.sh --skip-git <tag>      don't update compose/scripts from git first
#
# Order: update deploy files → pull images → start infra → migrate (old API still serving, so
# migrations must be backward compatible) → `docker rollout api` → recreate worker/analyzer → verify.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

# Logged in as root (CI or by hand): run as the user that owns the app dir instead, like remote_app. git refuses a
# repo owned by someone else ("dubious ownership"), and nothing here should leave root-owned files behind.
if [[ $EUID -eq 0 && "$(stat -c %U .)" != root ]]; then exec sudo -u "$(stat -c %U .)" -H -- "$PWD/scripts/deploy.sh" "$@"; fi

local_images=0
skip_git=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--local) local_images=1; shift ;;
		--skip-git) skip_git=1; shift ;;
		-*) echo "unknown option $1" >&2; exit 2 ;;
		*) break ;;
	esac
done
tag="${1:?usage: scripts/deploy.sh [--local] [--skip-git] <tag>}"

# Update compose.yaml/scripts first, then re-exec so the rest of this run uses the new version of this file.
if [[ $skip_git -eq 0 && -z "${DEPLOY_REEXEC:-}" ]]; then
	git fetch --quiet origin main
	git checkout --quiet --detach origin/main
	args=(--skip-git)
	[[ $local_images -eq 1 ]] && args+=(--local)
	DEPLOY_REEXEC=1 exec "$0" "${args[@]}" "$tag"
fi

exec 9>/tmp/illusi-deploy.lock
flock -w 600 9 || { echo "another deploy is running" >&2; exit 1; }

set -a; . ./.env; set +a
api_image="${API_IMAGE:-ghcr.io/illusion137/illusi-api}"
analyzer_image="${ANALYZER_IMAGE:-ghcr.io/illusion137/illusi-analyzer}"
if [[ $local_images -eq 1 ]]; then
	api_image="illusi-api"
	analyzer_image="illusi-analyzer"
fi

previous="$(cat .env.deploy 2>/dev/null || true)"
cat > .env.deploy.next <<EOF
API_IMAGE=$api_image
API_TAG=$tag
ANALYZER_IMAGE=$analyzer_image
ANALYZER_TAG=$tag
EOF
mv .env.deploy.next .env.deploy
# .env was exported above, and compose prefers the shell environment over --env-file: without this its API_IMAGE
# would win over .env.deploy, and a --local deploy would try to pull its locally built tag from the registry.
export API_IMAGE="$api_image" API_TAG="$tag" ANALYZER_IMAGE="$analyzer_image" ANALYZER_TAG="$tag"
rollback_tags() {
	echo "deploy failed; restoring previous image tags in .env.deploy" >&2
	if [[ -n "$previous" ]]; then printf '%s\n' "$previous" > .env.deploy; fi
}
trap rollback_tags ERR

dc() { scripts/compose.sh "$@"; }
data="${DATA_DIR:-./data}"
mkdir -p "$data"/{media,analyzer_tmp,logs,certs,letsencrypt,acme,postgres,backups}

echo "==> images $api_image:$tag, $analyzer_image:$tag"
if [[ $local_images -eq 0 ]]; then
	dc pull --quiet api analyzer
fi

echo "==> infrastructure"
dc up -d --wait db
dc up -d nginx-proxy

echo "==> migrations"
dc run --rm migrate

echo "==> api"
if [[ -z "$(dc ps -q api)" ]]; then
	dc up -d --wait api
else
	# New replica starts next to the old one; old one is stopped only after the new one is healthy.
	# nginx-proxy adds the new replica as soon as it starts, before it listens, so nginx can mark it
	# failed for fail_timeout (10s). Waiting longer than that before stopping the old replica means
	# there is always a live upstream.
	docker rollout --env-file .env --env-file .env.deploy --timeout 120 --wait-after-healthy 15 api
fi

echo "==> worker and analyzer"
dc up -d --no-deps worker analyzer

echo "==> verify"
# Through nginx: HTTPS once a certificate exists (HTTP then only redirects), plain HTTP before that.
if [[ -L "$data/certs/$DOMAIN.crt" ]]; then
	check=(curl -fsS --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health")
else
	check=(curl -fsS --max-time 5 -H "Host: $DOMAIN" "http://127.0.0.1/health")
fi
ok=0
for _ in $(seq 1 20); do
	if "${check[@]}" >/dev/null 2>&1; then
		ok=1
		break
	fi
	sleep 3
done
if [[ $ok -ne 1 ]]; then
	echo "health check through nginx failed" >&2
	exit 1
fi

trap - ERR
docker image prune -f --filter "until=168h" >/dev/null || true
echo "deployed $tag"
