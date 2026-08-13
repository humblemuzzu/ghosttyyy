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

### bdsqqq Port — COMPLETE (read before changing tools/subagents)

**See `pi-setup/2026-07-30-bdsqqq-port.md`.** Port of selected pieces from
[bdsqqq/dots](https://github.com/bdsqqq/dots). All phases are done (subagent tool
injection fixed, `web_search` replaced with Parallel AI, `agent_message` added,
`search_sessions` rebuilt on a branch model, condensed-milk removed; Phase 4:
`apply_patch` lanes replaced `edit`/`write`, `delegate` replaced `Task`).

That file records **why** several things are the way they are — in particular the
`pi-claude-code-use` OAuth tool filter that silently strips every custom tool from
sub-agent requests, and why `--no-tools` must never be used. Do not re-derive it.
Verification harnesses live in `pi-setup/port-harness/`.

### Provider Chain

```
pi CLI (v0.84.1) — @earendil-works/pi-coding-agent
  ├─ kimi-code provider (custom local config) + Kimi Code OAuth token helper
  │    └─ https://api.kimi.com/coding/v1 — Kimi Code subscription access
  └─ anthropic provider (native) + pi-claude-code-use (API payload shim for Claude Max OAuth use)
       └─ Claude API
```

Current default provider is `anthropic` with **`claude-opus-5`** (set in settings.json, and listed in `enabledModels` so it appears in `/model`). `kimi-code`/`kimi-for-coding` (K2.7 Code) remains available via Kimi Code subscription OAuth, and `openai-codex` with `gpt-5.5`/`gpt-5.6-sol` is also available. Switch the default any time with `/model`.

**When you change the default provider, also update `pi-sub-core-settings.json`:**
its `defaultProvider` is what the status bar / usage refresh reports on, and a provider
left at `enabled: false` there returns `{}` no matter what. Anthropic is now
`enabled: "auto"` + `fetchStatus: true`, which surfaces real Claude Max quota
(5-hour and weekly windows) in the status bar and in both usage tools.

**REQUIRED for Anthropic: `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1`** (set in
`~/.zshrc`). `pi-claude-code-use` rewrites every anthropic+OAuth request to look
like Claude Code, and its `filterAndRemapTools()` **silently drops any tool whose
name is not one of Claude Code's own 17** — removing `finder`, `oracle`,
`delegate`, `librarian`, `code_review`, the seven github tools and more. 38 tools
become 4 (`Read`/`Bash`/`Grep`/`Skill`), with no error anywhere.

This is **not** headless-only: the gate is `provider === "anthropic" &&
isUsingOAuth`, with no mode check, so a normal TUI session is affected too. It
stayed hidden for months only because the default model was `openai-codex`.
Without the flag, a fresh session will tell you it cannot call your sub-agents.
See `pi-setup/2026-07-30-bdsqqq-port.md` §3.1.

**Legacy fallback:** `pi-claude-bridge` (installed but not active in packages) wraps the Claude Code Agent SDK as a custom provider.

### System Prompt Assembly

The system prompt is assembled in layers:

1. **`system-prompt.ts`** — loads `agents/prompt.amp.system.md` template, interpolates variables (`{identity}`, `{harness}`, `{date}`, `{cwd}`, `{roots}`, `{os}`, `{repo}`, `{sessionId}`, `{ls}`, `{harness_docs_section}`)
2. **`tools/lib/pi-spawn.ts`** — sub-agent tool surfaces: per-agent `--tools` allowlists merged from each tool's `BUILTIN_TOOLS`/`EXTENSION_TOOLS` consts (replaced the old `tool-harness.ts` env-gated filtering)

---

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

## pi-mcp-adapter: Configuration Required

Two upstream defaults are deliberately **turned off**, both added in 2.18–2.19:

| Default | Our setting | Why |
|---|---|---|
| `mcpScript` tool registered | `settings.scriptMode: false` in `mcp.json` | It executes arbitrary JavaScript in a worker and adds a second permanent tool — this package was chosen precisely because it costs *one* ~200-token proxy tool, and `permissions.json` does not cover a JS execution surface. |
| `mcp-scripting` skill shipped | `{ "source": "npm:pi-mcp-adapter", "skills": [] }` in `settings.json` | With `scriptMode: false` the skill would teach a tool that does not exist. |

The object form is load-bearing and was verified against 0.84.1's
`collectPackageResources`: with `autoload` unset, `skills: []` filters skills to
none while `extensions` (undefined) still loads from the package's pi manifest —
so the `mcp` tool still registers. **Do not "simplify" it back to the string
form**; that silently restores the skill.

Verify after any update: the tool list must contain `mcp` and **not**
`mcpScript`; the skill list must not contain `mcp-scripting`.

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

**First check whether it is the OTHER width bug — the one that CRASHES rather
than smears.** On 2026-08-04 pi died with `Rendered line 2822 exceeds terminal
width (140 > 125)` at `pi-tui/dist/tui.js` `doRender`. That was **not** the
pi-tui patch and **not** a smear: `box-format.ts` defined its own
`visibleWidth` counting **one column per codepoint**, so a Japanese
`web_search` result title was clamped to "122 columns" and rendered at 140
(18 East-Asian Wide chars × 2). pi-tui asserts every line fits and throws an
uncaughtException, which kills the process — that assertion has existed since
pi-tui **0.6.2 (2025-11-12)**; what changed was `web_search` (added 2026-07-30)
becoming the first tool to put **arbitrary web-page titles** in a box header.
Stock unpatched pi-tui measures that line at 140 too, so our width patch was
never implicated.

Fixed by deleting the private measure and using pi-tui's `truncateToWidth` /
`visibleWidth` — **the invariant is that we must clamp with the same function
pi-tui asserts with.** Also clamped the `╰────` footer (a *constant* is still 5
columns and boxes render into narrower nested contexts) and made
`renderCallLine` honour its `width`. Guarded by `lib/box-format.test.ts`: 480
tests over ~28 scripts (CJK, Devanagari, Bengali, Tamil, Thai, Vietnamese,
Arabic, Hebrew, emoji ZWJ/skin-tone/flags, zero-width, tabs, ANSI) × 12 widths,
asserting `visibleWidth(line) <= width` for every emitted line. Verified the
suite actually catches it: reintroducing the old measure fails 26 tests,
starting with "the string that crashed pi @ width 125".

The same file also flattens `\r\n\v\f\u2028\u2029` in headers and notices —
a newline in a single-line sink is width-0, passes every width check, and still
advances a row nobody counted (that one smears rather than crashes).

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
- **Parent is Anthropic** (provider `anthropic` or `claude-bridge`, or model name contains `claude`) → use the designated model (`claude-sonnet-5`, `claude-opus-4-6` — see "Sub-agent Models")
- **Parent is non-Anthropic** (deepseek, kimi-code, sakana, llama-local, openai-codex, etc.) → inherit parent model (can't use Claude without separate API access)

This means subagents use Claude models when you're on Claude, but don't break when you're on a non-Anthropic provider.

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

Extends pi's existing @mention system to support agent tool routing. When the user types `@oracle review this auth flow`, a hidden directive is injected into the context telling the model to call the `oracle` tool — not delegate, not do it itself.

### How It Works

1. **Parse** — standalone regex `(?<![\w/])@(oracle|finder|codereview|task)(?=[\s.,;:!?)\]}]|$)` matches `@oracle` without requiring `/value` (unlike `@commit/sha`)
2. **Resolve** — `agent-source.ts` maps each kind to its tool name (e.g. `codereview` → `code_review`, `task` → `delegate`)
3. **Render** — produces `AGENT DIRECTIVE: Call the \`oracle\` tool for this request. The user explicitly tagged @oracle. Do not substitute another tool.`
4. **Inject** — `mentions.ts` injects the directive as a hidden `display: false` custom message in the `context` hook

### Agent ↔ Tool Mapping

| Mention | Tool | Description |
|---------|------|-------------|
| `@oracle` | `oracle` | Expert advisor — architecture, planning, hard bugs |
| `@finder` | `finder` | Codebase search by concept or behavior |
| `@codereview` | `code_review` | Code review with diff analysis |
| `@task` | `delegate` | Full subagent for independent parallel work (resumable) |

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
| `cloudflare` + 15 product servers | HTTP (`url`) | see "Cloudflare MCP servers" below | All remote. `auth: "oauth"` (never `true`!) + `protocolVersion: "auto"` for authenticated ones; `auth: false` for the public ones. |

### Cloudflare MCP servers (added 2026-08-13)

[Cloudflare's managed MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/).
All are **remote Streamable HTTP** endpoints, all use `protocolVersion: "auto"` — they are stateless MCP SDK v2
Workers (`createMcpHandler`), which is exactly the case the adapter's README cites for `"auto"`
(modern 2026-07-28 `server/discover` negotiation with conservative legacy fallback).
Authenticated servers use **Cloudflare OAuth** (authorization-code + PKCE, dynamic client registration,
loopback callback, tokens in the macOS Keychain) **or** an optional static `Authorization: Bearer` API token.
Lazy (default): nothing connects until a `cloudflare-*` tool is actually called.

**`auth` must be `"oauth"`, never `true`.** `auth: true` is NOT a legal value in pi-mcp-adapter
(valid: `"oauth"`, `"bearer"`, `false`, or omitted) and it fails **silently**: `supportsOAuth()`
(`mcp-auth-flow.ts`) falls through to `definition.auth === undefined`, so `true` disables both OAuth
and bearer and the server connects unauthenticated → 401. This bit us on first setup — the deployed
entry had `"auth": true`. See `pi-setup/2026-08-13-cloudflare-mcp.md`.

| Key | URL | What it is | Auth |
|-----|-----|-----------|------|
| `cloudflare` | `https://mcp.cloudflare.com/mcp` | **Cloudflare API** — Code Mode: `search()` + `execute()` over the whole API (~2,500 endpoints, ~1,000 tokens) + `docs` (dev docs search). Agent writes JS against a typed OpenAPI spec, executed in a Dynamic Worker sandbox with outbound restricted to api.cloudflare.com | OAuth (scope picker: Read only default / Full access / per-resource) |
| `cloudflare-docs` | `https://docs.mcp.cloudflare.com/mcp` | Developer docs search (AutoRAG) | public |
| `cloudflare-blog` | `https://blog.mcp.cloudflare.com/mcp` | Blog search/read | public |
| `cloudflare-stack` | `https://stack.mcp.cloudflare.com/mcp` | Docs search over a curated stack (Cloudflare/Hono/Vite/Astro…) | public |
| `cloudflare-agents-docs` | `https://agents.cloudflare.com/mcp` | Agents SDK docs search | public |
| `cloudflare-bindings` | `https://bindings.mcp.cloudflare.com/mcp` | Workers platform primitives: KV, R2, D1, Hyperdrive, Workers (+ get code) | OAuth |
| `cloudflare-builds` | `https://builds.mcp.cloudflare.com/mcp` | Workers Builds insights/management, build logs | OAuth |
| `cloudflare-observability` | `https://observability.mcp.cloudflare.com/mcp` | Workers logs/metrics debugging (heavy — keep queries concise per Cloudflare's own troubleshooting note) | OAuth |
| `cloudflare-containers` | `https://containers.mcp.cloudflare.com/mcp` | Ephemeral (~10 min) sandboxed dev containers (Node/Python) | OAuth |
| `cloudflare-browser` | `https://browser.mcp.cloudflare.com/mcp` | Browser Run: fetch → HTML/Markdown/screenshot/PDF, CSS-selector scraping, async crawls | OAuth |
| `cloudflare-logpush` | `https://logs.mcp.cloudflare.com/mcp` | Logpush job health summaries | OAuth |
| `cloudflare-ai-gateway` | `https://ai-gateway.mcp.cloudflare.com/mcp` | AI Gateway logs, prompt/response bodies, usage | OAuth |
| `cloudflare-auditlogs` | `https://auditlogs.mcp.cloudflare.com/mcp` | Account change-history queries + reports | OAuth |
| `cloudflare-dns-analytics` | `https://dns-analytics.mcp.cloudflare.com/mcp` | DNS performance optimization/debugging | OAuth |
| `cloudflare-dex` | `https://dex.mcp.cloudflare.com/mcp` | Digital Experience Monitoring (device/network/app perf, remote PCAP) | OAuth |
| `cloudflare-casb` | `https://casb.mcp.cloudflare.com/mcp` | Cloudflare One CASB — SaaS security misconfiguration findings | OAuth |

Deliberately **not** added: `radar`, `autorag` (AI Search), `graphql` — deprecated by Cloudflare
(their READMEs direct new users to the unified `mcp.cloudflare.com/mcp` Code Mode server, which covers
GraphQL analytics via `execute`); and `demo-day` (a demo server).

**First connect (one-time per server):** run `/mcp-auth <key>` in the TUI (walks the whole browser flow),
or headless: `mcp({ action: "auth-start", server: "cloudflare" })` → approve in the browser →
`mcp({ action: "auth-complete", server: "cloudflare", args: { redirectUrl } })`. Tokens are stored in
the macOS Keychain under `pi-mcp-adapter.oauth`, refreshed transparently (1 h access / 30 d refresh).
The main server's consent screen has a scope picker (Read only is the default preset).

**Bearer alternative (CI/CD):** any authenticated server also accepts a Cloudflare API token
(user or account; `cfat_`/`cfut_` prefixes) as a static header —
`{ "url": "https://bindings.mcp.cloudflare.com/mcp", "headers": { "Authorization": "Bearer <token>" } }`.
**Custom headers disable implicit OAuth auto-detect**, so that shape must set `auth: "oauth"` explicitly
if you want both. Multi-account: add a `cf-account-id` header to pin the account.

To add more servers: edit `~/.pi/agent/mcp.json` (global) or a project `.mcp.json`. stdio servers use `command`/`args`; HTTP servers use `url` (+ optional `headers`/`auth`).

```json
{ "mcpServers": {
  "astro": { "url": "http://127.0.0.1:8089/mcp", "auth": false },
  "paper": { "url": "http://127.0.0.1:29979/mcp", "auth": false },
  "cloudflare": { "url": "https://mcp.cloudflare.com/mcp", "auth": "oauth", "protocolVersion": "auto" },
  "cloudflare-docs": { "url": "https://docs.mcp.cloudflare.com/mcp", "auth": false, "protocolVersion": "auto" }
} }
```

### After pi/package update

No patches to re-apply. `pi update --extensions` may bump it — safe (unpatched). Backed up as the `npm:pi-mcp-adapter` entry in `pi-setup/settings.json` (package) + `pi-setup/mcp.json` (server config); `install.sh` re-adds both on deploy.

---

## Packages (npm)

| Package | Version | Purpose | Patched? |
|---------|---------|---------|----------|
| `@earendil-works/pi-coding-agent` | 0.84.1 | The pi agent itself (installed via homebrew npm) | **3 core patches** |
| `@benvargas/pi-claude-code-use` | 1.0.5 | API payload shim for Claude Max OAuth use (system prompt + tool-name compatibility) (primary Claude method) | No |
| `pi-context` | 2.1.2 | Context management: context_checkpoint, context_timeline, context_compact | No |
| `pi-token-burden` | 0.6.5 | Token usage tracking and display | No |
| `@marckrenn/pi-sub-bar` | 1.5.0 | Usage widget — shows provider quotas in status bar | No (**config**: see below) |
| `pi-autoresearch` | 1.6.2 | Autonomous experiment loop for optimization targets (GitHub install) | No |
| `pi-tool-display` | 0.5.0 | Compact tool rendering, thinking labels, user message box | **Config** |
| `pi-codex-goal` | 0.2.0 | Codex-style `/goal` — autonomous multi-turn objectives with completion audit | No |
| `pi-mcp-adapter` | 2.21.0 | On-demand MCP gateway — single `mcp` proxy tool (~200 tokens), lazy server connect | No (**config**: see below) |

**Active in settings.json (8):** `pi-context`, `pi-token-burden`, `@benvargas/pi-claude-code-use`, `@marckrenn/pi-sub-bar`, `pi-autoresearch`, `pi-tool-display`, `pi-codex-goal`, `pi-mcp-adapter`

**pi-claude-code-use is deliberately held at 1.0.5** (2.1.0 exists). Verified safe
on 0.84.1: it touches exactly one registry API (`isUsingOAuth`, unchanged), and
2.x's only new ≥0.84 feature needs registered MCP aliases, which we never have.
See `pi-setup/pi-migrations.md`.

**Removed packages — do not reinstall.** Reasons in `pi-setup/pi-migrations.md`
and the bdsqqq port log; the short version:

| Package | Removed | Why |
|---|---|---|
| `pi-web-access` | 2026-07-30 | `web_search` was 100% dead (every provider key rejected/rate-limited) and `source_check` silently degraded because it consumes it. Replaced by our self-contained Parallel AI `web_search`. |
| `pi-tasks` | 2026-07-30 | Array parameters arrived JSON-stringified and were rejected, so `task_plan` always failed and every tool gated behind it was unreachable. |
| `@tomooshi/condensed-milk-pi` | 2026-07-30 | Reported **failed** git commands as successes (a permission-rejected `git add -A` became `ok (1 files staged)`) and masked 60% of prior tool results at 30% context use. Needed three local patches to stay usable. `verify-patches.sh` fails loudly if a copy reappears. |
| `@sting8k/pi-vcc` | — | Algorithmic compaction; replaced by pi's native `compaction.enabled`. |
| `pi-computer-use` | 2026-07-23 | Installed-but-inactive, so its `computer-use` skill loaded while its GUI tools never registered — a dead skill in the list. |
| `pi-gpt-config`, `pi-ask`, `pi-grok-cli` | 2026-07-23 | Unused. |

**Kimi Code usage:** `/model kimi-code/kimi-for-coding:high`. Uses `~/.kimi-code/credentials/kimi-code.json` and `pi-setup/extensions/kimi-code-token.mjs` to refresh Kimi Code subscription OAuth tokens.

**Claude Max usage:** `/login anthropic` → `/model anthropic/claude-opus-5`. pi-claude-code-use intercepts provider API requests (after OAuth) and rewrites payloads for Claude Code-style subscription use. No custom provider needed — uses pi's native anthropic provider.

**Installed but inactive:** `pi-claude-bridge` (0.4.0, legacy fallback, patched), `lsp-pi`, `pi-powerline-footer`, `pi-anycopy`

**Per-version migration record:** `pi-setup/pi-migrations.md` — one entry per pi
update, recording which patched core file drifted and how the patch was
re-derived. Read it before running `pi update`.

---

## Subagent Inspector (`extensions/subagent-inspector/`)

Ctrl+Shift+A (or `/subagents`) opens an overlay listing every sub-agent run in the
session. Enter opens one: its **thinking**, tool calls and tool results, scrollable.
`←`/`→` switch between runs, `f` toggles trimmed/full tool results, Esc backs out
one level then closes. Works while an agent is still running and after it finished.

**Read-only by design.** It observes what the sub-agent tools already report; it
never resumes a child, never writes to a running process, and writes nothing to disk.

### Why it needs no session files

The parent session JSONL already stores each sub-agent's *entire* transcript in the
tool result's `details.messages` — thinking blocks included (measured: librarian 114
messages / 57 thinking, oracle 64/7, delegate 193/49). So history survives for all
five agent tools even though only `delegate` persists its own session.

### Why the registry is fed by events, not a shared module

pi loads every extension file with its own jiti instance and `moduleCache: false`
(`dist/core/extensions/loader.js`). A module-level `Map` in `tools/lib/` is therefore
**not the same Map** when imported from another extension — it reads empty, silently,
with no error. `registry.ts` is fed by `pi.on("tool_execution_start"/"update"/"end")`,
which cross the boundary carrying the tool's full `details` payload. Do not "simplify"
this into a shared module.

### Layout

| File | Purpose |
|------|---------|
| `index.ts` | extension entry — events, shortcut, `/subagents`, overlay |
| `registry.ts` | tracks runs from tool events (pure, tested) |
| `transcript.ts` | `Message[]` → transcript nodes incl. thinking (pure, tested) |
| `inspector.ts` | the overlay component — list + scrollable detail |
| `types.ts` | shared types |
| `registry.test.ts`, `transcript.test.ts` | 28 unit tests, no pi deps |

`inspector.ts` imports `@mariozechner/*`, which only resolve through pi's jiti
aliases — so it is not unit-testable under bare `bun test`. It is covered instead by
a render harness (real session data, 5 widths × 2 themes × every scroll position,
asserting no line exceeds the width) and by pty tests driving a real pi.

**Rendering contract:** the detail view is built from pi's own `Markdown`/`Text`/
`TruncatedText` components inside a `Container`, so a sub-agent's transcript looks
like the parent agent's transcript rather than a dialog. Source text is passed
through `normalizeForDisplay()` first, and every emitted row is truncated to the
render width and then padded back out to it: each view emits exactly
terminal-height × full-width rows so the overlay fully occludes the conversation
instead of interleaving with it. One over-wide row re-opens the TUI smear class
documented above. `getMarkdownTheme()` throws before `initTheme()`, so it is
wrapped — a throw inside `render()` would take the TUI down.

**No core patches.** Pure extension API (`pi.on`, `registerShortcut`,
`registerCommand`, `ctx.ui.custom`). Deployed by `install.sh`'s `cp -R extensions`.
Mouse click-to-open is *not* possible: pi never enables mouse tracking and no pi-tui
component knows its screen position (see the research notes in the port log).

---

## Extensions (12 active)

All live in `~/.pi/agent/extensions/`, backed up in `pi-setup/extensions/`.

| Extension | File | Purpose |
|-----------|------|---------|
| System Prompt | `system-prompt.ts` | Loads `prompt.amp.system.md` template with variable interpolation |
| Mentions | `mentions.ts` | @mention resolution (sessions, commits) + agent directives (@oracle, @finder, @codereview, @task) |
| Session Name | `session-name.ts` | Auto session naming |
| Session Breakdown | `session-breakdown.ts` | `/session-breakdown` analytics command |
| Notify | `notify.ts` | Desktop notifications via OSC 777 |
| Todos | `todos.ts` | File-based todo manager with TUI |
| MD Export | `md-export.ts` | `/md` — session JSONL → markdown export (clipboard or file) |
| Command Palette | `command-palette/` | Ctrl+Shift+P overlay |
| Editor | `editor/` | Custom box-drawing editor |
| Subagent Inspector | `subagent-inspector/` | Ctrl+Shift+A / `/subagents` — drill into a sub-agent's live transcript |
| Tools | `tools/` | 28 custom tools (see below) |
| Local Model | `local-model.ts` | `/local` — start/stop the llama.cpp router; injects local-model rules ONLY for `llama-local` |

**Note:** pi auto-discovers every `.ts` file in `extensions/` — there is no "present but disabled" state. To disable an extension, delete it or move it out of `extensions/`. `kimi-code-token.mjs` also lives here but is a helper script (called by the `kimi-code` provider), not a loaded extension. The 2026-07-23 cleanup deleted the former disabled extensions (handoff, brain-loader, opencode-zen, commandcode, pi-vcc-config) and `btw.ts` / `crof.ts` / `import-opencode.ts` entirely — recover from git if ever needed. (`local-model.ts` was later rebuilt as the `/local` command — see Local Models.)

---

## Custom Tools (28)

**Count note (corrected 2026-08-05):** this section said "24" for a long time while
`index.ts` registered more. `github.ts` alone registers **seven** tools, not one, and
`agent_message` registers via `setupAgentMessage(pi)` rather than a `registerTool` line.
The real figure is **28** (27 `pi.registerTool` calls + `agent_message`), of which
`web_search` is conditional — it is skipped entirely when its config disables it, so a
given session shows 26 or 27.

All live in `~/.pi/agent/extensions/tools/`, backed up in `pi-setup/extensions/tools/`.

### Tool Replacements (override pi built-ins)

These replace pi's default tool implementations with customized versions:

| Tool | File | Customization |
|------|------|---------------|
| **bash** | `bash.ts` | Git trailer injection, mutex locking for git commands, psst secret injection into subprocess env, output scrubbing |
| **read** | `read.ts` | Image viewing, fitted to the vision budget via `lib/image-fit.ts` (falls back to raw bytes on any failure) |
| **apply_patch** | `apply-patch.ts` | The ONLY file-mutation tool. **Four call shapes, one engine** (see below): `{path, content}`, `{path, old_string, new_string}`, `{ops:[…]}`, `{input: envelope}`. Multi-file atomic batching, mutex locking, undo tracking. Replaced `edit-file.ts` + `create-file.ts` in `6296fef`; pi's native `edit`/`write` are hidden at `session_start` |
| **format-file** | `format-file.ts` | Prettier/biome formatting |
| **grep** | `grep.ts` | Custom output formatting |
| **glob** | `glob.ts` | Custom result handling |
| **ls** | `ls.ts` | Delegates to read tool |
| **undo-edit** | `undo-edit.ts` | Edit reversal with diff display. Reverts the WHOLE tool call by default (`scope: "file"` for one path); a move is undone as one operation. Refuses when a file was changed outside the tool, since those bytes are recorded nowhere (`force: true` overrides, and says what it discarded) |
| **redo-edit** | `undo-edit.ts` | Re-applies an undone change. Refuses when a newer tool change touched the path, and (like undo) when the file was changed outside the tool — `force: true` overrides and says what it discarded |
| **skill** | `skill.ts` | Skill loading |

### New Tools (not in default pi)

> **apply_patch's four lanes — read before changing its schema.**
> See the section "apply_patch: strict on disk, loose on the wire" below.


| Tool | File | Purpose |
|------|------|---------|
| **screenshot** | `screenshot.ts` | macOS capture (display / window / region) that returns an image already inside Claude's vision budget. See "Screenshot & Vision Budget" below |
| **finder** | `finder.ts` | Concept-based search subagent — chain 3+ searches or search by concept |
| **oracle** | `oracle.ts` | Architecture review, hard multi-file bugs, complex planning (read+bash+screenshot, web_search, read_web_page) |
| **delegate** | `delegate.ts` | Spawns a resumable subagent (same model as parent) for parallel independent work. Replaced `task.ts` in `e4c8786` — `continueId` makes children resumable, which Task never was |
| **librarian** | `librarian.ts` | External repository exploration via GitHub API |
| **agent_message** | `agent-message.ts` | Inter-agent mailbox messaging. Registered via `setupAgentMessage(pi)`, not a plain `registerTool` |
| **web_search** | `web-search.ts` | Parallel AI Search API. **Conditionally registered** — if its config disables it, nothing is registered rather than advertising a tool that cannot run |
| **read-web-page** | `read-web-page.ts` | Web page reader using cheerio |
| **read-session** | `read-session.ts` | Read past pi session history |
| **search-sessions** | `search-sessions.ts` | Search session history by keyword, file, date |
| **code-review** | `code-review.ts` | Code review with diff analysis |
| **github** | `github.ts` | **Seven** tools, not one: `read_github`, `search_github`, `list_directory_github`, `list_repositories`, `glob_github`, `commit_search`, `diff` |

**Web search:** `pi-web-access` was removed 2026-07-30 (see Packages). Phase 3 landed the
self-contained Parallel AI `web_search` (`web-search.ts`), so the gap that note used to
describe is closed. Page reading is covered by our own `read_web_page` tool.

### apply_patch: strict on disk, loose on the wire

**Changed 2026-08-12.** Files: `apply-patch.ts`, `lib/codex-patch.ts`,
`lib/sub-agent-render.ts`, `apply-patch-lanes.test.ts` (new, 299 cases),
`agents/prompt.amp.system.md`.

#### The problem it fixes

`apply_patch` took exactly one required string: OpenAI's **V4A envelope**. That
format is not neutral — OpenAI's own guide says the model "has been extensively
trained" on it and Codex's says "use our exact implementation as the model has
been trained to excel at this diff format". Warp's writeup states the split
plainly: *"many LLMs are trained on string-replacement-based editing tools;
GPT-family models have been trained with V4A."* Our lark grammar is a copy of
`codex-rs/.../tool_apply_patch.lark`.

So the setup ran **every** file change through a competitor's post-training
artifact while the default model was Claude. Measured consequences were already
in the port log: haiku burned 15 consecutive failed calls, `deepseek-v4-flash`
produced a valid envelope expressing the wrong intent, and there was **no
whole-file write at all**, so replacing a file meant Delete + Add.

#### The shape now

Four call shapes, one engine. Every lane goes through the same
`evaluatePermission` → `withMutationQueues` → `withFileLocks` → snapshot →
in-memory apply → commit-or-rollback → `saveChanges` path, so a new lane can
never add a way around a guard:

| lane | shape |
|---|---|
| write | `{ path, content }` — create or replace outright |
| edit | `{ path, old_string, new_string, replace_all? }` |
| batch | `{ ops: [ … ] }` — several files, all-or-nothing |
| envelope | `{ input: "*** Begin Patch …" }` — multi-hunk, or pasted |

`normalizeCall()` picks the lane at runtime and **refuses rather than resolves**
any call that reads as two lanes at once. Key aliases are accepted (`file_path`,
`contents`, `oldText`, `old_str`, …) because a key that is merely *named*
differently is unambiguous; a key that changes the *operation* is never inferred
across lanes.

#### Things that are not obvious and cost real debugging

- **`constrainedSampling` was REMOVED, not disabled.** pi-ai's
  `inferGrammarInputProperty` requires exactly one required string property,
  which four optional lanes cannot satisfy, and
  `resolveGrammarConstrainedSampling` **throws** rather than degrading — killing
  the whole turn on an OpenAI model while every Anthropic test stays green. It
  only ever applied to OpenAI-family providers, i.e. the one family that emits
  V4A correctly unaided. `apply-patch.test.ts` guards this in **both**
  directions.
- **Every schema field is optional, and that is forced.** pi validates arguments
  against the schema *before* `execute()` (`pi-ai validateToolArguments`), so a
  required field is a hard wall against the other three lanes. The cost is that
  malformed calls are caught one layer later, which is why every refusal ends
  with the menu of accepted shapes.
- **`edits` is an ops key, and a top-level `path` is inherited by entries that
  lack one.** That is exactly pi's own native edit shape
  (`{path, edits:[{oldText,newText}]}`) and Claude Code's MultiEdit
  (`{file_path, edits:[{old_string,new_string}]}`) — the single most likely
  thing a Claude-family model emits. Without inheritance it lands as
  "ops[0]: no file path".
- **A key that *means* patch is never rescued as content.** `{path, diff:
  "-old\n+new"}` is a model fumbling a patch; writing those two lines into the
  file would destroy it and report success. Only the generic key `input` can be
  rescued into a write, and only when it does not look like a patch attempt.
- **A bare `target` is not a path alias** (cursor's `target_file` is). It reads
  as a move *destination* at least as naturally as a source, and a path alias
  that can be misread writes the wrong file.
- **`type` and `command` are not op aliases.** They are generic enough to arrive
  carrying something that is not an operation (`type: "text/plain"`), and an
  unrecognised op is a hard error — so accepting them turns a valid write into
  "unknown op".
- **A field the chosen op ignores is a refusal, not a no-op.** `{op:"delete",
  path, content}` reads as two intentions; carrying on deletes a file the caller
  was trying to rewrite.
- **A move refuses to clobber an existing destination**, mirroring `add`. The
  envelope's `*** Move to:` never had this guard; it did not matter much when a
  move cost a whole extra header line, but `{path, to}` makes it two fields.
  `git mv` refuses this too.
- **A rename no longer rewrites bytes.** Applying zero hunks used to run the
  applier anyway, which appends a trailing newline.
- **The redaction guard now compares against the real file** for a whole-file
  write, so rewriting a file that legitimately contains "… rest unchanged" is
  allowed while introducing one is not. (It caught its own test fixture during
  development; the fixture is built at runtime for that reason.)

#### Parser tolerance (`lib/codex-patch.ts`)

Accepted now: `*** Begin Patch ***`, `** begin patch`, odd spacing/case, prose
around the envelope, `<<EOF` heredocs with or without a leading command, git's
`@@ -1,3 +1,3 @@` numbers, header aliases (Create/New/Remove/Edit/Modify/Change/
Write/Replace File, Rename to), an Add block with **no** `+` prefixes, and bare
blank lines inside a `+` block.

Two rules that look arbitrary and are not:

- **A numbered hunk header is git's, hint included.** `@@ -1,1 +1,1 @@ someFn`
  drops `someFn` too. In V4A `@@ foo` is a *required* anchor that must match a
  line exactly, whereas git's hint is a truncated label for the enclosing scope
  — promoting it turns a working patch into "failed to find context 'someFn'".
- **A patch with no end marker at all is still an error.** A patch truncated
  mid-generation looks exactly like one whose author forgot the marker, and
  guessing turns a dropped stream into a half-written file. *Honest limit:* the
  envelope ends at the LAST end-marker line and `isEndLine` trims, so a hunk's
  context line ` *** End Patch` is indistinguishable from a real terminator if
  the stream is cut off right after it. Upstream had the identical hole (its
  last-line check also trimmed — verified, not assumed), and closing it would
  break the marker padding that `codex-patch.test.ts` requires.
- **An UNPREFIXED Add/Write body containing a marker-shaped line is refused.**
  This is the one truncation case that *could* be closed, and it was a real
  regression from accepting unprefixed blocks: because the envelope ends at the
  last end-marker anywhere in the text, a file documenting this very format came
  back **missing its last line, reported as success**. `+` prefixes and the
  explicit `*** Content` block both make content unmistakable and are
  unaffected, as is `{path, content}`.
- **A header is only a header at column 0.** `matchHeader` trims the end of a
  line but never the start, so ` *** Update File: x` stays content. Only the
  top-level dispatch, where no chunk is open, tolerates indentation. Two tests
  pin this.

#### Two defects found by grok-4.5 stress-testing (2026-08-12)

Both were real, both are fixed, and both were **pre-existing mechanisms that the
new lanes made far easier to reach** — worth stating plainly, because the
tempting reading is "the rewrite broke it".

- **Nested indentation was translated between tabs and spaces.** `reindentToFile`
  fixes the OUTER level by construction (it prepends the file's own indent) but
  deeper levels kept the patch's character, so a tab-indented file patched with
  space-indented text came back as `\t  return 2;`. Silent byte corruption, and
  outright breakage in a Makefile (where a tab is syntax) or mixed-indent Python.
  It now **refuses** when the shift would mix the two, because repairing it needs
  the file's indent *width*, which is a guess. The safe case — same character,
  different depth — is unaffected, and that is the case the fuzzy tier exists for.
  His stronger claim, that matching normalises tabs→spaces generally, does **not**
  hold: a uniform-depth Makefile hunk keeps its tabs, verified.
- **Undoing a move lost or duplicated the file.** A move is one logical operation
  recorded as TWO path histories (delete source + create destination), and
  `undo_edit` takes a single path — so undoing the destination removed the file
  from both places, and undoing the source left it in two. He reproduced the data
  loss with content named `gold-bar-do-not-lose`. `findMovePartner` now pairs the
  two halves and `undo_edit` reverts both. The pairing rule demands **exactly one**
  deletion and **one** creation in that tool call with **identical bytes**, so a
  batch that moves one file and deletes another cannot pair them by accident;
  when it is ambiguous it pairs nothing and undoes only what was asked.

A third fix came out of the first: `applyEdit` swallowed the fallback applier's
error to write a better "not found" message, which also swallowed *ambiguity* and
*indentation* diagnoses. It now swallows only `failed to find` — an allow-list of
what to hide, so a newly added diagnosis surfaces by default.

#### Round two — he re-tested and found the first fixes incomplete

- **The indent guard had a hole, and it was the Makefile case.** The check lived
  inside `reindentToFile`, which **returns early when the first line's indent
  already matches** — so a hunk anchored at column 0 (`build:`) skipped every
  check and the tab-indented recipe under it was rewritten with spaces. No
  mixing, so the mix-detector never fired. The guard now proves the shift
  against the file's own lines: apply the same transformation to the OLD lines
  and require it to reproduce what is actually on disk. If it cannot rebuild the
  lines it was derived from, it does not get applied to the new ones. Both
  legitimate rescues (uniform depth across tab/space, and same-character
  different-depth) still work — there are tests for each.
- **Move pairing is now RECORDED, not inferred.** `FileChange.movePartnerUri` is
  written by `apply_patch` at the moment it performs the move, so the reader
  never guesses. That kills the case that beat the heuristic: a batch that moves
  x→z *and* deletes y where x and y hold identical bytes. Legacy records without
  the field still fall back to byte matching, and when that is undecidable
  `undo_edit` now **says so** and names the candidates — previously it said
  nothing, which is what made a recoverable state look like data loss. (That
  silence was also a documentation error on my part: I claimed it warned.)
- **Undo is now per-tool-call by default**, with `scope: "file"` to opt out. The
  records were always grouped by tool call on disk; only the reader was
  per-path. This also makes the move case correct *by construction* rather than
  by pairing — both halves are in the same call.
- **`redo_edit` exists.** Every record already stored both `before` and `after`,
  so re-applying was never the hard part; the hard part is invalidation, and
  redo **refuses** when any later still-applied change touched the path. Getting
  that wrong is worse than having no redo, which is why there wasn't one.
- **Ambiguity errors now show the line at each match**, not just its number.

Verified live end-to-end in one session: a 2-file `ops` batch, one `undo_edit`
reverting both, one `redo_edit` re-applying both. Note that undo/redo are scoped
to the current session branch by design — a redo cannot reach an undo performed
by a different pi process.

#### Round three — undo is a stack, not random access

His last finding was labelled "not a bug, mild edge", and it was worth fixing
anyway: create A and C in one batch, later move A elsewhere, then undo the create
batch. Undoing a creation means "delete it" — but A is not there any more, so the
delete is a no-op and the content lives on at the move destination with its
creation history marked undone. No data loss, but a state nobody can reason
about, and incoherent is how data loss starts.

`undo_edit` now **refuses when a later still-applied change touches any path the
undo would revert**, and names what to undo first. That is the same invalidation
rule `redo_edit` already used, pointed the other way, so the two agree on what
"newer" means. Independent work is unaffected — editing A then B leaves no later
change on A, so undoing A is still allowed, and there is a test for exactly that.

**A real bug surfaced while testing it: ordering came from `Date.now()`.** That is
millisecond-resolution, so two tool calls in quick succession carry the SAME
timestamp and a strictly-greater comparison reads them as concurrent — the guard
silently let the undo through. Both undo and redo now order by **position in
`activeIds`**, which is the branch in order and monotonic by construction. Any
future ordering check here should use the branch, never the clock.

**Testing that guard exposed a second bug: redo popped the WRONG END of the
stack.** `findRedoCandidate` scanned the branch newest-first, so with L1→L2→L3
undone twice down to L1, one redo jumped straight to L3 — skipping the middle
step and printing the diff as `-L2 +L3` while the file held L1. Single-step redo
passed and hid it, which is why the original tests missed it. Because undo now
refuses to reach past a newer change, the undone changes for a path are always a
contiguous run at the top of the stack, so redo must take the **oldest** of that
run: the step the file would take next. Verified by flipping the scan direction
back and watching the new test fail.

#### Round four — undo now looks at the file before overwriting it

The last item he raised, and the one he ranked lowest: `revertChange` writes its
remembered copy back **unconditionally**, never checking the file still holds
what the tool left there. So anything written since by a non-recording writer —
`bash`, `format_file`, another editor — is overwritten without a word.

It deserved more than "tiny edge", for a reason the ranking missed: **every other
undo is itself undoable from these records, and this one is not.** Those outside
bytes were never photocopied by anything; they exist in the file and nowhere
else. It is the only remaining way this tool can destroy something unrecoverable.
It is also more reachable here than he assumed: `format_file` and `bash` record
nothing, so `apply_patch → format_file → undo_edit` already exposes it.

`matchesRecordedState()` (in `lib/file-tracker.ts`) answers "is this file exactly
as we left it"; `undo_edit` checks every change it is about to revert and
refuses, naming the files, with `force: true` to override.

Deliberately a **notice, not a wall**. It is silent whenever the file is
untouched, which is nearly always — a check that fires on harmless things is one
you learn to force without reading, and then it guards nothing. One drifted file
blocks the whole batch (undoing the clean half would leave a state neither the
caller nor the records describe), and a **forced** undo appends what it
discarded, since the diff describes only the tool's own change and would
otherwise leave the one unrecoverable act with no trace in its own output. That
last part was raised by a sub-agent while testing the guard live.

Verified by sabotage: stubbing `matchesRecordedState` to always return true fails
exactly the three drift tests and nothing else. Verified live in one session —
edit, `python3` append, undo → refused; the same with `force: true` → undone,
with the discard note.

While confirming the check could not false-positive, `allPaths` was verified to
be a `Set`, so **one record per path per tool call**. Two comments claiming a
batch "may write the same path more than once" were wrong and the sorts they
justified are gone.

#### Round five — the same guard, on redo

The undo guard was justified in round four with the claim that "`redo_edit` had
guarded exactly this since it was written". **That was wrong, and the wrongness
was load-bearing:** redo's check reads the *records*, looking for a newer change
this tool made. A shell command records nothing, so it is invisible to it. The
whole scenario survived the fix that was supposed to be about it —
`v1 → v2 → undo → v1`, shell writes `v1-HACKED`, redo silently restores `v2`.
Caught by grok-4.5 immediately after round four.

`matchesRecordedState(change, side)` now takes which copy the file should be
holding: `after` for undo (what the tool wrote), `before` for redo (what the undo
restored). Redo gained the identical refusal, `force`, and discard note. Both
existence fields fall back the way `revertChange` does, so old records behave.

Redo keeps **both** checks. The records check gives the more useful message when
the newer writer was this tool ("make the change again instead"), and the disk
check catches everything else.

Two lessons, both cheap to state and expensive to relearn:

- **Do not cite a guard without reading it.** The claim was plausible, written in
  a code comment, and repeated into the docs, where it would have justified never
  looking again.
- **A symmetric mechanism needs symmetric tests.** The round-four suite proved
  undo refused, forced, and reported — and every one of those tests passed with
  redo wide open. The sabotage harness now takes a side
  (`PI_DRIFT_SABOTAGE=before|after`) and each disables exactly its own tests,
  which is the property that was missing.

Verified live: edit → undo → `python3` overwrite → redo refused, `v1-HACKED`
intact.

His other two remaining items are correctly left alone: unique `old_string` is
the safety property (the error now shows the line at each match, which was the
real friction), and separate `undo_edit`/`redo_edit` tools are clearer than one
tool with a direction flag.

#### Verified

**1167 real tool calls** across the lane suite (seeded fuzz: 300 edit
round-trips, 200 write round-trips, 200 wrapped envelopes, 150 forced-failure
batches asserting nothing was written; plus generated alias matrices and
`undo_edit` coverage for every lane), alongside the original disk-contract and
parser tests. Full suite **1177 pass / 0 fail**.

A `code_review` pass over the diff found three real defects, all fixed above:
the unprefixed-marker truncation, the move clobber, and a silently-dropped `to`
on a write. It also claimed the leading-space end-marker hole was a regression;
that was checked against the old code and **was not** — the pre-existing
behaviour is identical, so the claim was recorded rather than acted on. Verify
each claim against the code before acting (§3.8 of the port log).

Live, same task (one span edit + one whole-file replace), fixtures reset per run:

| model | result | lanes used |
|---|---|---|
| `anthropic/claude-opus-5` | correct | `batch(2)` — one atomic call |
| `kimi-code/kimi-for-coding:high` | correct | `edit(1)`, `write(1)` |
| `deepseek/deepseek-v4-pro` | correct | `edit(1)`, `write(1)` |
| `deepseek/deepseek-v4-flash` | correct | `edit(1)`, `write(1)` |

**No model used the envelope**, and `deepseek-v4-flash` — recorded as *wrong* in
the pre-change matrix (§3.9 of the port log) — is now correct. Set
`PI_APPLY_PATCH_METRICS=1` to append `{lane, files}` per call to
`~/.pi/apply-patch-lanes.jsonl`; it is off by default because a tool that writes
to the home directory as a side effect of being called is a surprise.

### Tool Libraries (`tools/lib/`)

Shared code used by multiple tools:

| Library | Purpose |
|---------|---------|
| `agents-md.ts` | AGENTS.md/CLAUDE.md reading |
| `box-format.ts` | Box-drawing formatting |
| `vision.ts` | Claude vision budget arithmetic — token cost, resize target, slice plan. Pure, no I/O |
| `image.ts` | PNG decode/encode/crop + `readPngSize` (IHDR-only, no decode) |
| `resample.ts` | Area-average (box filter) downscale |
| `image-fit.ts` | The single seam: file → vision-safe image + payload ladder |
| `capture.ts` | macOS `screencapture` + JXA window enumeration |
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

**29 loadable by name** (verified live 2026-08-08): 23 config-level +
`find-skills` + `userinterface-wiki` + `context-management` (pi-context) +
3 `autoresearch-*` (pi-autoresearch). The `mcp-scripting` skill that
pi-mcp-adapter 2.19+ ships is deliberately suppressed — see the
pi-mcp-adapter config section.

### Config-level (`~/.config/agents/skills/`) — 23 skills

`amp-voice`, `c-sqr`, `chrome-cdp`, `coordinate`, `dataforseo`, `design-port`,
`dig`, `document`, `git`, `mat-cr2axis`, `mat-design`, `mat-tdd`, `nexus-fix`,
`remember`, `report`, `review`, `rounds`, `s-improve`, `shepherd`, `spar`,
`spawn`, `tmux`, `write`

Five of those are external skills adapted for pi, with author prefixes —
**`s-` shadcn, `c-` cursor, `mat-` matt pocock**:

| Skill | What it is | Subagents it spawns |
|-------|------------|---------------------|
| `s-improve` | read-only codebase auditor → writes self-contained handoff plans in `plans/`; never edits source | ≤4 read-only (standard) / ≤8 (deep), only during an audit |
| `c-sqr` | strict structural quality review of a branch diff | none |
| `mat-cr2axis` | two-axis diff review: standards (fowler smells) + spec, side by side | 2 read-only, parallel |
| `mat-design` | deep-modules vocabulary (module/interface/seam/adapter/depth) | 3–4, only in the DESIGN-IT-TWICE path |
| `mat-tdd` | test-driven development discipline (red→green, seams, anti-patterns) | none |

**Adapted for pi:** Claude-Code/Cursor machinery mapped to pi tools or cut
(shadcn's `execute`/`reconcile` worktree flow removed — pi sub-agents have no
worktree isolation). `code-review` was renamed `mat-cr2axis` to avoid clashing
with the `code_review` **tool**. As adapted, **none of the five ever edits code
via a subagent — every subagent they spawn is read-only.**

### Package-provided skills — why `skill.ts` had to change

Packages ship skills inside their own package dir. pi's native listing showed
them, but our custom `skill` tool only scanned the settings/agent/project skill
roots, so `skill({ name })` failed with "skill not found" on a skill the model
could plainly see. `skill.ts` now also discovers
`~/.pi/agent/npm/node_modules/<pkg>/skills/` (incl. `@scope/name`) and
`~/.pi/agent/git/<host>/<org>/<repo>/skills/`. An `isDirLike()` helper makes
symlinked skill dirs list correctly — `Dirent.isDirectory()` is **false** for a
symlink, which is why `find-skills` and `userinterface-wiki` were invisible.
User/config skills win over package skills of the same name.

`pi-skills/` in the repo is empty; `find-skills` and `userinterface-wiki` are
package-managed symlinks created on install.

---

## Screenshot & Vision Budget (`screenshot` tool + `lib/vision.ts`)

**Added 2026-08-05.** Files: `lib/vision.ts`, `lib/image.ts`, `lib/resample.ts`,
`lib/image-fit.ts`, `lib/capture.ts`, `lib/web-capture.ts`, `screenshot.ts`
(+ 6 test files). Harnesses: `pi-setup/port-harness/screenshot-bench.ts`,
`capture-probe.ts`, `web-capture-probe.ts`.

### Three capture backends, one fit pipeline

| target | mechanism | why |
|---|---|---|
| display / window / region | `screencapture` | photographs the glass |
| `url:` | headless Chrome via `playwright-core` | renders the WHOLE page, including below the fold |

`screencapture` can only ever return what is rendered on screen, so a page taller
than the display is unreachable by it. The `url:` path renders the full document and
`planView` slices it into ordered readable strips.

**`playwright-core`, not `playwright`, and `channel: "chrome"`.** Full `playwright`
bundles a ~150MB Chromium per platform; `playwright-core` is 13MB and ships none,
driving the Google Chrome already installed. Resolved at call time — if it is missing
the tool prints the install command instead of a module-resolution stack trace.
Verified: a 1200×7056 fixture page → 8 slices of 1200×1008, all inside budget.

Slicing a tall page honestly costs more than one image (8 slices ≈ 12,384 tokens), so
the tool says so and points at `selector:` for capturing one section instead.

### Sub-agent screenshots reach the caller

`collectSubAgentImages` (in `lib/sub-agent-render.ts`) pulls image blocks out of a
child's tool results and `subAgentResult` puts them **before** the child's text, for
`oracle`, `delegate` and `code_review`. Previously `getFinalOutput` kept text parts
only, so the pixels died with the child and the caller had to take its word.

Capped at the **2 most recent** images — images are the most expensive thing that can
enter a context, and a sub-agent's last look is usually the one that justified its
conclusion. A child that took no screenshots costs exactly nothing.

Verified live, and it immediately earned its keep: asked to check an oracle's claim,
the parent read figures out of the image the oracle never mentioned **and corrected it**
— the oracle said Stripema was the foreground app; the parent could see Finder held the
menu bar.

### The budget: two limits, and why one pass matters

Claude's budget is **two** limits — a 1568px padded edge AND **1568 visual
tokens**, where `tokens = ceil(w/28) × ceil(h/28)`. **The token limit binds first
for almost every screenshot**, which is why the obvious hand-rolled version is
wrong: `screencapture … && sips -Z 1400` on a 16:10 window gives 1400×900 =
50×33 = **1650 tokens**, over budget, so the API resizes it *again* to 1372×882 —
text resampled twice for a 2% size change, on top of a 3.2× reduction because a 2×
display had already captured 2800×1800. The tool resamples **once**, to the exact
size Anthropic's own resizer would pick, so the API's resize is a no-op. Verified
live: 2800×1800 → `1372×882 (1568 tokens, 1 pass)`.

### Where the numbers came from

`lib/vision.ts` is a behaviour-identical port of the `caliper` project's
`src/vision.ts` (`~/Documents/Code stuff/caliper`), which transcribes Anthropic's
published spec and reference resize implementation. The **same algorithm** is
implemented independently in the `ClaudeImageResizer` macOS app
(`ImageBudget.swift`). Two independent implementations agreeing on every test
vector is the only reason to trust either. **If you change a constant, change it
in all three and re-run `lib/vision.test.ts`.**

Details that look like nits and are not:

- **Banker's rounding.** `resizedSize` resolves exact .5 ties to even, matching
  Python's `round()`. `Math.round` drifts a pixel on tie-hitting aspect ratios —
  pinned by the 2000×1500 test.
- **The edge limit is tested against the PADDED edge**, `ceil(w/28)*28`.
- **High is the DEFAULT tier, and nothing decides it.** Swept 851 shapes
  (`port-harness/tier-dominance.ts`): high was larger 801 times, identical 50, and
  smaller **zero** times. It is not a trade-off, so there is nothing to weigh.
  Only an explicit `tier:"standard"` opts down; an absent or invented tier name
  gets high. In 54 wins the source already fitted, so high meant **no resample at
  all**. High is also safer for image *count* — 1988px slices vs 840 means a
  20,000px page needs 11 images instead of 25, and image count is what trips the
  >20 and 100-image rules.
- **No cost language anywhere in the tool surface.** A `screenshot.test.ts` case
  greps the description and every parameter for
  `token cost|cheaper|Nx the cost|expensive` and fails if any appears. Cost is the
  caller's business; the tool's business is not returning a degraded picture. The
  old `"~3x the token cost"` note actively pushed models to the weaker tier.
- **Patch-snapping was removed, not defaulted off.** Trimming each axis to a
  multiple of 28 saves ~3% of the budget and distorts the aspect ratio by up to
  2.7%; ClaudeImageResizer reached the same conclusion independently. It lives on
  in caliper if a measurement use ever wants it. `paddedSize` went the same way —
  the padding rule it reported is already inside `fits()`, which is what decides.
- **Area-average, not Lanczos.** Lanczos/bicubic ring on hard edges, and UI is
  nothing but hard edges (text stems, 1px borders). A deliberate divergence from
  ClaudeImageResizer's CoreGraphics `.high` path, which is the better choice for
  photos and the worse one here.

### Two caps that are ours, not Anthropic's

**`MAX_IMAGES_PER_CALL = 12`** (`lib/vision.ts`). Anthropic's wall is 100 images per
*request*, and a request is the whole conversation resent each turn — so one call
emitting 52 slices can clear that wall on its own. Measured at 1440px wide on the high
tier: a 100,000px page wanted 52 slices. 12 leaves 8× headroom and covers a ~23,000px
page. Exceeding it **truncates from the top** and says so in pixels; it never
bottom-aligns when truncating, because jumping to the end would leave an unannounced
hole in the middle.

**`MAX_RENDERABLE_HEIGHT = 16384`** (`lib/web-capture.ts`) — see below.

### Chromium silently returns BLANK past 16384px

Chromium cannot render a full-page screenshot taller than its maximum texture size
(2^14). Past that it does **not** fail — it returns an image of the requested
height whose lower portion is empty. Found by a model **reading our own slices**
and reporting that a 51,320px capture repeated and blanked out.

Measured (`port-harness/tall-page-limit.ts`) on a 40-section fixture: sections 1–13
rendered, **sections 14–40 came back blank**, boundary inside 15,506..16,719. The tool
then sliced that emptiness and handed it over as page content — worse than truncation,
because a caller cannot tell blank-because-empty from blank-because-broken.

`captureWebPage` now clips to 16384 and reports `clipped: { capturedHeight,
documentHeight }`, which `screenshot.ts` surfaces as a loud note. After the fix the same
fixture yields 13 distinct headings and **0 blank bands**.

Two probe bugs on the way there — one sampled at the CSS `height` when content-box
sizing made sections taller, the other assumed a mostly-whitespace fixture had ink
at the bottom. Lesson: **derive geometry from the artifact; do not assume it.**

### Two files that look like images and kill the request

`400 Could not process image` fails the **whole request**, not the one tool call — so it
takes the turn down. Two inputs reached the API and caused it, both for the same
structural reason: **the `asis` fast path deliberately never decodes.** Anything a decode
would catch is therefore already safe; only things that survive a *header read* need an
explicit refusal.

| input | why it slipped through |
|---|---|
| **0x0 PNG** (`DegenerateImageError`) | structurally valid, and zero tokens is inside every budget — so it is judged to "fit" perfectly and ships untouched |
| **truncated PNG** (`TruncatedImageError`) | intact IHDR reports plausible dimensions; measured, the first 100 bytes of a 300×200 PNG report 300×200 and ship as a 100-byte "image" |

Found live: a script killed mid-run left 65-byte 0x0 PNGs in `~/pi-scratch`, and reading
one killed the session. Empty files, not-an-image and half-a-file all throw while
decoding and never had this problem.

Both now throw `UnusableImageError` (the shared base) from `fitImageFile`, before
`planView` runs. Truncation is detected by the **missing 12-byte IEND chunk** — one tail
read, so `asis` stays decode-free. **PNG only, deliberately**: every valid PNG ends with
IEND so there are no false positives, and PNG is what `screencapture`, Chromium and our
own encoder produce — every path that can write a partial file. JPEGs commonly carry
trailing bytes after EOI, and refusing a valid image would be worse than the bug.

**`read.ts`'s raw-bytes fallback must skip this class.** It exists so a *fit* failure
never makes `read` worse than the five-line version it replaced — but falling back for
an unusable image re-sends the exact payload the API rejects. It now catches
`UnusableImageError` and reports it instead. Verified live: a fresh session read both
corrupt shapes, got clean errors, and kept working.

### Window targeting — the rules, and why each exists

**Every macOS tab is its own `NSWindow`, and the tab bar is a further separate
window.** Measured: 4 visible Ghostty terminals reported as 16 windows (two real
windows of 7 and 8 tabs, plus tab-bar windows at y=0 filtered by the height
floor). So a raw window count is accurate and useless. `groupLikelyTabs()` keys
on identical app+size+position; `renderWindowTable` folds siblings into one entry
with the capturable id first and the rest as `other tabs: …` (singletons stay
flat — a "1 tab(s)" header is noise).

This also explains a capture that looks 80px too tall: `screencapture -l` returns
the whole **tab group**, so a window whose `CGWindowBounds` says 1920×1040 @y=40
(the *content area*) captures as 1920×1080 from y=0 — the difference is exactly
the 40pt tab bar, verified by cropping and reading it. Nothing extra is captured
and nothing is lost. The tool notes any captured-pixels ≠ bounds×scale mismatch,
and suppresses that note when a region was applied (after a deliberate crop,
"the full window was captured" would be untrue).

Rules the tool follows, each from a live failure:

- **Disclose the choice.** Auto-picking used to be invisible: `app:"ghostty"`
  matched 12 windows and captured one silently. `resolveWindow` returns a
  `WindowChoice` carrying `autoPicked`; the tool names the match count and chosen
  id. Exactly one on-screen candidate → capture it and say so, never a second call.
- **Only give advice that can work.** The refusal used to say *"narrow it with
  window_title"* to a caller that had supplied one, when all candidates had
  byte-identical titles. That advice is now conditional on
  `new Set(titles).size > 1`; otherwise it says so and asks for `window_id`,
  the only thing that can separate them. `describeWindow` includes `@x,y` because
  terminals left-truncate their own titles, hiding the distinguishing prefix.
- **A dead end becomes a next step.** On failure, `displayedSibling()` names the
  on-screen member of the same tab group. It does **not** auto-capture it — the
  group renders whichever tab is active, so substituting would be the silent
  auto-pick bug again: right pixels, wrong subject.
- **`region` is window-relative** when combined with `window_id`/`app`, cropped
  from the window's own pixels after capture. Screen coordinates go stale the
  moment a window moves and cannot express the tab-bar offset `CGWindowBounds`
  omits. Over-large regions clamp and say so. Measured: a `[0,0,700,120]` crop
  costs **450 tokens instead of 2840**.

`resolveWindow` takes an injectable `pool` because these branches depend on which
Space is active — the ambiguous case stops being ambiguous the moment a window
moves, so it cannot be tested against the live desktop.

**Guardrail: every absolute claim made about macOS window behaviour here has been
wrong.** `[other Space]` (macOS only reports `kCGWindowIsOnscreen: false`, which
is equally true of a minimised window, a hidden app and — most often — a
background tab, so it is now `[not on screen]`); "cannot be captured while off
screen"; "a background tab can never be captured" (disproved by `window_id 13861`
capturing fine at 3840×2080). Three for three. State the observation, offer the
next step, and let the capture attempt be the authority. A test greps the rescue
message for `never|impossible|cannot be captured`.
- **Patch-snapping was removed, not merely defaulted off.** Trimming each axis down to a
  multiple of 28 saves ~3% of the budget and distorts the aspect ratio by up to 2.7%;
  ClaudeImageResizer reached the same conclusion independently, so nothing ever enabled
  it. It lives on in caliper if a measurement use ever wants it. `paddedSize` went the
  same way — the padding rule it reported is already inside `fits()`, which is what
  actually decides.
- **Area-average, not Lanczos.** Lanczos/bicubic ring on hard edges, and UI is nothing
  but hard edges (text stems, 1px borders). This is a deliberate divergence from
  ClaudeImageResizer's CoreGraphics `.high` path, which is the better choice for photos
  and the worse one here.

### The >20-image ceiling — why `high` is clamped to 2000px

Spec §7: once a request carries **more than 20 images**, the per-image ceiling
drops from 8000px to **2000px per axis**. The high-res tier's spec edge is 2576.

This went off live (session `019fcf7a`): a 2576×1449 image **succeeded at image
index 3 and 400'd at index 20 of the same session**, identical size, nothing wrong
with it — a 9-slice web capture had pushed the request past 21 images. Worst
possible failure shape, because it looks random.

**Fix:** `resolveTier()` clamps high to `MANY_IMAGE_MAX_EDGE = 2000`, so no image
this tool emits can ever be illegal. Costs ~23% of linear resolution (2576 → 1988
after padding) and 40% of token cost (4784 → 2840); 1988 is still 27% above the
standard tier, which is the reason to ask for `high`. `TIERS` keeps the **spec**
values — the test vectors and the ClaudeImageResizer cross-check are written
against those; only `resolveTier`, the seam every tool goes through, clamps.

**There is deliberately no opt-in back to 2576.** A tool cannot see how many
images are already in the conversation, so it cannot know whether 2576 is safe on
this call. An option that works early and fails later is worse than no option.

Guarded by a sweep of 12 shapes × both tiers asserting nothing exceeds 2000, plus
a separate one for slice boxes (slices are cropped, so they bypass `resizedSize`
entirely). **It was a known unknown:** the pre-build research listed this limit as
"NOT implemented" and it was then not built. Check that list before assuming a
limit is handled.

### The resample out-of-bounds bug (also fixed upstream in caliper)

`downscale`'s inner loops used `Math.ceil(xEnd)`/`Math.ceil(yEnd)` as bounds. At
the last row/column `(dx + 1) * xRatio` overshoots by ~1e-15, so `ceil` yields
`width + 1` and the loop reads one past the buffer. An out-of-bounds `Uint8Array`
read is `undefined` → `undefined * weight` is `NaN` → assigning `NaN` into a
`Uint8Array` silently stores **0**. A black pixel, no error anywhere.

| source → target | corrupt bytes |
|---|---|
| 21×21 → 19×19 | 57 (the entire bottom row) |
| **2880×1800 → 1389×868** (MBP Retina) | 3 (bottom-right pixel black) |
| 3840×2160 → 1456×819 | 0 — clean by luck |

**Why 107 tests missed it:** every resample test asserted an *aggregate* (mean,
buffer length, value range), and 3 bad bytes in 3.6 million move the mean by
0.00002. The fix clamps bounds to the buffer; regression tests now assert **exact
pixel values** across 7 named sizes plus an 873-combination sweep. Ported
faithfully from caliper and **fixed there too** — it mattered more there, since
caliper's `edges()`/`bands()` read a black pixel as ink.

### macOS facts verified on this machine (do not re-derive)

- `CGWindowListCopyWindowInfo` **is** reachable from JXA, but only through
  `ObjC.castRefToObject`. Calling it directly returns something that `typeof`s as
  `"function"` and unwraps to nothing. No compiled helper needed.
- **Use option `0` (all windows), never `1` (`OnScreenOnly`).** Option 1 omits every
  window on another Space — measured 17 vs 142, and this session's own terminal was in
  the missing 125.
- **Off-Space capture is mixed, not uniformly broken.** Survey: **9 of 10** off-Space
  windows captured fine; 1 failed with "could not create image from window". So the tool
  must *try* and explain on failure — pre-refusing would block 9 valid captures.
- `CGPreflightScreenCaptureAccess` has an **incomplete BridgeSupport entry** (declared
  with no signature) so JXA cannot call it. Authoritative check is
  `swift -e 'import CoreGraphics; print(CGPreflightScreenCaptureAccess())'` (~134ms),
  used only *after* something fails. The free heuristic is that `kCGWindowName` is blank
  for other processes when permission is denied.
- **Screen Recording must be granted to the terminal running pi.** Without it macOS
  returns the desktop with no windows rather than failing — a silently useless image.

### Performance (measured, real 8.3-megapixel Retina grab)

`readPngSize` 0.7ms · decode 118ms · downscale 45ms · encode 73ms · **~236ms total**.
That settled the "pure TS vs the Swift binary" question — no native helper, nothing for
`install.sh` to build. A full-screen 4K PNG is 6.8MB on disk = **9.07MB base64, 90.7% of
the 10MB API cap** before fitting; after fitting, 16.2%.

### Invariants

- **`sips` is a codec, never a resizer.** It transcodes non-PNG input and encodes JPEG at
  a given quality. Every geometry decision is made by `planView` in TypeScript.
- **`fitImageFile` is the only path from pixels to a vision model.** `screenshot` and
  `read` both funnel through it. Nothing else should base64 an image.
- **The `asis` path never decodes.** Dimensions come from the IHDR; if the image already
  fits, the original bytes ship untouched.
- `permissions.json` rejects the capture binary in bash and names the tool in the
  message. It does **not** match `sips` at all any more: that pattern produced three
  false positives in a single session — a git commit message describing the old pattern,
  and two files written through a shell heredoc that merely QUOTED it. The guard exists
  to stop an agent TAKING a screenshot by hand, not to stop anyone writing about it, and
  with the capture binary blocked there is no fresh screenshot to badly resize anyway.
  Pinned by `port-harness/permission-precision.ts` (5 real invocations still blocked,
  7 "talking about it" cases allowed) and by cases in `screenshot.test.ts`.
- Available to `delegate`, `oracle` and `code_review` sub-agents, and **a sub-agent's
  images now reach the parent** — see "Sub-agent screenshots reach the caller" above.

### `read` is covered too

`read.ts` routes images through `fitImageFile` as well, so an image the model *opens* gets
the same ceiling as one it *takes* — design mockups, downloaded PNGs, earlier screenshots.
Two deliberate properties:

- **An image that already fits returns exactly what it used to**: a single image block, no
  extra commentary. Only an image that needed work says so.
- **Any failure in the fit path falls back to the raw bytes.** `read` becoming more fragile
  than the five-line version it replaced would be a worse bug than a large payload.

Verified live: `/tmp/p0-display.png` (3840×2160, 6.8MB on disk, **9.07MB base64 = 90.7% of
the API cap**) now arrives as 1456×819 in one pass, and the model still read four-digit
figures out of a screenshot nested inside it.

### Not verified

- Multi-display: this machine has one display, so `display: 2` only ever produced
  `screencapture: Invalid display specified`. The flag is passed straight through.
- `activate` is implemented and unit-covered but **never run live** — it switches the
  user's Space, so it was not exercised during development. First real use may surface a
  macOS Automation (TCC) prompt. Note the tri-state: **unset** means a window that fails
  to capture because it is on another Space is retried with activation automatically;
  **true** activates up front; **false** forbids it. The auto-retry only fires for an
  off-screen window, because an on-screen failure is a permissions problem that stealing
  focus would not fix.

---

## Local Models (llama.cpp + LFM2.5-2.6B)

**Added 2026-08-05.** Files: `pi-setup/extensions/local-model.ts` (the `/local` command),
`pi-setup/llama-local.sh` (terminal launcher), the `llama-local` provider in `models.json`,
and its entry in `enabledModels`.

### ⚠️ llama.cpp MUST be >= b10270

Brew shipped **b8680 (commit `15f786e65`, dated 2026-04-06)** for months. That build has
**two silent tool-call parser bugs for the `lfm2` architecture** — neither raises an error,
both just hand the agent garbage:

| upstream | merged | symptom before the fix |
|---|---|---|
| **#24667** double-escaping | 2026-06-15 | `\n` in a tool argument arrives as **literal backslash-n**, so every multi-line argument is corrupt. Kills `apply_patch`, file writes, multi-line bash. |
| **#24178** parser unification | 2026-06-05 | `[f(a), f(b)]` parsed as **one mangled call** — the second call's raw text ends up inside the first call's last argument, and the result is still *valid JSON* so nothing rejects it. |

Both were reproduced here and traced by bypassing the parser: the **model emits correct
Pythonic output** (`[write_file(path='/tmp/x.py', content='import os\nprint(...)')]`) — llama.cpp
was copying the two characters `\`+`n` into JSON verbatim instead of interpreting the Python
escape. **Model was never at fault.** Upgrading `8680 → 10270` fixed both, verified.

If tool calling ever goes strange on a local model, check `llama-server --version` FIRST.

### The `/local` command

```
/local            status; if stopped, offers to start (interactive menu in TUI)
/local start      start router + load the model
/local stop       kill the server, release RAM
/local restart    stop then start
/local unload     drop the model, keep the server listening
/local status     quant, context, params, RAM, endpoint
/local logs       last 40 lines of /tmp/llama-server.log
```

**No auto-start at login** — deliberate, by user request. Start it when you want it.

### System prompt isolation — do not widen this

`before_agent_start` **returns `undefined` unless `ctx.model?.provider === "llama-local"`**.
pi chains that hook, and a handler returning nothing leaves the prompt byte-identical. So the
local-model rules + identity block are appended ONLY for the local model; claude/kimi/codex/
deepseek/sakana all keep the default prompt untouched.

**Verified with a canary**, not by asking the model (a 2.6B model introspecting its own prompt
is not evidence — it answered "ABSENT" while the text was demonstrably present). A unique token
was injected and the local model reproduced it exactly (`ZQ7X-VELVET-4419`); Claude and Kimi hit
the same hook and returned `NONE`, with instrumentation confirming the injection branch never ran
for them.

The injected rules exist because of measured failures, not theory: a 9-`apply_patch` loop with
only 2 verification runs (9m36s), a 10-call patch loop on a one-line fix (507s vs 23s median),
and bash arguments handed to `apply_patch`. Rules 3 (stop after two failures), 4 (verify each
edit) and 5 (never hand-compute expected values) target exactly those.

### Gotchas found while wiring this up

- **`ctx.hasUI`, not `ctx.canPrompt`.** There is no `canPrompt` — it reads `undefined`, which is
  falsy, so every dialog silently degraded to the non-interactive branch *inside a real TUI*.
- **A model must be in `enabledModels`** or `/model` shows "No matching models" even though
  `--list-models` and `--model provider/id` both work.
- **`toLocaleString()` follows the SYSTEM locale** — en-IN here, so 128000 rendered as
  `1,28,000`. Always pass `"en-US"` explicitly.
- **pi's built-in `llama.cpp` provider is TUI-only.** Its extension registers exactly one hook —
  the `/llama` command — and the model catalog is populated nowhere else, so headless `pi -p`
  can never see those models. That is why we use a `models.json` provider (`llama-local`) instead.
- **The extension embeds its own server command.** The 2026-07-23 `local-model.ts` shelled out to
  a `start-local.sh` living outside the repo; that script was later deleted and took the whole
  extension with it. Nothing here depends on a file that can vanish.

### Measured on this machine (M4 Pro, 48 GB)

decode **81-89 tok/s** · prefill ~1,049 tok/s · cold start → loaded **3.2s** ·
auto-sleep after 300s idle drops **3.25 GB → 0.18 GB**, wakes in **~1.0s**.
Our system prompt + 27 tools is **18,546 tokens** ≈ **17.7s prefill on every fresh `pi -p`**.

Reliability: clean, well-specified single-file task **5/5** at 24-25s. Structured JSON extraction
**3/3 byte-exact** at 35-38s. Self-directed work (write your own tests) **failed** — it does not
fail fast, it loops for 8-10 minutes and returns nothing. Put a timeout on anything unattended.

---

## Models

### Providers (in models.json)

| Provider | Models | Purpose |
|----------|--------|---------|
| `anthropic` | `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` (1M context override) | Direct Anthropic API + OAuth (Claude Max via pi-claude-code-use) |
| `deepseek` | `deepseek-v4-pro`, `deepseek-v4-flash` | 1M context, thinking mode, OpenAI-compatible API |
| `kimi-code` | `kimi-for-coding` (K2.7 Code, 262K ctx) | Kimi Code subscription OAuth via `~/.kimi-code/credentials/kimi-code.json`; token helper refreshes through `https://auth.kimi.com/api/oauth/token` |
| `llama-local` | `LFM2.5-2.6B` (Q6_K, 64K ctx active / 128K max) | Local llama.cpp router at `http://127.0.0.1:8080/v1`. Free, private, offline. Managed with `/local`. Requires llama.cpp >= b10270 — see "Local Models" above. |
| `sakana` | `fugu`, `fugu-ultra` (both 1M ctx, text+image) | Sakana AI "Fugu" multi-agent orchestration. OpenAI **Responses** API at `https://api.sakana.ai/v1` (`api: openai-responses`), Bearer `$SAKANA_API_KEY`. $20/mo "Standard" subscription. See "Sakana AI (Fugu)" section below. |

### Sub-agent Models

Set 2026-07-31. Constants live in each tool file (`const MODEL = …`); the
Anthropic-parent conditional in `lib/pi-spawn.ts` is unchanged, so a
non-Anthropic parent (deepseek/kimi/sakana) still makes every child inherit the
parent instead of demanding separate Claude access.

| sub-agent | model | why |
|---|---|---|
| **finder** | `claude-sonnet-5` | concept search is worth real reasoning; haiku missed connections |
| **librarian** | `claude-sonnet-5` | multi-repo exploration over the GitHub API |
| **code_review** | `claude-sonnet-5` | diff review |
| **oracle** | `claude-opus-4-6` | strongest model; architecture, hard bugs, alternative view |
| **delegate** | *(none — inherits `parentModel`)* | **deliberate.** a delegate is a peer doing your work, so it must match your model and provider. Do not add a `MODEL` const to `delegate.ts`. |
| **read_session** | `claude-sonnet-5` | picking the right branch out of a long, branching session is comprehension, not summarisation |
| **read_web_page** | `claude-sonnet-5` | only the optional `prompt` path spawns a model; a plain fetch spawns none |

Verified live (model read off the wire, not just the constant): parent
`claude-opus-5` → finder `claude-sonnet-5`, oracle `claude-opus-4-6`, delegate
`claude-opus-5` (inherited), read_web_page `claude-sonnet-5`, read_session
`claude-sonnet-5`.

**Still on haiku, deliberately:** `extensions/session-name.ts` (`NAMING_MODEL`)
generates the short session title. It runs on *every* session for a one-line
output, so the cheap tier is the right call. Everything else we own is off haiku.

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
│   ├── prompt.amp.read-web-page.md  # web-page Q&A prompt
│   └── ...
├── themes/                     # 2 pi TUI themes
│   ├── gruvbox.json
│   └── nightowl.json
├── pi-skills/                  # empty (find-skills + userinterface-wiki auto-created by packages)
├── config-skills/              # 23 config-level skills
└── extensions/
    ├── tools/                  # 28 custom tools + lib/ (config, prompt-patch, fs, mentions)
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
pi-tool-display config, editor label guards, box-format normalization,
provider-qualified sub-agent `--model`. Each
FAIL prints the exact fix command. Exit 0 = everything in place. Run it after
`pi update`, any `pi install`, any npm package update — or whenever something
feels off. `pi-setup/install.sh` also runs it as its final step.

**An import-level audit is not enough — also grep our own CLI call sites.**
`verify-patches.sh` and the usual API-compat sweep both check what our
extensions *import*. They cannot see a change in how pi interprets the
**command-line arguments we pass it**, and `lib/pi-spawn.ts` shells out to a
real `pi` process with `--model`, `--provider`, `--tools`, `--mode`. pi 0.84.0
#7327 changed bare `--model` resolution from "take the first catalog entry" to
"hard error if several authenticated providers match", which silently took out
**every sub-agent** — oracle, finder, code_review, librarian, read_session,
read_web_page — with an error that reads like an auth failure. The changelog
line had been read and filed as a *free win*. So: whenever a release mentions
model resolution, provider selection, tool filtering or CLI arguments, open
`lib/pi-spawn.ts` and check the flags it builds, then actually call one
sub-agent before declaring the update clean.

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

   Both surface only when pi-sub-core refreshes usage (status bar / refresh), so a normal boot looks clean.
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

# pi-sub-bar — no patches needed (re-check provider names in pi-sub-core-settings.json against the installed version after any update; see Update Workflow #3)

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
