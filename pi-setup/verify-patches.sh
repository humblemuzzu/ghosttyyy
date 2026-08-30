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

# ── pi entrypoint: modular CLI, not the 0.84.3 bundled runtime ──
# 0.84.3's bin is dist/bundle/cli.js, which inlines its own copies of
# resource-loader, keybindings, session-selector and pi-tui. The bundle never
# loads the on-disk files the checks below verify, so a bundle switch would
# silently disable every core patch while this script still reports PASS.
PI_BIN_TARGET="$(readlink "$(command -v pi)" 2>/dev/null || command -v pi)"
if [[ "$PI_BIN_TARGET" != *"dist/bundle/cli.js" ]]; then
    pass "pi entrypoint: modular CLI (dist/cli.js — patches load)"
else
    fail "pi entrypoint: bundled runtime — every core patch is inert" \
         "ln -sfn ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /opt/homebrew/bin/pi && bash pi-setup/verify-patches.sh"
fi

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

# ── pi core: compaction toolChoice guard (0.84.3 regression, breaks /compact) ──
# 0.84.3 sends toolChoice:"none" on every summarization request, but the
# summarization context carries no tools — xAI/OpenAI reject tool_choice without
# tools with a 400, so /compact fails. Our patch only sets toolChoice when tools
# exist. Without it, /compact dies with "A tool_choice was set on the request
# but no tools were specified."
if grep -q "context.tools?.length" "$PI_DIST/core/compaction/compaction.js" 2>/dev/null; then
    pass "pi core: compaction toolChoice guard (0.84.3 /compact regression)"
else
    fail "pi core: compaction toolChoice guard missing — /compact will 400 on xAI/OpenAI" \
         "cp pi-setup/pi-core-patches/compaction.js $PI_DIST/core/compaction/compaction.js"
fi

# ── pi-tui: conservative widths in ALL copies (TUI smears without it) ──
if node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs" --check >/dev/null 2>&1; then
    pass "pi-tui: width patch present in ALL installed copies"
else
    fail "pi-tui: width patch missing in some copies (TUI will smear on exotic unicode)" \
         "node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs"
fi

# ── condensed-milk: REMOVED 2026-07-30 ──
# Uninstalled deliberately. It required three local patches (\$-prefix strip, cmd
# param support, and a guard against compressing failed calls) and still produced
# silent data-integrity bugs: its git-mutations filter rewrote a REJECTED
# `git add -A` into "ok (1 files staged)". Its context masking also blanked older
# tool results at 30% context use, which actively hampered debugging.
# If any copy reappears (e.g. a stale global install), flag it — nothing should
# be patching or loading it any more.
cm_copies=$(find "$HOME/.pi/agent/npm" /opt/homebrew/lib/node_modules -path '*/@tomooshi/condensed-milk-pi/index.ts' 2>/dev/null)
if [ -z "$cm_copies" ]; then
    pass "condensed-milk: fully removed (no copies installed)"
else
    fail "condensed-milk: a copy is still installed at $(dirname "$cm_copies")" \
         "pi remove npm:@tomooshi/condensed-milk-pi  # it was removed deliberately, see AGENTS.md"
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

# ── sub-agents: provider-qualified --model (pi 0.84.0 #7327) ──
# A bare model id like "claude-opus-4-6" used to resolve to the first catalog
# entry; since 0.84.0 it HARD ERRORS when several authenticated providers offer
# the same id ("ambiguous across providers: anthropic/…, opencode/…"). That
# takes out oracle, finder, code_review, librarian, read_session and
# read_web_page at once, with an error that reads like an auth problem.
# qualifyModel() attaches the provider at the single spawn seam.
if grep -q "qualifyModel" "$PI_AGENT/extensions/tools/lib/pi-spawn.ts" 2>/dev/null; then
    pass "sub-agents: --model is provider-qualified (pi-spawn qualifyModel)"
else
    fail "sub-agents: pi-spawn.ts has no qualifyModel — every sub-agent will fail with \"ambiguous across providers\"" \
         "cp pi-setup/extensions/tools/lib/pi-spawn.ts ~/.pi/agent/extensions/tools/lib/pi-spawn.ts"
fi

# ── pi-sub: grok usage provider (local patch) ──
# Factory + PROVIDERS entry must land together. A settings entry without the
# factory throws PROVIDER_FACTORIES[name] is not a function on every refresh.
SUB_NM="$PI_AGENT/npm/node_modules/@marckrenn"
if grep -q 'grok: () => new GrokProvider' "$SUB_NM/pi-sub-core/src/providers/registry.ts" 2>/dev/null && \
   grep -q '"grok"' "$SUB_NM/pi-sub-shared/index.ts" 2>/dev/null && \
   [ -f "$SUB_NM/pi-sub-core/src/providers/impl/grok.ts" ]; then
    pass "pi-sub: grok provider factory + shared PROVIDERS entry"
else
    fail "pi-sub: grok provider patch missing" \
         "re-run pi-setup/install.sh (pi-sub-patches block) or cp pi-setup/pi-sub-patches/* into ~/.pi/agent/npm/node_modules/@marckrenn/"
fi

# ── shiki-diff: pi-diff render pipeline (edit/write syntax-highlighted diffs) ──
# The edit/write tools call @heyhuynhgiabuu/pi-diff's __testing render functions.
# They fall back to the plain box renderer if this breaks, so it's non-fatal —
# but a FAIL here means the pretty diffs are silently off (adapter degraded).
# NOTE: this probes with plain `node`; pi loads extensions under jiti, so this is
# a strong signal but not a 100%-fidelity check of the runtime import path.
TOOLS_DIR="$PI_AGENT/extensions/tools"
if [ ! -d "$TOOLS_DIR/node_modules/@heyhuynhgiabuu/pi-diff" ]; then
    fail "shiki-diff: @heyhuynhgiabuu/pi-diff not installed (edit/write diffs fall back to plain)" \
         "(cd \"$TOOLS_DIR\" && npm install)"
else
    # exit 0 = full pipeline incl renderSplit; 2 = mandatory ok but renderSplit
    # missing (edit degrades to unified — non-fatal); 3 = mandatory API missing.
    ( cd "$TOOLS_DIR" && node --input-type=module -e "const m=await import('@heyhuynhgiabuu/pi-diff');const t=m?.__testing;if(!t||typeof t.parsePatchFiles!=='function'||typeof t.renderUnified!=='function')process.exit(3);process.exit(typeof t.renderSplit==='function'?0:2)" ) >/dev/null 2>&1
    cm_rc=$?
    if [ "$cm_rc" -eq 0 ]; then
        pass "shiki-diff: pi-diff __testing pipeline (parsePatchFiles + renderUnified + renderSplit)"
    elif [ "$cm_rc" -eq 2 ]; then
        pass "shiki-diff: pi-diff __testing pipeline present; renderSplit missing — edit uses unified"
    else
        fail "shiki-diff: pi-diff __testing API changed — edit/write diffs degraded to plain fallback" \
             "update extensions/tools/lib/shiki-diff.ts to the new pi-diff export shape (see AGENTS.md)"
    fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PATCHES IN PLACE ✓"
else
    echo "SOME PATCHES MISSING — run pi-setup/install.sh or the per-item fixes above"
fi
exit $FAIL
