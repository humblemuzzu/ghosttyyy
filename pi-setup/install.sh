#!/usr/bin/env bash
#
# Pi Setup Installer — copies all extensions, themes, skills, and config
# from this folder into the right locations on a new Mac.
#
# Usage:
#   cd pi-setup
#   chmod +x install.sh
#   ./install.sh
#
# What it installs:
#   ~/.pi/agent/extensions/     — 11 extensions (editor, btw, handoff, notify, etc.)
#   ~/.pi/agent/themes/         — gruvbox + nightowl themes
#   ~/.pi/agent/agents/         — agent/prompt markdown files (system prompt, etc.)
#   ~/.pi/agent/skills/         — handoff skill
#   ~/.pi/agent/settings.json   — settings (gruvbox theme, opus model, compaction off, etc.)
#   ~/.pi/agent/keybindings.json
#   ~/.pi/agent/permissions.json
#   ~/.config/agents/skills/    — 15 skills (git, review, spawn, tmux, dig, etc.)
#
# Safe: backs up existing files before overwriting.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SUFFIX=".backup-$(date +%Y%m%d-%H%M%S)"

PI_AGENT="$HOME/.pi/agent"
CONFIG_SKILLS="$HOME/.config/agents/skills"

info()  { printf "\033[1;34m→\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m!\033[0m %s\n" "$1"; }

backup_if_exists() {
    local target="$1"
    if [ -e "$target" ]; then
        local backup="${target}${BACKUP_SUFFIX}"
        cp -R "$target" "$backup"
        warn "Backed up existing $(basename "$target") → $(basename "$backup")"
    fi
}

echo ""
echo "╭─────────────────────────────────────────╮"
echo "│   Pi Setup Installer                    │"
echo "│   Extensions, themes, skills & config   │"
echo "╰─────────────────────────────────────────╯"
echo ""

# ── Create directories ──
info "Creating directories..."
mkdir -p "$PI_AGENT"
mkdir -p "$CONFIG_SKILLS"

# ── Extensions ──
info "Installing extensions..."
backup_if_exists "$PI_AGENT/extensions"
rm -rf "$PI_AGENT/extensions"
cp -R "$SCRIPT_DIR/extensions" "$PI_AGENT/extensions"

# Install tool dependencies if npm is available
if [ -f "$PI_AGENT/extensions/tools/package.json" ] && command -v npm &>/dev/null; then
    info "Installing tool extension dependencies (npm install)..."
    (cd "$PI_AGENT/extensions/tools" && npm install --silent 2>/dev/null) || warn "npm install failed — you may need to run it manually"
fi
ok "Extensions installed (11 extensions)"

# ── Themes ──
info "Installing themes..."
backup_if_exists "$PI_AGENT/themes"
rm -rf "$PI_AGENT/themes"
cp -R "$SCRIPT_DIR/themes" "$PI_AGENT/themes"
ok "Themes installed (gruvbox, nightowl)"

# ── Agents (prompt files) ──
info "Installing agent prompts..."
backup_if_exists "$PI_AGENT/agents"
rm -rf "$PI_AGENT/agents"
cp -R "$SCRIPT_DIR/agents" "$PI_AGENT/agents"
ok "Agent prompts installed"

# ── Pi-level skills ──
info "Installing pi skills..."
backup_if_exists "$PI_AGENT/skills"
rm -rf "$PI_AGENT/skills"
cp -R "$SCRIPT_DIR/pi-skills" "$PI_AGENT/skills"
ok "Pi skills installed (handoff)"

# ── Config-level skills ──
info "Installing config skills..."
backup_if_exists "$CONFIG_SKILLS"
rm -rf "$CONFIG_SKILLS"
cp -R "$SCRIPT_DIR/config-skills" "$CONFIG_SKILLS"

# Make spawn script executable
if [ -f "$CONFIG_SKILLS/spawn/scripts/spawn-amp" ]; then
    chmod +x "$CONFIG_SKILLS/spawn/scripts/spawn-amp"
fi
ok "Config skills installed (15 skills)"

# ── Settings ──
info "Installing settings..."
backup_if_exists "$PI_AGENT/settings.json"
cp "$SCRIPT_DIR/settings.json" "$PI_AGENT/settings.json"
ok "Settings installed"

# ── Keybindings ──
info "Installing keybindings..."
backup_if_exists "$PI_AGENT/keybindings.json"
cp "$SCRIPT_DIR/keybindings.json" "$PI_AGENT/keybindings.json"
ok "Keybindings installed"

# ── Permissions ──
info "Installing permissions..."
backup_if_exists "$PI_AGENT/permissions.json"
cp "$SCRIPT_DIR/permissions.json" "$PI_AGENT/permissions.json"
ok "Permissions installed"

echo ""
echo "╭─────────────────────────────────────────╮"
echo "│   ✅ All done!                          │"
echo "│                                         │"
echo "│   Installed:                            │"
echo "│   • 11 extensions                       │"
echo "│   • 2 themes (gruvbox active)           │"
echo "│   • 15 config skills + 1 pi skill       │"
echo "│   • Agent prompts                       │"
echo "│   • Settings, keybindings, permissions  │"
echo "│                                         │"
echo "│   Restart pi to load everything.        │"
echo "╰─────────────────────────────────────────╯"
echo ""
