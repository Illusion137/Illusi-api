#!/usr/bin/env bash
# Deploy a git ref without CI or the registry: builds both images on the VPS and rolls them out
# with the same zero-downtime steps as a CI deploy (scripts/deploy.sh --local).
#
#   On the VPS:        scripts/force-deploy.sh [ref]           (default origin/main)
#   From your machine: scripts/force-deploy.sh [ref]           (SSHes in with the settings in .secrets)
#
# Where .secrets exists (your machine; it is never uploaded) this runs itself on the VPS over SSH.
# LIB_ORIGIN_REF (default main) picks the lib-origin branch.
set -euo pipefail
ref="${1:-origin/main}"

if [[ -f "$(dirname "$0")/../.secrets" ]]; then
	cd "$(dirname "$0")/.."
	# shellcheck source=scripts/lib/ssh.sh
	. scripts/lib/ssh.sh
	remote_app -t -- "LIB_ORIGIN_REF=$(printf %q "${LIB_ORIGIN_REF:-main}") scripts/force-deploy.sh $(printf %q "$ref")"
	exit
fi

# Wrapped in a function: bash reads scripts lazily, and the checkout below may rewrite this file.
main() {
	cd "$(dirname "$0")/.."
	git fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'
	git checkout --quiet --detach "$ref"
	local sha tag
	sha="$(git rev-parse --short=12 HEAD)"
	tag="force-$sha"
	echo "==> building $tag"

	scripts/fetch-lib-origin.sh
	docker build --pull --build-arg APP_VERSION="$tag" -t "illusi-api:$tag" .
	docker build --pull -t "illusi-analyzer:$tag" analyzer

	scripts/deploy.sh --local --skip-git "$tag"
}
main "$@"
