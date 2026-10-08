#!/bin/bash
# verify-patches.sh — read-only audit: is every patch/config still in place?
#
# Run after ANY pi update, package update, or `pi install`:
#   bash pi-setup/verify-patches.sh
#
# Exit 0 = everything in place. Exit 1 = something needs re-applying
# (run install.sh, or the specific fix printed next to each FAIL).
# Fix commands assume the repo root as cwd.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIST="/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist"
PI_AGENT="$HOME/.pi/agent"
FAIL=0

pass() { printf '\033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n    fix: %s\n' "$1" "$2"; FAIL=1; }

# ── pi entrypoint: modular CLI, not the bundled runtime ──
# dist/bundle/cli.js inlines its own resource-loader, keybindings,
# session-selector and pi-tui, so under the bundle every core patch below is
# inert while its check still passes.
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
         "cp pi-setup/pi-core-patches/session-selector.js $PI_DIST/modes/interactive/components/session-selector.js && cp pi-setup/pi-core-patches/keybindings.js $PI_DIST/core/keybindings.js"
fi

# ── pi core: compaction must be STOCK ──
# pi-core-patches/compaction.js is retired; copying it would undo upstream's
# toolChoice fix and break /compact on xAI/OpenAI.
if [ -f "$PI_DIST/core/compaction/compaction.js" ] && \
   ! grep -q "toolChoice" "$PI_DIST/core/compaction/compaction.js" && \
   grep -q "getSummarizationFailure" "$PI_DIST/core/compaction/compaction.js"; then
    pass "pi core: compaction is stock (/compact OK)"
else
    fail "pi core: compaction drifted — stock has no toolChoice and defines getSummarizationFailure" \
         "reinstall pi with: bash pi-setup/update-pi.sh <current version>  # never copy pi-core-patches/compaction.js"
fi

# ── pi-tui: conservative widths in ALL copies (TUI smears without it) ──
if node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs" --check >/dev/null 2>&1; then
    pass "pi-tui: width patch present in ALL installed copies"
else
    fail "pi-tui: width patch missing in some copies (TUI will smear on exotic unicode)" \
         "node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs"
fi

# ── pi-server: some pi versions import it without declaring the dependency ──
PI_PKG="$(dirname "$PI_DIST")"
if ! grep -q "@earendil-works/pi-server" "$PI_DIST/experimental/server.js" 2>/dev/null; then
    pass "pi core: pi-server not needed (not imported by this pi)"
elif [ -d "$PI_PKG/node_modules/@earendil-works/pi-server" ]; then
    pass "pi core: pi-server present"
else
    fail "pi core: @earendil-works/pi-server missing — every command crashes (ERR_MODULE_NOT_FOUND)" \
         "bash pi-setup/pi-core-patches/install-pi-server.sh"
fi

# ── removed packages must stay removed (AGENTS.md "Removed — do not reinstall") ──
REMOVED_PKGS=(
    pi-context todos pi-web-access pi-tasks @tomooshi/condensed-milk-pi
    claude-agent-sdk-pi @sting8k/pi-vcc pi-computer-use pi-gpt-config pi-ask
    pi-grok-cli pi-claude-bridge lsp-pi pi-powerline-footer pi-anycopy
    pi-autoresearch
)
NPM_GLOBAL="$(npm root -g 2>/dev/null || true)"
removed_found=""
for pkg in "${REMOVED_PKGS[@]}"; do
    for root in "$PI_AGENT/npm/node_modules" /opt/homebrew/lib/node_modules ${NPM_GLOBAL:+"$NPM_GLOBAL"}; do
        [ -d "$root/$pkg" ] && removed_found+=" $root/$pkg"
    done
    git_hit=$(find "$PI_AGENT/git" -mindepth 3 -maxdepth 3 -type d -name "${pkg##*/}" 2>/dev/null)
    [ -n "$git_hit" ] && removed_found+=" $git_hit"
    for ext in json ts; do
        [ -e "$PI_AGENT/extensions/${pkg##*/}.$ext" ] && removed_found+=" $PI_AGENT/extensions/${pkg##*/}.$ext"
    done
    grep -qE "\"npm:${pkg}(@[^\"]*)?\"|\"git:[^\"]*/${pkg##*/}(@[^\"]*)?\"" "$PI_AGENT/settings.json" 2>/dev/null \
        && removed_found+=" settings.json→$pkg"
done
if [ -z "$removed_found" ]; then
    pass "removed packages: none installed, configured or listed in settings.json"
else
    fail "removed packages are back:$removed_found" \
         "pi remove <source> for each, and trash any leftover dir or config named above"
fi

# ── pi-tool-display: config with ALL tool overrides disabled ──
TDCFG="$PI_AGENT/extensions/pi-tool-display/config.json"
if [ -f "$TDCFG" ] && python3 -c '
import json, sys
overrides = json.load(open(sys.argv[1])).get("registerToolOverrides", {})
sys.exit(1 if any(overrides.values()) else 0)' "$TDCFG" 2>/dev/null; then
    pass "pi-tool-display: config present, all tool overrides false"
else
    fail "pi-tool-display: config missing, unreadable, or an override is true (clobbers our custom tools)" \
         "cp pi-setup/extensions/pi-tool-display/config.json $TDCFG"
fi

# ── images: pi still normalizes tool images with the profile lib/image-budget.ts assumes ──
# Our tools size every image to pass pi's normalizer untouched; that normalizer
# is also what clamps every OTHER tool's images under the API's many-image limit.
IMG_REPORT=$(python3 - "$PI_AGENT/settings.json" "$PI_DIST/utils/image-resize-core.js" "$PI_DIST/core/agent-session.js" <<'PY'
import json, re, sys
settings, core, session = sys.argv[1:4]
problems = []
try:
    if json.load(open(settings)).get("images", {}).get("autoResize") is False:
        problems.append("settings.json sets images.autoResize false")
except FileNotFoundError:
    pass
src = open(core).read()
if not re.search(r"maxWidth:\s*2000", src) or not re.search(r"maxHeight:\s*2000", src) or "4.5 * 1024 * 1024" not in src:
    problems.append("pi's default resize profile is no longer 2000x2000 / 4.5 MiB (update PI_DEFAULT_RESIZE)")
if "normalizeToolResultImages" not in open(session).read():
    problems.append("agent-session.js no longer normalizes tool result images")
print("; ".join(problems))
PY
)
if [ -z "$IMG_REPORT" ]; then
    pass "images: pi normalizes tool images, default profile 2000px / 4.5 MiB, autoResize on"
else
    fail "images: $IMG_REPORT" \
         "re-check lib/image-budget.ts against pi's utils/image-resize-core.js, then re-run bun test lib/image-fit.test.ts"
fi

# ── agent prompts: every repo prompt is deployed ──
# pi-spawn reads sub-agent prompts from here; a missing file silently
# degrades that agent to the default body.
agents_missing=""
for f in "$SCRIPT_DIR"/agents/*.md; do
    [ -f "$PI_AGENT/agents/$(basename "$f")" ] || agents_missing+=" $(basename "$f")"
done
if [ -z "$agents_missing" ]; then
    pass "agent prompts: every pi-setup/agents/*.md is deployed"
else
    fail "agent prompts missing from $PI_AGENT/agents:$agents_missing" \
         "mkdir -p $PI_AGENT/agents && cp pi-setup/agents/*.md $PI_AGENT/agents/"
fi

# ── our extensions: smear fixes present in the LIVE deployed copies ──
if grep -q "flattenLabelText" "$PI_AGENT/extensions/editor/index.ts" 2>/dev/null && \
   grep -q "flattenSegmentText" "$PI_AGENT/extensions/editor/widget-row.ts" 2>/dev/null; then
    pass "editor extension: label newline guards (describeToolCall + sinks)"
else
    fail "editor extension: label guards missing (multiline bash cmds smear the TUI)" \
         "cp -R pi-setup/extensions/editor/. $PI_AGENT/extensions/editor/"
fi

if grep -q "normalizeForDisplay" "$PI_AGENT/extensions/tools/lib/box-format.ts" 2>/dev/null; then
    pass "tools extension: box-format display normalization"
else
    fail "tools extension: box-format normalization missing" \
         "cp -R pi-setup/extensions/tools/. $PI_AGENT/extensions/tools/ && (cd $PI_AGENT/extensions/tools && npm install --no-package-lock)"
fi

# ── sub-agents: agent-models.json loads cleanly and every model is in pi's catalog ──
# Parsed by the deployed loader itself, so this cannot drift from what the tools
# read. A model missing from `pi --list-models` would be refused at call time.
AM_REPORT=$(cd "$PI_AGENT/extensions/tools" 2>/dev/null && bun -e '
const { loadAgentModels } = await import("./lib/agent-models.ts");
const { execFileSync } = await import("node:child_process");
const config = loadAgentModels();
const listed = new Set(execFileSync("pi", ["--list-models"], { encoding: "utf-8" })
  .split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 1).map(([p, m]) => `${p}/${m}`));
const missing = Object.entries(config.models).filter(([, m]) => !listed.has(m.id)).map(([n, m]) => `${n} → ${m.id} not listed`);
console.log([...config.problems, ...missing].join("; "));
' 2>&1)
if [ -f "$PI_AGENT/agent-models.json" ] && [ -z "$AM_REPORT" ]; then
    pass "sub-agents: agent-models.json valid, every model listed by pi"
else
    fail "sub-agents: agent-models.json — ${AM_REPORT:-missing}" \
         "cp pi-setup/agent-models.json $PI_AGENT/agent-models.json  # then fix the named entries"
fi

# ── pi-sub: grok usage provider (local patch, files listed in manifest.txt) ──
SUB_NM="$PI_AGENT/npm/node_modules/@marckrenn"
SUB_MANIFEST="$SCRIPT_DIR/pi-sub-patches/manifest.txt"
sub_stale=""
if [ -f "$SUB_MANIFEST" ]; then
    while read -r src dest || [ -n "$src" ]; do
        [ -z "$src" ] && continue
        cmp -s "$SCRIPT_DIR/pi-sub-patches/$src" "$SUB_NM/$dest" || sub_stale+=" $dest"
    done < "$SUB_MANIFEST"
else
    sub_stale=" (pi-sub-patches/manifest.txt is missing)"
fi
if [ -z "$sub_stale" ]; then
    pass "pi-sub: grok provider patch (every manifest file matches pi-sub-patches/)"
else
    fail "pi-sub: grok provider patch missing or stale:$sub_stale" \
         "while read -r s d; do cp \"pi-setup/pi-sub-patches/\$s\" \"$SUB_NM/\$d\"; done < pi-setup/pi-sub-patches/manifest.txt"
fi

# ── pi-sub-core: stale-ctx guard ──
if node "$SCRIPT_DIR/pi-sub-patches/apply-sub-core-stale-guard.mjs" --check >/dev/null 2>&1; then
    pass "pi-sub-core: stale-ctx guard present"
else
    fail "pi-sub-core: stale-ctx guard missing (a fetch outliving /resume exits pi)" \
         "node pi-setup/pi-sub-patches/apply-sub-core-stale-guard.mjs"
fi

# ── shiki-diff: pi-diff render pipeline (edit/write syntax-highlighted diffs) ──
# Non-fatal at runtime (falls back to the plain box renderer), but a FAIL means
# the pretty diffs are silently off. Probed with plain node; pi loads under jiti.
TOOLS_DIR="$PI_AGENT/extensions/tools"
if [ ! -d "$TOOLS_DIR/node_modules/@heyhuynhgiabuu/pi-diff" ]; then
    fail "shiki-diff: @heyhuynhgiabuu/pi-diff not installed (edit/write diffs fall back to plain)" \
         "(cd \"$TOOLS_DIR\" && npm install --no-package-lock)"
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
             "update extensions/tools/lib/shiki-diff.ts to the new pi-diff export shape"
    fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PATCHES IN PLACE ✓"
else
    echo "SOME PATCHES MISSING — run pi-setup/install.sh or the per-item fixes above"
fi
exit $FAIL
