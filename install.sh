#!/usr/bin/env bash
# muzzpi installer
#   ./install.sh pi [--dry-run]   the pi harness  → ~/.pi/agent
#   ./install.sh ghostty          themes, fonts and switchers → Ghostty
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

usage() {
    sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'
}

target="${1:-}"
[ $# -gt 0 ] && shift
case "$target" in
    pi) exec bash "$ROOT/pi-setup/install.sh" "$@" ;;
    ghostty) exec bash "$ROOT/ghostty/install.sh" "$@" ;;
    -h|--help) usage ;;
    *) usage; exit 1 ;;
esac
