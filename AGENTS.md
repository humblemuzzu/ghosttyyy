# AGENTS.md — Pi Setup Reference

> This file is read by pi and other coding agents at session start.
> It describes the full setup so agents understand the architecture,
> know what not to touch, and can safely apply upstream updates.

## Architecture Overview

This repo serves two purposes:
1. **Ghostty terminal config** — themes, fonts, scripts (see README.md)
2. **Portable pi (coding agent) setup** — full backup of all extensions, tools, skills, themes, config, and an installer

The pi setup lives in `pi-setup/` and is deployed to `~/.pi/agent/` via `pi-setup/install.sh`.

### Migration Log

**See `pi-setup/2026-05-17-migration-log.md`** for the full record of the v0.74.0 migration, architecture decisions, CrofAI fixes, context management switch, and package cleanup. If anything breaks, check there first.

### bdsqqq Port — IN PROGRESS (read before changing tools/subagents)

**See `pi-setup/2026-07-30-bdsqqq-port.md`.** Ongoing port of selected pieces from
[bdsqqq/dots](https://github.com/bdsqqq/dots). Phases 0-3 are done (subagent tool
injection fixed, `web_search` replaced with Parallel AI, `agent_message` added,
`search_sessions` rebuilt on a branch model, condensed-milk removed). Phase 4
(`apply_patch` replacing `edit`/`write`, `delegate` replacing `Task`) is next.

That file records **why** several things are the way they are — in particular the
`pi-claude-code-use` OAuth tool filter that silently strips every custom tool from
sub-agent requests, and why `--no-tools` must never be used. Do not re-derive it.
Verification harnesses live in `pi-setup/port-harness/`.

### Provider Chain

```
pi CLI (v0.83.0) — @earendil-works/pi-coding-agent
  ├─ kimi-code provider (custom local config) + Kimi Code OAuth token helper
  │    └─ https://api.kimi.com/coding/v1 — Kimi Code subscription access
  └─ anthropic provider (native) + pi-claude-code-use (API payload shim for Claude Max OAuth use)
       └─ Claude API
```

Current default provider is `anthropic` with **`claude-opus-5`** (set in settings.json, and listed in `enabledModels` so it appears in `/model`). `kimi-code`/`kimi-for-coding` (K2.7 Code) remains available via Kimi Code subscription OAuth, and `openai-codex` with `gpt-5.5`/`gpt-5.6-sol` is also available. Switch the default any time with `/model`.

**When you change the default provider, also update `pi-sub-core-settings.json`:**
its `defaultProvider` is what `get_current_usage` reports on, and a provider
left at `enabled: false` there returns `{}` no matter what. Anthropic is now
`enabled: "auto"` + `fetchStatus: true`, which surfaces real Claude Max quota
(5-hour and weekly windows) in the status bar and in both usage tools.

**Legacy fallback:** `pi-claude-bridge` (installed but not active in packages) wraps the Claude Code Agent SDK as a custom provider.

### System Prompt Assembly

The system prompt is assembled in layers:

1. **`system-prompt.ts`** — loads `agents/prompt.amp.system.md` template, interpolates variables (`{identity}`, `{harness}`, `{date}`, `{cwd}`, `{roots}`, `{os}`, `{repo}`, `{sessionId}`, `{ls}`, `{harness_docs_section}`)
2. **`tool-harness.ts`** — env-gated tool filtering based on active workspace
3. **`brain-loader.ts`** — (disabled) injects `~/Documents/brain/MEMORY.md`, `USER.md`, project memory, and update protocol

---

## pi-claude-bridge: Custom Build (inactive)

**Upstream:** https://github.com/elidickinson/pi-claude-bridge (v0.4.0)
**Our patched version:** `pi-setup/claude-bridge-patches/index.ts`
**Status:** Installed globally but removed from settings.json packages. Legacy fallback.

### Patch Summary

Two `systemPrompt` modifications — remove `preset: "claude_code"` so Claude Code doesn't load its own system prompt. Search for `preset: "claude_code"` in upstream and replace with our versions:

```typescript
// Main provider: systemPrompt: systemPromptAppend || ""
// AskClaude tool: systemPrompt: skillsBlock || undefined
```

### Re-apply after npm update

```bash
cp pi-setup/claude-bridge-patches/index.ts /opt/homebrew/lib/node_modules/pi-claude-bridge/src/index.ts
```

---

## condensed-milk-pi: REMOVED (2026-07-30)

**Status:** uninstalled entirely. Do not reinstall. `pi-setup/condensed-milk-patches/` deleted.

It compressed bash output and masked stale tool results, but it cost more than it saved:

1. **It silently reported failures as successes.** Its `git-mutations.ts` filter summarises by
   *shape*, not content — `filterGitAdd()` returns `ok (N files staged)` for ANY input. Compression
   ran before `isError` was consulted, so a `git add -A` **rejected by our permission rules** was
   handed to the model as `ok (1 files staged)`. Same data-loss class as the `$`-prefix bug it
   already needed a patch for.
2. **Its context masking hampered debugging.** Defaults masked 60% of prior tool results at only
   **30% context use**, so earlier command output became `[cm-masked bash] …` placeholders and had
   to be re-run.
3. **Maintenance cost.** It required three separate local patches (`$`-prefix strip, `cmd` param
   support, and the `isError` guard), all of which had to be re-applied to *every* installed copy
   after each npm update.

pi's native compaction (`compaction.enabled: true` in settings.json) covers context management.

**If a copy ever reappears** (stale global install, or someone re-adds it to `packages`),
`verify-patches.sh` fails loudly — it now asserts the package is *absent*.

## pi-tool-display: Configuration Required

**Upstream:** https://github.com/MasuRii/pi-tool-display (v0.4.1)
**Config file:** `~/.pi/agent/extensions/pi-tool-display/config.json`
**Backed up:** `pi-setup/extensions/pi-tool-display/config.json`

### Why Config Is Required

pi-tool-display registers tool overrides for `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`. These **conflict** with our custom tool implementations in `extensions/tools/`. pi-tool-display's overrides bootstrap from pi's DEFAULT tools (not ours), so they would **replace** our mutex locking, secret scrubbing, git trailers, image support, etc.

**ALL tool overrides must be set to `false`.** This gives us only:
- ✅ Thinking labels (streaming "Thinking:" prefix)
- ✅ Native user message box with markdown rendering
- ✅ `/tool-display` settings command
- ❌ No tool rendering overrides (our custom tools handle their own rendering)

### Config Contents

```json
{
  "registerToolOverrides": {
    "read": false, "grep": false, "find": false,
    "ls": false, "bash": false, "edit": false, "write": false
  },
  "enableNativeUserMessageBox": true
}
```

### After npm Update

The config file is NOT in the npm package — it's in `~/.pi/agent/extensions/pi-tool-display/config.json`. npm updates don't touch it. But if you delete and reinstall, recreate the config:

```bash
mkdir -p ~/.pi/agent/extensions/pi-tool-display
cp pi-setup/extensions/pi-tool-display/config.json ~/.pi/agent/extensions/pi-tool-display/config.json
```

**If you see tool conflict errors on startup**, the config is missing or all overrides are `true`. Fix by recreating the config file.

---

## pi-vcc: Removed

**Previously:** `@sting8k/pi-vcc` (v0.3.12) — algorithmic compaction engine.
**Status:** Uninstalled. Using pi's native LLM-based compaction instead.

**Note:** the old `handoff.ts` extension had a `session_before_compact` hook that returned `{ cancel: true }` for all compaction except VCC, which blocked pi's native compaction entirely. It was first moved to `extensions-disabled/` and has since been **deleted** (2026-07-23 cleanup). Reminder: pi auto-discovers every `.ts` file in `extensions/`, so removing an extension from `settings.json` is NOT enough — the file must be deleted or moved out of `extensions/`.

---

## Pi Core: Extension Tool Conflict Suppression Patch

**File:** `dist/core/resource-loader.js` in `@earendil-works/pi-coding-agent`
**Patch stored:** `pi-setup/pi-core-patches/resource-loader.js`

### The Problem

When a user extension registers a tool with the same name as a package tool (e.g., our `web_search` vs pi-web-access's `web_search`), pi's `detectExtensionConflicts()` pushes the conflict to the errors array. Pi treats these as fatal startup errors, blocking launch — even though the code comment says "Keep all extensions loaded. Conflicts are reported as diagnostics."

User extensions load BEFORE packages, so `getAllRegisteredTools()` (first-wins) already gives user extensions precedence. The conflict diagnostic is the only problem.

### The Fix

Suppressed the conflict-to-error push. `detectExtensionConflicts()` still runs (for internal bookkeeping) but no longer pushes to `extensionsResult.errors`:

```javascript
// Before:
const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
for (const conflict of conflicts) {
    extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
}
// After:
this.detectExtensionConflicts(extensionsResult.extensions);
```

### Re-apply after pi update

Auto-applied by `pi-setup/install.sh` (pi core patches block). To apply manually:

```bash
cp pi-setup/pi-core-patches/resource-loader.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js
```

---

## Pi Core: Session Pinning Patch

**Files:**
- `dist/modes/interactive/components/session-selector.js`
- `dist/core/keybindings.js`

**Patches stored:** `pi-setup/pi-core-patches/session-selector.js`, `pi-setup/pi-core-patches/keybindings.js`

### What It Does

Adds the ability to **pin sessions to the top** of the `/resume` picker. Pins persist across pi updates' data (stored separately from the patched code) in `~/.pi/agent/pinned-sessions.json` — a JSON array of canonical session file paths.

- **`Ctrl+B`** in the `/resume` picker toggles pin/unpin on the selected session
- Pinned sessions float to the **top** of the list (in every sort mode and scope), flattened to depth 0, marked with a 📌 prefix
- A `pin` hint appears in the picker's hint line
- Pinning is non-destructive and global: the pin file references session paths, so a pinned session from another project shows in "All" scope

The native **rename** (`Ctrl+R`) was already built into pi — this patch only adds pinning.

### How It Works

**`keybindings.js`** — registered `app.session.pin` (default `ctrl+b`) in the `KEYBINDINGS` defaults map and added a `pinSession` alias. `ctrl+b` was chosen because `ctrl+g` (external editor), `ctrl+t` (thinking toggle), `ctrl+r/d/n/p/s` (session actions) are all taken.

**`session-selector.js`** — all additions are marked with `// LOCAL PATCH` comments:
1. **Imports** — added `mkdirSync/readFileSync/writeFileSync`, `dirname/join`, and `getAgentDir` from `../../../config.js`
2. **Pin-file helpers** (module-level) — `getPinFilePath()`, `readPinnedPaths()`, `writePinnedPaths()`, `isPinnedPath()`, `togglePinnedPath()`, and `applyPinning()` (reorders the flattened display list so pinned entries come first at depth 0)
3. **`SessionList.pinnedSet`** field + **`filterSessions()`** re-reads pins and calls `applyPinning()` after the normal sort
4. **Render loop** — pinned nodes render a `📌 ` prefix instead of the tree prefix
5. **`handleInput()`** — `app.session.pin` match toggles the pin, re-filters, and re-renders
6. **`SessionSelectorComponent`** — wires `onTogglePin` to `requestRender()`; header hint adds `pin`

### Re-apply after pi update

**`install.sh` now auto-applies all pi-core patches** (resource-loader + session-selector + keybindings) in its "pi core patches" block. Re-running `pi-setup/install.sh` after a pi update restores them. To apply manually without the full installer:

```bash
cp pi-setup/pi-core-patches/session-selector.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js
cp pi-setup/pi-core-patches/keybindings.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js
```

**Note:** The pin data file (`~/.pi/agent/pinned-sessions.json`) is user data, not code — npm updates never touch it. Only the two `.js` files above get overwritten on update and need re-applying.

**If the upstream selector changed significantly**, re-derive the patch by re-applying the `// LOCAL PATCH` blocks onto the fresh `session-selector.js` rather than blindly overwriting (the surrounding code may have shifted).

---

## TUI Width Desync Fix (pi-tui core patch + box-format normalizeForDisplay)

**Files:** `pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs` (THE root fix — patches EVERY installed pi-tui copy), `extensions/tools/lib/box-format.ts` (tool-output guard), `extensions/tools/bash.ts`, `extensions/tools/lib/sub-agent-render.ts`, `read-web-page.ts`, `code-review.ts`, `read-session.ts`
**Harness:** `pi-setup/render-repro/` (tmux + Ghostty repro, DSR cursor verification, regression tests)

### The Bug (fixed 2026-07-04, after multiple prior attempts)

Heavy tool output containing certain Unicode smeared the whole TUI — stale
duplicate tool boxes, content leaking below the editor, scattered spinner
frames. Only a terminal resize (SIGWINCH full redraw) recovered. Prior
attempts (commits `3b91aef`, `d7ca016`, `d5ae498`) fixed ANSI escape
leakage and render churn but the smear kept coming back on heavy streams.

**Root cause:** pi-tui measures text in grapheme clusters; real terminals
advance the cursor per spacing codepoint for complex scripts. Example: the
Devanagari conjunct `क्त्र` is ONE cluster — pi-tui width 1, Ghostty/tmux
render 3 columns. pi-tui's `Box.applyBg` pads every tool line to *exactly*
terminal width using its own measure, so one undercounted cluster makes the
line wider than the terminal → hard-wrap → the terminal scrolls a row
pi-tui doesn't know about → every subsequent differential write lands on
the wrong row. Heavy streaming = hundreds of full-width lines = one exotic
grapheme is enough. Reproduced and bisected empirically in tmux
(`pi-setup/render-repro/`).

Disagreeing classes found: Indic conjuncts (virama-joined), text-presentation
pictographs (EP without Emoji_Presentation, e.g. 🖐 ☹ — terminals disagree
with *each other*), skin-tone modifiers after non-modifier-base chars, and
codepoints unassigned in Node's ICU tables.

### The Fix — two layers

**Layer 1 (THE root fix): pi-tui width patch on ALL copies** —
`pi-core-patches/apply-pi-tui-width-patch.mjs`, an idempotent textual patcher.

Three rounds to get here:
- Round 1 guarded our tool renderers only → smear returned via pi core's OWN
  components (assistant `Markdown`, editor, footer) — proven with a DSR
  cursor-verified harness in a real Ghostty window.
- Round 2 patched pi core's pi-tui copy → smear STILL returned because
  **pi-tui exists in 15 copies**: every globally-installed package bundles its
  own (`pi-tool-display` — user-message box + thinking labels, `pi-sub-bar` —
  footer widget, `pi-token-burden`, `pi-claude-code-use`, …, plus
  `~/.pi/agent/npm/node_modules/@earendil-works/pi-tui` used by npm packages).
  Components from an unpatched copy render into the same screen with the old
  width math — one bad line anywhere smears everything.
- Round 3: the apply script `find`s every `*/pi-tui/dist/utils.js` under
  `/opt/homebrew/lib/node_modules` and `~/.pi/agent`, and applies the patch
  textually (anchor-based, version-tolerant 0.55→0.80, loud failure if
  upstream changed, `--check` mode to audit).

The patch makes `graphemeWidth()` **conservative — it can overcount but never
undercount** the real terminal's cursor advance. Undercounts hard-wrap and
desync; overcounts just pad a column short (invisible). Changes (all marked
`// LOCAL PATCH`):
1. `clusterAdvance(segment)` — per-codepoint advance sum: Mn/Me/Cf/ignorable/
   control → 0, **Mc (spacing marks, Indic matras) → 1** (Ghostty gives them a
   cell: हिंदी = 4 cols, DSR-measured; tmux gives 0 — counting 1 is exact in
   Ghostty, benign overcount in tmux), hangul V/T jamo → 0, lone surrogates → 1,
   text-presentation pictographs (🖐 ⚠ ☹) → max(EAW, 2).
2. `graphemeWidth` returns `max(original heuristic, clusterAdvance(segment))`;
   the all-marks early return routes through `clusterAdvance` too (standalone
   matras render 1 col). RGI emoji / flags keep their early-return 2
   (terminals render those 2 consistently — measured).

**Layer 1b (separate mechanism — control chars in single-line sinks):**
the custom editor's border labels and status widget row are ONE terminal line
each. `describeToolCall` in `extensions/editor/index.ts` used
`hint.split("/").pop()` on bash `cmd` — for a multiline script that returned
an UNBOUNDED tail including `\n`s, embedded into the border/status line. A
`\n` is width-0 to every width check but moves the real cursor a row → same
smear, different mechanism (this is why the smear survived the width fixes:
any heredoc/`python3 -c` script with a "/" in its tail triggered it —
`crazy-math.py` did, `python3 /tmp/tui-torture.py` didn't because its tail
was a short basename). Fixed at three layers: `describeToolCall` (first line
+ basename-only-for-paths + 24-char cap), `LabeledEditor.setLabel` sink guard
(`flattenLabelText` — collapses `\r\n\t\v\f` + C0/DEL, preserves ANSI), and
`widget-row.ts` `joinGroup` sink guard (`flattenSegmentText`).

**Layer 2 (defense in depth): `normalizeForDisplay()` in `box-format.ts`** —
display-only, at the render chokepoint of all box-rendering tools: strips stray
control chars, expands tabs, and replaces any grapheme cluster whose pi-tui
width disagrees with the modeled terminal advance with `�`. It derives from
pi-tui's live (patched) tables via the `visibleWidth` import, so with Layer 1
applied it replaces almost nothing — it exists to catch classes Layer 1 might
miss after a pi update. Model-visible tool result text is NEVER modified.
Applied at: `expandBlock`, headers, notices, `renderCallLine`, bash
`renderCall`, sub-agent tree renders, and raw fallback paths of
read-web-page/code-review/read-session.

Also fixed in the same pass: `bash.ts` uses per-stream `StringDecoder`s so
UTF-8 multibyte chars split across stdout/stderr chunk boundaries no longer
corrupt into `U+FFFD` in the model-visible output.

### Verified (2026-07-04)

- DSR cursor-drift harness (`harness2.mjs`), 150 frames/phase: **0 desyncs**
  in Ghostty AND tmux across ASCII-heavy, markdown-code, markdown+unicode,
  and combined phases (before the pi-tui patch: markdown+unicode desynced in
  BOTH terminals).
- Ghostty per-token DSR width measurement (`dsr-widths.mjs`): **0 undercounts**
  remaining (5 benign overcounts: क्त्र 3v2, 🖐⚠☹ 2v1, বাংলা 5v4).
- tmux visual capture phases: all MATCH; fuzz: 0 fatal undercounts / 3386
  clusters; 46/46 bun tests; pi boots clean.

### After ANY pi/package update (IMPORTANT)

`pi update --self`, npm package updates, and `pi install` ALL restore stock
pi-tui copies (each package bundles one). Re-apply via `install.sh` or:

```bash
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs          # patch all copies
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs --check  # audit
```

The script is idempotent and anchor-based; if upstream `graphemeWidth`
changed shape it reports `no-*-anchor` and exits non-zero — then update the
anchors in the script and re-run the harness suite.

### If the smear ever returns

1. Re-run `pi-setup/render-repro/` (see its README): DSR phases in Ghostty +
   tmux must show 0 desyncs, visual phases MATCH, `find-bad-clusters.mjs`
   must report `bad: 0` (fatal undercounts only).
2. First suspect: an update restored a stock pi-tui copy — run
   `node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs --check`
   (a NEWLY INSTALLED package brings a fresh unpatched copy too).
3. Measure the actual terminal with `dsr-widths.mjs` inside Ghostty — if a new
   char class undercounts, extend `clusterAdvance` (and keep it conservative:
   when in doubt, count MORE, never less).
4. If widths are all clean, suspect the OTHER mechanism: a component embedding
   `\n`/control chars into a single-line string (border label, widget row,
   truncated summary). `\n` is width-0 to every check but moves the real
   cursor. Grep the offending fragment from the smear screenshot to find the
   source component; flatten at its sink like `flattenLabelText`.

---

## Subagent Model Resolution (pi-spawn.ts patch)

**File:** `extensions/tools/lib/pi-spawn.ts`

### The Problem

The original code always used the parent model for subagents:
```typescript
const resolvedModel = config.parentModel ?? config.model;
```
This meant finder/oracle/librarian/code-review always inherited the parent model (e.g., `zai/glm-5.1`) instead of their designated Claude models.

### The Fix

Conditional resolution based on parent provider:
- **Parent is Anthropic** (provider `anthropic` or `claude-bridge`, or model name contains `claude`) → use designated model (`claude-haiku-4-5`, `claude-sonnet-4-6`)
- **Parent is non-Anthropic** (ZAI, local-llama, etc.) → inherit parent model (can't use Claude without separate API access)

This means subagents use cheap Claude models when you're on Claude, but don't break when you're on ZAI/local.

---

## Clipboard Image Paste Placeholder (editor.ts feature)

**File:** `extensions/editor/index.ts`

### The Problem

pi core's `handleClipboardImagePaste()` (in `interactive-mode.js`) writes the pasted clipboard image to a temp file and inserts the **raw path** (`/var/folders/.../pi-clipboard-<uuid>.png`) into the editor as literal text. That long path is what you stare at while composing, and the model only gets it as text (it has to `read` the path to see the image).

### The Fix (opencode-style placeholder, zero core patches)

Our `LabeledEditor` now sets its own `onPasteImage`. Core's editor-swap only wires the default handler when ours is unset (`if (!customEditor.onPasteImage)`), so ours wins with no core changes. On paste:

1. Read the clipboard image's **raw bytes** via `@mariozechner/clipboard`'s `getImageBinary()` and base64-encode them with `Buffer.toString("base64")`. **Do not use `getImageBase64()`** — it omits the trailing `=` padding, so any image whose byte length isn't a multiple of 3 yields unpadded base64 that Anthropic rejects with `invalid base64 data` (400). The `Buffer` path matches pi core's own read-tool image handling and is always correctly padded.
2. Insert a short token `[image #N]` into the editor (N increments per paste; resets after each submit).
3. Register the base64 in a module-level `pastedImages` map keyed by the token.

A `pi.on("input", …)` hook then expands tokens at submit: for each `[image #N]` found in the text it pushes an inline `{ type: "image", data, mimeType }` content block (returned via `{ action: "transform", text, images }`), so vision models receive the image **directly** — no temp file, no `read` round-trip. The token text stays in the message for a readable transcript. Multiple pastes stack as `[image #1] [image #2] …`.

### Clipboard module resolution

`@mariozechner/clipboard` is **not** a jiti-aliased package (jiti only aliases `@mariozechner/pi-*`), and the `~/.pi/agent/node_modules/@mariozechner/*` symlinks are stale. `loadClipboard()` resolves it with `require.resolve(..., { paths })` anchored at the **running pi binary's** `node_modules` (clipboard is pi's own dep, always present), then `extensions/tools/node_modules` and known global npm roots. If resolution fails, `onPasteImage` is left unset and pi's default path-insert behavior transparently takes over — **no regression**.

### After pi update

Nothing to re-apply — this is an extension, deployed by `install.sh` (`cp -R extensions`). Survives pi npm updates. The only dependency is `@mariozechner/clipboard`, which ships inside pi's own `node_modules` and is also installed under `extensions/tools` by `install.sh`'s `npm install`.

---

## Agent Mention Directives (@oracle, @finder, @codereview, @task)

**Files:** `extensions/tools/lib/mentions/agent-source.ts` (new), plus modifications to `types.ts`, `sources.ts`, `parse.ts`, `render.ts`, `provider.ts`, `index.ts`, and `extensions/mentions.ts`.

### What It Does

Extends pi's existing @mention system to support agent tool routing. When the user types `@oracle review this auth flow`, a hidden directive is injected into the context telling the model to call the `oracle` tool — not Task, not do it itself.

### How It Works

1. **Parse** — standalone regex `(?<![\w/])@(oracle|finder|codereview|task)(?=[\s.,;:!?)\]}]|$)` matches `@oracle` without requiring `/value` (unlike `@commit/sha`)
2. **Resolve** — `agent-source.ts` maps each kind to its tool name (e.g. `codereview` → `code_review`, `task` → `Task`)
3. **Render** — produces `AGENT DIRECTIVE: Call the \`oracle\` tool for this request. The user explicitly tagged @oracle. Do not substitute another tool.`
4. **Inject** — `mentions.ts` injects the directive as a hidden `display: false` custom message in the `context` hook

### Agent ↔ Tool Mapping

| Mention | Tool | Description |
|---------|------|-------------|
| `@oracle` | `oracle` | Expert advisor — architecture, planning, hard bugs |
| `@finder` | `finder` | Codebase search by concept or behavior |
| `@codereview` | `code_review` | Code review with diff analysis |
| `@task` | `Task` | Full subagent for independent parallel work |

### Autocomplete

Agent kinds appear in autocomplete when typing `@`. They complete with a trailing space (`@oracle `) instead of a trailing slash (`@commit/`). This is controlled by the `standalone: true` flag on `MentionSource`.

### Key Design Decisions

- **Standalone flag** — `MentionSource.standalone?: boolean` differentiates valueless mentions from data mentions. The parser builds two separate regexes (data with `/value`, standalone without).
- **Side-effect import** — `agent-source.ts` has no named exports; it registers sources at module load. `mentions.ts` uses an explicit `import "./tools/lib/mentions/agent-source.js"` to guarantee evaluation.
- **No text stripping** — the `@oracle` stays in the user's message text. The directive reinforces it; the model sees both.
- **Structural discrimination in render** — `"agent" in mention` distinguishes agent results from commit/session results without importing a kind list.

### What NOT to Do

- **Don't remove the side-effect import in `mentions.ts`** — the barrel `export *` in `index.ts` doesn't guarantee evaluation of modules with no named exports. The explicit import is required.
- **Don't add a `/value` to agent mentions** — they're standalone. `@oracle/foo` won't parse and won't trigger a directive.

---

## pi-mcp-adapter: On-Demand MCP Gateway

**Upstream:** https://github.com/nicobailon/pi-mcp-adapter (v2.10.0, MIT)
**Status:** Active in `settings.json` packages. **No patches.** Installed via `pi install npm:pi-mcp-adapter` → `~/.pi/agent/npm/node_modules/pi-mcp-adapter`.

### Why It Was Chosen (and why it's safe)

Built on Mario Zechner's "you don't need MCP" philosophy — MCP tool definitions are verbose (10k+ tokens per server) and you pay that whether you use them or not. This adapter exposes **one proxy tool** (`mcp`, ~200 tokens) instead of dumping every server's tools into context. The model discovers tools on demand via `mcp({ search })` → `mcp({ tool, args })`. Servers are **lazy** — no process spawns until a tool is actually called.

**It does NOT conflict with our setup:**
- Registers exactly **one tool named `mcp`** + commands `/mcp`, `/mcp-auth` + flag `--mcp-config`. No name collision with any of our 25 custom tools or commands.
- **Does NOT override pi built-ins** (`read`/`bash`/`edit`/etc.) — unlike pi-tool-display. Purely additive, so it cannot clobber our custom tools' mutex locking / secret scrubbing / git trailers.
- Uses only the public `ExtensionAPI` (`registerTool`/`registerCommand`/`registerFlag`/`on`). **No core patching.**
- Compatible with our pi 0.80.10 (devDep `pi-coding-agent ^0.79.1`, runtime `pi-ai`/`pi-tui ^0.74.0`).

### Behavior: "invoke MCP only when wanted"

- **With no config file present, it's inert** — just the proxy tool in the list, no servers, no overhead.
- The model only calls `mcp` when relevant; servers connect on first tool call; `directTools` (promoting MCP tools to first-class entries) is strictly opt-in.
- Set `disableProxyTool: true` to hide even the proxy once direct tools are cached.

### Config Files (precedence)

1. `~/.config/mcp/mcp.json` (user-global shared)
2. `<agent dir>/mcp.json` (`~/.pi/agent/mcp.json` — Pi global override)
3. `.mcp.json` (project-local shared)
4. `.pi/mcp.json` (Pi project override)

### Configured Servers

**Global (pi-only, all folders):** `~/.pi/agent/mcp.json` → backed up as `pi-setup/mcp.json`, deployed by `install.sh`.

| Server | Transport | Config | Notes |
|--------|-----------|--------|-------|
| `astro` | HTTP (`url`) | `http://127.0.0.1:8089/mcp`, `auth: false` | [Astro](https://tryastro.app/docs/mcp/) ASO tool. **Local HTTP server that runs inside the Astro Mac app** — must be enabled in Astro → Settings → MCP Server (default port 8089). `auth: false` because Astro is localhost-only with no token; this stops the adapter from probing OAuth. Lazy (default): pi only connects when an `astro` tool is actually called, so the Astro app must be open + MCP enabled at call time. 60 req/min limit. Tools: `list_apps`, `search_rankings`, `get_app_keywords`, `get_app_ratings`, `extract_competitors_keywords`, `add_app`, `add_keywords`, `set_keyword_note`, `set_keyword_tag`, `manage_tag`, `search_app_store`, `get_keyword_suggestions`. |
| `paper` | HTTP (`url`) | `http://127.0.0.1:29979/mcp`, `auth: false` | [Paper](https://paper.design/docs/mcp) design tool. **Local HTTP server that runs inside the Paper Desktop app** (macOS/Windows) — auto-starts in the background when you open a file in the app (fixed port 29979). `auth: false` because Paper is localhost-only with no token; this stops the adapter from probing OAuth. Lazy (default): pi only connects when a `paper` tool is actually called, so the Paper app must be open with a file loaded at call time. **Read+write** — the agent can create/modify shapes and content in the *currently open* design file (unlike read-only astro/Figma), so grant write permissions deliberately. Context = the currently open Paper file. Useful for design→code, syncing design tokens (e.g. from Figma), or pulling real content (e.g. from Notion) into designs. Inert (no error, adapter is lazy) if the Paper app isn't installed/running. |

To add more servers: edit `~/.pi/agent/mcp.json` (global) or a project `.mcp.json`. stdio servers use `command`/`args`; HTTP servers use `url` (+ optional `headers`/`auth`).

```json
{ "mcpServers": {
  "astro": { "url": "http://127.0.0.1:8089/mcp", "auth": false },
  "paper": { "url": "http://127.0.0.1:29979/mcp", "auth": false }
} }
```

### After pi/package update

No patches to re-apply. `pi update --extensions` may bump it — safe (unpatched). Backed up as the `npm:pi-mcp-adapter` entry in `pi-setup/settings.json` (package) + `pi-setup/mcp.json` (server config); `install.sh` re-adds both on deploy.

---

## Packages (npm)

| Package | Version | Purpose | Patched? |
|---------|---------|---------|----------|
| `@earendil-works/pi-coding-agent` | 0.83.0 | The pi agent itself (installed via homebrew npm) | No |
| `@benvargas/pi-claude-code-use` | 1.0.5 | API payload shim for Claude Max OAuth use (system prompt + tool-name compatibility) (primary Claude method) | No |
| `pi-context` | 2.1.2 | Context management: context_log, context_tag, context_checkout | No |
| `pi-token-burden` | 0.6.5 | Token usage tracking and display | No |
| `@marckrenn/pi-sub-bar` | 1.5.0 | Usage widget — shows provider quotas in status bar | No (**config**: see below) |
| `pi-autoresearch` | 1.6.2 | Autonomous experiment loop for optimization targets (GitHub install) | No |
| `pi-tool-display` | 0.5.0 | Compact tool rendering, thinking labels, user message box | **Config** |
| `pi-codex-goal` | 0.1.39 | Codex-style `/goal` — autonomous multi-turn objectives with completion audit | No |
| `pi-mcp-adapter` | 2.15.0 | On-demand MCP gateway — single `mcp` proxy tool (~200 tokens), lazy server connect, opt-in `directTools` | No |

**Active in settings.json (8):** `pi-context`, `pi-token-burden`, `@benvargas/pi-claude-code-use`, `@marckrenn/pi-sub-bar`, `pi-autoresearch`, `pi-tool-display`, `pi-codex-goal`, `pi-mcp-adapter`

**Removed 2026-07-30 (bdsqqq port, Phase 1):** `pi-web-access` and `pi-tasks` — uninstalled (`pi remove`) and dropped from packages, no backward compatibility kept.
- `pi-web-access` provided `web_search`, `source_check`, `fetch_content`, `get_search_content`. All four were **removed deliberately**: `web_search` was 100% dead (OpenAI rejected the model for ChatGPT-account Codex auth, Exa hit its free rate limit, Perplexity key invalid) and `source_check` silently degraded to `missing-evidence` because it consumes `web_search`. Replaced in Phase 3 by a self-contained Parallel AI `web_search` tool (ported from bdsqqq). Page reading is covered by our own `read_web_page` tool.
- `pi-tasks` provided 12 `task_*` tools + `/tasks` + a status widget. Removed because **array parameters were unusable**: its TypeBox schema is correct (`Type.Array`, `dist/src/tools.js:63`) but arrays arrived JSON-stringified and were rejected, so `task_plan` always failed and every tool gated behind it was unreachable.

**Removed 2026-07-23 cleanup:** `pi-gpt-config` (+ its patch), `pi-ask`, `pi-grok-cli` — uninstalled and dropped from packages. Custom Codex `web_search` tool removed (pi-web-access's native `web_search` restored).

**Kimi Code usage:** `/model kimi-code/kimi-for-coding:high`. Uses `~/.kimi-code/credentials/kimi-code.json` and `pi-setup/extensions/kimi-code-token.mjs` to refresh Kimi Code subscription OAuth tokens.

**Claude Max usage:** `/login anthropic` → `/model anthropic/claude-opus-4-8`. pi-claude-code-use intercepts provider API requests (after OAuth) and rewrites payloads for Claude Code-style subscription use. No custom provider needed — uses pi's native anthropic provider.

**Installed but inactive:** `pi-claude-bridge` (0.4.0, legacy fallback, patched), `lsp-pi`, `pi-powerline-footer`, `pi-anycopy`

**Removed 2026-07-23:** `pi-computer-use` — uninstalled entirely (git clone + `helpers/` copy). It was installed-but-inactive, so its `computer-use` skill loaded but its GUI tools (`screenshot`/`click`/`type_text`) never registered — a dead skill. Removed to stop it surfacing in the skill list.

### pi 0.83.0 migration (2026-07-30) — live update off 0.82.1 + pi-context 2.1.2 + pi-codex-goal 0.1.39

Updated `pi update` → **0.83.0** and the two flagged packages (`pi-context` 2.1.1→2.1.2, `pi-codex-goal` 0.1.38→0.1.39). **Audited against the real tarballs before updating** (`npm pack` + diff, no install). pi 0.83.0 is mostly additive but carries **one Breaking Change** (TypeBox 1.3.7); our source is clean of it. One patched core file (`resource-loader.js`) had real upstream drift and was **re-derived, not blind-copied**.

- **0.83.0 Breaking Change — TypeBox → 1.3.7:** removes `Type.Base/Awaited/Promise/AsyncIterator/Iterator/Options` and `Value.Mutate`, and fixes compiled validation of nullable array tool args (#7243). **Verified our 24 tools + all extensions are CLEAN** — grep of our `.ts` source for those APIs returned zero (the only matches were inside vendored `node_modules/@sinclair/typebox` internals/readme). No migration needed.
- **0.83.0 additive:** `pi auth print-api-key`/`print-bearer-token` credential export with OAuth refresh (#7168), headless OpenRouter login via pasted redirect URL/code, Claude Opus 5 on GitHub Copilot, `ctx.scopedModels` exposed to extensions (#7191), per-request `fetch` injection, `"pending"` stop reason, raw provider stop reasons surfacing unmapped terminal reasons as errors (#7272). OAuth now refreshes tokens with <5 min validity remaining (#7168).
- **pi-core patches — precise per-file handling (verified stock 0.82.1 vs stock 0.83.0):**
  - `resource-loader.js` — **RE-DERIVED**, not blind-copied. 0.83.0 added a new `findShadowedContextFile()` worktree-shadowing function (~lines 52-80, imports `basename` + `findGitPaths` from `footer-data-provider.js`) — **outside** our patch region. Our conflict-suppression edit is at the `addExtensionConflictDiagnostics` method (~line 458, `for (const conflict of conflicts) errors.push()` loop, anchor still present). Copied fresh stock 0.83.0 live → repo as new canonical, applied our suppression edit onto it (removed the loop, kept `findShadowedContextFile`), deployed repo → live. Verified live: `findShadowedContextFile` ×2 (feature preserved), conflict-push loop ×0, `LOCAL PATCH` marker ×1, node parse OK. Blind-copying the 0.82.1 repo patch would have **reverted the worktree-shadowing feature**.
  - `keybindings.js` + `session-selector.js` — **0 upstream drift** 0.82.1→0.83.0 (stock byte-identical, `diff` confirmed). Repo patches deployed as-is; verified live `app.session.pin` ×2, session-selector 7 `LOCAL PATCH`.
  - pi-tui width patch — `pi update` brought a fresh **v0.83.0** pi-tui copy (into pi's own `node_modules`); `apply-pi-tui-width-patch.mjs` patched it cleanly (anchors unchanged), all other copies already-patched, exit 0.
- **Packages (targeted `pi update npm:<pkg>`):**
  - **pi-context 2.1.1 → 2.1.2** — single refinement in `src/index.ts`: adds `didConversationAdvance()` so passive session entries (`custom`/`label`/`session_info`/`model_change`/`thinking_level_change`) no longer cancel a requested compaction (only real conversation advance does) + a `test` npm script. No tool/command rename, no API surface change.
  - **pi-codex-goal 0.1.38 → 0.1.39** — pauses an active goal when a hidden continuation run only calls `get_goal`/`*__get_goal` with no actionable progress (stops blocked status-inspection loops, surfaces `/goal resume`) + a token-budget doc note (#47). Goal-runtime internals only; `get_goal`/`create_goal`/`update_goal` unchanged.
- **Smoke-tested:** `pi --version` = 0.83.0; `verify-patches.sh` ALL PASS (8/8); `apply-pi-tui-width-patch.mjs --check` exit 0; clean `pi -p` boot with real Claude reply (`UPDATE_OK`), zero load/tool/provider/conflict errors. Rollback backup: `~/pi-update-backup-20260730_235801` (auth.json + patched 0.82.1 dist files + VERSION).

### pi 0.82.1 migration (2026-07-27) — live update off 0.82.0 + pi-web-access 0.14.0 + pi-mcp-adapter 2.15.0

Updated `pi update` → **0.82.1** and the two flagged packages. **Audited against the real 0.82.1/0.14.0/2.15.0 tarballs before updating** (`npm pack`, no install). pi itself is **purely additive** (no `Breaking Changes`/`Removed` section); one patched core file (`resource-loader.js`) had real upstream drift and was **re-derived, not blind-copied**.

- **0.82.1 upstream changes are additive:** **Claude Opus 5** on Anthropic + Bedrock (adaptive thinking incl `xhigh`, inference profiles, prompt caching — new model available, we still default `claude-opus-4-8`), `ANTHROPIC_AUTH_TOKEN` bearer auth for Anthropic-compatible gateways (incl compaction/branch-summaries), `If-None-Match` catalog revalidation (unchanged providers answer `304`), `outputPad` exposed to custom message renderers (#7045). Fixes that help us: **startup context-file discovery now skips directories named like `AGENTS.md`** (#7106 — the `statSync().isFile()` EISDIR guard; we have an `AGENTS.md`), unavailable scoped models hidden from `/models` (#7032), llama.cpp catalog persistence.
- **Compat surface intact (verified in the 0.82.1 dist):** `@mariozechner/*` loader aliases (`pi-tui`, `pi-ai` + `/compat` + `/oauth` + `/providers`, `pi-coding-agent`, `pi-agent-core`) all present → all ~46 extension imports resolve. `ctx.modelRegistry` shim still exposes `isUsingOAuth`/`getApiKeyAndHeaders`/`getApiKeyForProvider`/`registerProvider`/`getAvailable`/`find`/`refresh` → **pi-claude-code-use Claude path safe**.
- **Caution carried forward (future release):** the `/compat` entrypoint and `@mariozechner/*` aliases are slated for removal "in a future release" (no version announced). When it lands, the ~48 extension files must be renamed `@mariozechner/*` → `@earendil-works/*` and runtime pi-ai imports moved to `/compat` or the new `createModels()` API. Re-audit the compat surface at that point.
- **pi-core patches — precise per-file handling (verified stock 0.82.0 vs stock 0.82.1):**
  - `resource-loader.js` — **RE-DERIVED**, not blind-copied. 0.82.1 added a new `if (!statSync(filePath).isFile()) continue;` block (~line 36, the #7106 EISDIR/`AGENTS.md` fix) in the directory-walk method — **outside** our patch region. Our conflict-suppression edit is at the `addExtensionConflictDiagnostics`/`detectExtensionConflicts` loop (~line 407, anchor still present). Applied our suppression edit onto fresh stock 0.82.1 in place (removed the `for (const conflict of conflicts) errors.push()` loop, kept the new statSync line), then copied live → repo as new canonical. Blind-copying the 0.82.0 repo patch would have **reverted the EISDIR fix**.
  - `keybindings.js` + `session-selector.js` — **0 upstream drift** 0.82.0→0.82.1 (stock byte-identical). Repo patches deployed as-is; verified live `app.session.pin` ×2, session-selector 7 `LOCAL PATCH`.
  - pi-tui width patch — `pi update` brought a fresh **v0.82.1** pi-tui copy; `apply-pi-tui-width-patch.mjs` patched it cleanly (anchors unchanged), all other copies already-patched, `--check` exit 0 (re-run after pi update AND after the package updates).
- **Packages (targeted `pi update npm:<pkg>`, NOT `--extensions` — that clobbers condensed-milk):**
  - **pi-web-access 0.13.0 → 0.14.0** — mostly additive (new search providers: AnySearch/SERPdive/SearXNG/self-hosted Firecrawl; `source_check` research artifacts; `$ENV`/`!command` credential sources; `typebox` now a real runtime dep). Default public tool names **unchanged** (`web_search`/`fetch_content`/`get_search_content`/`source_check`) — no collision with our 24 custom tools (verified). **`### Removed`: the bundled `librarian` skill is dropped** — confirmed gone from `~/.pi/agent/npm/node_modules/pi-web-access/skills/`. Our custom **`librarian` tool** (`extensions/tools/librarian.ts`) is separate and unaffected; only the package skill disappears (skill count 28 → 27).
  - **pi-mcp-adapter 2.11.0 → 2.15.0** (4 minor bumps) — all additive/fixes. `get_<resource>`→`read_<resource>` rename (2.13.0) affects only *generated MCP resource tools*, not the `mcp` proxy tool; OAuth creds moved to OS credential store (2.13.0) — we use `auth:false` (localhost astro/paper), no OAuth creds, no impact. Single `mcp` proxy tool name unchanged; `mcp.json` servers intact.
- **condensed-milk untouched** by the targeted updates (separate package) — `$`-prefix strip intact.
- **Smoke-tested:** `pi --version` = 0.82.1; `verify-patches.sh` ALL PASS (8/8); `apply-pi-tui-width-patch.mjs --check` exit 0; clean `pi -p` boot with real Claude reply (`MIGRATION_OK`), zero load/tool/provider/conflict errors. Rollback backup: `~/pi-update-backup-20260727_152216` (auth.json + patched 0.82.0 dist files + VERSION).

---

## Extensions (11 active)

All live in `~/.pi/agent/extensions/`, backed up in `pi-setup/extensions/`.

| Extension | File | Purpose |
|-----------|------|---------|
| System Prompt | `system-prompt.ts` | Loads `prompt.amp.system.md` template with variable interpolation |
| Tool Harness | `tool-harness.ts` | Env-gated tool filtering per workspace |
| Mentions | `mentions.ts` | @mention resolution (sessions, commits) + agent directives (@oracle, @finder, @codereview, @task) |
| Session Name | `session-name.ts` | Auto session naming |
| Session Breakdown | `session-breakdown.ts` | `/session-breakdown` analytics command |
| Notify | `notify.ts` | Desktop notifications via OSC 777 |
| Todos | `todos.ts` | File-based todo manager with TUI |
| MD Export | `md-export.ts` | `/md` — session JSONL → markdown export (clipboard or file) |
| Command Palette | `command-palette/` | Ctrl+Shift+P overlay |
| Editor | `editor/` | Custom box-drawing editor |
| Tools | `tools/` | 24 custom tools (see below) |

**Note:** pi auto-discovers every `.ts` file in `extensions/` — there is no "present but disabled" state. To disable an extension, delete it or move it out of `extensions/`. `kimi-code-token.mjs` also lives here but is a helper script (called by the `kimi-code` provider), not a loaded extension. The 2026-07-23 cleanup deleted the former disabled extensions (handoff, brain-loader, opencode-zen, commandcode, pi-vcc-config) and `btw.ts` / `local-model.ts` / `crof.ts` / `import-opencode.ts` entirely — recover from git if ever needed.

---

## Custom Tools (24)

All live in `~/.pi/agent/extensions/tools/`, backed up in `pi-setup/extensions/tools/`.

### Tool Replacements (override pi built-ins)

These replace pi's default tool implementations with customized versions:

| Tool | File | Customization |
|------|------|---------------|
| **bash** | `bash.ts` | Git trailer injection, mutex locking for git commands, psst secret injection into subprocess env, output scrubbing |
| **read** | `read.ts` | Image viewing support |
| **edit-file** | `edit-file.ts` | Mutex locking to prevent concurrent edits |
| **create-file** | `create-file.ts` | Auto parent directory creation |
| **format-file** | `format-file.ts` | Prettier/biome formatting |
| **grep** | `grep.ts` | Custom output formatting |
| **glob** | `glob.ts` | Custom result handling |
| **ls** | `ls.ts` | Delegates to read tool |
| **undo-edit** | `undo-edit.ts` | Edit reversal with diff display |
| **skill** | `skill.ts` | Skill loading |

### New Tools (not in default pi)

| Tool | File | Purpose |
|------|------|---------|
| **finder** | `finder.ts` | Concept-based search subagent (haiku) — chain 3+ searches or search by concept |
| **oracle** | `oracle.ts` | Architecture review, hard multi-file bugs, complex planning (sonnet, read+bash) |
| **task** | `task.ts` | Spawns full subagent (same model as parent) for parallel independent work |
| **librarian** | `librarian.ts` | External repository exploration via GitHub API |
| **read-web-page** | `read-web-page.ts` | Web page reader using cheerio |
| **read-session** | `read-session.ts` | Read past pi session history |
| **search-sessions** | `search-sessions.ts` | Search session history by keyword, file, date |
| **code-review** | `code-review.ts` | Code review with diff analysis |
| **github** | `github.ts` | GitHub operations (repos, diffs, commits, search) |

**Web search:** `pi-web-access` was removed 2026-07-30 (see Packages). As of Phase 1 there is **no `web_search` tool** until Phase 3 lands the Parallel AI port. Page reading is covered by our own `read_web_page` tool. The earlier custom `web-search.ts` (Codex Responses API override) and the unregistered `look-at.ts` were deleted in the 2026-07-23 cleanup — image viewing works directly via the custom `read` tool.

### Tool Libraries (`tools/lib/`)

Shared code used by multiple tools:

| Library | Purpose |
|---------|---------|
| `agents-md.ts` | AGENTS.md/CLAUDE.md reading |
| `box-format.ts` | Box-drawing formatting |
| `file-tracker.ts` | File change tracking |
| `github.ts` | Shared GitHub API helpers |
| `html-to-md.ts` | HTML to markdown conversion |
| `interpolate.ts` | Template variable interpolation |
| `pi-spawn.ts` | Sub-agent spawning |
| `psst.ts` | Secret management (psst vault integration) |
| `show-renderer.ts` | TUI rendering for tool output |
| `show.ts` | Show/hide tool output panels |
| `sub-agent-render.ts` | Subagent output rendering |
| `tool-cost.ts` | Token cost calculation |
| `tui.ts` | TUI component helpers |
| `mutex.ts` | File-based mutex locking |
| `permissions.ts` | Permission evaluation |
| `output-buffer.ts` | Buffered output handling |
| `config.ts` | Shared config reader with schema validation, deep merge, project-local opt-in (ported from @bds_pi/config) |
| `prompt-patch.ts` | Auto-derive promptSnippet/promptGuidelines from tool descriptions (ported from @bds_pi/prompt-patch) |
| `fs.ts` | Path resolution and directory walking utilities (ported from @bds_pi/fs) |
| `mentions/` | @mention system — parse, resolve, render, agent directives, session/commit indexing, autocomplete provider (ported from @bds_pi/mentions) |

---

## Skills

### Config-level (`~/.config/agents/skills/`) — 21 skills

`amp-voice`, `chrome-cdp`, `coordinate`, `dig`, `document`, `git`, `nexus-fix`, `remember`, `report`, `review`, `rounds`, `shepherd`, `spar`, `spawn`, `tmux`, `write`

**Added 2026-07-23 (5 external skills, adapted for pi — author-prefixed names):**

| Skill | Author (prefix) | What it is | Subagents it spawns |
|-------|-----------------|------------|---------------------|
| `s-improve` | shadcn (`s-`) | read-only codebase auditor → writes self-contained handoff plans in `plans/`; never edits source | ≤4 read-only `Task` (standard) / ≤8 (deep), only during an audit |
| `c-sqr` | cursor (`c-`) | strict quality review — harsh structural critique of a branch diff (was "thermo-nuclear") | none |
| `mat-cr2axis` | matt pocock (`mat-`) | two-axis diff review: standards (fowler smells) + spec, side by side | 2 read-only `Task` (parallel) |
| `mat-design` | matt pocock (`mat-`) | deep-modules vocabulary (module/interface/seam/adapter/depth) | 3–4 `Task` only in the DESIGN-IT-TWICE path |
| `mat-tdd` | matt pocock (`mat-`) | test-driven development discipline (red→green, seams, anti-patterns) | none |

Mnemonic: **`s-` shadcn, `c-` cursor, `mat-` matt**. Sources: shadcn/improve, cursor/plugins (cursor-team-kit), mattpocock/skills. **Adapted for pi:** all Claude-Code/Cursor machinery mapped to pi tools (Explore/`Agent`→`Task`, issue-tracker→`github` tool) or cut (shadcn's `execute`/`reconcile` worktree flow + `closing-the-loop.md` removed — pi `Task` has no worktree isolation or bidirectional messaging). `code-review` renamed `mat-cr2axis` to avoid clashing with the `code_review` tool; `disable-model-invocation` frontmatter dropped (unused by `skill.ts`). Descriptions cross-reference each other to prevent the model confusing them. As adapted, **none of the five ever edits code via a subagent — every subagent they spawn is read-only.**

### Pi-level (`~/.pi/agent/skills/`)

No repo-stored pi-level skills (`pi-skills/` is empty). `find-skills` and `userinterface-wiki` are pi-package-managed symlinks, auto-created on install.

### Package-provided skills (discovered by the `skill` tool as of 2026-07-23)

Installed packages ship their own skills inside their package dir: `context-management` (pi-context), `autoresearch-create/finalize/hooks` (pi-autoresearch). pi's native listing shows these in the `/` menu, but our custom `skill` tool (`tools/skill.ts`) originally only scanned the settings/agent/project skill roots — so `skill({ name: "..." })` failed with "skill not found" even though the skill was visible. **Fix:** `skill.ts` now also discovers `~/.pi/agent/npm/node_modules/<pkg>/skills/` (incl `@scope/name`) and `~/.pi/agent/git/<host>/<org>/<repo>/skills/`, and an `isDirLike()` helper makes symlinked skill dirs (find-skills, userinterface-wiki) list correctly (`Dirent.isDirectory()` is false for symlinks). User/config skills still win over package skills of the same name. **27 skills** loadable by name (21 config + find-skills + userinterface-wiki + context-management + 3 autoresearch). *(The `librarian` skill shipped by pi-web-access until **0.14.0 removed it** 2026-07-27 — our custom `librarian` **tool** is separate and unaffected. The `computer-use` skill from pi-computer-use was here until that package was removed 2026-07-23 — its tools were never active.)*

---

## Models

### Providers (in models.json)

| Provider | Models | Purpose |
|----------|--------|---------|
| `anthropic` | `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` (1M context override) | Direct Anthropic API + OAuth (Claude Max via pi-claude-code-use) |
| `deepseek` | `deepseek-v4-pro`, `deepseek-v4-flash` | 1M context, thinking mode, OpenAI-compatible API |
| `kimi-code` | `kimi-for-coding` (K2.7 Code, 262K ctx) | Kimi Code subscription OAuth via `~/.kimi-code/credentials/kimi-code.json`; token helper refreshes through `https://auth.kimi.com/api/oauth/token` |
| `sakana` | `fugu`, `fugu-ultra` (both 1M ctx, text+image) | Sakana AI "Fugu" multi-agent orchestration. OpenAI **Responses** API at `https://api.sakana.ai/v1` (`api: openai-responses`), Bearer `$SAKANA_API_KEY`. $20/mo "Standard" subscription. See "Sakana AI (Fugu)" section below. |

### Sub-agent Models
- **finder**: `claude-haiku-4-5` (cheapest, fast parallel search)
- **librarian**: `claude-haiku-4-5` (cheapest, GitHub API exploration)
- **oracle**: `claude-sonnet-4-6` (strong reasoning for architecture/review)

### Active Settings

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5",
  "defaultThinkingLevel": "high",
  "theme": "gruvbox",
  "compaction": { "enabled": true }
}
```

---

## Sakana AI (Fugu) Provider

**Added:** 2026-06-22. **Config-only** (no extension, no patches) — lives in `models.json` as the `sakana` provider, exactly how pi is designed to absorb a new OpenAI-compatible provider.

### What it is

Sakana's API serves **"Fugu"** — a multi-agent orchestration system exposed as a single OpenAI-compatible model. Two models registered: `fugu` and `fugu-ultra` (both 1M context, text+image vision). $20/mo "Standard" subscription.

- **Base URL:** `https://api.sakana.ai/v1`
- **Wire API:** `openai-responses` (Sakana **recommends** Responses over Chat Completions; required for proper reasoning/tool management).
- **Auth:** Bearer `$SAKANA_API_KEY` (env var in `~/.zshrc`, same as `DEEPSEEK_API_KEY`). Key from `https://console.sakana.ai/api-keys`.

### Why `openai-responses` is safe here (verified against pi source)

Read `@earendil-works/pi-ai/dist/providers/openai-responses.js` before changing anything:

1. **`store: false` is hardcoded** (`buildParams`, ~line 190) and pi never sends `previous_response_id` — it rebuilds full history each turn (`input: messages`). Sakana is **stateless** (rejects `previous_response_id`), so pi's behavior matches Sakana exactly. This is also why "store like deepseek" is automatic: no server-side session either way.
2. **Reasoning summaries** (~lines 204-213): when effort is set, pi sends `reasoning: { effort, summary: "auto" }` + `include: ["reasoning.encrypted_content"]`, and parses `response.reasoning_summary_text.delta` back into thinking blocks. `fugu-ultra` supports reasoning summaries → "proper thinking" displays.
3. **The one trap** (~lines 215-219): if effort is unset and `thinkingLevelMap.off !== null`, pi sends `effort: "none"` — which **Sakana rejects** (it only accepts `high` and `xhigh`/`max`). Mitigated by `"off": null` in the map (pi then sends no reasoning param → Sakana uses its default) and by mapping every other level to `high`/`xhigh`.

### thinkingLevelMap (mandatory shape)

Sakana rejects any effort other than `high`/`xhigh`(==`max`), so all levels collapse:
```json
"thinkingLevelMap": { "off": null, "minimal": "high", "low": "high", "medium": "high", "high": "high", "xhigh": "xhigh" }
```

### Pricing

Only `fugu-ultra` carries published PAYG rates (input $5 / output $30 / cached-in $0.50 per 1M, <272K ctx). `fugu` is routed across providers with unpublished per-token rates → set to `0` (not invented). Under the $20 subscription these cost numbers are informational only.

### Known unknowns (deliberately NOT invented)

- `maxTokens` ceiling undocumented → set to `32768` (flagged guess; bump once observed).
- Numeric rate limits / $20 token allowance unpublished.
- `include: ["reasoning.encrypted_content"]` support not explicitly documented by Sakana — but their official Codex integration uses stateless Responses (`store:false`) with encrypted reasoning, so it's almost certainly supported. **If reasoning requests 4xx on `encrypted_content`/`developer` role, fallback:** switch `api` to `openai-completions` (loses fugu-ultra reasoning-summary display but keeps everything else), optionally with `compat.supportsDeveloperRole: false`.

### Setup steps to reproduce

1. `models.json` → `sakana` provider block (done).
2. `settings.json` → `enabledModels` adds `sakana/fugu`, `sakana/fugu-ultra` (done).
3. `~/.zshrc` → `export SAKANA_API_KEY="..."` next to the other provider keys.
4. New shell (or `source ~/.zshrc`), launch pi: `/model sakana/fugu-ultra:high`.

`models.json` hot-reloads when you open `/model` — no restart needed.

---

## File Layout

```
pi-setup/
├── install.sh                  # Full installer (backs up, then deploys)
├── settings.json               # Pi settings (packages, extensions, theme)
├── models.json                 # Model overrides + custom providers
├── keybindings.json            # Model cycling keys
├── permissions.json            # Git/rm safety rules
├── mcp.json                    # pi-mcp-adapter global MCP servers (astro, paper)
├── pi-sub-bar-settings.json    # @marckrenn/pi-sub-bar widget layout
├── pi-sub-core-settings.json   # pi-sub-core provider/refresh config
├── README.md                   # Setup docs + session log
├── claude-bridge-patches/
│   ├── index.ts                # Patched pi-claude-bridge (our custom build)
│   └── package.json            # Version tracking
│   ├── package.json            # Version tracking
│   └── filters/
│       └── context-compress.ts # Patched context masking (cmd param support)
├── agents/                     # 9 agent prompt templates
│   ├── prompt.amp.system.md    # Main system prompt template
│   ├── prompt.harness-docs.pi.md  # pi-specific docs
│   └── ...
├── themes/                     # 2 pi TUI themes
│   ├── gruvbox.json
│   └── nightowl.json
├── pi-skills/                  # empty (find-skills + userinterface-wiki auto-created by packages)
├── config-skills/              # 21 config-level skills
└── extensions/
    ├── tools/                  # 24 custom tools + lib/ (config, prompt-patch, fs, mentions)
    ├── pi-tool-display/
    │   └── config.json         # All tool overrides disabled (required for compatibility)
    ├── mentions.ts             # @mention resolution + agent directives extension
    └── *.ts                    # other extensions (all active; auto-discovered)
```

---

## Agent Prompt Templates (`agents/`)

| File | Purpose |
|------|---------|
| `prompt.amp.system.md` | Main system prompt — identity, behavior rules, tool selection, code defaults, communication |
| `prompt.harness-docs.pi.md` | Pi-specific SDK docs injected into system prompt |
| `agent.amp.finder.md` | Finder subagent: concept-based code search |
| `agent.amp.librarian.md` | Librarian subagent: external repo exploration |
| `agent.amp.oracle.md` | Oracle subagent: architecture review, hard bugs |
| `prompt.amp.handoff-extraction.md` | Handoff extraction prompt (kept for reference; the handoff extension was removed) |
| `prompt.amp.code-review-system.md` | Code review system prompt |
| `prompt.amp.code-review-report.md` | Code review report format |
| `prompt.amp.read-web-page.md` | Web page reading prompt |

---

## Update Workflow

### Post-update verification — ALWAYS RUN THIS FIRST

```bash
bash pi-setup/verify-patches.sh
```

Read-only audit of every patch and config this setup depends on: resource-loader
conflict suppression, session pinning, **pi-tui width patch in ALL installed
copies** (TUI smears without it), condensed-milk absence,
pi-tool-display config, editor label guards, box-format normalization. Each
FAIL prints the exact fix command. Exit 0 = everything in place. Run it after
`pi update`, any `pi install`, any npm package update — or whenever something
feels off. `pi-setup/install.sh` also runs it as its final step.

When pi or any package gets updated:

1. **pi itself updated** (`@earendil-works/pi-coding-agent`): Check if any internal APIs changed that our extensions depend on. Look at the [changelog](https://github.com/earendil-works/pi). Our extensions override built-in tools — if the tool API changed, update our tool files accordingly. The `@mariozechner/*` backward-compat aliases are currently preserved but will eventually be removed — when that happens, rename imports in all 46 `.ts` files (see log.md for the sed command). **Must re-apply `resource-loader.js` patch** — it suppresses extension tool-conflict boot errors; kept as a safety net (with the custom `web_search` removed there is currently no active conflict, but any future package/extension name collision would block startup without it). **Must re-run `apply-pi-tui-width-patch.mjs`** — without it, heavy output with Indic matras/exotic unicode desyncs and smears the whole TUI; note EVERY package update/install brings a fresh unpatched pi-tui copy (see "TUI Width Desync Fix").

2. **condensed-milk-pi**: REMOVED 2026-07-30 — do not reinstall. See "condensed-milk-pi: REMOVED" above for why (it reported failed git commands as successes).

3. **pi-sub-bar / pi-sub-core updated**: no code patches, but the settings files
   must only name providers the installed version actually ships. As of
   **pi-sub-core 1.5.0** those are exactly:

   `anthropic, copilot, gemini, antigravity, codex, kiro, zai`

   There is **no `kimi` and no `crofai`** — an earlier note here claimed they
   were "built-in as of v1.5.0", which was wrong and cost a debugging session.
   A provider named in `pi-sub-core-settings.json` that has no factory breaks
   the usage tools in two different ways:

   - in `providers{}` → `PROVIDER_FACTORIES[name] is not a function`
   - in `providerOrder[]` → `Cannot read properties of undefined (reading 'enabled')`

   Both surface only when `get_all_usage` runs, so a normal boot looks clean.
   After any pi-sub-* update, re-check both keys in
   `pi-sub-core-settings.json` **and** `pi-sub-bar-settings.json` against the
   `PROVIDER_FACTORIES` map in
   `~/.pi/agent/npm/node_modules/@marckrenn/pi-sub-core/src/providers/registry.ts`.

4. **pi-tool-display updated**: Config file at `~/.pi/agent/extensions/pi-tool-display/config.json` is NOT touched by npm updates. But if you delete and reinstall, **recreate the config** with all tool overrides set to `false`. Without it, pi-tool-display overwrites our custom tools.

5. **Other packages** (pi-context, pi-token-burden, pi-codex-goal, pi-autoresearch, pi-mcp-adapter): Generally safe to update. No patches on these. Check if they register tools or skills that conflict with ours.

### Quick re-patch after any update

```bash
# pi core — suppress extension tool-conflict boot errors (safety net; keep even with web_search removed)
cp pi-setup/pi-core-patches/resource-loader.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js

# pi core — session pinning (Ctrl+B in /resume picker)
cp pi-setup/pi-core-patches/session-selector.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js
cp pi-setup/pi-core-patches/keybindings.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js

# pi-tui — conservative grapheme widths in ALL installed copies
# (CRITICAL — TUI smears on exotic unicode without it; every package bundles its own pi-tui)
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs

# condensed-milk — REMOVED 2026-07-30, nothing to re-apply. Do not reinstall.

# pi-sub-bar — no patches needed (CrofAI + Kimi now built-in as of v1.5.0)

# pi-tool-display config (verify exists, recreate if missing)
cp pi-setup/extensions/pi-tool-display/config.json ~/.pi/agent/extensions/pi-tool-display/config.json

# pi-claude-bridge (only if reactivating — currently inactive)
# cp pi-setup/claude-bridge-patches/index.ts /opt/homebrew/lib/node_modules/pi-claude-bridge/src/index.ts
```

### What NOT to Do

- **Don't edit files directly in `/opt/homebrew/lib/node_modules/`** — they'll be wiped on the next npm update. Always edit in the repo (`pi-setup/`) and deploy via `install.sh` or manual `cp`.
- **Don't run `install.sh` without checking what changed** — it backs up existing files but overwrites them. If you've made live tweaks you want to keep, back them up first.
- **Don't reinstall condensed-milk-pi** — it silently rewrote failed git commands into success messages (`git add -A` rejected by permissions → reported as `ok (1 files staged)`), and needed three local patches to stay usable.
- **Don't set pi-tool-display overrides to `true`** — it replaces our custom tools with pi defaults, losing mutex locking, secret scrubbing, git trailers, image support.
- **Don't add `claude-agent-sdk-pi` back to packages** — it's the legacy bridge and conflicts with `pi-claude-bridge`.
- **Check `pi-setup/2026-05-17-migration-log.md`** if anything breaks — it has the full record of every change made, every decision, and rollback instructions.
- **Check `pi-setup/2026-07-30-bdsqqq-port.md`** before changing sub-agent tool wiring, `pi-spawn`, or the edit tools — it documents the OAuth tool-filter trap, the native `--tools` requirement, and the model-preservation rules.
