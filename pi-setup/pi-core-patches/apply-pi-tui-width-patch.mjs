#!/usr/bin/env node
/**
 * apply-pi-tui-width-patch.mjs — conservative grapheme widths for EVERY
 * installed copy of pi-tui.
 *
 * WHY: pi-tui's graphemeWidth() undercounts the real terminal cursor advance
 * for complex scripts (Devanagari matras/conjuncts etc). Components pad lines
 * to exactly terminal width with that measure, so one undercounted grapheme
 * hard-wraps the line, the terminal scrolls a row the TUI doesn't know about,
 * and the differential renderer smears the whole screen until SIGWINCH.
 * Full analysis: AGENTS.md "TUI Width Desync Fix".
 *
 * WHY A SCRIPT (not a stored file): pi-tui exists in MULTIPLE copies —
 * pi core's node_modules, ~/.pi/agent/npm/node_modules (used by ALL npm
 * packages: pi-tool-display, pi-sub-bar, condensed-milk, pi-ask, ...), and
 * inactive packages. Versions differ (0.74.x, 0.80.x). A textual, idempotent
 * patch survives version drift; whole-file copies don't.
 *
 * Usage: node apply-pi-tui-width-patch.mjs        # patch all copies
 *        node apply-pi-tui-width-patch.mjs --check # report only
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHECK_ONLY = process.argv.includes("--check");
const MARKER = "LOCAL PATCH";

const CLUSTER_ADVANCE_CODE = `
// LOCAL PATCH: per-codepoint cursor advance a terminal performs for a cluster.
// Zero-advance: nonspacing (Mn) + enclosing (Me) marks, format chars, default
// ignorables, controls. Spacing combining marks (Mc) deliberately COUNT 1:
// Ghostty gives Indic matras their own cell (हिंदी = 4 cols, measured via DSR
// 2026-07-04); tmux gives 0 — counting 1 is exact in Ghostty and a benign
// overcount in tmux. Invariant: may OVERCOUNT the terminal (benign — line
// pads a column short) but must NEVER UNDERCOUNT (fatal — hard-wrap desync).
const __zeroAdvanceRegex = /^[\\p{Mn}\\p{Me}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\p{Cc}]$/v;
const __extPictographicRegex = /^\\p{Extended_Pictographic}$/u;
function __clusterAdvance(segment) {
    let advance = 0;
    for (const char of segment) {
        const c = char.codePointAt(0);
        if (c === undefined)
            continue;
        // lone surrogates: terminals typically render a 1-col replacement
        if (c >= 0xd800 && c <= 0xdfff) {
            advance += 1;
            continue;
        }
        // hangul V/T conjoining jamo compose into the leading syllable
        if ((c >= 0x1160 && c <= 0x11ff) || (c >= 0xd7b0 && c <= 0xd7ff))
            continue;
        if (__zeroAdvanceRegex.test(char))
            continue;
        const w = eastAsianWidth(c);
        // text-presentation pictographs (e.g. 🖐 U+1F590, EAW=N): several
        // terminals render them 2 cells wide — count 2 to stay conservative
        advance += __extPictographicRegex.test(char) ? Math.max(w, 2) : w;
    }
    return advance;
}
`;

function findPiTuiCopies() {
    const roots = [
        "/opt/homebrew/lib/node_modules",
        path.join(os.homedir(), ".pi/agent"),
    ];
    const found = new Set();
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        let out = "";
        try {
            out = execSync(
                `find "${root}" -type f -path "*/pi-tui/dist/utils.js" -not -path "*/.git/*" 2>/dev/null`,
                { encoding: "utf8" },
            );
        } catch { /* find returns non-zero on permission errors — partial output is fine */ }
        for (const line of out.split("\n")) {
            if (line.trim()) found.add(path.resolve(line.trim()));
        }
    }
    return [...found].sort();
}

function patchFile(file) {
    let src = fs.readFileSync(file, "utf8");
    if (src.includes(MARKER)) return "already-patched";
    if (!src.includes("function graphemeWidth(segment)")) return "no-graphemeWidth";
    if (!src.includes("eastAsianWidth")) return "no-eastAsianWidth";

    // isolate the graphemeWidth function body (ends at first column-0 "}")
    const fnStart = src.indexOf("function graphemeWidth(segment)");
    const fnEnd = src.indexOf("\n}", fnStart);
    if (fnEnd === -1) return "no-fn-end";
    let fn = src.slice(fnStart, fnEnd + 2);

    // 1) all-marks early return → route through clusterAdvance (standalone
    //    spacing marks render 1 col in Ghostty)
    const zeroRet = /(if \(zeroWidthRegex\.test\(segment\)\) \{\n\s*)return 0;/;
    if (!zeroRet.test(fn)) return "no-zero-anchor";
    fn = fn.replace(zeroRet, "$1return __clusterAdvance(segment); // LOCAL PATCH: Mc marks advance 1 cell in Ghostty");

    // 2) final return → conservative max(heuristic, per-codepoint advance)
    const finalRet = /\n(\s*)return width;\n\}$/;
    if (!finalRet.test(fn)) return "no-final-anchor";
    fn = fn.replace(
        finalRet,
        "\n$1// LOCAL PATCH: conservative width — see __clusterAdvance below\n$1return Math.max(width, __clusterAdvance(segment));\n}",
    );

    src = src.slice(0, fnStart) + fn + CLUSTER_ADVANCE_CODE + src.slice(fnEnd + 2);
    fs.writeFileSync(file, src);
    return "patched";
}

const copies = findPiTuiCopies();
if (copies.length === 0) {
    console.error("ERROR: no pi-tui dist/utils.js found — did pi move?");
    process.exit(1);
}
let failures = 0;
for (const file of copies) {
    const version = (() => {
        try {
            return JSON.parse(fs.readFileSync(path.join(file, "../../package.json"), "utf8")).version;
        } catch { return "?"; }
    })();
    if (CHECK_ONLY) {
        const patched = fs.readFileSync(file, "utf8").includes(MARKER);
        console.log(`${patched ? "PATCHED " : "UNPATCHED"} v${version}  ${file}`);
        if (!patched) failures++;
        continue;
    }
    const result = patchFile(file);
    console.log(`${result.padEnd(16)} v${version}  ${file}`);
    if (result !== "patched" && result !== "already-patched") failures++;
}
if (failures > 0) {
    console.error(CHECK_ONLY
        ? `\n${failures} unpatched cop${failures === 1 ? "y" : "ies"} — run without --check`
        : `\n${failures} cop${failures === 1 ? "y" : "ies"} FAILED to patch — upstream utils.js changed; re-derive the patch (see AGENTS.md)`);
    process.exit(1);
}
