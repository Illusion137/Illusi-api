#!/usr/bin/env bash
# Copies lib-origin into ./lib-origin the way `origin` does (mirrors the ignore rules in
# lib-origin's bin/build_origin.ts), from a git ref instead of a local checkout. Used by CI and
# force-deploy; locally keep using `origin`.
#   LIB_ORIGIN_REPO (default https://github.com/Illusion137/lib-origin.git)
#   LIB_ORIGIN_REF  (default main)
set -euo pipefail
cd "$(dirname "$0")/.."
repo="${LIB_ORIGIN_REPO:-https://github.com/Illusion137/lib-origin.git}"
ref="${LIB_ORIGIN_REF:-main}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 --branch "$ref" "$repo" "$tmp/src"
echo "lib-origin @ $(git -C "$tmp/src" rev-parse --short HEAD) ($ref)"

rm -rf lib-origin
mkdir lib-origin
rsync -a \
	--exclude='/admin*' --exclude='/bin*' --exclude='/tests*' --exclude='/tools*' --exclude='/scratch*' \
	--exclude='/LICENSE*' --exclude='/translate_m*' --exclude='/illusicord*' --exclude='/dist-roze-native*' --exclude='/SillyTest*' \
	--exclude='node_modules' --exclude='.history' --exclude='.venv' --exclude='.vscode' --exclude='.claude' --exclude='.husky' --exclude='python' \
	--exclude='.git*' --exclude='.env*' --exclude='package*' --exclude='tsconfig*' --exclude='babel*' --exclude='jest*' \
	--exclude='*ignore' --exclude='*.epub' \
	"$tmp/src/" lib-origin/
