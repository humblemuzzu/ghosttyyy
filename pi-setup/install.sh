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
#   ~/.pi/agent/themes/         — gruvbox, nightowl, catppuccin-mocha, black-metal
#   ~/.pi/agent/agents/         — agent/prompt markdown files (system prompt, sub-agents, etc.)
#   ~/.pi/agent/skills/         — pi-level skills
#   ~/.pi/agent/settings.json   — settings (anthropic default, gruvbox theme, compaction on, etc.)
#   ~/.pi/agent/keybindings.json
#   ~/.pi/agent/models.json     — custom providers and model overrides
#   ~/.pi/agent/agent-models.json — sub-agent model list + per-agent default model/thinking
#   ~/.pi/agent/permissions.json
#   ~/.config/mcp/mcp.json      — pi-mcp-adapter global MCP servers
#   ~/.pi/agent/pi-sub-bar-settings.json  — seed only; never overwrites a live TUI theme
#   ~/.pi/agent/pi-sub-core-settings.json — seed only; never overwrites live provider on/off
#   ~/.config/agents/skills/    — config skills (pi-setup/config-skills/)
#   pi packages                 — the `packages` array below, mirrored from settings.json
#
# NO global npm packages are installed. Every pi package lives in
# ~/.pi/agent/npm/node_modules (installed by `pi install`), which is the ONLY
# place pi loads them from; a global copy is unloadable and ships an unpatched pi-tui.
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

# Copy every file the repo owns into place. Files the repo does not own are kept
# and reported, never deleted.
sync_dir() {
    local src="$1" target="$2"
    if [ ! -d "$src" ]; then
        warn "Source missing, skipped: $src"
        return 0
    fi
    backup_if_exists "$target"
    mkdir -p "$target"
    cp -R "$src/." "$target/" 2>/dev/null || warn "Copy reported errors: $src"
    local orphans
    orphans=$(cd "$target" && find . \( -type f -o -type l \) -print | sed 's|^\./||' | sort | while IFS= read -r f; do
        [ -e "$src/$f" ] || printf '%s\n' "$f"
    done) || true
    if [ -n "$orphans" ]; then
        warn "Kept $(printf '%s\n' "$orphans" | wc -l | tr -d ' ') file(s) the repo does not own:"
        printf '%s\n' "$orphans" | sed 's/^/    /'
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

# ── Extensions ──
info "Installing extensions..."
sync_dir "$SCRIPT_DIR/extensions" "$PI_AGENT/extensions"

# Install tool dependencies if npm is available
if [ -f "$PI_AGENT/extensions/tools/package.json" ] && command -v npm &>/dev/null; then
    info "Installing tool extension dependencies (npm install)..."
    # the copied lockfile stores the file: links relative to the repo checkout, which sits at a different depth
    (cd "$PI_AGENT/extensions/tools" && npm install --no-package-lock --silent 2>/dev/null) || warn "npm install failed — you may need to run it manually"
fi
ok "Extensions installed"

# ── Themes ──
info "Installing themes..."
sync_dir "$SCRIPT_DIR/themes" "$PI_AGENT/themes"
ok "Themes installed"

# ── Agents (prompt files) ──
info "Installing agent prompts..."
sync_dir "$SCRIPT_DIR/agents" "$PI_AGENT/agents"
ok "Agent prompts installed"

# ── Pi-level skills ──
info "Installing pi skills..."
sync_dir "$SCRIPT_DIR/pi-skills" "$PI_AGENT/skills"
ok "Pi skills installed"

# ── Config-level skills ──
info "Installing config skills..."
sync_dir "$SCRIPT_DIR/config-skills" "$CONFIG_SKILLS"

# Make scripts executable
if [ -f "$CONFIG_SKILLS/chrome-cdp/scripts/cdp.mjs" ]; then
    chmod +x "$CONFIG_SKILLS/chrome-cdp/scripts/cdp.mjs"
fi
ok "Config skills installed"

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
    ok "Custom providers installed (models.json)"
fi

# ── Sub-agent models ──
info "Installing sub-agent models..."
backup_if_exists "$PI_AGENT/agent-models.json"
cp "$SCRIPT_DIR/agent-models.json" "$PI_AGENT/agent-models.json"
ok "Sub-agent models installed (agent-models.json)"

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
    mkdir -p "$HOME/.config/mcp"
    backup_if_exists "$HOME/.config/mcp/mcp.json"
    cp "$SCRIPT_DIR/mcp.json" "$HOME/.config/mcp/mcp.json"
    ok "Global MCP config installed (~/.config/mcp/mcp.json)"
fi
if [ -f "$PI_AGENT/mcp.json" ]; then
    backup_if_exists "$PI_AGENT/mcp.json"
    rm -f "$PI_AGENT/mcp.json"
    ok "Removed leftover $PI_AGENT/mcp.json (adapter reads ~/.config/mcp/mcp.json)"
fi

# ── Pi package configs (sub-bar, sub-core) ──
# live copies are TUI-saved; only seed when missing
info "Installing pi package configs..."
for cfg in pi-sub-bar-settings.json pi-sub-core-settings.json; do
    if [ -f "$SCRIPT_DIR/$cfg" ]; then
        if [ -f "$PI_AGENT/$cfg" ]; then
            warn "Keeping live $cfg — not overwriting"
        else
            cp "$SCRIPT_DIR/$cfg" "$PI_AGENT/$cfg"
            ok "Seeded $cfg (no live copy)"
        fi
    fi
done
ok "Pi package configs installed (sub-bar, sub-core)"

# ── Pi packages (npm, discovered by pi at runtime) ──
info "Installing pi packages..."
# Mirror of settings.json "packages"; never re-add one AGENTS.md lists as removed.
packages=(
    "npm:pi-token-burden"
    "npm:@benvargas/pi-claude-code-use@2.2.1"
    "npm:@marckrenn/pi-sub-bar"
    "npm:pi-tool-display"
    "npm:pi-codex-goal@0.6.0"
    "npm:pi-mcp-adapter@5.1.0"
)
for pkg in "${packages[@]}"; do
    info "  Installing $pkg..."
    pi install "$pkg" 2>/dev/null || warn "Failed to install $pkg (install manually with: pi install $pkg)"
done
ok "Pi packages installed (${#packages[@]} packages)"

# ── pi core patches (dist/) ──
# These patch the pi CLI itself. resource-loader.js is CRITICAL — without it pi
# refuses to start (our tools override built-in tool names).
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
    # pi-server: some pi versions import it without declaring the dependency.
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
# Re-run install.sh after any sub-bar/sub-core update (pi update restores stock).
SUB_NM="$PI_AGENT/npm/node_modules/@marckrenn"
SUB_PATCH="$SCRIPT_DIR/pi-sub-patches"
if [ -d "$SUB_NM/pi-sub-core" ] && [ -f "$SUB_PATCH/manifest.txt" ]; then
    info "Applying pi-sub grok provider patch..."
    sub_failed=0
    while read -r src dest || [ -n "$src" ]; do
        [ -z "$src" ] && continue
        cp "$SUB_PATCH/$src" "$SUB_NM/$dest" || { warn "pi-sub patch: could not copy $src → $dest"; sub_failed=1; }
    done < "$SUB_PATCH/manifest.txt"
    if [ "$sub_failed" -eq 0 ]; then ok "pi-sub grok provider patch applied"; else warn "pi-sub grok provider patch INCOMPLETE — see above"; fi
else
    warn "pi-sub packages or pi-sub-patches missing — grok usage provider not installed"
fi

# ── pi-sub-core stale-ctx guard ──
if [ -f "$SUB_PATCH/apply-sub-core-stale-guard.mjs" ] && [ -d "$SUB_NM/pi-sub-core" ]; then
    info "Applying pi-sub-core stale-ctx guard..."
    node "$SUB_PATCH/apply-sub-core-stale-guard.mjs" || \
        warn "pi-sub-core stale-ctx guard FAILED — a usage fetch outliving /resume will exit pi"
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
echo "│   • custom tools                        │"
echo "│   • pi themes (gruvbox active)          │"
echo "│   • config skills                       │"
echo "│   • agent prompts                       │"
echo "│   • Settings, keybindings, permissions  │"
echo "│   • Sub-bar, sub-core configs           │"
echo "│   • pi packages                         │"
echo "│   • pi core patched (conflict + pins)   │"
echo "│   • pi-tool-display configured          │"
echo "│                                         │"
echo "│   Claude Max (OAuth):                   │"
echo "│   /login anthropic                      │"
echo "│   /model anthropic/claude-opus-5-5      │"
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
