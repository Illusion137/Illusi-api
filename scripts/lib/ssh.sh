# shellcheck shell=bash
# Shared by scripts/upload-env.sh and scripts/force-deploy.sh (run from your machine): SSH to the VPS with the
# settings in .secrets (see .secrets.example): IP, USER, SSH_KEY (a path or the key itself), SSH_PORT, DEPLOY_DIR.
# Sourced from the repo root; sets `dir` (the deploy directory on the VPS).

[[ -f .secrets ]] || { echo "error: .secrets not found (copy .secrets.example)" >&2; exit 1; }
# shellcheck disable=SC1091
. ./.secrets
: "${IP:?set IP in .secrets}" "${USER:?set USER in .secrets}" "${SSH_KEY:?set SSH_KEY in .secrets}"
dir="${DEPLOY_DIR:-/opt/illusi}"

ssh_tmp="$(mktemp -d)"
trap 'rm -rf "$ssh_tmp"' EXIT
if [[ "$SSH_KEY" == -----BEGIN* ]]; then
	ssh_key="$ssh_tmp/id"
	(umask 077; printf '%s\n' "$SSH_KEY" > "$ssh_key")
else
	ssh_key="${SSH_KEY/#\~/$HOME}"
	[[ -f "$ssh_key" ]] || { echo "error: SSH_KEY file $ssh_key not found" >&2; exit 1; }
fi

# `remote [ssh options] -- command`
remote() {
	local opts=()
	while [[ $# -gt 0 && "$1" != -- ]]; do opts+=("$1"); shift; done
	[[ "${1:-}" == -- ]] && shift
	ssh -i "$ssh_key" -p "${SSH_PORT:-22}" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
		${opts[@]+"${opts[@]}"} "$USER@$IP" "$@"
}
# For commands that read no input: plain ssh would swallow stdin (e.g. the answer to a prompt).
remote_n() { remote -- "$@" < /dev/null; }

# `remote_app [ssh options] -- command`: runs the command in the deploy directory as the user that owns it (the
# systemd timers run as that user), so logging in as root never leaves root-owned .env or .env.deploy behind.
remote_app() {
	local opts=()
	while [[ $# -gt 0 && "$1" != -- ]]; do opts+=("$1"); shift; done
	[[ "${1:-}" == -- ]] && shift
	local cmd qcmd
	cmd="$*"
	qcmd="$(printf %q "$cmd")"
	remote ${opts[@]+"${opts[@]}"} -- "cd $(printf %q "$dir") && if [ \"\$(id -u)\" = 0 ]; then exec sudo -u \"\$(stat -c %U .)\" -H bash -c $qcmd; else exec bash -c $qcmd; fi"
}
