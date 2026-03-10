#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# ghosttyyy installer
# One command to set up everything
# ─────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
GHOSTTY_CONFIG_DIR="$HOME/Library/Application Support/com.mitchellh.ghostty"
GHOSTTY_THEMES_DIR="$HOME/.config/ghostty/themes"
SCRIPTS_DIR="$HOME/.local/bin"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║     👻 ghosttyyy installer               ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: Check for Ghostty ────────────────────
if ! [ -d "/Applications/Ghostty.app" ]; then
  echo "  ⚠️  Ghostty not found at /Applications/Ghostty.app"
  echo "  Install it from https://ghostty.org"
  echo ""
  read -p "  Continue anyway? (y/n): " choice
  [ "$choice" != "y" ] && exit 0
fi
echo "  ✅ Ghostty found"

# ── Step 2: Install dependencies ─────────────────
echo ""
echo "  📦 Installing dependencies..."

if ! command -v brew &>/dev/null; then
  echo "  ⚠️  Homebrew not found. Install from https://brew.sh"
  exit 1
fi

if ! command -v fzf &>/dev/null; then
  echo "  Installing fzf..."
  brew install fzf
fi
echo "  ✅ fzf installed"

# ── Step 3: Install fonts ────────────────────────
echo ""
echo "  🔤 Installing developer fonts..."

fonts=(
  "font-jetbrains-mono"
  "font-fira-code"
  "font-cascadia-code"
  "font-victor-mono"
  "font-geist-mono"
  "font-monaspace"
  "font-maple-mono"
  "font-commit-mono"
  "font-iosevka"
)

for font in "${fonts[@]}"; do
  if brew list --cask "$font" &>/dev/null; then
    echo "  ✅ $font (already installed)"
  else
    echo "  Installing $font..."
    brew install --cask "$font" 2>/dev/null || echo "  ⚠️  Failed to install $font (skipping)"
  fi
done

# ── Step 4: Copy config ──────────────────────────
echo ""
echo "  ⚙️  Setting up Ghostty config..."

mkdir -p "$GHOSTTY_CONFIG_DIR"

if [ -f "$GHOSTTY_CONFIG_DIR/config" ]; then
  cp "$GHOSTTY_CONFIG_DIR/config" "$GHOSTTY_CONFIG_DIR/config.backup.$(date +%s)"
  echo "  📋 Backed up existing config"
fi

cp "$REPO_DIR/config" "$GHOSTTY_CONFIG_DIR/config"
echo "  ✅ Config installed → $GHOSTTY_CONFIG_DIR/config"

# ── Step 5: Copy themes ──────────────────────────
echo ""
echo "  🎨 Installing themes..."

mkdir -p "$GHOSTTY_THEMES_DIR"
cp "$REPO_DIR/themes/"* "$GHOSTTY_THEMES_DIR/"
echo "  ✅ $(ls "$REPO_DIR/themes/" | wc -l | tr -d ' ') themes installed → $GHOSTTY_THEMES_DIR/"

# ── Step 6: Install scripts ──────────────────────
echo ""
echo "  🛠️  Installing switcher scripts..."

mkdir -p "$SCRIPTS_DIR"
cp "$REPO_DIR/scripts/gtheme" "$SCRIPTS_DIR/gtheme"
cp "$REPO_DIR/scripts/gfont" "$SCRIPTS_DIR/gfont"
cp "$REPO_DIR/scripts/gcursor" "$SCRIPTS_DIR/gcursor"
cp "$REPO_DIR/scripts/ghostty-config" "$SCRIPTS_DIR/ghostty-config"
chmod +x "$SCRIPTS_DIR/gtheme" "$SCRIPTS_DIR/gfont" "$SCRIPTS_DIR/gcursor" "$SCRIPTS_DIR/ghostty-config"
echo "  ✅ Scripts installed → $SCRIPTS_DIR/"

# ── Step 7: Set up PATH and aliases ──────────────
echo ""
echo "  🔗 Setting up shell..."

SHELL_RC="$HOME/.zshrc"
if [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

# Add PATH if not present
if ! grep -q "$SCRIPTS_DIR" "$SHELL_RC" 2>/dev/null; then
  echo "" >> "$SHELL_RC"
  echo "# ── ghosttyyy ────────────────────────────" >> "$SHELL_RC"
  echo "export PATH=\"\$PATH:$SCRIPTS_DIR\"" >> "$SHELL_RC"
  echo "  ✅ Added $SCRIPTS_DIR to PATH"
else
  echo "  ✅ PATH already configured"
fi

# Add aliases if not present
if ! grep -q 'alias gg="ghostty-config"' "$SHELL_RC" 2>/dev/null; then
  cat >> "$SHELL_RC" << 'ALIASES'

# ── Ghostty switchers ────────────────────────────
alias gg="ghostty-config"     # master config hub
alias gt="gtheme"             # switch theme
alias gf="gfont"              # switch font
alias gc="gcursor"            # switch cursor
ALIASES
  echo "  ✅ Added aliases (gg, gt, gf, gc)"
else
  echo "  ✅ Aliases already configured"
fi

# ── Step 8: Accessibility permissions ────────────
echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║  ⚠️  IMPORTANT: Grant Accessibility Permissions          ║"
echo "  ║                                                          ║"
echo "  ║  The live-preview feature needs macOS Accessibility      ║"
echo "  ║  permissions to send the reload shortcut to Ghostty.     ║"
echo "  ║                                                          ║"
echo "  ║  Go to:                                                  ║"
echo "  ║    System Settings → Privacy & Security → Accessibility  ║"
echo "  ║                                                          ║"
echo "  ║  Add and enable BOTH:                                    ║"
echo "  ║    • Ghostty                                             ║"
echo "  ║    • Terminal (or whichever terminal you run this from)   ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Done ─────────────────────────────────────────
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  🎉 Installation complete!               ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
echo "  Run: source $SHELL_RC"
echo "  Then open Ghostty and type any of:"
echo ""
echo "    gg  — master config hub"
echo "    gt  — switch theme (live preview)"
echo "    gf  — switch font (live preview)"
echo "    gc  — switch cursor (live preview)"
echo ""
echo "  Press ⌘+Shift+, in Ghostty to reload config anytime."
echo ""
