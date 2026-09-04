#!/usr/bin/env bash
set -euo pipefail
PI="/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent"
[ -f "$PI/dist/cli.js" ] || { echo "pi dist not found"; exit 2; }
grep -q "@earendil-works/pi-server" "$PI/dist/experimental/server.js" || { echo "not imported — nothing to do"; exit 0; }
DEST="$PI/node_modules/@earendil-works/pi-server"
[ -d "$DEST" ] && { echo "already present"; exit 0; }
VER=$(node -p "require('$PI/package.json').version")
TMP=$(mktemp -d)
curl -fsSL "https://registry.npmjs.org/@earendil-works/pi-server/-/pi-server-$VER.tgz" -o "$TMP/p.tgz" || { echo "download failed (v$VER)"; exit 1; }
mkdir -p "$TMP/x" "$PI/node_modules/@earendil-works"
tar -xzf "$TMP/p.tgz" -C "$TMP/x"
cp -R "$TMP/x/package" "$DEST"
echo "installed @earendil-works/pi-server@$VER"
