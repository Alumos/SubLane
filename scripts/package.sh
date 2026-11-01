#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 4 ]]; then
  echo 'Usage: scripts/package.sh VERSION ARCH BINARY OUTPUT_DIRECTORY' >&2
  exit 1
fi
version=$1
arch=$2
binary=$3
output=$4
node scripts/release.mjs metadata "v${version}" owner/repo >/dev/null
case "$arch" in amd64|arm64) ;; *) echo 'Expected amd64 or arm64' >&2; exit 1 ;; esac
mkdir -p "$output"
output=$(cd "$output" && pwd)
archive="$output/sublane_${version}_linux_${arch}.tar.gz"
if [[ -e "$archive" ]]; then
  echo 'Refusing to overwrite an existing release archive' >&2
  exit 1
fi
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
cp "$binary" "$staging/sublane"
chmod 755 "$staging/sublane"
cp LICENSE THIRD_PARTY_NOTICES.md .env.example docker.compose.yaml "$staging/"
cp scripts/install.sh scripts/updater.sh "$staging/"
cp -R licenses "$staging/licenses"
mkdir "$staging/docs"
cp docs/README.md "$staging/docs/"
# The tar archive retains the executable bit that Actions artifact ZIPs do not preserve.
tar -czf "$archive" -C "$staging" sublane LICENSE THIRD_PARTY_NOTICES.md licenses .env.example docker.compose.yaml install.sh updater.sh docs
printf '%s\n' "$archive"
