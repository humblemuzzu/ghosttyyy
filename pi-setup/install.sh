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
#   ~/.pi/agent/extensions/     — 14 extensions (editor, tools, handoff, brain-loader, etc.)
#   ~/.pi/agent/themes/         — gruvbox + nightowl themes
#   ~/.pi/agent/agents/         — agent/prompt markdown files (system prompt, sub-agents, etc.)
#   ~/.pi/agent/skills/         — handoff skill
#   ~/.pi/agent/settings.json   — settings (zai default, gruvbox theme, compaction off, etc.)
#   ~/.pi/agent/keybindings.json
#   ~/.pi/agent/models.json     — model context window overrides
#   ~/.pi/agent/permissions.json
#   ~/.config/agents/skills/    — 16 skills (git, review, spawn, tmux, dig, etc.)
#   4 pi packages (npm)         — web-access, context, token-burden, pi-claude-bridge
#   2 global npm packages       — claude-agent-sdk-pi (legacy), pi-claude-bridge (active)
#
# After install, re-apply pi-claude-bridge patches if needed:
#   See README.md → "pi-claude-bridge Local Modifications"
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

# ── Prerequisites ──
info "Checking prerequisites..."
if ! command -v pi &>/dev/null; then
    warn "pi not found. Install it first: npm install -g @mariozechner/pi-coding-agent"
    echo "  Then re-run this script."
    exit 1
fi
ok "pi found: $(pi --version 2>/dev/null || echo 'version unknown')"

# ── Create directories ──
info "Creating directories..."
mkdir -p "$PI_AGENT"
mkdir -p "$CONFIG_SKILLS"

# ── Global npm packages ──
info "Installing global npm packages..."
# claude-agent-sdk-pi (legacy, may still be needed)
if ! npm list -g claude-agent-sdk-pi &>/dev/null 2>&1; then
    info "  Installing claude-agent-sdk-pi globally..."
    npm install -g claude-agent-sdk-pi 2>/dev/null || warn "Failed to install claude-agent-sdk-pi globally (install manually: npm install -g claude-agent-sdk-pi)"
else
    info "  claude-agent-sdk-pi already installed globally"
fi
# pi-claude-bridge (active Claude bridge)
if ! npm list -g pi-claude-bridge &>/dev/null 2>&1; then
    info "  Installing pi-claude-bridge globally (Claude Code Agent SDK bridge)..."
    npm install -g pi-claude-bridge 2>/dev/null || warn "Failed to install pi-claude-bridge globally (install manually: npm install -g pi-claude-bridge)"
else
    info "  pi-claude-bridge already installed globally"
fi
ok "Global packages checked"

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
ok "Extensions installed (14 extensions)"

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

# Make scripts executable
if [ -f "$CONFIG_SKILLS/spawn/scripts/spawn-amp" ]; then
    chmod +x "$CONFIG_SKILLS/spawn/scripts/spawn-amp"
fi
if [ -f "$CONFIG_SKILLS/chrome-cdp/scripts/cdp.mjs" ]; then
    chmod +x "$CONFIG_SKILLS/chrome-cdp/scripts/cdp.mjs"
fi
ok "Config skills installed (16 skills)"

# ── Settings ──
info "Installing settings..."
backup_if_exists "$PI_AGENT/settings.json"
cp "$SCRIPT_DIR/settings.json" "$PI_AGENT/settings.json"
ok "Settings installed"

# ── Models (context window override) ──
if [ -f "$SCRIPT_DIR/models.json" ]; then
    info "Installing model overrides..."
    backup_if_exists "$PI_AGENT/models.json"
    cp "$SCRIPT_DIR/models.json" "$PI_AGENT/models.json"
    ok "Model overrides installed (Opus 1M context window)"
fi

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

# ── Pi packages (npm, discovered by pi at runtime) ──
info "Installing pi packages..."
packages=(
    "npm:pi-web-access"
    "npm:pi-context"
    "npm:pi-token-burden"
    "npm:pi-claude-bridge"
)
for pkg in "${packages[@]}"; do
    info "  Installing $pkg..."
    pi install "$pkg" 2>/dev/null || warn "Failed to install $pkg (install manually with: pi install $pkg)"
done
ok "Pi packages installed (${#packages[@]} packages)"

# ── pi-claude-bridge patches ──
BRIDGE_INDEX="/opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts"
if [ -f "$BRIDGE_INDEX" ] && [ -f "$SCRIPT_DIR/claude-bridge-patches/index.ts" ]; then
    info "Applying pi-claude-bridge system prompt patches..."
    cp "$SCRIPT_DIR/claude-bridge-patches/index.ts" "$BRIDGE_INDEX"
    ok "pi-claude-bridge patches applied (custom system prompt)"
else
    warn "pi-claude-bridge not found or patch file missing — apply patches manually"
fi

echo ""
echo "╭─────────────────────────────────────────╮"
echo "│   ✅ All done!                          │"
echo "│                                         │"
echo "│   Installed:                            │"
echo "│   • 14 extensions                       │"
echo "│   • 25 custom tools (10 replaced + 15)  │"
echo "│   • 2 themes (gruvbox active)           │"
echo "│   • 18 config skills + 3 pi skills      │"
echo "│   • 9 agent prompts                     │"
echo "│   • Settings, keybindings, permissions  │"
echo "│   • 4 pi packages                       │"
echo "│   • pi-claude-bridge (global npm)       │"
echo "│   • Bridge patches applied              │"
echo "│                                         │"
echo "│   Claude usage:                         │"
echo "│   /model claude-sonnet-4-6              │"
echo "│                                         │"
echo "│   Debug: CLAUDE_BRIDGE_DEBUG=1 pi       │"
echo "│   Then restart pi.                      │"
echo "╰─────────────────────────────────────────╯"
echo ""
