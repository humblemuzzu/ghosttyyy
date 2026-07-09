#!/bin/bash
# verify-patches.sh — read-only audit: is every patch/config still in place?
#
# Run after ANY pi update, package update, or `pi install`:
#   bash pi-setup/verify-patches.sh
#
# Exit 0 = everything in place. Exit 1 = something needs re-applying
# (run install.sh, or the specific fix printed next to each FAIL).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIST="/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist"
PI_AGENT="$HOME/.pi/agent"
FAIL=0

pass() { printf '\033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n    fix: %s\n' "$1" "$2"; FAIL=1; }

# ── pi core: tool-conflict suppression (pi won't START without it) ──
if [ -f "$PI_DIST/core/resource-loader.js" ] && \
   ! grep -q "for (const conflict of conflicts)" "$PI_DIST/core/resource-loader.js"; then
    pass "pi core: resource-loader conflict suppression"
else
    fail "pi core: resource-loader conflict suppression" \
         "cp pi-setup/pi-core-patches/resource-loader.js $PI_DIST/core/resource-loader.js"
fi

# ── pi core: session pinning ──
if grep -q "LOCAL PATCH" "$PI_DIST/modes/interactive/components/session-selector.js" 2>/dev/null && \
   grep -q "app.session.pin" "$PI_DIST/core/keybindings.js" 2>/dev/null; then
    pass "pi core: session pinning (Ctrl+B in /resume)"
else
    fail "pi core: session pinning" \
         "cp pi-setup/pi-core-patches/{session-selector.js,keybindings.js} into dist (see AGENTS.md)"
fi

# ── pi-tui: conservative widths in ALL copies (TUI smears without it) ──
if node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs" --check >/dev/null 2>&1; then
    pass "pi-tui: width patch present in ALL installed copies"
else
    fail "pi-tui: width patch missing in some copies (TUI will smear on exotic unicode)" \
         "node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs"
fi

# ── condensed-milk: \$-prefix strip (WRONG git data without it) ──
CM="/opt/homebrew/lib/node_modules/@tomooshi/condensed-milk-pi"
if grep -q 'startsWith("\$ ")' "$CM/index.ts" 2>/dev/null && \
   grep -q "args.cmd" "$CM/filters/context-compress.ts" 2>/dev/null; then
    pass "condensed-milk: \$-prefix strip + cmd param support"
else
    fail "condensed-milk: patches missing (git status compression returns WRONG data)" \
         "cp pi-setup/condensed-milk-patches/... (see AGENTS.md quick re-patch)"
fi

# ── pi-gpt-config: tool-discipline overlay removed ──
GPTCFG="$PI_AGENT/git/github.com/edxeth/pi-gpt-config/index.ts"
if [ ! -f "$GPTCFG" ]; then
    pass "pi-gpt-config: not installed (nothing to patch)"
elif diff -q "$SCRIPT_DIR/gpt-config-patches/index.ts" "$GPTCFG" >/dev/null 2>&1; then
    pass "pi-gpt-config: patched build in place"
else
    fail "pi-gpt-config: live file differs from our patch" \
         "cp pi-setup/gpt-config-patches/index.ts $GPTCFG"
fi

# ── pi-tool-display: config with ALL tool overrides disabled ──
TDCFG="$PI_AGENT/extensions/pi-tool-display/config.json"
if [ -f "$TDCFG" ] && ! grep -q "true" <(python3 -c "
import json; c = json.load(open('$TDCFG'))
print(any(c.get('registerToolOverrides', {}).values()))" 2>/dev/null); then
    pass "pi-tool-display: config present, all tool overrides false"
else
    fail "pi-tool-display: config missing or overrides enabled (clobbers our custom tools)" \
         "cp pi-setup/extensions/pi-tool-display/config.json $TDCFG"
fi

# ── our extensions: smear fixes present in the LIVE deployed copies ──
if grep -q "flattenLabelText" "$PI_AGENT/extensions/editor/index.ts" 2>/dev/null && \
   grep -q "flattenSegmentText" "$PI_AGENT/extensions/editor/widget-row.ts" 2>/dev/null; then
    pass "editor extension: label newline guards (describeToolCall + sinks)"
else
    fail "editor extension: label guards missing (multiline bash cmds smear the TUI)" \
         "cp pi-setup/extensions/editor/* ~/.pi/agent/extensions/editor/"
fi

if grep -q "normalizeForDisplay" "$PI_AGENT/extensions/tools/lib/box-format.ts" 2>/dev/null; then
    pass "tools extension: box-format display normalization"
else
    fail "tools extension: box-format normalization missing" \
         "cp -R pi-setup/extensions/tools ~/.pi/agent/extensions/"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PATCHES IN PLACE ✓"
else
    echo "SOME PATCHES MISSING — run pi-setup/install.sh or the per-item fixes above"
fi
exit $FAIL
