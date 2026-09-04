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
#   ~/.pi/agent/extensions/     — custom extensions (editor, tools, mentions, md-export, etc.)
#   ~/.pi/agent/themes/         — gruvbox + nightowl themes
#   ~/.pi/agent/agents/         — agent/prompt markdown files (system prompt, sub-agents, etc.)
#   ~/.pi/agent/skills/         — pi-level skills
#   ~/.pi/agent/settings.json   — settings (anthropic default, gruvbox theme, compaction on, etc.)
#   ~/.pi/agent/keybindings.json
#   ~/.pi/agent/models.json     — model context window overrides
#   ~/.pi/agent/permissions.json
#   ~/.pi/agent/mcp.json        — pi-mcp-adapter global MCP servers (astro, paper)
#   ~/.pi/agent/pi-sub-bar-settings.json  — sub-bar widget layout
#   ~/.pi/agent/pi-sub-core-settings.json — sub-core provider/refresh config
#   ~/.config/agents/skills/    — 23 skills (git, review, spawn, tmux, dig, s-improve, mat-tdd, etc.)
#   pi packages (npm/git)       — token-burden, claude-code-use, sub-bar, autoresearch, tool-display, codex-goal, mcp-adapter
#
# NO global npm packages are installed. Every pi package lives in
# ~/.pi/agent/npm/node_modules (installed by `pi install`), which is the ONLY
# place pi loads them from. See the duplicate-copy cleanup note below.
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
    warn "pi not found. Install it first: npm install -g @earendil-works/pi-coding-agent"
    echo "  Then re-run this script."
    exit 1
fi
ok "pi found: $(pi --version 2>/dev/null || echo 'version unknown')"

# ── Create directories ──
info "Creating directories..."
mkdir -p "$PI_AGENT"
mkdir -p "$CONFIG_SKILLS"

# ── Global npm packages: DELIBERATELY NONE (2026-08-14) ──
# This block used to install pi-claude-bridge globally. It was removed because
# it was BROKEN and because global installs are dead weight:
#
#   1. `npm list -g` / `npm install -g` resolve to whatever `npm root -g` points
#      at — here the nvm root (~/.nvm/versions/node/<v>/lib/node_modules) — while
#      the patch block below hardcoded /opt/homebrew/lib/node_modules. So the
#      check always failed, the install went to one root, and the patch was
#      applied to a copy in a DIFFERENT root. It had been silently wrong for
#      months; nobody noticed because the bridge is inactive.
#   2. pi loads `npm:` packages ONLY from ~/.pi/agent/npm/node_modules
#      (`getManagedNpmInstallPath`, dist/core/package-manager.js:1710-1719). A
#      globally installed pi package is unreachable — it is not "inactive", it
#      is unloadable.
#
# 2026-08-14 cleanup removed ~3 GB of such copies from both global roots. Do not
# reintroduce a global install here; it will not be loaded and it will bring an
# UNPATCHED pi-tui copy back onto the machine (see the width-patch section).

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
ok "Extensions installed"

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
ok "Pi skills installed"

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
ok "Config skills installed (24 skills)"

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

# ── MCP servers (pi-mcp-adapter global config) ──
if [ -f "$SCRIPT_DIR/mcp.json" ]; then
    info "Installing global MCP config..."
    backup_if_exists "$PI_AGENT/mcp.json"
    cp "$SCRIPT_DIR/mcp.json" "$PI_AGENT/mcp.json"
    ok "Global MCP config installed (astro @ 127.0.0.1:8089, paper @ 127.0.0.1:29979)"
fi

# ── Pi package configs (sub-bar, sub-core) ──
# pi-vcc was removed (using pi's native compaction). Its config is no longer deployed.
info "Installing pi package configs..."
for cfg in pi-sub-bar-settings.json pi-sub-core-settings.json; do
    if [ -f "$SCRIPT_DIR/$cfg" ]; then
        backup_if_exists "$PI_AGENT/$cfg"
        cp "$SCRIPT_DIR/$cfg" "$PI_AGENT/$cfg"
    fi
done
ok "Pi package configs installed (sub-bar, sub-core)"

# ── Pi packages (npm, discovered by pi at runtime) ──
info "Installing pi packages..."
# Mirror of settings.json "packages" (source of truth). pi-claude-bridge removed.
packages=(
    "npm:pi-token-burden"
    "npm:@benvargas/pi-claude-code-use"
    "npm:@marckrenn/pi-sub-bar"
    "https://github.com/davebcn87/pi-autoresearch"
    "npm:pi-tool-display"
    "npm:pi-codex-goal"
    "npm:pi-mcp-adapter"
)
# NOTE: pi-context, todos.ts, pi-web-access, pi-tasks and
# @tomooshi/condensed-milk-pi were removed deliberately — do NOT re-add them
# here. See AGENTS.md.
# pi-web-access was still listed above until 2026-08-05, directly contradicting
# this comment: any fresh `install.sh` run silently reinstalled the package the
# rest of the setup assumes is gone, and its `web_search` collides with ours.
for pkg in "${packages[@]}"; do
    info "  Installing $pkg..."
    pi install "$pkg" 2>/dev/null || warn "Failed to install $pkg (install manually with: pi install $pkg)"
done
ok "Pi packages installed (${#packages[@]} packages)"


# ── condensed-milk: REMOVED 2026-07-30, nothing to patch ──
# It needed three local patches and still silently corrupted data: its
# git-mutations filter rewrote a REJECTED `git add -A` into "ok (1 files
# staged)", and its context masking blanked older tool results at 30% context
# use. Removed rather than carrying a fourth patch. Do not reinstall.

# ── pi core patches (dist/) ──
# These patch the pi CLI itself. resource-loader.js is CRITICAL — without it pi
# refuses to start (our web_search override conflicts with pi-web-access).
# session-selector.js + keybindings.js add session pinning (Ctrl+B in /resume).
# pi-tui-utils.js is CRITICAL — conservative grapheme widths; without it heavy
# output containing Indic matras/conjuncts or text-presentation emoji desyncs
# the differential renderer and smears the whole TUI (see AGENTS.md).
PI_CORE_DIST="/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist"
if [ -d "$PI_CORE_DIST" ] && [ -d "$SCRIPT_DIR/pi-core-patches" ]; then
    info "Applying pi core patches (tool-conflict suppression + session pinning + TUI widths)..."
    [ -f "$SCRIPT_DIR/pi-core-patches/resource-loader.js" ] && \
        cp "$SCRIPT_DIR/pi-core-patches/resource-loader.js" "$PI_CORE_DIST/core/resource-loader.js"
    [ -f "$SCRIPT_DIR/pi-core-patches/session-selector.js" ] && \
        cp "$SCRIPT_DIR/pi-core-patches/session-selector.js" "$PI_CORE_DIST/modes/interactive/components/session-selector.js"
    [ -f "$SCRIPT_DIR/pi-core-patches/keybindings.js" ] && \
        cp "$SCRIPT_DIR/pi-core-patches/keybindings.js" "$PI_CORE_DIST/core/keybindings.js"
    # pi-tui width patch: pi-tui exists in MANY copies (pi core + every npm
    # package bundles its own). The script finds and patches ALL of them —
    # a single unpatched copy (e.g. pi-tool-display's) still smears the TUI.
    if [ -f "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs" ]; then
        node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs" || \
            warn "pi-tui width patch failed on some copies — TUI may smear on exotic unicode (see AGENTS.md)"
    else
        warn "apply-pi-tui-width-patch.mjs missing — TUI smears on exotic unicode without it"
    fi
    # pi-server: 0.85.0 modular cli.js imports it but the npm package forgets
    # the dependency — every command crashes without it.
    if [ -f "$SCRIPT_DIR/pi-core-patches/install-pi-server.sh" ]; then
        bash "$SCRIPT_DIR/pi-core-patches/install-pi-server.sh" || \
            warn "pi-server install failed — pi may not start (see AGENTS.md)"
    fi
    ok "pi core patches applied (resource-loader + session pinning + pi-tui widths + pi-server)"
else
    warn "pi core dist or patch files missing — apply pi-core-patches manually"
fi

# ── pi-sub grok provider patch ──
# Local addition of a Grok usage provider to pi-sub-core/shared/bar. Upstream
# has no provider plugin hook — PROVIDER_FACTORIES is a hardcoded map — so the
# only way in is patching the installed package copies after every `pi install`.
# Stock copies are restored by `pi update --extensions`; re-run install.sh (or
# the cp block below) after any sub-bar/sub-core update.
SUB_NM="$PI_AGENT/npm/node_modules/@marckrenn"
SUB_PATCH="$SCRIPT_DIR/pi-sub-patches"
if [ -d "$SUB_NM/pi-sub-core" ] && [ -d "$SUB_PATCH" ]; then
    info "Applying pi-sub grok provider patch..."
    [ -f "$SUB_PATCH/pi-sub-shared-index.ts" ] && \
        cp "$SUB_PATCH/pi-sub-shared-index.ts" "$SUB_NM/pi-sub-shared/index.ts"
    [ -f "$SUB_PATCH/registry.ts" ] && \
        cp "$SUB_PATCH/registry.ts" "$SUB_NM/pi-sub-core/src/providers/registry.ts"
    [ -f "$SUB_PATCH/grok.ts" ] && \
        cp "$SUB_PATCH/grok.ts" "$SUB_NM/pi-sub-core/src/providers/impl/grok.ts"
    [ -f "$SUB_PATCH/bar-metadata.ts" ] && \
        cp "$SUB_PATCH/bar-metadata.ts" "$SUB_NM/pi-sub-bar/src/providers/metadata.ts"
    [ -f "$SUB_PATCH/bar-settings-types.ts" ] && \
        cp "$SUB_PATCH/bar-settings-types.ts" "$SUB_NM/pi-sub-bar/src/settings-types.ts"
    ok "pi-sub grok provider patch applied"
else
    warn "pi-sub packages or pi-sub-patches missing — grok usage provider not installed"
fi

# ── pi-tool-display config ──
TOOL_DISPLAY_CONFIG="$PI_AGENT/extensions/pi-tool-display/config.json"
if [ -f "$SCRIPT_DIR/extensions/pi-tool-display/config.json" ]; then
    info "Installing pi-tool-display config (all tool overrides disabled)..."
    mkdir -p "$PI_AGENT/extensions/pi-tool-display"
    cp "$SCRIPT_DIR/extensions/pi-tool-display/config.json" "$TOOL_DISPLAY_CONFIG"
    ok "pi-tool-display config installed"
fi

echo ""
echo "╭─────────────────────────────────────────╮"
echo "│   ✅ All done!                          │"
echo "│                                         │"
echo "│   Installed:                            │"
echo "│   • custom extensions                   │"
echo "│   • 28 custom tools               │"
echo "│   • 2 themes (gruvbox active)           │"
echo "│   • 24 config skills                    │"
echo "│   • 9 agent prompts                     │"
echo "│   • Settings, keybindings, permissions  │"
echo "│   • Sub-bar, sub-core configs           │"
echo "│   • 7 pi packages                       │"
echo "│   • pi core patched (conflict + pins)   │"
echo "│   • pi-tool-display configured          │"
echo "│                                         │"
echo "│   Claude Max (OAuth):                   │"
echo "│   /login anthropic                      │"
echo "│   /model anthropic/claude-opus-5      │"
echo "│   (pi-claude-code-use patches payloads) │"
echo "│                                         │"
echo "│   Debug: PI_DEBUG=1 pi                  │"
echo "│   Then restart pi.                      │"
echo "╰─────────────────────────────────────────╯"
echo ""

# ── final audit: verify every patch actually landed ──
if [ -f "$SCRIPT_DIR/verify-patches.sh" ]; then
    info "Verifying all patches are in place..."
    bash "$SCRIPT_DIR/verify-patches.sh" || warn "Some patches missing — see FAIL lines above"
fi
