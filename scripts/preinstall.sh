#!/usr/bin/env bash
# One-time (idempotent) setup of a fresh Debian/Ubuntu VPS for the Illusi stack. Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/Illusion137/Illusi-api/main/scripts/preinstall.sh -o preinstall.sh
#   DOMAIN=api.example.com LETSENCRYPT_EMAIL=you@example.com \
#   DEPLOY_SSH_PUBKEY="ssh-ed25519 AAAA... github-actions" GHCR_USER=Illusion137 GHCR_TOKEN=ghp_... \
#   bash preinstall.sh
#
# Installs Docker + compose + docker-rollout, a firewall, fail2ban, unattended upgrades and swap;
# creates the `illusi` deploy user (the CI SSH target) and /opt/illusi with .env, generating any secret it lacks
# (run scripts/upload-env.sh from your machine first to use your own .env, database password included);
# installs systemd timers for certificate renewal, nightly Postgres backups, media backups, a monthly restore test
# and image cleanup (each reported to a Sentry Cron Monitor through scripts/cron.sh when SENTRY_DSN is set); then
# runs the first deploy and issues the TLS certificate. Re-running only fills in what's missing.
#
# Env:
#   DOMAIN, LETSENCRYPT_EMAIL   required on the first run unless .env was uploaded first (stored in .env afterwards)
#   DEPLOY_SSH_PUBKEY           public key CI uses to SSH in as `illusi`
#   GHCR_USER, GHCR_TOKEN       registry login if the ghcr packages are private (read:packages)
#   APP_DIR (/opt/illusi), APP_USER (illusi), REPO_URL, DOCKER_ROLLOUT_VERSION (v0.14)
#   SKIP_DEPLOY=1               stop after host setup (no images pulled, no certificate)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/illusi}"
APP_USER="${APP_USER:-illusi}"
REPO_URL="${REPO_URL:-https://github.com/Illusion137/Illusi-api.git}"
DOCKER_ROLLOUT_VERSION="${DOCKER_ROLLOUT_VERSION:-v0.14}"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl git rsync ufw fail2ban unattended-upgrades openssl jq gnupg
dpkg-reconfigure -f noninteractive unattended-upgrades

log "docker"
if ! command -v docker >/dev/null; then
	curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
cat > /etc/docker/daemon.json.new <<'EOF'
{
	"log-driver": "json-file",
	"log-opts": { "max-size": "10m", "max-file": "5" },
	"live-restore": true
}
EOF
if ! cmp -s /etc/docker/daemon.json.new /etc/docker/daemon.json 2>/dev/null; then
	mv /etc/docker/daemon.json.new /etc/docker/daemon.json
	systemctl restart docker
else
	rm /etc/docker/daemon.json.new
fi

log "docker rollout $DOCKER_ROLLOUT_VERSION"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://raw.githubusercontent.com/wowu/docker-rollout/$DOCKER_ROLLOUT_VERSION/docker-rollout" -o /usr/local/lib/docker/cli-plugins/docker-rollout
chmod +x /usr/local/lib/docker/cli-plugins/docker-rollout
docker rollout --help >/dev/null

log "swap"
mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
if [[ $mem_mb -lt 4096 && ! -e /swapfile ]]; then
	# The analyzer's models need headroom on small VPSes.
	fallocate -l 4G /swapfile
	chmod 600 /swapfile
	mkswap /swapfile
	swapon /swapfile
	echo '/swapfile none swap sw 0 0' >> /etc/fstab
	sysctl -w vm.swappiness=10 >/dev/null
	echo 'vm.swappiness=10' > /etc/sysctl.d/99-illusi.conf
fi

log "firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
# Docker publishes ports past ufw; only 80/443 (nginx-proxy) and 127.0.0.1:5432 are published.
systemctl enable --now fail2ban

log "deploy user $APP_USER"
if ! id "$APP_USER" >/dev/null 2>&1; then
	useradd --create-home --shell /bin/bash "$APP_USER"
fi
usermod -aG docker "$APP_USER"
if [[ -n "${DEPLOY_SSH_PUBKEY:-}" ]]; then
	home="$(getent passwd "$APP_USER" | cut -d: -f6)"
	install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$home/.ssh"
	touch "$home/.ssh/authorized_keys"
	grep -qxF "$DEPLOY_SSH_PUBKEY" "$home/.ssh/authorized_keys" || echo "$DEPLOY_SSH_PUBKEY" >> "$home/.ssh/authorized_keys"
	chown "$APP_USER:$APP_USER" "$home/.ssh/authorized_keys"
	chmod 600 "$home/.ssh/authorized_keys"
fi

log "app $APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
	# init + fetch instead of clone: the directory may already hold a .env sent by scripts/upload-env.sh.
	mkdir -p "$APP_DIR"
	git -C "$APP_DIR" init --quiet
	git -C "$APP_DIR" remote add origin "$REPO_URL"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
[[ ! -f "$APP_DIR/.env" ]] || chmod 600 "$APP_DIR/.env"
as_app() { sudo -u "$APP_USER" -H "$@"; }
as_app git -C "$APP_DIR" fetch --quiet origin main
as_app git -C "$APP_DIR" checkout --quiet --detach origin/main

env_file="$APP_DIR/.env"
if [[ ! -f "$env_file" ]]; then
	: "${DOMAIN:?DOMAIN is required on the first run}"
	: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL is required on the first run}"
	install -m 600 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/deploy/.env.production.example" "$env_file"
fi
set_env() {
	# Sets KEY=value in .env only when it's missing or empty.
	local key="$1" value="$2"
	if grep -qE "^$key=.+" "$env_file"; then return; fi
	if grep -qE "^$key=" "$env_file"; then
		sed -i "s|^$key=.*|$key=$value|" "$env_file"
	else
		echo "$key=$value" >> "$env_file"
	fi
}
[[ -n "${DOMAIN:-}" ]] && sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" "$env_file"
[[ -n "${LETSENCRYPT_EMAIL:-}" ]] && sed -i "s|^LETSENCRYPT_EMAIL=.*|LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL|" "$env_file"
set_env DATA_DIR "$APP_DIR/data"
set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_env POSTGRES_APP_PASSWORD "$(openssl rand -hex 24)"
set_env JWT_ACCESS_SECRET "$(openssl rand -hex 32)"
set_env ACTION_TOKEN_SECRET "$(openssl rand -hex 32)"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a
mkdir -p "$DATA_DIR"/{media,analyzer_tmp,logs,certs,letsencrypt,acme,postgres,backups}
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"/{certs,acme,backups}
# The api container runs as uid 1000 (`node`).
chown -R 1000:1000 "$DATA_DIR"/{media,analyzer_tmp,logs}

if [[ -n "${GHCR_TOKEN:-}" ]]; then
	log "registry login"
	echo "$GHCR_TOKEN" | as_app docker login ghcr.io -u "${GHCR_USER:?GHCR_USER is required with GHCR_TOKEN}" --password-stdin
fi

log "systemd timers"
cat > /etc/systemd/system/illusi-certs.service <<EOF
[Unit]
Description=Renew Illusi TLS certificate
After=docker.service
[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/scripts/cron.sh certs-renew -- $APP_DIR/scripts/ssl.sh renew
EOF
cat > /etc/systemd/system/illusi-certs.timer <<'EOF'
[Unit]
Description=Renew Illusi TLS certificate twice a day
[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/illusi-backup.service <<EOF
[Unit]
Description=Back up the Illusi Postgres database (encrypted, also off-site)
After=docker.service
[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/scripts/cron.sh db-backup -- $APP_DIR/scripts/backup.sh
EOF
cat > /etc/systemd/system/illusi-backup.timer <<'EOF'
[Unit]
Description=Daily Illusi Postgres backup
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/illusi-media-backup.service <<EOF
[Unit]
Description=Copy new Illusi media files to object storage
After=docker.service
[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/scripts/cron.sh media-backup -- $APP_DIR/scripts/backup-media.sh
EOF
cat > /etc/systemd/system/illusi-media-backup.timer <<'EOF'
[Unit]
Description=Copy new Illusi media files to object storage every 15 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/illusi-prune.service <<EOF
[Unit]
Description=Remove old Docker images
[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/scripts/cron.sh docker-prune -- /usr/bin/docker image prune -af --filter until=336h
EOF
cat > /etc/systemd/system/illusi-prune.timer <<'EOF'
[Unit]
Description=Weekly Docker image cleanup
[Timer]
OnCalendar=weekly
Persistent=true
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/illusi-restore-test.service <<EOF
[Unit]
Description=Restore the newest Illusi backup into a throwaway Postgres and check it
After=docker.service
[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/scripts/cron.sh restore-test -- $APP_DIR/scripts/restore-test.sh
EOF
cat > /etc/systemd/system/illusi-restore-test.timer <<'EOF'
[Unit]
Description=Monthly Illusi backup restore test
[Timer]
OnCalendar=*-*-01 04:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now illusi-certs.timer illusi-backup.timer illusi-media-backup.timer illusi-prune.timer illusi-restore-test.timer

if [[ "${SKIP_DEPLOY:-0}" == 1 ]]; then
	log "host ready (SKIP_DEPLOY=1). Next: scripts/deploy.sh <tag> && scripts/ssl.sh issue as $APP_USER"
	exit 0
fi

log "first deploy"
if [[ -n "${GHCR_TOKEN:-}" ]] || as_app docker manifest inspect "${API_IMAGE}:latest" >/dev/null 2>&1; then
	as_app "$APP_DIR/scripts/deploy.sh" --skip-git latest
else
	echo "registry images not reachable; building on this host instead"
	as_app "$APP_DIR/scripts/force-deploy.sh" HEAD
fi

log "TLS certificate for $DOMAIN"
as_app "$APP_DIR/scripts/ssl.sh" issue

log "done: https://$DOMAIN/health"
