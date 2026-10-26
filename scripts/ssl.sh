#!/usr/bin/env bash
# Let's Encrypt certificates for $DOMAIN via certbot (webroot challenge served by nginx-proxy).
#   scripts/ssl.sh issue   first certificate (safe to re-run)
#   scripts/ssl.sh renew   renew if due, then reload nginx (systemd timer runs this twice a day)
# Neither restarts nginx: the config is re-rendered and reloaded in place.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
data="${DATA_DIR:-./data}"
dc() { scripts/compose.sh "$@"; }

reload_nginx() {
	# Re-render nginx-proxy's config (picks up a new cert file) and reload nginx without dropping connections.
	dc exec -T nginx-proxy sh -c 'docker-gen /app/nginx.tmpl /etc/nginx/conf.d/default.conf && nginx -t -q && nginx -s reload'
}

link_certs() {
	mkdir -p "$data/certs"
	# Absolute paths as seen inside nginx-proxy, where letsencrypt is mounted at /etc/letsencrypt.
	ln -sfn "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$data/certs/$DOMAIN.crt"
	ln -sfn "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$data/certs/$DOMAIN.key"
}

case "${1:-}" in
	issue)
		dc up -d nginx-proxy
		dc run --rm certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" \
			--email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email --non-interactive --keep-until-expiring
		link_certs
		reload_nginx
		echo "certificate active for $DOMAIN"
		;;
	renew)
		dc run --rm certbot renew --webroot -w /var/www/acme --quiet
		reload_nginx
		;;
	*)
		echo "usage: $0 issue|renew" >&2
		exit 2
		;;
esac
